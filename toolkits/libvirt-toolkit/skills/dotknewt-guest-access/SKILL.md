---
name: dotknewt-guest-access
description: Use when an existing VM must be reached over SSH, guest access is refused or unreachable, a project must be copied or synchronized into a guest, or commands and tests must run inside the guest. Do not use for lifecycle-only requests such as listing, starting, stopping, snapshotting, or deleting VMs.
---

# Guest Access

Continue an existing-VM request through verified access, transfer, and regular-user
execution. Treat lifecycle state, guest prerequisites, SSH authentication, clone
identity, transfer, and requested execution as separate claims. Never turn one
successful signal into proof of another stage.

Use `references/ssh-workflow.md` for concrete SSH, host-key, transfer, and remote
execution commands.

## Start from a handoff

Create or update a lightweight Markdown handoff. Preserve unknown values as
`unknown` until investigation produces evidence.

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

Use only `verified`, `failed`, `untested`, or `not applicable` for stage status.
Keep the provider host, session, and domain explicit when supplied by another
skill. Invoke provider-specific skills by name for provider work; do not assume
their files or tools exist in a standalone installation.

## Inventory capabilities before conclusions

1. Inventory the installed project helper, its bound credential/config, route
   inspection, transfer tools, and provider-reported diagnostics. Do not inspect
   SSH-agent identities or personal `~/.ssh` defaults for project VM access.
2. Record what each tool can actually prove. A lifecycle-only provider API does
   not prove the host lacks SSH, networking, or guest-execution capabilities.
3. Treat a guest agent as an optional diagnostic path. Discover supported guest
   commands, bound polling, decode output, and distinguish process creation from
   completion. Do not treat privileged guest-agent execution as proof of SSH,
   the intended account, its home, or its project workflow.
4. Request only the missing evidence or provider action needed for the next
   stage. Do not perform guest setup for a lifecycle-only request.

## Verify the path and endpoint

Identify three locations separately:

- **Client:** where SSH or transfer commands originate.
- **Virtualization host:** where provider-local addresses and forwards exist.
- **Guest:** where the intended account and project live.

Record every candidate address and port with provenance: provider inspection,
guest report, configured forward, SSH config, or operator input. Inspect routing
from the connection origin before interpreting an advertised guest IP or a
refused connection. A host-local bridge address may be valid on the
virtualization host but unreachable from the client. A loopback forward on a
remote virtualization host is remote loopback, not client loopback; require an
explicit route, jump, or tunnel rather than pretending it is local.

Use a bounded, noninteractive transport probe. Interpret timeout, refusal,
host-key failure, and authentication failure as different evidence. Do not
rewrite guest firewall, sshd, keys, or provider networking merely because the
first candidate endpoint fails.

## Establish trusted SSH identity and authentication

For toolkit-created project VMs, require the helper's bound `creation_id`,
provider-returned VM UUID, account, and public-key fingerprint. Verify rather
than rotate credentials on normal start, reconnect, and snapshot restore. A
missing local key or recreated VM UUID blocks access and requires the explicit
new-creation workflow; never overwrite another VM's credential directory.

Verify the host key through a trusted channel before accepting it. Treat
`ssh-keyscan` output as an unauthenticated candidate key, never as identity
proof. Reconcile changed keys with clone/rebuild evidence instead of disabling
host-key checking.

Inventory effective SSH configuration only with
`ssh -G -F <project-config> project-vm`. Use that config for every guest SSH,
SCP, and rsync invocation. It
must select the project private key and project-local trust store with
`StrictHostKeyChecking=yes`; never merge home configuration or agent identities. Existing
permissive files, known-hosts commands, DNS SSHFP trust, post-handshake key
updates, or multiplexed master connections must not relax or bypass guest trust.
Require a fresh host-key exchange. A routed management connection uses its own
explicitly selected management config; the generated guest config still owns
guest identity and trust. Do not attempt guest authentication before host-key
verification. Authenticate noninteractively to the intended regular account and
distinguish successful TCP, host-key verification, and account authentication.

When working with a clone, verify guest and SSH identity independently where
relevant. Compare source or sibling evidence when it is available. Require that
comparison to pass only when the requested outcome or an applicable policy
explicitly requires clone-uniqueness proof. Otherwise, report an unavailable
comparison as `untested`, disclose the residual uncertainty, and continue: that
missing comparison does not block independently trusted SSH authentication,
transfer, or execution. Endpoint host-key trust and intended-account
authentication remain mandatory. A new domain UUID, MAC, or successful privileged
guest-agent command does not prove regenerated guest or SSH identity.

## Verify the regular-user context

After authentication, query the intended account, effective UID, home directory,
hostname, and working directory. Require a regular user unless the user explicitly
requested an administrative diagnostic. Derive the destination from the guest's
reported home rather than assuming `/home/<name>` or expanding a local `~`.

Keep path ownership clear:

- Client paths belong to the machine running transfer commands.
- Host paths belong to the virtualization host and its provider owner.
- Guest paths belong to the authenticated guest account.

Do not use root QGA output as normal-user setup evidence.

## Transfer and verify

Choose an available transfer tool after inventory. Preserve the project SSH
configuration and verified host-key policy. Exclude the entire anchored
`/.libvirt-toolkit/` tree from rsync. For an SCP fallback, stage a positively
selected safe payload outside the project rather than recursively copying the
project root. Transfer into a destination owned by
the intended guest user, then verify destination existence, ownership, expected
files, and—when meaningful—a source/destination revision or checksum. Keep local
and guest paths explicit. Do not claim transfer success from a zero exit alone if
the destination was never inspected.

## Execute the requested command

Run only the requested command as the intended guest account from an explicit
guest working directory. Capture the exact command, endpoint, execution account,
cwd, exit status, and relevant stdout/stderr. A test process starting is not the
same as tests completing; use a bounded wait and preserve the final result.

## Report by stage

Return a compact stage table and keep failures local to their stage:

| Stage | Status | Evidence / next action |
|---|---|---|
| Lifecycle | verified / failed / untested / not applicable | Provider/domain evidence |
| Guest prerequisites | ... | sshd/account/tool evidence |
| SSH authentication | ... | Endpoint, trusted key, account result |
| Clone identity | ... | Compared identities or unavailable comparison |
| Transfer | ... | Destination verification |
| Requested execution | ... | Command, location/account/cwd, exit, output |

Treat a stage as required only when the requested outcome or an applicable policy
depends on it. Do not report the requested outcome complete while such a stage is
`untested` or `failed`; state the narrow blocker and evidence needed next. For a
project workflow, endpoint host-key trust, intended-account authentication,
transfer verification, and requested execution evidence are required. Clone
source/sibling comparison is required only by an explicit clone-uniqueness need;
when it is unavailable otherwise, keep clone identity `untested` and disclosed
without blocking independently trusted authentication, transfer, or execution.

## Common mistakes

- Equating a running VM or working guest agent with usable SSH access.
- Treating a scanned host key as trusted identity.
- Trying a guest-reported address without checking the route from the client.
- Treating remote-host loopback as client loopback.
- Falling back to personal SSH config, an agent, or default known-hosts files.
- Copying `.libvirt-toolkit` credentials with rsync or recursive SCP.
- Assuming a guest home or allowing local shell expansion to choose it.
- Running setup as root and reporting it as the intended user's workflow.
- Reporting transfer or tests complete without destination or exit evidence.
