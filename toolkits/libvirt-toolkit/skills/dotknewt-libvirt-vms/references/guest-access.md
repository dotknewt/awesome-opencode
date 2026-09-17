# Libvirt guest-access handoff

Use this provider recipe when a request continues beyond libvirt lifecycle into
guest access, project transfer, or guest execution. Keep lifecycle operations on
the selected `dotknewt-libvirt` MCP connection. Invoke `dotknewt-guest-access` by name for
SSH trust, authentication, transfer, and regular-user execution; do not duplicate
or replace that skill's transport workflow here.

## Establish the provider context

Record the MCP connection, virtualization host, VM owner, libvirt session, and
domain before interpreting any address or changing a persistent definition:

```markdown
## Guest-access handoff
- Requested outcome:
- Provider / host / owner / session / domain: libvirt / <host> / <owner> / qemu:///session / <domain>
- Provider connection identity: <exact MCP connection name>
- Connection origin: <client, virtualization host, or named jump path>
- Candidate endpoint and provenance: unknown
- Intended account / home: <account> / unknown
- Domain and guest identity evidence: <domain UUID/MAC>; guest identity unknown
- Credential creation_id / VM UUID / account / public-key fingerprint: <values or unknown>
- Installed helper / credential directory / generated SSH config: <absolute paths or unknown>
- Available tooling: <MCP connection, virsh access, route tools, SSH client, optional QGA>
- Lifecycle: untested
- Guest prerequisites: untested
- SSH authentication: untested
- Clone identity: untested
- Transfer: untested
- Requested execution: untested
```

Use only `verified`, `failed`, `untested`, or `not applicable` for stage status.
Confirm the selected connection with `host_info`, then use `vm_list` and
`vm_inspect` on that same connection. On the virtualization host, compare the
VM owner's actual environment and session when needed:

```sh
SESSION='qemu:///session'
DOMAIN='replace-with-exact-domain'
virsh --connect "$SESSION" domuuid "$DOMAIN"
virsh --connect "$SESSION" domstate "$DOMAIN"
virsh --connect "$SESSION" dumpxml --inactive "$DOMAIN"
virsh --connect "$SESSION" domiflist "$DOMAIN"
virsh --connect "$SESSION" domifaddr "$DOMAIN" --source agent
```

Treat `domifaddr` as one candidate source, not as reachability proof. The guest
agent source may be unavailable, and an address reported on a host-local bridge
may have no route from the client. Inspect the route from the actual connection
origin (for example, `ip route get <candidate-address>` on that machine) before
probing. Keep these path origins distinct:

- client paths and client loopback belong to the SSH/transfer origin;
- virtualization-host paths, listeners, and `qemu:///session` belong to the VM owner;
- guest paths and homes belong to the authenticated guest account.

## Provision a new VM's login key before first boot

For a new project VM, invoke `dotknewt-guest-access` by name and use its installed
helper before calling `vm_create`. The local helper creates the `creation_id` and
private key; neither enters the MCP request. Read the one-line public key from
the emitted `public_key_path`, then call the selected libvirt MCP connection:

```json
{
  "name": "<unique-project-vm>",
  "template": "<published-template>",
  "version": "<immutable-version>",
  "guest_user": "<prepared-account>",
  "ssh_public_key": "ssh-ed25519 AAAA..."
}
```

Exactly one of `guest_user` and `ssh_public_key` is invalid. The key has no
options; it may have one optional whitespace-free comment token. Creation replaces the selected account's complete
`authorized_keys` file in the new writable overlay before domain definition or
first boot; it never customizes the published backing image. No personal key,
SSH-agent identity, or template login key is a fallback.

Require the response's separately generated `uuid` plus exactly the matching
`guest_access.user`, `guest_access.fingerprint`, and
`guest_access.status=provisioned`. Bind the local `creation_id` to that UUID and
fingerprint with the helper; `bind` receives metadata, not private-key content.
Keep the exact MCP connection name, host, owner, session, and domain in the
handoff because `provider=libvirt` alone is ambiguous.

If the response is an error or VM outcome is uncertain, leave the helper record
pending and stop mutations for recovery. A definite new creation gets another
fresh credential. On start, reconnect, or snapshot restore, verify the existing
bound record instead of preparing or rotating a key. Missing local keys block
access; a VM recreated under a new UUID requires a new credential while the old
directory remains untouched.

## Configure a unique passt loopback forward

Use this path only for a managed working VM with a supported user-mode
interface. A clone has no inherited fixed forward: the clone sanitizer removes
every `portForward` to prevent sibling collisions. If the VM is running, request
graceful shutdown through `vm_shutdown` with a bounded wait, reinspect, and
continue only after `vm_inspect` confirms shut off. Never infer shutdown from a
timeout and never force-stop without separate explicit authorization. Stop on
ownership rejection or `recovery_required`; do not edit around those gates.

Before choosing a port or changing persistent XML, verify that `passt` is
installed, executable, and discoverable for the VM owner on the selected
virtualization host. Run this in that owner's environment, not on the client:

```sh
passt_path=$(command -v passt) || {
  printf 'passt is required for the requested loopback forwarding path; install it for the VM owner or authorize an administrator to do so\n' >&2
  exit 1
}
[ -x "$passt_path" ] || {
  printf 'passt is not executable by the VM owner: %s\n' "$passt_path" >&2
  exit 1
}
"$passt_path" --version
```

Record the path, version output, execution location, and VM owner under **Guest
prerequisites**. If lookup, execution, or authorization fails, stop with that
narrow prerequisite blocker. Do not edit XML and do not substitute a different
network backend. This check establishes host capability only; the post-start
listener and endpoint probe below remain required.

Choose an unprivileged port from 1024 through 65535 on the virtualization host.
Check both active listeners and every sibling's persistent inactive definition
as the same VM owner:

```sh
HOST_PORT='replace-with-unused-unprivileged-port'
case "$HOST_PORT" in
  *[!0-9]*|'') printf 'invalid port: %s\n' "$HOST_PORT" >&2; exit 1 ;;
esac
[ "$HOST_PORT" -ge 1024 ] && [ "$HOST_PORT" -le 65535 ] || exit 1
ss -H -ltn "sport = :$HOST_PORT"
virsh --connect "$SESSION" list --all --name | while IFS= read -r sibling; do
  [ -n "$sibling" ] || continue
  printf '\n== %s ==\n' "$sibling"
  virsh --connect "$SESSION" dumpxml --inactive "$sibling" \
    | grep -nE '<portForward|<range ' || true
done
```

No listener plus no configured sibling forward reduces collision risk; it does
not reserve the port. Another process can claim it before start. Keep the VM shut
off and add this exact shape to its persistent user interface, replacing only the
selected host port:

```xml
<backend type="passt"/>
<portForward proto="tcp" address="127.0.0.1">
  <range start="HOST_PORT" to="22"/>
</portForward>
```

Do not add wildcard/non-loopback binds, UDP, an unbounded range, passt host-device
selection, or backend attributes. Preserve the existing MAC, model, and other
interface data. As the VM owner on the selected virtualization host, run
`virsh --connect "$SESSION" edit "$DOMAIN"` while the domain is confirmed shut
off, add the XML to the persistent user interface, then re-read it with
`virsh --connect "$SESSION" dumpxml --inactive "$DOMAIN"`. Confirm the domain,
interface, bind address, selected host port, and guest destination 22. Start the
VM through `vm_start` on the original MCP connection, then call `vm_inspect`
again. Check the actual virtualization-host listener and probe the endpoint from
the stated connection origin; configuration alone is not access evidence.

For a local virtualization host, the candidate endpoint is
`127.0.0.1:<HOST_PORT>` on that host. For a remote virtualization host, that is
remote loopback, not client loopback. Use an approved management alias to create
a separate client-side tunnel, for example:

```sh
VIRTUALIZATION_HOST_ALIAS='replace-with-approved-host-alias'
CLIENT_TUNNEL_PORT='replace-with-unused-client-port'
MANAGEMENT_CONFIG=/absolute/path/to/approved-management-ssh-config
ssh -F "$MANAGEMENT_CONFIG" -N -o ExitOnForwardFailure=yes \
  -L "127.0.0.1:${CLIENT_TUNNEL_PORT}:127.0.0.1:${HOST_PORT}" \
  -- "$VIRTUALIZATION_HOST_ALIAS"
```

Authenticate the outer SSH connection as the virtualization host. Preserve a
separate stable `HostKeyAlias` for the guest reached through the client tunnel;
the virtualization-host key and the guest key are different trust identities.
Record the tunneled client endpoint and its provenance in the handoff, then let
`dotknewt-guest-access` perform trusted guest host-key verification and authentication.
That skill's generated project config is mandatory for every guest SSH, SCP,
rsync, and `ssh -G` invocation; the explicit management config above is only for
the separately trusted outer route.

## Optional read-only QEMU guest-agent diagnosis

Use QGA only to gather missing prerequisite evidence when the selected host,
owner, session, and domain are explicit. First record `domuuid`, `domstate`, and
inactive XML identity, then inspect QGA capabilities:

```sh
virsh --connect "$SESSION" qemu-agent-command --pretty "$DOMAIN" \
  '{"execute":"guest-info"}'
```

Confirm `guest-exec` and `guest-exec-status` are present and enabled before use.
Issue only a read-only probe such as `/usr/bin/id`, capture its returned PID, and
poll a bounded number of times:

```sh
exec_reply=$(
  virsh --connect "$SESSION" qemu-agent-command "$DOMAIN" \
    '{"execute":"guest-exec","arguments":{"path":"/usr/bin/id","arg":[],"capture-output":true}}'
)
pid=$(printf '%s' "$exec_reply" | python3 -c \
  'import json,sys; print(json.load(sys.stdin)["return"]["pid"])')

status_reply=''
attempt=1
while [ "$attempt" -le 10 ]; do
  request=$(printf '{"execute":"guest-exec-status","arguments":{"pid":%s}}' "$pid")
  status_reply=$(virsh --connect "$SESSION" qemu-agent-command "$DOMAIN" "$request") || exit 1
  exited=$(printf '%s' "$status_reply" | python3 -c \
    'import json,sys; print(str(json.load(sys.stdin)["return"].get("exited", False)).lower())')
  [ "$exited" = true ] && break
  sleep 1
  attempt=$((attempt + 1))
done

STATUS_REPLY="$status_reply" python3 - <<'PY'
import base64, json, os
result = json.loads(os.environ["STATUS_REPLY"])["return"]
if result.get("exited") is not True or "exitcode" not in result:
    raise SystemExit("guest-exec did not reach an exited status with exitcode")
for field in ("out-data", "err-data"):
    data = result.get(field)
    if data is not None:
        print(f"{field}: {base64.b64decode(data).decode('utf-8', errors='replace')}")
print("exitcode: %s" % result["exitcode"])
PY
```

Require `exited: true`, an `exitcode`, and decoded captured stdout/stderr before
claiming the probe completed. An unavailable guest agent, disabled QGA commands,
or failed probe does not prove that SSH or every guest transport is unavailable.
QGA success commonly reflects privileged execution; it proves neither SSH
authentication nor the intended regular account, home, clone identity, transfer,
or project setup.

## Complete the handoff

Update candidate endpoint provenance, domain/guest identity evidence, available
tools, and every stage status. Invoke `dotknewt-guest-access` by name with the completed
handoff. Require trusted SSH host identity and intended-account authentication
before project execution. Perform clone identity comparisons when evidence is
available or clone-uniqueness proof is explicitly required. When retained-source
or sibling evidence cannot be inspected, record the comparison as `untested` and
never infer uniqueness from a fresh libvirt UUID or MAC. That missing comparison
blocks project execution only when the user or an applicable policy requires
clone-uniqueness proof; otherwise continue independently trusted authentication,
transfer, and execution while disclosing the uncertainty.
