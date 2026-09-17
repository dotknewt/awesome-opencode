# Project SSH workflow

Use this workflow only with credentials created by the installed
`dotknewt-guest-access` helper. Every guest SSH, SCP, rsync, and effective-config
inspection must use the generated project config and its fixed alias
`project-vm`. Do not consult `~/.ssh`, an SSH agent, default known-hosts files,
or a multiplexed connection.

Run the sequence in one POSIX shell. Set the helper to its absolute installed
path; never resolve it relative to a source checkout. Initialize one cleanup
handler before creating temporary files so later stages do not replace an
earlier trap:

```sh
set -eu
HELPER=/absolute/installed/skills/dotknewt-guest-access/scripts/project_ssh.py
PROJECT_ROOT=/absolute/path/to/project
VM_NAME=replace-with-unique-vm-name
GUEST_USER=developer

candidate_file=
rsync_wrapper=
staging_dir=
cleanup_project_ssh() {
  for temporary in "$candidate_file" "$rsync_wrapper"; do
    [ -z "$temporary" ] || rm -f -- "$temporary"
  done
  [ -z "$staging_dir" ] || rm -rf -- "$staging_dir"
}
trap cleanup_project_ssh EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

json_string() {
  JSON_FIELD=$1 JSON_DOCUMENT=$2 python3 - <<'PY'
import json
import os
import sys

document = json.loads(os.environ["JSON_DOCUMENT"])
field = os.environ["JSON_FIELD"]
if not isinstance(document, dict) or not isinstance(document.get(field), str):
    raise SystemExit(f"missing or non-string JSON field: {field}")
sys.stdout.write(document[field])
PY
}
```

## Prepare once, before VM creation

Create a fresh credential for every new VM creation attempt:

```sh
prepare_json=$(python3 "$HELPER" prepare \
  --project-root "$PROJECT_ROOT" \
  --vm-name "$VM_NAME" \
  --provider libvirt \
  --guest-user "$GUEST_USER") || exit 1

PREPARE_JSON=$prepare_json EXPECTED_VM_NAME=$VM_NAME \
EXPECTED_GUEST_USER=$GUEST_USER python3 - <<'PY'
import json
import os

document = json.loads(os.environ["PREPARE_JSON"])
required = {
    "provider", "vm_name", "guest_user", "creation_id", "vm_uuid",
    "fingerprint", "status", "credential_dir", "private_key_path",
    "public_key_path",
}
if set(document) != required:
    raise SystemExit("unexpected prepare response schema")
if document["provider"] != "libvirt":
    raise SystemExit("unexpected prepare provider")
if document["vm_name"] != os.environ["EXPECTED_VM_NAME"]:
    raise SystemExit("unexpected prepare VM name")
if document["guest_user"] != os.environ["EXPECTED_GUEST_USER"]:
    raise SystemExit("unexpected prepare guest user")
if document["status"] != "pending" or document["vm_uuid"] is not None:
    raise SystemExit("prepare did not return a pending unbound credential")
PY

CREATION_ID=$(json_string creation_id "$prepare_json")
CREDENTIAL_DIR=$(json_string credential_dir "$prepare_json")
PUBLIC_KEY_PATH=$(json_string public_key_path "$prepare_json")
PREPARED_FINGERPRINT=$(json_string fingerprint "$prepare_json")
SSH_PUBLIC_KEY=$(PUBLIC_KEY_PATH=$PUBLIC_KEY_PATH python3 - <<'PY'
import os
from pathlib import Path

text = Path(os.environ["PUBLIC_KEY_PATH"]).read_text(encoding="utf-8")
lines = text.splitlines()
if len(lines) != 1:
    raise SystemExit("public key file must contain exactly one line")
fields = lines[0].split()
if len(fields) not in (2, 3) or fields[0] != "ssh-ed25519":
    raise SystemExit("public key file is not one option-free Ed25519 key")
print(" ".join(fields), end="")
PY
)
```

The schema check and field extraction use JSON parsing, never `eval` or shell
code generation. `SSH_PUBLIC_KEY` is read only from `public_key_path`; pass that
value and `GUEST_USER` to `vm_create`. Never read the private key or put
private-key bytes or `private_key_path` in an MCP request,
helper `bind` call, log, handoff, or report. The server receives only
`guest_user` and the one-line Ed25519 public key; it does not receive
`creation_id`.

If creation fails or its result is uncertain, preserve the pending credential
directory unchanged for recovery. Do not bind it to a guessed domain and do not
reuse it for another creation. A definite retry that creates a different VM
requires another `prepare`; earlier pending or bound directories remain intact.

## Bind the returned VM identity

Accept identity only from the selected provider connection's `vm_create`
response. Record that connection's name, virtualization host, owner,
`qemu:///session`, and domain alongside the helper record; the helper's
`--provider libvirt` value is not a substitute for that connection identity.

Require all of the following before binding:

- response `uuid` becomes helper `vm_uuid`;
- response `guest_access.user` equals the requested account;
- response `guest_access.fingerprint` equals the helper's prepared public-key
  fingerprint;
- response `guest_access.status` is `provisioned`; and
- the local `creation_id` is unchanged and was not sent to the provider.

Then bind metadata only. `bind` never receives private-key contents:

```sh
[ "$RETURNED_GUEST_ACCESS_STATUS" = provisioned ] || {
  printf '%s\n' 'guest access was not provisioned' >&2
  exit 1
}
[ "$RETURNED_GUEST_ACCESS_USER" = "$GUEST_USER" ] || {
  printf '%s\n' 'returned guest account does not match' >&2
  exit 1
}
[ "$RETURNED_GUEST_ACCESS_FINGERPRINT" = "$PREPARED_FINGERPRINT" ] || {
  printf '%s\n' 'returned public-key fingerprint does not match' >&2
  exit 1
}
bind_json=$(python3 "$HELPER" bind \
  --credential-dir "$CREDENTIAL_DIR" \
  --provider libvirt \
  --vm-name "$VM_NAME" \
  --creation-id "$CREATION_ID" \
  --vm-uuid "$RETURNED_VM_UUID" \
  --fingerprint "$RETURNED_GUEST_ACCESS_FINGERPRINT" \
  --guest-user "$RETURNED_GUEST_ACCESS_USER") || exit 1

BIND_JSON=$bind_json EXPECTED_VM_UUID=$RETURNED_VM_UUID python3 - <<'PY'
import json
import os

document = json.loads(os.environ["BIND_JSON"])
if document.get("status") != "bound":
    raise SystemExit("bind did not return a bound credential")
if document.get("vm_uuid") != os.environ["EXPECTED_VM_UUID"]:
    raise SystemExit("bind returned a different VM UUID")
PY
```

On normal `vm_start`, reconnect, and `snapshot_restore`, call `verify` with the
bound `creation_id`, VM UUID, fingerprint, and account. Never rotate or prepare
a new key for those operations. A missing/tampered local key or a changed UUID
is a blocker, not permission to overwrite credentials. If the provider recreated
the VM with a new UUID, treat it as a new creation and use a separately prepared
credential; preserve the old VM's directory.

## Establish the endpoint and host identity

Keep the client, virtualization host, and guest distinct. Record the endpoint's
provenance and inspect routing from the actual client. A passt listener on
`127.0.0.1` of a remote virtualization host is not client loopback.

Before any guest authentication, obtain `TRUSTED_HOST_FINGERPRINT` through an
independently trusted source such as a verified console or measured
image/first-boot record. `ssh-keyscan` supplies only an unauthenticated
candidate.

Choose exactly one endpoint setup. For a directly reachable guest:

```sh
SSH_HOST=$GUEST_HOST
SSH_PORT=$GUEST_PORT
SCAN_HOST=$SSH_HOST
SCAN_PORT=$SSH_PORT
HOST_KEY_ALIAS=
```

For a remote-host loopback forward, first use a separately managed explicit
configuration in a dedicated terminal. This authenticates the management host,
not the guest; its host identity must already be trusted under that management
policy:

```sh
MANAGEMENT_CONFIG=/absolute/path/to/approved-management-ssh-config
ssh -F "$MANAGEMENT_CONFIG" -N -o ExitOnForwardFailure=yes \
  -L "127.0.0.1:${CLIENT_TUNNEL_PORT}:127.0.0.1:${REMOTE_GUEST_PORT}" \
  -- "$VIRTUALIZATION_HOST_ALIAS"
```

In the project workflow shell, point guest scanning/configuration at the client
side of that tunnel but use a stable guest identity token:

```sh
SSH_HOST=127.0.0.1
SSH_PORT=$CLIENT_TUNNEL_PORT
SCAN_HOST=$SSH_HOST
SCAN_PORT=$SSH_PORT
HOST_KEY_ALIAS=$STABLE_GUEST_HOST_KEY_ALIAS
```

Collect the candidate without authenticating. The helper validates the endpoint
and alias before mutation, derives the normalized direct/IPv6/alias token,
requires exactly one unique Ed25519 key, compares its fingerprint with the
independently trusted value, and performs a no-follow locked/atomic update of
`known_hosts` inside this credential directory:

```sh
candidate_file=$(mktemp)
timeout 8s ssh-keyscan -T 5 -t ed25519 -p "$SCAN_PORT" \
  -- "$SCAN_HOST" >"$candidate_file"

set -- python3 "$HELPER" enroll \
  --credential-dir "$CREDENTIAL_DIR" \
  --provider libvirt \
  --vm-name "$VM_NAME" \
  --creation-id "$CREATION_ID" \
  --vm-uuid "$RETURNED_VM_UUID" \
  --fingerprint "$RETURNED_GUEST_ACCESS_FINGERPRINT" \
  --guest-user "$GUEST_USER" \
  --hostname "$SSH_HOST" \
  --port "$SSH_PORT" \
  --trusted-host-fingerprint "$TRUSTED_HOST_FINGERPRINT" \
  --candidate-file "$candidate_file"
if [ -n "$HOST_KEY_ALIAS" ]; then
  set -- "$@" --host-key-alias "$HOST_KEY_ALIAS"
fi
enroll_json=$("$@") || exit 1

KNOWN_HOSTS_FILE=$(json_string known_hosts_path "$enroll_json")
ENROLLED_HOSTNAME=$(json_string hostname "$enroll_json")
ENROLLED_HOST_TOKEN=$(json_string host_key_token "$enroll_json")
ENROLLED_HOST_FINGERPRINT=$(json_string host_key_fingerprint "$enroll_json")
[ "$ENROLLED_HOST_FINGERPRINT" = "$TRUSTED_HOST_FINGERPRINT" ] || exit 1
```

`enroll` rejects control/whitespace, SSH `%`, and known-hosts pattern characters
in hostnames/aliases before opening trust state. Nondefault literal IPv6 is
normalized as `[address]:port`; a supplied alias is the exact token. Candidate
and trust files use no-follow operations. A per-credential lock covers reading,
conflict checking, temporary-file fsync, and atomic replacement, so concurrent
helper calls cannot lose an enrollment. Existing exact matches are idempotent;
conflicts fail without changing `known_hosts`.

No guest authentication command appears before this comparison and enrollment.
Never default to `~/.ssh/known_hosts`, append around a conflict, enroll loopback
or the management host as guest identity, or use `StrictHostKeyChecking=no`.
The helper-owned trust store remains under the private credential directory,
already covered by the anchored `/.libvirt-toolkit/` Git ignore entry.

## Generate and inspect the strict project config

Only after the verified host key is in the project trust store, generate the
config:

```sh
set -- python3 "$HELPER" configure \
  --credential-dir "$CREDENTIAL_DIR" \
  --provider libvirt \
  --vm-name "$VM_NAME" \
  --creation-id "$CREATION_ID" \
  --vm-uuid "$RETURNED_VM_UUID" \
  --fingerprint "$RETURNED_GUEST_ACCESS_FINGERPRINT" \
  --guest-user "$GUEST_USER" \
  --hostname "$ENROLLED_HOSTNAME" \
  --port "$SSH_PORT" \
  --known-hosts "$KNOWN_HOSTS_FILE"
if [ -n "$HOST_KEY_ALIAS" ]; then
  set -- "$@" --host-key-alias "$HOST_KEY_ALIAS"
fi
configure_json=$("$@") || exit 1

CONFIGURE_JSON=$configure_json EXPECTED_HOST=$ENROLLED_HOSTNAME \
EXPECTED_PORT=$SSH_PORT python3 - <<'PY'
import json
import os

document = json.loads(os.environ["CONFIGURE_JSON"])
if document.get("status") != "bound" or document.get("alias") != "project-vm":
    raise SystemExit("configure returned an unexpected identity or alias")
if document.get("hostname") != os.environ["EXPECTED_HOST"]:
    raise SystemExit("configure returned an unexpected hostname")
if document.get("port") != int(os.environ["EXPECTED_PORT"]):
    raise SystemExit("configure returned an unexpected port")
if not isinstance(document.get("config_path"), str):
    raise SystemExit("configure did not return config_path")
PY
CONFIG_PATH=$(json_string config_path "$configure_json")
```

Leave `HOST_KEY_ALIAS` empty only for a direct endpoint whose hostname/port
lookup token was enrolled. The tunnel setup supplies the stable guest alias.
Inspect only the extracted config path:

```sh
ssh -G -T -F "$CONFIG_PATH" project-vm
```

Confirm the expected hostname, port, user, `IdentityFile`, `IdentitiesOnly=yes`,
project `UserKnownHostsFile`, `GlobalKnownHostsFile=none`,
`StrictHostKeyChecking=yes`, disabled DNS/known-host command/key updates, and
disabled control master/path. Do not add `-i`, use `ssh-add`, or merge user SSH
configuration.

## Authenticate and inspect the regular-user context

All guest invocations use the project config:

```sh
timeout 12s ssh -F "$CONFIG_PATH" \
  -o BatchMode=yes -o ConnectTimeout=5 -o ConnectionAttempts=1 \
  project-vm true

ssh -F "$CONFIG_PATH" project-vm \
  'id; printf "home=%s\n" "$HOME"; hostname; printf "cwd=%s\n" "$PWD"'

guest_home_b64=$(ssh -F "$CONFIG_PATH" project-vm \
  'printf %s "$HOME" | base64')
SIMPLE_GUEST_PARENT=$(GUEST_HOME_B64=$guest_home_b64 python3 - <<'PY'
import base64
import os
import re
from pathlib import PurePosixPath

encoded = "".join(os.environ["GUEST_HOME_B64"].split())
try:
    home = base64.b64decode(encoded, validate=True).decode("utf-8")
except (ValueError, UnicodeDecodeError) as exc:
    raise SystemExit("guest home was not valid base64 UTF-8") from exc
if not re.fullmatch(r"/[A-Za-z0-9._/-]+", home):
    raise SystemExit("guest home contains characters unsafe for transfer clients")
if str(PurePosixPath(home)) != home or home == "/":
    raise SystemExit("guest home is not a normalized absolute path")
print(home, end="")
PY
)
GUEST_PROJECT=$SIMPLE_GUEST_PARENT/project
```

Distinguish route timeout, refusal, host-key rejection, and authentication
rejection. Confirm the effective account is the intended non-root user. Capture
its absolute home as base64 remote data; do not assume `/home/<user>` or use a
local `~` expansion. The validation above intentionally restricts transfer
destinations to normalized paths made only from ordinary path characters.

## Transfer without copying credentials

The local runtime directory must never enter the guest. Prefer rsync and exclude
it explicitly even though it is Git-ignored:

```sh
rsync_wrapper=$(mktemp /tmp/project-vm-rsync.XXXXXX)
cat >"$rsync_wrapper" <<'EOF'
#!/bin/sh
exec ssh -F "$PROJECT_VM_CONFIG" "$@"
EOF
chmod 700 "$rsync_wrapper"
export PROJECT_VM_CONFIG=$CONFIG_PATH
rsync -a --protect-args --exclude='/.libvirt-toolkit/' \
  -e "$rsync_wrapper" -- "$PROJECT_ROOT/" "project-vm:$GUEST_PROJECT/"
```

If rsync is unavailable, do not recursively SCP the project root. Stage a safe
payload outside the project after positively selecting intended files and
confirming the staging tree contains no `.libvirt-toolkit`, private keys,
credential records, caches, or unrelated secrets. Replace the example selection
below with the explicit files needed for the requested work; do not add `.` or
the project root:

```sh
staging_dir=$(mktemp -d "${TMPDIR:-/tmp}/project-vm-stage.XXXXXX")
SAFE_STAGING_DIR=$staging_dir/project
install -d -m 0700 "$SAFE_STAGING_DIR"

# Positive allowlist example: replace these entries for the actual project.
set -- src tests pyproject.toml
for relative in "$@"; do
  case $relative in
    ''|/*|.|..|*/../*|../*|*/..|.libvirt-toolkit|.libvirt-toolkit/*)
      printf 'unsafe staging selection: %s\n' "$relative" >&2
      exit 1
      ;;
  esac
  [ -e "$PROJECT_ROOT/$relative" ] && [ ! -L "$PROJECT_ROOT/$relative" ] || exit 1
  cp -R -- "$PROJECT_ROOT/$relative" "$SAFE_STAGING_DIR/"
done

STAGED_ROOT=$SAFE_STAGING_DIR python3 - <<'PY'
import os
from pathlib import Path

root = Path(os.environ["STAGED_ROOT"])
blocked_parts = {".libvirt-toolkit", ".git", ".pytest_cache", "__pycache__", "node_modules"}
blocked_names = {"connection.json", "id_ed25519", "id_rsa", "known_hosts"}
for path in root.rglob("*"):
    relative = path.relative_to(root)
    if path.is_symlink() or blocked_parts.intersection(relative.parts) or path.name in blocked_names:
        raise SystemExit(f"unsafe staged path: {relative}")
    if path.is_file():
        if b"-----BEGIN OPENSSH PRIVATE KEY-----" in path.read_bytes():
            raise SystemExit(f"private SSH key in staged path: {relative}")
    elif not path.is_dir():
        raise SystemExit(f"non-file staged path: {relative}")
PY

guest_parent_b64=$(printf %s "$SIMPLE_GUEST_PARENT" | base64 | tr -d '\n')
ssh -F "$CONFIG_PATH" project-vm sh -s -- "$guest_parent_b64" <<'REMOTE'
set -eu
parent=$(printf %s "$1" | base64 -d)
[ "$parent" = "$HOME" ] && [ -d "$parent" ] || exit 1
[ ! -e "$parent/project" ] || {
  printf '%s\n' 'refusing to overwrite remote project destination' >&2
  exit 1
}
REMOTE
scp -F "$CONFIG_PATH" -r -- "$SAFE_STAGING_DIR" \
  project-vm:"$SIMPLE_GUEST_PARENT/"
ssh -F "$CONFIG_PATH" project-vm \
  'test -d "$HOME/project" && test ! -e "$HOME/project/.libvirt-toolkit"'
```

Verify destination ownership, expected files, and a revision or checksums when
meaningful. A zero transfer exit without destination inspection is insufficient.

## Run and report

Run only the requested command as the intended account from an explicit, simple
verified guest working directory. Hand even the validated path to a fixed remote
script as base64 data rather than interpolating it into remote shell source:

```sh
guest_project_b64=$(printf %s "$GUEST_PROJECT" | base64 | tr -d '\n')
timeout 20m ssh -F "$CONFIG_PATH" project-vm sh -s -- "$guest_project_b64" <<'REMOTE'
set -eu
project=$(printf %s "$1" | base64 -d)
[ "$project" = "$HOME/project" ] && [ -d "$project" ] || exit 1
[ ! -e "$project/.libvirt-toolkit" ] || exit 1
cd -- "$project"
exec python -m pytest -q
REMOTE
```

For other paths or command parameters, apply the same encoded-data/fixed-script
pattern rather than interpolating them. Report provider
connection identity, `creation_id`, VM UUID, account/public-key fingerprint,
endpoint and host-key evidence, guest account/home/cwd, transfer verification,
literal command, exit status, and relevant output. Never report private-key
content.
