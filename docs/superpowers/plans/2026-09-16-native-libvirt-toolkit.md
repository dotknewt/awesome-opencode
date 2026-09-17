# Native OpenCode toolkit first release

Approved conversational design, transcribed for execution on 2026-09-16.

## Spec and scope

Create a working `dotknewt/awesome-opencode` repository, toolkit-first and OpenCode-native. The first toolkit is `libvirt-toolkit`; public names are `dotknewt-libvirt-vms`, `dotknewt-guest-access`, and `dotknewt-libvirt` (MCP connection). A TypeScript installer automatically manages native MCP configuration while preserving unrelated JSONC content. The existing Python MCP server is migrated, not rewritten. No SDD toolkit is included.

## Global Constraints

- Work only in `/home/dotme/Code/awesome-opencode`; `/home/dotme/Code/awesome-agency` is read-only migration input at revision `36026a3619af7e38273e40ccf4266125c31d1f79`.
- No commits, pushes, publishing, live configuration installation, or live VM operations. All installer verification uses temporary targets.
- Use `apply_patch` for edits. No nested delegation. Workers return reports; controller owns reviews.
- Toolkit content is canonical, self-contained, namespaced, independently versioned, and shipped as real files. No Claude marketplace projection, `${CLAUDE_PLUGIN_ROOT}`, or source-checkout dependencies in installed content.
- Preserve libvirt lifecycle/safety semantics and separate software installation state from VM data. Never remove VM data on uninstall.
- Explicit project or global targets; global honors XDG_CONFIG_HOME. Preserve consumer AGENTS.md and unrelated configuration.
- Owned files use hashes and single-toolkit ownership; unowned collisions and local edits cause conflicts rather than overwrite. Config ownership is per MCP entry and compared structurally.
- Preflight before writes, transactional rollback and durable interrupted-operation recovery, target locking, zero-write dry-run, safe path handling.
- Installed content and packaged CLI work after the original source checkout disappears. Uninstall uses persisted state without requiring the original catalog.
- Native local MCP configuration: `mcp.dotknewt-libvirt = {type: 'local', command: ['uv','run','--script', ABSOLUTE_INSTALLED_SERVER], enabled: true}`. New config declares `$schema: https://opencode.ai/config.json`.
- No actual MCP/libvirt startup during installer/discovery tests. Use fake lifecycle adapters for protocol tests. Document prerequisites and restart requirement honestly.
- Default delegated model for all roles is `openai/gpt-5.6-sol`; no overrides.

## Task 1: Repository foundation and libvirt migration

Create package.json/lockfile, TypeScript configuration, ignore rules, root AGENTS.md, toolkit manifest/schema, and self-contained libvirt content. Package/CLI name: `awesome-opencode`; start package and toolkit version `0.1.0` (record original toolkit 1.0.7 in provenance). Support Node >=22, Linux first (libvirt server requires Linux).

Copy real source files from `plugins/libvirt-toolkit/mcp/libvirt/` and skill pools `skills/libvirt-vms/`, `skills/guest-access/`, excluding generated caches. Keep Python implementation and tests intact except necessary documentation paths, package layout contracts, and namespaced skill references. Native frontmatter must match namespaced directories. Preserve MIT attribution based on manifest evidence; state source/license provenance accurately and inspect relevant source notices.

Define a small strict versioned toolkit manifest with name/version/description/license, explicit exports, local MCP contributions, and explicit dependencies. Exports support skills, agents, commands and assets through simple source/destination mapping; actual first toolkit only needs skills and server assets. Runtime paths resolve to installed toolkit files. Do not invent OpenCode config keys. Validate paths, duplicate exports, namespace, required skills/frontmatter, and complete auxiliary references; add meaningful content validation tests/script. Include toolkit README, CHANGELOG and PROVENANCE. Root documents may be preliminary until Task 4.

Dependencies may include `jsonc-parser`, a schema validator, TypeScript, Node types; keep them minimal. Provide npm build/test/validate entry points matching what currently exists (later tasks extend them). Tests must use fake host adapters, never real virsh. Run relevant migrated Python tests with isolated dependencies and content/type checks. Record exact commands, output summaries, changed files, self-review and concerns in report.

## Task 2: Ownership-aware installer engine and configuration transactions

Build TypeScript modules under installer/src for catalog/payload, target selection, state, config edits, planning and transaction application. Consume Task 1 manifest or tighten it coherently if needed. Core operations: list, install, update, uninstall; update without toolkit names updates installed entries only; uninstall works without available source manifests. CLI wiring belongs to Task 3.

Project payload root `<project>/.opencode`, global root `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`; installer state root `<payload-root>/awesome-opencode`. Skills go into skills/<public-name>. Server/assets are under managed toolkits/<toolkit-name>. No source symlinks. Track versions, file hashes/modes, owner, expected managed config values and config-file location. Version and hash changes trigger appropriate updates; unowned identical files still conflict.

For project config consider root opencode.json/jsonc and .opencode/opencode.json/jsonc; for global config consider opencode.json/jsonc. Reject multiple candidates (do not guess precedence); reuse single supported existing file; default new project config at project root and global config at global root. Validate JSONC object shapes and duplicate keys, preserve comments/unrelated text through targeted jsonc-parser edits, refuse malformed inputs. Persist entry ownership and compare structurally so formatting/key order/unrelated edits do not conflict. Never replace whole mcp/config object or delete unrelated data. Explain configuration-layer limitations.

Preflight complete desired changes and stale-file deletions. Reject traversal, absolute export paths, symlink parent/leaf escapes and special files; protect state/config too. Hold an exclusive target lock and recheck preconditions before apply. Write journal with before/after content/modes sufficient for rollback. Catch ordinary failures and roll back; on next mutating run recover interrupted journal only if each affected resource matches recorded before/after state, otherwise refuse to overwrite intervening edits. Prevent concurrent operations from treating live locks as stale. Dry-run does not create target/state/lock/config and reports pending recovery without doing it. Never recursively delete directories that may contain user additions.

Use meaningful failing-first tests for install/update/uninstall, JSONC preservation, key-order equality, unowned/modified collisions, target resolution, malformed state/config, path/symlink attacks, rollback, interruption/recovery, intervening edits, locking/concurrency, dry-run. Provide explicit test fault injection rather than public destructive flags. Run covering tests and build; report API contract for Task 3.

## Task 3: Packaged CLI and source-independent verification

Wire CLI list/install/update/uninstall and --dry-run over engine. Mutations require exactly one of --project PATH or --global. Provide clear help, nonzero errors, planned operations, and restart reminder after successful mutations. No config-time source dependencies, no installer-started MCP. Add bin/package files/prepack rules; ensure build artifacts and toolkits are shipped but source tests, caches and scratch are not.

Add child-process CLI tests and real npm tarball integration: pack into temporary directory, install package in another temporary directory, remove a disposable source copy and execute installed CLI. Verify project/global install, updates, uninstall, command paths resolve, references exist and server modules import without source; uninstall remains possible if packaged catalog becomes unavailable. Ensure migrated Python tests remain maintainable even when excluded from package.

Add optional isolated OpenCode discovery script/test: inspect installed CLI --version/--help, isolate HOME/XDG and project, disable external plugins/skills/providers as supported, disable MCP entry before discovery, verify two native skills and resolved config through CLI. Never use credentials or start the real MCP server. Separate native schema validation (public config schema) from discovery. Tests that need unavailable binary/dependency clearly skip with prerequisites; CI setup added in Task 4. Run package/CLI tests and discovery if binary exists.

## Task 4: Documentation, CI, and release acceptance

Complete README, CONTRIBUTING, AGENTS.md, docs/authoring.md, architecture.md, compatibility.md and decisions describing actual implemented commands/schema/layout/config policy and evidence. Document Linux/libvirt/uv/virsh/qemu-img/qemu:///session prerequisites, dependency download on first server launch, VM data directory, explicit remote-host handling, installation/uninstall/conflict recovery, restart and absolute-path relocation caveat. Do not promise unsupported multi-host behavior or verification.

CI runs npm ci, build, validation, installer tests, package lifecycle tests and Python tests with supported dependency setup. Use optional qemu-img temporary-file tests only with installed binary. Include schema-validation and isolated OpenCode discovery jobs with explicit prerequisites; no live VM services/credentials. Preserve licenses/provenance; no fabricated authorship.

Run complete repository acceptance commands in temporary environments. Fix integration gaps within task scope, document measured OpenCode version and date. Review repository for stale dk-* names, Claude-specific registration, source path dependencies and packaging waste. Record commands/counts/skips and known limitations. No publication/commit/push is authorized.
