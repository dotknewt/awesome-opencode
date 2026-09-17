# Preparing an Ubuntu source template

Use this recipe only when the user asks to install or prepare an Ubuntu source
domain for `template_publish`. It prepares an ordinary, user-owned source VM;
publication later creates the toolkit's independent flattened template.

## 1. Preserve the prepared install inputs

The initial recipe uses the user's prepared Ubuntu 26.04 desktop ISO and
`ubuntu-dev-seed.iso`; do not replace it with an interactive `--cdrom` recipe.
If the user requests a change, map it to the corresponding command option or
NoCloud file instead of collecting values that the command never consumes:

| Input | Where it is applied |
|---|---|
| domain, CPU, vCPU, and memory | `--name`, `--cpu`, `--vcpus`, `--memory` |
| installer ISO and boot files | `--location=...,kernel=...,initrd=...` |
| writable OS disk | first `--disk` |
| account, locale, storage, packages, SSH policy | seed ISO `user-data` under `autoinstall:`; do not embed personal/project SSH keys |
| installer instance/host identity | seed ISO `meta-data` |

The command below has a prepared seed already. That ISO must be readable at the
shown path on the server host, have volume label `cidata`, and contain NoCloud
files named `user-data` and `meta-data` at its root. `user-data` starts with
`#cloud-config` and contains a valid Ubuntu `autoinstall:` mapping; `meta-data`
contains at least a unique `instance-id` and the intended `local-hostname`.
Optional `vendor-data` is also a root-level NoCloud file. Treat credentials and
password hashes in the seed as secrets. If any installer choice changes, rebuild
the prepared seed and verify its label and contents before launching; merely
asking for the value does not alter the installation.

All paths and commands apply on the selected server host as the VM owner under
`qemu:///session`. V1 publication requires exactly one writable file-backed
QCOW2 disk. Do not add TPM, passthrough, shared filesystems, block/network disks,
or another writable disk. Windows TPM support is deferred.

## 2. Run the seeded autoinstall

This is the original prepared command. Run it as the VM owner on the selected
server host:

```sh
virt-install --connect qemu:///session --name ubuntu-dev-template \
  --cpu host-passthrough --vcpus=2,maxvcpus=8 \
  --memory=8192,currentMemory=4096 \
  --location="$HOME/Archive/iso/ubuntu-26.04-desktop-amd64.iso,kernel=casper/vmlinuz,initrd=casper/initrd" \
  --extra-args="autoinstall" \
  --disk size=32,format=qcow2 \
  --disk path="$HOME/Archive/iso/ubuntu-dev-seed.iso",device=cdrom,readonly=on \
  --os-variant=ubuntu26.04 --noautoconsole --wait=-1
```

The first `--disk` is the one writable file-backed QCOW2 OS disk accepted by the
v1 publication contract. The second is read-only NoCloud installation media,
not another writable guest disk. The toolkit has not live-tested this original
installer invocation. It has exercised the later publication and working-guest
lifecycle with one resulting Ubuntu 26.04 image; that does not validate these
installation inputs. Inspect installer logs and the resulting guest before
preparing it for publication.

## 3. Prepare the exact guest-access contract

Prepare a disposable full copy and never inject a personal or project login key:

```sh
virt-clone --connect qemu:///session --original "$SOURCE_VM" \
  --name "$PREPARED_COPY" --file "$NEW_COPY_DISK"
```

Inspect the copy's real account, home, shell, SSH units, and mount layout. Before
publication the selected non-root account must occur exactly once in
`/etc/passwd`; match `^[a-z_][a-z0-9_-]{0,31}$`; have UID/GID in
`1..4294967294`; use an executable absolute shell listed actively in regular
`/etc/shells`; and have an absolute normalized home strictly below `/home`,
`/srv`, `/opt`, or `/var/lib`. The home and every existing component through
`.ssh/authorized_keys` must be non-symlink. The home is an owned directory;
`.ssh`, if present, is a directory; `authorized_keys`, if present, is regular.
Remove the source account's login keys rather than baking any access into the
shared template. Creation later replaces the complete key file with mode 0600,
inside mode-0700 `.ssh`, owned by this UID/GID.

Install OpenSSH server/client and required guest commands: POSIX `/bin/sh`,
`sshd`, Ed25519-capable `ssh-keygen`, `awk`, `base64`, `chmod`, `chown`, `cut`,
`install`, `mktemp`, `mv`, `rm`, `rmdir`, `sha256sum`, `stat`, and `test`.
Require regular non-symlink `/run`, `/etc/ssh/sshd_config`, and either absent or
directory non-symlink `/run/sshd`. With a temporary offline Ed25519 host key,
this exact policy query for the selected account must produce exactly one of
each value shown (keyword case is ignored; values are exact):

```sh
sshd -T -h "$TEMPORARY_OFFLINE_HOST_KEY" -f /etc/ssh/sshd_config \
  -C "user=$GUEST_USER,host=localhost,addr=127.0.0.1"
# pubkeyauthentication yes
# authorizedkeysfile .ssh/authorized_keys
# authorizedkeyscommand none
# trustedusercakeys none
```

Disabled public-key authentication, additional authorized-key files, commands,
or trusted user CAs are incompatible.
Create `/run/sshd` as mode 0755 only when absent for this check, then remove only
that owned directory while empty. Preserve any existing directory and contents.

Cloud-init is used for installation only. Before publication disable all of its
first-boot behavior and create regular non-symlink
`/etc/cloud/cloud-init.disabled` (also required on images without cloud-init).
Audit and disable every vendor, seed, distro, or custom first-boot mechanism that
could rewrite the selected account or `authorized_keys`. Then write regular
non-symlink `/etc/libvirt-toolkit/guest-access-v1.json` containing exactly:

```json
{
  "authorized_keys": ".ssh/authorized_keys",
  "firstboot_authorized_keys": "disabled",
  "prepared_for": "libvirt-toolkit",
  "version": 1
}
```

Host-key generation is separate from login-key provisioning. Because cloud-init
is disabled, install this bounded systemd oneshot before final shutdown and make
every inspected SSH activation path require it. The standard Ubuntu paths shown
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
truncate
`/etc/machine-id`, remove `/var/lib/dbus/machine-id` and `/etc/ssh/ssh_host_*`,
and create `/etc/libvirt-toolkit/host-key-generation.pending` as a regular
non-symlink file. The SSH service/socket dependency activates the oneshot; do not
enable it separately through `multi-user.target`. `DefaultDependencies=no`
avoids the cycle that a normal service's implicit `After=basic.target` would
create with a socket's implicit `Before=sockets.target`. Verify every enabled SSH
service/socket has the `Requires=` and `After=` edges and that the marker remains
pending in the shut-off publication source. Do not
use libguestfs `--firstboot-command`, cloud-init, or a template login key as a
substitute. Boot disposable working clones to prove machine-ID and host-key
regeneration before SSH starts; never boot and consume the publication source's
oneshot.

Operate only on the copy and hash/stat the retained source disk before and after.
Stale `/etc/fstab` aliases must be repaired only in the copy. Remove credentials,
enrollment, secrets, and source-specific network state. Add passt forwarding only
to an individual working VM by following `guest-access.md`.

## 4. Confirm shutdown, remove install media, and keep a source checkpoint

First verify the domain is confirmed shut off; do not treat a timeout or command
return alone as proof:

```sh
virsh --connect qemu:///session domstate "$SOURCE_VM"
```

Only after it reports `shut off`, remove the installation CD-ROM from the
persistent definition. Inspect `domblklist --details` to obtain the actual CD-ROM
target (for example `sda`) instead of guessing:

```sh
virsh --connect qemu:///session domblklist "$SOURCE_VM" --details
virsh --connect qemu:///session change-media "$SOURCE_VM" "$CDROM_TARGET" \
  --eject --config
```

If the user wants the initial source-domain checkpoint, create it while shut off
and give it the required explicit name:

```sh
virsh --connect qemu:///session snapshot-create-as \
  --domain "$SOURCE_VM" --name base-install \
  --description "Prepared Ubuntu source before toolkit publication"
```

This `base-install` object is a native `virsh` snapshot of the separately owned
source domain. It is not a toolkit snapshot and will not appear in
`snapshot_list`. Toolkit snapshots apply only to managed working VMs and use
external QCOW2/configuration/NVRAM layers.

Re-run `domstate`, inspect the inactive domain XML and disk with
`domblklist --inactive --details`, then call `template_publish` through the MCP
connection selected for this host. A rejection must be reported and corrected,
not bypassed.

If the request continues into a working guest, use `guest-access.md` for the
provider endpoint and handoff, then invoke `dotknewt-guest-access` by name. Before project
VM creation, use that skill's installed helper to prepare a fresh credential;
pass only its account and public key to `vm_create`. Do not send the local
`creation_id` or private-key data. Bind that creation ID only after the response
returns its separate VM UUID and matching `guest_access` account/fingerprint.
Before project
execution, verify the guest SSH host key through a trusted source, authenticate
the intended regular account, and compare machine ID and SSH host-key identity
with the retained source and a sibling when those are available. Report an
unavailable comparison as `untested`, not as uniqueness. Unless the user or an
applicable policy requires clone-uniqueness proof, that unavailable comparison
does not block independently trusted guest access, transfer, or execution. The
authorized Ubuntu 26.04 lifecycle smoke test described by the toolkit remains
evidence for that one image's lifecycle only. It did not exercise this
guest-access transformation or first-boot host-key sequence and establishes no
Debian or CachyOS guest-access result. Guest-access script coverage uses a host
temporary filesystem and real OpenSSH; the libguestfs command boundary and
template dependency checks use fakes/static fixtures, not a prepared live image.
