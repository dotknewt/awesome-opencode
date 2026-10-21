# Hermes Notifier Toolkit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish exact tool isolation and destination/discovery feasibility before creating the lightweight notifier toolkit, whose one-send and fallback behavior is instruction-level best effort.

**Architecture:** Task 1 produces an evidence report and executable protocol for review. Task 2 performs only bounded experiments using disposable candidate presets and a fake MCP server. Only after protocol approval and the exact-tool-isolation/discovery gates pass may Task 3 create distributable files. Static prompt checks, deterministic permission tests, and real-model behavioral evaluations are separate evidence classes; single-send/no-retry and fallback instructions are not native guarantees.

**Tech Stack:** Native OpenCode configuration/runtime, disposable fake MCP stdio server, repository `node:test`, toolkit manifest/installer, actual isolated OpenCode discovery.

**Spec:** [2026-10-21-hermes-notifier-design.md](../specs/2026-10-21-hermes-notifier-design.md)

## Global Constraints

- User explicitly opts in once for the current task; parent tracks task scope. No separate approval per eligible notification.
- Development/validation sends no live Hermes messages. Any live test requires separate explicit approval naming exact payload and destination.
- Never use consumer config or credentials, or edit consumer config/`AGENTS.md`. Real-model evaluations require separately approved isolated credentials, network, and any cost.
- Exact Hermes `messages_send`-only access is a hard runtime/security gate; never broaden access to make discovery work.
- One attempt/no retry after ambiguity are mandatory instructions, not native invocation-count guarantees; model compliance risk is accepted and evaluations are observations, not guarantees.
- Primary is `opencode/mimo-v2.6-flash-free`; parent may select desired fallback `openai/gpt-5.6-luna` only after a confirmed pre-send primary failure. Do not invent an automatic fallback field. If failure timing cannot be confirmed, parent does not switch models.
- No plugin or adapter expansion, guessed OpenCode field, or lifecycle hook.
- Stop before distributable toolkit creation if exact isolation or supported discovery/default behavior lacks evidence. Missing permission, credentials, or prerequisites for mandatory evaluations is blocked, never passed.
- Toolkit exports must be real self-contained files and conform to `schemas/toolkit.schema.json`.

## Review Focus

- Does exact Hermes send-only tool isolation hold under the actual OpenCode version with direct MCP and Code Mode variants?
- Can the parent identify a confirmed pre-send primary failure without guessing, and distinguish post-send/ambiguous outcomes before deciding whether to use fallback?
- Do real-model evaluations show expected prompt compliance for one-send/no-retry and task/destination rules? These observations are not guarantees.
- Does a supported install/discovery path exist without consumer configuration mutation or source-tree dependencies?
- Is there an existing supported user-default destination mechanism? Otherwise missing destination must prompt; do not invent persistent settings.

---

### Task 1: Feasibility protocol and approval (no experiments or implementation)

**Files:**
- Create: `docs/superpowers/reports/2026-10-21-hermes-notifier-feasibility.md`
- Read: OpenCode V2 docs linked in the spec, version-specific source/runtime interfaces if available, repository schema/installer/tests/docs.
- No toolkit, test, fixture, candidate preset, or configuration changes.

**Interfaces:**
- Report classifies findings as documented, source-inspected, experimentally verified, or unresolved; defines the disposable experiment configuration, evidence capture, cleanup, and stop criteria.
- Commands are specified only after the relevant source/runtime interfaces and exact OpenCode binary are inspected; do not invent commands or APIs.

- [ ] **Step 1: Inspect actual supported interfaces.** Read agent/MCP/tools documentation, schema, installer export mapping, `tests/toolkit-manifest.test.ts`, `tests/package-lifecycle.test.ts`, root `README.md`, and version-specific runtime/source interfaces available. Record exact candidates for agent install/discovery and normalized Hermes tool action.
- [ ] **Step 2: Investigate exact tool isolation.** Determine how permissions expose only the normalized Hermes send action while denying other tools/resources under direct MCP and Code Mode. This remains a hard gate. Record separately that native permission/step controls do not provide an invocation quota; the revised product accepts one-send/no-retry as instructions rather than requiring native enforcement.
- [ ] **Step 3: Investigate parent-controlled fallback mechanics.** Establish documented/source-inspected model selection for primary/fallback and determine whether the parent can confirm primary failure before any tool invocation. Do not assume an agent preset or native automatic fallback field; if timing cannot be confirmed, record that the parent must not switch.
- [ ] **Step 4: Investigate destination default and distribution.** Identify existing supported user-default destination storage (if any), and how toolkit installation can expose the preset/skill without changing consumer config. If no mechanism exists, report the gap without adding one.
- [ ] **Step 5: Write exact experimental protocol.** Based on the inspected interfaces, specify commands, disposable paths, candidate presets/configs, fake-server behavior, expected evidence, provider authorization requirements, and cleanup. Separate deterministic isolation/enforcement checks from real-model behavior evaluations.
- [ ] **Step 6: Request user review and approval of the protocol.** Stop before creating fixtures or candidate configs until approved. Exact tool isolation remains a hard gate; one-send/fallback behaviors are evaluated as instructions, not native guarantees.

### Task 2: Bounded disposable feasibility experiments (approval gate before toolkit creation)

**Files:**
- Create only in temporary directories: candidate agent/config files, fake MCP server, call logs, and disposable OpenCode state/data.
- Update: `docs/superpowers/reports/2026-10-21-hermes-notifier-feasibility.md` with complete evidence and outcomes.
- No files under `toolkits/`; no permanent test fixtures; no consumer files or live Hermes endpoint.

**Interfaces:**
- Fake MCP exposes `messages_send`, a forbidden read action, and a resource; records every invocation and exact arguments. It cannot deliver externally.
- Deterministic experiments test discoverability and exact tool catalog/permission isolation only. Fake MCP call logs capture invocations and arguments; they do not prove model instruction compliance or native one-send guarantees.
- Real-model evaluations use the approved primary and fake MCP only; require separately approved isolated provider credentials/network/cost. Record observed compliance for exact relay, current-task opt-in, destination precedence/ask, allowed event selection, distinct blockers, and no retry. These are observations, not guarantees.

- [ ] **Step 1: Follow only the Task 1 approved protocol** against the selected stable OpenCode V2 binary, recording its actual version, and disposable paths. Do not improvise native fields or broaden permissions if a test fails.
- [ ] **Step 2: Record deterministic results** for exact send-only isolation, preset/skill discovery, and destination-default lookup. Record command, version, configuration variant, observed catalog, and cleanup. Do not describe fake call logs as invocation enforcement.
- [ ] **Step 3: Run real-model behavior evaluations only with explicit prerequisites/authorization.** No credentials or approval means blocked/unrun, not passed. Use synthetic task/content and fake MCP only; record each case and outcome as behavioral observation, not guarantee.
- [ ] **Step 4: Update the feasibility report** with evidence class and outcome per gate. Exact isolation, installed discovery, and destination behavior must be addressed before implementation. Report single-send/no-retry model behavior as evaluation observations. If required real-model evaluation lacks authorization/credentials/network/cost approval, mark it blocked/unrun, not passed.
- [ ] **Step 5: Obtain explicit user approval of the completed feasibility report and proceed/stop decision.** No distributable toolkit files are created before this gate passes. Do not add plugin/adapter scope or change the accepted best-effort risk without a new product decision.

### Task 3: Create the distributable toolkit (only after Task 2 gate passes)

**Files:**
- Create: `toolkits/hermes-notifier-toolkit/toolkit.json`
- Create: `toolkits/hermes-notifier-toolkit/README.md`
- Create: `toolkits/hermes-notifier-toolkit/PROVENANCE.md`
- Create: `toolkits/hermes-notifier-toolkit/CHANGELOG.md`
- Create: `toolkits/hermes-notifier-toolkit/agents/dotknewt-hermes-notifier.md`
- Create: `toolkits/hermes-notifier-toolkit/skills/dotknewt-hermes-notifier/SKILL.md`
- Create: `tests/fixtures/hermes-notifier/fake_mcp.py`
- Create: `tests/hermes-notifier.test.ts`
- Modify: `README.md` available-toolkit list and documentation links.
- Modify: `tests/package-lifecycle.test.ts` packed-file assertions.

**Interfaces:**
- Manifest exports the skill and agent using only Task 2 proven repository-supported locations; no bundled MCP (`mcp: []`) because Hermes is externally configured.
- Static instruction tests assert required prompt text/rules are present; they establish document completeness only.
- Deterministic runtime tests assert the actual tool catalog and native permission isolation. Fake server call logs record observed calls only; scripted model responses are not behavioral proof.
- Real-model evaluations separately assess prompt compliance for one-send/no-retry, exact relay, opt-in, destination, and event selection. Report observations and limitations, not guarantees.

- [ ] **Step 1: Create manifest and toolkit documentation** from strict schema and repository conventions. Include exact setup boundaries, task-scoped user opt-in, destination precedence/ask, and truthful verification limitations.
- [ ] **Step 2: Create agent preset and companion skill** using only experimentally proven native config/permission behavior. Include primary and parent-controlled fallback instructions; explicitly state one attempt/no retry as best-effort model instructions and do not encode invented auto-fallback configuration.
- [ ] **Step 3: Create static instruction completeness checks** in `tests/hermes-notifier.test.ts`; assert opt-in scope, event classes, exact relay, destination precedence/ask, one attempt, and fallback rules are explicitly documented. Label these checks as static only.
- [ ] **Step 4: Create deterministic fake MCP fixture and runtime tests** following Task 2's proven protocol. Assert catalog/permission isolation and exact recorded call arguments. Do not assert a native invocation quota or use scripted model responses to claim skill compliance.
- [ ] **Step 5: Add root README catalog entry and package lifecycle assertions** for packed agent/skill paths; package already includes `toolkits/**`, so inspect `npm pack --json --dry-run` and change `package.json` only if evidence requires it.
- [ ] **Step 6: Validate after all manifest sources exist:** `bun run build && node dist/installer/src/cli.js validate`; then `bun run build && node --test dist/tests/hermes-notifier.test.js`; then `bun run test:package`. Expected: strict manifest passes, named deterministic/static checks pass with correct evidence labels, packaged runtime paths are present, and tests are excluded.
- [ ] **Step 7: Run installed discovery using the exact approved disposable Task 2 setup.** Assert no source-tree dependency and no consumer config/`AGENTS.md` mutation.

### Task 4: Repository acceptance and evidence handoff

**Files:**
- Modify only if needed: toolkit changelog/docs and the approved feasibility report with final evidence.

- [ ] **Step 1: Run all repository commands** listed in `CONTRIBUTING.md`: `bun install --frozen-lockfile`, `bun run build`, `bun run test`, `bun run validate`, `bun run test:installer`, `bun run test:package`, full documented Python unittest discovery, `bun run test:opencode:schema`, and the isolated config matrix/discovery commands using stable OpenCode V2 from `PATH` or an explicit `--opencode PATH`.
- [ ] **Step 2: Treat missing prerequisites, skips, and nonzero results as incomplete.** Do not use unisolated OpenCode discovery or report missing provider authorization as success.
- [ ] **Step 3: Inspect final diff and `npm pack --json --dry-run`.** Confirm only planned toolkit, catalog, tests, and report changed; no credentials, generated caches, or consumer files.
- [ ] **Step 4: Report each gate separately:** static instruction completeness, deterministic exact-tool isolation, real-model behavioral observations, parent fallback observability, destination-default support, and installed discovery. Do not claim live Hermes delivery or guarantees based on behavioral observations.
