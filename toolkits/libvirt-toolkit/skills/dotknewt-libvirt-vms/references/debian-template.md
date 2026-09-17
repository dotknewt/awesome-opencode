# Preparing an existing Debian 13 source template

Use this reference when the user asks to prepare an existing
`debian13-dev-template` for independent project VMs. The lifecycle core accepts
compatible Debian domains without an OS-specific switch. Publication flattens a
prepared shut-off source into an independent immutable QCOW2 template; project
VMs get writable linked overlays.

## 1. Inspect the existing source

Select the MCP host connection and call `host_info`, `vm_list`, and
`template_list`. An existing libvirt source domain is not automatically a
published toolkit template. All following paths and commands belong to that
server host and VM owner under `qemu:///session`.

Read the source state and inactive devices before preparing it:

```sh
SOURCE_VM=debian13-dev-template
virsh --connect qemu:///session dominfo "$SOURCE_VM"
virsh --connect qemu:///session dumpxml --inactive "$SOURCE_VM"
virsh --connect qemu:///session domblklist "$SOURCE_VM" --inactive --details
```

Require shut-off state, no managed-save state, exactly one writable file-backed
QCOW2 disk, and devices within the skill's v1 contract. An observed Debian 13
definition uses BIOS boot (no loader/NVRAM), virtio disk/network/video, user-mode
networking, SPICE audio/redirection, and no TPM. Its defaults are 2 current / 8
maximum vCPUs and 4 GiB current / 8 GiB configured memory. These are observed
defaults, not Debian minimum requirements. Omit `vm_create` sizing overrides to
preserve them; overrides set both current and configured values to the request.

## 2. Prepare clone identity in a disposable copy

Guest preparation is an explicit operation outside the toolkit's MCP lifecycle
API. Keep the original source, and prepare a separate shut-off full copy with
`virt-clone`. Offline customization additionally requires libguestfs tools
(`virt-inspector`, `virt-cat`, `virt-customize`) on the server host.

Select unused `PREPARED_COPY` and absolute `NEW_COPY_DISK` values, and set
`SOURCE_DISK` from the inspected writable disk path. Record its hash and file
metadata before and after preparation:

```sh
sha256sum "$SOURCE_DISK"
stat "$SOURCE_DISK"
virt-clone --connect qemu:///session --original "$SOURCE_VM" \
  --name "$PREPARED_COPY" --file "$NEW_COPY_DISK"
virt-inspector --connect qemu:///session -d "$PREPARED_COPY"
virt-cat --connect qemu:///session -d "$PREPARED_COPY" /etc/os-release
virt-cat --connect qemu:///session -d "$PREPARED_COPY" /etc/fstab
```

Inspect the copy's actual accounts, mount layout, cloud-init configuration, and
SSH units. Confirm Debian 13, an existing intended login account with a home
directory, and `openssh-server` installed. Resolve any stale `/etc/fstab` device
aliases in the copy before retrying failed libguestfs inspection. If packages
are missing, install them in the copy before final identity cleanup.

For a Debian systemd guest with `ssh.service`, the following offline path does
not require cloud-init. Set `GUEST_USER` to the inspected account, `SSH_PUBLIC_KEY`
to an absolute host-side public-key file, and `PREPARED_HOSTNAME` to the chosen
preparation-copy hostname. Verify those inputs before running:

```sh
virt-customize --connect qemu:///session -d "$PREPARED_COPY" --no-network \
  --ssh-inject "$GUEST_USER:file:$SSH_PUBLIC_KEY" \
  --truncate /etc/machine-id --delete /var/lib/dbus/machine-id \
  --delete '/etc/ssh/ssh_host_*' \
  --firstboot-command 'ssh-keygen -A' \
  --firstboot-command 'systemctl enable --now ssh.service' \
  --hostname "$PREPARED_HOSTNAME"
```

This queues SSH host-key generation before the explicit SSH enable/start
command, and leaves an empty machine ID for systemd to regenerate. It does not
order an already-enabled SSH unit after libguestfs firstboot; verify generated
keys and a running SSH service in disposable working clones. Select the actual
inspected SSH unit if this image uses a different one;
Ubuntu's `ssh.socket` example is not evidence that a Debian image uses it.

If cloud-init is installed and configured, inspect its datasource, cached
instance identity, and SSH/hostname policy. Clean its instance state as part of
preparation and verify it will initialize each clone rather than override the
chosen access policy. Any in-guest cleanup, including
`cloud-init clean --logs --machine-id`, belongs before shutdown and the final
offline customization above, and requires that initialization path to be
configured. Deleting host keys alone is incomplete
preparation; a verified first-boot regeneration mechanism is required.

The preparation hostname is copied into every clone. Give each working VM its
own guest hostname using separate guest configuration; fresh libvirt names,
UUIDs, and MACs do not change guest hostnames. Remove source-specific enrollment,
credentials, and network identity that should not be shared before publication.

Keep the cleaned copy shut off: booting it now consumes the first-boot actions
intended for clones. Recheck the retained source's hash/stat against the earlier
record. Confirm the copy is shut off with no managed save, and eject any attached
installation media from its persistent definition using the inspected CD-ROM
target.

## 3. Publish and create a project VM

On the selected MCP connection, call `template_publish` with:

```json
{
  "source_vm": "<the prepared copy's domain name>",
  "name": "debian13-dev-template",
  "version": "v1"
}
```

Replace the source placeholder with `PREPARED_COPY`. Choose an unused version
after inspecting `template_list`; published versions are immutable. If the
original source already has verified clone-identity preparation, it can instead
be the publication source without making another preparation copy.

Then call `vm_create` (replace the example VM name with a unique project name):

```json
{
  "name": "my-project-debian13",
  "template": "debian13-dev-template",
  "version": "v1"
}
```

The result is a shut-off working VM. For user-mode networking, follow
`guest-access.md` to inspect the path, select a distinct unused virtualization-
host loopback port, configure the persistent passt forward while shut off, start
through the MCP connection, and create the provider handoff. Then invoke
`dotknewt-guest-access` by name for SSH trust, authentication, transfer, and execution.
The toolkit does not allocate ports, run guest commands, or copy project files.

After boot, verify `/etc/os-release`, guest hostname, machine ID, and SSH host-key
fingerprint. Verify the guest SSH host key through a trusted source and
authenticate the intended regular account before project work. Compare machine
IDs and host keys with the retained source and a sibling clone when available;
report an unavailable comparison as `untested`. Unless the user or an applicable
policy requires clone-uniqueness proof, that unavailable comparison does not block
independently trusted guest access, transfer, or execution. After graceful
shutdown is confirmed, use `snapshot_create`
and `snapshot_restore` for powered-off disk/configuration snapshots; BIOS guests
have no NVRAM to capture, and RAM is never included.

## Evidence boundary

The existing Debian domain's inactive XML passed parsing and in-memory clone
sanitization on 2026-09-16. A sanitized observed fixture exercises publication,
sibling cloning, sizing preservation, and BIOS/no-NVRAM snapshot/restore with
fake host-command adapters and temporary files. This preparation recipe and
Debian guest boot/SSH/identity regeneration have not been live-tested. Establish
those outcomes on disposable working VMs before claiming end-to-end readiness.
