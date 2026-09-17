import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from libvirt_mcp.domain import DomainSpec, sanitize_clone_xml
from libvirt_mcp.snapshots import rewrite_snapshot_xml
from libvirt_mcp.errors import LifecycleError


FIXTURE = Path(__file__).parent / "fixtures" / "source.xml"
REAL_DOMAIN_FIXTURE = Path(__file__).parent / "fixtures" / "ubuntu-dev-template.xml"


class DomainTests(unittest.TestCase):
    def test_observed_ubuntu_domain_parses_and_clones_with_fresh_identity(self):
        spec = DomainSpec.from_xml(REAL_DOMAIN_FIXTURE.read_text(encoding="utf-8"))

        clone = ET.fromstring(
            sanitize_clone_xml(
                spec,
                "work-a",
                "22222222-2222-2222-2222-222222222222",
                Path("/managed/work-a/disk.qcow2"),
                None,
                ["52:54:00:01:02:03"],
            )
        )

        self.assertEqual("work-a", clone.findtext("name"))
        self.assertEqual("22222222-2222-2222-2222-222222222222", clone.findtext("uuid"))
        self.assertEqual("/managed/work-a/disk.qcow2", clone.find("./devices/disk/source").get("file"))
        self.assertEqual("52:54:00:01:02:03", clone.find("./devices/interface/mac").get("address"))
        self.assertEqual("isa-serial", clone.find("./devices/serial/target/model").get("name"))
        self.assertEqual("ich9", clone.find("./devices/sound").get("model"))
        self.assertEqual("spice", clone.find("./devices/audio").get("type"))
        self.assertEqual(2, len(clone.findall("./devices/redirdev")))
        self.assertEqual("itco", clone.find("./devices/watchdog").get("model"))
        rendered = ET.tostring(clone, encoding="unicode")
        self.assertNotIn(spec.uuid, rendered)
        self.assertNotIn(str(spec.disk), rendered)
        self.assertNotIn("52:54:00:aa:bb:cc", rendered)

    def test_observed_virtual_devices_reject_host_backing_and_unobserved_shapes(self):
        base = REAL_DOMAIN_FIXTURE.read_text(encoding="utf-8")
        tcp_redirection = base.replace(
            '<redirdev bus="usb" type="spicevmc">', '<redirdev bus="usb" type="tcp">', 1
        )
        tcp_redirection_root = ET.fromstring(tcp_redirection)
        self.assertIsNotNone(tcp_redirection_root.find("./devices/redirdev[@type='tcp']"))
        self.assertIsNotNone(tcp_redirection_root.find("./devices/channel[@type='spicevmc']"))
        cases = {
            "host-backed audio": base.replace('type="spice"/>', 'type="pipewire"/>', 1),
            "audio host path": base.replace('type="spice"/>', 'type="spice" path="/tmp/audio.sock"/>', 1),
            "redirection transport": tcp_redirection,
            "redirection bus": base.replace('<redirdev bus="usb"', '<redirdev bus="virtio"', 1),
            "unobserved sound model": base.replace('<sound model="ich9">', '<sound model="ac97">', 1),
            "unobserved watchdog action": base.replace('action="reset"', 'action="poweroff"', 1),
            "unobserved serial target model": base.replace('<model name="isa-serial"/>', '<model name="pci-serial"/>', 1),
            "unexpected audio child": base.replace(
                '<audio id="1" type="spice"/>', '<audio id="1" type="spice"><input/></audio>'
            ),
            "unexpected sound child": base.replace(
                '</sound>', '<codec type="duplex"/></sound>', 1
            ),
            "unexpected watchdog child": base.replace(
                '<watchdog model="itco" action="reset"/>',
                '<watchdog model="itco" action="reset"><source path="/host/watchdog"/></watchdog>',
            ),
        }
        for label, xml in cases.items():
            with self.subTest(label=label):
                with self.assertRaises(LifecycleError) as caught:
                    DomainSpec.from_xml(xml)
                self.assertEqual("unsupported_domain", caught.exception.code)

    def test_passt_loopback_forward_parses_but_fixed_port_is_not_cloned(self):
        source = REAL_DOMAIN_FIXTURE.read_text(encoding="utf-8").replace(
            '<interface type="user">',
            '<interface type="user"><backend type="passt"/>'
            '<portForward proto="tcp" address="127.0.0.1">'
            '<range start="57277" to="22"/></portForward>',
        )
        spec = DomainSpec.from_xml(source)
        clone = ET.fromstring(
            sanitize_clone_xml(
                spec,
                "work-a",
                "22222222-2222-2222-2222-222222222222",
                Path("/managed/work-a/disk.qcow2"),
                None,
                ["52:54:00:01:02:03"],
            )
        )
        self.assertEqual("passt", clone.find("./devices/interface/backend").get("type"))
        self.assertIsNone(clone.find("./devices/interface/portForward"))

    def test_passt_forward_rejects_non_loopback_and_unbounded_shapes(self):
        base = REAL_DOMAIN_FIXTURE.read_text(encoding="utf-8")
        cases = {
            "non-loopback bind": (
                '<backend type="passt"/><portForward proto="tcp" address="0.0.0.0">'
                '<range start="57277" to="22"/></portForward>'
            ),
            "missing range": '<backend type="passt"/><portForward proto="tcp" address="127.0.0.1"/>',
            "non-passt backend": '<backend type="slirp"/>',
            "host device": '<backend type="passt"/><source dev="eth0"/>',
        }
        for label, children in cases.items():
            with self.subTest(label=label):
                xml = base.replace('<interface type="user">', f'<interface type="user">{children}')
                with self.assertRaises(LifecycleError) as caught:
                    DomainSpec.from_xml(xml)
                self.assertEqual("unsupported_domain", caught.exception.code)
        network_interface = FIXTURE.read_text(encoding="utf-8").replace(
            '<interface type="network">', '<interface type="network"><backend type="passt"/>'
        )
        with self.assertRaises(LifecycleError) as caught:
            DomainSpec.from_xml(network_interface)
        self.assertEqual("unsupported_domain", caught.exception.code)

    def test_legacy_and_nested_file_nvram_are_parsed_and_rewritten_in_kind(self):
        modern = FIXTURE.read_text(encoding="utf-8")
        legacy = modern.replace(
            '<nvram type="file" template="/usr/share/OVMF/OVMF_VARS.fd"><source file="/SOURCE/NVRAM.fd"/></nvram>',
            '<nvram template="/usr/share/OVMF/OVMF_VARS.fd">/SOURCE/NVRAM.fd</nvram>',
        )
        for label, source in (("legacy", legacy), ("modern", modern)):
            with self.subTest(label=label):
                spec = DomainSpec.from_xml(source)
                self.assertEqual(Path("/SOURCE/NVRAM.fd"), spec.nvram)
                clone = ET.fromstring(
                    sanitize_clone_xml(spec, "work", "uuid", Path("/managed/disk.qcow2"), Path("/managed/nvram.fd"), ["52:54:00:01:02:03"])
                )
                snapshot = ET.fromstring(
                    rewrite_snapshot_xml(source, "source-vm", spec.uuid, Path("/managed/snapshot.qcow2"), Path("/managed/snapshot.fd"))
                )
                for rewritten, expected in ((clone, "/managed/nvram.fd"), (snapshot, "/managed/snapshot.fd")):
                    nvram = rewritten.find("./os/nvram")
                    if label == "modern":
                        self.assertEqual(expected, nvram.find("source").get("file"))
                        self.assertFalse((nvram.text or "").strip())
                    else:
                        self.assertEqual(expected, (nvram.text or "").strip())
                        self.assertIsNone(nvram.find("source"))

    def test_inspection_rejects_unsupported_firmware_state(self):
        base = FIXTURE.read_text(encoding="utf-8")
        current = '<nvram type="file" template="/usr/share/OVMF/OVMF_VARS.fd"><source file="/SOURCE/NVRAM.fd"/></nvram>'
        cases = {
            "block nvram": base.replace(current, '<nvram type="block"><source dev="/dev/vg/nvram"/></nvram>'),
            "network nvram": base.replace(current, '<nvram type="network"><source protocol="rbd" name="pool/nvram"/></nvram>'),
            "stateless firmware": base.replace(
                '<loader readonly="yes" type="pflash">',
                '<loader readonly="yes" type="pflash" stateless="yes">',
            ),
            "varstore": base.replace(current, current + '<varstore>/SOURCE/VARSTORE.fd</varstore>'),
        }
        for label, xml in cases.items():
            with self.subTest(label=label):
                with self.assertRaises(LifecycleError) as caught:
                    DomainSpec.from_xml(xml)
                self.assertEqual("unsupported_domain", caught.exception.code)

    def test_text_nvram_rejects_file_type_attribute_reserved_for_nested_form(self):
        modern = FIXTURE.read_text(encoding="utf-8")
        malformed = modern.replace(
            '<nvram type="file" template="/usr/share/OVMF/OVMF_VARS.fd"><source file="/SOURCE/NVRAM.fd"/></nvram>',
            '<nvram type="file" template="/usr/share/OVMF/OVMF_VARS.fd">/SOURCE/NVRAM.fd</nvram>',
        )
        with self.assertRaises(LifecycleError) as caught:
            DomainSpec.from_xml(malformed)
        self.assertEqual("unsupported_domain", caught.exception.code)

    def test_inspection_rejects_unsafe_devices_and_extra_writable_disks(self):
        base = FIXTURE.read_text(encoding="utf-8")
        unsafe = [
            "<hostdev mode='subsystem' type='pci'/>",
            "<tpm model='tpm-tis'><backend type='emulator'/></tpm>",
            "<filesystem type='mount'><source dir='/host'/><target dir='host'/></filesystem>",
            "<disk type='block' device='disk'><source dev='/dev/sdb'/><target dev='vdb'/></disk>",
            "<disk type='block' device='cdrom'><source dev='/dev/sr0'/><target dev='sdb'/><readonly/></disk>",
            "<disk type='network' device='cdrom'><source protocol='rbd' name='pool/image'/><target dev='sdb'/><readonly/></disk>",
            "<disk type='file' device='disk'><driver type='qcow2'/><source file='/tmp/two.qcow2'/><target dev='vdb'/></disk>",
            "<interface type='direct'><source dev='eno1' mode='bridge'/></interface>",
        ]
        for device in unsafe:
            with self.subTest(device=device):
                xml = base.replace("</devices>", device + "</devices>")
                with self.assertRaises(LifecycleError) as caught:
                    DomainSpec.from_xml(xml)
                self.assertEqual("unsupported_domain", caught.exception.code)

    def test_inspection_rejects_host_backed_and_stateful_device_configuration(self):
        base = FIXTURE.read_text(encoding="utf-8")
        unsafe = {
            "host serial": '<serial type="dev"><source path="/dev/ttyS0"/><target port="1"/></serial>',
            "host tcp channel": '<channel type="tcp"><source mode="connect" host="10.0.0.8" service="4444"/><target type="virtio" name="host.socket"/></channel>',
            "evdev": '<input type="evdev"><source dev="/dev/input/event4"/></input>',
            "shared memory": '<shmem name="looking-glass"><model type="ivshmem-plain"/><size unit="M">32</size></shmem>',
            "memory device": '<memory model="dimm"><target><size unit="MiB">512</size><node>0</node></target></memory>',
            "arbitrary rng": '<rng model="virtio"><backend model="random">/dev/hwrng</backend></rng>',
        }
        for label, device in unsafe.items():
            with self.subTest(label=label):
                with self.assertRaises(LifecycleError) as caught:
                    DomainSpec.from_xml(base.replace("</devices>", device + "</devices>"))
                self.assertEqual("unsupported_domain", caught.exception.code)
        for label, os_config in {
            "kernel": "<kernel>/boot/vmlinuz-host</kernel>",
            "initrd": "<initrd>/boot/initrd-host</initrd>",
        }.items():
            with self.subTest(label=label):
                with self.assertRaises(LifecycleError) as caught:
                    DomainSpec.from_xml(base.replace("</os>", os_config + "</os>"))
                self.assertEqual("unsupported_domain", caught.exception.code)

    def test_realistic_virtual_devices_read_only_firmware_and_urandom_rng_are_supported(self):
        source = FIXTURE.read_text(encoding="utf-8")
        spec = DomainSpec.from_xml(source)
        rewritten = sanitize_clone_xml(
            spec, "work", "uuid", Path("/managed/disk.qcow2"), Path("/managed/nvram.fd"), ["52:54:00:01:02:03"]
        )
        self.assertIn("/usr/share/OVMF/OVMF_CODE.fd", rewritten)
        self.assertIn("/dev/urandom", rewritten)
        self.assertIn('serial type="pty"', rewritten)

    def test_sizing_overrides_reject_dependent_cpu_and_memory_configuration(self):
        base = FIXTURE.read_text(encoding="utf-8")
        cases = {
            "topology": (base.replace("</vcpu>", "</vcpu><cpu><topology sockets=\"1\" dies=\"1\" cores=\"2\" threads=\"1\"/></cpu>"), 4, None),
            "pinning": (base.replace("</vcpu>", "</vcpu><cputune><vcpupin vcpu=\"0\" cpuset=\"0\"/></cputune>"), 4, None),
            "per-vcpu": (base.replace("</vcpu>", "</vcpu><vcpus><vcpu id=\"0\" enabled=\"yes\" hotpluggable=\"no\"/></vcpus>"), 4, None),
            "numa": (base.replace("</vcpu>", "</vcpu><cpu><numa><cell id=\"0\" cpus=\"0-1\" memory=\"2097152\" unit=\"KiB\"/></numa></cpu>"), 4, None),
            "max-memory": (base.replace("<memory unit=\"KiB\">", '<maxMemory slots="16" unit="KiB">4194304</maxMemory><memory unit="KiB">'), None, 4096),
        }
        for label, (xml, vcpus, memory_mib) in cases.items():
            with self.subTest(label=label):
                with self.assertRaises(LifecycleError) as caught:
                    sanitize_clone_xml(DomainSpec.from_xml(xml), "work", "uuid", Path("/d"), None, ["52:54:00:01:02:03"], vcpus, memory_mib)
                self.assertEqual("unsupported_override", caught.exception.code)

    def test_inspection_rejects_shareable_writable_disk(self):
        xml = FIXTURE.read_text(encoding="utf-8").replace(
            '<target dev="vda" bus="virtio"/>', '<target dev="vda" bus="virtio"/><shareable/>'
        )
        with self.assertRaises(LifecycleError) as caught:
            DomainSpec.from_xml(xml)
        self.assertEqual("unsupported_domain", caught.exception.code)

    def test_clone_sanitizes_identity_source_paths_and_runtime_paths(self):
        source = FIXTURE.read_text(encoding="utf-8").replace(
            "<devices>", "<genid>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</genid><seclabel type=\"dynamic\"><label>source-label</label></seclabel><devices>"
        ).replace(
            '<source file="/SOURCE/source.qcow2"/>',
            '<source file="/SOURCE/source.qcow2"/><serial>SOURCE-SERIAL</serial><wwn>5000cca123456789</wwn><alias name="ua-source-disk"/>',
        ).replace(
            '<source network="default"/>',
            '<source network="default" portid="12345678-1234-1234-1234-123456789abc"/><target dev="vnet7"/><alias name="net0"/>',
        ).replace(
            '<graphics type="spice" autoport="yes">',
            '<graphics type="spice" autoport="yes" port="5907" tlsPort="5908" websocket="5700" socket="/run/libvirt/allocated.sock"><alias name="graphics0"/>',
        )
        spec = DomainSpec.from_xml(source)
        xml = sanitize_clone_xml(
            spec,
            name="work-a",
            uuid="22222222-2222-2222-2222-222222222222",
            disk=Path("/managed/work-a/disk.qcow2"),
            nvram=Path("/managed/work-a/nvram.fd"),
            macs=["52:54:00:01:02:03"],
            vcpus=4,
            memory_mib=4096,
        )
        self.assertIn("22222222-2222-2222-2222-222222222222", xml)
        self.assertNotIn("11111111-1111-1111-1111-111111111111", xml)
        self.assertIn("/managed/work-a/disk.qcow2", xml)
        self.assertIn("/managed/work-a/nvram.fd", xml)
        self.assertNotIn("source.qcow2", xml)
        self.assertNotIn("installer.iso", xml)
        self.assertNotIn("source.sock", xml)
        self.assertNotIn("source-spice.sock", xml)
        self.assertNotIn("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", xml)
        self.assertNotIn("vnet7", xml)
        self.assertNotIn("source-label", xml)
        for generated in (
            "SOURCE-SERIAL",
            "5000cca123456789",
            "ua-source-disk",
            "12345678-1234-1234-1234-123456789abc",
            "net0",
            "graphics0",
            "5907",
            "5908",
            "5700",
            "allocated.sock",
        ):
            self.assertNotIn(generated, xml)
        self.assertIn("52:54:00:01:02:03", xml)
        self.assertIn('<memory unit="KiB">4194304</memory>', xml)
        self.assertIn('<currentMemory unit="KiB">4194304</currentMemory>', xml)
        self.assertIn('<vcpu placement="static" current="4">4</vcpu>', xml)

    def test_overrides_must_be_positive_non_booleans(self):
        spec = DomainSpec.from_xml(FIXTURE.read_text(encoding="utf-8"))
        for vcpus, memory in [(0, None), (None, -1), (True, None)]:
            with self.subTest(vcpus=vcpus, memory=memory):
                with self.assertRaises(LifecycleError) as caught:
                    sanitize_clone_xml(spec, "x", "u", Path("/d"), None, [], vcpus, memory)
                self.assertEqual("invalid_argument", caught.exception.code)


if __name__ == "__main__":
    unittest.main()
