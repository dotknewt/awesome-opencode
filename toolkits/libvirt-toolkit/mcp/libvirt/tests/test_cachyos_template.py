"""Observed CachyOS XML through the real lifecycle core, with fake host I/O."""
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from libvirt_mcp.errors import LifecycleError
from libvirt_mcp.lifecycle import Lifecycle
from fakes import FakeRunner


FIXTURE = Path(__file__).parent / "fixtures" / "cachyos.xml"
TEMPLATE = "cachyos-dev-template"


class CachyOSTemplateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.disk = root / "source.qcow2"
        self.nvram = root / "source_VARS.fd"
        self.disk.write_bytes(b"retained CachyOS source")
        self.nvram.write_bytes(b"retained CachyOS firmware state")
        self.fake = FakeRunner(FIXTURE.read_text(encoding="utf-8"), self.disk, self.nvram)
        self.fake.domains["CachyOS"] = self.fake.domains.pop("source-vm")
        self.source_xml = self.fake.domains["CachyOS"]["xml"]
        self.service = Lifecycle(root / "managed", runner=self.fake)

    def assert_source_unchanged(self):
        self.assertEqual(self.source_xml, self.fake.domains["CachyOS"]["xml"])
        self.assertEqual(b"retained CachyOS source", self.disk.read_bytes())
        self.assertEqual(b"retained CachyOS firmware state", self.nvram.read_bytes())

    def assert_configuration(self, xml):
        self.assertEqual("8", xml.findtext("vcpu"))
        self.assertEqual("16777216", xml.findtext("memory"))
        self.assertEqual("16777216", xml.findtext("currentMemory"))
        self.assertEqual("memfd", xml.find("./memoryBacking/source").get("type"))
        self.assertEqual("shared", xml.find("./memoryBacking/access").get("mode"))
        self.assertEqual("efi", xml.find("os").get("firmware"))
        self.assertEqual("/usr/share/edk2/x64/OVMF_CODE.secboot.4m.fd", xml.findtext("./os/loader"))
        self.assertEqual("yes", xml.find("./os/loader").get("readonly"))
        self.assertEqual("yes", xml.find("./os/loader").get("secure"))
        self.assertEqual({"enrolled-keys": "no", "secure-boot": "yes"}, {
            feature.get("name"): feature.get("enabled")
            for feature in xml.findall("./os/firmware/feature")
        })
        self.assertEqual("/usr/share/edk2/x64/OVMF_VARS.4m.fd", xml.find("./os/nvram").get("template"))
        self.assertEqual("http://archlinux.org/archlinux/rolling", xml.find(
            ".//{http://libosinfo.org/xmlns/libvirt/domain/1.0}os"
        ).get("id"))

    def test_publication_and_sibling_clones_own_disks_and_nvram(self):
        template = self.service.template_publish("CachyOS", TEMPLATE, "v1")
        first = self.service.vm_create("cachyos-project-a", TEMPLATE, "v1")
        second = self.service.vm_create("cachyos-project-b", TEMPLATE, "v1")
        self.assertIsNone(self.fake.backing_for(template["disk"]))
        self.assertEqual(b"retained CachyOS source", Path(template["disk"]).read_bytes())
        identities, macs = set(), set()
        for record in (template, first, second):
            xml = ET.fromstring(Path(record["xml"]).read_text(encoding="utf-8"))
            self.assert_configuration(xml)
            self.assertEqual(record["disk"], xml.find("./devices/disk/source").get("file"))
            self.assertEqual(record["nvram"], xml.findtext("./os/nvram"))
            self.assertEqual(b"retained CachyOS firmware state", Path(record["nvram"]).read_bytes())
            self.assertIsNone(xml.find("./devices/disk[@device='cdrom']"))
        for vm in (first, second):
            xml = ET.fromstring(self.fake.domains[vm["name"]]["xml"])
            self.assertEqual(vm["nvram"], xml.findtext("./os/nvram"))
            self.assertEqual(template["disk"], self.fake.backing_for(vm["disk"]))
            self.assertEqual(vm["uuid"], xml.findtext("uuid"))
            identities.add(vm["uuid"])
            macs.add(xml.find("./devices/interface/mac").get("address"))
        self.assertEqual(2, len(identities))
        self.assertEqual(2, len(macs))
        self.assertNotIn("11111111-1111-4111-8111-111111111111", identities)
        self.assertNotIn("52:54:00:aa:bb:cc", macs)
        for field, source in (("disk", self.disk), ("nvram", self.nvram)):
            self.assertEqual(4, len({str(source), template[field], first[field], second[field]}))
        Path(first["nvram"]).write_bytes(b"first clone firmware change")
        for record in (template, second):
            self.assertEqual(b"retained CachyOS firmware state", Path(record["nvram"]).read_bytes())
        self.assert_source_unchanged()

    def test_snapshot_restores_saved_firmware_and_configuration_with_same_identity(self):
        self.service.template_publish("CachyOS", TEMPLATE, "v1")
        vm = self.service.vm_create("cachyos-project", TEMPLATE, "v1")
        original = ET.fromstring(self.fake.domains[vm["name"]]["xml"])
        Path(vm["nvram"]).write_bytes(b"saved working VM firmware")
        saved = self.service.snapshot_create(vm["name"], "before-changes")
        after_snapshot = self.service.vm_inspect(vm["name"])
        Path(after_snapshot["nvram"]).write_bytes(b"changed after snapshot")
        changed = ET.fromstring(self.fake.domains[vm["name"]]["xml"])
        changed.find("vcpu").text = "4"
        changed.find("memory").text = "4194304"
        changed.find("currentMemory").text = "4194304"
        changed.remove(changed.find("memoryBacking"))
        self.fake.domains[vm["name"]]["xml"] = ET.tostring(changed, encoding="unicode")
        restored = self.service.snapshot_restore(vm["name"], "before-changes")
        active = ET.fromstring(self.fake.domains[vm["name"]]["xml"])
        self.assert_configuration(active)
        self.assertEqual(vm["uuid"], active.findtext("uuid"))
        self.assertEqual(original.find("./devices/interface/mac").get("address"),
                         active.find("./devices/interface/mac").get("address"))
        self.assertEqual("shut off", restored["state"])
        self.assertEqual(restored["nvram"], active.findtext("./os/nvram"))
        self.assertEqual(vm["disk"], saved["disk"])
        self.assertEqual(saved["disk"], self.fake.backing_for(after_snapshot["disk"]))
        self.assertEqual(saved["disk"], self.fake.backing_for(restored["disk"]))
        self.assertNotEqual(after_snapshot["disk"], restored["disk"])
        self.assertNotEqual(saved["nvram"], restored["nvram"])
        for record in (saved, restored):
            self.assertEqual(b"saved working VM firmware", Path(record["nvram"]).read_bytes())
        Path(restored["nvram"]).write_bytes(b"changed after restore")
        self.assertEqual(b"saved working VM firmware", Path(saved["nvram"]).read_bytes())
        self.assert_source_unchanged()

    def test_memfd_backing_does_not_allow_shared_memory_devices(self):
        xml = ET.fromstring(self.source_xml)
        xml.find("devices").append(ET.fromstring(
            '<shmem name="shared"><model type="ivshmem-plain"/><size unit="M">32</size></shmem>'
        ))
        self.fake.domains["CachyOS"]["xml"] = ET.tostring(xml, encoding="unicode")
        with self.assertRaises(LifecycleError) as caught:
            self.service.template_publish("CachyOS", TEMPLATE, "v1")
        self.assertEqual("unsupported_domain", caught.exception.code)
        self.assertEqual([], self.service.template_list()["templates"])
        self.assertFalse(self.service.store.journal_path.exists())
        self.assertEqual(b"retained CachyOS source", self.disk.read_bytes())
        self.assertEqual(b"retained CachyOS firmware state", self.nvram.read_bytes())


if __name__ == "__main__":
    unittest.main()
