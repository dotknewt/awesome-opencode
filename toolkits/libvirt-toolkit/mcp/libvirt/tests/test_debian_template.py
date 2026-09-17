"""Observed Debian 13 XML through the real lifecycle core, with fake host I/O."""
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from libvirt_mcp.lifecycle import Lifecycle
from fakes import FakeRunner


FIXTURE = Path(__file__).parent / "fixtures" / "debian13-dev-template.xml"
TEMPLATE = "debian13-dev-template"


class DebianTemplateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.disk = root / "source.qcow2"
        self.disk.write_bytes(b"retained Debian source")
        self.fake = FakeRunner(FIXTURE.read_text(encoding="utf-8"), self.disk, root / "absent.fd")
        self.fake.domains[TEMPLATE] = self.fake.domains.pop("source-vm")
        self.source_xml = self.fake.domains[TEMPLATE]["xml"]
        self.service = Lifecycle(root / "managed", runner=self.fake)

    def test_publication_and_sibling_clones_preserve_bios_and_split_sizing(self):
        template = self.service.template_publish(TEMPLATE, TEMPLATE, "v1")
        first = self.service.vm_create("debian-project-a", TEMPLATE, "v1")
        second = self.service.vm_create("debian-project-b", TEMPLATE, "v1")
        self.assertIsNone(template["nvram"])
        self.assertIsNone(self.fake.backing_for(template["disk"]))
        self.assertEqual(b"retained Debian source", Path(template["disk"]).read_bytes())
        identities, macs, disks = set(), set(), set()
        for vm in (first, second):
            xml = ET.fromstring(self.fake.domains[vm["name"]]["xml"])
            self.assertIsNone(vm["nvram"])
            self.assertIsNone(xml.find("./os/nvram"))
            self.assertIsNone(xml.find("./os/loader"))
            self.assertEqual("hd", xml.find("./os/boot").get("dev"))
            self.assertEqual("8", xml.findtext("vcpu"))
            self.assertEqual("2", xml.find("vcpu").get("current"))
            self.assertEqual("8388608", xml.findtext("memory"))
            self.assertEqual("4194304", xml.findtext("currentMemory"))
            self.assertEqual("http://debian.org/debian/13", xml.find(
                ".//{http://libosinfo.org/xmlns/libvirt/domain/1.0}os"
            ).get("id"))
            self.assertEqual(vm["disk"], xml.find("./devices/disk/source").get("file"))
            self.assertEqual(template["disk"], self.fake.backing_for(vm["disk"]))
            self.assertEqual(vm["uuid"], xml.findtext("uuid"))
            identities.add(vm["uuid"])
            macs.add(xml.find("./devices/interface/mac").get("address"))
            disks.add(vm["disk"])
        self.assertEqual(2, len(identities))
        self.assertEqual(2, len(macs))
        self.assertEqual(2, len(disks))
        self.assertNotIn("11111111-1111-4111-8111-111111111111", identities)
        self.assertNotIn("52:54:00:aa:bb:cc", macs)
        self.assertEqual(self.source_xml, self.fake.domains[TEMPLATE]["xml"])
        self.assertEqual(b"retained Debian source", self.disk.read_bytes())

    def test_bios_snapshot_restore_preserves_identity_without_firmware_files(self):
        self.service.template_publish(TEMPLATE, TEMPLATE, "v1")
        vm = self.service.vm_create("debian-project", TEMPLATE, "v1")
        original_xml = ET.fromstring(self.fake.domains[vm["name"]]["xml"])
        saved = self.service.snapshot_create(vm["name"], "before-changes")
        after_snapshot = self.service.vm_inspect(vm["name"])
        changed = ET.fromstring(self.fake.domains[vm["name"]]["xml"])
        changed.find("vcpu").text = "4"
        changed.find("vcpu").set("current", "4")
        changed.find("memory").text = "2097152"
        changed.find("currentMemory").text = "2097152"
        self.fake.domains[vm["name"]]["xml"] = ET.tostring(changed, encoding="unicode")
        restored = self.service.snapshot_restore(vm["name"], "before-changes")
        active = ET.fromstring(self.fake.domains[vm["name"]]["xml"])
        self.assertEqual(vm["disk"], saved["disk"])
        self.assertEqual(saved["disk"], self.fake.backing_for(after_snapshot["disk"]))
        self.assertEqual(saved["disk"], self.fake.backing_for(restored["disk"]))
        self.assertNotEqual(after_snapshot["disk"], restored["disk"])
        self.assertEqual("shut off", restored["state"])
        self.assertEqual(vm["uuid"], active.findtext("uuid"))
        self.assertEqual(original_xml.find("./devices/interface/mac").get("address"),
                         active.find("./devices/interface/mac").get("address"))
        self.assertEqual("8", active.findtext("vcpu"))
        self.assertEqual("2", active.find("vcpu").get("current"))
        self.assertEqual("8388608", active.findtext("memory"))
        self.assertEqual("4194304", active.findtext("currentMemory"))
        for record in (saved, restored):
            self.assertIsNone(record["nvram"])
            archived = ET.fromstring(Path(record["xml"]).read_text(encoding="utf-8"))
            self.assertIsNone(archived.find("./os/nvram"))
            self.assertIsNone(archived.find("./os/loader"))
        self.assertEqual(["before-changes"], [
            item["name"] for item in self.service.snapshot_list(vm["name"])["snapshots"]
        ])
        self.assertEqual(self.source_xml, self.fake.domains[TEMPLATE]["xml"])
        self.assertEqual(b"retained Debian source", self.disk.read_bytes())


if __name__ == "__main__":
    unittest.main()
