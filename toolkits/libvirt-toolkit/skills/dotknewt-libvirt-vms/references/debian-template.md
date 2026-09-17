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

## 2. Prepare the exact guest-access contract in a disposable copy

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

Inspect the copy's actual accounts, mount layout, cloud-init state, and SSH
units. Confirm Debian 13 and install `openssh-server` plus `openssh-client` before
final offline cleanup. Never use `--ssh-inject` or retain a personal/project
public key in the shared image.

The selected non-root account must occur exactly once in `/etc/passwd`; match
`^[a-z_][a-z0-9_-]{0,31}$`; have UID/GID in `1..4294967294`; use an executable
absolute shell listed actively in regular `/etc/shells`; and have an absolute
normalized home strictly below `/home`, `/srv`, `/opt`, or `/var/lib`. The home
and every existing component through `.ssh/authorized_keys` must be non-symlink.
The home is an owned directory; `.ssh`, if present, is a directory;
`authorized_keys`, if present, is regular. Remove its existing login keys.
Creation later replaces the complete file with mode 0600 inside mode-0700
`.ssh`, both owned by that account.

Require POSIX `/bin/sh`, `sshd`, Ed25519-capable `ssh-keygen`, `awk`, `base64`,
`chmod`, `chown`, `cut`, `install`, `mktemp`, `mv`, `rm`, `rmdir`, `sha256sum`,
`stat`, and `test`. Require regular non-symlink `/run` and
`/etc/ssh/sshd_config`; `/run/sshd` is absent or a non-symlink directory. Create
it mode 0755 only when absent for the policy check and remove only that owned
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
rewrite the selected account or key. Then create regular non-symlink
`/etc/libvirt-toolkit/guest-access-v1.json` with exactly this parsed object:

```json
{
  "authorized_keys": ".ssh/authorized_keys",
  "firstboot_authorized_keys": "disabled",
  "prepared_for": "libvirt-toolkit",
  "version": 1
}
```

Host-key regeneration is independent of login-key provisioning. With cloud-init
disabled, install this bounded systemd oneshot before final shutdown and make
every inspected SSH activation path require it. The standard Debian paths shown
are `ssh.service` and `ssh.socket`; change the assignment only to match the units
actually inspected on the prepared image:

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
SSH_ACTIVATION_UNITS='ssh.service ssh.socket'
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
`/var/lib/dbus/machine-id` and `/etc/ssh/ssh_host_*`, and create that pending
marker as regular non-symlink
`/etc/libvirt-toolkit/host-key-generation.pending`. The SSH activation units pull
in the oneshot; do not enable it separately through `multi-user.target`.
`DefaultDependencies=no` avoids a cycle between a socket's implicit
`Before=sockets.target` and a normal service's implicit `After=basic.target`.
Verify every enabled SSH service/socket has both dependency edges and that the
marker remains pending in the shut-off publication source. Do not rely on
libguestfs `--firstboot-command`. Boot disposable working clones to prove machine
ID and host keys are generated before SSH starts; never boot the publication
source and consume its oneshot.

Resolve stale `/etc/fstab` aliases only in the copy. Remove source credentials,
enrollment, secrets, and static network identity. Recheck the retained source's
hash/stat, keep the prepared copy shut off without managed save, and eject
installation media using its inspected target.

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
  "version": "v1",
  "guest_user": "developer",
  "ssh_public_key": "ssh-ed25519 AAAA..."
}
```

Before this call, invoke `dotknewt-guest-access` by name and prepare a fresh
project credential. Pass only its public key/account; do not pass its local
`creation_id` or private-key data. Bind that creation ID only after the response
returns the separate VM UUID and matching `guest_access` account/fingerprint.

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
