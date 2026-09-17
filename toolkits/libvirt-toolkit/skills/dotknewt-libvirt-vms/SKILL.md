---
name: dotknewt-libvirt-vms
description: Use when preparing or publishing Ubuntu, Debian 13, or CachyOS QCOW2 templates, managing libvirt working VMs through the dotknewt-libvirt MCP server, or continuing a project-in-VM request into provider networking and a guest-access handoff.
---

# Managing Libvirt VMs

Use the toolkit's MCP operations for bounded lifecycle work on managed
`qemu:///session` VMs. Keep host selection, power-state gates, and ownership
checks explicit. Compatibility depends on domain devices and storage, not an OS
allowlist. Ubuntu, Debian 13, and CachyOS have documented preparation paths; a shut-off
domain still needs guest identity preparation before publication. Open a source
preparation reference only when the user asks to prepare or install a template:

- Ubuntu: `references/ubuntu-template.md`.
- Existing Debian 13 (`debian13-dev-template`): `references/debian-template.md`.
- Existing CachyOS (Arch-based, UEFI): `references/cachyos-template.md`.

For a request that requires reaching a new or existing VM, copying a project, or
running commands in the guest, continue through **Guest-access handoff** below.
Keep listing, inspection, power, snapshot, publication, and deletion requests
bounded to lifecycle unless the user also requests guest access or execution.

## Select the host first

1. Identify the MCP connection name that represents the requested host. The
   installed `dotknewt-libvirt` connection is local; remote deployments should have a
   distinct name such as `libvirt-lab`.
2. Call `host_info` through that connection before mutation and confirm the
   returned host/session fits the request.
3. Keep every operation for a workflow on that connection. `qemu:///session`,
   toolkit state, domains, and absolute storage paths belong to the server host
   and the user running the server. Do not mix results or paths between hosts.

## Lifecycle workflow

| Intent | MCP operation | Required handling |
|---|---|---|
| Discover | `host_info`, `template_list`, `vm_list`, `vm_inspect` | Inspect before changing state. |
| Publish | `template_publish` | Source must be prepared, supported, and shut off. |
| Create | `vm_create` | Use a published name/version and unique VM name. |
| Power | `vm_start`, `vm_shutdown`, `vm_force_stop` | Force-stop only after explicit user authorization. |
| Snapshot | `snapshot_list`, `snapshot_create`, `snapshot_restore` | VM must be shut off with no managed-save state. |
| Remove | `vm_delete`, `template_remove` | Confirm target; templates with dependents are rejected. |

For graceful shutdown, call `vm_shutdown` with a bounded wait. A timeout is not
proof that shutdown failed or succeeded, and the operation never escalates to a
force-stop. Call `vm_inspect` again. Continue with a shut-off-only operation only
after the VM reports shut off; ask separately before `vm_force_stop`.

## Guest-access handoff

Do not stop a project-in-VM request after `vm_start`. Open
`references/guest-access.md`, confirm the provider host, VM owner, session,
domain, network path, and endpoint provenance, and preserve all lifecycle,
ownership, graceful-shutdown, and recovery gates while preparing access.
Before adding a passt forward, verify that `passt` is available to the VM owner
on the selected host; a missing or unauthorized backend blocks persistent XML
changes for that path.

Create or update this handoff for both newly created and existing clones:

```markdown
## Guest-access handoff
- Requested outcome:
- Provider / host / owner / session / domain:
- Connection origin:
- Candidate endpoint and provenance:
- Intended account / home:
- Domain and guest identity evidence:
- Available tooling:
- Lifecycle: untested
- Guest prerequisites: untested
- SSH authentication: untested
- Clone identity: untested
- Transfer: untested
- Requested execution: untested
```

Populate known provider fields and leave unknown values explicit. Use only
`verified`, `failed`, `untested`, or `not applicable` for stage status. Invoke
`dotknewt-guest-access` by name with this record after the provider path and endpoint are
ready. Keep QGA diagnostics, SSH authentication, clone identity, transfer, and
regular-user execution as separate claims; a running domain or successful QGA
probe does not complete the requested guest workflow.

## Clone and snapshot model

Each working VM gets an exclusive writable QCOW2 overlay over an immutable
published image, a fresh domain UUID/MAC addresses, and an independent NVRAM
copy when UEFI NVRAM exists. Deleting one working VM must not alter another.
Guest machine identity must have been prepared to regenerate at first boot;
libvirt identifiers alone do not make a guest independent.

Toolkit snapshots are powered-off disk/configuration/NVRAM layers, not native
`virsh` snapshot or checkpoint objects. They contain no RAM. Restoring creates a
fresh writable child, preserves the working VM identity, and leaves it shut off.

## Rejections and interrupted operations

On an MCP error, report its `code`, `message`, and relevant `details`. Do not bypass
a rejection. Do not edit ownership metadata, retry a mutating operation blindly,
or substitute shell commands. Correct the stated precondition and reinspect.

`recovery_required` means a partial operation left a host-local journal. Stop
mutations. On the server host, the VM owner must manually compare the journal's
domain/storage resources with libvirt and toolkit metadata, reconcile them, and
remove the journal only after recovery is verified. Preserve its path and
diagnostics for the operator.

## V1 boundaries

V1 accepts one writable file-backed QCOW2 disk and optional file-backed UEFI
NVRAM in legacy text or nested file-source XML. Extra writable disks,
block/network disks or firmware, stateless/separate-varstore firmware, host
serial/evdev, shared-memory devices (`shmem`) or memory devices, direct kernel/initrd boot, shared
filesystems, passthrough, TPM, and unknown device kinds are rejected. A standard
virtio RNG backed by `/dev/urandom` and fixed read-only firmware loaders are
supported. The observed CachyOS `memoryBacking` with `source type="memfd"` and
`access mode="shared"` is retained; it is not a shared-memory device. CPU/memory
overrides are rejected when topology, pinning, per-vCPU,
NUMA, max-memory, or hotplug relationships would make the rewrite inconsistent;
omit the override to retain otherwise compatible source relationships. Windows
guests requiring TPM are unsupported until a follow-up adds a tested ownership
model. No operation runs commands in a guest, copies projects, migrates VMs,
transfers remote disks, or takes live/RAM snapshots.

## Common mistakes

- Treating a shutdown timeout as permission to snapshot or force-stop.
- Calling toolkit snapshots native libvirt snapshots.
- Reusing a local path or state result with a remote MCP connection.
- Assuming linked disks also reset guest machine or SSH identity.
- Deleting a recovery journal before reconciling every listed resource.
