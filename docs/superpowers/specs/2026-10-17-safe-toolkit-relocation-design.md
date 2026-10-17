# Safe toolkit relocation and configuration rename design

**Status:** design only; implementation has not been approved.  This document
records the agreed contract and a proposed implementation/test approach. It is
not a claim that OpenCode loads every candidate listed below or that all config
precedence has been verified.

## Agreed contract

`update` repairs a copied/moved installation and supported OpenCode config
renames in the *explicitly selected* `--project PATH` or `--global` target. It
validates and repairs every toolkit recorded as installed in that selected
target, but refreshes payload/version only for the toolkit(s) named on the
command line. No old absolute path is ever a write or deletion destination.
Updating a moved installation is a transactional repair, not an invitation to
adopt arbitrary files or rewrite every config the user may have.

For owned MCP entries, only substitutions of the exact previous managed root
with the exact selected managed root are repairable. A changed non-path field,
extra/missing field, or modified owned payload file is a conflict. Relevant
consumer edits, comments, and VM data are preserved. More than one plausible
configuration owner, or evidence that another loaded config overrides the same
managed MCP name, fails with an actionable diagnostic rather than guessing.
Unsupported legacy config locations are left untouched and produce migration
guidance; they are not silently moved.

Dry-run performs no writes, locking, recovery, or directory creation. A real
repair is one transaction; failure rolls it back when safe. Successful changes
require restarting OpenCode. A journal that cannot be proven safe to recover
after a move fails closed and tells the operator how to recover; stale journal
writes must not be replayed against old paths.

## Current implementation facts (baseline)

- `resolveTarget` (`installer/src/target.ts`) uses explicit project and global
  roots. Project config candidates are root `opencode.json`/`opencode.jsonc`
  and nested `.opencode/opencode.json`/`.opencode/opencode.jsonc`; global
  candidates are `$XDG_CONFIG_HOME/opencode/opencode.json`/`opencode.jsonc`
  (or `$HOME/.config/opencode`).
  Current candidate resolution rejects multiple existing candidates and a
  state-owned config path outside the supported candidate set.
- State format 1 (`installer/src/state.ts`) stores absolute owned file paths,
  hashes/modes/owners, each toolkit's absolute `configPath`, and structural
  expected MCP entries. `validateStatePaths` in the engine currently checks
  containment under the *current* payload root and supported config candidates;
  that naturally rejects stale paths after a move.
- `InstallerEngine.plan` currently verifies only requested toolkits' owned
  files, requires exact current config ownership, and sets each requested
  toolkit's MCP entry from the current managed root. `update` without names
  updates all state entries; update with names only plans those names. This is
  not relocation repair today.
- `config.ts` parses JSONC, rejects duplicate keys, structurally compares
  values, and uses `jsonc-parser` edits, which preserve unrelated source text
  and comments. Current owned-entry checks require the complete expected value.
- Transactions (`transaction.ts`) snapshot preconditions, use a journal and
  durable replacements, and guard rollback/recovery by requiring each resource
  to equal either its recorded before or after snapshot. `applyTransaction`
  acquires the OS lock before journal recovery. `--dry-run` currently reports
  pending recovery without attempting it. Path checks reject symlink
  components. CLI mutations require Linux and util-linux `flock`; the lock is
  held by the parent-owned inherited file descriptor through transaction
  completion. These existing properties should remain.
- `docs/compatibility.md` records schema validation against the public schema
  and actual isolated discovery measured on OpenCode 1.18.31, while explicitly
  saying that is measured evidence, not an exact-version support promise.
  Existing tests cover candidate paths, JSONC preservation, ownership,
  transaction recovery, and dry-run. They do not establish config precedence
  across all OpenCode search locations.

## Proposed repair algorithm

### 1. Establish current target and old-root evidence

Use only the target from the explicit CLI scope. Resolve the current absolute
`payloadRoot`, managed toolkit root, state path, journal path, and supported
config candidate set from that target. Do not scan an old checkout, infer a
target from current working directory, or probe old paths as destinations.

Read state from the selected target. The catalog is **not** an inventory of
what an installed toolkit owns: a legitimate release may add/remove files, and
an older unrequested toolkit may no longer exist in the current catalog. For
every state record, derive the prior payload root from the stored
`configPath`'s recognized historical target layout (below), then derive each
installed relative file path lexically from its stored absolute file path and
that root. Require all file paths to be strict descendants of the inferred
root, all records to imply the same root for the selected scope, and the stored
config path and file layout to agree with the selected project/global layout.
Validate state shape, toolkit identity, file-owner label, hash/mode fields,
unique destinations, and entry ownership. An unrequested toolkit need not be
present in the current catalog; its stored state and verified current copies
are the evidence for preserving it. A requested toolkit must load its current
catalog manifest and uses the normal update inventory; if that manifest is
absent, the requested update fails.

Historical root inference is lexical, not filesystem discovery. For project
scope, a prior root-level `opencode.json`/`.jsonc` config implies project root
`dirname(configPath)` and payload root `<project root>/.opencode`; a nested
`.opencode/opencode.json`/`.jsonc` implies payload root `dirname(configPath)`.
For global scope, a recognized `<config-root>/opencode/opencode.json` or
`opencode.jsonc` config implies payload root `dirname(configPath)` (the
historical XDG config root is its parent). Require the exact basename
`opencode.json` or `opencode.jsonc`, absolute paths, and recognized layouts.
Reject
lexical `..` components *before* normalization, malformed paths, a config
layout inconsistent with scope, mixed inferred roots, file paths outside the
inferred payload root, and duplicate/aliased relative destinations. A
configPath that cannot prove one of these layouts is not enough to infer a
root: stop with a specific diagnostic that says historical ownership/root
cannot be proven and requests manual recovery/migration. Do not guess from
current working directory, catalog paths, directory names alone, or probing
the old location.

The inferred root and old absolute paths are provenance evidence only. No
`lstat`, `realpath`, `access`, existence check, metadata inspection, content
read, or other filesystem operation may target the inferred root or any stale
path. Reject traversal lexically before normalization; path normalization is
for comparison only, not proof of safety. All filesystem/no-follow/symlink,
regular-file, hash, mode, and parent checks apply only to the selected current
target and current destinations. Derive new destinations by joining each
validated installed relative path to the selected `payloadRoot`, then require
strict lexical containment and unique destinations.

Verify every current copy against its stored state hash and mode. A missing or
changed current copy is a conflict, not an implicit restoration from the old
location; the state hashes/modes are ownership evidence under the installer's
existing trust boundary, not cryptographic authentication. Never treat a
matching hash as proof against a maliciously edited state file. Do not weaken
current-target symlink/path protections to make a move succeed.

### 2. Select configuration by ownership, not guesswork

Examine supported candidates only within the explicit selected scope. For
each installed toolkit with MCP ownership, locate current ownership by exact
supported structural evidence. A uniquely matching supported current entry
may supersede a stale stored `configPath` when the old config path's recognized
historical layout and root are safely inferable as described above; state need
not be manually edited first. The stale absolute config path is evidence only
and is never accessed. Compare candidate entries as follows:

1. A candidate whose managed MCP entry matches the stored expected structure
   except for exact old-root-to-current-root substitutions is evidence of
   ownership. Substitution is limited to complete string path values in the
   managed command array (the exact old managed root prefix plus the same
   suffix); no substring, basename, wildcard, or arbitrary absolute-path
   replacement is allowed.
2. A candidate that matches no owned entry is not ownership evidence. A
   candidate with the same managed name but changed structure is a conflict,
   not a reason to choose another candidate.
3. There must be exactly one owner candidate for all managed entries. Two
   candidates with matching entries, incompatible owners/config paths, or
   multiple current config files with ambiguous evidence fail with paths and
   remediation (choose one supported config and remove/migrate the duplicate
   manually before retrying).

After selection, rewrite only the owned paths and record the selected current
`configPath` in state. Preserve every unrelated key/value, comment, and
formatting with `jsonc-parser` edits. Reject an owned MCP entry if any
non-path property differs, including command executable/arguments other than
the exact path argument, `type`, `enabled`, unknown fields, or shape. This
ensures user edits are conflicts rather than silently overwritten.

Distinguish an old *supported layout* that moved from a genuinely unsupported
legacy layout. If a recognized historical path proves the moved root, a unique
supported current structural match can repair stale state ownership. If the
historical layout/root cannot be proved, fail explicitly with that reason; do
not promise that copying files or retrying will repair ownership.

If ownership is found only in a currently unsupported config location, leave
that config untouched and give migration guidance identifying the observed
unsupported source. The user can manually merge/move the MCP entry into one
supported current candidate while preserving consumer settings; on retry, a
unique structural match there is sufficient even if state still names the
old supported path. Preserve any leftover unsupported config; do not delete
it. If a verified-loaded unsupported source competes with or overrides the
managed name, fail with both locations and require manual resolution rather
than treating supported ownership as effective.

### 3. Check duplicate/overriding configuration evidence

Before commit, inspect all supported candidates in the selected scope, not
just the selected file. If another candidate contains the same managed MCP
name with a different value, or supplies competing ownership evidence, fail
with both paths and require the user to resolve duplication. Also check any
other *known and supported* config sources that the project's verified
OpenCode versions load for the selected scope, when their precedence/search
rules are established. If another loaded config can override a managed name,
fail rather than report a repair that may be inert.

The current repository evidence proves the installer candidate list, not all
OpenCode config loading/precedence. Before implementation, verify root versus
nested project candidates (`opencode.json`, `opencode.jsonc`,
`.opencode/opencode.json`, `.opencode/opencode.jsonc`) against the versions
actually used by the compatibility checks and tests. Verify global candidates
similarly. Do not cite upstream development `dev` behavior as a supported
contract. If precedence cannot be proven, explicitly restrict the check to
known candidates, disclose the boundary in user-facing docs, and do not claim
to have ruled out every external override.

### 4. Plan one atomic repair

Plan all file/config/state changes for all installed toolkits before applying
anything. Verify every installed toolkit, including unrequested toolkits, and
rebase its ownership records. For requested toolkit names only, load the
current catalog payload and apply normal update semantics/version changes.
Unrequested toolkits retain their installed version and file contents; their
state paths/config ownership metadata are rebased only as needed to describe
the verified moved copies. Any conflict aborts the complete plan.

Take snapshots/reads for the state, selected config, every current owned file,
and all relevant alternate config candidates. A changed snapshot between plan
and apply aborts. Build all transaction changes at current selected-root
destinations only. Do not include old-root paths in reads that are interpreted
as mutation resources or in transaction changes. Dry-run prints the complete
proposed repair/update and conflicts but creates no lock, journal, directory,
or file.

Apply under the existing target lock and transaction. Rollback may restore
only current selected-root before-images when each current resource still
matches before/after. Keep parent-owned inherited-FD lock alive through
transaction completion. A successful CLI operation reports that OpenCode must
be restarted.

### 5. Interrupted journals across a move

Existing journal recovery is safe only when each journal resource is allowed
under the current target and equals its before or after image. A moved target
can make a prior journal refer to old absolute paths. Do not broaden the
allowed-resource predicate to accept those paths and do not translate/replay
journal changes by string replacement.

On detecting a journal, validate its schema and lexically classify every
resource path against the current target *before any path safety check or
snapshot*. Recovery is permitted only when the *entire* journal can be proven
to describe resources still within the selected target and each current
snapshot is exactly before or after; then existing guarded rollback semantics
may restore before-images. If any entry names the old root, is outside
selected scope, has ambiguous meaning, is malformed, or has an intervening
third state, refuse recovery and leave journal/data untouched. Report journal
path, offending resource, and
safe manual recovery guidance (restore the installation at its original
location and recover there, or manually inspect/resolve the journal before
retrying). Do not automatically remove or rewrite the journal. Dry-run only
reports pending/unsafe recovery and performs no writes.

Implementation must ensure a failed recovery never falls through to planning
or writing the new repair. Tests should specifically prove no access/write at
the old location, including when the old root still exists.

## Path, ownership, and atomicity invariants

- State structure, toolkit identity, owner labels, stored hash/modes, lexical
  installed paths, and one inferable historical root must agree; reject
  malformed or mixed-root state. Current manifests are not used to prove the
  installed inventory of unrequested toolkits.
- Every destination is derived from the selected current root plus validated
  installed relative path (or, for a requested upgrade, validated manifest
  relative path). Reject lexical traversal before normalization; then check
  strict containment (not equal to root). Reject absolute paths,
  duplicate/aliased paths, symlinks, special files, and unsafe current-target
  parent components.
- A current destination is only repairable if it is verified owned by this
  state and its current content matches expected ownership. Never adopt an
  unowned identical file or overwrite a changed owned file.
- Old absolute paths are provenance hints only. They may not be transaction
  changes, deletes, rollback destinations, or sources of bytes for repair.
- Config edits are structural and narrowly scoped to owned MCP path fields;
  all non-path ownership fields must match. Preserve unrelated configuration
  and comments. Do not touch `AGENTS.md`, VM data, or other user files.
- All installed-toolkit validations and all requested upgrades form one plan
  and one transaction. Any ambiguity/conflict means no changes.
- Dry-run has no writes, lock acquisition, recovery, directory creation, or
  journal mutation. Real mutations remain Linux-only with util-linux `flock`.
- A moved installation does not change uninstall ownership of VM data; toolkit
  removal must never delete VM data.

## Proposed tests

Use temporary project/global roots and fake payloads/configs only. Do not use a
real OpenCode config or live libvirt. Extend installer-engine and CLI tests:

1. Relocate project tree/state with two installed toolkits, leave old source
   root present, update one toolkit: all ownership metadata and config paths
   repair in current root; only named toolkit version/payload upgrades; assert
   byte-for-byte old root unchanged.
2. Same repair with old root absent; include JSON and JSONC variants and
   comments/unrelated values, including config rename from one supported
   candidate to another. Verify only managed path strings/state change.
3. Global relocation with explicit XDG/HOME roots; ensure another global or
   project target is untouched.
4. Mixed or contradictory old-root evidence, no inferable root, malformed
   state, requested manifest/state conflict, traversal, duplicate destination,
   symlinked component, regular-file/special-file conflicts: actionable error
   and zero writes.
5. Current owned file changed/missing, unowned file at rebased destination,
   or mode/hash mismatch: conflict; never restore bytes from extant old path.
6. Exact path-only MCP substitutions accepted; suffix/prefix lookalikes,
   multiple path substitutions, changed command argument, `type`, `enabled`,
   extra property, and duplicate-key JSONC rejected without edits.
7. Unique structural owner in supported current config supersedes stale
   `configPath` when old supported layout/root is inferable, without manual
   state edits. No evidence, multiple evidence, or competing supported entries
   produce no mutation and actionable error. Unsupported-only ownership gives
   migration guidance; after a manual merge, a unique supported match repairs
   state while preserving the unsupported source. A verified-loaded competing
   unsupported source fails.
8. Override/precedence fixtures for every config location proven loaded by the
   supported/tested OpenCode versions; assert conflict when another loaded
   source overrides same managed name. Keep unsupported/unverified precedence
   explicit rather than inventing fixtures as product facts.
9. An unrequested installed toolkit absent from catalog is preserved using its
   state inventory; a requested toolkit absent from catalog fails. A requested
   release adding/removing files updates only that toolkit's inventory while
   repairing/rebasing the unrequested toolkit's existing inventory.
10. Old-path safety: instrument filesystem calls to prove no `lstat`,
    `realpath`, `access`, open/read, or write targets old-root paths; reject
    lexical `..` before normalization and test mixed/unrecognized historical
    layouts.
11. Dry-run snapshots every target file, directories, lock and journal before
   and after; assert exact equality and no recovery attempt, including pending
   old-path journal.
12. Transaction fault injection after each write, before/after journal publish,
    and third-party edits: rollback only when guarded; otherwise retain journal
    and fail. Simulate move with journal paths at old root and prove no stale
    writes/replay and actionable recovery error.
13. Concurrency and lock ownership regression: lock remains parent-owned until
    transaction completes; existing inherited-FD lock semantics and Linux/
    `flock` requirement remain intact.
14. CLI: explicit `--project`/`--global` only, selected scope isolation,
    requested-vs-all installed reporting, dry-run message, migration/conflict
    diagnostics, and restart notice after successful repair.

## Documentation and compatibility follow-up

Before implementation, inspect primary OpenCode documentation/schema and the
actual isolated discovery behavior for the repository's tested OpenCode
version(s). Existing primary schema URL: <https://opencode.ai/config.json>.
Record observed config search/precedence evidence in `docs/compatibility.md`,
with version and test setup; do not extrapolate from a development build. In
particular, explicitly settle whether project-root and nested `.opencode`
JSON/JSONC candidates are genuinely supported, and the behavior when both
exist. The implementation must not expand candidate support beyond verified
behavior without a deliberate compatibility decision.

Update CLI help and user docs to describe explicit-scope relocation repair,
the named-toolkit upgrade behavior, conflict rules, unsupported legacy
migration, dry-run guarantees, restart requirement, and interrupted-journal
recovery instructions. State clearly that paths/configs outside verified
scope are not repaired and config precedence claims are bounded by measured
versions.

## Remaining decisions

No major user-contract decision remains: the scope and behavior above are the
agreed contract. Builder-level choices still to settle before coding:

- Exact CLI diagnostic/recovery wording and whether an unsafe moved journal
  gets a dedicated error code.
- Which concrete OpenCode versions/environments are available to establish
  root/nested JSON/JSONC and precedence evidence. Until that check is done,
  candidate/precedence facts remain unverified rather than assumptions.
- The exact code-level proof procedure for deriving one safe historical root
  from recognized `configPath` layout plus state-owned path containment/layout
  is a required focused implementation review before code is approved. It must
  not substitute current manifest inventory equality or filesystem inspection
  of old paths for that proof.

## Review and validation ownership

The design author checked this document against the agreed contract and the
source/docs named above. The parent session owns the next read and a fresh
review before implementation. No implementation validation was run or is
implied by this design-only change.
