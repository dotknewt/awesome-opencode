# Contributing

Use Linux, Node.js 22+, npm, Python 3.10+, `uv`, and util-linux `flock`.
`qemu-img` is optional locally: its tests use temporary image files only and
report a visible unittest skip when the executable is absent. Never run tests
against a live VM or consumer configuration.
The guest-access script tests require real `sshd` and `ssh-keygen` and fail setup
instead of skipping when either is absent. Dedicated Debian/Ubuntu checks must
install `openssh-server` and `openssh-client`; CachyOS/Arch checks install
`openssh`.

Install exact JavaScript dependencies and run repository acceptance:

```sh
npm ci
npm run build
npm test
npm run validate
npm run test:installer
npm run test:package

PYTHONDONTWRITEBYTECODE=1 \
uv run --isolated --python 3.13 --with 'mcp==2.2.0' \
  python -m unittest discover \
  -s toolkits/libvirt-toolkit/mcp/libvirt/tests -p 'test_*.py' -v

npm run test:opencode:schema
npm run test:opencode:discovery
```

The schema check requires HTTPS access to `https://opencode.ai/config.json`.
Discovery requires an actual `opencode` executable. The helper exits 77 when a
prerequisite is absent; dedicated CI jobs install their prerequisites and treat
every nonzero result, including 77, as failure. `npm test` may surface those two
checks as explicit local skips, but the separate acceptance commands are the
release evidence.

Before submitting changes:

- Keep every toolkit export in its own directory as real files; no symlinks or
  source-checkout references.
- Update `toolkit.json`, toolkit changelog, provenance, and docs together when a
  toolkit's public behavior changes. Toolkit and npm package versions are
  independent.
- Add tests for ownership conflicts, path safety, rollback, or compatibility
  whenever those contracts change.
- Inspect `npm pack --json --dry-run` for missing runtime files and accidental
  tests, evals, caches, bytecode, TypeScript, or planning artifacts.
- Do not add live credentials, start services, alter a real OpenCode config, or
  perform libvirt/VM operations.

See [docs/authoring.md](docs/authoring.md) for the manifest contract.
