# Toolkit authoring

Create `toolkits/<toolkit>/toolkit.json` conforming to
`schemas/toolkit.schema.json`. Names are lowercase kebab-case and versions are
SemVer. Keep the toolkit license/provenance explicit and version it independently
from the npm package.

Manifest exports map a relative source to a relative installed destination:

- `skill` -> `skills/<namespaced-name>`
- `agent` -> `agents/<namespaced-name>.md`
- `command` -> `commands/<namespaced-name>.md`
- `asset` -> a bounded payload path such as `mcp/<name>`

Every exported tree must contain real regular files. Symlinks, special files,
absolute paths, traversal, and undeclared auxiliary references are rejected.
Skill frontmatter `name` must match its destination name; descriptions must be
discoverable. Relative Markdown links and eval attachments are validated from
the toolkit tree even when evals are not shipped.

Local MCP contributions declare a namespaced `name`, `type: "local"`, command
prefix, relative `entrypoint`, and `enabled`. The entrypoint must be contained by
an asset export and every command executable must appear in
`dependencies.executables`. The engine appends the resolved absolute installed
entrypoint. Do not embed repository paths or `${CLAUDE_PLUGIN_ROOT}`.

Declare honest platform and executable requirements. An installer manifest does
not prove a service works, install system dependencies, or authorize startup.
Document first-launch downloads, state/data locations, and destructive boundaries
in toolkit docs.

Validate with:

```sh
npm run validate
npm test
npm pack --json --dry-run
```

Add source tests for schema/reference rules and a real package lifecycle test for
new runtime shapes. Tests must use temporary targets and fake external adapters.
Optional binary integration may use disposable files only; never contact a live
service or VM.
