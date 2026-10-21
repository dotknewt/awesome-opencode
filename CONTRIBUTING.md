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

bun run test:opencode:schema

# Actual OpenCode evidence gate: Linux x86_64, bubblewrap, installed stable V2 binary.
test "$(uname -m)" = "x86_64"
command -v bwrap
node scripts/check-opencode-config-matrix.mjs
node scripts/check-opencode.mjs discovery
```

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
and reject missing, malformed, prerelease, non-V2, or unrecognized version
output. They report the version actually measured; no binary is downloaded or
installed automatically. Missing binaries/prerequisites fail the explicit
acceptance command; no unisolated fallback is allowed. The schema check may
still visibly skip when its public schema endpoint is unavailable; treat that
skip/nonzero result as incomplete acceptance. No CI configuration or automatic
prerequisite installation is asserted here.

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
