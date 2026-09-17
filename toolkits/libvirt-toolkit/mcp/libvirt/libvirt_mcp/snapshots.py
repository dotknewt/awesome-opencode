from __future__ import annotations

import copy
import os
import shutil
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .domain import DomainSpec, rewrite_nvram
from .errors import LifecycleError

if TYPE_CHECKING:
    from .lifecycle import Lifecycle


class SnapshotManager:
    """Offline, toolkit-managed external disk snapshots for a Lifecycle."""

    def __init__(self, lifecycle: "Lifecycle"):
        self.lifecycle = lifecycle
        self.store = lifecycle.store

    def list(self, name: str) -> dict[str, Any]:
        data = self.store.load()
        record = data["vms"].get(name)
        if record is None:
            raise LifecycleError("not_managed", f"domain {name} is not a managed working VM")
        snapshots = [self._public_snapshot(item) for _, item in sorted(record.get("snapshots", {}).items())]
        return {"name": name, "snapshots": snapshots}

    def create(self, name: str, snapshot: str, description: str = "") -> dict[str, Any]:
        snapshot_dir = self.store.owned_path("vms", name, "snapshots", snapshot)
        if not isinstance(description, str):
            raise LifecycleError("invalid_argument", "snapshot description must be a string")
        with self.store.mutation_lock():
            self.store.require_no_journal()
            data = self.store.load()
            record, spec, state = self._require_offline_owned(name, data)
            snapshots = record.setdefault("snapshots", {})
            if snapshot in snapshots:
                raise LifecycleError("already_exists", f"snapshot {snapshot} already exists for domain {name}")

            operation_id = str(uuid.uuid4())
            layer = Path(record["disk"])
            new_disk = self.store.owned_path("vms", name, "layers", operation_id + ".qcow2")
            archive_xml = snapshot_dir / "domain.xml"
            archive_nvram = snapshot_dir / "nvram.fd" if record.get("nvram") else None
            archived_xml = rewrite_snapshot_xml(
                spec.xml,
                name,
                record["uuid"],
                layer.resolve(),
                archive_nvram.absolute() if archive_nvram else None,
            )
            active_xml = rewrite_snapshot_xml(
                spec.xml,
                name,
                record["uuid"],
                new_disk.absolute(),
                Path(record["nvram"]) if record.get("nvram") else None,
            )
            for proposed_xml, proposed_disk, proposed_nvram in (
                (archived_xml, layer.resolve(), archive_nvram.absolute() if archive_nvram else None),
                (active_xml, new_disk.absolute(), Path(record["nvram"]) if record.get("nvram") else None),
            ):
                proposed = DomainSpec.from_xml(proposed_xml)
                if proposed.disk != proposed_disk or proposed.nvram != proposed_nvram:
                    raise LifecycleError("invalid_generated_xml", "snapshot XML did not retain proposed owned storage")
            resources = [f"domain:{name}", str(layer), str(new_disk), str(archive_xml)]
            if archive_nvram:
                resources.append(str(archive_nvram))
            pre_operation = self._pre_operation(record)
            journal = self.store.begin(f"snapshot_create:{name}:{snapshot}", resources)
            self.store.update_journal(journal, "creating", pre_operation=pre_operation)
            try:
                snapshot_dir.mkdir(parents=True, exist_ok=False)
                new_disk.parent.mkdir(parents=True, exist_ok=True)
                if archive_nvram:
                    shutil.copy2(record["nvram"], archive_nvram)
                    os.chmod(archive_nvram, 0o444)
                archive_xml.write_text(archived_xml, encoding="utf-8")
                os.chmod(archive_xml, 0o444)
                self.lifecycle._run(
                    ["qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", str(layer.resolve()), str(new_disk)]
                )
                Path(record["xml"]).write_text(active_xml, encoding="utf-8")
                self.store.persist_paths([archive_xml, new_disk, Path(record["xml"])] + ([archive_nvram] if archive_nvram else []))
                self.store.update_journal(journal, "define", pre_operation=pre_operation)
                self.lifecycle._virsh("define", record["xml"])
                os.chmod(layer, 0o444)
                self.store.persist_paths([layer])
                snapshot_record = {
                    "name": snapshot,
                    "description": description,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "parent": record.get("active_parent"),
                    "layer": str(layer.resolve()),
                    "disk": str(layer.resolve()),
                    "xml": str(archive_xml.resolve()),
                    "nvram": str(archive_nvram.resolve()) if archive_nvram else None,
                }
                snapshots[snapshot] = snapshot_record
                record["disk"] = str(new_disk.resolve())
                record["active_parent"] = snapshot
                self.store.update_journal(journal, "registry", pre_operation=pre_operation)
                self.store.save(data)
                self.store.clear_journal()
                return {"vm": name, **self._public_snapshot(snapshot_record)}
            except Exception as exc:
                self.lifecycle._raise_partial(journal, exc)

    def restore(self, name: str, snapshot: str) -> dict[str, Any]:
        # Validate the public identifier before entering the mutation boundary.
        self.store.owned_path("vms", name, "snapshots", snapshot)
        with self.store.mutation_lock():
            self.store.require_no_journal()
            data = self.store.load()
            record, current_spec, _state = self._require_offline_owned(name, data)
            try:
                selected = record.get("snapshots", {})[snapshot]
            except KeyError as exc:
                raise LifecycleError("not_found", f"snapshot {snapshot} does not exist for domain {name}") from exc

            operation_id = str(uuid.uuid4())
            new_disk = self.store.owned_path("vms", name, "layers", operation_id + ".qcow2")
            new_nvram = (
                self.store.owned_path("vms", name, "firmwares", operation_id + ".fd") if selected.get("nvram") else None
            )
            recovery_xml = self.store.owned_path("vms", name, "recovery", operation_id, "domain.xml")
            archived_spec = DomainSpec.from_xml(Path(selected["xml"]).read_text(encoding="utf-8"))
            if archived_spec.name != name or archived_spec.uuid != record["uuid"]:
                raise LifecycleError("ownership_drift", "snapshot domain identity differs from the managed VM")
            restored_xml = rewrite_snapshot_xml(
                archived_spec.xml,
                name,
                record["uuid"],
                new_disk.absolute(),
                new_nvram.absolute() if new_nvram else None,
            )
            proposed = DomainSpec.from_xml(restored_xml)
            if proposed.disk != new_disk.absolute() or proposed.nvram != (new_nvram.absolute() if new_nvram else None):
                raise LifecycleError("invalid_generated_xml", "restored snapshot XML did not retain proposed owned storage")
            resources = [
                f"domain:{name}",
                str(new_disk),
                str(selected["layer"]),
                str(record["disk"]),
                str(record["xml"]),
                str(recovery_xml),
            ]
            if new_nvram:
                resources.append(str(new_nvram))
            if record.get("nvram"):
                resources.append(record["nvram"])
            pre_operation = self._pre_operation(record)
            pre_operation["xml_archive"] = str(recovery_xml.absolute())
            journal = self.store.begin(f"snapshot_restore:{name}:{snapshot}", resources)
            self.store.update_journal(journal, "creating", pre_operation=pre_operation)
            try:
                recovery_xml.parent.mkdir(parents=True, exist_ok=False)
                recovery_xml.write_text(current_spec.xml, encoding="utf-8")
                os.chmod(recovery_xml, 0o444)
                self.store.persist_paths([recovery_xml])
                new_disk.parent.mkdir(parents=True, exist_ok=True)
                self.lifecycle._run(
                    [
                        "qemu-img",
                        "create",
                        "-f",
                        "qcow2",
                        "-F",
                        "qcow2",
                        "-b",
                        str(Path(selected["layer"]).resolve()),
                        str(new_disk),
                    ]
                )
                if new_nvram:
                    new_nvram.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(selected["nvram"], new_nvram)
                    os.chmod(new_nvram, 0o600)
                Path(record["xml"]).write_text(restored_xml, encoding="utf-8")
                self.store.persist_paths([new_disk, Path(record["xml"])] + ([new_nvram] if new_nvram else []))
                self.store.update_journal(journal, "define", pre_operation=pre_operation)
                self.lifecycle._virsh("define", record["xml"])

                previous_disk = Path(record["disk"])
                os.chmod(previous_disk, 0o444)
                immutable_previous = [previous_disk, recovery_xml]
                if record.get("nvram"):
                    os.chmod(record["nvram"], 0o444)
                    immutable_previous.append(Path(record["nvram"]))
                self.store.persist_paths(immutable_previous)
                record.setdefault("retained_layers", []).append(
                    {"disk": record["disk"], "parent": record.get("active_parent")}
                )
                if record.get("nvram"):
                    record.setdefault("retained_nvram", []).append(record["nvram"])
                record.setdefault("retained_xml", []).append(str(recovery_xml.resolve()))
                record["disk"] = str(new_disk.resolve())
                record["nvram"] = str(new_nvram.resolve()) if new_nvram else None
                record["active_parent"] = snapshot
                self.store.update_journal(journal, "registry", pre_operation=pre_operation)
                self.store.save(data)
                self.store.clear_journal()
                return {"name": name, "state": "shut off", "restored_snapshot": snapshot, **record}
            except Exception as exc:
                self.lifecycle._raise_partial(journal, exc)

    def validate_metadata(self, name: str, data: dict, record: dict | None = None) -> None:
        record = record or data["vms"].get(name)
        if record is None:
            raise LifecycleError("not_managed", f"domain {name} is not a managed working VM")
        self.lifecycle._template_record(data, record["template"], record["version"])
        snapshots = record.get("snapshots", {})
        vm_dir = self.store.owned_path("vms", name)
        expected_xml = vm_dir / "domain.xml"
        if Path(record.get("xml", "")) != expected_xml.absolute():
            raise LifecycleError("ownership_drift", "active domain XML path differs from ownership metadata")
        self._owned_file(Path(record["xml"]), vm_dir, "active domain XML")
        if record.get("nvram"):
            self._owned_file(Path(record["nvram"]), vm_dir, "active NVRAM")

        for snapshot_name, item in snapshots.items():
            expected_dir = self.store.owned_path("vms", name, "snapshots", snapshot_name)
            self._owned_file(Path(item.get("layer", "")), vm_dir, "snapshot layer")
            self._require_read_only(Path(item["layer"]), "snapshot layer")
            if item.get("disk") != item.get("layer"):
                raise LifecycleError("ownership_drift", "snapshot disk alias differs from its layer")
            if Path(item.get("xml", "")) != (expected_dir / "domain.xml").absolute():
                raise LifecycleError("ownership_drift", "snapshot XML path differs from ownership metadata")
            self._owned_file(Path(item["xml"]), vm_dir, "snapshot XML")
            self._require_read_only(Path(item["xml"]), "snapshot XML")
            try:
                archived = DomainSpec.from_xml(Path(item["xml"]).read_text(encoding="utf-8"))
            except LifecycleError as exc:
                raise LifecycleError("ownership_drift", "snapshot XML is not a valid owned archive") from exc
            if archived.name != name or archived.uuid != record["uuid"] or archived.disk.resolve() != Path(item["layer"]).resolve():
                raise LifecycleError("ownership_drift", "snapshot XML identity/storage differs from snapshot metadata")
            archived_has_nvram = archived.nvram is not None
            metadata_has_nvram = bool(item.get("nvram"))
            if archived_has_nvram != metadata_has_nvram:
                raise LifecycleError("ownership_drift", "snapshot XML/NVRAM presence differs from snapshot metadata")
            if metadata_has_nvram:
                if Path(item["nvram"]) != (expected_dir / "nvram.fd").absolute():
                    raise LifecycleError("ownership_drift", "snapshot NVRAM path differs from ownership metadata")
                self._owned_file(Path(item["nvram"]), vm_dir, "snapshot NVRAM")
                self._require_read_only(Path(item["nvram"]), "snapshot NVRAM")
                if archived.nvram.resolve() != Path(item["nvram"]).resolve():
                    raise LifecycleError("ownership_drift", "snapshot XML NVRAM differs from snapshot metadata")
            parent = item.get("parent")
            if parent is not None and parent not in snapshots:
                raise LifecycleError("ownership_drift", "snapshot parent is missing", {"snapshot": snapshot_name})

        active = Path(record["disk"])
        self._owned_file(active, vm_dir, "active disk")
        active_parent = record.get("active_parent")
        if active_parent is not None and active_parent not in snapshots:
            raise LifecycleError("ownership_drift", "active snapshot parent is missing")
        for retained in record.get("retained_layers", []):
            path = Path(retained["disk"])
            self._owned_file(path, vm_dir, "retained layer")
            self._require_read_only(path, "retained layer")
            parent = retained.get("parent")
            if parent is not None and parent not in snapshots:
                raise LifecycleError("ownership_drift", "retained layer parent is missing")
        for retained_nvram in record.get("retained_nvram", []):
            path = Path(retained_nvram)
            self._owned_file(path, vm_dir, "retained NVRAM")
            self._require_read_only(path, "retained NVRAM")
        for retained_xml in record.get("retained_xml", []):
            path = Path(retained_xml)
            self._owned_file(path, vm_dir, "retained domain XML")
            self._require_read_only(path, "retained domain XML")

    def validate_graph(
        self, name: str, data: dict, record: dict | None = None, *, metadata_validated: bool = False
    ) -> None:
        record = record or data["vms"].get(name)
        if not metadata_validated:
            self.validate_metadata(name, data, record)
        template = self.lifecycle._template_record(data, record["template"], record["version"])
        template_disk = Path(template["disk"]).resolve()
        snapshots = record.get("snapshots", {})
        for item in snapshots.values():
            parent = item.get("parent")
            expected_backing = Path(snapshots[parent]["layer"]).resolve() if parent else template_disk
            self._validate_backing(Path(item["layer"]), expected_backing)
        active_parent = record.get("active_parent")
        expected_active_backing = Path(snapshots[active_parent]["layer"]).resolve() if active_parent else template_disk
        self._validate_backing(Path(record["disk"]), expected_active_backing)
        for retained in record.get("retained_layers", []):
            parent = retained.get("parent")
            expected = Path(snapshots[parent]["layer"]).resolve() if parent else template_disk
            self._validate_backing(Path(retained["disk"]), expected)

    def _require_offline_owned(self, name: str, data: dict) -> tuple[dict, DomainSpec, str]:
        record, spec, state, drift = self.lifecycle._inspect_managed(name, data)
        if drift:
            raise LifecycleError("ownership_drift", "actual domain identity/storage differs from ownership metadata", {"fields": drift})
        if state != "shut off":
            raise LifecycleError("invalid_state", "working VM must be shut off for snapshot operations")
        self.validate_graph(name, data, record)
        if self.lifecycle._has_managed_save(name):
            raise LifecycleError("managed_save_present", "working VM has managed-save state")
        # Out-of-band libvirt changes do not honor the toolkit lock. Recheck as
        # the final inspection before creating files or rewriting configuration.
        state = self.lifecycle._state(name)
        if state != "shut off":
            raise LifecycleError("invalid_state", "working VM must remain shut off for snapshot operations")
        return record, spec, state

    def _validate_backing(self, disk: Path, expected: Path) -> None:
        chain = self.lifecycle._image_chain(disk)
        if not chain or Path(chain[0].get("filename", "")).resolve() != disk.resolve():
            raise LifecycleError("ownership_drift", "disk inspection did not identify the owned layer", {"disk": str(disk)})
        backing = chain[0].get("full-backing-filename")
        if not backing or Path(backing).resolve() != expected.resolve():
            raise LifecycleError(
                "ownership_drift",
                "actual disk backing differs from snapshot metadata",
                {"disk": str(disk), "expected_backing": str(expected), "actual_backing": backing},
            )

    @staticmethod
    def _owned_file(path: Path, vm_dir: Path, kind: str) -> None:
        try:
            path.resolve().relative_to(vm_dir.resolve())
        except ValueError as exc:
            raise LifecycleError("ownership_drift", f"{kind} escapes the managed VM directory") from exc
        if path.is_symlink() or not path.is_file():
            raise LifecycleError("ownership_drift", f"{kind} is missing or unsafe")

    @staticmethod
    def _require_read_only(path: Path, kind: str) -> None:
        if path.stat().st_mode & 0o222:
            raise LifecycleError("ownership_drift", f"{kind} is unexpectedly writable")

    @staticmethod
    def _pre_operation(record: dict) -> dict:
        return {
            "uuid": record["uuid"],
            "disk": record["disk"],
            "xml": record["xml"],
            "nvram": record.get("nvram"),
            "active_parent": record.get("active_parent"),
        }

    @staticmethod
    def _public_snapshot(record: dict) -> dict:
        return copy.deepcopy(record)


def rewrite_snapshot_xml(xml: str, name: str, domain_uuid: str, disk: Path, nvram: Path | None) -> str:
    """Preserve snapshot configuration/identity while selecting new owned state."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise LifecycleError("invalid_domain_xml", "archived snapshot XML is malformed") from exc
    root.find("name").text = name
    root.find("uuid").text = domain_uuid
    writable = []
    for element in root.findall("./devices/disk"):
        if element.get("device", "disk") == "disk" and element.find("readonly") is None:
            writable.append(element)
    if len(writable) != 1:
        raise LifecycleError("unsupported_domain", "snapshot XML must contain exactly one writable disk")
    source = writable[0].find("source")
    if source is None:
        raise LifecycleError("unsupported_domain", "snapshot writable disk has no source")
    source.attrib.clear()
    source.set("file", str(disk))
    rewrite_nvram(root, nvram)
    return ET.tostring(root, encoding="unicode")
