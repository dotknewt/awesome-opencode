from __future__ import annotations

import json
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from libvirt_mcp.errors import LifecycleError
from libvirt_mcp.lifecycle import Lifecycle

from fakes import FakeGuestAccess, FakeRunner


PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f project-vm"
FINGERPRINT = "SHA256:ZkAslGjFiUHdGf/WUL8rQvkib4PTvQatUV0OUQSncCA"


FIXTURE = Path(__file__).parent / "fixtures" / "source.xml"
REAL_DOMAIN_FIXTURE = Path(__file__).parent / "fixtures" / "ubuntu-dev-template.xml"
CAPABILITIES = Path(__file__).parent / "fixtures" / "capabilities.xml"
SOURCE_UUID = "11111111-1111-1111-1111-111111111111"


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "managed"
        self.source_disk = Path(self.temp.name) / "source.qcow2"
        self.source_nvram = Path(self.temp.name) / "source_NVRAM.fd"
        self.source_disk.write_bytes(b"source image")
        self.source_nvram.write_bytes(b"firmware state")
        self.fake = FakeRunner(FIXTURE.read_text(encoding="utf-8"), self.source_disk, self.source_nvram)
        self.service = Lifecycle(self.root, runner=self.fake)

    def tearDown(self):
        self.temp.cleanup()

    def publish(self):
        return self.service.template_publish("source-vm", "ubuntu-dev-template", "v1")

    def create(self, name="work-a", **kwargs):
        self.publish()
        return self.service.vm_create(name, "ubuntu-dev-template", "v1", **kwargs)

    def assert_error(self, code, function, *args, **kwargs):
        with self.assertRaises(LifecycleError) as caught:
            function(*args, **kwargs)
        self.assertEqual(code, caught.exception.code)
        return caught.exception

    def test_host_info_and_lists_are_json_serializable(self):
        self.fake.capabilities_xml = CAPABILITIES.read_text(encoding="utf-8")
        result = self.service.host_info()
        self.assertEqual("qemu:///session", result["uri"])
        self.assertEqual("x86_64", result["host"]["architecture"])
        self.assertEqual("Skylake-Client-IBRS", result["host"]["cpu"]["model"])
        self.assertEqual({"sockets": 1, "dies": 1, "cores": 4, "threads": 2}, result["host"]["cpu"]["topology"])
        self.assertEqual(["ssse3", "vmx"], result["host"]["cpu"]["features"])
        self.assertEqual(["suspend_disk", "suspend_mem"], result["host"]["power_management"])
        self.assertTrue(result["host"]["iommu"])
        json.dumps(result)
        self.assertEqual([], self.service.template_list()["templates"])
        names = {item["name"] for item in self.service.vm_list()["vms"]}
        self.assertEqual({"source-vm"}, names)

    def test_publication_flattens_to_new_owned_immutable_version(self):
        template = self.publish()
        disk = Path(template["disk"])
        self.assertTrue(disk.is_file())
        self.assertNotEqual(self.source_disk, disk)
        self.assertIsNone(self.fake.backing_for(disk))
        self.assertEqual(0o444, disk.stat().st_mode & 0o777)
        self.assertTrue(Path(template["nvram"]).is_file())
        metadata = self.service.template_list()["templates"][0]
        self.assertEqual(SOURCE_UUID, metadata["source_uuid"])
        published_xml = ET.fromstring(Path(template["xml"]).read_text(encoding="utf-8"))
        self.assertEqual(template["nvram"], published_xml.find("./os/nvram/source").get("file"))

    def test_publication_rejects_running_or_managed_saved_source(self):
        self.fake.domains["source-vm"]["state"] = "running"
        self.assert_error("invalid_state", self.publish)
        self.fake.domains["source-vm"]["state"] = "shut off"
        self.fake.domains["source-vm"]["managed_save"] = True
        self.assert_error("managed_save_present", self.publish)

    def test_managed_save_probe_distinguishes_absence_from_inspection_failure(self):
        self.create()
        self.fake.fail[("virsh", "--connect", "qemu:///session", "managedsave-dumpxml")] = "permission denied"
        error = self.assert_error("inspection_incomplete", self.service.vm_start, "work-a")
        self.assertIn("permission denied", error.details["stderr"])
        self.assertFalse(self.service.store.journal_path.exists())

    def test_managed_save_probe_accepts_current_libvirt_absence_wording(self):
        self.fake.fail[("virsh", "--connect", "qemu:///session", "managedsave-dumpxml")] = (
            "error: Requested operation is not valid: domain does not have managed save image"
        )
        published = self.publish()
        self.assertEqual("ubuntu-dev-template", published["name"])

    def test_publication_rejects_unsafe_source_disk_and_duplicate_version(self):
        self.fake.domains["source-vm"]["xml"] = self.fake.domains["source-vm"]["xml"].replace(
            str(self.source_disk), str(Path(self.temp.name) / "missing.qcow2")
        )
        self.assert_error("unsafe_source", self.publish)
        self.fake = FakeRunner(FIXTURE.read_text(encoding="utf-8"), self.source_disk, self.source_nvram)
        self.service = Lifecycle(self.root, runner=self.fake)
        self.publish()
        self.assert_error("already_exists", self.publish)

    def test_publication_rejects_foreign_nested_nvram_before_side_effects(self):
        missing = Path(self.temp.name) / "foreign-missing.fd"
        self.fake.domains["source-vm"]["xml"] = self.fake.domains["source-vm"]["xml"].replace(
            str(self.source_nvram), str(missing)
        )
        self.fake.calls.clear()
        self.assert_error("unsafe_source", self.publish)
        self.assertFalse((self.root / "templates" / "ubuntu-dev-template" / "v1").exists())
        self.assertFalse(self.service.store.journal_path.exists())
        self.assertFalse(any(call[:2] == ["qemu-img", "convert"] for call in self.fake.calls))

    def test_unsupported_source_configuration_is_rejected_before_publication_side_effects(self):
        additions = {
            "host serial": '<serial type="dev"><source path="/dev/ttyS0"/></serial>',
            "memory device": '<memory model="dimm"><target><size unit="MiB">512</size></target></memory>',
        }
        original = self.fake.domains["source-vm"]["xml"]
        for label, device in additions.items():
            with self.subTest(label=label):
                self.fake.domains["source-vm"]["xml"] = original.replace("</devices>", device + "</devices>")
                self.fake.calls.clear()
                self.assert_error("unsupported_domain", self.publish)
                self.assertFalse((self.root / "templates" / "ubuntu-dev-template" / "v1").exists())
                self.assertFalse(self.service.store.journal_path.exists())
                self.assertFalse(any(call[:2] == ["qemu-img", "convert"] for call in self.fake.calls))
        self.fake.domains["source-vm"]["xml"] = original

    def test_nested_host_resources_under_every_allowed_device_fail_before_publication_side_effects(self):
        original = self.fake.domains["source-vm"]["xml"]
        modern_nvram = (
            '<nvram type="file" template="/usr/share/OVMF/OVMF_VARS.fd">'
            f'<source file="{self.source_nvram}"/></nvram>'
        )
        cases = {
            "disk backing source": original.replace(
                '<target dev="vda" bus="virtio"/>',
                '<backingStore type="file"><source file="/host/base.qcow2"/></backingStore><target dev="vda" bus="virtio"/>',
                1,
            ),
            "interface script": original.replace(
                '<model type="virtio"/>', '<model type="virtio"/><script path="/host/if-up"/>', 1
            ),
            "controller source": original.replace(
                '<controller type="pci" index="0" model="pcie-root"/>',
                '<controller type="pci" index="0" model="pcie-root"><source file="/host/controller"/></controller>',
            ),
            "serial log": original.replace(
                '<serial type="pty"><source path="/dev/pts/7"/><target type="isa-serial" port="0"/></serial>',
                '<serial type="pty"><source path="/dev/pts/7"/><target type="isa-serial" port="0"/><log file="/host/serial.log"/></serial>',
            ),
            "console log": original.replace(
                '<console type="pty"><source path="/dev/pts/7"/><target type="serial" port="0"/></console>',
                '<console type="pty"><source path="/dev/pts/7"/><target type="serial" port="0"/><log file="/host/console.log"/></console>',
            ),
            "channel log": original.replace(
                '</channel>', '<log file="/host/channel.log"/></channel>', 1
            ),
            "input source": original.replace(
                '<input type="tablet" bus="usb"/>',
                '<input type="tablet" bus="usb"><source path="/host/input"/></input>',
            ),
            "graphics egl rendernode": original.replace(
                '<graphics type="spice" autoport="yes"><listen type="socket" socket="/run/libvirt/source-spice.sock"/></graphics>',
                '<graphics type="egl-headless"><gl rendernode="/dev/dri/renderD128"/></graphics>',
            ),
            "graphics gl rendernode": original.replace(
                '</graphics>', '<gl enable="yes" rendernode="/dev/dri/renderD128"/></graphics>', 1
            ),
            "video acceleration rendernode": original.replace(
                '<model type="virtio" heads="1" primary="yes"/>',
                '<model type="virtio" heads="1" primary="yes"><acceleration accel3d="yes" rendernode="/dev/dri/renderD128"/></model>',
                1,
            ),
            "memballoon source": original.replace(
                '<memballoon model="virtio"/>',
                '<memballoon model="virtio"><source file="/host/balloon"/></memballoon>',
            ),
            "rng nested source": original.replace(
                '</backend></rng>', '<source file="/host/rng"/></backend></rng>', 1
            ),
            "panic source": original.replace(
                '<panic model="isa"/>', '<panic model="isa"><source file="/host/panic"/></panic>'
            ),
            "emulator nested source": original.replace(
                '<emulator>/usr/bin/qemu-system-x86_64</emulator>',
                '<emulator>/usr/bin/qemu-system-x86_64<source file="/host/emulator"/></emulator>',
            ),
            "text nvram with file type": original.replace(
                modern_nvram,
                f'<nvram type="file" template="/usr/share/OVMF/OVMF_VARS.fd">{self.source_nvram}</nvram>',
            ),
        }
        for index, (label, xml) in enumerate(cases.items()):
            with self.subTest(label=label):
                self.fake.domains["source-vm"]["xml"] = xml
                self.fake.calls.clear()
                template_name = f"unsafe-{index}"
                self.assert_error(
                    "unsupported_domain", self.service.template_publish, "source-vm", template_name, "v1"
                )
                self.assertFalse((self.root / "templates" / template_name / "v1").exists())
                self.assertFalse(self.service.store.journal_path.exists())
                self.assertFalse(any(call[:2] == ["qemu-img", "convert"] for call in self.fake.calls))
        self.fake.domains["source-vm"]["xml"] = original

    def test_publication_accepts_complete_compatible_virtual_device_fixture(self):
        template = self.publish()
        published = Path(template["xml"]).read_text(encoding="utf-8")
        self.assertIn("/usr/bin/qemu-system-x86_64", published)
        self.assertIn("/usr/share/OVMF/OVMF_CODE.fd", published)
        self.assertIn("/dev/urandom", published)
        self.assertNotIn("/dev/pts/7", published)
        self.assertNotIn("/run/libvirt/source.sock", published)
        self.assertNotIn("/run/libvirt/source-spice.sock", published)
        self.assertFalse(self.service.store.journal_path.exists())

    def test_observed_ubuntu_domain_publishes_and_creates_a_working_clone(self):
        fake = FakeRunner(REAL_DOMAIN_FIXTURE.read_text(encoding="utf-8"), self.source_disk, self.source_nvram)
        service = Lifecycle(Path(self.temp.name) / "observed-managed", runner=fake)

        template = service.template_publish("source-vm", "ubuntu-dev-template", "v1")
        vm = service.vm_create("work-observed", "ubuntu-dev-template", "v1")

        clone = ET.fromstring(fake.domains["work-observed"]["xml"])
        self.assertEqual(template["disk"], fake.backing_for(vm["disk"]))
        self.assertEqual(vm["uuid"], clone.findtext("uuid"))
        self.assertEqual(vm["disk"], clone.find("./devices/disk/source").get("file"))
        self.assertNotEqual("52:54:00:aa:bb:cc", clone.find("./devices/interface/mac").get("address"))
        self.assertIsNotNone(clone.find("./devices/audio[@type='spice']"))
        self.assertIsNotNone(clone.find("./devices/sound[@model='ich9']"))
        self.assertEqual(2, len(clone.findall("./devices/redirdev[@type='spicevmc']")))
        self.assertIsNotNone(clone.find("./devices/watchdog[@model='itco']"))

    def test_create_uses_linked_clone_fresh_identity_and_independent_nvram(self):
        template = self.publish()
        vm = self.service.vm_create("work-a", "ubuntu-dev-template", "v1")
        self.assertNotEqual(SOURCE_UUID, vm["uuid"])
        self.assertEqual(template["disk"], self.fake.backing_for(vm["disk"]))
        self.assertNotEqual(template["nvram"], vm["nvram"])
        self.assertEqual(b"firmware state", Path(vm["nvram"]).read_bytes())
        xml = self.fake.domains["work-a"]["xml"]
        self.assertNotIn(SOURCE_UUID, xml)
        self.assertNotIn(str(self.source_disk), xml)
        self.assertNotIn("aa:bb:cc", xml)
        root = ET.fromstring(xml)
        self.assertEqual(vm["nvram"], root.find("./os/nvram/source").get("file"))

    def test_create_provisions_overlay_before_define_and_preserves_backing(self):
        guest_access = FakeGuestAccess()
        self.service.guest_access = guest_access
        template = self.publish()
        backing_before = Path(template["disk"]).read_bytes()

        vm = self.service.vm_create(
            "work-a", "ubuntu-dev-template", "v1", guest_user="developer", ssh_public_key=PUBLIC_KEY
        )

        create_index = next(i for i, call in enumerate(self.fake.calls) if call[:2] == ["qemu-img", "create"])
        define_index = next(i for i, call in enumerate(self.fake.calls) if call[3] == "define")
        self.assertLess(create_index, define_index)
        self.assertEqual([Path(vm["disk"])], [call[0] for call in guest_access.provision_calls])
        self.assertEqual(backing_before, Path(template["disk"]).read_bytes())
        self.assertEqual(
            {"user": "developer", "fingerprint": FINGERPRINT, "status": "provisioned"}, vm["guest_access"]
        )

    def test_create_credential_pair_is_optional_but_incomplete_pair_fails_before_mutation(self):
        self.publish()
        self.assertEqual("shut off", self.service.vm_create("legacy", "ubuntu-dev-template", "v1")["state"])
        for kwargs in ({"guest_user": "developer"}, {"ssh_public_key": PUBLIC_KEY}):
            with self.subTest(kwargs=kwargs):
                self.fake.calls.clear()
                self.assert_error(
                    "invalid_guest_access", self.service.vm_create, "incomplete", "ubuntu-dev-template", "v1", **kwargs
                )
                self.assertFalse((self.root / "vms" / "incomplete").exists())
                self.assertFalse(self.service.store.journal_path.exists())
                self.assertFalse(any(call[:2] == ["qemu-img", "create"] for call in self.fake.calls))

    def test_guest_provision_failure_records_stage_and_fingerprint_for_recovery(self):
        guest_access = FakeGuestAccess()
        guest_access.fail_provision = True
        self.service.guest_access = guest_access
        self.publish()

        error = self.assert_error(
            "recovery_required",
            self.service.vm_create,
            "work-a",
            "ubuntu-dev-template",
            "v1",
            guest_user="developer",
            ssh_public_key=PUBLIC_KEY,
        )

        self.assertEqual("provisioning_guest", error.details["failed_stage"])
        self.assertEqual(
            {"user": "developer", "fingerprint": FINGERPRINT, "status": "pending"},
            error.details["guest_access"],
        )
        self.assertNotIn("ssh_public_key", json.dumps(error.details))
        self.assertNotIn("work-a", self.fake.domains)

    def test_overlay_create_failure_and_timeout_retain_pending_guest_metadata(self):
        self.service.guest_access = FakeGuestAccess()
        self.publish()
        original_run = self.fake.run

        for label, failure in (
            ("failure", None),
            (
                "timeout",
                LifecycleError(
                    "command_timeout",
                    "timed out",
                    {"side_effect_unknown": True},
                ),
            ),
        ):
            with self.subTest(label=label):
                if label == "failure":
                    self.fake.fail[("qemu-img", "create")] = "injected create failure"
                else:
                    self.fake.fail.clear()

                    def run(argv, timeout_seconds=30):
                        if list(argv[:2]) == ["qemu-img", "create"]:
                            raise failure
                        return original_run(argv, timeout_seconds)

                    self.fake.run = run
                error = self.assert_error(
                    "recovery_required",
                    self.service.vm_create,
                    f"work-{label}",
                    "ubuntu-dev-template",
                    "v1",
                    guest_user="developer",
                    ssh_public_key=PUBLIC_KEY,
                )
                self.assertEqual(
                    {"user": "developer", "fingerprint": FINGERPRINT, "status": "pending"},
                    error.details["guest_access"],
                )
                self.assertEqual("creating_overlay", error.details["failed_stage"])
                self.service.store.journal_path.unlink()
                self.fake.run = original_run
                self.fake.fail.clear()

    def test_guest_access_metadata_survives_snapshot_create_and_restore(self):
        self.service.guest_access = FakeGuestAccess()
        self.publish()
        created = self.service.vm_create(
            "work-a", "ubuntu-dev-template", "v1", guest_user="developer", ssh_public_key=PUBLIC_KEY
        )
        expected = created["guest_access"]
        self.service.snapshot_create("work-a", "clean")
        restored = self.service.snapshot_restore("work-a", "clean")
        self.assertEqual(expected, restored["guest_access"])
        self.assertEqual(expected, self.service.vm_inspect("work-a")["guest_access"])

    def test_create_applies_consistent_cpu_memory_overrides_and_duplicate_guard(self):
        vm = self.create(vcpus=4, memory_mib=8192)
        root = ET.fromstring(self.fake.domains[vm["name"]]["xml"])
        self.assertEqual("4", root.findtext("vcpu"))
        self.assertEqual("4", root.find("vcpu").get("current"))
        self.assertEqual("8388608", root.findtext("memory"))
        self.assertEqual("8388608", root.findtext("currentMemory"))
        self.assert_error("already_exists", self.service.vm_create, "work-a", "ubuntu-dev-template", "v1")

    def test_invalid_create_overrides_have_no_side_effects_or_journal(self):
        self.publish()
        for value, keyword in ((0, "vcpus"), (-1, "memory_mib"), (True, "vcpus")):
            with self.subTest(value=value, keyword=keyword):
                self.assert_error(
                    "invalid_argument",
                    self.service.vm_create,
                    "work-a",
                    "ubuntu-dev-template",
                    "v1",
                    **{keyword: value},
                )
                self.assertFalse((self.root / "vms" / "work-a").exists())
                self.assertFalse(self.service.store.journal_path.exists())
                self.assertFalse(any(call[:2] == ["qemu-img", "create"] for call in self.fake.calls))
        self.assertEqual("shut off", self.service.vm_create("work-a", "ubuntu-dev-template", "v1")["state"])

    def test_dependent_sizing_configuration_blocks_overrides_before_journal_or_resources(self):
        source = self.fake.domains["source-vm"]["xml"]
        cases = {
            "cpu": (source.replace("</vcpu>", "</vcpu><cpu><topology sockets=\"1\" dies=\"1\" cores=\"2\" threads=\"1\"/></cpu>"), {"vcpus": 4}),
            "memory": (source.replace("<memory unit=\"KiB\">", '<maxMemory slots="16" unit="KiB">4194304</maxMemory><memory unit="KiB">'), {"memory_mib": 4096}),
        }
        for index, (label, (xml, override)) in enumerate(cases.items()):
            with self.subTest(label=label):
                fake = FakeRunner(xml, self.source_disk, self.source_nvram)
                service = Lifecycle(Path(self.temp.name) / f"managed-{index}", runner=fake)
                service.template_publish("source-vm", "ubuntu", "v1")
                fake.calls.clear()
                self.assert_error("unsupported_override", service.vm_create, "work-a", "ubuntu", "v1", **override)
                self.assertFalse((service.store.root / "vms" / "work-a").exists())
                self.assertFalse(service.store.journal_path.exists())
                self.assertFalse(any(call[:2] == ["qemu-img", "create"] for call in fake.calls))
                created = service.vm_create("work-a", "ubuntu", "v1")
                created_xml = fake.domains[created["name"]]["xml"]
                if label == "cpu":
                    self.assertIn("<topology", created_xml)
                else:
                    self.assertIn("<maxMemory", created_xml)

    def test_create_rejects_tampered_template_ownership_metadata(self):
        self.publish()
        registry = self.service.store.load()
        registry["templates"]["ubuntu-dev-template"]["versions"]["v1"]["disk"] = str(self.source_disk)
        self.service.store.save(registry)
        self.assert_error(
            "ownership_drift", self.service.vm_create, "work-a", "ubuntu-dev-template", "v1"
        )

    def test_start_shutdown_timeout_and_force_stop_have_distinct_semantics(self):
        self.create()
        self.assertEqual("running", self.service.vm_start("work-a")["state"])
        self.assertEqual("running", self.service.vm_start("work-a")["state"])
        self.fake.shutdown_completes = False
        error = self.assert_error("shutdown_timeout", self.service.vm_shutdown, "work-a", timeout_seconds=0)
        self.assertEqual("running", self.fake.domains["work-a"]["state"])
        self.assertNotIn("destroy", [call[3] for call in self.fake.calls if call[0] == "virsh"])
        self.assertEqual(0, error.details["timeout_seconds"])
        self.assertEqual("shut off", self.service.vm_force_stop("work-a")["state"])

    def test_running_vm_image_lock_does_not_block_idempotent_start_shutdown_or_force_stop(self):
        self.create()
        self.service.snapshot_create("work-a", "point")
        self.service.vm_start("work-a")
        self.fake.reject_live_image_info = True

        self.fake.calls.clear()
        self.assertEqual("running", self.service.vm_start("work-a")["state"])
        self.assertFalse(any(call[:2] == ["qemu-img", "info"] for call in self.fake.calls))
        self.assertFalse(any("-U" in call for call in self.fake.calls))

        self.fake.calls.clear()
        self.assertEqual("shut off", self.service.vm_shutdown("work-a")["state"])
        self.assertFalse(any(call[:2] == ["qemu-img", "info"] for call in self.fake.calls))

        self.fake.reject_live_image_info = False
        self.service.vm_start("work-a")
        self.fake.reject_live_image_info = True
        self.fake.calls.clear()
        self.assertEqual("shut off", self.service.vm_force_stop("work-a")["state"])
        self.assertFalse(any(call[:2] == ["qemu-img", "info"] for call in self.fake.calls))

    def test_shutdown_timeout_must_be_finite(self):
        self.create()
        self.service.vm_start("work-a")
        for timeout in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(timeout=timeout):
                self.assert_error("invalid_argument", self.service.vm_shutdown, "work-a", timeout_seconds=timeout)
        self.assertEqual("running", self.fake.domains["work-a"]["state"])

    def test_delete_rejects_foreign_domain_and_drift(self):
        vm = self.create()
        self.assert_error("not_managed", self.service.vm_delete, "source-vm")
        xml = self.fake.domains["work-a"]["xml"].replace(vm["uuid"], "99999999-9999-9999-9999-999999999999")
        self.fake.domains["work-a"]["xml"] = xml
        self.assert_error("ownership_drift", self.service.vm_delete, "work-a")
        self.assertTrue(Path(vm["disk"]).exists())

    def test_managed_save_and_symlinked_owned_disk_block_mutation(self):
        vm = self.create()
        self.fake.domains["work-a"]["managed_save"] = True
        self.assert_error("managed_save_present", self.service.vm_delete, "work-a")
        self.fake.domains["work-a"]["managed_save"] = False
        disk = Path(vm["disk"])
        outside = Path(self.temp.name) / "outside.qcow2"
        outside.write_bytes(b"foreign")
        disk.unlink()
        disk.symlink_to(outside)
        self.assert_error("ownership_drift", self.service.vm_start, "work-a")

    def test_delete_removes_only_managed_domain_and_directory(self):
        vm = self.create()
        outside = Path(self.temp.name) / "keep-me"
        outside.write_text("safe", encoding="utf-8")
        removed = self.service.vm_delete("work-a")
        self.assertTrue(removed["removed"])
        self.assertNotIn("work-a", self.fake.domains)
        self.assertFalse(Path(vm["disk"]).parent.exists())
        self.assertEqual("safe", outside.read_text(encoding="utf-8"))

    def test_delete_filesystem_failure_after_undefine_retains_recovery_journal(self):
        vm = self.create()
        with patch("libvirt_mcp.lifecycle.shutil.rmtree", side_effect=OSError("injected remove failure")):
            error = self.assert_error("recovery_required", self.service.vm_delete, "work-a")
        self.assertNotIn("work-a", self.fake.domains)
        self.assertTrue(Path(vm["disk"]).exists())
        self.assertTrue(Path(error.details["journal"]).exists())

    def test_template_registry_failure_after_removal_retains_recovery_journal(self):
        template = self.publish()

        def fail_save(_data):
            raise OSError("injected registry failure")

        self.service.store.save = fail_save
        error = self.assert_error("recovery_required", self.service.template_remove, "ubuntu-dev-template", "v1")
        self.assertFalse(Path(template["disk"]).parent.exists())
        self.assertTrue(Path(error.details["journal"]).exists())
        self.assertEqual("OSError", error.details["cause"]["type"])

    def test_journal_update_failure_still_returns_structured_recovery_error(self):
        self.create()
        with patch("libvirt_mcp.lifecycle.shutil.rmtree", side_effect=OSError("remove failed")):
            self.service.store.update_journal = lambda *_args, **_kwargs: (_ for _ in ()).throw(
                OSError("journal update failed")
            )
            error = self.assert_error("recovery_required", self.service.vm_delete, "work-a")
        self.assertEqual("OSError", error.details["journal_error"]["type"])
        self.assertTrue(self.service.store.journal_path.exists())

    def test_partial_publication_failure_keeps_journal_and_never_deletes_source(self):
        self.fake.fail[("qemu-img", "convert")] = "conversion failed"
        error = self.assert_error("recovery_required", self.publish)
        self.assertTrue(self.source_disk.exists())
        self.assertIn(str(self.root / "templates" / "ubuntu-dev-template" / "v1" / "disk.qcow2"), error.details["resources"])

    def test_template_remove_checks_metadata_and_real_backing_dependencies(self):
        template = self.publish()
        vm = self.service.vm_create("work-a", "ubuntu-dev-template", "v1")
        self.assert_error("template_in_use", self.service.template_remove, "ubuntu-dev-template", "v1")
        self.service.vm_delete("work-a")
        foreign_disk = Path(self.temp.name) / "foreign.qcow2"
        foreign_disk.write_bytes(b"foreign")
        self.fake.backings[str(foreign_disk)] = template["disk"]
        foreign_xml = self.fake.domains["source-vm"]["xml"].replace(str(self.source_disk), str(foreign_disk))
        self.fake.domains["foreign"] = {"xml": foreign_xml.replace("source-vm", "foreign"), "state": "shut off", "managed_save": False}
        self.assert_error("template_in_use", self.service.template_remove, "ubuntu-dev-template", "v1")
        del self.fake.domains["foreign"]
        self.fake.fail[("qemu-img", "info")] = "cannot inspect"
        self.assert_error("inspection_incomplete", self.service.template_remove, "ubuntu-dev-template", "v1")

    def test_partial_create_failure_retains_resources_and_blocks_mutations(self):
        self.publish()
        self.fake.fail[("virsh", "--connect", "qemu:///session", "define")] = "define failed"
        error = self.assert_error("recovery_required", self.service.vm_create, "work-a", "ubuntu-dev-template", "v1")
        self.assertTrue(Path(error.details["journal"]).is_file())
        self.assertTrue(any(Path(path).exists() for path in error.details["resources"]))
        blocked = self.assert_error("recovery_required", self.service.template_remove, "ubuntu-dev-template", "v1")
        self.assertEqual(error.details["operation_id"], blocked.details["operation_id"])

    def test_create_successful_define_without_readable_domain_requires_recovery(self):
        self.publish()
        self.fake.define_visibility = "missing"

        error = self.assert_error(
            "recovery_required", self.service.vm_create, "work-a", "ubuntu-dev-template", "v1"
        )

        self.assertTrue(Path(error.details["journal"]).is_file())
        self.assertNotIn("work-a", self.service.store.load()["vms"])
        self.assertTrue((self.root / "vms" / "work-a" / "disk.qcow2").is_file())
        self.assertEqual("external_command_failed", error.details["cause"]["code"])
        define_index = next(index for index, call in enumerate(self.fake.calls) if call[3] == "define")
        self.assertIn("dumpxml", [call[3] for call in self.fake.calls[define_index + 1 :]])

    def test_create_mismatched_domain_readback_requires_recovery_before_registry_commit(self):
        self.publish()

        def mismatch(xml):
            root = ET.fromstring(xml)
            root.find("name").text = "wrong-name"
            root.find("uuid").text = "99999999-9999-9999-9999-999999999999"
            root.find("./devices/disk/source").set("file", "/wrong/disk.qcow2")
            root.find("./os/nvram/source").set("file", "/wrong/nvram.fd")
            return ET.tostring(root, encoding="unicode")

        self.fake.define_transform = mismatch
        error = self.assert_error(
            "recovery_required", self.service.vm_create, "work-a", "ubuntu-dev-template", "v1"
        )

        self.assertTrue(Path(error.details["journal"]).is_file())
        self.assertNotIn("work-a", self.service.store.load()["vms"])
        self.assertEqual("domain_postcondition_failed", error.details["cause"]["code"])
        self.assertEqual(["disk", "name", "nvram", "uuid"], error.details["cause"]["details"]["fields"])

    def test_metadata_failure_retains_defined_domain_and_reachable_storage(self):
        self.publish()

        def fail_save(_data):
            raise OSError("injected registry failure")

        self.service.store.save = fail_save
        error = self.assert_error(
            "recovery_required", self.service.vm_create, "work-a", "ubuntu-dev-template", "v1"
        )
        self.assertIn("work-a", self.fake.domains)
        disk = self.root / "vms" / "work-a" / "disk.qcow2"
        self.assertTrue(disk.exists())
        self.assertEqual("OSError", error.details["cause"]["type"])

    def test_resources_are_fsynced_before_success_clears_journal(self):
        self.publish()
        events = []
        original_persist = self.service.store.persist_paths
        original_clear = self.service.store.clear_journal

        def persist(paths):
            events.append(("persist", {Path(path).name for path in paths}))
            return original_persist(paths)

        def clear():
            events.append(("clear", set()))
            return original_clear()

        self.service.store.persist_paths = persist
        self.service.store.clear_journal = clear
        self.service.vm_create("work-a", "ubuntu-dev-template", "v1")
        self.assertEqual("persist", events[-2][0])
        self.assertEqual({"disk.qcow2", "nvram.fd", "domain.xml"}, events[-2][1])
        self.assertEqual("clear", events[-1][0])

    def test_resource_fsync_failure_retains_files_and_journal_before_define(self):
        self.publish()
        self.service.store.persist_paths = lambda _paths: (_ for _ in ()).throw(OSError("fsync failed"))
        error = self.assert_error(
            "recovery_required", self.service.vm_create, "work-a", "ubuntu-dev-template", "v1"
        )
        self.assertNotIn("work-a", self.fake.domains)
        self.assertTrue((self.root / "vms" / "work-a" / "disk.qcow2").exists())
        self.assertTrue(Path(error.details["journal"]).exists())

    def test_inspect_detects_disk_path_drift(self):
        vm = self.create()
        replacement = Path(self.temp.name) / "other.qcow2"
        replacement.write_bytes(b"other")
        self.fake.domains["work-a"]["xml"] = self.fake.domains["work-a"]["xml"].replace(vm["disk"], str(replacement))
        inspected = self.service.vm_inspect("work-a")
        self.assertTrue(inspected["drift"])
        self.assert_error("ownership_drift", self.service.vm_start, "work-a")


if __name__ == "__main__":
    unittest.main()
