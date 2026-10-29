# Hermes Notifier Toolkit Design

**Status:** Revised product decision approved 2026-10-21: lightweight preset, strict tool-access restrictions, and best-effort single-send/fallback instructions. Runtime tool isolation and fallback observability remain verification gates.

## Goal and scope

Add a reusable native OpenCode toolkit containing (1) a restricted Hermes notifier agent preset and (2) a companion orchestration skill. The skill lets a parent agent explicitly opt a task into one-way notifications of the task's final success or failure and distinct blocking questions. This is a scoped notification facility, not a general Hermes client or conversation channel.

The toolkit assumes Hermes is already configured and authenticated by the consumer outside this project. Installation must not edit consumer OpenCode configuration, `AGENTS.md`, credentials, or Hermes state. The installer only installs manifest-declared files under the toolkit's managed locations. There is no plugin expansion in this design.

## Approved behavior

### Opt-in, destination, and payload

- Notification is off unless the **user explicitly opts in** for the current task. The parent records/tracks that consent and must not carry it to child or later tasks. Once opted in, that consent authorizes eligible notifications for this task to the resolved destination; there is no separate approval per message.
- Send only final success, final failure, and distinct blocking questions. Do not send progress, subtasks, routine updates, or duplicate questions.
- The parent/orchestrator supplies both (a) the exact concise, sanitized message and (b) the exact destination. A message contains task identity plus outcome, or the exact blocking question and direction to return to OpenCode. The notifier relays the supplied text unchanged; it does not compose, expand, summarize, or answer it.
- Destination precedence: a destination explicitly supplied for the current task overrides the user's configured default. If neither exists, ask the user. Never infer or guess a destination.
- The task opt-in authorizes only eligible task notifications under the rules above. Development and validation must not send live messages; any live test requires separate explicit permission naming its exact payload and destination.

### Notifier boundary

- The notifier agent may invoke only Hermes `messages_send`. It has no read, search, history, reply, approval, shell, file, or other tool access.
- It is instructed to make one send attempt for each authorized notification and report the result to the parent. On failure/ambiguity it is instructed not to retry because the first send may have succeeded remotely. These are model-compliance instructions, not native invocation-count guarantees; behavioral evaluation can observe compliance but cannot guarantee it.
- The only content and destination are the exact values provided by the parent. Do not include secrets or unrelated context.
- Hermes setup, authentication, and connection are pre-existing consumer responsibilities. A missing or unauthenticated service is reported, not configured automatically.

### Model selection

- Primary: `opencode/mimo-v2.6-flash-free`.
- Desired fallback: `openai/gpt-5.6-luna`, selected by the parent only after a confirmed primary model failure before any send attempt. The parent must not switch models after a send attempt or retry an ambiguous send. These are parent/prompt instructions, not a documented native automatic fallback policy or runtime guarantee. The failure signal needed to confirm the pre-send boundary remains unverified; if it cannot be observed, do not switch models.
- Both IDs were catalog-verified for the approved design. The primary is listed at zero cost; fallback cost is unknown. This is not evidence that either model reliably calls the required tool.

## Repository shape and install contract

Create a standalone toolkit directory `toolkits/hermes-notifier-toolkit/`, with a strict `toolkit.json`, `README.md`, `PROVENANCE.md`, `CHANGELOG.md`, one skill tree under `skills/dotknewt-hermes-notifier/`, and one agent Markdown preset under `agents/dotknewt-hermes-notifier.md`. The manifest declares the skill and agent exports and no MCP entry unless a separately approved design establishes that a bundled Hermes server is needed; current scope assumes the consumer's externally configured Hermes integration.

The exact installed location of the preset and how OpenCode loads it in a task are implementation choices, not an approved API assumption. Before implementation, establish a repository-supported distribution/discovery mechanism that works in a consumer installation without source-checkout references and without mutating consumer configuration. Do not invent a manifest field, native configuration field, or lifecycle hook. If the mechanism is not supported, stop and return the evidence rather than weakening the security boundary.

The user-configured default destination is approved as a behavior but its storage/configuration mechanism is unresolved. Investigate only repo-supported mechanisms and documented OpenCode interfaces. Do not create a new preference file, config key, or automatic configuration edit without a product decision. A task-provided destination still takes precedence; if no supported user default can be identified, ask the user for a task destination and report the default mechanism as blocked for product resolution.

## Evidence and verification status

The following are **documented** in OpenCode's V2 primary documentation, consulted 2026-10-21. Runtime acceptance selects stable OpenCode V2 from `PATH` by default or accepts an explicit executable, records the measured version, and rejects prerelease/non-V2/unrecognized output. A V2 label is not a broad compatibility claim; source citations below remain version-specific historical evidence.

- [Agents](https://opencode.ai/v2/docs/agents/): Markdown agent presets, `mode: subagent`, model selection, permission rules, and ordered matching permissions are documented. The docs say a subagent uses its configured model and that the child uses its own configured permissions.
- [MCP servers](https://opencode.ai/v2/docs/mcp-servers/): MCP tools are exposed through Code Mode by default; `codemode: false` exposes tools directly. MCP tool permission actions use the normalized `<server>_<tool>` name. Server setup is configuration-driven.
- [Tools](https://opencode.ai/v2/docs/tools/): `execute` provides Code Mode, whose accessible tool set includes tools reached through its namespace; denying `execute` removes Code Mode. MCP tools can also be listed directly with Code Mode disabled. Tool permissions still apply.

These docs do **not** establish the exact Hermes integration/tool name or a safe way to isolate exactly one MCP action while denying the Code Mode `execute` gateway. They do not prove the low-cost primary model will call `messages_send`, nor that a primary failure can be confirmed before a send attempt. Agent model selection is documented; automatic fallback is not. Do not assume an agent frontmatter override changes a running subagent's model. Strict tool-access isolation and pre-send failure observability remain verification gates. Single-send/no-retry and parent-controlled fallback are best-effort instructions by explicit product decision, not native runtime guarantees.

### Mandatory stop/verification gates

Before packaging or enabling the notifier, investigate with an isolated disposable OpenCode configuration, disposable candidate presets, and a fake Hermes MCP server. Never use consumer configuration, credentials, or a live Hermes destination for these experiments. Complete the evidence gate before creating distributable toolkit files.

1. **Exact tool isolation (hard runtime/security gate):** deterministic isolated tests must demonstrate the agent can access exactly normalized Hermes `messages_send` and cannot call other Hermes actions, read resources, or access other tools. Test direct MCP and Code Mode variants using disposable config. If exact isolation is not proven, stop; do not broaden permissions or silently add an adapter/plugin.
2. **Behavioral evaluation (not a guarantee):** with fake Hermes only, evaluate exact relay, task opt-in, destination precedence/ask, eligible event selection, distinct blockers, one attempt, and no retry. Separate static instruction checks, deterministic native permission checks, and real-model behavior observations. Real-model evaluations require separately approved isolated credentials/network/cost; observations are not guarantees.
3. **Parent-controlled fallback:** investigate whether a primary model failure can be confirmed before any send attempt and whether post-attempt/ambiguous failures can be distinguished. The parent may select `openai/gpt-5.6-luna` only on confirmed pre-send failure. If that evidence is unavailable, parent must not switch; document the fallback limitation. Do not invent a native automatic fallback field or claim a guarantee.
4. **Distribution, discovery, and destination default:** prove the preset/skill are found after install in an isolated disposable consumer setup without source references or automatic config/`AGENTS.md` changes. Identify an existing supported user-default destination mechanism. If either mechanism cannot be proved, stop and report evidence rather than inventing an API.

No live Hermes messages are part of implementation or validation evidence. A normal task's explicit opt-in authorizes eligible messages for that task; a live test during development/validation requires separate explicit permission naming the test payload and destination. Provider smoke/evaluations use a fake Hermes server and separately approved credentials/network/cost; missing authorization or prerequisites blocks the gate.

## Failure and safety requirements

- If the user has not opted in for the current task, send nothing. Once opted in, do not ask for per-message approval for eligible outcomes; the parent remains responsible for tracking task scope.
- If destination is absent from task override and user default, ask; send nothing meanwhile.
- If the payload is not supplied exactly by the parent, lacks task identity/outcome or exact blocking question, or contains content that cannot be safely sanitized without changing it, ask the parent to provide a corrected exact message; do not improvise.
- A successful call is reported as success. A definite pre-send model initialization failure may select the approved fallback only after the verification gate passes. Any send error, timeout, disconnect, or uncertain outcome is reported as uncertain/failure without retry or fallback.
- Tool isolation, user permission, destination choice, and message exactness are independent gates; satisfying one does not imply the others.

## Acceptance criteria

1. Toolkit manifest validates against `schemas/toolkit.schema.json`; exports are real files, and installed content is self-contained.
2. Companion skill instructs the parent to apply task-scoped opt-in, outcome/question-only notification, exact parent-supplied payload and destination, override/default/ask resolution, and no autonomous configuration edits. Instructions alone are not runtime enforcement.
3. Preset permissions are deny-by-default and allow only the narrowly verified normalized Hermes send action; no broad Code Mode or unrelated tools are available.
4. Static instruction checks verify required prompt rules are present; deterministic runtime tests verify exact allowed-tool isolation. Real-model behavior evaluations report observed prompt compliance for exact relay, opt-in, destination, event selection, one attempt, and no retry, without representing observations as guarantees.
5. Parent-controlled fallback is attempted only when a primary failure is confirmed before any send attempt. If pre-send versus post-send failure is not observable, do not switch models and report this limitation; do not invent automatic fallback configuration.
6. Any failed mandatory tool-isolation/discovery gate blocks implementation; do not broaden permissions or add a plugin/adapter under this approval.
7. No live messages or edits to consumer configuration/`AGENTS.md` occur during implementation and testing. Live test traffic requires separate permission naming its exact payload and destination.
