from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
import os
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from mcp import Client, StdioServerParameters

from libvirt_mcp import LifecycleError
from libvirt_mcp.server import create_server, default_state_dir


ROOT = Path(__file__).resolve().parents[1]


class FakeLifecycle:
    def __init__(self):
        self.calls: list[tuple[str, tuple, dict]] = []
        self.slow_entered = threading.Event()
        self.slow_release = threading.Event()

    def _success(self, method: str, *args, **kwargs):
        self.calls.append((method, args, kwargs))
        return {"operation": method, "args": list(args), "kwargs": kwargs}

    def host_info(self):
        return self._success("host_info")

    def template_list(self):
        return self._success("template_list")

    def template_publish(self, source_vm, name, version):
        return self._success("template_publish", source_vm, name, version)

    def template_remove(self, name, version):
        self.calls.append(("template_remove", (name, version), {}))
        raise LifecycleError("template_in_use", "template has dependents", {"vms": ["work-a"]})

    def vm_list(self):
        return self._success("vm_list")

    def vm_inspect(self, name):
        return self._success("vm_inspect", name)

    def vm_create(self, name, template, version, vcpus=None, memory_mib=None):
        return self._success("vm_create", name, template, version, vcpus, memory_mib)

    def vm_start(self, name):
        return self._success("vm_start", name)

    def vm_shutdown(self, name, timeout_seconds=60):
        return self._success("vm_shutdown", name, timeout_seconds)

    def vm_force_stop(self, name):
        return self._success("vm_force_stop", name)

    def vm_delete(self, name):
        return self._success("vm_delete", name)

    def snapshot_list(self, name):
        return self._success("snapshot_list", name)

    def snapshot_create(self, name, snapshot, description=""):
        return self._success("snapshot_create", name, snapshot, description)

    def snapshot_restore(self, name, snapshot):
        self.calls.append(("snapshot_restore", (name, snapshot), {}))
        if snapshot == "slow":
            self.slow_entered.set()
            self.slow_release.wait(timeout=2)
        return {"name": name, "restored_snapshot": snapshot}


class MCPServerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.lifecycle = FakeLifecycle()

    @asynccontextmanager
    async def client(self):
        async with Client(create_server(self.lifecycle)) as client:
            yield client

    async def test_discovers_every_lifecycle_tool_with_typed_schemas(self):
        async with self.client() as client:
            result = await client.list_tools()
        tools = {tool.name: tool for tool in result.tools}
        self.assertEqual(
            set(tools),
            {
                "host_info",
                "template_list",
                "template_publish",
                "template_remove",
                "vm_list",
                "vm_inspect",
                "vm_create",
                "vm_start",
                "vm_shutdown",
                "vm_force_stop",
                "vm_delete",
                "snapshot_list",
                "snapshot_create",
                "snapshot_restore",
            },
        )
        for tool in tools.values():
            self.assertIs(tool.input_schema["additionalProperties"], False, tool.name)
        self.assertEqual(tools["snapshot_create"].input_schema["required"], ["name", "snapshot"])
        timeout_schema = tools["vm_shutdown"].input_schema["properties"]["timeout_seconds"]
        self.assertEqual(timeout_schema["minimum"], 0)
        self.assertEqual(timeout_schema["maximum"], 300)

    async def test_success_is_machine_readable_and_preserves_arguments(self):
        async with self.client() as client:
            result = await client.call_tool(
                "snapshot_create",
                {"name": "work-a", "snapshot": "base", "description": "clean install"},
            )
        self.assertFalse(result.is_error)
        self.assertEqual(
            result.structured_content,
            {
                "operation": "snapshot_create",
                "args": ["work-a", "base", "clean install"],
                "kwargs": {},
            },
        )

    async def test_schema_rejection_happens_before_lifecycle_mutation(self):
        async with self.client() as client:
            result = await client.call_tool(
                "vm_create",
                {"name": "work-a", "template": "ubuntu", "version": "1", "vcpus": "2"},
            )
        self.assertTrue(result.is_error)
        self.assertEqual(self.lifecycle.calls, [])

    async def test_unknown_argument_is_rejected_before_lifecycle_mutation(self):
        async with self.client() as client:
            result = await client.call_tool(
                "vm_shutdown",
                {"name": "work-a", "timeout_second": 0},
            )
        self.assertTrue(result.is_error)
        self.assertEqual(self.lifecycle.calls, [])

    async def test_lifecycle_error_uses_error_result_with_complete_structure(self):
        async with self.client() as client:
            result = await client.call_tool("template_remove", {"name": "ubuntu", "version": "1"})
        self.assertTrue(result.is_error)
        self.assertEqual(
            result.structured_content,
            {
                "code": "template_in_use",
                "message": "template has dependents",
                "details": {"vms": ["work-a"]},
            },
        )
        self.assertEqual(json.loads(result.content[0].text), result.structured_content)

    async def test_blocking_lifecycle_call_does_not_block_other_requests(self):
        async with self.client() as client:
            started = time.monotonic()
            slow = asyncio.create_task(
                client.call_tool("snapshot_restore", {"name": "work-a", "snapshot": "slow"})
            )
            entered = await asyncio.to_thread(self.lifecycle.slow_entered.wait, 1)
            self.assertTrue(entered)
            try:
                quick = await asyncio.wait_for(client.call_tool("template_list", {}), timeout=0.5)
                self.assertFalse(quick.is_error)
                self.assertLess(time.monotonic() - started, 0.75)
            finally:
                self.lifecycle.slow_release.set()
            self.assertFalse((await slow).is_error)

    async def test_subprocess_stdio_initializes_and_lists_tools_with_fake_core(self):
        launcher = textwrap.dedent(
            """
            from libvirt_mcp.server import create_server

            class FakeLifecycle:
                def __getattr__(self, name):
                    return lambda *args, **kwargs: {"operation": name}

            create_server(FakeLifecycle()).run()
            """
        )
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "fake_server.py"
            fixture.write_text(launcher, encoding="utf-8")
            env = dict(os.environ)
            env["PYTHONPATH"] = str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")
            parameters = StdioServerParameters(
                command=sys.executable,
                args=[str(fixture)],
                env=env,
                cwd=str(ROOT),
            )
            async with Client(parameters) as client:
                tools = await client.list_tools()
        self.assertIn("vm_create", {tool.name for tool in tools.tools})


class StateDirectoryTests(unittest.TestCase):
    def test_default_state_directory_uses_xdg_data_home(self):
        with patch.dict(os.environ, {"XDG_DATA_HOME": "/tmp/xdg-data"}, clear=False):
            self.assertEqual(default_state_dir(), Path("/tmp/xdg-data/libvirt-toolkit"))

    def test_default_state_directory_falls_back_to_local_share(self):
        with patch.dict(os.environ, {}, clear=True), patch("pathlib.Path.home", return_value=Path("/home/tester")):
            self.assertEqual(default_state_dir(), Path("/home/tester/.local/share/libvirt-toolkit"))


if __name__ == "__main__":
    unittest.main()
