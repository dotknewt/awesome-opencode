# ADR 0001: Native, self-contained OpenCode toolkits

Status: accepted (2026-09-16)

## Decision

Use strict toolkit manifests and copy real files into OpenCode's native skill and
configuration locations. Write `type: "local"` MCP entries and validate them
against OpenCode's public schema and actual isolated discovery.

## Consequences

Installed content survives removal of the package source and repository. Claude
marketplace registration, `${CLAUDE_PLUGIN_ROOT}`, and symlink projection are not
supported. Package acceptance must test copied tarball content after source
removal.
