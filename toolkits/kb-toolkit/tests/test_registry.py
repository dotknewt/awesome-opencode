import hashlib
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import tracemalloc
import unittest
from dataclasses import asdict, FrozenInstanceError, replace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'mcp' / 'kb'))
from kb_mcp.config import KBConfig, KBError, load_config
from kb_mcp.registry import load_registry


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self._fixture_roots = []
        self.root = self.new_root()
        self.config = KBConfig(str(self.root), 'intel://', 'intel_uri', 'index.md', 'Published-record navigation')

    def new_root(self):
        # Own only newly allocated containers. Ancestor-replacement tests rename
        # the root inside its container, so cleanup also covers detached copies.
        temporary = tempfile.TemporaryDirectory(prefix='kb-registry-', dir='/tmp/opencode')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name) / 'root'
        root.mkdir()
        self._fixture_roots.append(root)
        return root

    def source(self, uri, title='Example', kind='entity', extra='', body='Hello WORLD\n'):
        return f'---\nintel_uri: {uri}\ntitle: {title}\ntype: {kind}\n{extra}---\n{body}'

    def fixture(self):
        record = self.source('intel://entity/example')
        (self.root / 'record.md').write_text(record)
        index = self.source('intel://index/threat-intelligence-kb', body=(
            '## Published-record navigation\n\n| Identifier | Record |\n| --- | --- |\n'
            '| `intel://entity/example` | [Example](record.md) |\n'
            '| `intel://index/threat-intelligence-kb` | [Index](index.md) |\n'))
        (self.root / 'index.md').write_text(index)
        (self.root / 'private.md').write_text('DO NOT PUBLISH')
        return record

    def test_index_allowlist_and_exact_original_bytes(self):
        record = self.fixture()
        registry = load_registry(self.config)
        page = registry.list_records()
        self.assertEqual([r['uri'] for r in page['records']], ['intel://entity/example', 'intel://index/threat-intelligence-kb'])
        self.assertIsNone(page['next_offset'])
        result = registry.read('intel://entity/example')
        self.assertEqual(result, dict(uri='intel://entity/example', title='Example', type='entity', relative_path='record.md', byte_size=len(record.encode()), sha256=hashlib.sha256(record.encode()).hexdigest(), content=record))
        with self.assertRaises(KBError):
            registry.read('intel://private')

    def test_config_strict_schema_and_byte_bounds(self):
        path = self.root / 'config.json'
        valid = json.dumps(asdict(self.config))
        path.write_text(valid)
        self.assertEqual(load_config(str(path)), self.config)
        with self.assertRaises(FrozenInstanceError):
            self.config.root = '/elsewhere'
        invalid = [valid[:-1] + ', "root":"/other"}', '{}', '[]',
                   '{"x": [[[[[0]]]]]}', valid + 'x', ' ' * 65537]
        for field, values in {
            'root': ['', 'relative', '/a/../b', '/a//b', '/a/./b', '/' + 'a' * 4096],
            'uri_prefix': ['', 'intel:', '1bad://', 'a' * 62 + '://'],
            'uri_key': ['', 'é' * 33, 'bad\nkey'],
            'index_path': ['', '/index.md', 'a//b.md', './index.md', '../index.md', 'a%20.md', 'a\\b.md', 'x.txt'],
            'navigation_heading': ['', 'é' * 65, 'Heading\n'],
        }.items():
            for value in values + [None, True, 1, [], {}]:
                invalid.append(json.dumps({**asdict(self.config), field: value}))
        invalid.append(json.dumps({**asdict(self.config), 'extra': 'x'}))
        for text in invalid:
            with self.subTest(text=text[:80]):
                path.write_text(text)
                with self.assertRaises(KBError) as caught:
                    load_config(str(path))
                self.assertEqual(caught.exception.code, 'invalid_config')
                self.assertNotIn(str(self.root), str(caught.exception))
        path.write_text(valid + ' ' * (65536 - len(valid.encode())))
        self.assertEqual(load_config(str(path)), self.config)
        path.write_text(path.read_text() + ' ')
        with self.assertRaises(KBError):
            load_config(str(path))

    def test_config_field_maxima_are_utf8_byte_limits(self):
        path = self.root / 'config.json'
        maximum = dict(root='/' + 'a' * 4095, uri_prefix='a' * 61 + '://', uri_key='é' * 32,
                       index_path='a' * 1021 + '.md', navigation_heading='é' * 64)
        path.write_text(json.dumps(maximum))
        self.assertEqual(asdict(load_config(str(path))), maximum)
        for field in maximum:
            data = dict(maximum)
            if field == 'uri_prefix':
                data[field] = 'a' + data[field]
            elif field == 'index_path':
                data[field] = 'a' + data[field]
            else:
                data[field] += 'a'
            path.write_text(json.dumps(data))
            with self.subTest(field=field), self.assertRaises(KBError):
                load_config(str(path))

    def test_namespace_isolation_and_date_metadata(self):
        self.fixture()
        for path in self.root.glob('*.md'):
            path.write_text(path.read_text().replace('intel_uri:', 'other_id:').replace('intel://', 'other://'))
        config = replace(self.config, uri_prefix='other://', uri_key='other_id')
        path = self.root / 'record.md'
        path.write_text(path.read_text().replace('title: Example', 'title: 2026-10-29'))
        registry = load_registry(config)
        self.assertEqual(registry.read('other://entity/example')['title'], '2026-10-29')
        with self.assertRaises(KBError):
            registry.read('intel://entity/example')

    def test_independent_roots_and_inert_external_links(self):
        self.fixture()
        first = load_registry(self.config)
        second_root = self.new_root()
        body = '[Outside](../../secret.md) [Web](https://example.invalid/secret)\n'
        (second_root / 'record.md').write_text('---\nother_id: other://entity\ntitle: Second\ntype: threat-actor\n---\n' + body)
        (second_root / 'index.md').write_text('## Records\n| Identifier | Record |\n| --- | --- |\n| `other://entity` | [Second](record.md) |\n')
        second = load_registry(KBConfig(str(second_root), 'other://', 'other_id', 'index.md', 'Records'))
        self.assertEqual(second.read('other://entity')['type'], 'threat-actor')
        self.assertIn(body, second.read('other://entity')['content'])
        self.assertEqual(first.read('intel://entity/example')['title'], 'Example')
        for registry, uri in [(first, 'other://entity'), (second, 'intel://entity/example')]:
            with self.assertRaises(KBError):
                registry.read(uri)

    def test_unicode_case_expansion_snippet_still_contains_match(self):
        self.fixture()
        (self.root / 'record.md').write_text(self.source('intel://entity/example', body='İ' * 1000 + '\nNEEDLE\n'))
        page = load_registry(self.config).search('needle')
        self.assertEqual(len(page['records']), 1)
        self.assertIn('NEEDLE', page['records'][0]['snippet'])

    def test_unicode_casefold_expansions_in_content_and_query(self):
        self.fixture()
        path = self.root / 'record.md'
        for body, query, expected in [
            ('ß' * 1000 + '\nStraße\n', 'STRASSE', 'Straße'),
            ('ﬃ' * 1000 + '\nSTRASSE\n', 'Straße', 'STRASSE'),
            ('İ' * 1000 + '\nﬃ\n', 'FFI', 'ﬃ'),
            ('ß' * 1000 + '\nFFI\n', 'ﬃ', 'FFI'),
        ]:
            with self.subTest(query=query, expected=expected):
                path.write_text(self.source('intel://entity/example', body=body))
                page = load_registry(self.config).search(query)
                self.assertEqual(len(page['records']), 1)
                self.assertIn(expected, page['records'][0]['snippet'])
                self.assertLessEqual(len(page['records'][0]['snippet']), 512)

    def test_newline_heavy_sources_do_not_allocate_whole_file_line_lists(self):
        # A 1 MiB source plus its retained snapshot fits comfortably within this
        # allowance; a million-entry line list alone exceeds it. Measure real
        # startup allocations, not implementation text or mocked parser calls.
        for kind in ['index', 'record', 'frontmatter']:
            with self.subTest(kind=kind):
                self.fixture()
                if kind == 'index':
                    path = self.root / 'index.md'
                    base = path.read_text()
                    text = base + '\n' * (1048576 - len(base.encode()))
                elif kind == 'record':
                    path = self.root / 'record.md'
                    base = self.source('intel://entity/example', body='')
                    text = base + '\n' * (1048576 - len(base.encode()))
                else:
                    path = self.root / 'record.md'
                    text = '---\n' + '\n' * (1048576 - 8) + '---\n'
                path.write_text(text)
                tracemalloc.start()
                try:
                    if kind == 'frontmatter':
                        with self.assertRaises(KBError):
                            load_registry(self.config)
                    else:
                        registry = load_registry(self.config)
                        uri = 'intel://index/threat-intelligence-kb' if kind == 'index' else 'intel://entity/example'
                        self.assertEqual(registry.read(uri)['byte_size'], 1048576)
                    peak = tracemalloc.get_traced_memory()[1]
                finally:
                    tracemalloc.stop()
                self.assertLess(peak, 8 * 1024 * 1024)

    def test_newline_heavy_frontmatter_exact_byte_boundary(self):
        self.fixture()
        path = self.root / 'record.md'
        base = self.source('intel://entity/example', body='')
        for size in [16384, 16385]:
            text = base[:-4] + '\n' * (size - len(base.encode())) + '---\n'
            self.assertEqual(len(text.encode()), size)
            path.write_text(text)
            if size == 16384:
                self.assertEqual(load_registry(self.config).read('intel://entity/example')['byte_size'], size)
            else:
                with self.assertRaises(KBError):
                    load_registry(self.config)

    def test_fixture_cleanup_removes_only_newly_owned_roots(self):
        case = RegistryTests('test_independent_roots_and_inert_external_links')
        result = unittest.TestResult()
        case.run(result)
        self.assertTrue(result.wasSuccessful(), result.errors + result.failures)
        self.assertFalse(case.root.exists(), 'Test fixture survived its cleanup lifecycle')
        for root in case._fixture_roots:
            self.assertFalse(root.parent.exists(), 'Owned container survived cleanup')
        self.assertTrue(self.root.exists(), 'Cleanup removed an unrelated fixture')

    def test_edit_between_fstat_and_initial_read_is_rejected(self):
        self.fixture()
        target = self.root / 'record.md'
        target_id = target.stat().st_ino
        real_fstat = os.fstat
        changed = False
        def changing_fstat(fd):
            nonlocal changed
            info = real_fstat(fd)
            if info.st_ino == target_id and not changed:
                changed = True
                with target.open('a') as stream:
                    stream.write('concurrent edit')
            return info
        with patch('os.fstat', side_effect=changing_fstat), self.assertRaises(KBError):
            load_registry(self.config)

    def test_publication_grammar_rejects_ambiguous_rows(self):
        self.fixture()
        path = self.root / 'index.md'
        original = path.read_text()
        row = '| `intel://entity/example` | [Example](record.md) |'
        invalid = [original + '\n## Published-record navigation\n',
                   original + '\ntrailing prose\n', original + '\n```\nunclosed',
                   original.replace('| --- | --- |', '| :--- | --- |'),
                   original.replace('| Identifier | Record |', '| Record | Identifier |'),
                   original.replace(row, row + '\n' + row),
                   original.replace(row, '    ' + row),
                   original.replace(row, row + ' extra'),
                   original.replace(row, row.replace('Example', 'Ex\\|ample')),
                   original.replace(row, row.replace('(record.md)', '(record.md "title")')),
                   original.replace(row, row.replace('(record.md)', '((record.md))')),
                   original.replace(row, row.replace('[Example]', '[Ex\\ample]')),
                   original.replace('record.md', 'missing.md'),
                   original.replace('(record.md)', '(index.md)'),
                   original.replace(row, '\t' + row),
                   original.replace(row, row.replace('| [Example]', '| extra | [Example]')),
                   original.replace(row + '\n', '').replace('| `intel://index/threat-intelligence-kb` | [Index](index.md) |\n', ''),
                   original + '\n## Elsewhere\n~~~~\n```\n']
        for destination in ['../record.md', './record.md', 'a//record.md', '/record.md', 'a%2f.md', 'a\\b.md', 'a:b.md', 'a.md?x', 'a.md#x', 'a b.md']:
            invalid.append(original.replace('(record.md)', f'({destination})'))
        for text in invalid:
            with self.subTest(text=text[-100:]):
                path.write_text(text)
                with self.assertRaises(KBError):
                    load_registry(self.config)

    def test_fences_and_section_termination(self):
        self.fixture()
        path = self.root / 'index.md'
        original = path.read_text()
        suffix = '\n## Other\n| `intel://private` | [Hidden](private.md) |\n'
        prefix = '```md\n## Published-record navigation\n~~~\n```\n'
        path.write_text(original.replace('## Published-record navigation', prefix + '## Published-record navigation') + suffix)
        self.assertEqual(len(load_registry(self.config).list_records()['records']), 2)

    def test_empty_or_tab_separated_atx_heading_ends_section(self):
        self.fixture()
        path = self.root / 'index.md'
        original = path.read_text()
        for heading in ['#', '##', '#\tOther', '##\tOther']:
            with self.subTest(heading=heading):
                path.write_text(original + '\n' + heading + '\nUnrelated prose\n')
                self.assertEqual(len(load_registry(self.config).list_records()['records']), 2)

    def test_unicode_line_separators_do_not_authorize_headings(self):
        self.fixture()
        path = self.root / 'index.md'
        original = path.read_text()
        for separator in ['\x85', '\u2028', '\u2029', '\x1c']:
            path.write_text(original.replace('## Published-record navigation', 'Not a heading' + separator + '## Published-record navigation'))
            with self.subTest(separator=repr(separator)), self.assertRaises(KBError):
                load_registry(self.config)

    def test_metadata_and_yaml_fail_closed(self):
        self.fixture()
        path = self.root / 'record.md'
        original = path.read_text()
        variants = [original.replace('intel://entity/example', 'intel://other'),
                    original.replace('title: Example', 'title: []'),
                    original.replace('title: Example', 'title: ""'),
                    original.replace('type: entity', 'type: null'),
                    original.replace('type: entity', 'type: entity\ntype: entity'),
                    original.replace('title: Example', 'title: &a Example'),
                    original.replace('title: Example', 'title: *a'),
                    original.replace('title: Example', 'title: !!str Example'),
                    original.replace('type: entity', 'type: entity\nignored: {x: 1, x: 2}'),
                    original.replace('type: entity', 'type: entity\nignored: {<<: {x: 1}}'),
                    original.replace('type: entity', 'type: entity\nignored: ' + '[' * 9 + '0' + ']' * 9),
                    original.replace('type: entity', 'type: entity\nignored: [' + ','.join('0' for _ in range(1024)) + ']'),
                    original.replace('type: entity', 'type: entity\nignored: ' + 'x' * 4097),
                    original.replace('title: Example', 'title: ' + 'é' * 257),
                    original.replace('type: entity', 'type: ' + 'é' * 65),
                    original.replace('title: Example', 'title: "bad\\u0000title"'),
                    'not frontmatter\n' + original]
        for text in variants:
            with self.subTest(text=text[:100]):
                path.write_text(text)
                with self.assertRaises(KBError) as caught:
                    load_registry(self.config)
                self.assertNotIn('intel://', str(caught.exception))
                self.assertNotIn(str(self.root), str(caught.exception))

    def test_symlinks_hardlinks_and_special_files(self):
        self.fixture()
        link = self.root / 'alias'
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(KBError):
            load_registry(replace(self.config, root=str(link)))
        with self.assertRaises(KBError):
            load_registry(replace(self.config, root=str(link / 'missing')))
        record = self.root / 'record.md'
        record.rename(self.root / 'real.md')
        record.symlink_to(self.root / 'real.md')
        with self.assertRaises(KBError):
            load_registry(self.config)
        record.unlink()
        record.mkdir()
        with self.assertRaises(KBError):
            load_registry(self.config)
        record.rmdir()
        os.link(self.root / 'index.md', record)
        with self.assertRaises(KBError):
            load_registry(self.config)

    def test_requests_are_strict_literal_and_snapshot_only(self):
        record = self.fixture()
        registry = load_registry(self.config)
        (self.root / 'record.md').write_text('changed')
        with patch('os.open', side_effect=AssertionError('request performed filesystem IO')), patch('builtins.open', side_effect=AssertionError('request performed filesystem IO')):
            self.assertEqual(registry.read('intel://entity/example')['content'], record)
            self.assertEqual(len(registry.search('world')['records']), 1)
            self.assertEqual(registry.search('.*')['records'], [])
            self.assertEqual(registry.search('x' * 256)['records'], [])
            first = registry.list_records(limit=1)
            second = registry.list_records(offset=first['next_offset'], limit=1)
            self.assertNotEqual(first['records'][0]['uri'], second['records'][0]['uri'])
            self.assertIsNone(second['next_offset'])
            self.assertLessEqual(len(registry.search('world')['records'][0]['snippet']), 512)
        for query in ['', 'x' * 257, None, 1, True]:
            with self.assertRaises(KBError):
                registry.search(query)
        for field in ['offset', 'limit']:
            for value in [True, '1', 1.0, None, -1] + ([0, 101] if field == 'limit' else []):
                with self.subTest(field=field, value=value), self.assertRaises(KBError):
                    registry.list_records(**{field: value})
        for uri in ['INTEL://entity/example', 'intel://entity/%65xample', 'intel://entity/example/', None, True, 'a' * 1025]:
            with self.assertRaises(KBError):
                registry.read(uri)
        result = registry.read('intel://entity/example')
        result['title'] = 'mutated'
        self.assertEqual(registry.read('intel://entity/example')['title'], 'Example')

    def test_source_line_boundaries_do_not_strip_data_carriage_returns(self):
        self.fixture()
        path = self.root / 'record.md'
        for body, allowed in [('x' * 16384 + '\n', True), ('x' * 16385 + '\n', False),
                              ('x' * 16384 + '\r\n', True), ('x' * 16384 + '\r\r\n', False)]:
            with self.subTest(allowed=allowed, ending=repr(body[-4:])):
                path.write_bytes(self.source('intel://entity/example', body=body).encode())
                if allowed:
                    self.assertEqual(load_registry(self.config).read('intel://entity/example')['content'], path.read_bytes().decode())
                else:
                    with self.assertRaises(KBError):
                        load_registry(self.config)

    def test_frontmatter_and_yaml_exact_budgets(self):
        self.fixture()
        path = self.root / 'record.md'
        base = self.source('intel://entity/example', body='')
        for size in [16384, 16385]:
            # Comments consume bytes but not nodes/scalar allowance.
            text = base.replace('type: entity\n', 'type: entity\n#' + 'x' * (size - len(base.encode()) - 2) + '\n')
            self.assertEqual(len(text.encode()), size)
            path.write_text(text)
            if size == 16384:
                load_registry(self.config)
            else:
                with self.assertRaises(KBError):
                    load_registry(self.config)
        for leaves, valid in [(1015, True), (1016, False)]:
            path.write_text(self.source('intel://entity/example', extra='ignored: [' + ','.join('0' for _ in range(leaves)) + ']\n'))
            if valid:
                load_registry(self.config)
            else:
                with self.assertRaises(KBError):
                    load_registry(self.config)
        for levels, valid in [(6, True), (7, False)]:
            path.write_text(self.source('intel://entity/example', extra='ignored: ' + '[' * levels + '0' + ']' * levels + '\n'))
            if valid:
                load_registry(self.config)
            else:
                with self.assertRaises(KBError):
                    load_registry(self.config)
        path.write_text(self.source('intel://entity/example', title='é' * 256, kind='é' * 64, extra='ignored: ' + 'x' * 4096 + '\n'))
        result = load_registry(self.config).read('intel://entity/example')
        self.assertEqual(result['title'], 'é' * 256)
        self.assertNotIn('ignored', result)

    def test_exact_uri_grammar_and_unindexed_index(self):
        valid = ['intel://HOST', 'intel://host/', 'intel://host/%2F', 'intel://host/%2f', 'intel://host/%41', 'intel://例/路径?q=é#片', 'intel://host?x#f', 'intel://' + 'a' * 1016]
        invalid = ['intel://', 'intel:///path', 'intel://?q', 'intel://#f', 'INTEL://host', 'intel://a/%', 'intel://a/%xy', 'intel://a b', 'intel://a\\b', 'intel://a{b}', 'intel://a"b', 'intel://a<b>', 'intel://a\x7fb', 'intel://' + 'a' * 1017]
        for uri in valid + invalid:
            with self.subTest(uri=uri):
                (self.root / 'record.md').write_text(self.source(json.dumps(uri)))
                (self.root / 'index.md').write_text('## Published-record navigation\n| Identifier | Record |\n| --- | --- |\n' + f'| `{uri}` | [Record](record.md) |\n')
                if uri in valid:
                    registry = load_registry(self.config)
                    self.assertEqual(registry.read(uri)['uri'], uri)
                    self.assertEqual(len(registry.list_records()['records']), 1)
                    with self.assertRaises(KBError):
                        registry.read('intel://index/threat-intelligence-kb')
                else:
                    with self.assertRaises(KBError):
                        load_registry(self.config)

    def test_fifo_has_hard_subprocess_timeout(self):
        self.fixture()
        path = self.root / 'record.md'
        path.unlink()
        os.mkfifo(path)
        script = ('from kb_mcp.config import KBConfig, KBError\nfrom kb_mcp.registry import load_registry\n'
                  'try:\n load_registry(KBConfig(**' + repr(asdict(self.config)) + '))\n'
                  'except KBError:\n pass\nelse:\n raise AssertionError("FIFO admitted")\n')
        env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1] / 'mcp' / 'kb') + os.pathsep + os.environ.get('PYTHONPATH', ''))
        result = subprocess.run([sys.executable, '-c', script], env=env, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_intermediate_symlink_and_duplicate_hardlink_targets(self):
        self.fixture()
        index = self.root / 'index.md'
        original = index.read_text()
        (self.root / 'dir').mkdir()
        (self.root / 'dir' / 'record.md').write_text(self.source('intel://entity/example'))
        (self.root / 'shortcut').symlink_to(self.root / 'dir', target_is_directory=True)
        index.write_text(original.replace('(record.md)', '(shortcut/record.md)'))
        with self.assertRaises(KBError):
            load_registry(self.config)
        os.link(self.root / 'record.md', self.root / 'alias.md')
        index.write_text(original + '| `intel://entity/alias` | [Alias](alias.md) |\n')
        with self.assertRaises(KBError):
            load_registry(self.config)

    def test_detects_changes_during_construction_and_revalidation(self):
        # Wrap real OS opens to deterministically edit actual synthetic files.
        for mode in ['edit', 'replace', 'ancestor', 'index']:
            with self.subTest(mode=mode):
                self.fixture()
                real_open = os.open
                count = 0
                def changing_open(path, flags, *args, **kwargs):
                    nonlocal count
                    if path == 'record.md':
                        count += 1
                        if count == 2:
                            if mode == 'edit':
                                (self.root / 'record.md').write_text(self.source('intel://entity/example', body='edited'))
                            elif mode == 'replace':
                                (self.root / 'new.md').write_bytes((self.root / 'record.md').read_bytes())
                                (self.root / 'new.md').replace(self.root / 'record.md')
                            elif mode == 'ancestor':
                                old = self.root.with_name(self.root.name + '-old')
                                self.root.rename(old)
                                self.root.mkdir()
                                for name in ['record.md', 'index.md']:
                                    os.link(old / name, self.root / name)
                            else:
                                with (self.root / 'index.md').open('a') as stream:
                                    stream.write('\n')
                    return real_open(path, flags, *args, **kwargs)
                with patch('os.open', side_effect=changing_open), self.assertRaises(KBError):
                    load_registry(self.config)

    def test_serialized_pages_and_read_budget(self):
        rows = []
        for i in range(110):
            uri = 'intel://例/' + 'é' * 480 + f'{i:03}'
            name = f'{i:03}.md'
            rows.append(f'| `{uri}` | [Record]({name}) |')
            (self.root / name).write_text(self.source(uri, title=json.dumps('"' * 512), kind='é' * 64, body='needle ' + '\\' * 1000))
        (self.root / 'index.md').write_text('## Published-record navigation\n| Identifier | Record |\n| --- | --- |\n' + '\n'.join(rows))
        registry = load_registry(self.config)
        self.assertLessEqual(len(registry.list_records()['records']), 20)
        for operation in [registry.list_records, lambda **kw: registry.search('needle', **kw)]:
            seen = []
            offset = 0
            while offset is not None:
                page = operation(offset=offset, limit=100)
                envelope = {'jsonrpc': '2.0', 'id': 'x' * 128, 'result': {'structuredContent': page, 'content': [{'type': 'text', 'text': json.dumps(page)}]}}
                self.assertLessEqual(len(json.dumps(envelope).encode()), 256 * 1024)
                self.assertTrue(page['records'])
                seen.extend(r['uri'] for r in page['records'])
                offset = page['next_offset']
            self.assertEqual(len(seen), 110)
            self.assertEqual(len(set(seen)), 110)
            self.assertEqual(seen, sorted(seen))

    def test_record_file_size_boundaries(self):
        self.fixture()
        path = self.root / 'record.md'
        base = self.source('intel://entity/example', body='')
        remaining = 1048576 - len(base.encode())
        body = ('\x00' * 1000 + '\n') * (remaining // 1001) + '\x00' * (remaining % 1001)
        path.write_bytes((base + body).encode())
        registry = load_registry(self.config)
        read = registry.read('intel://entity/example')
        envelope = {'result': {'structuredContent': read, 'content': [{'type': 'text', 'text': json.dumps(read)}]}}
        self.assertLessEqual(len(json.dumps(envelope).encode()), 16 * 1024 * 1024)
        path.write_bytes(path.read_bytes() + b'x')
        with self.assertRaises(KBError):
            load_registry(self.config)

    def test_snapshot_cannot_be_deleted_or_reassigned(self):
        self.fixture()
        registry = load_registry(self.config)
        with self.assertRaises(AttributeError):
            registry._records = ()
        with self.assertRaises(AttributeError):
            del registry._records
        self.assertEqual(len(registry.list_records()['records']), 2)

    def test_duplicate_nan_yaml_keys_fail_closed(self):
        self.fixture()
        (self.root / 'record.md').write_text(self.source('intel://entity/example', extra='ignored: {.nan: one, .nan: two}\n'))
        with self.assertRaises(KBError):
            load_registry(self.config)

    def test_count_budget_includes_unindexed_index_exactly_once(self):
        header = '## Published-record navigation\n| Identifier | Record |\n| --- | --- |\n'
        rows = []
        for i in range(10000):
            name = f'{i}.md'
            uri = f'intel://e/{i}'
            rows.append(f'| `{uri}` | [R]({name}) |\n')
            (self.root / name).write_text(self.source(uri, body=''))
        index = self.root / 'index.md'
        index.write_text(header + ''.join(rows[:9999]))
        registry = load_registry(self.config)
        self.assertEqual(registry.list_records(offset=9998)['records'][0]['uri'], sorted(f'intel://e/{i}' for i in range(9999))[9998])
        self.assertIsNone(registry.list_records(offset=9998)['next_offset'])
        index.write_text(header + ''.join(rows))
        with self.assertRaises(KBError):
            load_registry(self.config)
        index.write_text(self.source('intel://index', body=header + ''.join(rows[:9999]) + '| `intel://index` | [Index](index.md) |\n'))
        registry = load_registry(self.config)
        self.assertEqual(len(registry.list_records(offset=9999)['records']), 1)
        self.assertEqual(len(registry.list_records()['records']), 20)
        self.assertEqual(len(registry.list_records(limit=100)['records']), 100)

    def test_aggregate_byte_budget_includes_index_once(self):
        rows = []
        for i in range(64):
            rows.append(f'| `intel://e/{i}` | [R]({i}.md) |\n')
        index = self.source('intel://index', body='## Published-record navigation\n| Identifier | Record |\n| --- | --- |\n' + ''.join(rows) + '| `intel://index` | [Index](index.md) |\n')
        (self.root / 'index.md').write_text(index)
        for i in range(64):
            base = self.source(f'intel://e/{i}', body='')
            size = 1048576 - (len(index.encode()) if i == 63 else 0)
            remaining = size - len(base.encode())
            (self.root / f'{i}.md').write_text(base + ('x' * 1000 + '\n') * (remaining // 1001) + 'x' * (remaining % 1001))
        registry = load_registry(self.config)
        self.assertEqual(len(registry.list_records(limit=100)['records']), 65)
        with (self.root / '63.md').open('a') as stream:
            stream.write('x')
        with self.assertRaises(KBError):
            load_registry(self.config)
    def test_index_file_size_boundaries(self):
        self.fixture()
        path = self.root / 'index.md'
        base = path.read_text() + '\n## End\n'
        remaining = 1048576 - len(base.encode())
        path.write_text(base + ('x' * 1000 + '\n') * (remaining // 1001) + 'x' * (remaining % 1001))
        self.assertEqual(load_registry(self.config).read('intel://index/threat-intelligence-kb')['byte_size'], 1048576)
        with path.open('a') as stream:
            stream.write('x')
        with self.assertRaises(KBError):
            load_registry(self.config)


if __name__ == '__main__':
    unittest.main()
