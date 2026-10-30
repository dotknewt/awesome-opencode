"""Explicit KB configuration and safe public errors."""
from dataclasses import dataclass
import json
import os
import re
import stat
import unicodedata


class KBError(Exception):
    def __init__(self, code='invalid_source'):
        self.code = code
        self.message = {
            'invalid_source': 'Knowledge base validation failed.',
            'invalid_config': 'Knowledge base configuration is invalid.',
            'invalid_request': 'Invalid knowledge base request.',
            'not_found': 'Published record not found.',
        }.get(code, 'Knowledge base validation failed.')
        super().__init__(self.message)


@dataclass(frozen=True)
class KBConfig:
    root: str
    uri_prefix: str
    uri_key: str
    index_path: str
    navigation_heading: str


def load_config(path: str) -> KBConfig:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
                raise ValueError
            raw = stream.read(65537)
        if len(raw) > 65536:
            raise ValueError
        text = raw.decode('utf-8')
        # Reject excessive nesting before json constructs any collections.
        depth = 0
        quoted = escaped = False
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
                if depth > 4:
                    raise ValueError
            elif char in ']}':
                depth -= 1
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise ValueError
                result[key] = value
            return result
        data = json.loads(text, object_pairs_hook=pairs)
        if not isinstance(data, dict) or set(data) != set(KBConfig.__dataclass_fields__):
            raise ValueError
        config = KBConfig(**data)
        validate_config(config)
        return config
    except (OSError, ValueError, TypeError, UnicodeError, KBError):
        raise KBError('invalid_config') from None


def bounded_text(value, maximum):
    if not isinstance(value, str) or not value or len(value.encode('utf-8')) > maximum:
        raise ValueError
    if any(unicodedata.category(c) == 'Cc' for c in value):
        raise ValueError
    return value


def relative_path(value):
    bounded_text(value, 1024)
    if not value.endswith('.md') or any(c.isspace() or c in '%\\?#:' for c in value):
        raise ValueError
    if any(part in ('', '.', '..') for part in value.split('/')):
        raise ValueError
    return value


def validate_config(config):
    for field, maximum in [('root', 4096), ('uri_prefix', 64), ('uri_key', 64), ('index_path', 1024), ('navigation_heading', 128)]:
        bounded_text(getattr(config, field), maximum)
    if not config.root.startswith('/') or (config.root != '/' and any(p in ('', '.', '..') for p in config.root[1:].split('/'))):
        raise ValueError
    if not re.fullmatch(r'[A-Za-z][A-Za-z0-9+.-]*://', config.uri_prefix):
        raise ValueError
    relative_path(config.index_path)
    heading = config.navigation_heading
    # Headings are literal publication selectors, never rendered Markdown.
    # Reject reference-shaped syntax without decoding it or normalizing text;
    # ordinary ampersands and isolated tildes remain valid plain text.
    if (heading != heading.strip()
            or any(c in '#`*_[]<>\\' for c in heading)
            or '~~' in heading
            or re.search(r'~\S(?:.*\S)?~', heading)
            or re.search(r'&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);', heading)):
        raise ValueError
