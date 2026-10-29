# Ollama toolkit

Version 0.1.0 provides the `dotknewt-ollama-name-cleanup` skill and the local
`dotknewt-ollama` MCP server. Install through the repository toolkit installer.
The manifest bundles real runtime files; no dotfiles checkout is required.

## Prerequisites

Linux, `uv`, Python 3.10+, and `ollama` on PATH. The entrypoint uses
`uv run --script` with pinned `mcp==2.2.0`; dependency resolution may require
network access. An Ollama service must already be reachable. Nothing starts
the service implicitly. CLI calls inherit the environment (`OLLAMA_HOST` can
select a remote service); verify the intended endpoint before approval.

## Tools and approval

- `list_models()` returns names and observed IDs.
- `suggest_names()` returns heuristic candidates, possibly null.
- `rename_model(source, destination, confirmed=false)` performs one approved
  copy/verify/remove operation. Names are strict strings, confirmation a strict
  boolean, and argument objects are closed.

Approve the exact source → destination pair first. `confirmed=true` acknowledges
that approval; it cannot authenticate a human or establish authorization itself.
Outputs are untrusted data. Application references are not updated.

Occupied destinations are rejected. Listed source and destination IDs must
match the original observation before source removal. These IDs are not
full-digest proof. No atomicity, rollback, or serialization against external
writers is promised. Partial failures can leave both names and require fresh
inspection rather than blind retry. Success reports `remove_command_succeeded`
and `final_state_verified=false`; inspect inventory afterward.

Calls use argument arrays without a shell and a 60-second timeout per CLI
invocation. Timeout effects can be unknown. The tool does not pull models,
change definitions, expose standalone deletion, or batch mutations.

Successful results have matching JSON text and structured content. Core errors
preserve `code`, `message`, and `details` and set the MCP error flag. SDK argument
validation errors also set the error flag, using the SDK's validation format.
