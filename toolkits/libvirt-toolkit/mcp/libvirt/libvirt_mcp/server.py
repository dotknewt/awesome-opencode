from __future__ import annotations

import argparse
import inspect
import json
import os
import sys
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from typing import Annotated, Any

from mcp.server.context import HandlerResult, ServerRequestContext
from mcp.server import MCPServer
from mcp.types import CallToolResult, TextContent
from pydantic import Field

from .errors import LifecycleError
from .lifecycle import Lifecycle


NonEmptyString = Annotated[str, Field(strict=True, min_length=1)]
PositiveInteger = Annotated[int, Field(strict=True, gt=0)]
ShutdownTimeout = Annotated[int, Field(strict=True, ge=0, le=300)]


def default_state_dir() -> Path:
    """Return the per-user managed-state root without creating it."""
    data_home = os.environ.get("XDG_DATA_HOME")
    base = Path(data_home).expanduser() if data_home else Path.home() / ".local" / "share"
    return base / "libvirt-toolkit"


def _result(payload: dict[str, Any], *, is_error: bool = False) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=json.dumps(payload, sort_keys=True))],
        structuredContent=payload,
        isError=is_error,
    )


class _StrictToolArguments:
    """Advertise and enforce closed argument objects around SDK-generated tools."""

    def __init__(self) -> None:
        self._allowed: dict[str, frozenset[str]] = {}

    def tool(self, server: MCPServer) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        def register(function: Callable[..., Any]) -> Callable[..., Any]:
            self._allowed[function.__name__] = frozenset(inspect.signature(function).parameters)
            server.add_tool(function)
            return function

        return register

    async def __call__(
        self,
        context: ServerRequestContext,
        call_next: Callable[[ServerRequestContext], Awaitable[HandlerResult]],
    ) -> HandlerResult:
        if context.method == "tools/call" and isinstance(context.params, Mapping):
            name = context.params.get("name")
            arguments = context.params.get("arguments") or {}
            if isinstance(name, str) and isinstance(arguments, Mapping) and name in self._allowed:
                extra = sorted(set(arguments) - self._allowed[name])
                if extra:
                    return _result(
                        {
                            "code": "invalid_arguments",
                            "message": "tool request contains unknown arguments",
                            "details": {"tool": name, "fields": extra},
                        },
                        is_error=True,
                    )

        result = await call_next(context)
        if context.method == "tools/list" and isinstance(result, Mapping):
            tools = []
            for item in result.get("tools", []):
                tool = dict(item)
                schema = dict(tool.get("inputSchema", {}))
                schema["additionalProperties"] = False
                tool["inputSchema"] = schema
                tools.append(tool)
            result = {**result, "tools": tools}
        return result


def _call(lifecycle: Any, method: str, *args: Any, **kwargs: Any) -> CallToolResult:
    try:
        return _result(getattr(lifecycle, method)(*args, **kwargs))
    except LifecycleError as exc:
        return _result(exc.as_dict(), is_error=True)
    except Exception as exc:
        print(f"libvirt-mcp: unexpected {method} failure: {type(exc).__name__}: {exc}", file=sys.stderr)
        return _result(
            {
                "code": "internal_error",
                "message": "unexpected lifecycle adapter failure",
                "details": {"operation": method, "type": type(exc).__name__},
            },
            is_error=True,
        )


def create_server(lifecycle: Any) -> MCPServer:
    """Create a stdio-capable MCP server around one Lifecycle-compatible object."""
    strict_arguments = _StrictToolArguments()
    server = MCPServer(
        "libvirt-toolkit",
        description="Safe host-local qemu:///session VM lifecycle management",
        version="1.0.7",
        middleware=[strict_arguments],
    )

    @strict_arguments.tool(server)
    def host_info() -> CallToolResult:
        """Inspect local libvirt host capabilities and versions."""
        return _call(lifecycle, "host_info")

    @strict_arguments.tool(server)
    def template_list() -> CallToolResult:
        """List immutable templates published into managed storage."""
        return _call(lifecycle, "template_list")

    @strict_arguments.tool(server)
    def template_publish(source_vm: NonEmptyString, name: NonEmptyString, version: NonEmptyString) -> CallToolResult:
        """Publish one powered-off local domain as an immutable template version."""
        return _call(lifecycle, "template_publish", source_vm, name, version)

    @strict_arguments.tool(server)
    def template_remove(name: NonEmptyString, version: NonEmptyString) -> CallToolResult:
        """Remove an unused managed template version."""
        return _call(lifecycle, "template_remove", name, version)

    @strict_arguments.tool(server)
    def vm_list() -> CallToolResult:
        """List local libvirt domains and identify managed working VMs."""
        return _call(lifecycle, "vm_list")

    @strict_arguments.tool(server)
    def vm_inspect(name: NonEmptyString) -> CallToolResult:
        """Inspect one local domain and its managed state."""
        return _call(lifecycle, "vm_inspect", name)

    @strict_arguments.tool(server)
    def vm_create(
        name: NonEmptyString,
        template: NonEmptyString,
        version: NonEmptyString,
        vcpus: PositiveInteger | None = None,
        memory_mib: PositiveInteger | None = None,
    ) -> CallToolResult:
        """Create a powered-off linked working VM from a managed template."""
        return _call(lifecycle, "vm_create", name, template, version, vcpus, memory_mib)

    @strict_arguments.tool(server)
    def vm_start(name: NonEmptyString) -> CallToolResult:
        """Start a managed working VM; already-running VMs are unchanged."""
        return _call(lifecycle, "vm_start", name)

    @strict_arguments.tool(server)
    def vm_shutdown(name: NonEmptyString, timeout_seconds: ShutdownTimeout = 60) -> CallToolResult:
        """Request graceful shutdown and wait at most 300 seconds without force-stop."""
        return _call(lifecycle, "vm_shutdown", name, timeout_seconds)

    @strict_arguments.tool(server)
    def vm_force_stop(name: NonEmptyString) -> CallToolResult:
        """Force-stop a managed working VM as a separate explicit operation."""
        return _call(lifecycle, "vm_force_stop", name)

    @strict_arguments.tool(server)
    def vm_delete(name: NonEmptyString) -> CallToolResult:
        """Delete a powered-off managed VM and only its owned storage."""
        return _call(lifecycle, "vm_delete", name)

    @strict_arguments.tool(server)
    def snapshot_list(name: NonEmptyString) -> CallToolResult:
        """List toolkit-managed external snapshots for a working VM."""
        return _call(lifecycle, "snapshot_list", name)

    @strict_arguments.tool(server)
    def snapshot_create(
        name: NonEmptyString,
        snapshot: NonEmptyString,
        description: str = "",
    ) -> CallToolResult:
        """Create an external snapshot of a powered-off managed VM."""
        return _call(lifecycle, "snapshot_create", name, snapshot, description)

    @strict_arguments.tool(server)
    def snapshot_restore(name: NonEmptyString, snapshot: NonEmptyString) -> CallToolResult:
        """Restore a powered-off VM onto a fresh child of a named snapshot."""
        return _call(lifecycle, "snapshot_restore", name, snapshot)

    return server


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Run the libvirt toolkit MCP server over stdio.")
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=default_state_dir(),
        help="managed state root (default: $XDG_DATA_HOME/libvirt-toolkit or ~/.local/share/libvirt-toolkit)",
    )
    args = parser.parse_args(argv)
    state_dir = args.state_dir.expanduser().absolute()
    print(f"libvirt-mcp: qemu:///session state directory: {state_dir}", file=sys.stderr)
    create_server(Lifecycle(state_dir)).run("stdio")


__all__ = ["create_server", "default_state_dir", "main"]
