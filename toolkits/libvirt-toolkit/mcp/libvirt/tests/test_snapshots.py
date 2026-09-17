from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from libvirt_mcp.commands import CommandRunner
from libvirt_mcp.errors import LifecycleError
from libvirt_mcp.lifecycle import Lifecycle

from fakes import FakeRunner


FIXTURE = Path(__file__).parent / "fixtures" / "source.xml"


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "managed"
        self.source_disk = Path(self.temp.name) / "source.qcow2"
        self.source_nvram = Path(self.temp.name) / "source_NVRAM.fd"
        self.source_disk.write_bytes(b"source image")
        self.source_nvram.write_bytes(b"firmware state")
        self.fake = FakeRunner(FIXTURE.read_text(encoding="utf-8"), self.source_disk, self.source_nvram)
        self.service = Lifecycle(self.root, runner=self.fake)
        self.service.template_publish("source-vm", "ubuntu", "v1")
        self.vm = self.service.vm_create("work-a", "ubuntu", "v1")

    def tearDown(self):
        self.temp.cleanup()

    def assert_error(self, code, function, *args, **kwargs):
        with self.assertRaises(LifecycleError) as caught:
            function(*args, **kwargs)
        self.assertEqual(code, caught.exception.code)
        return caught.exception

    def snapshot_names(self):
        return [item["name"] for item in self.service.snapshot_list("work-a")["snapshots"]]

    def test_create_uses_fresh_overlay_and_lists_durable_record(self):
        original = self.vm["disk"]
        saved = self.service.snapshot_create("work-a", "before-upgrade", "safe point")
        active = self.service.vm_inspect("work-a")["disk"]

        self.assertEqual(original, saved["disk"])
        self.assertEqual(original, self.fake.backing_for(active))
        self.assertNotEqual(original, active)
        self.assertEqual(0, Path(original).stat().st_mode & 0o222)
        self.assertEqual(["before-upgrade"], self.snapshot_names())
        listed = self.service.snapshot_list("work-a")["snapshots"][0]
        self.assertEqual("safe point", listed["description"])
        self.assertIsNone(listed["parent"])
        self.assertTrue(Path(listed["xml"]).is_file())
        self.assertTrue(Path(listed["nvram"]).is_file())
        archived = ET.fromstring(Path(listed["xml"]).read_text(encoding="utf-8"))
        self.assertEqual(listed["nvram"], archived.find("./os/nvram/source").get("file"))
        json.dumps(listed)

    def test_legacy_text_nvram_survives_publication_clone_snapshot_and_restore(self):
        source = FIXTURE.read_text(encoding="utf-8").replace(
            '<nvram type="file" template="/usr/share/OVMF/OVMF_VARS.fd"><source file="/SOURCE/NVRAM.fd"/></nvram>',
            '<nvram template="/usr/share/OVMF/OVMF_VARS.fd">/SOURCE/NVRAM.fd</nvram>',
        )
        legacy_root = Path(self.temp.name) / "legacy-managed"
        fake = FakeRunner(source, self.source_disk, self.source_nvram)
        service = Lifecycle(legacy_root, runner=fake)
        template = service.template_publish("source-vm", "legacy", "v1")
        vm = service.vm_create("legacy-work", "legacy", "v1")
        saved = service.snapshot_create("legacy-work", "point")
        restored = service.snapshot_restore("legacy-work", "point")
        for xml_path, expected in (
            (template["xml"], template["nvram"]),
            (saved["xml"], saved["nvram"]),
            (restored["xml"], restored["nvram"]),
        ):
            nvram = ET.fromstring(Path(xml_path).read_text(encoding="utf-8")).find("./os/nvram")
            self.assertEqual(expected, (nvram.text or "").strip())
            self.assertIsNone(nvram.find("source"))
        active = ET.fromstring(fake.domains["legacy-work"]["xml"]).find("./os/nvram")
        self.assertNotEqual(vm["nvram"], restored["nvram"])
        self.assertEqual(restored["nvram"], (active.text or "").strip())

    def test_create_and_restore_require_shut_off_without_managed_save(self):
        self.fake.domains["work-a"]["state"] = "running"
        self.assert_error("invalid_state", self.service.snapshot_create, "work-a", "point")
        self.fake.domains["work-a"]["state"] = "shut off"
        self.fake.domains["work-a"]["managed_save"] = True
        self.assert_error("managed_save_present", self.service.snapshot_create, "work-a", "point")
        self.fake.domains["work-a"]["managed_save"] = False
        self.service.snapshot_create("work-a", "point")
        self.fake.domains["work-a"]["managed_save"] = True
        self.assert_error("managed_save_present", self.service.snapshot_restore, "work-a", "point")
        self.fake.domains["work-a"]["managed_save"] = False
        self.fake.domains["work-a"]["state"] = "running"
        self.assert_error("invalid_state", self.service.snapshot_restore, "work-a", "point")

    def test_out_of_band_start_during_inspection_is_rejected_before_journal(self):
        with patch.object(self.service, "_state", side_effect=["shut off", "running"]):
            self.assert_error("invalid_state", self.service.snapshot_create, "work-a", "point")
        self.assertFalse(self.service.store.journal_path.exists())

    def test_duplicate_missing_and_foreign_domain_errors(self):
        self.service.snapshot_create("work-a", "point")
        self.assert_error("already_exists", self.service.snapshot_create, "work-a", "point")
        self.assert_error("not_found", self.service.snapshot_restore, "work-a", "missing")
        self.assert_error("not_managed", self.service.snapshot_list, "source-vm")

    def test_repeated_restore_preserves_snapshots_siblings_and_reachability(self):
        first = self.service.snapshot_create("work-a", "first")
        second = self.service.snapshot_create("work-a", "second")
        self.service.snapshot_restore("work-a", "first")
        restored_once = self.service.vm_inspect("work-a")["disk"]
        self.assertEqual(first["disk"], self.fake.backing_for(restored_once))
        self.service.snapshot_restore("work-a", "first")
        restored_twice = self.service.vm_inspect("work-a")["disk"]

        self.assertNotEqual(restored_once, restored_twice)
        self.assertEqual(first["disk"], self.fake.backing_for(restored_twice))
        self.assertEqual({"first", "second"}, set(self.snapshot_names()))
        self.assertEqual("first", next(item for item in self.service.snapshot_list("work-a")["snapshots"] if item["name"] == "second")["parent"])
        for path in (first["disk"], second["disk"], restored_once):
            self.assertTrue(Path(path).is_file())
            self.assertEqual(0, Path(path).stat().st_mode & 0o222)

    def test_restore_recovers_archived_configuration_firmware_and_identity(self):
        original_uuid = self.vm["uuid"]
        Path(self.vm["nvram"]).write_bytes(b"snapshot firmware")
        self.fake.domains["work-a"]["xml"] = self.fake.domains["work-a"]["xml"].replace(
            "<memory unit=\"KiB\">2097152</memory>", "<memory unit=\"KiB\">3145728</memory>"
        )
        self.service.snapshot_create("work-a", "configured")
        current_nvram = Path(self.service.vm_inspect("work-a")["nvram"])
        current_nvram.write_bytes(b"later firmware")
        self.fake.domains["work-a"]["xml"] = self.fake.domains["work-a"]["xml"].replace("3145728", "4194304")

        restored = self.service.snapshot_restore("work-a", "configured")
        root = ET.fromstring(self.fake.domains["work-a"]["xml"])
        self.assertEqual(original_uuid, root.findtext("uuid"))
        self.assertEqual("3145728", root.findtext("memory"))
        self.assertEqual(b"snapshot firmware", Path(restored["nvram"]).read_bytes())
        self.assertEqual(restored["nvram"], root.find("./os/nvram/source").get("file"))
        self.assertEqual("shut off", restored["state"])

    def test_identity_and_backing_chain_drift_are_rejected_before_journal(self):
        snapshot = self.service.snapshot_create("work-a", "point")
        current = self.service.vm_inspect("work-a")
        self.fake.domains["work-a"]["xml"] = self.fake.domains["work-a"]["xml"].replace(
            current["uuid"], "99999999-9999-9999-9999-999999999999"
        )
        self.assert_error("ownership_drift", self.service.snapshot_restore, "work-a", "point")
        self.fake.domains["work-a"]["xml"] = self.fake.domains["work-a"]["xml"].replace(
            "99999999-9999-9999-9999-999999999999", current["uuid"]
        )
        self.fake.backings[current["disk"]] = str(self.source_disk)  # bypass the registered snapshot parent
        self.assert_error("ownership_drift", self.service.snapshot_restore, "work-a", "point")
        self.assertTrue(Path(snapshot["disk"]).exists())
        self.assertFalse(self.service.store.journal_path.exists())

    def test_define_failure_reports_recoverable_pre_operation_state(self):
        original = self.service.vm_inspect("work-a")
        self.fake.fail[("virsh", "--connect", "qemu:///session", "define")] = "define failed"
        error = self.assert_error("recovery_required", self.service.snapshot_create, "work-a", "point")

        self.assertEqual(original["disk"], error.details["pre_operation"]["disk"])
        self.assertEqual(original["uuid"], error.details["pre_operation"]["uuid"])
        self.assertEqual("define", error.details["failed_stage"])
        self.assertEqual(original["disk"], DomainDisk.from_xml(self.fake.domains["work-a"]["xml"]))
        self.assertTrue(Path(error.details["journal"]).is_file())

    def test_atomic_registry_failure_after_define_retains_both_states(self):
        original = self.service.vm_inspect("work-a")
        save = self.service.store.save

        def fail_save(_data):
            raise OSError("injected metadata failure")

        self.service.store.save = fail_save
        error = self.assert_error("recovery_required", self.service.snapshot_create, "work-a", "point")
        self.service.store.save = save
        actual_disk = DomainDisk.from_xml(self.fake.domains["work-a"]["xml"])
        self.assertNotEqual(original["disk"], actual_disk)
        self.assertTrue(Path(original["disk"]).is_file())
        self.assertTrue(Path(actual_disk).is_file())
        self.assertEqual("registry", error.details["failed_stage"])

    def test_restore_define_failure_archives_exact_previous_recovery_state(self):
        self.service.snapshot_create("work-a", "point")
        before = self.service.vm_inspect("work-a")
        prior_xml = self.fake.domains["work-a"]["xml"].replace("2097152", "3670016")
        self.fake.domains["work-a"]["xml"] = prior_xml
        Path(before["nvram"]).write_bytes(b"pre-restore firmware")
        self.fake.fail[("virsh", "--connect", "qemu:///session", "define")] = "define failed"

        error = self.assert_error("recovery_required", self.service.snapshot_restore, "work-a", "point")
        recovery_xml = Path(error.details["pre_operation"]["xml_archive"])
        self.assertEqual(prior_xml, recovery_xml.read_text(encoding="utf-8"))
        self.assertEqual(before["disk"], DomainDisk.from_xml(self.fake.domains["work-a"]["xml"]))
        self.assertTrue(Path(before["disk"]).is_file())
        self.assertEqual(b"pre-restore firmware", Path(before["nvram"]).read_bytes())
        self.assertIn(str(recovery_xml), error.details["resources"])

    def test_restore_registry_failure_keeps_exact_previous_and_new_recovery_assets(self):
        self.service.snapshot_create("work-a", "point")
        before = self.service.vm_inspect("work-a")
        prior_xml = self.fake.domains["work-a"]["xml"].replace("2097152", "4718592")
        self.fake.domains["work-a"]["xml"] = prior_xml
        Path(before["nvram"]).write_bytes(b"prior firmware")
        original_save = self.service.store.save
        self.service.store.save = lambda _data: (_ for _ in ()).throw(OSError("registry failed"))
        error = self.assert_error("recovery_required", self.service.snapshot_restore, "work-a", "point")
        self.service.store.save = original_save

        recovery_xml = Path(error.details["pre_operation"]["xml_archive"])
        actual_disk = DomainDisk.from_xml(self.fake.domains["work-a"]["xml"])
        self.assertEqual("registry", error.details["failed_stage"])
        self.assertEqual(prior_xml, recovery_xml.read_text(encoding="utf-8"))
        self.assertTrue(Path(before["disk"]).is_file())
        self.assertEqual(0, Path(before["disk"]).stat().st_mode & 0o222)
        self.assertEqual(b"prior firmware", Path(before["nvram"]).read_bytes())
        self.assertTrue(Path(actual_disk).is_file())
        self.assertNotEqual(before["disk"], actual_disk)

    def test_writable_named_or_retained_layer_is_ownership_drift(self):
        saved = self.service.snapshot_create("work-a", "point")
        Path(saved["disk"]).chmod(0o600)
        self.assert_error("ownership_drift", self.service.snapshot_restore, "work-a", "point")
        Path(saved["disk"]).chmod(0o444)
        self.service.snapshot_restore("work-a", "point")
        retained = Path(self.service.store.load()["vms"]["work-a"]["retained_layers"][0]["disk"])
        retained.chmod(0o600)
        self.assert_error("ownership_drift", self.service.snapshot_restore, "work-a", "point")

    def test_snapshot_archive_presence_path_ownership_and_modes_are_validated(self):
        mutations = {
            "missing-xml": lambda item: Path(item["xml"]).unlink(),
            "missing-nvram": lambda item: Path(item["nvram"]).unlink(),
            "missing-nvram-metadata": lambda item: item.update(nvram=None),
            "extra-nvram-metadata": self._remove_archived_xml_nvram,
            "foreign-nvram": lambda item: self._rewrite_archived_nvram(item, self.source_nvram),
            "foreign-nvram-metadata": lambda item: item.update(nvram=str(self.source_nvram)),
            "writable-xml": lambda item: Path(item["xml"]).chmod(0o600),
            "writable-nvram": lambda item: Path(item["nvram"]).chmod(0o600),
        }
        for index, (case, mutate) in enumerate(mutations.items()):
            with self.subTest(case=case):
                name = f"archive-{index}"
                self.service.vm_create(name, "ubuntu", "v1")
                self.service.snapshot_create(name, "point")
                data = self.service.store.load()
                item = data["vms"][name]["snapshots"]["point"]
                mutate(item)
                self.service.store.save(data)
                self.assert_error("ownership_drift", self.service.snapshot_restore, name, "point")
                self.assertFalse(self.service.store.journal_path.exists())

    def test_archive_write_failure_is_recoverable_and_keeps_original_domain(self):
        original = self.service.vm_inspect("work-a")
        with patch("libvirt_mcp.snapshots.Path.write_text", side_effect=OSError("injected XML write failure")):
            error = self.assert_error("recovery_required", self.service.snapshot_create, "work-a", "point")
        self.assertEqual("creating", error.details["failed_stage"])
        self.assertEqual(original["disk"], DomainDisk.from_xml(self.fake.domains["work-a"]["xml"]))
        self.assertTrue(Path(error.details["journal"]).exists())

    def test_existing_interrupted_operation_blocks_mutation_but_not_listing(self):
        self.service.snapshot_create("work-a", "point")
        self.service.store.begin("interrupted", ["domain:work-a"])
        self.assertEqual(["point"], self.snapshot_names())
        self.assert_error("recovery_required", self.service.snapshot_restore, "work-a", "point")

    def test_vm_delete_removes_every_owned_layer_and_snapshot_archive(self):
        first = self.service.snapshot_create("work-a", "first")
        self.service.snapshot_create("work-a", "second")
        self.service.snapshot_restore("work-a", "first")
        vm_dir = Path(first["disk"]).parent
        self.service.vm_delete("work-a")
        self.assertFalse(vm_dir.exists())

    @staticmethod
    def _remove_archived_xml_nvram(item):
        path = Path(item["xml"])
        root = ET.fromstring(path.read_text(encoding="utf-8"))
        root.find("os").remove(root.find("./os/nvram"))
        path.chmod(0o600)
        path.write_text(ET.tostring(root, encoding="unicode"), encoding="utf-8")
        path.chmod(0o444)

    @staticmethod
    def _rewrite_archived_nvram(item, path):
        xml_path = Path(item["xml"])
        root = ET.fromstring(xml_path.read_text(encoding="utf-8"))
        nvram = root.find("./os/nvram")
        source = nvram.find("source")
        if source is None:
            nvram.text = str(path)
        else:
            source.set("file", str(path))
        xml_path.chmod(0o600)
        xml_path.write_text(ET.tostring(root, encoding="unicode"), encoding="utf-8")
        xml_path.chmod(0o444)


class DomainDisk:
    @staticmethod
    def from_xml(xml: str) -> str:
        root = ET.fromstring(xml)
        return root.find("./devices/disk/source").get("file")


@unittest.skipUnless(shutil.which("qemu-img"), "qemu-img is not available")
class RealQemuSnapshotTests(unittest.TestCase):
    def test_create_and_restore_make_real_temporary_backing_chains(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.qcow2"
            subprocess.run(["qemu-img", "create", "-f", "qcow2", str(source), "1M"], check=True, capture_output=True)
            nvram = root / "NVRAM.fd"
            nvram.write_bytes(b"firmware")
            fake = FakeRunner(FIXTURE.read_text(encoding="utf-8"), source, nvram)
            commands = CommandRunner()

            class HybridRunner:
                def run(self, argv, timeout_seconds=30):
                    if argv[0] == "qemu-img":
                        return commands.run(argv, timeout_seconds=timeout_seconds)
                    return fake.run(argv, timeout_seconds=timeout_seconds)

            service = Lifecycle(root / "managed", runner=HybridRunner())
            service.template_publish("source-vm", "ubuntu", "v1")
            service.vm_create("work-a", "ubuntu", "v1")
            saved = service.snapshot_create("work-a", "point")
            active = service.vm_inspect("work-a")["disk"]
            chain = json.loads(commands.run(["qemu-img", "info", "--output=json", "--backing-chain", active]).stdout)
            self.assertEqual(str(Path(saved["disk"]).resolve()), chain[0]["full-backing-filename"])
            service.snapshot_restore("work-a", "point")
            restored = service.vm_inspect("work-a")["disk"]
            restored_chain = json.loads(commands.run(["qemu-img", "info", "--output=json", "--backing-chain", restored]).stdout)
            self.assertEqual(str(Path(saved["disk"]).resolve()), restored_chain[0]["full-backing-filename"])


if __name__ == "__main__":
    unittest.main()
