# awesome-opencode

`awesome-opencode` distributes self-contained, native OpenCode toolkits.

## Bun-first development

This repository uses **Bun** as the default package manager for development.
Documented npm commands are retained only for interoperability checks.

## Available toolkits

- `project-toolkit` installs the on-demand `dotknewt-handling-todos` skill for
  TODO and backlog workflows. It does not inject always-loaded rules or change a
  consumer's `AGENTS.md`.
- `libvirt-toolkit` installs two namespaced skills and a local Python MCP server
  for a bounded `qemu:///session` workflow.

## Requirements

- Linux and Node.js 22 or newer for installer mutations.
- The **util-linux** implementation of `flock` on `PATH`. The parent installer
  opens the target lock file, a short-lived `flock` child locks that inherited
  file descriptor, and the parent retains the descriptor until recovery and the
  complete transaction finish. Other `flock` implementations are not supported.
- For the libvirt MCP server: Python 3.10+, `uv`, `virsh`, `qemu-img`, and a
  working per-user `qemu:///session`. Credentialed VM creation additionally
  needs `virt-customize` and `virt-cat`; the project credential helper needs
  `ssh-keygen`. `passt` is optional for the documented loopback-forwarding
  workflow, and SSH/rsync/SCP are access/transfer clients.
- Network access on first MCP launch, or a populated `uv` cache, so `uv` can
  acquire the pinned `mcp==2.2.0` dependency.

Installing content does not start the MCP server, contact libvirt, or operate a
VM. Restart OpenCode after an applied install, update, or uninstall.

## CLI

Install the CLI globally from Git using Bun, then invoke it directly:

```sh
bun install --global --trust https://github.com/dotknewt/awesome-opencode.git
export PATH="$(bun pm bin -g):$PATH"
awesome-opencode --version
awesome-opencode --help
```

The Git install uses the `prepare` lifecycle to build and validate the CLI;
`--trust` explicitly permits that dependency lifecycle script. `bun pm bin -g`
prints the global executable directory itself, commonly `$HOME/.bun/bin`, which
must be on `PATH` when invoking `awesome-opencode` directly.

npm remains supported as an interoperability path for Git installation:

```sh
NPM_CONFIG_ALLOW_GIT=root npm install --global https://github.com/dotknewt/awesome-opencode.git
awesome-opencode --version
```

Leave lifecycle scripts enabled. `NPM_CONFIG_ALLOW_GIT=root` permits the direct
Git dependency on npm versions that require explicit Git-source permission.

When working in this repository's source checkout, initialize it separately:

```sh
bun install --frozen-lockfile
bun run build
bun dist/installer/src/cli.js --help
```

The explicit `dist` entrypoint deterministically runs this checkout's built CLI;
`bunx awesome-opencode` may instead resolve a registry or globally installed
package because a package's own executable is not installed into its local
`node_modules/.bin`. Use `awesome-opencode` directly to run the global CLI.

For toolkit operations, use an absolute target path:

```text
awesome-opencode list (--project PATH | --global)
awesome-opencode install <toolkit...> (--project PATH | --global) [--dry-run]
awesome-opencode update [toolkit...] (--project PATH | --global) [--dry-run]
awesome-opencode uninstall <toolkit...> (--project PATH | --global) [--dry-run]
awesome-opencode validate
awesome-opencode --help
awesome-opencode --version
```

```sh
awesome-opencode install libvirt-toolkit --project /absolute/project --dry-run
awesome-opencode install libvirt-toolkit --project /absolute/project
awesome-opencode update --project /absolute/project
awesome-opencode uninstall libvirt-toolkit --project /absolute/project
awesome-opencode install libvirt-toolkit --global
```

Install the project workflow skill with either target selector:

```sh
awesome-opencode install project-toolkit --project /absolute/project
awesome-opencode update project-toolkit --project /absolute/project
awesome-opencode uninstall project-toolkit --project /absolute/project
awesome-opencode install project-toolkit --global
awesome-opencode update project-toolkit --global
awesome-opencode uninstall project-toolkit --global
```

Restart OpenCode after an applied install, update, or uninstall. The installed
`dotknewt-handling-todos` skill is discoverable and loaded on demand when its
TODO/backlog trigger matches; it is not an always-loaded rule.

`--project` resolves relative input against the current directory, but absolute
input is recommended for auditable automation. `--global` uses
`$XDG_CONFIG_HOME/opencode`, falling back to `~/.config/opencode`. Exactly one
target selector is required. `update` without names updates installed toolkits
only. After moving an installed project or selected global config root, `update`
can prove prior ownership, verify every installed toolkit's current copy, and
rebase all installed records. Payloads and versions change only for explicitly
requested toolkits; without names, all installed toolkits are updated. A dry run
performs no recovery, locking, directory
creation, config edit, or state write.

Listing and file-only install/uninstall operations do not inspect, parse,
snapshot, create, or edit OpenCode configuration candidates. For those operations,
configuration is required when a selected desired manifest contributes MCP
entries or a selected installed record owns MCP entries. Update verifies all
installed records, regardless of the requested toolkit names, so it skips
configuration only when no installed record owns MCP entries and no requested
update manifest contributes MCP entries. A no-name update requests every
installed toolkit.

When configuration is not required, its candidate paths and targets remain
untouched; file-only toolkits can therefore coexist with consumer-managed config
symlinks and unrelated configuration shapes.

For install/uninstall and first-MCP selection, multiple existing supported
configuration candidates are refused. When update has installed MCP ownership,
it resolves the unique owner: an unrelated valid candidate may remain, but
competing entries or split ownership are refused. Malformed JSON/JSONC and
symlinked or non-file candidates are refused rather than followed or replaced.
A mixed file-and-MCP batch fails before payload or state writes when these checks
fail. Selecting only a file-only toolkit for install/uninstall does not make an
unselected installed MCP toolkit's configuration part of that operation. Update
is different: its all-record verification includes installed MCP ownership even
when the named update payloads are file-only.

New configuration receives `$schema: "https://opencode.ai/config.json"`. The
native entry is:

```json
{
  "type": "local",
  "command": ["uv", "run", "--script", "/absolute/managed/server.py"],
  "enabled": true
}
```

The installer preserves unrelated configuration and owns only its exact MCP
entry and declared files. An unowned collision or a locally changed owned file
or entry is a conflict, not permission to overwrite. Restore the recorded
installed content before retrying, or restore it and uninstall before replacing
it with a manually managed variant. Interrupted mutations are journaled; the
next non-dry-run mutation attempts guarded rollback only when every affected
resource still matches its recorded before/after form. Intervening edits must be
reconciled first.

Uninstall removes owned toolkit files and its structurally matching MCP entry.
It does not recursively remove directories with user additions and never removes
libvirt VM data. Libvirt data defaults to `$XDG_DATA_HOME/libvirt-toolkit` or
`~/.local/share/libvirt-toolkit`.

### Moving a target

Use `update` after moving an installed project or selected global OpenCode
configuration root. The update path is intentionally narrow: it must establish
historical ownership from installer state, reject unsafe or unprovable prior
locations, and verify all currently installed owned files and MCP entries before
changing anything. It rebases ownership records for every installed toolkit,
and updates payloads/versions for the requested toolkits; an unnamed update
updates all installed toolkits. Use `--dry-run` first to inspect planned changes
without writes.

An unsafe prior state or journal reference is refused; restore the exact
original location and resolve an interrupted transaction there before retrying.
Distinct overlapping previous/current payload roots are refused before further
planning; same-root rename current access is supported. Initial selected-state
discovery and shared ancestors may access the old tree, but after ownership
provenance is established the bounded guarantee is no stale-resource reads or
writes. No general filesystem observer is claimed. This behavior follows the
bounded candidate policy described in [compatibility evidence](docs/compatibility.md),
not a guarantee about every OpenCode configuration source. Restart OpenCode
after a successful applied update. This procedure does not relocate the separate
VM data directory. Do not hand-edit installer state to simulate relocation.

### Remote libvirt hosts

The managed MCP entry always runs locally as the OpenCode user and therefore
uses that user's local `qemu:///session`. The installer does not provision SSH,
copy content to another host, or support one installation controlling multiple
hosts. A remote stdio-over-SSH deployment is an explicit manual mode documented
in [`toolkits/libvirt-toolkit/mcp/libvirt/README.md`](toolkits/libvirt-toolkit/mcp/libvirt/README.md):
copy the entire server directory to the remote account, install prerequisites
there, and configure SSH transport yourself. That manual configuration is not
installer-owned or covered by native discovery acceptance.

## Documentation and verification

- [Architecture](docs/architecture.md)
- [Compatibility and measured evidence](docs/compatibility.md)
- [Toolkit authoring](docs/authoring.md)
- [Contributing](CONTRIBUTING.md)
- [Design decisions](docs/decisions/)
- [Libvirt toolkit operation](toolkits/libvirt-toolkit/README.md)
- [Project toolkit operation](toolkits/project-toolkit/README.md)

See `CONTRIBUTING.md` for complete acceptance commands. Tests use temporary
targets and fake lifecycle adapters; no CI job starts libvirt or performs VM
actions.
