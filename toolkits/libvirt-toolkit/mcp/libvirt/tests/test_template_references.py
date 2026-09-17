from __future__ import annotations

import re
import unittest
from pathlib import Path


REFERENCES = Path(__file__).resolve().parents[3] / "skills" / "dotknewt-libvirt-vms" / "references"
CASES = {
    "ubuntu-template.md": {"ssh.service", "ssh.socket"},
    "debian-template.md": {"ssh.service", "ssh.socket"},
    "cachyos-template.md": {"sshd.service"},
}
HOSTKEY_UNIT = "libvirt-toolkit-firstboot-hostkeys.service"


def _heredoc(text: str, destination: str) -> str:
    match = re.search(
        rf"tee {re.escape(destination)} [^\n]*<<'EOF'\n(.*?)\nEOF",
        text,
        flags=re.DOTALL,
    )
    if match is None:
        raise AssertionError(f"missing documented heredoc for {destination}")
    return match.group(1)


def _unit_values(unit: str, key: str) -> set[str]:
    values: set[str] = set()
    for line in unit.splitlines():
        if line.startswith(key + "="):
            values.update(line.split("=", 1)[1].split())
    return values


def _has_path(graph: dict[str, set[str]], start: str, target: str) -> bool:
    pending = [start]
    visited: set[str] = set()
    while pending:
        node = pending.pop()
        if node == target:
            return True
        if node in visited:
            continue
        visited.add(node)
        pending.extend(graph.get(node, ()))
    return False


class PreparedTemplateReferenceTests(unittest.TestCase):
    def test_effective_policy_requires_public_key_authentication(self):
        for name in CASES:
            with self.subTest(template=name):
                text = (REFERENCES / name).read_text(encoding="utf-8")
                self.assertIn("# pubkeyauthentication yes", text)

    def test_hostkey_service_is_required_by_each_documented_ssh_activation_path_without_cycle(self):
        for name, activation_units in CASES.items():
            with self.subTest(template=name):
                text = (REFERENCES / name).read_text(encoding="utf-8")
                service = _heredoc(
                    text,
                    "/etc/systemd/system/libvirt-toolkit-firstboot-hostkeys.service",
                )
                drop_in = _heredoc(text, '"/etc/systemd/system/$unit.d/libvirt-toolkit-firstboot-hostkeys.conf"')

                self.assertIn("DefaultDependencies=no", service)
                self.assertEqual({"local-fs.target"}, _unit_values(service, "Requires"))
                self.assertIn("local-fs.target", _unit_values(service, "After"))
                self.assertNotIn("WantedBy=multi-user.target", service)
                self.assertEqual({HOSTKEY_UNIT}, _unit_values(drop_in, "Requires"))
                self.assertEqual({HOSTKEY_UNIT}, _unit_values(drop_in, "After"))

                assignment = re.search(r"SSH_ACTIVATION_UNITS='([^']+)'", text)
                self.assertIsNotNone(assignment)
                documented_units = set(assignment.group(1).split())
                self.assertEqual(activation_units, documented_units)

                # Model systemd's relevant default target ordering plus the
                # documented custom edges. A normal service defaults after
                # basic.target; a socket defaults before sockets.target.
                graph: dict[str, set[str]] = {
                    "local-fs.target": {HOSTKEY_UNIT},
                    "sockets.target": {"basic.target"},
                }
                for unit in documented_units:
                    graph.setdefault(HOSTKEY_UNIT, set()).add(unit)
                    if unit.endswith(".socket"):
                        graph.setdefault(unit, set()).add("sockets.target")
                    else:
                        graph.setdefault("basic.target", set()).add(unit)

                for unit in documented_units:
                    self.assertTrue(_has_path(graph, HOSTKEY_UNIT, unit))
                for node in graph:
                    self.assertFalse(
                        any(next_node == node or _has_path(graph, next_node, node) for next_node in graph[node]),
                        f"documented ordering cycle from {node} in {name}",
                    )


if __name__ == "__main__":
    unittest.main()
