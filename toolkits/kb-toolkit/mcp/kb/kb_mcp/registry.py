"""Bounded publication parser and immutable, filesystem-independent snapshots."""
from dataclasses import dataclass
import hashlib
import json
import os
import re
import stat
from types import MappingProxyType

import yaml
from yaml.events import AliasEvent, CollectionStartEvent, CollectionEndEvent, ScalarEvent

from .config import KBError, bounded_text, relative_path, validate_config

FILE_LIMIT = 1024 * 1024
TOTAL_LIMIT = 64 * 1024 * 1024
COUNT_LIMIT = 10000
LINE_LIMIT = 16384
FRONTMATTER_LIMIT = 16384
# Reserve room for MCP envelopes and both structured and text representations.
PAGE_PAYLOAD_LIMIT = 60000


def _uri(value, prefix):
    bounded_text(value, 1024)
    if not value.startswith(prefix) or any(c.isspace() or c in '\\`|"<>{}' for c in value):
        raise ValueError
    remainder = value[len(prefix):]
    if not re.split(r'[/ ?#]', remainder, maxsplit=1)[0]:
        raise ValueError
    if re.search(r'%(?![0-9a-fA-F]{2})', value):
        raise ValueError
    return value


def _signature(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


@dataclass(frozen=True)
class _Source:
    raw: bytes
    signature: tuple
    directories: tuple


def _read_source(config, path, remaining):
    """Never pass more than one pathname component to a directory-relative open."""
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fds = []
    try:
        fds.append(os.open('/', directory_flags))
        directories = [os.fstat(fds[-1])]
        parts = ([] if config.root == '/' else config.root[1:].split('/')) + path.split('/')
        for part in parts[:-1]:
            fds.append(os.open(part, directory_flags, dir_fd=fds[-1]))
            directories.append(os.fstat(fds[-1]))
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fds[-1])
        with os.fdopen(fd, 'rb') as stream:
            before = os.fstat(stream.fileno())
            cap = min(FILE_LIMIT, remaining)
            if not stat.S_ISREG(before.st_mode) or before.st_size > cap:
                raise ValueError
            raw = stream.read(cap + 1)
            after = os.fstat(stream.fileno())
            if len(raw) > cap or len(raw) != before.st_size or _signature(before) != _signature(after):
                raise ValueError
        identities = tuple((s.st_dev, s.st_ino) for s in directories)
        if identities != tuple((s.st_dev, s.st_ino) for s in map(os.fstat, fds)):
            raise ValueError
        return _Source(raw, _signature(before), identities)
    finally:
        for fd in reversed(fds):
            os.close(fd)


class _MetadataLoader(yaml.SafeLoader):
    # Copy resolver lists: do not change process-global PyYAML behavior.
    yaml_implicit_resolvers = {
        key: [(tag, pattern) for tag, pattern in values if tag != 'tag:yaml.org,2002:timestamp']
        for key, values in yaml.SafeLoader.yaml_implicit_resolvers.items()
    }

    def construct_mapping(self, node, deep=False):
        result = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if key == '<<' or key in result:
                raise ValueError
            result[key] = self.construct_object(value_node, deep=deep)
        return result


def _line_spans(value):
    """Yield LF/CRLF line indexes without retaining a collection of lines."""
    newline, carriage_return = (b'\n', b'\r') if isinstance(value, bytes) else ('\n', '\r')
    start = 0
    while True:
        end = value.find(newline, start)
        following = len(value) if end == -1 else end + 1
        end = len(value) if end == -1 else end
        content_end = end - 1 if end > start and value[end - 1:end] == carriage_return else end
        yield start, content_end, following
        if following == len(value):
            return
        start = following


def _metadata(text, config):
    lines = _line_spans(text)
    start, end, body_start = next(lines)
    if text[start:end] != '---':
        raise ValueError
    size = len(text[:body_start].encode('utf-8'))
    for start, end, following in lines:
        size += len(text[start:following].encode('utf-8'))
        if size > FRONTMATTER_LIMIT:
            raise ValueError
        if text[start:end] == '---':
            frontmatter = text[body_start:start]
            break
    else:
        raise ValueError
    # Event preflight happens before the YAML composer builds its node graph.
    depth = nodes = 0
    for event in yaml.parse(frontmatter, Loader=yaml.SafeLoader):
        if isinstance(event, AliasEvent) or getattr(event, 'anchor', None) is not None or getattr(event, 'tag', None) is not None:
            raise ValueError
        if isinstance(event, (ScalarEvent, CollectionStartEvent)):
            nodes += 1
            if nodes > 1024 or depth + 1 > 8:
                raise ValueError
        if isinstance(event, CollectionStartEvent):
            depth += 1
        elif isinstance(event, CollectionEndEvent):
            depth -= 1
        elif isinstance(event, ScalarEvent) and len(event.value.encode('utf-8')) > 4096:
            raise ValueError
    meta = yaml.load(frontmatter, Loader=_MetadataLoader)
    if not isinstance(meta, dict):
        raise ValueError
    uri = _uri(meta.get(config.uri_key), config.uri_prefix)
    title = bounded_text(meta.get('title'), 512)
    kind = bounded_text(meta.get('type'), 128)
    return dict(uri=uri, title=title, type=kind)


def _decode(raw):
    if any(end - start > LINE_LIMIT for start, end, _ in _line_spans(raw)):
        raise ValueError
    return raw.decode('utf-8')


def _table(text, config):
    rows = []
    seen_heading = False
    active = False
    phase = 'before'
    fence = None
    # Python splitlines also splits Unicode separators that are not Markdown
    # line endings; those must never turn inline text into an authorizing heading.
    for start, end, _ in _line_spans(text):
        line = text[start:end]
        if fence:
            if re.fullmatch(r' {0,3}' + re.escape(fence[0]) + '{' + str(fence[1]) + r',}[ \t]*', line):
                fence = None
            continue
        opening = re.match(r' {0,3}(`{3,}|~{3,})', line)
        if opening:
            if active:
                raise ValueError
            fence = (opening[1][0], len(opening[1]))
            continue
        heading = re.fullmatch(r'(#{1,6})(?:[ \t]+.*)?', line)
        if heading and len(heading[1]) <= 2:
            active = False
            if line == '## ' + config.navigation_heading:
                if seen_heading:
                    raise ValueError
                seen_heading = active = True
            continue
        if not active:
            continue
        if not line.strip():
            if phase == 'rows':
                phase = 'after'
            elif phase == 'separator':
                raise ValueError
            continue
        if phase == 'before':
            if line != '| Identifier | Record |':
                raise ValueError
            phase = 'separator'
        elif phase == 'separator':
            if line != '| --- | --- |':
                raise ValueError
            phase = 'rows'
        elif phase == 'rows':
            cells = line.split('|')
            if len(cells) != 4 or cells[0] or cells[-1]:
                raise ValueError
            identifier, record = (cell.strip(' ') for cell in cells[1:3])
            match_id = re.fullmatch(r'`([^`]+)`', identifier)
            match_link = re.fullmatch(r'\[([^\[\]\\|\r\n]+)\]\(([^()<>\\]+)\)', record)
            if not match_id or not match_link:
                raise ValueError
            rows.append((_uri(match_id[1], config.uri_prefix), relative_path(match_link[2])))
            if len(rows) > COUNT_LIMIT:
                raise ValueError
        else:
            raise ValueError
    if fence or not seen_heading or not rows or phase == 'separator':
        raise ValueError
    return rows


class Registry:
    """All request operations use only immutable retained snapshot data."""
    __slots__ = ('_records',)

    def __init__(self, records):
        object.__setattr__(self, '_records', tuple(MappingProxyType(dict(r)) for r in sorted(records, key=lambda r: r['uri'])))

    def __setattr__(self, name, value):
        raise AttributeError('Registry is immutable')

    def __delattr__(self, name):
        raise AttributeError('Registry is immutable')

    def _page(self, offset, limit, query=None):
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100:
            raise KBError('invalid_request')
        records = []
        matched = 0
        next_offset = None
        for record in self._records:
            position = record['content'].casefold().find(query) if query is not None else 0
            if position < 0:
                continue
            matched += 1
            if matched <= offset:
                continue
            item = {k: v for k, v in record.items() if k != 'content'}
            if query is not None:
                content = record['content']
                # Unicode casefolding can expand characters (e.g. sharp S).
                # Translate the match offset back without retaining an offset map.
                folded_offset = 0
                for original_offset, char in enumerate(content):
                    folded_offset += len(char.casefold())
                    if folded_offset > position:
                        break
                start = max(0, original_offset - 128)
                item['snippet'] = content[start:start + 512]
            candidate = {'records': records + [item], 'next_offset': matched}
            if len(records) >= limit or len(json.dumps(candidate, ensure_ascii=True).encode('utf-8')) > PAGE_PAYLOAD_LIMIT:
                if not records:
                    raise KBError('invalid_request')
                next_offset = offset + len(records)
                break
            records.append(item)
        return {'records': records, 'next_offset': next_offset}

    def list_records(self, offset=0, limit=20):
        return self._page(offset, limit)

    def search(self, query, offset=0, limit=20):
        if not isinstance(query, str) or not 1 <= len(query) <= 256:
            raise KBError('invalid_request')
        try:
            query.encode('utf-8')
        except UnicodeError:
            raise KBError('invalid_request') from None
        return self._page(offset, limit, query.casefold())

    def read(self, uri):
        try:
            bounded_text(uri, 1024)
        except (ValueError, UnicodeError):
            raise KBError('invalid_request') from None
        for record in self._records:
            if record['uri'] == uri:
                return dict(record)
        raise KBError('not_found')


def load_registry(config):
    try:
        validate_config(config)
        index = _read_source(config, config.index_path, TOTAL_LIMIT)
        sources = {config.index_path: index}
        total = len(index.raw)
        rows = _table(_decode(index.raw), config)
        uris, paths, identities = set(), set(), set()
        records = []
        for uri, path in rows:
            if uri in uris or path in paths:
                raise ValueError
            uris.add(uri)
            paths.add(path)
            if path not in sources:
                if len(sources) >= COUNT_LIMIT:
                    raise ValueError
                source = _read_source(config, path, TOTAL_LIMIT - total)
                total += len(source.raw)
                sources[path] = source
            source = sources[path]
            if source.signature[:2] in identities or (path != config.index_path and source.signature[:2] == index.signature[:2]):
                raise ValueError
            identities.add(source.signature[:2])
            content = _decode(source.raw)
            meta = _metadata(content, config)
            if meta['uri'] != uri:
                raise ValueError
            records.append(dict(**meta, relative_path=path, byte_size=len(source.raw), sha256=hashlib.sha256(source.raw).hexdigest(), content=content))
        # Fresh walks catch detached/replaced ancestors; one transient file only.
        for path in [p for p in sources if p != config.index_path] + [config.index_path]:
            current = _read_source(config, path, FILE_LIMIT)
            if current != sources[path]:
                raise ValueError
            del current
        return Registry(records)
    except (OSError, ValueError, TypeError, UnicodeError, yaml.YAMLError, RecursionError):
        raise KBError('invalid_source') from None
