# Compatibility and evidence

Evidence dates and exact-version boundaries are stated per surface below; no
measurement is an inferred exact-version support promise.

| Surface | Supported/measured | Evidence boundary |
|---|---|---|
| Installer runtime | Linux, Node.js >=22, util-linux `flock` | CLI preflight plus parent-owned inherited-FD concurrency/recovery tests |
| Python server | Python >=3.10; acceptance uses 3.13 and `mcp==2.2.0` | Full fake-adapter unittest suite and isolated PEP 723 `--help` launch |
| OpenCode config schema | Public `https://opencode.ai/config.json` | Generated `dotknewt-libvirt` entry validated separately against `$defs.McpLocalConfig` |
| OpenCode discovery (historical; measured 2026-09-17) | OpenCode 1.18.31 measured | Historical isolated HOME/XDG project with `--pure`, plugins/providers/extra skills disabled, and MCP disabled; two native skills and config path observed. This is not v2 evidence. |
| OpenCode config candidate loading/discovery (historical) | OpenCode v2.0.30 measured 2026-10-17 | Exact executable, isolated `/api/config`, plugin readiness, native skill metadata, and disabled MCP entry observed below. No broader support change is implied. |
| OpenCode config candidate loading/discovery (current validation policy) | Stable OpenCode >=2.2.1 selected from `PATH` by default; explicit `--opencode PATH` supported | Shared numeric admission allows later majors and rejects older, prerelease, or malformed versions. Each outcome must exactly match the measured run version. Each successful run proves only its named assertions for that executable, not broad compatibility. No automatic download. |
| qemu images | Optional local `qemu-img` | Temporary qcow2 create/convert/backing-chain tests only |
| libvirt | `virsh`, `qemu-img`, per-user `qemu:///session` required for real use | No CI/live acceptance; lifecycle tests use fake command adapters |

The native discovery check proves resolution only—not an MCP handshake,
dependency download, provider request, MCP server launch, libvirt connectivity,
SSH transport, or VM lifecycle. Historical v2.0.30 evidence and the later
stable-V2 measurements below observed only the named config matrix, builtin
skill-plugin readiness, installed skills, and disabled MCP config in isolated
network namespaces. No provider requests or credentials were used. The schema
check is separate because discovery alone does not validate the authoritative
schema.

The server is host-local: paths, ownership, state, and `qemu:///session` belong to
the user and machine running it. Manual stdio over SSH is documented, but the
installer does not deploy remote hosts and no multi-host claim is made.

Schema acceptance needs network access. Server first launch also needs network
access unless the required Python/runtime artifacts are cached. Contributors
must install and verify the prerequisites listed in `CONTRIBUTING.md`; no CI
configuration or automatic prerequisite installation is claimed here.

OpenCode is a moving target. The public schema check is separate from runtime
source evidence. The stable >=2.2.1 gate is a selection policy, not a
compatibility guarantee for every eligible release. Each matrix/discovery run records
the actual executable version and supports only the assertions measured on that
version. External overrides and effective merged runtime completeness remain
unverified; no production observer, candidate expansion, or broad support claim
is implied. The historical v1 `--pure` discovery result remains limited to
1.18.31 and is not used as v2 evidence.

## Current OpenCode policy and v2.2.1 evidence (2026-10-29)

Actual acceptance requires **stable OpenCode v2.2.1 or greater**, using numeric
semver ordering, not an exact-version pin. Prereleases, malformed output, and
leading-zero version components are rejected; valid build metadata is allowed.
The shared sandbox runner records the actual version and requires every outcome
to match it exactly. Eligibility is not a claim that every later release passes:
the existing behavioral assertions and isolation remain mandatory.

Source-inspected v2.2.1 release references (separate from measurements):
[config protocol](https://github.com/anomalyco/opencode/blob/3ebcf9a32c7b28f658cfee80775448929361727a/packages/protocol/src/groups/config.ts),
[plugin protocol](https://github.com/anomalyco/opencode/blob/3ebcf9a32c7b28f658cfee80775448929361727a/packages/protocol/src/groups/plugin.ts),
and [skill protocol](https://github.com/anomalyco/opencode/blob/3ebcf9a32c7b28f658cfee80775448929361727a/packages/protocol/src/groups/skill.ts)
retain the config-entry and location-scoped plugin/skill response shapes used by
the harness; the plugin and skill routes are experimental.
[Config schema](https://github.com/anomalyco/opencode/blob/3ebcf9a32c7b28f658cfee80775448929361727a/packages/schema/src/config.ts),
[MCP schema](https://github.com/anomalyco/opencode/blob/3ebcf9a32c7b28f658cfee80775448929361727a/packages/schema/src/mcp.ts),
[plugin schema](https://github.com/anomalyco/opencode/blob/3ebcf9a32c7b28f658cfee80775448929361727a/packages/schema/src/plugin.ts),
[location parsing](https://github.com/anomalyco/opencode/blob/3ebcf9a32c7b28f658cfee80775448929361727a/packages/server/src/location.ts),
and [builtin skill registration](https://github.com/anomalyco/opencode/blob/3ebcf9a32c7b28f658cfee80775448929361727a/packages/core/src/config/plugin/skill.ts)
support the unchanged entry, disabled-state, location, and readiness assertions.
Source shapes alone do not prove legacy MCP normalization or runtime readiness;
those remain experimental acceptance prerequisites for each actual executable.

Measured here with `/home/dotme/.opencode/bin/opencode`, reporting
`opencode v2.2.1`: the unchanged isolated 18-case matrix passed with the same
ordered candidate paths and markers listed in the historical table below.
Isolated discovery passed: builtin `opencode.config.skill` reached active state,
all four installed skill identities and exact paths were observed, and both
libvirt and Ollama MCP entries normalized to `disabled: true` with their exact
sandbox-mapped entrypoints. Commands were
`node scripts/check-opencode-config-matrix.mjs --opencode "$(command -v opencode)"`
and `node scripts/check-opencode.mjs discovery --opencode "$(command -v opencode)"`.
No sandbox mounts were added in that pre-merge run; no MCP server execution, live service, provider
request, or consumer configuration was involved. These results are bounded to
this release and disposable fixture, not external overrides or merged-runtime
completeness. Historical measurements and release links below remain unchanged.

### Ollama integration (2026-10-29)

Focused npm tarball acceptance passed with both project/global installations:
the unpacked package source was deleted and the installed CLI catalog made
unavailable before launching each target-owned `uv run --script` entrypoint.
A fake Ollama executable handled stdio MCP initialize, tools/list, list_models,
suggest_names, and confirmed rename_model. Assertions checked structured/text
result agreement, copy/verify/remove trace, and final fake inventory. This is
direct MCP subprocess evidence, **not OpenCode MCP execution** or live Ollama
compatibility. Runtime assets/skill inclusion and exclusion of tests/caches were
checked in the real tarball.

Discovery expects four installed skills and two disabled MCP entries. The initial
attempt failed closed under the former exact-v2.0.30 policy because the available
executable was `opencode v2.2.1`. The new minimum-version policy and successful
v2.2.1 rerun are recorded separately above, not as an extension of historical
v2.0.30 evidence. That run kept sandbox mounts and network isolation unchanged; no
Python/uv/Ollama runtime was mounted. Public schema validation passed during
controller acceptance; full-suite acceptance remains controller-owned.

The remote integration adds only a read-only mount of the self-contained shared
version helper beside the sandbox driver; no repository directory, Python/uv,
Ollama runtime, or consumer configuration is exposed.
The integrated runner was rechecked on `opencode v2.2.1`: PATH-selected 18-case
matrix and PATH/explicit-path discovery passed, with four installed skills and
both MCP entries disabled. The dated Hermes planning documents retain their
historical V2-only policy wording; current repository acceptance follows the
minimum-version policy here and in `CONTRIBUTING.md`, not that superseded wording.

## Historical OpenCode v2.0.30 configuration evidence

| Version | Command | Documented fact | Source-inspected fact | Measured result | Support boundary |
|---|---|---|---|---|---|
| 2.0.30 (measured 2026-10-17) | `bun run build && node --test dist/tests/opencode-config-matrix.test.js && bun run test:opencode:discovery`; matrix: `node scripts/check-opencode-config-matrix.mjs --opencode "$(command -v opencode)"` | [v2 config docs](https://opencode.ai/v2/docs/config) and [v2 CLI docs](https://opencode.ai/v2/docs/cli) are versioned documentation references; no undocumented precedence rule is inferred from them. | Released source: [Config.Entry schema](https://github.com/anomalyco/opencode/blob/v2.0.30/packages/schema/src/config.ts) is document/directory; [config protocol](https://github.com/anomalyco/opencode/blob/v2.0.30/packages/protocol/src/groups/config.ts) and [handler](https://github.com/anomalyco/opencode/blob/v2.0.30/packages/server/src/handlers/config.ts) return entries low-to-high; [location](https://github.com/anomalyco/opencode/blob/v2.0.30/packages/server/src/location.ts) uses literal `location[directory]`; [MCP schema](https://github.com/anomalyco/opencode/blob/v2.0.30/packages/schema/src/mcp.ts) uses normalized `disabled?: boolean`; [plugin protocol/handler/schema](https://github.com/anomalyco/opencode/blob/v2.0.30/packages/protocol/src/groups/plugin.ts) expose location-scoped plugin inventory and active/failed status; [skill protocol](https://github.com/anomalyco/opencode/blob/v2.0.30/packages/protocol/src/groups/skill.ts) returns wrapped skill data. | Exact `opencode v2.0.30`: matrix 18/18 and discovery passed; focused compiled test suite 11/11. Plugin `opencode.config.skill` was builtin/active; skill response had five entries (two built-ins and three expected installed skills at exact paths). Project MCP normalized to `disabled: true`, with the exact sandbox-mapped entrypoint. | Bounded candidate-only behavior: no candidate expansion, production observer, or support change. External overrides and effective merged runtime completeness remain unverified. Harness requires Linux x86_64 and bubblewrap with the explicitly mounted runtime paths; this is not a broader platform claim. |

### Measured config documents

The entries below are ordered as returned (lowest-to-highest priority per the
released handler); `path ← marker` identifies each distinct fixture document.
They document observed source entries only—not effective merged values or a
general precedence rule. XDG/HOME mixed cases deliberately supply both files
with XDG selected in the environment; only the XDG document was observed.

The readiness barrier is source-backed and measured for this exact release:
released v2.0.30 [`GET /api/plugin`
protocol](https://github.com/anomalyco/opencode/blob/v2.0.30/packages/protocol/src/groups/plugin.ts)
and [handler](https://github.com/anomalyco/opencode/blob/v2.0.30/packages/server/src/handlers/plugin.ts)
return plugin inventory; [Plugin.Info](https://github.com/anomalyco/opencode/blob/v2.0.30/packages/schema/src/plugin.ts)
exposes identity, source, and active/failed state. The isolated run observed
`opencode.config.skill` with builtin source and active status before the single
skill request; this resolves the observed startup timing for this harness only,
not a general precedence or support claim.

The separate discovery acceptance command passed on 2026-10-17. Its config API
returned `disabled: true` and the expected sandbox-mapped command path. After
the builtin plugin reached active state, the skill API returned five skills:
the builtin `opencode` and `report` entries under `/builtin/*.md`, plus
`dotknewt-guest-access`, `dotknewt-handling-todos`, and
`dotknewt-libvirt-vms` at `/fixture/project/.opencode/skills/<id>/SKILL.md`.
Only builtin plugin/skill registrations were observed; provider requests and
credentials were not used, and the MCP entry remained disabled inside the
network-isolated disposable environment.

| Case | Ordered loaded document path ← marker | Source role / evidence ID |
|---|---|---|
| project-json | `project/opencode.json` ← `matrix-project-json-0` | project root / matrix-first |
| project-jsonc | `project/opencode.jsonc` ← `matrix-project-jsonc-0` | project root / matrix-first |
| project-conflict | `project/opencode.json` ← `matrix-project-conflict-0`; `project/opencode.jsonc` ← `matrix-project-conflict-1` | project root format pair / matrix-first |
| nested-json | `project/.opencode/opencode.json` ← `matrix-nested-json-0` | nested project / matrix-first |
| nested-jsonc | `project/.opencode/opencode.jsonc` ← `matrix-nested-jsonc-0` | nested project / matrix-first |
| nested-conflict | `project/.opencode/opencode.json` ← `matrix-nested-conflict-0`; `project/.opencode/opencode.jsonc` ← `matrix-nested-conflict-1` | nested format pair / matrix-first |
| project-nested-json | `project/opencode.json` ← `matrix-project-nested-json-0`; `project/.opencode/opencode.json` ← `matrix-project-nested-json-1` | cross-level JSON pair / matrix-first |
| project-nested-jsonc | `project/opencode.jsonc` ← `matrix-project-nested-jsonc-0`; `project/.opencode/opencode.jsonc` ← `matrix-project-nested-jsonc-1` | cross-level JSONC pair / matrix-first |
| project-json-nested-jsonc | `project/opencode.json` ← `matrix-project-json-nested-jsonc-0`; `project/.opencode/opencode.jsonc` ← `matrix-project-json-nested-jsonc-1` | cross-level mixed pair / matrix-first |
| project-jsonc-nested-json | `project/opencode.jsonc` ← `matrix-project-jsonc-nested-json-0`; `project/.opencode/opencode.json` ← `matrix-project-jsonc-nested-json-1` | cross-level mixed pair / matrix-first |
| global-xdg-json | `xdg/opencode/opencode.json` ← `matrix-global-xdg-json-0` | selected XDG global / matrix-first |
| global-xdg-jsonc | `xdg/opencode/opencode.jsonc` ← `matrix-global-xdg-jsonc-0` | selected XDG global / matrix-first |
| global-home-json | `home/.config/opencode/opencode.json` ← `matrix-global-home-json-0` | HOME fallback with XDG unset / matrix-first |
| global-home-jsonc | `home/.config/opencode/opencode.jsonc` ← `matrix-global-home-jsonc-0` | HOME fallback with XDG unset / matrix-first |
| xdg-conflict | `xdg/opencode/opencode.json` ← `matrix-xdg-conflict-0`; `xdg/opencode/opencode.jsonc` ← `matrix-xdg-conflict-1` | XDG format pair / matrix-first |
| home-conflict | `home/.config/opencode/opencode.json` ← `matrix-home-conflict-0`; `home/.config/opencode/opencode.jsonc` ← `matrix-home-conflict-1` | HOME format pair with XDG unset / matrix-first |
| xdg-home-json-inputs | `xdg/opencode/opencode.json` ← `matrix-xdg-home-json-inputs-0` | XDG selected; HOME input not observed / matrix-first |
| xdg-home-jsonc-inputs | `xdg/opencode/opencode.jsonc` ← `matrix-xdg-home-jsonc-inputs-0` | XDG selected; HOME input not observed / matrix-first |

The matrix measured these fixture document paths under this exact isolated
configuration. It does not rule out external overrides or prove effective
runtime merge completeness. Evidence is inline and reproducible via the
acceptance commands in [CONTRIBUTING.md](../CONTRIBUTING.md); no ignored scratch
artifact is required. Discovery passed for the specific builtin readiness,
installed skill identities/paths, and disabled MCP entry described above; it
does not establish broader runtime or external-source behavior.

## Relocation boundary

Installer relocation is an update-only ownership operation, not an OpenCode
source-precedence guarantee. Configuration handling is bounded by the
installer's existing candidate policy; the v2.0.30 evidence above measured only
the listed 18 fixture cases. It does not claim completeness for external
overrides or effective merged runtime configuration. Update at a moved root
verifies every installed current copy and rebases every installed state record,
while requested toolkits' payloads/versions change (or every installed toolkit
is updated when no names are supplied). Unsafe
historical ownership/journal references and distinct overlapping previous/current
payload roots are refused. Initial selected-state discovery and shared ancestors
may access prior paths; the bounded stale-resource guarantee starts after
provenance is established. Same-root rename permits current-root access. No
stale-resource access after provenance is claimed, but no general observer or
relocation support for install, uninstall, list, or other operations is implied.

## Historical stable-V2 policy and measured 2.1.1 result

`scripts/check-opencode-config-matrix.mjs` and
`scripts/check-opencode.mjs discovery` select `opencode` from `PATH` unless an
explicit `--opencode PATH` is supplied. The former V2-only admission policy is
superseded by the stable >=2.2.1 policy above; v2.1.1 no longer qualifies for
current acceptance. Missing executables fail closed; no automatic download or
unisolated fallback is performed.

On 2026-10-21, the focused acceptance run selected `opencode v2.1.1` from `PATH`
and passed the existing 18-case configuration matrix plus isolated discovery
assertions. This is evidence for those specific assertions on v2.1.1 only; it
does not establish general V2 compatibility, effective config merging, or
external override behavior. The pinned v2.0.30 source citations and measurements
above remain historical evidence and are not removed or reinterpreted.
