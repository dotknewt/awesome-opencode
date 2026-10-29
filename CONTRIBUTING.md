# Contributing

Use Linux, Node.js 22+, **Bun**, Python 3.10+, `uv`, and util-linux `flock`.
`qemu-img` is optional locally: its tests use temporary image files only and
report a visible unittest skip when the executable is absent. Never run tests
against a live VM or consumer configuration.
The guest-access script tests require real `sshd` and `ssh-keygen` and fail setup
instead of skipping when either is absent. Dedicated Debian/Ubuntu checks must
install `openssh-server` and `openssh-client`; CachyOS/Arch checks install
`openssh`.

Install exact JavaScript dependencies and run repository acceptance:

```sh
bun install --frozen-lockfile
bun run build
bun run test
bun run validate
bun run test:installer
bun run test:package

PYTHONDONTWRITEBYTECODE=1 \
uv run --isolated --python 3.13 --with 'mcp==2.2.0' \
  python -m unittest discover \
  -s toolkits/libvirt-toolkit/mcp/libvirt/tests -p 'test_*.py' -v

PYTHONDONTWRITEBYTECODE=1 \
uv run --isolated --python 3.13 --with 'mcp==2.2.0' \
  python -m unittest discover \
  -s toolkits/ollama-toolkit/mcp/ollama/tests -p 'test_*.py' -v

bun run test:opencode:schema

# Actual OpenCode evidence gate: Linux x86_64, bubblewrap, stable v2.2.1 or greater.
test "$(uname -m)" = "x86_64"
command -v bwrap
OPENCODE="$(command -v opencode)"
test -x "$OPENCODE"
# Both runners enforce minimum-version admission inside the sandbox.
node scripts/check-opencode-config-matrix.mjs --opencode "$OPENCODE"
node scripts/check-opencode.mjs discovery --opencode "$OPENCODE"
```

The OpenCode schema check requires HTTPS access to
`https://opencode.ai/config.json`. The matrix requires Linux x86_64, `bwrap`, the
stable OpenCode v2.2.1 or greater executable, Node.js 22+, `/usr/lib`, and
`/lib64/ld-linux-x86-64.so.2` for the reviewed sandbox runtime mounts. It fails
on missing prerequisites; it does not skip or fall back to an unisolated run.
Admission uses numeric stable-semver ordering (valid build metadata is allowed;
prereleases are not). Evidence records the actual executable version, and every
outcome must match that exact run version. Eligibility does not promise that a
later release passes the unchanged behavioral assertions.
The discovery test also requires the actual executable. Some repository test
wrappers may report optional prerequisite skips; run the explicit acceptance
commands above and treat any skip/nonzero result as incomplete evidence. No CI
configuration or automatic prerequisite installation is asserted here.

Package acceptance launches installed Ollama MCP entrypoints in both scopes
with a fake `ollama` executable and disposable HOME/XDG/inventory. It requires
`uv`, Python, and cached dependencies or network access; absence fails rather
than skips this protocol check. No real Ollama service is used. OpenCode discovery
keeps both MCP entries disabled: skill/config discovery is not MCP execution.

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
- Keep the npm Git-install and tarball lifecycle tests green; npm remains the
  supported compatibility path while Bun is the development default.
- Do not add live credentials, start shared or consumer services, alter a real
  OpenCode config, or perform libvirt/VM operations. The explicitly approved
  OpenCode evidence check may start only its disposable server inside the
  reviewed bubblewrap/network namespace using temporary config/data/state.

See [docs/authoring.md](docs/authoring.md) for the manifest contract.
