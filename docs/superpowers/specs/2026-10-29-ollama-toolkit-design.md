# Ollama name-cleanup toolkit

## Intent and approval

Expose the naming workflow from the user's `ollama_name_cleanup.py` as a
self-contained toolkit for agents working on Ollama model names. The user
selected skill + MCP tools, limited scope to name cleanup, and approved the
design in conversation on 2026-10-29.

## Goals and boundaries

- A discoverable skill guides read-only inspection, naming suggestions, and
  explicitly authorized single-model renames through local MCP tools.
- Renaming rejects occupied destinations, copies the model, verifies listed
  identity and the unchanged source, then removes the original name.
- Failed verification does not remove the original. Partial failures report
  what was attempted and what remains known, without claiming rollback.
- Exact source → destination approval is required before mutation. A tool
  argument is an agent acknowledgement, not proof of human authorization.
- No pulls, model-definition changes, standalone deletion, or batch mutation.
- Leave the dotfiles script unchanged. Ship real bundled files, never runtime
  references to that checkout. Preserve consumer configuration and data.
- Concurrent external writers remain a documented limitation; no atomic rename
  or protection against arbitrary external changes is promised.

## Approaches

Skill + bundled shell-invoked Python helper was the smaller alternative.
The user chose skill + MCP tools for directly callable operations despite the
additional MCP runtime/configuration dependency. Native custom-tool exports
are outside the current manifest contract and are not needed.

## Implementation direction (builder decisions)

Use `toolkits/ollama-toolkit/`, namespace `dotknewt`, initial version `0.1.0`,
Python 3.10+ and the existing pinned `mcp==2.2.0`/uv entrypoint pattern.
Install a naming skill and an MCP asset through the strict toolkit manifest.
Use an injectable Ollama CLI adapter with argument arrays, structured results,
strict tool arguments, bounded subprocess execution, and no shell evaluation.
Suggestions are heuristics, not automatic rename decisions; uncertain names
require agent/user judgment. The existing extraction behavior is the starting
point, not a requirement to guess missing family or size.

## Evidence and verification

Use fake Ollama adapters/executables and temporary install targets exclusively.
Verify protocol discovery and calls, partial failures, packaging, both install
scopes, and execution without the source checkout. Run CONTRIBUTING.md gates
with Node.js 22+ and Python 3.10+, including full Python discovery, public
OpenCode schema checks and isolated discovery when prerequisites exist.

Existing repository compatibility evidence targets OpenCode v2.0.30; it does
not establish new MCP execution behavior. Check primary sources for any new
OpenCode behavior relied upon and distinguish source evidence from experiments.
Confirm redistribution provenance/license of the external script before copying
its implementation. Missing prerequisites must be reported, not treated as passes.

## Approved validation-policy amendment

The user subsequently requested OpenCode v2.2.1 or greater instead of the exact
v2.0.30 prerequisite. Admit stable releases at or above v2.2.1, retain fail-closed
behavioral checks and sandbox isolation, and record the actual measured version.
Historical v2.0.30 evidence stays labeled as historical; minimum eligibility is
not a compatibility guarantee for untested future releases.
