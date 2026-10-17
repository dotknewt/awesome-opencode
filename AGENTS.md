# awesome-opencode contributor guidance

This repository distributes native, self-contained OpenCode toolkits. Keep
toolkit content under `toolkits/<name>/` and declare every installed file through
that toolkit's strict `toolkit.json`. Toolkit versions are independent from the
`awesome-opencode` npm package version.

## Safety and ownership

- Never run live libvirt operations while developing or testing this repository.
- Use fake host adapters and temporary directories. Optional `qemu-img` tests
  may create only disposable images under a temporary directory.
- Installed and packaged content must continue working after the source checkout
  is removed. Do not use symlinks or source-relative runtime references.
- Preserve consumer configuration, `AGENTS.md`, and unrelated files. The
  installer owns only manifest-declared files and structural MCP entries recorded
  in state; local edits are conflicts.
- Never remove VM data during toolkit or CLI uninstall.
- Mutating installer behavior is Linux-only and requires util-linux `flock`.
  Preserve the parent-owned inherited-FD lock through transaction completion.
- After a move, use `update` only when prior ownership can be proven and every
  installed current copy verifies. An update rebases every installed record;
  named toolkits are updated, while an unnamed update updates all installed
  toolkits. Fail closed on unsafe journals or distinct overlapping roots. Do not
  extend this relocation claim to other operations or unmeasured configuration
  sources; initial state discovery/shared ancestors are outside the
  stale-resource guarantee.

## Validation

Use Node.js 22 or newer and Python 3.10 or newer. Before reporting a change
complete, run the commands in `CONTRIBUTING.md`, including full Python discovery,
public OpenCode schema validation, and actual isolated OpenCode discovery when
their prerequisites are available. Dedicated CI checks must install required
prerequisites and must not convert setup absence into success.

Do not commit generated caches, virtual environments, `node_modules`, or `dist`.
