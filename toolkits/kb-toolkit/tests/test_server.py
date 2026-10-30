"""Real pipe/SDK tests: fixtures are synthetic and owned by each test."""
from contextlib import asynccontextmanager
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import anyio
import mcp_types as t
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ASSET = Path(__file__).resolve().parents[1] / 'mcp' / 'kb'
sys.path.insert(0, str(ASSET))
from kb_mcp.server import create_server

CASES = ['intel://entities/example', 'intel://INDEX/Mixed',
         'intel://entities/a%2Fb', 'intel://entities/a%2fb',
         'intel://entities/a%41', 'intel://entities', 'intel://entities/',
         'intel://entities/a?x=1#fragment', 'intel://entities/日本語/é',
         'intel://例え/日本語']
SECRET = 'SYNTHETIC_SECRET_DO_NOT_ECHO'


class ServerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='kb-protocol-', dir='/tmp/opencode')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)

    def fixture(self, name='one', uris=None, prefix='intel://', key='intel_uri', body='Hello WORLD\n'):
        root = self.base / name
        root.mkdir()
        uris = uris or CASES
        contents = {}
        rows = []
        for i, uri in enumerate(uris):
            text = f'---\n{key}: {uri}\ntitle: Example\ntype: entity\n---\n{body}'
            (root / f'{i}.md').write_text(text, encoding='utf-8')
            contents[uri] = text
            rows.append(f'| `{uri}` | [Record]({i}.md) |\n')
        (root / 'index.md').write_text('## Published-record navigation\n\n| Identifier | Record |\n| --- | --- |\n' + ''.join(rows), encoding='utf-8')
        (root / 'private.md').write_text(SECRET)
        config = root / 'config.json'
        config.write_text(json.dumps(dict(root=str(root), uri_prefix=prefix, uri_key=key,
                                         index_path='index.md', navigation_heading='Published-record navigation')))
        return config, contents

    @asynccontextmanager
    async def session(self, config):
        with tempfile.TemporaryFile(mode='w+') as errors:
            params = StdioServerParameters(command=sys.executable, args=[str(ASSET / 'server.py'), '--config', str(config)])
            with anyio.fail_after(30):
                async with stdio_client(params, errlog=errors) as streams:
                    async with ClientSession(*streams) as session:
                        await session.initialize()
                        yield session
            errors.seek(0)
            self.assertEqual(errors.read(), '')

    def run_async(self, function):
        anyio.run(function)

    def test_independent_stdio_exact_uris_and_read_only_surface(self):
        first, originals = self.fixture()
        second, other = self.fixture('two', ['INTEL://INDEX/Mixed'], 'INTEL://', 'record_id')
        before = {p: p.read_bytes() for p in self.base.rglob('*') if p.is_file()}
        async def check():
            async with self.session(first) as a, self.session(second) as b:
                tools = (await a.list_tools()).tools
                self.assertEqual({t.name for t in tools}, {'kb_list', 'kb_search', 'kb_read'})
                for tool in tools:
                    self.assertTrue(tool.annotations.read_only_hint)
                    self.assertTrue(tool.annotations.idempotent_hint)
                    self.assertFalse(tool.annotations.destructive_hint)
                    self.assertFalse(tool.annotations.open_world_hint)
                    self.assertFalse(tool.input_schema['additionalProperties'])
                self.assertEqual([r.uri for r in (await a.list_resources()).resources], sorted(originals))
                self.assertEqual([r.uri for r in (await b.list_resources()).resources], list(other))
                for session, records in ((a, originals), (b, other)):
                    page = (await session.call_tool('kb_list', {})).structured_content
                    self.assertEqual([r['uri'] for r in page['records']], sorted(records))
                    for uri, text in records.items():
                        result = await session.read_resource(uri)
                        self.assertEqual(result.contents[0].uri, uri)
                        self.assertEqual(result.contents[0].mime_type, 'text/markdown')
                        self.assertEqual(result.contents[0].text, text)
                        tool = (await session.call_tool('kb_read', {'uri': uri})).structured_content
                        self.assertEqual(tool['content'], text)
                        self.assertEqual(tool['sha256'], hashlib.sha256(text.encode()).hexdigest())
                    found = (await session.call_tool('kb_search', {'query': 'world', 'limit': 1})).structured_content
                    self.assertEqual(len(found['records']), 1)
                    self.assertIn('WORLD', found['records'][0]['snippet'])
                for uri in ['INTEL://INDEX/Mixed', 'intel://entities/a/b', 'intel://entities/aA', 'intel://Entities', 'intel://private', '../private.md']:
                    self.assertTrue((await a.call_tool('kb_read', {'uri': uri})).is_error)
                    with self.assertRaises(Exception):
                        await a.read_resource(uri)
                self.assertTrue((await b.call_tool('kb_read', {'uri': CASES[0]})).is_error)
        self.run_async(check)
        self.assertEqual({p: p.read_bytes() for p in before}, before)

    def test_strict_tool_arguments_and_resource_cursors(self):
        config, _ = self.fixture(uris=[f'intel://entity/{i:03}' for i in range(105)])
        other, _ = self.fixture('two', ['intel://other'])
        async def check():
            async with self.session(config) as session, self.session(other) as second:
                for name, args in [('kb_list', {'extra': SECRET}), ('unknown', {}),
                                   ('kb_read', {}), ('kb_read', {'uri': 'x' * 1025}),
                                   ('kb_search', {'query': ''}), ('kb_search', {'query': 'a' * 257})] + [
                    (name, {field: value}) for name, field in [('kb_list', 'offset'), ('kb_list', 'limit'), ('kb_read', 'uri'), ('kb_search', 'query')]
                    for value in [True, None, 1.5, [], {}]
                ] + [('kb_list', {field: '1'}) for field in ['offset', 'limit']]:
                    with self.subTest(name=name, args=args):
                        result = await session.call_tool(name, args)
                        self.assertTrue(result.is_error)
                        self.assertEqual(result.structured_content['error'], 'invalid_request')
                        self.assertNotIn(SECRET, result.model_dump_json())
                page = await session.list_resources()
                self.assertEqual(len(page.resources), 20)
                cursor = page.next_cursor
                self.assertIsNotNone(cursor)
                following = await session.list_resources(params=t.PaginatedRequestParams(cursor=cursor))
                self.assertEqual(following.resources[0].uri, 'intel://entity/020')
                for bad in ['', 'bad', 'x' * 129, 'é', cursor + 'x']:
                    with self.assertRaises(Exception):
                        await session.list_resources(params=t.PaginatedRequestParams(cursor=bad))
                with self.assertRaises(Exception):
                    await second.list_resources(params=t.PaginatedRequestParams(cursor=cursor))
                for limit in [0, 101, -1]:
                    self.assertTrue((await session.call_tool('kb_list', {'limit': limit})).is_error)
        self.run_async(check)

    def wire(self, config, frames, command=None):
        init = {'jsonrpc': '2.0', 'id': 0, 'method': 'initialize', 'params': {'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'test', 'version': '1'}}}
        ready = {'jsonrpc': '2.0', 'method': 'notifications/initialized'}
        data = b''.join(json.dumps(x).encode() + b'\n' for x in [init, ready]) + frames
        return subprocess.run(command or [sys.executable, str(ASSET / 'server.py'), '--config', str(config)], input=data, capture_output=True, timeout=30)

    def test_ingress_bounds_and_framework_errors_never_echo(self):
        config, _ = self.fixture()
        bad_frames = [b'{' + SECRET.encode(), b'[' * 9 + b'0' + b']' * 9,
                      b' ' * 65537 + SECRET.encode()]
        for value in [True, None, 1.5, 2**63, -(2**63)-1, [], {}, SECRET * 10, 'é' * 65, '\ud800']:
            bad_frames.append(json.dumps({'jsonrpc': '2.0', 'id': value, 'method': SECRET}).encode())
        bad_frames += [json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'resources/read', 'params': {'uri': value}}).encode() for value in [None, True, 12, 'x' * 1025]]
        bad_frames += [json.dumps({'jsonrpc': '2.0', 'id': 3, 'method': 'resources/list', 'params': {'cursor': value}}).encode() for value in [True, 12, [], {}]]
        bad_frames += [json.dumps({'jsonrpc': '2.0', 'id': 4, 'method': 'resources/read', 'params': {'uri': CASES[0], 'extra': SECRET}}).encode()]
        bad_frames += [json.dumps({'jsonrpc': '2.0', 'id': 5, 'method': 'tools/call', 'params': {'name': 'kb_list', 'arguments': value}}).encode() for value in [None, True, '1', [], 1.5]]
        for frame in bad_frames:
            result = self.wire(config, frame + b'\n')
            self.assertNotIn(SECRET.encode(), result.stdout + result.stderr)
            self.assertNotIn(str(self.base).encode(), result.stdout + result.stderr)
            self.assertNotIn(b'Traceback', result.stderr)
            responses = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertFalse(any('contents' in r.get('result', {}) for r in responses))
            self.assertTrue(result.returncode != 0 or any('error' in r for r in responses))

    def test_safe_startup_failures(self):
        missing = self.base / SECRET
        malformed = self.base / 'bad.json'
        malformed.write_text('{"root": "' + SECRET + '", "extra": 0}')
        for args in [[], ['--config', str(missing)], ['--config', str(malformed)], ['--unexpected', SECRET]]:
            result = subprocess.run([sys.executable, str(ASSET / 'server.py')] + args, capture_output=True, timeout=15)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, b'')
            self.assertNotIn(SECRET.encode(), result.stderr)
            self.assertNotIn(str(self.base).encode(), result.stderr)
            self.assertLessEqual(len(result.stderr), 1024)

    def test_actual_envelope_caps_escape_heavy_reads_and_unicode_pages(self):
        config, records = self.fixture(uris=['intel://large'], body=('\x01' * 16000 + '\n') * 64)
        requests = [{'jsonrpc': '2.0', 'id': '\x00' * 128, 'method': 'tools/call', 'params': {'name': 'kb_read', 'arguments': {'uri': 'intel://large'}}},
                    {'jsonrpc': '2.0', 'id': 2, 'method': 'resources/read', 'params': {'uri': 'intel://large'}}]
        result = self.wire(config, b''.join(json.dumps(x).encode() + b'\n' for x in requests))
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        answers = {json.loads(line)['id']: (line, json.loads(line)) for line in lines}
        for identifier in ['\x00' * 128, 2]:
            self.assertLessEqual(len(answers[identifier][0]), 16 * 1024 * 1024)
        self.assertEqual(answers['\x00' * 128][1]['result']['structuredContent']['content'], records['intel://large'])
        self.assertEqual(answers[2][1]['result']['contents'][0]['text'], records['intel://large'])
        uris = [f'intel://entity/{i:03}/' + '日' * 320 for i in range(105)]
        config, _ = self.fixture('pages', uris)
        frames = [{'jsonrpc': '2.0', 'id': i, 'method': method, 'params': params} for i, method, params in [
            (1, 'tools/call', {'name': 'kb_list', 'arguments': {'limit': 100}}),
            (2, 'tools/call', {'name': 'kb_search', 'arguments': {'query': 'world', 'limit': 100}}),
            (3, 'resources/list', {})]]
        result = self.wire(config, b''.join(json.dumps(x).encode() + b'\n' for x in frames))
        self.assertEqual(result.returncode, 0, result.stderr)
        answers = {json.loads(line)['id']: json.loads(line) for line in result.stdout.splitlines()}
        self.assertEqual(set(answers), {0, 1, 2, 3})
        for line in result.stdout.splitlines():
            self.assertLessEqual(len(line), 256 * 1024)
        for identifier in [1, 2]:
            page = answers[identifier]['result']['structuredContent']
            self.assertGreater(len(page['records']), 0)
            self.assertLess(len(page['records']), 100)
            self.assertEqual(page['next_offset'], len(page['records']))
            self.assertEqual(page['records'][0]['uri'], uris[0])

    def test_injected_framework_exception_is_sanitized_on_both_streams(self):
        config, _ = self.fixture()
        script = f'''import sys, logging
sys.path.insert(0, {str(ASSET)!r})
import kb_mcp.server as module
from mcp.server.lowlevel import Server
async def fail(ctx, params):
    logging.error({SECRET!r})
    print({SECRET!r}, file=sys.stderr)
    print({SECRET!r})
    raise RuntimeError({SECRET!r} + {str(self.base)!r})
module.create_server = lambda registry: Server('injected', on_read_resource=fail, on_call_tool=fail)
raise SystemExit(module.main(['--config', {str(config)!r}]))
'''
        for method, params in [('resources/read', {'uri': CASES[0]}), ('tools/call', {'name': 'kb_read', 'arguments': {'uri': CASES[0]}})]:
            frame = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode() + b'\n'
            result = self.wire(config, frame, [sys.executable, '-c', script])
            self.assertEqual(result.returncode, 0)
            self.assertNotIn(SECRET.encode(), result.stdout + result.stderr)
            self.assertNotIn(str(self.base).encode(), result.stdout + result.stderr)
            answer = [json.loads(line) for line in result.stdout.splitlines() if json.loads(line).get('id') == 1]
            self.assertEqual(len(answer), 1)
            self.assertIn('error', answer[0])
            self.assertLessEqual(len(json.dumps(answer[0]).encode()), 1024)

    def test_valid_id_frame_and_depth_boundaries_reach_sdk(self):
        config, _ = self.fixture()
        for identifier in [-(2**63), 2**63-1, 'é' * 64, '\x00' * 128]:
            request = {'jsonrpc': '2.0', 'id': identifier, 'method': 'ping'}
            raw = json.dumps(request).encode()
            result = self.wire(config, raw + b' ' * (65535 - len(raw)) + b'\n')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(identifier, [json.loads(line)['id'] for line in result.stdout.splitlines()])
        request = {'jsonrpc': '2.0', 'id': 5, 'method': 'unknown', 'params': {'nested': [[[[[[0]]]]]]}}
        result = self.wire(config, json.dumps(request).encode() + b'\n')
        self.assertEqual(result.returncode, 0)
        self.assertTrue(any(json.loads(line).get('id') == 5 and 'error' in json.loads(line) for line in result.stdout.splitlines()))

    def test_error_envelope_with_maximally_escaped_id_is_bounded(self):
        config, _ = self.fixture()
        frame = {'jsonrpc': '2.0', 'id': '\x00' * 128, 'method': 'tools/call', 'params': {'name': 'kb_read', 'arguments': {'uri': 'intel://missing'}}}
        result = self.wire(config, json.dumps(frame).encode() + b'\n')
        self.assertEqual(result.returncode, 0)
        errors = [line for line in result.stdout.splitlines() if json.loads(line).get('id') == '\x00' * 128]
        self.assertEqual(len(errors), 1)
        self.assertTrue(json.loads(errors[0])['result']['isError'])
        self.assertLessEqual(len(errors[0]), 1024)

    def test_invalid_publication_uri_fails_stdio_startup(self):
        for i, uri in enumerate(['intel://', 'intel://a/%GG', 'intel://a/%', 'intel://a/white space', 'intel://a/back\\slash', 'intel://a/<tag>', 'intel://a/{x}', 'INTEL://wrong-prefix']):
            config, _ = self.fixture(str(i), [uri])
            result = subprocess.run([sys.executable, str(ASSET / 'server.py'), '--config', str(config)], input=b'', capture_output=True, timeout=15)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, b'')
            self.assertNotIn(uri.encode(), result.stderr)


if __name__ == '__main__':
    unittest.main()
