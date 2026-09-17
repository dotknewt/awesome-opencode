# awesome-opencode

`awesome-opencode` distributes self-contained, native OpenCode toolkits. The
initial `libvirt-toolkit` installs two namespaced skills and a local Python MCP
server for a bounded `qemu:///session` workflow.

## Requirements

- Linux and Node.js 22 or newer for installer mutations.
- The **util-linux** implementation of `flock` on `PATH`. The parent installer
  opens the target lock file, a short-lived `flock` child locks that inherited
  file descriptor, and the parent retains the descriptor until recovery and the
  complete transaction finish. Other `flock` implementations are not supported.
- For the libvirt MCP server: Python 3.10+, `uv`, `virsh`, `qemu-img`, and a
  working per-user `qemu:///session`. `passt` is optional for the documented
  loopback-forwarding workflow.
- Network access on first MCP launch, or a populated `uv` cache, so `uv` can
  acquire the pinned `mcp==2.2.0` dependency.

Installing content does not start the MCP server, contact libvirt, or operate a
VM. Restart OpenCode after an applied install, update, or uninstall.

## CLI

Install the package by your normal npm package source, then use an absolute
target path:

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

`--project` resolves relative input against the current directory, but absolute
input is recommended for auditable automation. `--global` uses
`$XDG_CONFIG_HOME/opencode`, falling back to `~/.config/opencode`. Exactly one
target selector is required. `update` without names updates installed toolkits
only. A dry run performs no recovery, locking, directory creation, config edit,
or state write.

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

MCP commands and ownership state contain absolute paths. The current engine
cannot repair a project or XDG config root after it has moved, and `update` from
the new location is **not** a relocation operation. Before moving, uninstall at
the old path, move the project/config root, reinstall at the new path, and
restart OpenCode. If already moved, return it to the exact old absolute path,
uninstall there, then move and reinstall. This does not affect the separate VM
data directory. Do not hand-edit installer state to simulate relocation.

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

See `CONTRIBUTING.md` for complete acceptance commands. Tests use temporary
targets and fake lifecycle adapters; no CI job starts libvirt or performs VM
actions.
