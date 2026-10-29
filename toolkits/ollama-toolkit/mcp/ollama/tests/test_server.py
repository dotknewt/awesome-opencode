import json
from pathlib import Path
import sys
import unittest
from mcp import Client

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ollama_mcp.cleanup import Cleanup, CleanupError
from ollama_mcp.server import create_server


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.calls = []
        self.models = {'old:latest': 'abcdef123456'}
        self.failure = None

    def runner(self, args):
        self.calls.append(args)
        if self.failure:
            raise self.failure
        if args[0] == 'cp':
            self.models[args[2]] = self.models[args[1]]
        elif args[0] == 'rm':
            del self.models[args[1]]
        return 'NAME ID SIZE MODIFIED\n' + ''.join(
            f'{name} {identity} 1 GB now\n' for name, identity in self.models.items())

    def payload(self, result):
        self.assertEqual(json.loads(result.content[0].text), result.structured_content)
        return result.structured_content

    async def test_discovery(self):
        async with Client(create_server(Cleanup(self.runner))) as client:
            tools = {t.name: t for t in (await client.list_tools()).tools}
        self.assertEqual(set(tools), {'list_models', 'suggest_names', 'rename_model'})
        for name, tool in tools.items():
            self.assertIs(tool.input_schema['additionalProperties'], False)
            annotations = tool.annotations.model_dump(by_alias=True)
            self.assertEqual(annotations['readOnlyHint'], name != 'rename_model')
            self.assertEqual(annotations['destructiveHint'], name == 'rename_model')
            self.assertIs(annotations['openWorldHint'], True)
        schema = tools['rename_model'].input_schema
        self.assertEqual(schema['required'], ['source', 'destination'])
        for key in ('source', 'destination'):
            self.assertEqual(schema['properties'][key]['type'], 'string')
        self.assertEqual(schema['properties']['confirmed']['type'], 'boolean')
        self.assertIs(schema['properties']['confirmed']['default'], False)

    async def test_success_payloads(self):
        async with Client(create_server(Cleanup(self.runner))) as client:
            for name in ('list_models', 'suggest_names'):
                result = await client.call_tool(name, {})
                self.assertFalse(result.is_error)
                self.payload(result)
            result = await client.call_tool('rename_model', {
                'source': 'old:latest', 'destination': 'new:latest', 'confirmed': True})
        self.assertFalse(result.is_error)
        self.assertEqual(self.payload(result)['status'], 'remove_command_succeeded')
        self.assertEqual(self.calls[-4:], [['list'], ['cp', 'old:latest', 'new:latest'],
                                         ['list'], ['rm', 'old:latest']])

    async def test_rejected_arguments_never_reach_runner(self):
        valid = {'source': 'old:latest', 'destination': 'new:latest', 'confirmed': True}
        cases = [('list_models', {'extra': 1}), ('suggest_names', {'extra': 1}),
                 ('rename_model', {**valid, 'extra': 1}), ('rename_model', {}),
                 ('rename_model', {'source': 'old:latest'}),
                 ('rename_model', {'destination': 'new:latest'})]
        for key in ('source', 'destination'):
            for value in (1, True, None, [], {}):
                cases.append(('rename_model', {**valid, key: value}))
        for value in ('true', 'false', 1, 0, None, [], {}):
            cases.append(('rename_model', {**valid, 'confirmed': value}))
        async with Client(create_server(Cleanup(self.runner))) as client:
            for name, arguments in cases:
                with self.subTest(name=name, arguments=arguments):
                    result = await client.call_tool(name, arguments)
                    self.assertTrue(result.is_error)
                    self.assertEqual(self.calls, [])
            for arguments in ({**valid, 'confirmed': False},
                              {'source': 'old:latest', 'destination': 'new:latest'}):
                result = await client.call_tool('rename_model', arguments)
                self.assertTrue(result.is_error)
                self.assertEqual(self.payload(result)['code'], 'confirmation_required')
                self.assertEqual(self.calls, [])

    async def test_core_error_fields_preserved(self):
        self.failure = CleanupError('cli_timeout', 'timeout', {'state': 'unknown'})
        async with Client(create_server(Cleanup(self.runner))) as client:
            result = await client.call_tool('list_models', {})
        self.assertTrue(result.is_error)
        self.assertEqual(self.payload(result), {
            'code': 'cli_timeout', 'message': 'timeout', 'details': {'state': 'unknown'}})

    async def test_partial_failure_fields_preserved(self):
        def runner(args):
            if args[0] == 'rm':
                raise CleanupError('cli_failed', 'failed')
            return self.runner(args)
        async with Client(create_server(Cleanup(runner))) as client:
            result = await client.call_tool('rename_model', {
                'source': 'old:latest', 'destination': 'new:latest', 'confirmed': True})
        self.assertTrue(result.is_error)
        payload = self.payload(result)
        self.assertEqual(payload['code'], 'rename_partial_failure')
        self.assertEqual(payload['details']['stage'], 'remove')
        self.assertIs(payload['details']['rollback_attempted'], False)
