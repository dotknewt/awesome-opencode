---
name: dotknewt-handling-todos
description: Use when discussing, drafting, organizing, reviewing, or implementing TODO or backlog items.
---

## Handling TODO items

### Intent and authorization
- Treat TODO items as backlog entries, not instructions to execute.
- Examples illustrate requirements; do not turn them into active tasks unless
  explicitly requested.
- Requests to suggest, draft, organize, or review TODOs authorize only that work.
- Implement a TODO only when the user explicitly selects it for implementation.
- Recording or approving a TODO's wording does not authorize implementation.

### Writing TODOs
- Give each item a stable ID and a concise, action-oriented title.
- Describe the desired outcome rather than prematurely prescribing a solution.
- Include scope, acceptance criteria, dependencies, and unresolved questions
  when relevant.
- Separate confirmed requirements from assumptions and optional ideas.
- Split independently deliverable outcomes into separate items.
- Keep detail proportional to complexity; avoid full implementation plans
  for unselected backlog items.

### Tracking TODOs
- Keep one authoritative backlog location.
- Use explicit statuses: proposed, ready, in-progress, blocked, done.
- “Ready” means sufficiently defined, not authorized to execute.
- Mark an item in-progress only after implementation is requested and begins.
- For blocked items, record the blocker and the decision or dependency needed.
- Do not silently expand scope, change priority, or close related items.

### Working on an authorized TODO
- Read applicable repository guidance and inspect the relevant implementation.
- Confirm the intended outcome and resolve consequential ambiguity.
- Identify dependencies, compatibility constraints, and verification requirements.
- Follow the repository's planning and implementation workflow.
- If new work is discovered, propose a linked TODO instead of automatically
  expanding the active task.

### Completion
- Mark an item done only when its acceptance criteria are satisfied and required
  verification has completed.
- Record a concise summary of the changes and verification evidence.
- State any unverified behavior or remaining work explicitly.
- Keep partially completed or blocked items open.

### Response scope
- When asked for instructions, return instructions.
- When asked for TODO suggestions, return proposed TODO text.
- When asked for a plan, return a plan.
- Do not infer permission to edit files, run setup, or implement features from
  discussion of a TODO.
