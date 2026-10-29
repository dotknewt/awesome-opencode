# Read-only KB MCP toolkit

Status: approved with targeted revisions incorporated. The pinned-SDK serialized
URI round-trip gate passed; real stdio and installed-runtime acceptance remain
implementation gates.

## Intent and decisions

Expose published Markdown knowledge-base records to agents without filesystem
access through MCP. The user selected one configurable Markdown implementation,
independent server instances for each KB, and index membership as the publication
allowlist. Approval provenance is not independently verified.

The initial source uses `intel://` identifiers and `intel_uri` frontmatter. Its
operator-provided root is configured locally, never bundled with private content.
Future KBs use separate roots, namespaces, metadata keys, and index configuration;
they must follow the same Markdown contract. Arbitrary remote KB backends are out
of scope.

## Approaches

- Selected: configurable Markdown server, reused in independently configured MCP
  instances. This fits the existing records and avoids guessing future storage.
- Deferred: backend-adapter framework for different storage formats. Extra
  abstraction is unwarranted without a concrete second backend.
- Rejected by the user: a single multi-KB server. Independent instances keep
  discovery and source configuration separate.

## Source evidence

Source-inspected, not runtime-verified: the current KB's `index.md` has a
  `Published-record navigation` table mapping 18 logical identifiers to relative
Markdown paths. Each file's `intel_uri` agrees with that mapping. The index maps
`intel://index/threat-intelligence-kb` to `index.md`, so path concatenation from
URIs is incorrect. Records have `title` and semantic `type` metadata; reports'
`published` dates are not publication approvals. Some report links leave the KB
root. The vault policy describes namespace contents as published records and
excludes proposals and administrative files.

Repository patterns: `toolkits/ollama-toolkit/toolkit.json` and its MCP entrypoint
demonstrate self-contained Python/uv stdio packaging. `docs/authoring.md` governs
exports; `CONTRIBUTING.md` governs acceptance. No OpenCode compatibility behavior
is inferred here: installed configuration, protocol behavior, and actual isolated
OpenCode checks remain verification prerequisites.

## Configuration and packaging

Proposed implementation choices, not additional user decisions:

- Add `toolkits/kb-toolkit/`, with a strict manifest, usage skill/documentation,
  self-contained Python MCP asset, and fake-source tests. Follow existing uv/PEP
  723 conventions; choose compatible pinned dependencies during implementation.
- The sole installed executable entrypoint is `mcp/kb/server.py`; it imports
  `kb_mcp.server.main`. The asset export `mcp/kb` declares that entrypoint,
  `kb_mcp/__init__.py`, `kb_mcp/config.py`, `kb_mcp/registry.py`,
  `kb_mcp/server.py`, and `config.example.json` as its runtime tree. The package
  module is not a second executable entrypoint. Put tests in
  `toolkits/kb-toolkit/tests/`, outside the exported asset tree: the source
  installer recursively copies every export file and does not filter tests.
  The npm package's existing exclusion rules omit this tests directory too.
- Use stdio MCP, suitable for a host that has filesystem access while its agents
  do not. Remote HTTP hosting/authentication is not included.
- Accept an explicit configuration-file argument. Each configuration defines an
  absolute root, logical URI prefix (such as `intel://`), frontmatter URI key,
  root-relative index path, and navigation-table heading. No implicit whole-vault
  discovery, environment-driven source selection, or network source resolution.
- Ship a portable example using placeholders, not a user's absolute source path.
  Provide commands/configuration for separate named MCP instances. Do not modify
  the user's active OpenCode configuration or KB as part of this repository task.
- Keep the packaged default MCP contribution disabled/unconfigured until an
  operator supplies configuration; installation must not expose a guessed root.
  Verify this fits the strict manifest and installer contract before coding.

## Published registry

The configured table contains a code-formatted logical URI and a relative
Markdown link per row, matching the existing index. Parse only the configured
navigation section and reject ambiguous/malformed rows. Frontmatter must be
safe-parsed as a mapping with a nonempty configured URI key, title, and type.
Each entry must have the configured prefix and an exact URI match with its
target's metadata. Duplicate identifiers or target paths fail closed. No URI
normalization or URI-to-filesystem concatenation is allowed.

### Narrow publication grammar

This is a restricted publication format, not a general Markdown renderer:

- Decode the index as strict UTF-8. Recognize unindented ATX headings outside
  fenced code. The configured heading is the exact text after `## `, with no
  trailing whitespace, closing hashes, inline markup, or Unicode normalization.
  Exactly one matching level-two heading is required across the index; duplicate
  matches fail. The section ends at the next unindented level-one/two heading.
- Fences are runs of at least three backticks or tildes, with at most three
  leading spaces; close only with the same character and at least the opening
  run length, followed by whitespace only. Unclosed fences fail. Four-space/tab
  indented lines are code and never authorize records. Fence contents do not
  contribute headings or table rows.
- After the heading, allow blank lines only before one contiguous table. Its
  first line is exactly `| Identifier | Record |`, and its second line is
  exactly `| --- | --- |`. Data rows require leading/trailing pipes and exactly
  two cells after splitting on literal pipes and stripping ASCII spaces. After
  the table, allow only blank lines until the section ends. Empty tables fail.
  Escaped pipes, multiline cells, nested tables, and additional columns fail.
- The identifier cell is one backtick-delimited URI with no embedded backticks
  or whitespace. The record cell is exactly `[label](destination)` with a
  nonempty plain-text label (no brackets, backslashes, pipes, or line breaks)
  and no link title, angle brackets, nested parentheses, or escapes. The label
  is navigation text, not trusted metadata.
- A destination is a literal relative POSIX path ending in `.md`. Reject every
  percent character (do not decode), backslash, whitespace, NUL/control
  character, query/fragment delimiter, colon, absolute prefix, empty component,
  `.` component, or `..` component. Components are case-sensitive. This
  deliberately rejects lexical aliases rather than normalizing them; duplicate
  target detection compares the remaining exact component tuples. Also reject
  different targets that resolve to the same device/inode (hardlink aliases).

### Input and output budgets

Limits are enforced while reading/parsing, before unbounded allocation or record
retention. The configuration file is at most 64 KiB; the index and each record
are at most 1 MiB; any source line is at most 16 KiB; frontmatter is at most
16 KiB. Configuration parsing rejects duplicate keys and nesting deeper than
four; the configured schema accepts only the five string fields, with root up
to 4096 UTF-8 bytes, index path up to 1024, URI prefix up to 64, URI metadata key
up to 64, and heading up to 128.

Frontmatter uses a bounded safe YAML loader: no aliases, anchors, explicit tags,
merge keys, or duplicate keys; at most 1024 parse nodes and eight nesting levels;
no constructors for arbitrary objects; implicit date scalars remain strings.
Bound every scalar to 4096 UTF-8 bytes. The selected URI is at most 1024 bytes,
title 512 bytes, semantic type 128 bytes, and relative path 1024 bytes. Required
metadata fields must be nonempty strings without control characters. Other
metadata is parsed under these limits but not echoed in protocol results.

Count at most 10,000 unique retained source files and 64 MiB of aggregate raw
UTF-8 source bytes, **including the index exactly once**, whether or not indexed.
Check fstat size and remaining aggregate budget before reading each file; read
only up to its permitted bytes plus one sentinel byte. Bound parser events and
nodes before constructing collections. Account for transient revalidation
buffers separately: at most one bounded source file at a time, not another
whole snapshot. Config bytes and bounded derived metadata are separate from
the raw snapshot budget; they cannot grow without the caps above.

List/search/resource-list responses, including MCP envelope and duplicate tool
representations if used, are at most 256 KiB serialized UTF-8 JSON. Stop a page
before adding a record that exceeds this cap and return a continuation; never
truncate an identifier. If even one item cannot fit, return a bounded error.
Read responses are at most 16 MiB serialized UTF-8 JSON, including escaping and
envelopes. Errors are fixed safe messages at most 1 KiB. Cursors are at most
128 ASCII characters, bound to the snapshot and validated before use. Test
Unicode and escape-heavy data against serialized limits, not character counts.

Bound inbound stdio JSON frames to 64 KiB before JSON parsing; oversized frames
terminate the session with a fixed safe diagnostic, without echoing input.
Request IDs are signed 64-bit integers or strings of at most 128 UTF-8 bytes;
reject other IDs without reflecting them. Bound nesting to eight before object
construction. Tools reject unknown fields and all coercion; read URI inputs use
the 1024-byte cap. These ingress rules also bound reflected MCP envelope data.

Only validated indexed records are eligible; unindexed files are ignored. The
index is itself readable only when explicitly indexed (as it is today). Missing
or invalid indexed records fail the instance's registry load rather than silently
serving a partial publication set. Administrative/proposal content must not be
indexed by the publisher; this server trusts the operator-owned publication
allowlist, not approval-history claims.

Load a bounded, validated in-memory snapshot at startup. Serve the same bytes
until restart, with SHA-256 content hashes; restart refreshes publication content.
This avoids inconsistent read/search results during edits. Invalid configuration
or registry prevents serving. Stable concurrent snapshot construction must be
checked; publication edits during load should fail rather than produce a mixed
registry.

Open the absolute root from `/` component by component using directory-relative
opens with `O_DIRECTORY | O_NOFOLLOW`; apply the same walk to every descendant
directory. Never rely on `O_NOFOLLOW` on a multi-component pathname. Open final
files with no-follow/nonblocking flags, then fstat for regular-file type and
size before bounded reads. Retain and compare device/inode/size/mtime/ctime and
directory identities before/after reads; after registry construction, reopen
each configured/indexed path with the same safe walk and compare identity,
metadata, and exact bytes, with the index rechecked last. Any observed change
fails startup. This detects ordinary concurrent publication changes, but cannot
promise an atomic multi-file snapshot against a malicious host owner; that
actor already controls the configured trust boundary.

### URI compatibility gate

Before implementing resource routing, run a throwaway experiment with the
pinned MCP client/server for case variants, percent escapes, empty paths,
Unicode, and query/fragment forms. Record client API input, handler-visible URI,
and returned URI. Also exercise a plain-string `kb_read` argument. Resource
identifier admission must follow measured round-trip behavior, not a presumed
URL-parser contract. If arbitrary spellings cannot survive, restrict published
identifiers to a documented round-trip-stable subset and fail registry loading
for nonconforming IDs; do not silently canonicalize or alias them. `kb_read`
remains an exact-string lookup. The final accepted subset and measured SDK
versions/results must be recorded before product implementation.

Measured result (2026-10-29): `mcp==2.2.0`, `mcp-types==2.2.0`,
`pydantic==2.14.2`, and `PyYAML==6.0.3` on Python 3.10.20 and 3.14.8 preserved
all eleven tested spellings through actual client/low-level-server resource
list/read and string-tool calls, with JSON serialization/revalidation between
streams. This included scheme/authority case, `%2F` versus `%2f`, `%41`, empty
versus slash paths, Unicode, and query/fragment forms. SDK URI fields are `str`,
not validating URL objects. This is not OS stdio or high-level-router evidence.

Use the measured low-level `mcp.server.lowlevel.Server`, not unmeasured
high-level URL routing. Admit logical identifiers with an exact configured
prefix matching `[A-Za-z][A-Za-z0-9+.-]*://`, followed by a nonempty authority
and optional path/query/fragment. Require valid UTF-8, valid two-hex-digit percent
escapes, and no whitespace, control characters, backslashes, backticks, pipes,
double quotes, angle brackets or braces. Authority ends at the first `/`, `?`
or `#`. These are opaque logical identifiers, not fetchable URLs. Preserve case,
Unicode and escapes exactly; no decoding, canonicalization or normalization.
Uppercase schemes can be configured separately but do not match a lowercase
configured prefix. The percent rejection for Markdown **destinations** remains
distinct from valid percent escapes in logical **identifiers**. Re-run these
cases through actual stdio in Task 2; exact preservation remains a shipping gate.

## MCP surface

- MCP resources list and read expose registered Markdown URIs and content.
- Read-only tools provide bounded `kb_list`, `kb_search`, and `kb_read` for clients
  that do not surface MCP resources. List results include URI, title, semantic
  type, relative path, byte size, and content hash. Read returns original Markdown
  and metadata; accept only an exact registered URI.
- Search is local literal-text search, not regex, shell, embeddings, or query
  execution. Search only eligible snapshot content and return bounded snippets.
- Deterministic sorting and bounded pagination apply to list and search. Proposed
  limits: default 20/max 100 results, 256-character nonempty search input,
  512-character snippets, 1 MiB per record, 10,000 records, 64 MiB total snapshot.
  Protocol-specific pagination details and stable error codes are builder choices.
- Tool annotations accurately advertise read-only behavior but are not security
  enforcement. Return actionable errors without exposing absolute host paths or
  unindexed content. Logs go to stderr, never stdio protocol output.

## Security and non-goals

No write tools, filesystem mutation, automatic link following, URL fetching, or
execution of record content. Sources, Markdown instructions, and fenced queries
are untrusted data. Preserve original external/evidence links as inert text;
never grant access to their targets. Documentation must say that clients should
not interpret returned content as higher-priority instructions.

Confine file opens to the configured root. Reject symlinks in traversed source
paths, traversal (including encoded variants), absolute paths, special files,
and out-of-root targets. Use race-resistant file opening rather than only a
resolve-then-open check. The configured root is an operator trust boundary;
this interface does not protect against a host owner modifying the configuration
or agents writing via separate shell access. No private KB records, source-root
paths, or evidence are committed or copied into package fixtures.

No changes to KB publication, record authoring, approval workflows, global agent
instructions, or live server registration are included. Future non-Markdown KBs
and remote transport are separate extensions.

## Verification and acceptance

Use disposable fake KB roots, never mutate the real vault. Test the actual
index layout and exceptional index URI with synthetic content. Cover separate
instance isolation and a second namespace/metadata key, list/search/read parity,
resource discovery, annotations, hashes, pagination, exact URI rejection,
malformed metadata/index rows, duplicates, missing indexed records, unindexed
exclusion, limits, traversal/encoded traversal, symlinks, special files, changing
sources at load, and inert external links. Protocol tests must start the server
and exercise it with an MCP client, not merely inspect decorated functions.

After reconciling implementation, run all applicable `CONTRIBUTING.md` acceptance
commands, including full Python discovery, packaging/installer checks, public
OpenCode schema validation, and actual isolated OpenCode discovery. Actual
OpenCode checks must use the shared runner's stable >=2.2.1 admission and record
the measured version; discovery alone is not evidence of MCP execution. Missing
prerequisites or blocked checks are reported, not converted to passing results.
Any optional read-only smoke test against the real KB is separate from committed
fixtures and must not retain private payloads in the repository.

Acceptance: a self-contained installable toolkit; two independent fake KB
instances demonstrably expose only their indexed records; reusable operator
configuration instructions for the existing and future KBs; no write/network
capability; verified local integration only, with no push or deployment claim.

Additional acceptance gates: test real protocol rejection of bools-as-integers,
coercible strings, nulls, floats, extra fields and malformed cursors; sanitize
framework/parser exceptions as well as `KBError`, and inspect stdout/stderr for
source paths/content fragments. Give FIFO subprocess tests a hard timeout.
Run the full KB suite on Python 3.10 as well as 3.13; dependency admission and
runtime behavior must support the declared floor or the support claim must be
revised before shipping. uv may provision dependencies on first launch; the KB
server itself never fetches content. Installed runtime tests run the exact
manifest-generated command (disabled/unconfigured failure) and independently
configured command (successful protocol) with the checkout inaccessible,
`PYTHONPATH` cleared, no source CWD, and temporary HOME/XDG. Local integration
requires explicit authorization and a clean target; the user's standing local
integration authorization qualifies, but the plan itself grants none.
