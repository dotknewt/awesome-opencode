"""Strict, narrow MCP interface for the bundled naming workflow."""
import inspect
import json
from collections.abc import Mapping
from typing import Annotated

from mcp.server import MCPServer
from mcp.types import CallToolResult, TextContent, ToolAnnotations
from pydantic import Field

from .cleanup import Cleanup, CleanupError

Name = Annotated[str, Field(strict=True)]
Confirmation = Annotated[bool, Field(strict=True)]


def _result(payload, is_error=False):
    return CallToolResult(content=[TextContent(type='text', text=json.dumps(payload))],
                          structuredContent=payload, isError=is_error)


class _StrictArguments:
    def __init__(self):
        self.allowed = {}

    def register(self, server, function, *, readonly):
        self.allowed[function.__name__] = frozenset(inspect.signature(function).parameters)
        server.add_tool(function, annotations=ToolAnnotations(
            readOnlyHint=readonly, destructiveHint=not readonly,
            idempotentHint=readonly, openWorldHint=True))

    async def __call__(self, context, call_next):
        if context.method == 'tools/call' and isinstance(context.params, Mapping):
            name = context.params.get('name')
            arguments = context.params.get('arguments') or {}
            if isinstance(name, str) and name in self.allowed and isinstance(arguments, Mapping):
                extra = sorted(set(arguments) - self.allowed[name])
                if extra:
                    return _result({'code': 'invalid_arguments',
                                    'message': 'Tool request contains unknown arguments.',
                                    'details': {'tool': name, 'fields': extra}}, True)
        result = await call_next(context)
        if context.method == 'tools/list' and isinstance(result, Mapping):
            result = {**result, 'tools': [
                {**tool, 'inputSchema': {**tool['inputSchema'], 'additionalProperties': False}}
                for tool in result.get('tools', [])]}
        return result


def _call(cleanup, method, *args):
    try:
        return _result(getattr(cleanup, method)(*args))
    except CleanupError as error:
        return _result({'code': error.code, 'message': error.message, 'details': error.details}, True)
    except Exception:
        return _result({'code': 'internal_error', 'message': 'Unexpected cleanup adapter failure.',
                        'details': {'operation': method}}, True)


def create_server(cleanup: Cleanup) -> MCPServer:
    strict = _StrictArguments()
    server = MCPServer('ollama-toolkit', version='0.1.0', middleware=[strict])

    def list_models() -> CallToolResult:
        """Inspect Ollama model names and observed list IDs."""
        return _call(cleanup, 'list_models')

    def suggest_names() -> CallToolResult:
        """Suggest names heuristically without modifying models."""
        return _call(cleanup, 'suggest_names')

    def rename_model(source: Name, destination: Name, confirmed: Confirmation = False) -> CallToolResult:
        """Copy, verify listed IDs, then remove source; requires exact-pair approval.

        confirmed is agent acknowledgement, not proof of human authorization.
        External writers are not serialized; no atomicity or rollback is promised.
        """
        return _call(cleanup, 'rename_model', source, destination, confirmed)

    strict.register(server, list_models, readonly=True)
    strict.register(server, suggest_names, readonly=True)
    strict.register(server, rename_model, readonly=False)
    return server


def main():
    create_server(Cleanup()).run('stdio')
