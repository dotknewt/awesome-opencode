# libvirt-toolkit

Native OpenCode toolkit for a bounded `qemu:///session` libvirt lifecycle and a
verified handoff into guest SSH access. Version `0.2.0` adds per-creation,
project-local guest credentials and offline complete replacement of the selected
account's login keys before first boot.

## Contributions

- `dotknewt-libvirt-vms`: template publication, linked working VMs, power,
  external powered-off snapshots, recovery gates, and provider handoff.
- `dotknewt-guest-access`: provider-neutral SSH trust, authentication, transfer,
  and requested regular-user execution, including its installed project
  credential helper.
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

Dependencies are feature-scoped even though the manifest enumerates every
toolkit executable: lifecycle-only calls use `uv`, `virsh`, and `qemu-img`;
credentialed `vm_create` additionally requires host `virt-customize` and
`virt-cat`; the client helper requires Python 3.10+ and Ed25519-capable
`ssh-keygen`. Prepared guests require POSIX `/bin/sh`, OpenSSH server `sshd`,
`ssh-keygen`, and the commands listed in each template reference. Ubuntu/Debian
install `openssh-server` and `openssh-client`; CachyOS/Arch installs `openssh`.
SSH/SCP/rsync are access/transfer clients, with rsync preferred and SCP optional.

For every new dev VM, run the installed helper's `prepare` operation before
`vm_create`, pass only `guest_user` and public-key text, and bind the unchanged
local `creation_id` to the separately returned VM UUID and matching
`guest_access` account/fingerprint. The provider never receives private-key
content or the local creation ID. Start, reconnect, and snapshot restore verify
and reuse the bound credential; uncertain creation preserves pending state.
Every guest SSH/transfer command uses the generated strict project config and
project trust store. `/.libvirt-toolkit/` is Git-ignored by the helper and must
also be explicitly excluded from project transfer.
The helper's `enroll` operation validates an independently trusted Ed25519
fingerprint against a candidate scan file, derives the exact direct/IPv6/alias
lookup token, and updates the credential-local trust store with no-follow file
operations under a lock. It never reads personal SSH stores.

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
