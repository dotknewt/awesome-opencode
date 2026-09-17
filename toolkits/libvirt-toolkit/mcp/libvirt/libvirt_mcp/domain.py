from __future__ import annotations

import copy
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

from .errors import LifecycleError


SUPPORTED_DEVICE_TAGS = {
    "audio",
    "channel",
    "console",
    "controller",
    "disk",
    "emulator",
    "graphics",
    "input",
    "interface",
    "memballoon",
    "panic",
    "redirdev",
    "rng",
    "serial",
    "sound",
    "video",
    "watchdog",
}

DEVICE_CHILDREN = {
    "audio": set(),
    "channel": {"source", "target", "alias", "address"},
    "console": {"source", "target", "alias", "address"},
    "controller": {"model", "target", "driver", "alias", "address"},
    "disk": {"driver", "source", "target", "readonly", "boot", "serial", "wwn", "alias", "address"},
    "emulator": set(),
    "graphics": {"listen", "image", "gl", "audio", "alias"},
    "input": {"driver", "alias", "address"},
    "interface": {
        "mac", "source", "target", "model", "driver", "link", "boot", "mtu", "rom", "backend", "portForward",
        "bandwidth", "vlan", "virtualport", "alias", "address",
    },
    "memballoon": {"driver", "stats", "alias", "address"},
    "panic": {"alias", "address"},
    "redirdev": {"alias", "address"},
    "rng": {"rate", "backend", "driver", "alias", "address"},
    "serial": {"source", "target", "alias", "address"},
    "sound": {"alias", "address"},
    "video": {"model", "driver", "alias", "address"},
    "watchdog": {"alias", "address"},
}

ALLOWED_GRANDCHILDREN = {
    ("interface", "bandwidth"): {"inbound", "outbound"},
    ("interface", "portForward"): {"range"},
    ("interface", "vlan"): {"tag"},
    ("interface", "virtualport"): {"parameters"},
    ("serial", "target"): {"model"},
    ("video", "model"): {"acceleration", "resolution"},
}

HOST_RESOURCE_ATTRIBUTES = {"file", "path", "dir", "rendernode", "socket"}


def _unsupported(message: str) -> None:
    raise LifecycleError("unsupported_domain", message)


def _validate_children(device: ET.Element) -> None:
    allowed = DEVICE_CHILDREN[device.tag]
    unknown = sorted({child.tag for child in device if child.tag not in allowed})
    if unknown:
        _unsupported(f"{device.tag} contains unsupported child configuration: {', '.join(unknown)}")
    for child in device:
        allowed_grandchildren = ALLOWED_GRANDCHILDREN.get((device.tag, child.tag), set())
        unknown_grandchildren = sorted({nested.tag for nested in child if nested.tag not in allowed_grandchildren})
        if unknown_grandchildren:
            _unsupported(
                f"{device.tag}/{child.tag} contains unsupported nested configuration: "
                + ", ".join(unknown_grandchildren)
            )
        if any(list(nested) for nested in child):
            _unsupported(f"{device.tag}/{child.tag} contains unsupported deeply nested configuration")


def _generated_resource(device: ET.Element, element: ET.Element, attribute: str) -> bool:
    if device.tag == "disk" and element is device.find("source") and attribute == "file":
        return True
    if device.tag in {"serial", "console", "channel"} and element is device.find("source") and attribute == "path":
        return True
    if device.tag == "graphics" and attribute == "socket":
        return element is device or element in device.findall("listen")
    return False


def _validate_nested_resources(device: ET.Element) -> None:
    for element in device.iter():
        for attribute in HOST_RESOURCE_ATTRIBUTES:
            if element.get(attribute) and not _generated_resource(device, element, attribute):
                _unsupported(f"{device.tag} contains unsupported host resource attribute {attribute}")
        if element.tag == "source" and element.get("dev"):
            _unsupported(f"{device.tag} contains an unsupported host device source")
        text = (element.text or "").strip()
        if text.startswith("/") and not (
            (device.tag == "emulator" and element is device)
            or (device.tag == "rng" and element is device.find("backend") and text == "/dev/urandom")
        ):
            _unsupported(f"{device.tag} contains an unsupported host path")


def _validate_device_subtype(device: ET.Element) -> None:
    tag = device.tag
    if tag == "audio" and device.get("type") != "spice":
        _unsupported("host-backed audio devices are unsupported")
    if tag == "controller" and device.get("type") not in {
        "pci", "usb", "sata", "scsi", "virtio-serial", "ide", "ccid", "isa"
    }:
        _unsupported("controller type is unsupported")
    if tag == "disk" and device.get("device", "disk") not in {"disk", "cdrom"}:
        _unsupported("disk device subtype is unsupported")
    if tag == "emulator":
        executable = (device.text or "").strip()
        if not executable or not Path(executable).is_absolute():
            _unsupported("emulator must be a fixed absolute executable reference")
    if tag == "graphics":
        if device.get("type") not in {"spice", "vnc"}:
            _unsupported("graphics type is unsupported")
        for listen in device.findall("listen"):
            if listen.get("type") not in {"socket", "address", "network", "none"}:
                _unsupported("graphics listen type is unsupported")
    if tag == "video":
        models = device.findall("model")
        if len(models) != 1 or models[0].get("type") not in {"virtio", "qxl", "vga", "bochs", "cirrus"}:
            _unsupported("video model is unsupported")
    if tag == "memballoon" and device.get("model") not in {"virtio", "none"}:
        _unsupported("memory balloon model is unsupported")
    if tag == "panic" and device.get("model") not in {"isa", "pseries", "hyperv", "s390", "pvpanic"}:
        _unsupported("panic device model is unsupported")
    if tag == "redirdev" and (device.get("bus"), device.get("type")) != ("usb", "spicevmc"):
        _unsupported("host-backed redirection transports are unsupported")
    if tag == "serial":
        for target in device.findall("target"):
            models = target.findall("model")
            if models and (
                target.get("type") != "isa-serial"
                or len(models) != 1
                or models[0].get("name") != "isa-serial"
            ):
                _unsupported("serial target model is unsupported")
    if tag == "sound" and device.get("model") != "ich9":
        _unsupported("sound device model is unsupported")
    if tag == "watchdog" and (device.get("model"), device.get("action")) != ("itco", "reset"):
        _unsupported("watchdog device configuration is unsupported")


def _port_number(value: str | None, field: str) -> int:
    try:
        number = int(value or "")
    except ValueError:
        _unsupported(f"passt forwarding {field} must be a TCP port number")
    if not 1 <= number <= 65535:
        _unsupported(f"passt forwarding {field} must be a TCP port number")
    return number


def _validate_passt_forwarding(interface: ET.Element) -> None:
    backends = interface.findall("backend")
    forwards = interface.findall("portForward")
    if (backends or forwards) and interface.get("type", "network") != "user":
        _unsupported("passt forwarding is supported only on user interfaces")
    if len(backends) > 1:
        _unsupported("user interface has multiple network backends")
    if backends and backends[0].attrib != {"type": "passt"}:
        _unsupported("user interface backend must be an unadorned passt backend")
    if forwards and not backends:
        _unsupported("port forwarding requires the passt backend")
    for forwarding in forwards:
        if forwarding.attrib != {"proto": "tcp", "address": "127.0.0.1"}:
            _unsupported("passt forwarding must bind TCP only to 127.0.0.1")
        ranges = forwarding.findall("range")
        if not ranges:
            _unsupported("passt forwarding must name a bounded port range")
        for port_range in ranges:
            if set(port_range.attrib) - {"start", "end", "to"}:
                _unsupported("passt forwarding range contains unsupported attributes")
            start = _port_number(port_range.get("start"), "start")
            end = _port_number(port_range.get("end"), "end") if port_range.get("end") else start
            destination = _port_number(port_range.get("to"), "destination") if port_range.get("to") else start
            if end < start or destination + (end - start) > 65535:
                _unsupported("passt forwarding range is invalid")


def _nvram_path(root: ET.Element) -> Path | None:
    os_element = root.find("os")
    if os_element is None:
        raise LifecycleError("unsupported_domain", "domain XML must contain an os section")
    if os_element.find("varstore") is not None:
        raise LifecycleError("unsupported_domain", "separate firmware varstores are unsupported")
    loaders = os_element.findall("loader")
    if len(loaders) > 1:
        raise LifecycleError("unsupported_domain", "multiple firmware loader references are unsupported")
    for loader in loaders:
        if loader.get("stateless") == "yes":
            raise LifecycleError("unsupported_domain", "stateless firmware is unsupported")
        if loader.get("readonly") != "yes":
            raise LifecycleError("unsupported_domain", "firmware loader references must be read-only")
    nvram = os_element.find("nvram")
    if nvram is None:
        return None
    source = nvram.find("source")
    nvram_type = nvram.get("type")
    text = (nvram.text or "").strip()
    if source is not None:
        filename = source.get("file")
        if nvram_type != "file" or not filename or text or len(nvram.findall("source")) != 1:
            raise LifecycleError("unsupported_domain", "NVRAM must be a single file-backed source")
        return Path(filename)
    if nvram_type is not None or not text:
        raise LifecycleError("unsupported_domain", "NVRAM must use a legacy path or nested file source")
    return Path(text)


def rewrite_nvram(root: ET.Element, path: Path | None) -> None:
    """Rewrite supported NVRAM without converting legacy and nested XML forms."""
    os_element = root.find("os")
    if os_element is None:
        raise LifecycleError("unsupported_domain", "domain XML must contain an os section")
    nvram = os_element.find("nvram")
    if path is None:
        if nvram is not None:
            os_element.remove(nvram)
        return
    if nvram is None:
        nvram = ET.SubElement(os_element, "nvram")
        nvram.text = str(path)
        return
    source = nvram.find("source")
    if source is None:
        nvram.text = str(path)
        return
    nvram.text = None
    nvram.set("type", "file")
    source.attrib.clear()
    source.set("file", str(path))


def _validate_devices(devices: ET.Element) -> None:
    unsupported = sorted({device.tag for device in devices if device.tag not in SUPPORTED_DEVICE_TAGS})
    if unsupported:
        raise LifecycleError(
            "unsupported_domain",
            "domain contains unsupported device configuration",
            {"devices": unsupported},
        )
    for device in devices:
        _validate_children(device)
        _validate_device_subtype(device)
        _validate_nested_resources(device)
    for interface in devices.findall("interface"):
        if interface.get("type", "network") not in {"network", "bridge", "user"}:
            raise LifecycleError("unsupported_domain", "host-bound network interfaces are unsupported")
        _validate_passt_forwarding(interface)
        source = interface.find("source")
        if source is not None:
            allowed_source_attributes = {
                "network": {"network", "portid"},
                "bridge": {"bridge", "portid"},
                "user": set(),
            }[interface.get("type", "network")]
            if set(source.attrib) - allowed_source_attributes:
                _unsupported("interface source contains unsupported host resources")
    for tag in ("serial", "console"):
        for device in devices.findall(tag):
            if device.get("type", "pty") != "pty" or len(device.findall("source")) > 1:
                raise LifecycleError("unsupported_domain", f"host-backed {tag} devices are unsupported")
            source = device.find("source")
            if source is not None and set(source.attrib) - {"path"}:
                _unsupported(f"host-backed {tag} source attributes are unsupported")
    for channel in devices.findall("channel"):
        if channel.get("type") not in {"unix", "spicevmc", "qemu-vdagent"}:
            raise LifecycleError("unsupported_domain", "host-backed channel transports are unsupported")
        for source in channel.findall("source"):
            if any(source.get(attribute) for attribute in ("dev", "file", "host", "service")):
                raise LifecycleError("unsupported_domain", "host-backed channel sources are unsupported")
            if set(source.attrib) - {"mode", "path"}:
                _unsupported("channel source attributes are unsupported")
    for input_device in devices.findall("input"):
        if input_device.get("type") not in {"mouse", "tablet", "keyboard"} or input_device.find("source") is not None:
            raise LifecycleError("unsupported_domain", "host-backed input devices are unsupported")
    for rng in devices.findall("rng"):
        backend = rng.find("backend")
        if (
            rng.get("model") != "virtio"
            or backend is None
            or backend.get("model") != "random"
            or (backend.text or "").strip() != "/dev/urandom"
            or len(rng.findall("backend")) != 1
        ):
            raise LifecycleError("unsupported_domain", "only virtio RNG backed by /dev/urandom is supported")


def _validate_override_compatibility(root: ET.Element, vcpus: int | None, memory_mib: int | None) -> None:
    cpu_dependents = ["./cpu/topology", "./cpu/numa", "cputune", "vcpus", "numatune"]
    memory_dependents = ["maxMemory", "./cpu/numa", "numatune", "./devices/memory"]
    vcpu = root.find("vcpu")
    if vcpus is not None and ((vcpu is not None and vcpu.get("cpuset")) or any(root.find(path) is not None for path in cpu_dependents)):
        raise LifecycleError(
            "unsupported_override",
            "vCPU override is unsupported when topology, pinning, NUMA, or per-vCPU configuration is present",
        )
    if memory_mib is not None and any(root.find(path) is not None for path in memory_dependents):
        raise LifecycleError(
            "unsupported_override",
            "memory override is unsupported when maximum memory, NUMA, or memory devices are configured",
        )


@dataclass(frozen=True)
class DomainSpec:
    name: str
    uuid: str
    disk: Path
    nvram: Path | None
    xml: str
    interface_count: int

    @classmethod
    def from_xml(cls, xml: str) -> "DomainSpec":
        try:
            root = ET.fromstring(xml)
        except ET.ParseError as exc:
            raise LifecycleError("invalid_domain_xml", "libvirt returned malformed domain XML") from exc
        name = (root.findtext("name") or "").strip()
        domain_uuid = (root.findtext("uuid") or "").strip()
        if not name or not domain_uuid:
            raise LifecycleError("unsupported_domain", "domain XML must contain a name and UUID")
        devices = root.find("devices")
        if devices is None:
            raise LifecycleError("unsupported_domain", "domain has no devices section")
        if any(root.find(f"./os/{tag}") is not None for tag in ("kernel", "initrd", "cmdline", "dtb", "acpi")):
            raise LifecycleError("unsupported_domain", "direct host boot artifacts are unsupported")
        _validate_devices(devices)
        writable = []
        for disk in devices.findall("disk"):
            if disk.find("shareable") is not None:
                raise LifecycleError("unsupported_domain", "shareable disks are unsupported")
            if disk.get("type") != "file":
                raise LifecycleError("unsupported_domain", "only file-backed disk devices are supported")
            if disk.get("device", "disk") != "disk" or disk.find("readonly") is not None:
                continue
            driver = disk.find("driver")
            source = disk.find("source")
            if driver is None or driver.get("type") != "qcow2" or source is None or not source.get("file"):
                raise LifecycleError("unsupported_domain", "the writable disk must be a file-backed QCOW2 image")
            writable.append(Path(source.get("file")))
        if len(writable) != 1:
            raise LifecycleError("unsupported_domain", "exactly one writable QCOW2 disk is required")
        nvram = _nvram_path(root)
        return cls(name, domain_uuid, writable[0], nvram, xml, len(devices.findall("interface")))


def _positive_override(value: int | None, field: str) -> None:
    if value is not None and (isinstance(value, bool) or not isinstance(value, int) or value <= 0):
        raise LifecycleError("invalid_argument", f"{field} must be a positive integer")


def validate_overrides(vcpus: int | None, memory_mib: int | None) -> None:
    """Validate public clone sizing before any mutation side effects."""
    _positive_override(vcpus, "vcpus")
    _positive_override(memory_mib, "memory_mib")


def sanitize_clone_xml(
    spec: DomainSpec,
    name: str,
    uuid: str,
    disk: Path,
    nvram: Path | None,
    macs: list[str],
    vcpus: int | None = None,
    memory_mib: int | None = None,
) -> str:
    """Return inactive XML with owned storage and source identity removed."""
    validate_overrides(vcpus, memory_mib)
    root = copy.deepcopy(ET.fromstring(spec.xml))
    _validate_override_compatibility(root, vcpus, memory_mib)
    root.find("name").text = name
    root.find("uuid").text = uuid
    for tag in ("genid", "seclabel"):
        for element in list(root.findall(tag)):
            root.remove(element)
    for entry in root.findall("./sysinfo/system/entry"):
        if entry.get("name") == "uuid":
            entry.text = uuid
    devices = root.find("devices")
    writable_seen = False
    for element in list(devices.findall("disk")):
        if element.get("device", "disk") != "disk" or element.find("readonly") is not None:
            devices.remove(element)
            continue
        source = element.find("source")
        if not writable_seen:
            source.attrib.clear()
            source.set("file", str(disk))
            for identity in ("serial", "wwn"):
                child = element.find(identity)
                if child is not None:
                    element.remove(child)
            writable_seen = True
        else:
            devices.remove(element)
    rewrite_nvram(root, nvram)
    interfaces = devices.findall("interface")
    if len(macs) != len(interfaces):
        raise LifecycleError("invalid_argument", "one fresh MAC is required for each interface")
    for interface, mac in zip(interfaces, macs):
        mac_element = interface.find("mac")
        if mac_element is None:
            mac_element = ET.SubElement(interface, "mac")
        mac_element.set("address", mac)
        for target in list(interface.findall("target")):
            interface.remove(target)
        source = interface.find("source")
        if source is not None:
            source.attrib.pop("portid", None)
        for forwarding in list(interface.findall("portForward")):
            interface.remove(forwarding)
    for channel in devices.findall("channel"):
        for source in list(channel.findall("source")):
            if source.get("path"):
                channel.remove(source)
    for tag in ("serial", "console"):
        for device in devices.findall(tag):
            for source in list(device.findall("source")):
                if source.get("path"):
                    device.remove(source)
    for graphics in devices.findall("graphics"):
        for attribute in ("port", "tlsPort", "websocket", "socket"):
            graphics.attrib.pop(attribute, None)
        for listen in list(graphics.findall("listen")):
            if listen.get("socket"):
                graphics.remove(listen)
    for device in list(devices):
        for alias in list(device.findall("alias")):
            device.remove(alias)
    if vcpus is not None:
        vcpu = root.find("vcpu")
        if vcpu is None:
            vcpu = ET.SubElement(root, "vcpu")
        vcpu.text = str(vcpus)
        vcpu.set("current", str(vcpus))
    if memory_mib is not None:
        kib = str(memory_mib * 1024)
        for tag in ("memory", "currentMemory"):
            element = root.find(tag)
            if element is None:
                element = ET.SubElement(root, tag)
            element.set("unit", "KiB")
            element.text = kib
    return ET.tostring(root, encoding="unicode")
