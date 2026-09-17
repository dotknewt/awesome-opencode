# Synthetic guest-access scenarios

These records are synthetic evaluation inputs. They are not authorization to run
live commands.

## Scenario A — lifecycle MCP and QGA, no passt forward

- Requested outcome: copy `/work/ledger-api` into `dev-clone` and run its unit tests
- Provider / host / owner / session / domain: libvirt / workstation / alex / `qemu:///session` / `dev-clone`
- Connection origin: workstation
- Candidate endpoint and provenance: unknown; `vm_inspect` exposes no guest-access endpoint
- Intended account / home: `developer` / unknown
- Identity evidence: domain UUID is unique; guest and SSH identity untested
- Available tooling: lifecycle-only libvirt MCP; QGA supports guest-exec; local `ssh`, `ssh-keygen`, `ssh-keyscan`, and `rsync`
- Lifecycle: verified running
- Guest prerequisites: untested; root QGA reports sshd active and account `developer`, but does not verify intended-user access
- Networking evidence: source template used libvirt passt; clone definition has no passt port-forward
- SSH authentication: untested
- Clone identity: untested
- Transfer: untested
- Requested execution: untested

## Scenario B — guest-reported address resolves host-local

- Requested outcome: diagnose SSH refusal to `qa-vm` before copying a patch
- Provider / host / owner / session / domain: libvirt / workstation / developer / `qemu:///session` / `qa-vm`
- Connection origin: workstation
- Candidate endpoint and provenance: `192.168.0.20:22`, reported by the guest agent for `qa-vm`
- Intended account / home: `qa` / unknown
- Identity evidence: known-hosts has no entry for the candidate
- Available tooling: workstation `ssh`, `ip` route inspection, `rsync`, lifecycle-only libvirt MCP, and QGA diagnostics
- Route evidence: workstation `ip route get 192.168.0.20` returns `local 192.168.0.20 dev lo src 192.168.0.20 uid 1000 cache <local>`
- Probe evidence: workstation TCP connection to `192.168.0.20:22` returned connection refused; because the route is class `local` on `dev lo`, this probe does not reach the guest or prove guest sshd failure
- Lifecycle: verified running
- Guest prerequisites: untested; QGA reports sshd listening on guest port 22 as partial evidence; intended `qa` account, home, and required tools still require verification
- SSH authentication: untested
- Clone identity: not applicable
- Transfer: untested
- Requested execution: not applicable

## Scenario C — remote host loopback forward and project tests

- Requested outcome: sync `/srv/projects/parser` into `parser-vm` and run `python -m pytest -q`
- Provider / host / owner / session / domain: libvirt / `hv-east` / vm-owner / `qemu:///session` / `parser-vm`
- Connection origin: developer laptop
- Candidate endpoint and provenance: `127.0.0.1:22241`, passt forward verified on `hv-east`
- Intended account / home: `dev` / `/home/dev`
- Identity evidence: operator console confirms guest SSH ED25519 fingerprint `SHA256:SYNTHETIC`; laptop has no trusted entry yet
- Available tooling: laptop SSH config alias `hv-east`, ssh-agent, `ssh`, `ssh-keyscan`, and `rsync`; the remote host allows an approved SSH tunnel
- Lifecycle: verified running
- Guest prerequisites: verified; sshd and `dev` account verified through operator console
- SSH authentication: untested
- Clone identity: untested; operator confirms regenerated guest machine-id, but source/sibling SSH-key comparison is unavailable
- Transfer: untested
- Requested execution: untested
