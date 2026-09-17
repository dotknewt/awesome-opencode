from __future__ import annotations

import json
import math
import os
import shutil
import time
import uuid as uuid_module
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from .commands import CommandRunner
from .domain import DomainSpec, sanitize_clone_xml, validate_overrides
from .errors import LifecycleError
from .guest_access import GuestAccessProvisioner, LibguestfsGuestAdapter
from .store import Store


URI = "qemu:///session"
DEFAULT_COMMAND_TIMEOUT = 30


class Lifecycle:
    """Managed-template and working-VM lifecycle for one local libvirt session."""

    def __init__(self, root: Path, runner=None, guest_access=None):
        self.store = Store(Path(root))
        self.runner = runner or CommandRunner()
        self.guest_access = guest_access or GuestAccessProvisioner(LibguestfsGuestAdapter(self.runner))

    def _run(self, argv: list[str], *, allow_failure: bool = False, timeout: float = DEFAULT_COMMAND_TIMEOUT):
        result = self.runner.run(argv, timeout_seconds=timeout)
        if result.returncode and not allow_failure:
            raise LifecycleError(
                "external_command_failed",
                "external command failed",
                {"argv": argv, "returncode": result.returncode, "stderr": result.stderr.strip()},
            )
        return result

    def _virsh(self, *args: str, allow_failure: bool = False, timeout: float = DEFAULT_COMMAND_TIMEOUT):
        return self._run(["virsh", "--connect", URI, *map(str, args)], allow_failure=allow_failure, timeout=timeout)

    def _state(self, name: str) -> str:
        return self._virsh("domstate", name).stdout.strip().lower()

    def _domain_xml(self, name: str) -> str:
        return self._virsh("dumpxml", "--inactive", name).stdout

    def _actual_names(self) -> list[str]:
        output = self._virsh("list", "--all", "--name").stdout
        return [line.strip() for line in output.splitlines() if line.strip()]

    @staticmethod
    def _fresh_macs(count: int) -> list[str]:
        values = []
        for _ in range(count):
            suffix = uuid_module.uuid4().bytes[-3:]
            values.append("52:54:00:" + ":".join(f"{part:02x}" for part in suffix))
        return values

    @staticmethod
    def _safe_source(path: Path, kind: str) -> Path:
        if not path.is_absolute() or path.is_symlink() or not path.is_file():
            raise LifecycleError("unsafe_source", f"source {kind} must be an existing non-symlink regular file")
        return path.resolve()

    def _has_managed_save(self, name: str) -> bool:
        result = self._virsh("managedsave-dumpxml", name, allow_failure=True)
        if result.returncode == 0:
            return True
        stderr = result.stderr.strip()
        normalized = stderr.lower()
        if "no managed save image" in normalized or "does not have managed save image" in normalized:
            return False
        raise LifecycleError(
            "inspection_incomplete",
            "could not determine whether managed-save state exists",
            {"domain": name, "returncode": result.returncode, "stderr": stderr},
        )

    def _template_record(self, data: dict, name: str, version: str) -> dict:
        try:
            record = data["templates"][name]["versions"][version]
        except KeyError as exc:
            raise LifecycleError("not_found", f"template {name}@{version} is not published") from exc
        directory = self.store.owned_path("templates", name, version)
        expected = {
            "disk": directory / "disk.qcow2",
            "xml": directory / "domain.xml",
            "nvram": directory / "nvram.fd" if record.get("nvram") else None,
        }
        drift = []
        for field, expected_path in expected.items():
            if expected_path is None:
                continue
            actual = Path(record.get(field, ""))
            if actual != expected_path.absolute() or actual.is_symlink() or not actual.is_file():
                drift.append(field)
        disk = Path(record.get("disk", ""))
        if disk.is_file() and disk.stat().st_mode & 0o222:
            drift.append("disk_mode")
        nvram = Path(record["nvram"]) if record.get("nvram") else None
        if nvram and nvram.is_file() and nvram.stat().st_mode & 0o222:
            drift.append("nvram_mode")
        if drift:
            raise LifecycleError(
                "ownership_drift", "published template storage differs from ownership metadata", {"fields": drift}
            )
        return record

    def host_info(self) -> dict[str, Any]:
        try:
            root = ET.fromstring(self._virsh("capabilities").stdout)
            host = root.find("host")
            cpu = host.find("cpu") if host is not None else None
            if host is None or cpu is None or not (cpu.findtext("arch") or "").strip():
                raise ValueError("missing host CPU architecture")
            topology_element = cpu.find("topology")
            topology = {
                key: int(topology_element.get(key))
                for key in ("sockets", "dies", "cores", "threads")
                if topology_element is not None and topology_element.get(key) is not None
            }
            host_info = {
                "uuid": (host.findtext("uuid") or "").strip() or None,
                "architecture": cpu.findtext("arch").strip(),
                "cpu": {
                    "model": (cpu.findtext("model") or "").strip() or None,
                    "vendor": (cpu.findtext("vendor") or "").strip() or None,
                    "topology": topology,
                    "features": sorted(
                        feature.get("name") for feature in cpu.findall("feature") if feature.get("name")
                    ),
                },
                "power_management": sorted(child.tag for child in host.findall("./power_management/*")),
                "iommu": host.find("iommu") is not None and host.find("iommu").get("support") == "yes",
            }
        except (ET.ParseError, TypeError, ValueError) as exc:
            raise LifecycleError("inspection_incomplete", "libvirt capabilities XML is incomplete or malformed") from exc
        return {"uri": URI, "host": host_info, "version": self._virsh("version").stdout.strip()}

    def template_list(self) -> dict[str, Any]:
        data = self.store.load()
        templates = []
        for name, group in sorted(data["templates"].items()):
            for version, record in sorted(group.get("versions", {}).items()):
                templates.append({"name": name, "version": version, **record})
        return {"templates": templates}

    def template_publish(self, source_vm: str, name: str, version: str) -> dict[str, Any]:
        template_dir = self.store.owned_path("templates", name, version)
        disk = template_dir / "disk.qcow2"
        nvram = template_dir / "nvram.fd"
        xml_path = template_dir / "domain.xml"
        with self.store.mutation_lock():
            self.store.require_no_journal()
            data = self.store.load()
            if version in data["templates"].get(name, {}).get("versions", {}):
                raise LifecycleError("already_exists", f"template {name}@{version} already exists")
            if self._state(source_vm) != "shut off":
                raise LifecycleError("invalid_state", "source domain must be shut off")
            if self._has_managed_save(source_vm):
                raise LifecycleError("managed_save_present", "source domain has managed-save state")
            spec = DomainSpec.from_xml(self._domain_xml(source_vm))
            source_disk = self._safe_source(spec.disk, "disk")
            source_nvram = self._safe_source(spec.nvram, "NVRAM") if spec.nvram else None
            template_uuid = str(uuid_module.uuid4())
            sanitized = sanitize_clone_xml(
                spec,
                f"{name}-{version}-template",
                template_uuid,
                disk,
                nvram if source_nvram else None,
                self._fresh_macs(spec.interface_count),
            )
            proposed = DomainSpec.from_xml(sanitized)
            if proposed.uuid != template_uuid or proposed.disk != disk or proposed.nvram != (nvram if source_nvram else None):
                raise LifecycleError("invalid_generated_xml", "sanitized template XML did not retain the proposed owned identity and storage")
            info = self._run(["qemu-img", "info", "--output=json", "--backing-chain", str(source_disk)])
            try:
                image_info = json.loads(info.stdout)
            except json.JSONDecodeError as exc:
                raise LifecycleError("inspection_incomplete", "qemu-img returned malformed JSON") from exc
            if not image_info or image_info[0].get("format") != "qcow2":
                raise LifecycleError("unsupported_domain", "source disk is not QCOW2")
            resources = [str(disk), str(xml_path)] + ([str(nvram)] if source_nvram else [])
            journal = self.store.begin(f"template_publish:{name}@{version}", resources)
            try:
                template_dir.mkdir(parents=True, exist_ok=False)
                self._run(["qemu-img", "convert", "-O", "qcow2", str(source_disk), str(disk)])
                os.chmod(disk, 0o444)
                if source_nvram:
                    shutil.copy2(source_nvram, nvram)
                    os.chmod(nvram, 0o444)
                xml_path.write_text(sanitized, encoding="utf-8")
                record = {
                    "source_vm": source_vm,
                    "source_uuid": spec.uuid,
                    "template_uuid": template_uuid,
                    "disk": str(disk.resolve()),
                    "xml": str(xml_path.resolve()),
                    "nvram": str(nvram.resolve()) if source_nvram else None,
                }
                self.store.persist_paths([disk, xml_path] + ([nvram] if source_nvram else []))
                data["templates"].setdefault(name, {"versions": {}})["versions"][version] = record
                self.store.save(data)
                self.store.clear_journal()
                return {"name": name, "version": version, **record}
            except Exception as exc:
                self._raise_partial(journal, exc)

    def _image_chain(self, path: Path) -> list[dict]:
        result = self._run(
            ["qemu-img", "info", "--output=json", "--backing-chain", str(path)], allow_failure=True
        )
        if result.returncode:
            raise LifecycleError(
                "inspection_incomplete", "could not inspect a domain disk dependency", {"disk": str(path), "stderr": result.stderr}
            )
        try:
            value = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise LifecycleError("inspection_incomplete", "qemu-img dependency output was malformed", {"disk": str(path)}) from exc
        if not isinstance(value, list):
            raise LifecycleError("inspection_incomplete", "qemu-img dependency output was incomplete", {"disk": str(path)})
        return value

    def _actual_template_dependents(self, target: Path) -> list[str]:
        dependents = []
        target = target.resolve()
        for domain_name in self._actual_names():
            try:
                root = ET.fromstring(self._domain_xml(domain_name))
            except (LifecycleError, ET.ParseError) as exc:
                raise LifecycleError("inspection_incomplete", "could not inspect every local domain") from exc
            for disk in root.findall("./devices/disk"):
                if disk.get("device", "disk") != "disk":
                    continue
                source = disk.find("source")
                filename = source.get("file") if source is not None else None
                if not filename:
                    raise LifecycleError("inspection_incomplete", "a writable domain disk is not file-backed")
                chain = self._image_chain(Path(filename))
                referenced = {
                    Path(item[key]).resolve()
                    for item in chain
                    for key in ("filename", "full-backing-filename")
                    if item.get(key)
                }
                if target in referenced:
                    dependents.append(domain_name)
                    break
        return dependents

    def template_remove(self, name: str, version: str) -> dict[str, Any]:
        with self.store.mutation_lock():
            self.store.require_no_journal()
            data = self.store.load()
            record = self._template_record(data, name, version)
            metadata_dependents = [
                vm_name
                for vm_name, vm in data["vms"].items()
                if vm.get("template") == name and vm.get("version") == version
            ]
            if metadata_dependents:
                raise LifecycleError("template_in_use", "template has managed dependents", {"vms": metadata_dependents})
            actual_dependents = self._actual_template_dependents(Path(record["disk"]))
            if actual_dependents:
                raise LifecycleError("template_in_use", "template has actual disk dependents", {"vms": actual_dependents})
            directory = self.store.owned_path("templates", name, version)
            journal = self.store.begin(f"template_remove:{name}@{version}", [str(directory)])
            try:
                shutil.rmtree(directory)
                self.store.persist_directory(directory.parent)
                del data["templates"][name]["versions"][version]
                if not data["templates"][name]["versions"]:
                    del data["templates"][name]
                self.store.save(data)
                self.store.clear_journal()
                return {"name": name, "version": version, "removed": True}
            except Exception as exc:
                self._raise_partial(journal, exc)

    def vm_list(self) -> dict[str, Any]:
        data = self.store.load()
        values = []
        for name in self._actual_names():
            state = self._state(name)
            managed = data["vms"].get(name)
            values.append({"name": name, "state": state, "managed": managed is not None, **(managed or {})})
        return {"vms": values}

    def _inspect_managed(self, name: str, data: dict | None = None) -> tuple[dict, DomainSpec, str, list[str]]:
        data = data or self.store.load()
        record = data["vms"].get(name)
        if record is None:
            raise LifecycleError("not_managed", f"domain {name} is not a managed working VM")
        spec = DomainSpec.from_xml(self._domain_xml(name))
        drift = []
        if spec.uuid != record["uuid"]:
            drift.append("uuid")
        if spec.disk.resolve() != Path(record["disk"]).resolve():
            drift.append("disk")
        vm_dir = self.store.owned_path("vms", name).absolute()
        try:
            Path(record["disk"]).resolve().relative_to(vm_dir.resolve())
            disk_owned = True
        except ValueError:
            disk_owned = False
        if not disk_owned or spec.disk.is_symlink() or not spec.disk.is_file():
            if "disk" not in drift:
                drift.append("disk")
        actual_nvram = spec.nvram.resolve() if spec.nvram else None
        recorded_nvram = Path(record["nvram"]).resolve() if record.get("nvram") else None
        if actual_nvram != recorded_nvram:
            drift.append("nvram")
        if record.get("nvram"):
            try:
                Path(record["nvram"]).resolve().relative_to(vm_dir.resolve())
                nvram_owned = True
            except ValueError:
                nvram_owned = False
            if not nvram_owned or spec.nvram.is_symlink() or not spec.nvram.is_file():
                if "nvram" not in drift:
                    drift.append("nvram")
        return record, spec, self._state(name), drift

    def vm_inspect(self, name: str) -> dict[str, Any]:
        data = self.store.load()
        if name not in data["vms"]:
            spec = DomainSpec.from_xml(self._domain_xml(name))
            return {"name": name, "uuid": spec.uuid, "disk": str(spec.disk), "managed": False, "state": self._state(name)}
        record, _spec, state, drift = self._inspect_managed(name, data)
        return {"name": name, **record, "managed": True, "state": state, "drift": drift}

    def vm_create(
        self,
        name: str,
        template: str,
        version: str,
        vcpus: int | None = None,
        memory_mib: int | None = None,
        guest_user: str | None = None,
        ssh_public_key: str | None = None,
    ) -> dict[str, Any]:
        if (guest_user is None) != (ssh_public_key is None):
            raise LifecycleError(
                "invalid_guest_access", "guest_user and ssh_public_key must either both be supplied or both be omitted"
            )
        guest_request = None
        validate_overrides(vcpus, memory_mib)
        vm_dir = self.store.owned_path("vms", name)
        disk = vm_dir / "disk.qcow2"
        nvram = vm_dir / "nvram.fd"
        xml_path = vm_dir / "domain.xml"
        with self.store.mutation_lock():
            self.store.require_no_journal()
            if guest_user is not None and ssh_public_key is not None:
                guest_request = self.guest_access.prepare(guest_user, ssh_public_key)
            data = self.store.load()
            if name in data["vms"] or self._virsh("dominfo", name, allow_failure=True).returncode == 0:
                raise LifecycleError("already_exists", f"domain {name} already exists")
            template_record = self._template_record(data, template, version)
            template_spec = DomainSpec.from_xml(Path(template_record["xml"]).read_text(encoding="utf-8"))
            vm_uuid = str(uuid_module.uuid4())
            vm_nvram = nvram if template_record.get("nvram") else None
            xml = sanitize_clone_xml(
                template_spec,
                name,
                vm_uuid,
                disk.absolute(),
                vm_nvram.absolute() if vm_nvram else None,
                self._fresh_macs(template_spec.interface_count),
                vcpus,
                memory_mib,
            )
            proposed = DomainSpec.from_xml(xml)
            if proposed.name != name or proposed.uuid != vm_uuid or proposed.disk != disk.absolute() or proposed.nvram != (vm_nvram.absolute() if vm_nvram else None):
                raise LifecycleError("invalid_generated_xml", "clone XML did not retain the proposed owned identity and storage")
            resources = [str(disk), str(xml_path), f"domain:{name}"]
            if template_record.get("nvram"):
                resources.append(str(nvram))
            journal = self.store.begin(f"vm_create:{name}", resources)
            try:
                guest_access_metadata = None
                if guest_request is not None:
                    pending_guest_access = {
                        "user": guest_request.user,
                        "fingerprint": guest_request.fingerprint,
                        "status": "pending",
                    }
                    self.store.update_journal(
                        journal, "creating_overlay", guest_access=pending_guest_access
                    )
                vm_dir.mkdir(parents=True, exist_ok=False)
                base = str(Path(template_record["disk"]).resolve())
                self._run(["qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", base, str(disk)])
                if guest_request is not None:
                    self.store.update_journal(
                        journal, "provisioning_guest", guest_access=pending_guest_access
                    )
                    guest_access_metadata = self.guest_access.provision(disk, guest_request)
                    self.store.update_journal(
                        journal, "guest_provisioned", guest_access=guest_access_metadata
                    )
                if template_record.get("nvram"):
                    shutil.copy2(template_record["nvram"], nvram)
                    os.chmod(nvram, 0o600)
                xml_path.write_text(xml, encoding="utf-8")
                self.store.persist_paths([disk, xml_path] + ([nvram] if vm_nvram else []))
                self._virsh("define", str(xml_path))
                actual = DomainSpec.from_xml(self._domain_xml(name))
                mismatched = sorted(
                    field
                    for field, expected, observed in (
                        ("name", name, actual.name),
                        ("uuid", vm_uuid, actual.uuid),
                        ("disk", disk.absolute(), actual.disk),
                        ("nvram", vm_nvram.absolute() if vm_nvram else None, actual.nvram),
                    )
                    if expected != observed
                )
                if mismatched:
                    raise LifecycleError(
                        "domain_postcondition_failed",
                        "defined domain identity or storage did not match the proposed managed domain",
                        {"domain": name, "fields": mismatched},
                    )
                record = {
                    "uuid": vm_uuid,
                    "template": template,
                    "version": version,
                    "disk": str(disk.resolve()),
                    "xml": str(xml_path.resolve()),
                    "nvram": str(nvram.resolve()) if vm_nvram else None,
                }
                if guest_access_metadata is not None:
                    record["guest_access"] = guest_access_metadata
                data["vms"][name] = record
                self.store.save(data)
                self.store.clear_journal()
                return {"name": name, "state": "shut off", **record}
            except Exception as exc:
                self._raise_partial(journal, exc)

    def _require_owned(self, name: str, data: dict) -> tuple[dict, str]:
        record, _spec, state, drift = self._inspect_managed(name, data)
        if drift:
            raise LifecycleError("ownership_drift", "actual domain identity/storage differs from ownership metadata", {"fields": drift})
        from .snapshots import SnapshotManager

        manager = SnapshotManager(self)
        manager.validate_metadata(name, data, record)
        if state == "shut off":
            manager.validate_graph(name, data, record, metadata_validated=True)
        if self._has_managed_save(name):
            raise LifecycleError("managed_save_present", "working VM has managed-save state")
        return record, state

    def snapshot_list(self, name: str) -> dict[str, Any]:
        from .snapshots import SnapshotManager

        return SnapshotManager(self).list(name)

    def snapshot_create(self, name: str, snapshot: str, description: str = "") -> dict[str, Any]:
        from .snapshots import SnapshotManager

        return SnapshotManager(self).create(name, snapshot, description)

    def snapshot_restore(self, name: str, snapshot: str) -> dict[str, Any]:
        from .snapshots import SnapshotManager

        return SnapshotManager(self).restore(name, snapshot)

    def vm_start(self, name: str) -> dict[str, Any]:
        with self.store.mutation_lock():
            self.store.require_no_journal()
            data = self.store.load()
            record, state = self._require_owned(name, data)
            if state == "running":
                return {"name": name, "state": state, **record}
            if state != "shut off":
                raise LifecycleError("invalid_state", f"cannot start domain from state {state}")
            self._virsh("start", name)
            return {"name": name, "state": self._state(name), **record}

    def vm_shutdown(self, name: str, timeout_seconds: int = 60) -> dict[str, Any]:
        if (
            isinstance(timeout_seconds, bool)
            or not isinstance(timeout_seconds, (int, float))
            or not math.isfinite(timeout_seconds)
            or timeout_seconds < 0
        ):
            raise LifecycleError("invalid_argument", "timeout_seconds must be finite and non-negative")
        with self.store.mutation_lock():
            self.store.require_no_journal()
            data = self.store.load()
            record, state = self._require_owned(name, data)
            if state == "shut off":
                return {"name": name, "state": state, **record}
            if state != "running":
                raise LifecycleError("invalid_state", f"cannot shut down domain from state {state}")
            self._virsh("shutdown", name)
            deadline = time.monotonic() + timeout_seconds
            while True:
                state = self._state(name)
                if state == "shut off":
                    return {"name": name, "state": state, **record}
                if time.monotonic() >= deadline:
                    raise LifecycleError(
                        "shutdown_timeout",
                        "domain did not shut down before the deadline; it was not force-stopped",
                        {"timeout_seconds": timeout_seconds, "state": state},
                    )
                time.sleep(min(0.25, max(0, deadline - time.monotonic())))

    def vm_force_stop(self, name: str) -> dict[str, Any]:
        with self.store.mutation_lock():
            self.store.require_no_journal()
            data = self.store.load()
            record, state = self._require_owned(name, data)
            if state == "shut off":
                return {"name": name, "state": state, **record}
            self._virsh("destroy", name)
            return {"name": name, "state": self._state(name), **record}

    def vm_delete(self, name: str) -> dict[str, Any]:
        with self.store.mutation_lock():
            self.store.require_no_journal()
            data = self.store.load()
            record, state = self._require_owned(name, data)
            if state != "shut off":
                raise LifecycleError("invalid_state", "working VM must be shut off before deletion")
            vm_dir = self.store.owned_path("vms", name)
            journal = self.store.begin(f"vm_delete:{name}", [f"domain:{name}", str(vm_dir)])
            try:
                undefine_args = ("undefine", "--nvram", name) if record.get("nvram") else ("undefine", name)
                self._virsh(*undefine_args)
                shutil.rmtree(vm_dir)
                self.store.persist_directory(vm_dir.parent)
                del data["vms"][name]
                self.store.save(data)
                self.store.clear_journal()
                return {"name": name, "removed": True, "uuid": record["uuid"]}
            except Exception as exc:
                self._raise_partial(journal, exc)

    def _raise_partial(self, journal: dict, exc: Exception):
        cause = exc.as_dict() if isinstance(exc, LifecycleError) else {"type": type(exc).__name__, "message": str(exc)}
        journal.update({"failed_stage": journal.get("stage"), "stage": "recovery_required", "cause": cause})
        journal_error = None
        try:
            self.store.update_journal(journal, "recovery_required", cause=cause)
        except Exception as persistence_exc:
            journal_error = {"type": type(persistence_exc).__name__, "message": str(persistence_exc)}
        details = dict(journal)
        details["journal"] = str(self.store.journal_path)
        if journal_error:
            details["journal_error"] = journal_error
        raise LifecycleError(
            "recovery_required",
            "operation was interrupted after resources may have changed; automatic rollback was not attempted",
            details,
        ) from exc
