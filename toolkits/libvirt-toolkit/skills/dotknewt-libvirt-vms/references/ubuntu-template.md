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
| account, locale, storage, packages, SSH policy | seed ISO `user-data` under `autoinstall:` |
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

## 3. Prepare first-boot guest identity

Inside the guest, arrange for the clones' next boot to generate a new machine
identity and SSH host keys. On a systemd Ubuntu guest, a typical final cleanup is:

```sh
sudo cloud-init clean --logs --machine-id
sudo rm -f /etc/ssh/ssh_host_*
sudo shutdown -h now
```

Use `cloud-init` only when it is installed and configured to initialize the
clone on first boot. Otherwise configure and verify an equivalent one-shot
first-boot mechanism before publication; an empty `/etc/machine-id` must be
regenerated, and SSH host keys must be regenerated rather than left absent.
Never publish credentials, enrollment state, secrets, or source-specific network
configuration that should not be cloned.

For offline preparation of a disposable copy, first inspect the image's actual
OS, account, mount layout, SSH units, and cloud-init state. Then a measured
Ubuntu 26.04 workflow used the following shape. Choose a unique hostname for the
disposable source copy rather than reusing this example's measured hostname:

```sh
virt-clone --connect qemu:///session --original "$SOURCE_VM" \
  --name "$PREPARED_COPY" --file "$NEW_COPY_DISK"
virt-customize --connect qemu:///session -d "$PREPARED_COPY" --no-network \
  --ssh-inject "localuser:file:$HOME/.ssh/id_ed25519.pub" \
  --truncate /etc/machine-id --delete /var/lib/dbus/machine-id \
  --delete '/etc/ssh/ssh_host_*' \
  --firstboot-command 'ssh-keygen -A' \
  --firstboot-command 'systemctl enable ssh.socket' \
  --hostname "$PREPARED_HOSTNAME"
```

The measured image used socket-activated SSH, so its first boot explicitly
enabled `ssh.socket`; another image may require a different inspected SSH unit.
The hostname applies to the disposable preparation copy and must be selected for
that copy. It does not replace first-boot machine-ID and SSH-host-key renewal.

Operate only on the new shut-off copy and hash/stat the retained source disk
before and after. `virt-customize` uses the guest's mount configuration during
inspection; stale `/etc/fstab` device aliases can prevent it from mounting the
root even when a manual read-only libguestfs mount succeeds. Diagnose and repair
that alias only in the copy before retrying. Do not suppress inspection or alter
the retained source.

The first-boot commands are intentionally copied into the published image so each
working VM creates its own host keys. Do not boot the prepared publication source
first and consume that one-shot action. After a working VM boots, verify its
machine ID and host-key fingerprint differ from the retained source; a fresh
libvirt UUID alone is not guest identity proof. Add any passt SSH forward only to
the individual working VM with its own unused loopback port by following
`guest-access.md`; template sanitization removes source forwards.

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
execution, verify the guest SSH host key through a trusted source, authenticate
the intended regular account, and compare machine ID and SSH host-key identity
with the retained source and a sibling when those are available. Report an
unavailable comparison as `untested`, not as uniqueness. Unless the user or an
applicable policy requires clone-uniqueness proof, that unavailable comparison
does not block independently trusted guest access, transfer, or execution. The
authorized Ubuntu 26.04 lifecycle smoke test described by the toolkit remains
evidence for that one image only; it establishes no Debian or CachyOS guest-access
result.
