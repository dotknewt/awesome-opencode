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

## 3. Prepare the exact guest-access contract

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

For the inspected standard units, enable and test SSH in the preparation guest:

```sh
sudo systemctl enable --now sshd.service
sudo sshd -t
```

The selected non-root account must occur exactly once in `/etc/passwd`; match
`^[a-z_][a-z0-9_-]{0,31}$`; have UID/GID in `1..4294967294`; use an executable
absolute shell listed actively in regular `/etc/shells`; and have an absolute
normalized home strictly below `/home`, `/srv`, `/opt`, or `/var/lib`. The home
and every existing component through `.ssh/authorized_keys` must be non-symlink.
The home is an owned directory; `.ssh`, if present, is a directory;
`authorized_keys`, if present, is regular. Remove all inherited login keys.
Never use `--ssh-inject` or bake personal/project public keys into the template.
Creation later replaces the complete file with mode 0600 inside mode-0700
`.ssh`, both owned by this account.

Require POSIX `/bin/sh`, `sshd`, Ed25519-capable `ssh-keygen`, `awk`, `base64`,
`chmod`, `chown`, `cut`, `install`, `mktemp`, `mv`, `rm`, `rmdir`, `sha256sum`,
`stat`, and `test`. Require regular non-symlink `/run` and
`/etc/ssh/sshd_config`; `/run/sshd` is absent or a non-symlink directory. Create
it mode 0755 only when absent for this policy check, then remove only that owned
directory while empty. Preserve an existing directory and contents. With a
temporary offline Ed25519 host key, require exactly these effective values:

```sh
sshd -T -h "$TEMPORARY_OFFLINE_HOST_KEY" -f /etc/ssh/sshd_config \
  -C "user=$GUEST_USER,host=localhost,addr=127.0.0.1"
# pubkeyauthentication yes
# authorizedkeysfile .ssh/authorized_keys
# authorizedkeyscommand none
# trustedusercakeys none
```

Keyword case is ignored; values are exact and each setting occurs once.
Disabled public-key authentication, additional key stores, commands, or trusted
user CAs are incompatible.

Disable cloud-init and create regular non-symlink
`/etc/cloud/cloud-init.disabled`, including when cloud-init is absent. Audit and
disable every distro, vendor, seed, or custom first-boot mechanism that could
rewrite the account or key. Then create regular non-symlink
`/etc/libvirt-toolkit/guest-access-v1.json` with exactly this parsed object:

```json
{
  "authorized_keys": ".ssh/authorized_keys",
  "firstboot_authorized_keys": "disabled",
  "prepared_for": "libvirt-toolkit",
  "version": 1
}
```

Host-key regeneration is separate from login-key provisioning. Do not merely
assume `sshdgenkeys.service` ordering: verify it, or install this bounded systemd
oneshot before final shutdown and make every inspected SSH activation path
require it. The standard CachyOS path shown is `sshd.service`; add an inspected
socket only if the prepared image actually enables one:

```sh
sudo install -d -m 0755 /etc/libvirt-toolkit
sudo tee /usr/local/sbin/libvirt-toolkit-firstboot-hostkeys >/dev/null <<'EOF'
#!/bin/sh
set -eu
/usr/bin/ssh-keygen -A
rm -f /etc/libvirt-toolkit/host-key-generation.pending
EOF
sudo chmod 0755 /usr/local/sbin/libvirt-toolkit-firstboot-hostkeys
sudo tee /etc/systemd/system/libvirt-toolkit-firstboot-hostkeys.service >/dev/null <<'EOF'
[Unit]
Description=Generate per-clone SSH host keys
ConditionPathExists=/etc/libvirt-toolkit/host-key-generation.pending
DefaultDependencies=no
Requires=local-fs.target
After=local-fs.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/libvirt-toolkit-firstboot-hostkeys
EOF
SSH_ACTIVATION_UNITS='sshd.service'
for unit in $SSH_ACTIVATION_UNITS; do
  sudo systemctl cat "$unit" >/dev/null
  sudo install -d -m 0755 "/etc/systemd/system/$unit.d"
  sudo tee "/etc/systemd/system/$unit.d/libvirt-toolkit-firstboot-hostkeys.conf" >/dev/null <<'EOF'
[Unit]
Requires=libvirt-toolkit-firstboot-hostkeys.service
After=libvirt-toolkit-firstboot-hostkeys.service
EOF
done
sudo systemctl daemon-reload
for unit in $SSH_ACTIVATION_UNITS; do
  sudo systemctl show -p Requires -p After "$unit"
done
```

The script removes its marker only after `ssh-keygen -A` succeeds. Offline,
truncate `/etc/machine-id`, remove
`/var/lib/dbus/machine-id` and `/etc/ssh/ssh_host_*`, and create the marker when
using the toolkit oneshot as regular non-symlink
`/etc/libvirt-toolkit/host-key-generation.pending`. The SSH activation unit pulls
in the oneshot; do not enable it separately through `multi-user.target`.
`DefaultDependencies=no` also keeps a subsequently inspected socket path from
forming a `sockets.target`/`basic.target` ordering cycle. Verify every enabled SSH
service/socket has both dependency edges and that the chosen mechanism is pending
in the shut-off publication source. Cloud-init and libguestfs firstboot scripts are
not substitutes. Boot disposable working clones to prove machine ID and host
keys are generated before SSH starts; never boot and consume the publication
source's one-time mechanism.

Remove source-specific enrollment, credentials, and static network identity.
Keep the cleaned copy shut off without managed save, recheck original disk/NVRAM
hash/stat, and eject install media using its inspected target.

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
  "version": "v1",
  "guest_user": "developer",
  "ssh_public_key": "ssh-ed25519 AAAA..."
}
```

Before this call, invoke `dotknewt-guest-access` by name and prepare a fresh
project credential. Pass only its public key/account; do not pass its local
`creation_id` or private-key data. Bind that creation ID only after the response
returns the separate VM UUID and matching `guest_access` account/fingerprint.

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
