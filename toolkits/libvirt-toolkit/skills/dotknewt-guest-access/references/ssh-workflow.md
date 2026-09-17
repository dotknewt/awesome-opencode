# SSH Workflow

Use these Bash examples only after filling parameters from evidence. Keep probes
bounded and noninteractive until trusted identity and authentication are known.

## Inventory and define the endpoint without defeating existing configuration

Prefer an existing SSH alias when one is supplied:

```bash
ssh_target='dev-guest'
ssh_args=()
scp_args=()
rsync_route_port=''
effective_config=$(ssh -G "${ssh_args[@]}" -- "$ssh_target")
printf '%s\n' "$effective_config" \
  | grep -E '^(hostname|user|port|proxyjump|proxycommand|hostkeyalias|identityfile|identityagent|identitiesonly|stricthostkeychecking|userknownhostsfile|globalknownhostsfile|knownhostscommand|verifyhostkeydns|updatehostkeys|controlmaster|controlpath|controlpersist) '
ssh-add -l
```

For a direct endpoint, keep address, port, and intended account separate:

```bash
guest_host='127.0.0.1'
guest_port='22042'
guest_user='developer'
ssh_target="${guest_user}@${guest_host}"
case "$guest_port" in
  *[!0-9]*|'') printf 'invalid SSH port: %s\n' "$guest_port" >&2; exit 1 ;;
esac
ssh_args=(-p "$guest_port")
scp_args=(-P "$guest_port")
rsync_route_port=$guest_port
effective_config=$(ssh -G "${ssh_args[@]}" -- "$ssh_target")
printf '%s\n' "$effective_config" \
  | grep -E '^(hostname|user|port|proxyjump|proxycommand|hostkeyalias|identityfile|identityagent|identitiesonly|stricthostkeychecking|userknownhostsfile|globalknownhostsfile|knownhostscommand|verifyhostkeydns|updatehostkeys|controlmaster|controlpath|controlpersist) '
ssh-add -l
```

Do not add `-F /dev/null`, `IdentitiesOnly=yes`, or an arbitrary `-i` merely to
make a probe look deterministic. Those options bypass compatible user config or
agent identities. Add an override only after the inventory shows why it is needed.
Empty route arrays preserve an alias's configured port, ProxyJump, identities,
agent, and other settings; direct endpoints populate the port once. The effective
configuration inventory is local-only: it performs no connection or
authentication. Record its trust settings, but do not rely on a permissive
`StrictHostKeyChecking` value, different user/global known-hosts files, a
`KnownHostsCommand`, DNS SSHFP trust, host-key updates, or an existing multiplexed
connection for this guest. The workflow below supplies stricter command-line
values after selecting and verifying a dedicated trust store.

## Verify host-key trust

Resolve the effective **guest endpoint** through SSH config before inspecting
trusted state. `HostKeyAlias` takes precedence when configured. Otherwise,
known-hosts uses the hostname for port 22 and bracketed host/port form for a
non-default port:

```bash
effective_host=$(printf '%s\n' "$effective_config" | awk '$1 == "hostname" {print $2; exit}')
effective_port=$(printf '%s\n' "$effective_config" | awk '$1 == "port" {print $2; exit}')
host_key_alias=$(printf '%s\n' "$effective_config" | awk '$1 == "hostkeyalias" {print $2; exit}')
if [ -n "$host_key_alias" ] && [ "$host_key_alias" != none ]; then
  known_host=$host_key_alias
elif [ "$effective_port" = 22 ]; then
  known_host=$effective_host
else
  known_host="[${effective_host}]:${effective_port}"
fi

# Select this path explicitly; quoting preserves spaces in an operator-selected path.
known_hosts_file=${GUEST_KNOWN_HOSTS_FILE:-"$HOME/.ssh/known_hosts"}
[ -n "$known_hosts_file" ] || { printf 'empty guest trust-store path\n' >&2; exit 1; }
case "$known_hosts_file" in
  /*) ;;
  *) printf 'guest trust-store path must be absolute: %s\n' "$known_hosts_file" >&2; exit 1 ;;
esac
known_hosts_dir=${known_hosts_file%/*}
[ -n "$known_hosts_dir" ] || known_hosts_dir=/
install -d -m 700 -- "$known_hosts_dir"
touch "$known_hosts_file"
chmod 600 "$known_hosts_file"
[ -w "$known_hosts_file" ] || {
  printf 'guest trust store is not writable: %s\n' "$known_hosts_file" >&2
  exit 1
}
ssh-keygen -F "$known_host" -f "$known_hosts_file"
```

Existing records for `known_host` must be compared with trusted evidence; do
not append around a conflict. The explicit command-line policy used later takes
precedence over permissive user configuration while leaving identity, agent,
ProxyJump, and other routing choices intact.

If no trusted key exists, request only the independently trusted algorithm. This
example expects an ED25519 fingerprint. Scan the effective guest endpoint, then
normalize its host field to the same `known_host` token SSH will verify:

```bash
trusted_fingerprint='SHA256:replace-with-trusted-ed25519-fingerprint'
scan_host=$effective_host
scan_port=$effective_port
candidate_file=$(mktemp)
verified_key_file=$(mktemp)
candidate_keys_file=$(mktemp)
rsync_ssh_wrapper=''
cleanup_guest_access_files() {
  rm -f "$candidate_file" "$verified_key_file" "$candidate_keys_file"
  [ -z "$rsync_ssh_wrapper" ] || rm -f "$rsync_ssh_wrapper"
}
trap cleanup_guest_access_files EXIT
timeout 8s ssh-keyscan -T 5 -t ed25519 -p "$scan_port" \
  "$scan_host" >"$candidate_file"
candidate_count=$(awk 'NF >= 3 && $2 == "ssh-ed25519" {print $2, $3}' \
  "$candidate_file" | sort -u | tee "$candidate_keys_file" | wc -l)
[ "$candidate_count" -eq 1 ] || {
  printf 'expected exactly one unique ED25519 candidate, got %s\n' \
    "$candidate_count" >&2
  exit 1
}
{
  printf '%s ' "$known_host"
  cat "$candidate_keys_file"
} >"$verified_key_file"
candidate_fingerprint=$(ssh-keygen -E sha256 -lf "$verified_key_file" \
  | awk '{print $2}')
printf 'candidate ED25519 fingerprint: %s\n' "$candidate_fingerprint"
[ "$candidate_fingerprint" = "$trusted_fingerprint" ] || {
  printf 'host-key fingerprint mismatch\n' >&2
  exit 1
}
```

`ssh-keyscan` does not follow SSH config's `ProxyJump`. If `effective_host` is not
directly reachable from the client, expose that guest endpoint through an
approved temporary tunnel using the configured jump alias, then set `scan_host`
and `scan_port` to the client side of that tunnel. Keep `known_host` derived from
the effective guest target (or `HostKeyAlias`), not from the jump host. The
remote-loopback example below applies this pattern concretely.

Authenticate that fingerprint through a separate trusted source: a verified
console, image/build record, provider-published fingerprint, or an operator who
can inspect the guest. `ssh-keyscan` itself authenticates nothing. After that
comparison succeeds, place the exact verified key in the selected known-hosts
file and enforce that file together with `StrictHostKeyChecking=yes`. Disable
additional global stores with `GlobalKnownHostsFile=none` so another configured
key cannot satisfy the check instead. Also disable `KnownHostsCommand` and DNS
SSHFP trust, prevent post-handshake host-key enrollment, and require a fresh
non-multiplexed connection. Never use `StrictHostKeyChecking=no` or an empty trust
store to work around a mismatch.

Append only after that trusted comparison and only when no conflicting record
was found above:

```bash
cat "$verified_key_file" >>"$known_hosts_file"
ssh-keygen -F "$known_host" -f "$known_hosts_file"
ssh_trust_args=(
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$known_hosts_file"
  -o GlobalKnownHostsFile=none
  -o KnownHostsCommand=none
  -o VerifyHostKeyDNS=no
  -o UpdateHostKeys=no
  -o ControlMaster=no
  -o ControlPath=none
)
```

`ControlPath=none` prevents reuse of an already-authenticated master connection,
which would skip the fresh guest host-key exchange these overrides are intended
to verify. Preserving existing routing, identity, and agent selection does not
mean preserving trust alternatives or connection reuse that bypasses this check.

Authenticate and enroll each algorithm independently when policy requires more
than ED25519. Never append unverified RSA/ECDSA lines returned by a broader scan.

For clones or rebuilt guests, compare the trusted source identity when available.
If the source or sibling cannot be inspected, mark that comparison `untested`.

## Verify the intended account and home

Only now probe SSH transport and intended-account authentication. The strict
overrides guarantee that the independently verified guest key is the key used by
this connection, even if the inventoried configuration was permissive:

```bash
timeout 12s ssh \
  -o BatchMode=yes \
  -o ConnectTimeout=5 \
  -o ConnectionAttempts=1 \
  "${ssh_trust_args[@]}" \
  "${ssh_args[@]}" \
  -- "$ssh_target" true
probe_status=$?
```

Record stderr and distinguish route/timeout, connection refusal, host-key
rejection, and authentication rejection. A refusal proves only that the probed
address and port rejected the connection from this origin. No SSH authentication
command belongs before guest-key verification and enrollment.

After that succeeds, run a fixed diagnostic command before constructing
destination paths:

```bash
ssh "${ssh_trust_args[@]}" "${ssh_args[@]}" -- "$ssh_target" \
  'id; printf "home=%s\n" "$HOME"; hostname; printf "cwd=%s\n" "$PWD"'
```

Confirm the effective user is the intended regular account. Capture the guest's
home as data without allowing the client shell to expand guest syntax:

```bash
guest_home=$(
  ssh "${ssh_trust_args[@]}" "${ssh_args[@]}" -- "$ssh_target" 'printf "%s" "$HOME"'
)
case "$guest_home" in
  /*) ;;
  *) printf 'guest returned an invalid home: %s\n' "$guest_home" >&2; exit 1 ;;
esac
```

Do not write `"$ssh_target:~/project"`: the meaning of `~`, quoting, and the
remote transfer shell can differ. Build the path from the verified guest home.
Use a simple generated project directory name when possible:

```bash
project_name='example-project'
guest_project="${guest_home%/}/workspace/${project_name}"
```

For remote shell operations on that path, encode it after confirming `base64` is
available on both ends. This preserves spaces and shell metacharacters as data:

```bash
guest_project_b64=$(printf '%s' "$guest_project" | base64 | tr -d '\n')
ssh "${ssh_trust_args[@]}" "${ssh_args[@]}" -- "$ssh_target" \
  "GUEST_PROJECT_B64='$guest_project_b64' sh -s" <<'REMOTE'
set -eu
guest_project=$(printf '%s' "$GUEST_PROJECT_B64" | base64 -d)
mkdir -p -- "$guest_project"
REMOTE
```

## Transfer and inspect the destination

Prefer rsync when available because `--protect-args` preserves a remote path as
one argument. Give rsync a temporary executable wrapper so its remote-shell
string parser never has to interpret shell escaping for a trust-store path that
may contain spaces. The wrapper adds only verified trust policy and the direct
endpoint's port; the underlying SSH invocation still reads configured identity,
agent, and ProxyJump routing. `/tmp` keeps the executable path itself free of
spaces. The trailing slashes copy project contents into the destination:

```bash
local_project='/absolute/client/path/example-project/'
rsync_ssh_wrapper=$(mktemp /tmp/guest-access-rsync-ssh.XXXXXX)
cat >"$rsync_ssh_wrapper" <<'WRAPPER'
#!/bin/sh
set -eu
set -- -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$GUEST_KNOWN_HOSTS_FILE" \
  -o GlobalKnownHostsFile=none \
  -o KnownHostsCommand=none \
  -o VerifyHostKeyDNS=no \
  -o UpdateHostKeys=no \
  -o ControlMaster=no \
  -o ControlPath=none "$@"
if [ -n "${GUEST_SSH_PORT:-}" ]; then
  set -- -p "$GUEST_SSH_PORT" "$@"
fi
exec ssh "$@"
WRAPPER
chmod 700 "$rsync_ssh_wrapper"
export GUEST_KNOWN_HOSTS_FILE=$known_hosts_file
export GUEST_SSH_PORT=$rsync_route_port
rsync -a --protect-args -e "$rsync_ssh_wrapper" \
  -- "$local_project" "${ssh_target}:${guest_project}/"
ssh "${ssh_trust_args[@]}" "${ssh_args[@]}" -- "$ssh_target" \
  "GUEST_PROJECT_B64='$guest_project_b64' sh -s" <<'REMOTE'
set -eu
guest_project=$(printf '%s' "$GUEST_PROJECT_B64" | base64 -d)
test -d "$guest_project"
stat -c '%U:%G %n' "$guest_project"
find "$guest_project" -mindepth 1 -maxdepth 1 -print
if git -C "$guest_project" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$guest_project" status --short
fi
REMOTE
```

Use SCP only when rsync is unavailable and the destination path is simple and
verified. Modern OpenSSH uses SFTP mode by default:

```bash
simple_guest_parent="${guest_home%/}/workspace"
scp "${ssh_trust_args[@]}" "${scp_args[@]}" -r -- "/absolute/client/path/$project_name" \
  "${ssh_target}:${simple_guest_parent}/"
```

Restrict this SCP form to a destination verified to contain only ordinary path
characters; otherwise use rsync with `--protect-args`. Verify the resulting path
with the encoded fixed-script pattern above.

Verify ownership, expected files, and revision or checksums as appropriate. Keep
the client source path distinct from virtualization-host paths and guest paths.

## Run a command with an explicit guest cwd

For a simple verified destination and a literal requested command, make the cwd
and completion status visible:

```bash
requested_command='python -m pytest -q'
requested_command_b64=$(printf '%s' "$requested_command" | base64 | tr -d '\n')
timeout 20m ssh "${ssh_trust_args[@]}" "${ssh_args[@]}" -- "$ssh_target" \
  "GUEST_PROJECT_B64='$guest_project_b64' REQUESTED_COMMAND_B64='$requested_command_b64' sh -s" <<'REMOTE'
set -eu
guest_project=$(printf '%s' "$GUEST_PROJECT_B64" | base64 -d)
requested_command=$(printf '%s' "$REQUESTED_COMMAND_B64" | base64 -d)
cd -- "$guest_project"
exec sh -lc "$requested_command"
REMOTE
command_status=$?
printf 'guest command exit=%s\n' "$command_status"
```

Keep the remote script fixed and pass path and command text through the verified
encoding rather than interpolating them as shell syntax. Report the literal
requested command, client endpoint, guest account, guest cwd, exit status, and
relevant stdout/stderr. A timeout is a distinct result, not successful completion.

## Remote virtualization hosts

Treat a forward bound to `127.0.0.1` on a remote virtualization host as reachable
only on that host. Either run the SSH client there through an approved management
path or establish an explicit tunnel/jump from the client. Record which origin
performed host-key verification, authentication, transfer, and command execution;
do not rewrite `127.0.0.1` as though it referred to the user's workstation.

For Scenario C's remote-host loopback forward, reserve a client-local port and
open an approved tunnel in a dedicated terminal:

```bash
virtualization_host_alias='hv-east'
remote_guest_port='22241'
client_tunnel_port='32241'
ssh -N -o ExitOnForwardFailure=yes \
  -L "127.0.0.1:${client_tunnel_port}:127.0.0.1:${remote_guest_port}" \
  -- "$virtualization_host_alias"
```

Keep that terminal open only for the workflow. Define a separate guest alias so
SSH uses the tunneled endpoint while storing the **guest's** key under a stable
guest identity rather than under the virtualization host or generic loopback:

```sshconfig
Host parser-vm-via-hv-east
  HostName 127.0.0.1
  Port 32241
  User dev
  HostKeyAlias parser-vm@hv-east
```

Then select `ssh_target='parser-vm-via-hv-east'` with empty `ssh_args` and
`scp_args`. `ssh -G` resolves `127.0.0.1:32241` as the scan endpoint and
`parser-vm@hv-east` as `known_host`; compare the resulting guest-key fingerprint
with trusted guest evidence. The `hv-east` host key authenticates only the
separately trusted outer tunnel and must not be enrolled as the guest key.
Opening that tunnel is not an authentication attempt to the guest; perform it
only after the management alias's own host identity is already trusted. Guest
authentication still waits until the tunneled guest key has been independently
verified and enrolled in the explicit guest trust store. Close the tunnel when
finished.
