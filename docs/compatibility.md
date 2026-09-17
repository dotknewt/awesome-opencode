# Compatibility and evidence

Evidence was measured on 2026-09-17, not inferred from an exact-version support
promise.

| Surface | Supported/measured | Evidence boundary |
|---|---|---|
| Installer runtime | Linux, Node.js >=22, util-linux `flock` | CLI preflight plus parent-owned inherited-FD concurrency/recovery tests |
| Python server | Python >=3.10; acceptance uses 3.13 and `mcp==2.2.0` | Full fake-adapter unittest suite and isolated PEP 723 `--help` launch |
| OpenCode config schema | Public `https://opencode.ai/config.json` | Generated `dotknewt-libvirt` entry validated separately against `$defs.McpLocalConfig` |
| OpenCode discovery | OpenCode 1.18.31 measured | Isolated HOME/XDG project, `--pure`, plugins/providers/extra skills disabled, MCP disabled; two native skills and config path observed |
| qemu images | Optional local `qemu-img` | Temporary qcow2 create/convert/backing-chain tests only |
| libvirt | `virsh`, `qemu-img`, per-user `qemu:///session` required for real use | No CI/live acceptance; lifecycle tests use fake command adapters |

The discovery check proves native startup-time resolution, not an MCP handshake,
dependency download, server launch, libvirt connectivity, SSH transport, or VM
lifecycle. The schema check is separate because discovery alone does not validate
the authoritative schema.

The server is host-local: paths, ownership, state, and `qemu:///session` belong to
the user and machine running it. Manual stdio over SSH is documented, but the
installer does not deploy remote hosts and no multi-host claim is made.

Schema acceptance needs network access. Server first launch also needs network
access unless the required Python/runtime artifacts are cached. Dedicated CI
installs `uv`, `qemu-img`, and the measured OpenCode npm package and fails on
missing setup; local aggregate tests may report explicit prerequisite skips.

OpenCode is a moving target. Compatibility is based on schema validation and
actual isolated discovery rather than pinning runtime support to 1.18.31. New
native fields or discovery assumptions require both checks to be updated.
