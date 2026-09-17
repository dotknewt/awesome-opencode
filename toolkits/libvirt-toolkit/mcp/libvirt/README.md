# Libvirt toolkit MCP server

This local stdio server exposes the toolkit's bounded `qemu:///session`
lifecycle operations. It uses `virsh` and `qemu-img`; credentialed VM creation
also uses libguestfs `virt-customize` and `virt-cat`. It does not need Python
libvirt bindings or a daemon of its own.

## Prerequisites

- Python 3.10 or newer
- [`uv`](https://docs.astral.sh/uv/)
- `virsh`, `qemu-img`, and a working per-user `qemu:///session`
- `virt-customize` and `virt-cat` only when `vm_create` supplies guest access
- Network access on the first launch so `uv` can acquire the launcher's pinned
  official Python MCP SDK dependency (`mcp==2.2.0`)

The launcher uses PEP 723 metadata and does not modify user Python
configuration. From this directory, discover the tools without contacting
libvirt by using an MCP client; actual tool calls inspect or mutate the local
user's libvirt session.

Credentialed creation requires both `guest_user` and one option-free
`ssh-ed25519` public-key line. Before any domain definition, the server modifies
only the new writable overlay, completely replaces the account's effective
`.ssh/authorized_keys`, and returns the VM UUID plus `guest_access` account,
public-key fingerprint, and status. It never accepts a client creation ID,
private-key path, or private-key bytes. Prepared guests must meet the exact
account/path/SSHD/cloud-disable/marker contract in the installed
`dotknewt-libvirt-vms` skill's distro references. Omit both guest arguments for
lifecycle-only creation; supplying exactly one is invalid.

```sh
uv run --script server.py
```

Managed data defaults to `$XDG_DATA_HOME/libvirt-toolkit`, or
`~/.local/share/libvirt-toolkit` when `XDG_DATA_HOME` is unset. Override it for
an isolated host or test account:

```sh
uv run --script server.py --state-dir /absolute/path/to/libvirt-toolkit-state
```

Startup and unexpected adapter diagnostics go to stderr so stdout remains an
MCP protocol stream. Expected lifecycle failures are MCP tool-error results with
machine-readable `code`, `message`, and `details` fields.

The lifecycle core accepts legacy text and modern nested file-backed UEFI NVRAM.
It rejects host-backed or stateful device XML outside the toolkit's documented
narrow contract before mutation. CPU and memory overrides also fail before a
journal is created when topology, pinning, NUMA, hotplug, or maximum-memory XML
would make a partial rewrite inconsistent. Timeout errors retain bounded,
normalized partial stdout/stderr and mark external side effects as unknown.

## Remote stdio over SSH

This is an explicit manual deployment, not an installer feature or verified
multi-host topology. The native installer entry always launches its managed
server locally; do not edit that owned entry and expect later installer updates
or uninstall to accept it.

Copy this entire directory to the remote VM owner's host, ensure the
prerequisites are installed there, and configure the client to run the same
launcher over a non-interactive SSH session:

```sh
ssh -T vm-owner@libvirt-host -- \
  uv run --script /absolute/path/to/libvirt/server.py \
  --state-dir /absolute/path/to/libvirt-toolkit-state
```

Paths, state, `qemu:///session`, and VM ownership are always relative to the
machine and user running the server. Startup never installs a service or changes
SSH configuration.

## Tests

The installed-toolkit acceptance test requires the `uv` executable. It launches
the copied PEP 723 server with `uv run --script ... --help` after deleting a
disposable source copy, using isolated HOME/XDG/UV state. First use needs network
access or a populated cache for the pinned dependencies; CI installs `uv`
explicitly and does not skip this acceptance.

Run the MCP tests in a temporary `uv` environment:

```sh
PYTHONDONTWRITEBYTECODE=1 \
uv run --isolated --python 3.13 --with 'mcp==2.2.0' \
  python -m unittest discover -s tests -p 'test_mcp.py' -v
```

The tests inject a fake lifecycle adapter and use temporary files/processes.
`test_guest_access.py` executes generated guest scripts against an isolated
temporary root and requires real `sshd` plus `ssh-keygen`; it does not skip when
they are absent. Dedicated Debian/Ubuntu checks must install `openssh-server`
and `openssh-client` (CachyOS/Arch: `openssh`). The suite does not contact
libvirt or run VM operations.
