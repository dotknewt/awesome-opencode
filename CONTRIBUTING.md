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

# Actual OpenCode evidence gate: Linux x86_64, bubblewrap, stable >=2.2.1 binary.
test "$(uname -m)" = "x86_64"
command -v bwrap
node scripts/check-opencode-config-matrix.mjs
node scripts/check-opencode.mjs discovery
```

Also run full KB discovery on the declared Python minimum and the shared test
runtime. These tests use disposable synthetic KBs and real MCP stdio, never the
operator's vault:

```sh
for version in 3.10 3.13; do
  PYTHONDONTWRITEBYTECODE=1 \
  uv run --isolated --python "$version" --with 'mcp==2.2.0' --with 'PyYAML==6.0.3' \
    python -m unittest discover -s toolkits/kb-toolkit/tests -p 'test_*.py' -v || exit
done
```

uv may provision interpreters/dependencies; that is not KB content fetching.
Installed KB protocol checks require these dependencies (cached or downloadable)
and a working `bwrap` mount/PID namespace. They mask the developer checkout and
remove the packaged source before launching installed files in both scopes;
only the disposable fixture root is writable. Setup failures fail rather than
skip this check. The default KB MCP
entry remains disabled/unconfigured; discovery alone does not verify execution.

Optional: select a specific executable instead of the installed `opencode` on
`PATH` (replace the example with a real executable path):

```sh
node scripts/check-opencode-config-matrix.mjs --opencode /path/to/opencode
node scripts/check-opencode.mjs discovery --opencode /path/to/opencode
```

The OpenCode schema check requires HTTPS access to
`https://opencode.ai/config.json`. The matrix/discovery checks require Linux
x86_64, `bwrap`, Node.js 22+, `/usr/lib`, and
`/lib64/ld-linux-x86-64.so.2` for the reviewed sandbox runtime mounts. They use
the installed `opencode` on `PATH` by default, or an explicit `--opencode PATH`,
and require stable OpenCode v2.2.1 or greater (later majors allowed), rejecting
missing, malformed, prerelease, or unrecognized version output. Shared admission
uses numeric semver ordering with BigInt; valid build metadata is allowed.
Every outcome must match the actual run version exactly. Eligibility is not a
promise that later releases pass the behavioral assertions.
They report the version actually measured; no binary is downloaded or
installed automatically. Missing binaries/prerequisites fail the explicit
acceptance command; no unisolated fallback is allowed. The schema check may
still visibly skip when its public schema endpoint is unavailable; treat that
skip/nonzero result as incomplete acceptance. No CI configuration or automatic
prerequisite installation is asserted here.

Package acceptance launches installed Ollama MCP entrypoints in both scopes
with a fake `ollama` executable and disposable HOME/XDG/inventory. It requires
`uv`, Python, and cached dependencies or network access; absence fails rather
than skips this protocol check. No real Ollama service is used. OpenCode discovery
keeps bundled MCP entries disabled: skill/config discovery is not MCP execution.

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
