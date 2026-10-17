# Architecture

## Catalog and package

`toolkits/<name>/toolkit.json` is the canonical manifest. Schema version 1
declares identity, independent SemVer, license, platform/executable dependencies,
exports, required skills, and native local MCP contributions. Validation rejects
unknown fields, path traversal, symlinks, special files, undeclared references,
and contributions outside native destination namespaces.

The npm package ships compiled installer JavaScript, schemas, manifests, toolkit
runtime/docs, and root metadata. Tests, eval fixtures, TypeScript, caches,
bytecode, and planning files are excluded. Payloads are copied as real files, so
installed content has no dependency on the package source or repository checkout.

## Targets and layout

Project scope resolves `--project` to an absolute root and installs under:

```text
PROJECT/
  opencode.json                 # default; an existing supported JSON/JSONC candidate may be selected
  .opencode/
    skills/<name>/...
    awesome-opencode/
      toolkits/<toolkit>/...    # managed non-skill assets
      state.json                # ownership, hashes, modes, versions, config expectations
      journal.json              # present only for an interrupted transaction
      lock                      # owner diagnostics
      lock.os                   # kernel-lock inode
```

Supported project config candidates are root `opencode.json`/`opencode.jsonc`
and `.opencode/opencode.json`/`.opencode/opencode.jsonc`. More than one existing
candidate is ambiguous and refused when an operation manages MCP configuration.

Global scope uses `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode`, for the
payload, state, and `opencode.json`/`opencode.jsonc`. It does not write a project.

Libvirt VM lifecycle data is separate: `$XDG_DATA_HOME/libvirt-toolkit` or
`~/.local/share/libvirt-toolkit`, optionally overridden by server `--state-dir`.
Installer uninstall never owns or removes that directory.

## Planning, ownership, and transactions

The engine preflights complete desired changes. Files have one toolkit owner and
are recorded with absolute path, SHA-256 content hash, and mode. Existing unowned
destinations are refused even when identical. Existing owned files must still
match their hash/mode. MCP ownership is per `(config path, entry name)` and the
entry is compared structurally, so harmless JSON key ordering does not matter
but semantic local edits block update/uninstall.

Target resolution computes candidate paths without accessing them. Listing and
file-only install/uninstall operations omit configuration when their selected
desired manifests and selected installed records contain no MCP entries. Their
file/state ownership checks still apply, but unrelated configuration candidates
are not inspected, parsed, snapshotted, created, or written. A recorded
`configPath` on a legacy file-only state record remains valid inert metadata.

Update verifies every installed record, even when toolkit names were explicitly
selected. It omits configuration only when no installed record owns MCP and no
requested update manifest contributes MCP. Otherwise it resolves configuration
strictly. Install/uninstall similarly require configuration when any selected
desired manifest contributes MCP or any selected installed record owns an MCP
entry. Resolution rejects
ambiguous, malformed, duplicate-key, symlinked, and non-file candidates, records
all candidates in the race-safe transaction read set, and verifies prior owned
entries. This includes removing the last entry, no-catalog uninstall, and
no-name update. Mixed file/MCP batches therefore fail atomically at that boundary
before payload or state writes. An explicit file-only install/uninstall does not
pull an unselected installed MCP toolkit into configuration planning; update
does account for all installed MCP ownership.

Mutations are journaled with complete before/after snapshots and applied with
atomic replace, fsync, and precondition rechecks. Ordinary failures attempt
rollback. A later mutation detects an interrupted journal and performs guarded
rollback only if resources match recorded before/after states. Dry-run reports
pending recovery but intentionally makes zero writes.

On Linux the parent opens `lock.os`; util-linux `flock` locks inherited FD 3 in a
short-lived child. The lock belongs to the shared open-file description and
remains held by the parent's still-open descriptor after the child exits. The
parent closes it only after apply/recovery/failure handling. Metadata is for
diagnostics and legacy recovery, not the concurrency primitive.

Directories are never recursively removed during normal uninstall, preserving
user additions. Path checks reject symlink parents/leaves and special resources.

### Update across a moved root

`update` can repair a moved project or selected global config root when prior
ownership can be proven safely. It verifies the current copy of every installed
toolkit and its owned MCP state, then rebases every installed ownership record.
Requested toolkit payloads are loaded/replaced and their versions changed; an
unnamed update loads and updates all installed toolkit payloads. Unsafe
historical state or journal references fail
closed. Distinct overlapping previous/current payload roots are rejected before
further planning; same-root rename current access is permitted. Initial
selected-state discovery and shared ancestors are outside the bounded stale
resource guarantee. After provenance is established, no stale-resource reads or
writes are expected. This is not a general observer guarantee, and no other
installer operation is a relocation operation. Dry-run reports the plan without
recovery or writes.

## Native OpenCode integration

For each local MCP contribution, the engine resolves the entrypoint inside the
managed toolkit root and writes a native local entry with an absolute path:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "dotknewt-libvirt": {
      "type": "local",
      "command": ["uv", "run", "--script", "/absolute/path/server.py"],
      "enabled": true
    }
  }
}
```

OpenCode discovers skills from `.opencode/skills`. No Claude registration,
marketplace projection, or plugin-root substitution participates. Installation
does not start the server; OpenCode must be restarted.

Absolute paths intentionally prevent runtime dependence on a working directory,
but make target relocation a lifecycle boundary. See README's move procedure.
