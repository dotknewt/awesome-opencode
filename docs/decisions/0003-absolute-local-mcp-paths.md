# ADR 0003: Absolute local MCP paths and explicit relocation

Status: accepted (2026-09-16)

## Decision

Resolve each MCP entrypoint to its absolute managed installation path. Treat one
installation as local to one OpenCode target and one server host/user. Do not
infer relocation or remote deployment.

## Consequences

Runtime is independent of cwd and source checkout. Moving a project or XDG root
invalidates both command and ownership paths; the supported process is uninstall
at the old path, move, reinstall, restart. If already moved, return it to the old
absolute path first. `update` cannot repair relocation. Remote stdio over SSH is
manual, separately configured, and outside installer/discovery guarantees.
