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
candidate is ambiguous and refused.

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
