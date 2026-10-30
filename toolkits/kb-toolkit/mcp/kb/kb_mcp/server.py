"""Read-only low-level MCP surface and bounded stdio transport.

The SDK's unbounded line reader is deliberately not used: framing, JSON depth,
and reflected IDs are checked before SDK parsing. No request opens source files.
"""
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import hmac
import json
import logging
import os
import secrets
import sys

import anyio
import mcp_types as t
from mcp.server.lowlevel import Server
from mcp.shared.message import SessionMessage

from .config import KBError, load_config
from .registry import Registry, load_registry

PAGE_CAP = 256 * 1024
READ_CAP = 16 * 1024 * 1024
FRAME_CAP = 64 * 1024
SAFE_MESSAGE = 'KB request failed.'


def _encoded(value):
    return json.dumps(value, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def _fits(result, cap):
    # Worst-case legal ID, including JSON escaping, not merely the payload size.
    return len(_encoded({'jsonrpc': '2.0', 'id': '\x00' * 128,
                         'result': result.model_dump(mode='json', by_alias=True, exclude_none=True)})) <= cap


def _tool_result(value, error=False):
    return t.CallToolResult(content=[t.TextContent(type='text', text=_encoded(value).decode())],
                            structuredContent=value, isError=error)


def _tool_error(code):
    if code not in {'invalid_request', 'not_found'}:
        code = 'internal_error'
    return _tool_result({'error': code, 'message': SAFE_MESSAGE}, True)


def create_server(registry: Registry) -> Server:
    """Create one isolated snapshot's MCP handlers; cursors never cross instances."""
    cursor_key = secrets.token_bytes(32)

    def cursor(offset):
        value = str(offset)
        return value + '.' + hmac.new(cursor_key, value.encode(), hashlib.sha256).hexdigest()

    def offset_from_cursor(value):
        if value is None:
            return 0
        if type(value) is not str or not value.isascii() or len(value) > 128:
            raise KBError('invalid_request')
        number, sep, signature = value.partition('.')
        if not sep or not number.isdecimal() or len(number) > 5 or not 1 <= int(number) <= 10000:
            raise KBError('invalid_request')
        if not hmac.compare_digest(value, cursor(int(number))):
            raise KBError('invalid_request')
        return int(number)

    async def list_resources(ctx, params):
        try:
            offset = offset_from_cursor(params.cursor if params else None)
            page = registry.list_records(offset=offset)
            resources = [t.Resource(uri=r['uri'], name=r['title'], mimeType='text/markdown') for r in page['records']]
            next_offset = page['next_offset']
            while resources:
                result = t.ListResourcesResult(resources=resources, nextCursor=cursor(next_offset) if next_offset is not None else None)
                if _fits(result, PAGE_CAP):
                    return result
                resources.pop()
                next_offset = offset + len(resources)
            result = t.ListResourcesResult(resources=[])
            if not page['records']:
                return result
        except Exception:
            pass
        raise ValueError(SAFE_MESSAGE)

    async def read_resource(ctx, params):
        try:
            record = registry.read(params.uri)
            result = t.ReadResourceResult(contents=[t.TextResourceContents(uri=record['uri'], text=record['content'], mimeType='text/markdown')])
            if _fits(result, READ_CAP):
                return result
        except Exception:
            pass
        raise ValueError(SAFE_MESSAGE)

    pagination = {'offset': {'type': 'integer', 'minimum': 0, 'default': 0},
                  'limit': {'type': 'integer', 'minimum': 1, 'maximum': 100, 'default': 20}}
    schemas = {
        'kb_list': {'type': 'object', 'properties': pagination, 'additionalProperties': False},
        'kb_search': {'type': 'object', 'properties': {**pagination, 'query': {'type': 'string', 'minLength': 1, 'maxLength': 256}}, 'required': ['query'], 'additionalProperties': False},
        'kb_read': {'type': 'object', 'properties': {'uri': {'type': 'string', 'minLength': 1, 'maxLength': 1024}}, 'required': ['uri'], 'additionalProperties': False},
    }

    async def list_tools(ctx, params):
        return t.ListToolsResult(tools=[t.Tool(name=name, description=description, inputSchema=schemas[name],
            annotations=t.ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False))
            for name, description in [('kb_list', 'List published snapshot metadata.'),
                                      ('kb_search', 'Literal case-insensitive search of published snapshot text.'),
                                      ('kb_read', 'Read original published Markdown by exact logical URI.')]])

    async def call_tool(ctx, params):
        try:
            name = params.name
            args = params.arguments if params.arguments is not None else {}
            if name not in schemas or type(args) is not dict or set(args) - set(schemas[name]['properties']):
                raise KBError('invalid_request')
            if not set(schemas[name].get('required', ())) <= set(args):
                raise KBError('invalid_request')
            if name == 'kb_read':
                value = registry.read(**args)
            elif name == 'kb_search':
                value = registry.search(**args)
            else:
                value = registry.list_records(**args)
            result = _tool_result(value)
            if name == 'kb_read':
                if not _fits(result, READ_CAP):
                    raise KBError('invalid_request')
            else:
                while not _fits(result, PAGE_CAP):
                    if not value['records']:
                        raise KBError('invalid_request')
                    value['records'].pop()
                    if not value['records']:
                        raise KBError('invalid_request')
                    value['next_offset'] = args.get('offset', 0) + len(value['records'])
                    result = _tool_result(value)
            return result
        except KBError as exc:
            return _tool_error(exc.code)
        except Exception:
            return _tool_error('internal_error')

    return Server('kb', on_list_resources=list_resources, on_read_resource=read_resource,
                  on_list_tools=list_tools, on_call_tool=call_tool)


def _parse_frame(raw):
    """Scan nesting before constructing JSON collections, then validate raw IDs."""
    if len(raw) > FRAME_CAP:
        raise ValueError(SAFE_MESSAGE)
    text = raw.decode('utf-8', errors='strict')
    depth, quoted, escaped = 0, False, False
    for char in text:
        if quoted:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char in '[{':
            depth += 1
            if depth > 8:
                raise ValueError(SAFE_MESSAGE)
        elif char in ']}':
            depth -= 1

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(SAFE_MESSAGE)
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValueError(SAFE_MESSAGE)

    value = json.loads(text, object_pairs_hook=pairs, parse_constant=invalid_constant)
    if type(value) is not dict:
        raise ValueError(SAFE_MESSAGE)
    if 'id' in value:
        identifier = value['id']
        if not ((type(identifier) is int and -(2**63) <= identifier < 2**63) or
                (type(identifier) is str and len(identifier.encode('utf-8')) <= 128)):
            raise ValueError(SAFE_MESSAGE)
    # Check raw params before the SDK can coerce primitive values or ignore extras.
    method = value.get('method')
    if method in {'resources/list', 'resources/read', 'tools/list', 'tools/call'}:
        params = value.get('params', {})
        allowed = {'resources/list': {'cursor'}, 'resources/read': {'uri'},
                   'tools/list': set(), 'tools/call': {'name', 'arguments'}}[method]
        if type(params) is not dict or set(params) - (allowed | {'_meta'}):
            raise ValueError(SAFE_MESSAGE)
        for key in ('cursor', 'uri', 'name'):
            if key in params and type(params[key]) is not str:
                raise ValueError(SAFE_MESSAGE)
        if 'uri' in params and len(params['uri'].encode('utf-8')) > 1024:
            raise ValueError(SAFE_MESSAGE)
        if 'arguments' in params and type(params['arguments']) is not dict:
            raise ValueError(SAFE_MESSAGE)
    return t.jsonrpc_message_adapter.validate_python(value, by_name=False)


async def _serve(server, stdin, stdout):
    incoming, reads = anyio.create_memory_object_stream(0)

    class Output:
        async def send(self, message):
            value = message.message.model_dump(mode='json', by_alias=True, exclude_unset=True)
            if 'error' in value:
                value['error'] = {'code': -32603, 'message': SAFE_MESSAGE}
            result = value.get('result', {})
            cap = READ_CAP if 'contents' in result or 'content' in result.get('structuredContent', {}) else PAGE_CAP
            raw = _encoded(value)
            if len(raw) > cap:
                raw = _encoded({'jsonrpc': '2.0', 'id': value.get('id'), 'error': {'code': -32603, 'message': SAFE_MESSAGE}})
            await anyio.to_thread.run_sync(stdout.write, raw + b'\n')
            await anyio.to_thread.run_sync(stdout.flush)

        async def aclose(self):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

    async def receive():
        async with incoming:
            while True:
                raw = await anyio.to_thread.run_sync(stdin.readline, FRAME_CAP + 1)
                if not raw:
                    return
                await incoming.send(SessionMessage(_parse_frame(raw)))

    async with anyio.create_task_group() as group:
        group.start_soon(receive)
        await server.run(reads, Output(), server.create_initialization_options())


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    try:
        if len(args) != 2 or args[0] != '--config' or not args[1]:
            raise ValueError(SAFE_MESSAGE)
        registry = load_registry(load_config(args[1]))
        server = create_server(registry)
        stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
        # Framework loggers and exception diagnostics must not emit input values.
        old_disable = logging.root.manager.disable
        logging.disable(sys.maxsize)
        try:
            with open(os.devnull, 'w') as sink, redirect_stderr(sink), redirect_stdout(sink):
                anyio.run(_serve, server, stdin, stdout)
        finally:
            logging.disable(old_disable)
        return 0
    except Exception:
        sys.stderr.write('KB startup or transport failed.\n')
        return 1
