# libvirt-toolkit

Native OpenCode toolkit for a bounded `qemu:///session` libvirt lifecycle and a
verified handoff into guest SSH access. Version `0.1.0` migrates the behavior of
the original `libvirt-toolkit` 1.0.7 without changing its lifecycle core.

## Contributions

- `dotknewt-libvirt-vms`: template publication, linked working VMs, power,
  external powered-off snapshots, recovery gates, and provider handoff.
- `dotknewt-guest-access`: provider-neutral SSH trust, authentication, transfer,
  and requested regular-user execution.
- `mcp/libvirt/server.py`: local stdio MCP server pinned to `mcp==2.2.0` by its
  PEP 723 launcher.

The manifest's MCP `entrypoint` is relative to the managed installed-toolkit
root, not the source tree. The installation engine finds the asset export whose
`destination` contains that entrypoint, copies from the export's `source`, then
resolves the installed destination to write this native OpenCode entry with an
absolute server path. This also keeps nonidentity source/destination mappings
correct:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "dotknewt-libvirt": {
      "type": "local",
      "command": [
        "uv",
        "run",
        "--script",
        "/absolute/installed/toolkit/mcp/libvirt/server.py"
      ],
      "enabled": true
    }
  }
}
```

OpenCode must be restarted after installation or configuration changes. The
installer must not start this server or perform any VM operation.

The installer owns this MCP entry structurally. Changing its command, enabled
state, or other fields causes later update/uninstall to stop with a conflict
rather than overwrite the edit. Restore the installed entry before retrying, or
restore and uninstall before taking over the entry manually.

## Prerequisites and boundary

Linux is the supported server platform. Install `uv`, `virsh`, and `qemu-img`,
and configure the toolkit owner’s `qemu:///session`. First server launch needs
network access or a populated `uv` cache for `mcp==2.2.0`. `passt` is optional
and required only for the documented per-VM loopback-forwarding path.

Toolkit state defaults to `$XDG_DATA_HOME/libvirt-toolkit` or
`~/.local/share/libvirt-toolkit`. It is VM lifecycle data, not CLI installation
state, and must never be removed by uninstalling this toolkit.

The configured launcher path and installer state are absolute. `update` cannot
repair a moved project or XDG configuration root. Uninstall at the old location,
move, reinstall at the new location, and restart OpenCode. If it was already
moved, put it back at the exact old path first. VM lifecycle data is separate and
does not move with the OpenCode installation.

The managed configuration always runs on the local OpenCode host as the local
user. Remote stdio over SSH is a manual deployment described in the server
README; the installer does not copy the server, configure SSH, or support one
installation across multiple libvirt hosts.

Tests use fake host adapters and temporary files. They do not connect to libvirt
or start, stop, create, or remove a real VM.
