# Preparing an existing CachyOS source template

Use this reference when the user asks to prepare the existing `CachyOS` VM for
independent project clones. CachyOS is Arch-based; Debian's `openssh-server` and
`ssh.service`, and Ubuntu's `ssh.socket`, are not its preparation defaults.
Guest preparation is separate from the toolkit's MCP lifecycle operations.

## 1. Inspect the source on the selected host

Select the intended MCP connection and call `host_info`, `vm_list`, and
`template_list`. The libvirt domain `CachyOS` is not automatically a published
toolkit template. All commands and absolute paths below belong to that server
host and the VM owner using `qemu:///session`.

```sh
SOURCE_VM=CachyOS
virsh --connect qemu:///session dominfo "$SOURCE_VM"
virsh --connect qemu:///session dumpxml --inactive "$SOURCE_VM"
virsh --connect qemu:///session domblklist "$SOURCE_VM" --inactive --details
```

Require shut-off state, no managed save, one writable file-backed QCOW2 disk,
and devices within the skill's v1 contract. The observed definition has:

| Setting | Observed value |
|---|---|
| CPUs / memory | 8 vCPUs / 16 GiB current and configured memory |
| Firmware | UEFI, read-only OVMF loader, raw file-backed NVRAM |
| Firmware selection | Secure-boot-capable loader, `enrolled-keys=no` |
| Disk / network | Virtio QCOW2 disk / user-mode virtio interface |
| Memory backing | `source type="memfd"`, `access mode="shared"` |
| OS metadata | Arch rolling libosinfo identifier |

These are source settings, not CachyOS minimum requirements. Confirm the guest
distribution from `/etc/os-release`; a domain name or Arch metadata is not proof.
Omit sizing overrides to preserve the source configuration. Firmware selection
flags do not establish guest Secure Boot enforcement or successful boot.

The observed memfd-backed RAM is retained. It has no named shared-memory device
or persistent memory file to copy between clones. This is distinct from
`<devices><shmem .../></devices>` (ivshmem), which remains unsupported, as do
memory devices and passthrough. This observation does not establish support for
arbitrary memory-backing configurations. Powered-off snapshots never contain RAM.

## 2. Make a disposable preparation copy, including NVRAM

Install `virt-clone` and libguestfs tools (`virt-inspector`, `virt-cat`,
`virt-customize`) on the server host. Select unused `PREPARED_COPY`, absolute
`NEW_COPY_DISK`, and absolute `NEW_COPY_NVRAM` values. Set `SOURCE_DISK` and
`SOURCE_NVRAM` from the inspected XML, and record their hash/stat output:

```sh
sha256sum "$SOURCE_DISK" "$SOURCE_NVRAM"
stat "$SOURCE_DISK" "$SOURCE_NVRAM"
virt-clone --connect qemu:///session --original "$SOURCE_VM" \
  --name "$PREPARED_COPY" --file "$NEW_COPY_DISK" --nvram "$NEW_COPY_NVRAM"
virsh --connect qemu:///session dumpxml --inactive "$PREPARED_COPY"
cmp "$SOURCE_NVRAM" "$NEW_COPY_NVRAM"
```

Before booting the copy, confirm that its disk and NVRAM paths resolve to
separate files from the original, its UUID/MAC are fresh, and its firmware
configuration is retained. Copy the existing NVRAM contents, not just a blank
VARS template: the guest's boot entries and firmware state matter. The fixed
read-only loader remains a host prerequisite. Keep the original shut off and
customize only the copy.

Inspect the copy's guest layout while it is shut off:

```sh
virt-inspector --connect qemu:///session -d "$PREPARED_COPY"
virt-cat --connect qemu:///session -d "$PREPARED_COPY" /etc/os-release
virt-cat --connect qemu:///session -d "$PREPARED_COPY" /etc/fstab
```

Confirm the intended root filesystem, login account/home, mount layout, and
cloud-init state. CachyOS images may use Btrfs subvolumes or encryption;
libguestfs inspection/customization must work with this actual image before
using the offline commands below. Resolve missing filesystem support, unlock
requirements, or incorrect root mounts on the copy first.

## 3. Arrange Arch SSH startup, then clean guest identity offline

Boot the preparation copy using a separate console workflow if guest changes
are needed. In that guest, inspect the installed Arch OpenSSH package and units:

```sh
pacman -Q openssh
sudo systemctl cat sshd.service sshdgenkeys.service
```

If OpenSSH is missing, install it in the copy with `sudo pacman -Syu openssh`
(a full rolling-release update, not a partial `pacman -Sy` update). Inspect the
units again afterward. [Arch's OpenSSH documentation](https://wiki.archlinux.org/title/OpenSSH)
uses `openssh`, `sshd.service`, and `sshdgenkeys.service` to regenerate missing
host keys. Verify that the installed SSH service pulls in key generation and
orders it before the daemon starts, including any local drop-ins. If that
mechanism is missing or customized, establish and test an equivalent ordered
key-generation service before deleting host keys.

For the inspected standard units, enable and start SSH in the preparation guest
so its key-generation dependency runs even on a fresh OpenSSH installation:

```sh
sudo systemctl enable --now sshd.service
sudo sshd -t
```

Confirm the intended account can log in and that its SSH configuration accepts
the selected public key. Set a preparation hostname in the copy and remove
source-specific enrollment, credentials, or static network identity that must
not be shared. If cloud-init is present, inspect its datasource and SSH/hostname
policy; clean its cached instance state before shutdown and the final offline
cleanup. Do not assume cloud-init is installed or that it will configure clones.

Shut the copy down gracefully and confirm no managed save. Set `GUEST_USER` to
the inspected account and `SSH_PUBLIC_KEY` to the absolute server-host path of
the intended public-key file. With successful libguestfs inspection and the
ordered key-generation mechanism established, run on the server host:

```sh
virt-customize --connect qemu:///session -d "$PREPARED_COPY" --no-network \
  --ssh-inject "$GUEST_USER:file:$SSH_PUBLIC_KEY" \
  --truncate /etc/machine-id --delete /var/lib/dbus/machine-id \
  --delete '/etc/ssh/ssh_host_*'
```

The empty machine ID lets systemd initialize each clone's identity; the inspected
Arch SSH units regenerate host keys at boot. This recipe does not depend on
libguestfs firstboot scripts. Keep the cleaned copy shut off until publication;
booting it now would repopulate the identities intended for clones. Recheck the
original disk/NVRAM hash/stat against the recorded values. Eject attached install
media using its inspected CD-ROM target, and confirm the copy remains shut off
with no managed save.

## 4. Publish and create project VMs

On the selected MCP connection, call `template_publish` with:

```json
{
  "source_vm": "<the prepared copy's domain name>",
  "name": "cachyos-dev-template",
  "version": "v1"
}
```

Replace the source placeholder with `PREPARED_COPY`; choose an unused version
after inspecting `template_list`. A verified, already-prepared original can
instead be the source directly. Publication flattens the disk and copies NVRAM
into an immutable template version.

Call `vm_create` with a unique working-VM name:

```json
{
  "name": "my-project-cachyos",
  "template": "cachyos-dev-template",
  "version": "v1"
}
```

The result is shut off, with a writable linked disk, independent NVRAM, fresh
UUID/MAC, and retained firmware/memfd configuration. For user-mode networking,
follow `guest-access.md` to inspect the path, select a distinct unused
virtualization-host loopback port, configure the persistent passt forward while
shut off, start through the MCP connection, and create the provider handoff.
Then invoke `dotknewt-guest-access` by name for SSH trust, authentication, transfer, and
execution. The toolkit does not allocate ports, run guest commands, or copy
project files.

Verify UEFI boot, `/etc/os-release`, a running `sshd.service`, and key-based
login in disposable working clones. Assign each a unique guest hostname;
libvirt names do not change guest hostnames. Verify the guest SSH host key
through a trusted source and authenticate the intended regular account before
project work. Compare machine IDs and SSH host-key fingerprints with the
retained source and a sibling clone when available; report an unavailable
comparison as `untested`. Unless the user or an applicable policy requires
clone-uniqueness proof, that unavailable comparison does not block independently
trusted guest access, transfer, or execution. After confirmed graceful shutdown,
`snapshot_create` and `snapshot_restore` retain disk,
configuration, and NVRAM state, preserve VM identity, and leave the VM shut off.

## Evidence boundary

The existing `CachyOS` inactive XML passed parsing and in-memory clone sanitization
on 2026-09-16. A sanitized observed fixture exercises publication, sibling disk
and NVRAM independence, preserved sizing/firmware/memfd backing, shared-memory
device rejection, and powered-off snapshot/restore with fake host-command
adapters and temporary files. CachyOS preparation, libguestfs guest access, UEFI
boot, SSH, and first-boot identity regeneration have not been live-tested.
