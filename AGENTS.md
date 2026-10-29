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

## Design and review workflow

- Before turning external behavior into a design constraint, cite primary-source
  evidence for the OpenCode version being tested. Distinguish documented,
  source-inspected, and experimentally verified behavior; mark unresolved facts
  as verification prerequisites rather than inferring behavior from doc silence.
- Ask users for product decisions; resolve filesystem, API, and compatibility
  facts through investigation. Group independent decisions into one interview
  round within tool limits; defer questions whose prerequisites remain unsettled.
- After substantive review corrections, re-read the revised sections and their
  dependent invariants/tests against each finding before calling the artifact
  reviewed. Report any remaining evidence gaps explicitly.

## Validation

Use Node.js 22 or newer and Python 3.10 or newer. Before reporting a change
complete, require stable OpenCode v2.2.1 or greater for actual OpenCode checks.
Use the shared runner's numeric version admission; reject prereleases and
malformed versions. Record the actual measured version and require exact
per-outcome consistency, not equality to the minimum version. Eligibility is
not evidence of compatibility; retain behavioral assertions and sandbox isolation.
Before reporting a change complete, run the commands in `CONTRIBUTING.md`, including full Python discovery,
public OpenCode schema validation, and actual isolated OpenCode discovery when
their prerequisites are available. Dedicated CI checks must install required
prerequisites and must not convert setup absence into success.

Do not commit generated caches, virtual environments, `node_modules`, or `dist`.
