# KB toolkit

Version 0.1.0 provides an independently configured, read-only Markdown KB MCP
server and the on-demand `dotknewt-kb-read` skill. The server host reads local
files; agents can use its tools/resources without filesystem access. This is
stdio MCP, not a remote HTTP service or an arbitrary URI fetcher.

## Install and configure

Requires Linux, `uv`, and Python 3.10+. `uv run --script` provisions pinned
`mcp==2.2.0` and `PyYAML==6.0.3`; first launch may download dependencies or a
Python interpreter unless cached. This provisioning is separate from the KB
server, which never fetches network content.

```sh
awesome-opencode install kb-toolkit --project /absolute/project
# Or: awesome-opencode install kb-toolkit --global
```

Installation contributes **disabled, unconfigured** `dotknewt-kb`. Keep that
installer-owned entry unchanged. Create separate, uniquely named connections for
each KB; they reuse the executable, not source configuration or publication state.
The installer does not select a KB, change global agent instructions, or launch
the server. The skill is discoverable on demand, not an always-loaded directive.

Copy `mcp/kb/config.example.json` from the installed asset tree to an
operator-owned location **outside installed assets**, then replace all values:

```json
{
  "root": "/absolute/published-intel",
  "uri_prefix": "intel://",
  "uri_key": "intel_uri",
  "index_path": "index.md",
  "navigation_heading": "Published-record navigation"
}
```

These five string fields are required; unknown/duplicate keys fail. `root` is
absolute and all its components must be real directories, not symlinks. For a
future KB, use another config/root and its own prefix, metadata key and index
heading. Future KBs must follow this Markdown contract; other backends are not
implemented. Logical URIs are case-sensitive identifiers, not network endpoints.

The project-installed entrypoint is:

```text
/absolute/project/.opencode/awesome-opencode/toolkits/kb-toolkit/mcp/kb/server.py
```

For a global install, replace `/absolute/project/.opencode` with the selected
OpenCode config root (`$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode`). Use
an expanded absolute path in configuration, not shell expressions.

An operator can add distinct global connections with the documented OpenCode V2
CLI (omit `--global` for project connections):

```sh
opencode mcp add intel-kb --global -- uv run --script /absolute/installed/mcp/kb/server.py --config /absolute/config/intel.json
opencode mcp add future-kb --global -- uv run --script /absolute/installed/mcp/kb/server.py --config /absolute/config/future.json
opencode mcp list
```

Replace `/absolute/installed/mcp/kb/server.py` with the actual installed path
above. These commands change active configuration and are operator steps, not
part of installation or tests. Merge manual V2 entries under `mcp.servers`, with
`type: "local"` and the same argument array in `command`; V2 uses `disabled`,
whereas this repository's toolkit manifest uses `enabled`. Do not replace
unrelated configuration or repurpose the managed `dotknewt-kb` entry. Remove your
separately configured connections before uninstalling their executable; the
installer does not own or remove those entries, external configs, or KB data.

Configuration syntax above is documented by the official
[OpenCode V2 MCP guide](https://opencode.ai/v2/docs/mcp-servers), consulted
2026-10-30. Runtime/schema checks are separate evidence; version eligibility
alone is not a compatibility guarantee.

## Publication contract

Only files explicitly indexed in the configured root can be served. Missing,
duplicate, malformed or mismatched entries fail startup; unindexed files are
ignored. The index itself is readable only if explicitly indexed. Publication
eligibility trusts this operator-maintained allowlist, not approval provenance.

An index uses exactly one matching unindented level-two heading and table:

```markdown
## Published-record navigation

| Identifier | Record |
| --- | --- |
| `intel://reports/example` | [Example](reports/example.md) |
```

The heading text must match exactly, without closing hashes, trailing whitespace
or markup. Its section ends at the next unindented level-one/two heading. The
header/separator lines above are exact; data rows have two cells, leading/trailing
pipes, one backtick-wrapped URI and one plain `[label](destination)` link. Only
blank lines may surround the contiguous table within its section. Empty tables,
duplicate matching headings, extra columns, escaped pipes, link titles/escapes,
nested parentheses and multiline cells fail.

Fenced code (backticks/tildes of length >=3, indented at most three spaces) cannot
authorize rows/headings; it closes with the same character and at least the
opening length, with whitespace only afterward. Unclosed fences fail. Indented
code also cannot authorize rows. Code inside the publication section fails its
table-only contract. Files use UTF-8 with LF or CRLF lines.

Destinations are literal relative POSIX `.md` paths. Percent characters are
**rejected, never decoded**, as are absolute paths, backslashes, whitespace,
control characters, colons, query/fragment delimiters, empty/`.`/`..` components.
Targets must be unique by path and file identity; lexical aliases are rejected
rather than normalized. Symlinks and special files are rejected throughout the
component-by-component directory walk.

Each indexed record starts with bounded YAML frontmatter:

```yaml
---
intel_uri: intel://reports/example
title: Example report
type: report
sources:
  - https://example.invalid/source
---
```

The configured URI key, `title`, and `type` are nonempty strings; `type` can be
semantic (for example `malware-family`). The URI must match its indexed identifier
exactly. The prefix is a scheme followed by `://`; authority is nonempty, optional
path/query/fragment remain opaque. Case, Unicode and valid two-hex-digit percent
escapes are preserved. Whitespace/control characters, backslashes, backticks,
pipes, quotes, angle brackets and braces are forbidden. No URI-to-path conversion
occurs. Unknown metadata is bounded/validated but not returned. YAML aliases,
anchors, explicit tags, merge keys and duplicate keys are forbidden; date scalars
remain strings.

## Operations and limits

| Operation | Input | Result |
| --- | --- | --- |
| `kb_list` | `offset=0`, `limit=20` | Metadata records and `next_offset` or null |
| `kb_search` | `query`, `offset=0`, `limit=20` | Literal Unicode-caseless matches, bounded snippets and `next_offset` |
| `kb_read` | exact `uri` | Original Markdown and metadata |
| MCP resources | list cursor / exact read URI | Published URIs / Markdown content |

Arguments are strict; extra fields and type coercion are rejected. Metadata is
`uri`, `title`, `type`, `relative_path`, `byte_size`, and SHA-256 `sha256`; read
adds `content`, search adds `snippet`. Tools return equivalent structured and JSON
text results. Resource cursors are separate from tool offsets, authenticated per
instance, and invalid after process restart.

- Pages default to 20, maximum 100; byte caps can shorten pages further.
- Search query: 1–256 characters; snippets: at most 512 characters.
- Config: 64 KiB; index/record: 1 MiB each; source line/frontmatter: 16 KiB.
- Snapshot: 10,000 unique source files and 64 MiB raw UTF-8 bytes, including the
  index exactly once. Revalidation uses one bounded transient source buffer.
- Metadata: URI/path 1024 UTF-8 bytes, title 512, type 128; YAML scalar 4096,
  at most 1024 nodes and eight nesting levels. Config nesting is at most four;
  root 4096 bytes, index path 1024, prefix/key 64, heading 128.
- Incoming frames: 64 KiB; JSON nesting: eight; IDs: signed 64-bit integer or
  at most 128 UTF-8-byte string. Malformed transport input closes the session
  with a fixed diagnostic rather than echoing content.
- Complete serialized responses: list/search/resource list 256 KiB; reads
  16 MiB; errors 1 KiB; resource cursors 128 ASCII characters.

The server validates an immutable startup snapshot, including a second safe
read of indexed files and the index last. Detected concurrent source changes
fail startup. It does not promise atomic multi-file reads against a hostile host
owner. Restart the **MCP process** to refresh published content; repeating a query
does not reload files. Errors omit source paths and record fragments, so check
operator configuration and this publication contract when startup fails.

Read-only describes the MCP surface, not protection against agents with separate
shell access. Records, source URLs, relative evidence links and fenced queries
remain untrusted reference text: nothing is fetched or executed, including links
outside the root. An approved publication does not authorize an operational action.
