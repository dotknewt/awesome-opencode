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
- Do not claim that `update` relocates moved absolute state paths. The supported
  workflow is uninstall at the old path, move, reinstall, and restart.

## Validation

Use Node.js 22 or newer and Python 3.10 or newer. Before reporting a change
complete, run the commands in `CONTRIBUTING.md`, including full Python discovery,
public OpenCode schema validation, and actual isolated OpenCode discovery when
their prerequisites are available. Dedicated CI checks must install required
prerequisites and must not convert setup absence into success.

Do not commit generated caches, virtual environments, `node_modules`, or `dist`.
