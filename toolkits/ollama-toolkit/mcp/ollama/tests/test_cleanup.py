import pathlib
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from ollama_mcp.cleanup import Cleanup, CleanupError, run_ollama


ID = 'abcdef123456'
OTHER = '123456abcdef'


def inventory(*rows):
    return 'NAME ID SIZE MODIFIED\n' + ''.join(
        f'{name} {identity} 4.5 GB 2 hours ago\n' for name, identity in rows)


class Fake:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, args):
        self.calls.append(args)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class CleanupTests(unittest.TestCase):
    def rejected(self, runner, source='old', destination='new', confirmed=True):
        with self.assertRaises(CleanupError) as caught:
            Cleanup(runner).rename_model(source, destination, confirmed)
        self.assertFalse(any(call[0] in ('cp', 'rm') for call in runner.calls))
        return caught.exception

    def test_inventory(self):
        result = Cleanup(Fake(inventory(('old', ID)))).list_models()
        self.assertEqual(result['models'], [{'name': 'old', 'canonical_name': 'old:latest', 'observed_id': ID}])
        self.assertEqual(result['identity_evidence'], 'ollama_list_id_not_full_digest_proof')

    def test_invalid_inventory(self):
        for text in ('', 'wrong header', inventory(('old', ID), ('old:latest', ID)),
                     'NAME ID SIZE MODIFIED\nbad invalid 4 GB now\n'):
            with self.subTest(text=text), self.assertRaises(CleanupError) as caught:
                Cleanup(Fake(text)).list_models()
            self.assertEqual(caught.exception.code, 'invalid_inventory')

    def test_suggestions(self):
        names = ['org/Qwen3-8B-Instruct-Q4_K_M:latest', 'mystery-8b', 'qwen3-unknown', 'qwen3-llama3-8b', 'qwen3-8b-4b']
        result = Cleanup(Fake(inventory(*[(name, ID) for name in names]))).suggest_names()['suggestions']
        self.assertEqual(result[0], {'source': names[0], 'family': 'qwen3', 'size': '8b', 'descriptors': ['instruct'], 'candidate': 'qwen3:8b-instruct'})
        for item in result[1:]:
            self.assertIsNone(item['candidate'])

    def test_size_is_not_a_family_version(self):
        source = 'mistral-7b-instruct'
        result = Cleanup(Fake(inventory((source, ID)))).suggest_names()
        self.assertEqual(result['suggestions'], [{
            'source': source, 'family': None, 'size': '7b',
            'descriptors': ['mistral', 'instruct'], 'candidate': None,
        }])

    def test_rejections(self):
        for source, destination, confirmed, rows, code in [
            ('old', 'new', False, [], 'confirmation_required'),
            ('old', 'new', 1, [], 'confirmation_required'),
            ('--help', 'new', True, [], 'invalid_name'),
            ('old', '--help', True, [], 'invalid_name'),
            ('old', 'bad name', True, [], 'invalid_name'),
            ('old', 'old:latest', True, [], 'unchanged_name'),
            ('old', 'new', True, [], 'source_missing'),
            ('old', 'new', True, [('old', ID), ('new:latest', OTHER)], 'destination_occupied'),
        ]:
            with self.subTest(code=code, source=source):
                fake = Fake(inventory(*rows))
                self.assertEqual(self.rejected(fake, source, destination, confirmed).code, code)
                if code in ('confirmation_required', 'invalid_name', 'unchanged_name'):
                    self.assertEqual(fake.calls, [])

    def test_success_order(self):
        fake = Fake(inventory(('old', ID)), '', inventory(('old', ID), ('new:latest', ID)), '')
        result = Cleanup(fake).rename_model('old', 'new', True)
        self.assertEqual(fake.calls, [['list'], ['cp', 'old', 'new'], ['list'], ['rm', 'old']])
        self.assertEqual(result['status'], 'remove_command_succeeded')
        self.assertEqual(result['observed_id'], ID)
        self.assertFalse(result['final_state_verified'])

    def test_partial_failures(self):
        cases = [
            ([RuntimeError('copy failed')], 'copy', [['list'], ['cp', 'old', 'new']]),
            (['', inventory(('old', ID), ('new', OTHER))], 'verify', None),
            (['', inventory(('old', OTHER), ('new', ID))], 'verify', None),
            (['', inventory(('new', ID))], 'verify', None),
            (['', inventory(('old', ID))], 'verify', None),
            (['', 'unreadable'], 'verify', None),
            (['', RuntimeError('unavailable')], 'verify', None),
            (['', inventory(('old', ID), ('new', ID)), RuntimeError('remove failed')], 'remove', None),
            ([subprocess.TimeoutExpired(['ollama', 'cp'], 60)], 'copy', None),
        ]
        for responses, stage, expected in cases:
            with self.subTest(stage=stage, responses=responses):
                fake = Fake(inventory(('old', ID)), *responses)
                with self.assertRaises(CleanupError) as caught:
                    Cleanup(fake).rename_model('old', 'new', True)
                error = caught.exception
                self.assertEqual(error.code, 'rename_partial_failure')
                self.assertEqual(error.message, 'Rename did not complete reliably; inspect inventory. No rollback was attempted.')
                self.assertTrue(error.details['copy_attempted'])
                self.assertEqual(error.details['source'], 'old')
                self.assertEqual(error.details['destination'], 'new')
                self.assertEqual(error.details['observed_id'], ID)
                self.assertEqual(error.details['identity_evidence'], 'ollama_list_id_not_full_digest_proof')
                failure = responses[-1]
                if isinstance(failure, Exception):
                    cause = {
                        'code': 'cli_timeout' if isinstance(failure, subprocess.TimeoutExpired) else 'cli_failed',
                        'message': 'Ollama command failed.',
                        'details': {'reason': str(failure)},
                    }
                elif failure == 'unreadable':
                    cause = {'code': 'invalid_inventory', 'message': 'Unexpected Ollama inventory header.', 'details': {}}
                else:
                    cause = {'code': 'verification_failed', 'message': 'Source or destination is missing or its listed ID changed.', 'details': {}}
                self.assertEqual(error.details['cause'], cause)
                observation = responses[1] if len(responses) > 1 else None
                if isinstance(observation, str) and observation.startswith('NAME ID SIZE MODIFIED\n'):
                    expected_observation = []
                    for row in observation.splitlines()[1:]:
                        name, identity, *_ = row.split()
                        expected_observation.append({'name': name, 'canonical_name': name + ':latest', 'observed_id': identity})
                    self.assertEqual(error.details['post_copy_observation'], expected_observation)
                else:
                    self.assertNotIn('post_copy_observation', error.details)
                self.assertEqual(error.details['stage'], stage)
                self.assertEqual(error.details['state'], 'unknown')
                self.assertFalse(error.details['rollback_attempted'])
                self.assertEqual(error.details['remove_attempted'], stage == 'remove')
                self.assertEqual(fake.calls, expected or ([['list'], ['cp', 'old', 'new']] +
                    ([['list']] if stage != 'copy' else []) + ([['rm', 'old']] if stage == 'remove' else [])))

    @patch('ollama_mcp.cleanup.subprocess.run')
    def test_production_boundary(self, run):
        run.return_value.stdout = 'output'
        self.assertEqual(run_ollama(['list']), 'output')
        run.assert_called_once_with(['ollama', 'list'], check=True, capture_output=True, text=True, timeout=60)
        run.side_effect = subprocess.TimeoutExpired(['ollama', 'list'], 60)
        with self.assertRaises(CleanupError) as caught:
            run_ollama(['list'])
        self.assertEqual(caught.exception.code, 'cli_timeout')


if __name__ == '__main__':
    unittest.main()
