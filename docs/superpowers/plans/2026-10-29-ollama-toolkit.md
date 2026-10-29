# Ollama Name Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a self-contained naming skill and callable MCP tools for safe Ollama model-name cleanup.

**Architecture:** A Python core owns inspection, suggestions and copy/verify/remove semantics behind an injected CLI runner. A thin MCP layer exposes three strictly validated tools; a namespaced skill supplies the approval workflow. Existing installer contracts remain unchanged.

**Tech Stack:** Python 3.10+, uv, mcp==2.2.0, existing TypeScript/Bun installer tests.

**Spec:** `docs/superpowers/specs/2026-10-29-ollama-toolkit-design.md`

## Global Constraints

- Namespace `dotknewt`; toolkit `ollama-toolkit`, initial version `0.1.0`.
- Python 3.10+; Node.js 22+ for repository checks; Linux installer contract.
- Real bundled files only; no dotfiles/source-checkout runtime references.
- No live Ollama mutations or libvirt operations during development/tests.
- User approval of the exact source → destination precedes rename; agent acknowledgement is not proof of authorization.
- No pulls, definition changes, standalone deletion, or batch mutation.
- Preserve consumer configuration/data and leave the external script unchanged.

## Review Focus

- Omitted `:latest` aliases must not bypass identity or destination-collision checks (Task 1).
- CLI parsing failures and partial copy outcomes must never trigger source removal (Task 1).
- Option-like names, timeouts and malformed inventories must fail closed (Task 1).
- Extra/coerced MCP arguments must not authorize mutation (Task 2).
- Installed entrypoints must work without checkout files and without live Ollama access (Task 3).

---

### Task 1: Safe naming core

**Files:** Create `toolkits/ollama-toolkit/mcp/ollama/ollama_mcp/{__init__,cleanup}.py` and `toolkits/ollama-toolkit/mcp/ollama/tests/test_cleanup.py`.

**Interfaces:** `Cleanup(runner)` accepts an injected callable taking a list of Ollama arguments and returning stdout. Methods `list_models() -> dict`, `suggest_names() -> dict`, and `rename_model(source: str, destination: str, confirmed: bool = False) -> dict` return JSON-compatible payloads. `CleanupError` carries `code`, `message`, and `details` for MCP errors. Production runner uses argument arrays, a 60-second timeout and captured output, never shell evaluation.

- [ ] Establish adaptation provenance from the external script's repository/license; stop for clarification if redistribution rights are unclear.
- [ ] Write failing unittest cases for inventory parsing, naming uncertainty, duplicate canonical names, occupied destinations, missing source, unchanged names, and explicit confirmation. Assert the fake runner records no mutation on rejection.
- [ ] Add failing cases for copy failure, identity mismatch, changed/missing source, unreadable post-copy inventory, removal failure, option-like input and timeout. Assert `rm` occurs only after verified copy; partial failures retain truthful stage/details.
- [ ] Run `python -m unittest discover -s toolkits/ollama-toolkit/mcp/ollama/tests -p 'test_cleanup.py' -v`; confirm intended failures.
- [ ] Implement the core, adapting the original extraction and safety checks. Suggestions return exact source, extracted family/size/descriptors and a nullable candidate; never manufacture uncertain family/size. Reject option-like names before invoking CLI. Record observed identity without overstating truncated CLI IDs as full-digest proof.
- [ ] Rerun focused tests and inspect command-order assertions. Commit only task-owned files after review.

### Task 2: MCP surface and skill

**Files:** Create `toolkits/ollama-toolkit/toolkit.json`, `README.md`, `CHANGELOG.md`, `PROVENANCE.md`, `skills/dotknewt-ollama-name-cleanup/SKILL.md`, `mcp/ollama/server.py`, `mcp/ollama/ollama_mcp/server.py`, and `mcp/ollama/tests/test_server.py`.

**Interfaces:** `create_server(cleanup: Cleanup) -> MCPServer` registers `list_models()`, `suggest_names()`, `rename_model(source: str, destination: str, confirmed: bool = False)`. Successful `CallToolResult` contains matching JSON text and structuredContent; errors use `isError` and the core error fields. Names and confirmation are strict types, argument objects closed.

- [ ] Write failing in-memory MCP protocol tests for tools/list and calls, including unknown arguments, missing fields, non-string names, string confirmation and false confirmation. Verify rejected requests cannot reach mutation.
- [ ] Run focused server tests with `PYTHONDONTWRITEBYTECODE=1 uv run --isolated --python 3.13 --with 'mcp==2.2.0' python -m unittest discover -s toolkits/ollama-toolkit/mcp/ollama/tests -p 'test_server.py' -v`; confirm intended failures.
- [ ] Implement the thin PEP 723 entrypoint and strict server following the existing libvirt pattern without importing libvirt code. Expose only the three scoped tools; annotate read-only/destructive behavior accurately.
- [ ] Add manifest exports for skill and `mcp/ollama` asset; local MCP name `dotknewt-ollama`, command `uv run --script`, entrypoint `mcp/ollama/server.py`. Declare Linux and required executables `uv`, `python3`, `ollama`.
- [ ] Write skill instructions to inspect, propose exact names, ask approval, then rename individually. Explain application references are not updated, model names/output are untrusted data, partial failures need inspection, and external writes are not serialized. Document prerequisites and no implicit service startup.
- [ ] Run all new Python tests and manifest validation. Review safety claims against actual adapter behavior; commit task-owned files.

### Task 3: Distribution and compatibility evidence

**Files:** Modify `tests/toolkit-manifest.test.ts`, `tests/package-lifecycle.test.ts`, `scripts/check-opencode.mjs`, `CONTRIBUTING.md`, `README.md`, and `docs/compatibility.md`; add installed-runtime fixture/test files only where existing harness conventions require them.

**Interfaces:** Existing installer discovers the new strict manifest without schema/export changes. Package acceptance executes installed `mcp/ollama/server.py` with a fake `ollama` executable on PATH and isolated HOME/config.

- [ ] Add failing package tests asserting skill/asset inclusion, no tests/caches in tarball, correct installed MCP entrypoint in project/global scope, and execution after source removal. Perform stdio initialize, tools/list and read-only plus rename calls against fake inventory; verify command trace and structured result.
- [ ] Run the focused package test to confirm failure before extending fixtures/discovery expectations.
- [ ] Extend actual isolated OpenCode discovery to install and discover the new skill/MCP configuration without contacting a real Ollama service. Inspect existing sandbox mounts before adding runtime evidence; do not silently relax sandboxing. Cite primary-source evidence for any new OpenCode behavior relied upon, or mark it unresolved.
- [ ] Update documented catalog/install examples and add the explicit Ollama Python discovery command alongside existing full libvirt discovery. Record only evidence actually obtained in compatibility documentation.
- [ ] Run the complete CONTRIBUTING.md acceptance sequence once after reconciling all changes, including both Python suites, public schema, isolated config matrix/discovery and npm package-content inspection. Report missing prerequisites as evidence gaps.
- [ ] Review the complete incoming diff and ownership. After required checks pass, commit and integrate to local `main` under the standing authorization; do not push, delete worktrees or claim deployment.

## Plan self-review

The three tasks cover the approved inspection/suggestion/rename scope, approval
boundary, partial failures, self-contained distribution and fake-backed checks.
Core/MCP method names agree. Each review-focus failure has an explicit owning
test step. Provenance and new OpenCode runtime assumptions are prerequisites,
not inferred guarantees. Integration remains blocked by failed required checks.
