---
name: dotknewt-libvirt-vms
description: Use when preparing or publishing Ubuntu, Debian 13, or CachyOS QCOW2 templates, managing libvirt working VMs, protecting a supplied source while tests run on an isolated clone, or continuing a project-in-VM request into provider networking and guest access.
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
| Create | `vm_create` | Prepare a fresh project credential first; pass only its account and public key. |
| Power | `vm_start`, `vm_shutdown`, `vm_force_stop` | Force-stop only after explicit user authorization. |
| Snapshot | `snapshot_list`, `snapshot_create`, `snapshot_restore` | VM must be shut off with no managed-save state. |
| Remove | `vm_delete`, `template_remove` | Confirm target; templates with dependents are rejected. |

For graceful shutdown, call `vm_shutdown` with a bounded wait. A timeout is not
proof that shutdown failed or succeeded, and the operation never escalates to a
force-stop. Call `vm_inspect` again. Continue with a shut-off-only operation only
after the VM reports shut off; ask separately before `vm_force_stop`.

## Clone-only testing policy

When a request supplies an existing VM or template as the basis for testing,
protect that source for the complete workflow. Resolve it from the explicit
request and context, then corroborate its domain UUID, host, owner, session,
publication metadata, and disk/NVRAM lineage. Keep the resolved identity in the
workflow record. A name or suffix is never source or clone authorization; a
managed, mutable VM explicitly supplied as the source remains protected even
when ordinary runtime ownership checks would permit changing it.

Only read-only inspection and `template_publish` may target the protected
source. Never propose source start, shutdown, force-stop, configuration edits,
credential or guest provisioning, QGA/SSH/guest execution, snapshot operations,
deletion, or recovery. Fake or real runtime permission for those operations does
not override this policy. Publication may inspect and copy a verified prepared,
supported, shut-off source with no managed-save state, but it must preserve the
source XML, power state, disk, NVRAM, identity, and recorded hashes. A running,
managed-saved, unsafe, unsupported, ambiguous, or failed-to-publish source blocks
the testing workflow. Report the failed precondition; do not remediate the
source, substitute shell commands, or infer safety from its name.

If the source needs preparation, stop the testing workflow without booting or
changing it. Preparation requires separate explicit authorization for a
non-testing workflow. Before any boot or mutation, that workflow must create and
verify an independent full copy with a distinct UUID and MAC addresses, a fully
independent disk with no source backing relationship, and independent NVRAM when
applicable. Preserve and recheck the supplied source identity and XML/disk/NVRAM
hashes, and record `source -> preparation copy -> published template/version`
lineage. Renaming, relabeling, or recording the supplied source under a new role
is not a copy. The preparation copy may be published after preparation, but it
is not the final test VM.

Testing requires publication followed by a distinct `vm_create` working clone.
Before any clone power, endpoint setup, guest access, transfer, execution,
recovery, or cleanup, verify all of the following:

- The lineage is `protected source -> published template/version -> vm_create
  clone`, with any independently authorized preparation copy recorded between
  source and publication.
- The clone has a fresh domain UUID and MAC addresses, an exclusive
  toolkit-owned overlay backed by the exact immutable publication with no
  configuration or backing drift, and an independent writable NVRAM copy when
  applicable.
- Endpoint provenance and reinspection bind the candidate endpoint to the clone
  UUID, not to the source, preparation copy, publication, or a sibling VM.

Missing or mismatched evidence blocks testing. An uncertain `vm_create` result
is not a clone: preserve the pending credential, do not guess a UUID or retry
blindly, and restrict inspection or recovery to identified candidate clone-owned
resources and its journal. Cleanup and recovery may target only the verified
clone and its owned overlay, NVRAM, metadata, and journal. Preserve the protected
source and immutable published image/NVRAM backing, including when tests fail or
clone creation/deletion is interrupted.

### Creation-time guest access

When a new VM needs project access, invoke `dotknewt-guest-access` by name and
run its installed `project_ssh.py prepare` helper **before** `vm_create`. Read
only the emitted public-key file. Call `vm_create` with `guest_user` and the
single option-free `ssh-ed25519` public-key line; never send the local
`creation_id`, private-key path, or private-key bytes.

The provider returns a separately generated VM `uuid` and `guest_access`
metadata. Require `guest_access.status=provisioned`, the requested account, and
the prepared public-key fingerprint, then bind the unchanged local
`creation_id` to that returned VM UUID. Record the selected MCP connection name,
host, owner, session, and domain separately from generic provider type
`libvirt`. On an error or uncertain creation result, preserve the pending local
credential unchanged for recovery; do not guess a UUID or reuse it for another
creation.

Ordinary `vm_start`, reconnect, and `snapshot_restore` reuse and verify the bound
credential. They never create or rotate login keys. A missing/tampered local
credential blocks managed access. A recreated VM with a new UUID is a new
creation and receives a fresh credential without deleting or overwriting the old
VM's directory.

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
- Provider connection identity:
- Connection origin:
- Candidate endpoint and provenance:
- Intended account / home:
- Domain and guest identity evidence:
- Credential creation_id / VM UUID / account / public-key fingerprint:
- Installed helper / credential directory / generated SSH config:
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
The preserved VM-level `guest_access` account/fingerprint is metadata to verify;
snapshot restore does not provision a new key.

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
