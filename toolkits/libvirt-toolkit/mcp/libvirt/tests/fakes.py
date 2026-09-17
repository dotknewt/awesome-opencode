from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace


class FakeRunner:
    """Stateful virsh/qemu-img substitute; filesystem effects are real and temporary."""

    def __init__(self, source_xml: str, source_disk: Path, source_nvram: Path):
        source_xml = source_xml.replace("/SOURCE/source.qcow2", str(source_disk)).replace(
            "/SOURCE/NVRAM.fd", str(source_nvram)
        )
        self.domains = {
            "source-vm": {
                "xml": source_xml,
                "state": "shut off",
                "managed_save": False,
            }
        }
        self.backings: dict[str, str | None] = {str(source_disk): None}
        self.fail: dict[tuple[str, ...], str] = {}
        self.shutdown_completes = True
        self.reject_live_image_info = False
        self.define_visibility = "normal"
        self.define_transform = None
        self.calls: list[list[str]] = []
        self.capabilities_xml = """<capabilities><host>
          <uuid>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</uuid>
          <cpu><arch>x86_64</arch><model>Skylake-Client-IBRS</model><vendor>Intel</vendor>
          <topology sockets="1" dies="1" cores="4" threads="2"/>
          <feature name="vmx"/><feature name="ssse3"/></cpu>
          <power_management><suspend_mem/><suspend_disk/></power_management>
          <iommu support="yes"/></host></capabilities>"""

    def backing_for(self, path: str | Path) -> str | None:
        return self.backings.get(str(path))

    def run(self, argv, timeout_seconds=30):
        argv = [str(item) for item in argv]
        self.calls.append(argv)
        for prefix, message in self.fail.items():
            if tuple(argv[: len(prefix)]) == prefix:
                return SimpleNamespace(returncode=1, stdout="", stderr=message)
        if argv[0] == "qemu-img":
            return self._qemu(argv)
        if argv[:3] != ["virsh", "--connect", "qemu:///session"]:
            return SimpleNamespace(returncode=2, stdout="", stderr="missing explicit URI")
        return self._virsh(argv[3:])

    def _ok(self, stdout=""):
        return SimpleNamespace(returncode=0, stdout=stdout, stderr="")

    def _virsh(self, args):
        command = args[0]
        if command == "capabilities":
            return self._ok(self.capabilities_xml)
        if command == "version":
            return self._ok("Compiled against library: libvirt 10.0.0\n")
        if command == "list":
            return self._ok("\n".join(self.domains) + "\n")
        name = args[-1]
        if command == "dominfo":
            return self._ok() if name in self.domains else SimpleNamespace(returncode=1, stdout="", stderr="not found")
        if command == "domstate":
            domain = self.domains.get(name)
            return self._ok(domain["state"] + "\n") if domain else SimpleNamespace(returncode=1, stdout="", stderr="not found")
        if command == "managedsave-dumpxml":
            domain = self.domains.get(name)
            if domain and domain["managed_save"]:
                return self._ok(domain["xml"])
            return SimpleNamespace(returncode=1, stdout="", stderr="no managed save image")
        if command == "dumpxml":
            domain = self.domains.get(name)
            return self._ok(domain["xml"]) if domain else SimpleNamespace(returncode=1, stdout="", stderr="not found")
        if command == "define":
            xml = Path(args[1]).read_text(encoding="utf-8")
            if self.define_visibility == "missing":
                return self._ok()
            root = ET.fromstring(xml)
            lookup_name = root.findtext("name")
            if self.define_transform is not None:
                xml = self.define_transform(xml)
            self.domains[lookup_name] = {"xml": xml, "state": "shut off", "managed_save": False}
            return self._ok()
        if command == "start":
            self.domains[name]["state"] = "running"
            return self._ok()
        if command == "shutdown":
            if self.shutdown_completes:
                self.domains[name]["state"] = "shut off"
            return self._ok()
        if command == "destroy":
            self.domains[name]["state"] = "shut off"
            return self._ok()
        if command == "undefine":
            if "<nvram" in self.domains[name]["xml"] and "--nvram" not in args:
                return SimpleNamespace(returncode=1, stdout="", stderr="cannot undefine domain with nvram")
            del self.domains[name]
            return self._ok()
        return SimpleNamespace(returncode=2, stdout="", stderr=f"unsupported virsh {command}")

    def _qemu(self, argv):
        command = argv[1]
        if command == "convert":
            source, destination = argv[-2:]
            Path(destination).write_bytes(Path(source).read_bytes())
            self.backings[destination] = None
            return self._ok()
        if command == "create":
            backing = argv[argv.index("-b") + 1]
            destination = argv[-1]
            Path(destination).write_bytes(b"overlay")
            self.backings[destination] = backing
            return self._ok()
        if command == "info":
            path = argv[-1]
            if self.reject_live_image_info:
                for domain in self.domains.values():
                    if domain["state"] != "running":
                        continue
                    root = ET.fromstring(domain["xml"])
                    source = root.find("./devices/disk/source")
                    if source is not None and source.get("file") == path:
                        return SimpleNamespace(returncode=1, stdout="", stderr="image is locked by running VM")
            if path not in self.backings:
                return SimpleNamespace(returncode=1, stdout="", stderr="unknown image")
            chain = []
            current = path
            while current:
                item = {"filename": current, "format": "qcow2", "virtual-size": 1048576}
                backing = self.backings.get(current)
                if backing:
                    item["backing-filename"] = backing
                    item["full-backing-filename"] = backing
                chain.append(item)
                current = backing
            return self._ok(json.dumps(chain))
        return SimpleNamespace(returncode=2, stdout="", stderr=f"unsupported qemu-img {command}")
