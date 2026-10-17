# Safe Toolkit Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make explicit-scope `update` safely rebase all state-owned toolkits after a supported project/global move, upgrading payload/version only for requested toolkit(s) (or all installed toolkits when no names are supplied).

**Architecture:** Keep state format 1 and introduce pure historical-root proof and positive resource policy. Add exact MCP path edits, an asynchronous current-config snapshot/selection layer, and a full journal preflight barrier; then orchestrate them only in update. A child-process filesystem guard verifies stale-path non-access; compatibility claims are bounded to measured OpenCode evidence.

**Tech Stack:** TypeScript/Node.js, Bun, `node:test`, `jsonc-parser`, current snapshot/journal transaction, OpenCode schema/discovery scripts, Python unittest acceptance.

**Spec:** `docs/superpowers/specs/2026-10-17-safe-toolkit-relocation-design.md`

## Global Constraints

- State `formatVersion: 1`; update-only relocation; do not alter install, uninstall, or list repair semantics.
- Require explicit `--project PATH` or `--global`; never infer scope from cwd or scan an old checkout.
- Stored owned paths are absolute by format. Derived installed relative paths must be normalized relative paths, never absolute, traversing, aliased, or duplicate.
- Preserve consumer config/comments, consumer `AGENTS.md`, unrelated files, and VM data at runtime; repository guidance may be intentionally updated in Task 6. No old path is a write/delete/rollback/source destination.
- Native installed payload namespaces are `skills/<public-name>/<files>`, `agents/<public-name>.md`, `commands/<public-name>.md`, `awesome-opencode/toolkits/<own-toolkit>/<files>`; confirm grammar against `installer/src/toolkit-manifest.ts`.
- Validate raw absolute paths/NUL/`..` before normalization; reject aliases, prefix collisions, global duplicate MCP ownership, invalid lowercase SHA-256, and modes outside integer `0..0o777`.
- Hashes/modes are ownership evidence within existing trust boundary, not cryptographic authentication. Current selected destinations retain no-follow/symlink, regular-file, parent, hash and mode checks.
- Preserve inherited parent-owned `flock` FD through transaction completion, guarded rollback, third-state protection and fault hooks. Mutations are Linux-only and require util-linux `flock`.
- Dry-run: no writes, lock, recovery, directory creation or journal mutation.
- Use temporary project/global roots and fake config/payloads only; never live libvirt, actual consumer config, credentials, services, or shared OpenCode services/plugins/providers/MCP.
- Node.js 22+, Python 3.10+, Linux, util-linux `flock`, Bun and `uv`; `sshd` and `ssh-keygen` are mandatory tests. `qemu-img` is optional and disposable-temp-only.
- Successful mutation requires OpenCode restart. This plan makes no claim about currently shipped relocation behavior; implementation replaces the obsolete repository guidance only after behavior and evidence are established.
- Do not bump toolkit versions without payload changes. Do not expand candidate support absent explicit compatibility decision.
- Do not claim tests or prerequisite versions run until execution actually produces results.

## Review Focus

1. **Overlapping previous/current roots or observer coinciding with stale path:** even the initial read of selected state can traverse an ancestor belonging to the old root before proof exists. This is a scope-clarification gate before execution; do not claim impossible zero prior access or silently treat post-proof rejection as solving it.
2. **Malformed/mixed/empty state and ambiguous native namespace interpretation:** including project directory literally named `.opencode`, empty records, skills-only records and absent catalog; reject ambiguity without inventing proof.
3. **Config competition/path argument:** exact generated final command index only; split owners, conflicts, unsupported or verified-loaded overriding sources fail/migrate without replacing full entries.
4. **Malformed/stale journal or resource collision:** validate complete journal schema and all lexical resource classes before any resource safety or snapshot calls; refused recovery does not plan or replay stale resource paths.
5. **Races and misleading safety evidence:** snapshot absence/presence, unchanged unrequested files and observers under lock; instrument APIs so zero stale reads are proven, not inferred from an unchanged old tree. Precedence claims require exact-version evidence.

## File Responsibilities and Interfaces

- `installer/src/relocation.ts`: pure `HistoricalRootProof { previousPayloadRoot: string; previousManagedRoot: string; rebasedState: InstallerState }`; `proveHistoricalRoot(state: InstallerState, target: TargetPaths): HistoricalRootProof`. Empty state explicitly returns previous roots equal to current roots (identity/no historical evidence), and empty record inventories cannot infer a root.
- `installer/src/resource-policy.ts`: `classifyMutationResource(target: TargetPaths, resourcePath: string): 'payload' | 'config' | 'state'`; `assertInstalledRelativePath(toolkitName: string, relativePath: string): void`. Classifier rejects journal/locks/temp/control resources; it does not grant broad allowlists. Requested manifest paths use the same positive native namespace rules.
- `installer/src/state.ts`: export existing `validateState(value: unknown): asserts value is InstallerState` and strengthen it to reject malformed raw absolute paths and duplicate/alias/prefix ownership before path resolution erases evidence; preserve format 1 and existing valid install/uninstall/list states.
- `installer/src/config.ts`: `CommandPathEdit { index: number; before: string; after: string }`; `matchRelocatedEntry(actual: unknown, expected: unknown, previousManagedRoot: string, currentManagedRoot: string): CommandPathEdit[]`; `editOwnedCommandPaths(source: string, name: string, edits: readonly CommandPathEdit[]): string`. Only generated entrypoint path at final command index; preserve JSONC comments.
- `installer/src/repair-config.ts`: `ConfigSource { path: string; role: 'candidate' | 'observer'; evidenceId: string }`; `RepairConfigSelection { path: string | undefined; source: string | undefined; reads: TransactionRead[]; entries: Record<string, OwnedConfigEntry[]> }`; synchronous `listRepairConfigSources(target: TargetPaths, env: NodeJS.ProcessEnv): ConfigSource[]`; asynchronous `selectRepairConfiguration(target: TargetPaths, state: InstallerState, proof: HistoricalRootProof, sources: readonly ConfigSource[]): Promise<RepairConfigSelection>`. Selection snapshots current bounded sources; preserves original expected state for comparison and returns rebased expected entries per toolkit plus all reads/absences. Empty MCP bypasses it in engine with no config I/O.
- `installer/src/transaction.ts`: exported `Journal { formatVersion: 1; changes: TransactionChange[] }`; `validateJournalResources(value: unknown, target: TargetPaths): Journal`; `inspectPendingJournal(target: TargetPaths): Promise<'none' | 'pending'>`; `TransactionOptions { observerPaths?: readonly string[] }`; exact `applyTransaction(target: TargetPaths, changes: TransactionChange[], reads?: TransactionRead[], faults?: TransactionFaults, options?: TransactionOptions): Promise<void>`. Journal inspection validates schema/resources lexically without snapshotting any journal change resource. Engine supplies evidence-approved observers and rejects stale provenance; transaction validates observer paths as absolute/canonical, rejects controls/mutation overlap, and revalidates snapshots under lock. Transaction cannot independently prove historical provenance with its API inputs. Observers never authorize mutation/recovery.
- `installer/src/installer-engine.ts`: `InstallerPlan.observerPaths: string[]`; update verifies/rebases every installed record, loads current manifests only for requested names (unnamed means all), constructs evidence-backed observer paths and lexically rejects forbidden stale paths before transaction handoff. No install/uninstall/list behavior change.
- Evidence files: create `scripts/check-opencode-config-matrix.mjs`, `tests/opencode-config-matrix.test.ts`; existing actual compatibility test is `tests/opencode-compat.test.ts`. Keep `scripts/check-opencode.mjs` unless evidence harness needs a narrow integration.
- Tests are in `tests/*.test.ts`; `tsconfig.json` includes `tests/**/*.ts`. Compile then run built tests using `bun run build && node --test dist/tests/<file>.test.js`, never `bun test`.
- New tests: `tests/relocation.test.ts`, `tests/resource-policy.test.ts`, `tests/repair-config.test.ts`, `tests/config-relocation.test.ts`, `tests/transaction-relocation.test.ts`, `tests/relocation-io.test.ts`; existing engine regression is `tests/installer-engine.test.ts`. New child-process guard helper: `scripts/relocation-io-guard.mjs`.
- Docs: README, `docs/architecture.md`, `docs/compatibility.md`, CLI help, and narrow obsolete relocation guidance in repository `AGENTS.md` (use writing-for-agents at execution). Do not edit consumer AGENTS.

## Dependency, Write-Scope, and Validation Ownership

| Task | Depends on | Files owned | Focused validation |
|---|---|---|---|
| 1 evidence | none | matrix script/test, compatibility evidence table | build + `node --test dist/tests/opencode-config-matrix.test.js`; real CLI matrix |
| 2 pure proof | Task 1 source policy | relocation/resource/state + corresponding tests | build + node tests for relocation/resource |
| 3 config selection | Task 2 | config/repair-config + their tests | build + node config/repair tests |
| 4 transaction | Task 2 | transaction + transaction-relocation test | build + node transaction-relocation test |
| 5 engine | Tasks 3 and 4 | engine + existing engine test | build + node engine test |
| 6 end-to-end/docs | Task 5 | IO helper/test, package.json, CLI/docs/AGENTS | build + node IO/CLI/installer suites |
| 7 acceptance | Tasks 1–6 | no product ownership | CONTRIBUTING commands + package inspection |

Tasks 3 and 4 may proceed in parallel after Task 2; their owned source/test files are disjoint. Task 5 waits for both. The focused root-proof fresh review below must pass before integration approval.

Implementation specialist owns task-scoped code/tests/assertions. Fast-generic owns serialized build/test command execution and records command evidence; do not run concurrent builds into shared `dist`. Parent owns evidence-artifact review, focused proof review, and final acceptance review. Tasks 3 and 4 may be implemented in parallel, but their build/Node validation commands run serially through the single fast-generic lane.

### Plan Production Checklist

- [x] Reconnaissance and read-only oracle review completed by parent; source interfaces read for drafting.
- [x] Draft produced and revised against parent findings.
- [x] Parent reviewed coverage and interfaces; compatibility measurements and overlapping-root clarification remain execution gates.
- [ ] Execution not approved; plan only.

---

### Task 1: Establish Versioned OpenCode Evidence Gate

**Files:**
- Create: `scripts/check-opencode-config-matrix.mjs`, `tests/opencode-config-matrix.test.ts`.
- Modify: `docs/compatibility.md` (concrete evidence table).
- Read: `scripts/check-opencode.mjs`, `tests/opencode-compat.test.ts`, `installer/src/target.ts`.
- Evidence sources: primary `https://opencode.ai/v2/docs/config`, `/v2/docs/cli`, public `https://opencode.ai/config.json`, released source, actual executable.

**Interfaces:**
- CLI: `node scripts/check-opencode-config-matrix.mjs --opencode /absolute/path/to/tested/opencode` (the executor supplies the actual verified binary path).
- Produces exact candidate/source policy and table columns for version, command, documented fact, source-inspected fact, measured result, and support boundary. If precedence remains unsettled but existing candidate loading is verified, use the bounded known-candidate-only fallback and disclose that unverified external overrides are not ruled out. If actual-version evidence cannot establish that even current candidates are loaded, BLOCK implementation; do not silently retain unsupported writes. No automatic support change.

- [ ] **Step 1: Add named failing test** `testMatrixCoversCandidatesAndConflictPairs`; assert matrix includes project root and nested JSON/JSONC, global HOME/XDG single candidates and conflicting pairs, and only source-confirmed extra loaded sources. Each run uses temporary HOME/XDG, isolated cwd, and no shared service/plugins/providers/MCP. Account for ancestor/system config leakage: use exact-version source-backed isolation or a disposable sandbox proving no real config loaded; do not invent a safe `--pure` guarantee. Assertion shape: `assert.deepEqual(result.loadedCandidates, expectedEvidenceBackedCandidates)`.
- [ ] **Step 2: Run against actual exact released 1.18.31 or explicitly documented tested replacement.**

  Run: `bun run build && node --test dist/tests/opencode-config-matrix.test.js` then `node scripts/check-opencode-config-matrix.mjs --opencode /absolute/path/to/tested/opencode`.
  Expected: test checks emitted exact executable version and reproducible outcomes; fake CLI cannot establish precedence. If actual executable absent, discovery is **BLOCKED** and implementation cannot pass this evidence gate. Docs/source may be unavailable while adequate measured evidence exists, but record that gap and do not assert undocumented facts.

- [ ] **Step 3: Implement matrix and evidence table.** Existing `scripts/check-opencode.mjs` remains unless a narrow integration is required. If matrix cannot isolate external config, report **BLOCKED** rather than claim measured candidate behavior. No guessed sources; unknown sources are not silently scanned. Candidate-only fallback is allowed only after verifying current candidates load in the tested version; no candidate expansion without compatibility decision.
- [ ] **Step 4: Re-run matrix and schema/discovery.**

  Run: `bun run test:opencode:schema && bun run test:opencode:discovery && node scripts/check-opencode-config-matrix.mjs --opencode /absolute/path/to/tested/opencode`.
  Expected: schema and actual discovery succeed; dedicated CI requires prerequisites and treats every nonzero result including 77 as failure.
- [ ] **Step 5: Commit:** `git add scripts/check-opencode-config-matrix.mjs tests/opencode-config-matrix.test.ts docs/compatibility.md && git commit -m "test: establish OpenCode config source evidence"`.

### Task 2: Pure Historical Root, State, and Resource Proofs

**Files:**
- Create: `installer/src/relocation.ts`, `installer/src/resource-policy.ts`, `tests/relocation.test.ts`, `tests/resource-policy.test.ts`.
- Modify: `installer/src/state.ts` and `tests/installer-engine.test.ts` for regression coverage.
- Read: `installer/src/target.ts`, `toolkit-manifest.ts`, `payload.ts`.

**Interfaces:**
- Consumes Task 1's bounded candidate/source evidence and existing `InstallerState`, `TargetPaths`, `OwnedFile`, `OwnedConfigEntry`.
- Produces the exact interfaces listed above. Proof/classifier are pure and perform no filesystem calls.

- [ ] **Step 1: Add named failing tests** `projectRootConfigInfersProjectPayloadRoot`, `nestedConfigInfersNestedPayloadRoot`, `globalConfigRequiresOpencodeDirectory`, `emptyStateUsesIdentityWithoutProof`, `emptyInventoryCannotInventProof`, `skillsOnlyRecordRebasesConfigPathWithoutMcp`, `opencodeBasenameAmbiguityFailsClosed`, and `malformedStateRejectedBeforePathResolution`. Assertion examples: `assert.equal(proof.previousPayloadRoot, oldPayloadRoot)`; `assert.equal(proof.previousPayloadRoot, target.payloadRoot)` for empty state; `assert.throws(() => validateState(state), /absolute|traversal/)` using exported assertion signature `validateState(value: unknown): asserts value is InstallerState`.
- [ ] **Step 2: Add named resource/path tests** `installedPathsRejectAbsoluteAndTraversal`, `aliasesAndPrefixCollisionsAreRejected`, `nativeNamespacesRequireOwnerLayout`, `mcpEntrypointMustBeOwnedAndInventoried`, `hashAndModeAreStrict`, `classifierRejectsJournalLockTempAndControlPaths`. Include duplicate MCP ownership across records, symlink/special-file current fixtures for engine boundary, no catalog needed for historical inventory, requested manifest missing handled later. Assertion examples: `assert.throws(() => assertInstalledRelativePath('alpha', '../outside'))`; `assert.throws(() => classifyMutationResource(target, target.journalPath))`.
- [ ] **Step 3: Run tests to verify failures.**

  Run: `bun run build && node --test dist/tests/relocation.test.js dist/tests/resource-policy.test.js`.
  Expected: before implementation TypeScript may fail on the deliberately missing exports; that compile failure is the red result, not a passing test suite. After exports exist, named behavioral assertions must pass. Every test is pure: no old path probes.

- [ ] **Step 4: Implement `validateState` raw-path validation before normalization** and proof/policy helpers. Historical project interpretations are project dirname + `/.opencode`, or dirname when config parent basename `.opencode`; global requires exact basename `opencode.json`/`.jsonc` under basename `opencode`. Namespace/layout must disambiguate project roots, including project directory literally named `.opencode`; if not unique, fail. Filter by stored native namespace/owner/layout; intersect all record interpretations; require exactly one root. No manifest or old FS access. Rebase only validated relative paths to current root. Empty state roots are current-root identity; empty file inventories do not prove roots. For skills-only records rebase configPath lexically without reading config; no MCP means engine does not call config selector.
- [ ] **Step 5: Run focused tests plus unchanged-operation state regression.**

  Run: `bun run build && node --test dist/tests/relocation.test.js dist/tests/resource-policy.test.js dist/tests/installer-engine.test.js`.
  Expected: PASS, including existing valid state install/uninstall/list cases and all malformed raw state rejection assertions.
- [ ] **Step 6: Mandatory root-proof review before integration approval.** Fresh reviewer checks project `.opencode` basename ambiguity, empty state/records, skills-only no config read, old catalog absence, raw path validation order, and pure no-FS proof. Resolve findings and rerun Task 2 focused command before Tasks 5–6.
- [ ] **Step 7: Commit:** `git add installer/src/relocation.ts installer/src/resource-policy.ts installer/src/state.ts tests/relocation.test.ts tests/resource-policy.test.ts tests/installer-engine.test.ts && git commit -m "feat: prove relocation ownership from state"`.

### Task 3: Exact MCP Path Editing and Async Config Selection

**Files:**
- Modify: `installer/src/config.ts`.
- Create: `installer/src/repair-config.ts`, `tests/config-relocation.test.ts`, `tests/repair-config.test.ts`.

**Interfaces:**
- Consumes Task 2 proof/policy; Task 1 candidate/observer source policy; existing config parser.
- Produces `CommandPathEdit`, exact match/edit functions, synchronous `listRepairConfigSources`, asynchronous `selectRepairConfiguration`, and `RepairConfigSelection`. `entries` returns rebased `OwnedConfigEntry[]` per toolkit; `reads` covers source snapshots and absent candidates. Original state expected entries remain available separately during comparison.

- [ ] **Step 1: Add named config tests** `acceptsExactGeneratedFinalCommandPath`, `alreadyCurrentEntryNeedsNoEdit`, `rejectsPrefixSubstringAndSuffixLookalikes`, `rejectsMultiplePathSubstitutions`, `rejectsChangedExecutableAndOtherArguments`, `rejectsMissingExtraAndChangedFields`, `rejectsTypeEnabledAndUnknownFieldChanges`, `preservesJsoncCommentsAndUnrelatedBytes`, `rejectsDuplicateJsoncKeys`. Assertion examples: old value yields `assert.deepEqual(edits, [{ index: 2, before: oldPath, after: currentPath }])`; exact current value yields `assert.deepEqual(edits, [])`.
- [ ] **Step 2: Add async source selection tests** `oneCandidateOwnsAllEntries`, `splitOwnersFail`, `sameNameConflictFails`, `extraEmptyCandidateCoexistsWhenUnambiguous`, `unsupportedOnlyOwnerGuidesMigration`, `verifiedLoadedCompetitorFails`, `inactiveUnsupportedSourceIsPreserved`, `snapshotsEveryCandidateAndAbsence`, `neverReadsStaleConfigPath`. Explicitly verify returned reads and state expected-entry rebases. Assertion example: `assert.deepEqual(selection.reads.map(({ path }) => path), allCandidatePaths)` including absent paths; `assert.equal(selection.path, soleOwner.path)`.
- [ ] **Step 3: Run red focused tests.**

  Run: `bun run build && node --test dist/tests/config-relocation.test.js dist/tests/repair-config.test.js`.
  Expected: TypeScript compile fails on deliberately absent interfaces (or, after interface stubs, named assertions fail); fixtures never probe old paths.

- [ ] **Step 4: Implement JSONC final-index edit and asynchronous current-source selection.** Synchronous `listRepairConfigSources(target, env)` enumerates only Task 1's bounded candidates and evidence-backed observers. Async `selectRepairConfiguration(...)` snapshots all current relevant files/absence once; unique candidate owns every installed MCP entry. Unsupported observer never becomes owner; migration guidance applies to sole unsupported owner; verified-loaded competitor fails; inactive unsupported leftover remains untouched. Preserve original expected state for comparison; return rebased expected entries; never read stale `configPath`.
- [ ] **Step 5: Run green config tests.**

  Run: `bun run build && node --test dist/tests/config-relocation.test.js dist/tests/repair-config.test.js`.
  Expected: PASS, including exact path edit and all ownership/snapshot assertions.
- [ ] **Step 6: Commit:** `git add installer/src/config.ts installer/src/repair-config.ts tests/config-relocation.test.ts tests/repair-config.test.ts && git commit -m "feat: select relocated MCP configuration ownership"`.

### Task 4: Journal Barrier and Explicit Read-Only Observers

**Files:**
- Modify: `installer/src/transaction.ts`.
- Create: `tests/transaction-relocation.test.ts`.

**Interfaces:**
- Consumes Task 2 resource policy and current `ResourceSnapshot`, `TransactionRead`, `TransactionChange`, `TargetPaths`, fault hooks.
- Produces exact `Journal`, `validateJournalResources` and `TransactionOptions` / `applyTransaction` signatures listed in File Responsibilities. Keep current existing optional arguments in their existing order, options final.

- [ ] **Step 1: Add named journal tests** `preflightsWholeJournalBeforeAnyResourceSafetyCheck`, `rejectsMalformedSnapshotsBeforeSnapshot`, `rejectsOldRootJournalResourceBeforeAccess`, `rejectsJournalLockTempAndControlResources`, `permitsOnlyPolicyStateResource`, `preservesJournalAndDataOnUnsafeRecovery`, `inspectPendingJournalClassifiesSelectedJournalWithoutSnapshots`. Spy assertion example: `assert.equal(resourceSafetyCalls, 0)` after a malformed later journal record.
- [ ] **Step 2: Add named observer/race tests** `observerReadRevalidatedUnderLock`, `observerCannotAuthorizeMutation`, `observerCannotAuthorizeRecovery`, `arbitraryTransactionReadCannotBecomeObserver`, `absentCandidateAppearingBeforeApplyAborts`, `dryRunDoesNotLockOrRecover`, `recoveryFailureDoesNotFallThroughToPlan`. Snapshot expected values include absence. Assertion example: `await assert.rejects(applyWithChangedObserver(), /planning read changed/)`; assert no planned change targets observer.
- [ ] **Step 3: Add fault-boundary regression assertions** at each write boundary, before and after journal temp sync/publish, and third-party third-state edits; preserve existing test hooks and inherited parent FD behavior.
- [ ] **Step 4: Run red tests.**

  Run: `bun run build && node --test dist/tests/transaction-relocation.test.js dist/tests/installer-engine.test.js`.
  Expected: TypeScript compile fails on deliberately absent exports (or, after signatures are staged, preflight-order/observer assertions fail); pre-existing transaction regressions remain interpretable.

- [ ] **Step 5: Implement whole-journal validation first**, covering complete schema/snapshots and lexical resources before any resource safety/snapshot. Only after all entries pass, inspect current before/after images, then guarded restore. Export `inspectPendingJournal(target)` to read only the selected journal, validate complete schema/resources lexically, and return `'none' | 'pending'`; unsafe journals throw actionable error without snapshotting journal change resources. Engine supplies evidence-approved observers and rejects stale provenance; transaction validates observer paths as absolute/canonical, rejects control paths and mutation overlap, and revalidates observer snapshots under lock. Transaction cannot independently prove historical provenance without engine-supplied inputs. Reads never become changes/recovery authorization. Preserve inherited FD, fault hooks, third-state protection. Real failed recovery may alter current lock lifecycle; only promise journal/data unchanged.
- [ ] **Step 6: Run green transaction regression.**

  Run: `bun run build && node --test dist/tests/transaction-relocation.test.js dist/tests/installer-engine.test.js`.
  Expected: PASS; journal/data invariant holds, dry-run is inert, inherited lock/fault regressions pass.
- [ ] **Step 7: Commit:** `git add installer/src/transaction.ts tests/transaction-relocation.test.ts && git commit -m "fix: preflight transaction journal resources"`.

### Task 5: Update-Only Engine Orchestration

**Files:**
- Modify: `installer/src/installer-engine.ts`.
- Modify/test: `tests/installer-engine.test.ts`.

**Interfaces:**
- Consumes Task 2 proof/policy and Task 3 selector plus Task 4 transaction options.
- Produces `InstallerPlan.observerPaths: string[]`; complete verification/rebase plan; catalog payload/version update only for requested name(s); dry-run uses `inspectPendingJournal`. Engine constructs the evidence-backed observer list and rejects forbidden stale paths before passing it. Transaction validates explicit observer paths as absolute/canonical and revalidates snapshots only; it does not claim independent provenance proof.

- [ ] **Step 1: Add named engine tests** `requestedToolkitOnlyChangesPayloadAndVersion`, `allInstalledRecordsAreVerifiedAndRebased`, `unrequestedMissingCatalogIsPreserved`, `requestedMissingCatalogFails`, `requestedManifestAddRemoveChangesOnlyRequestedInventory`, `changedMissingHashModeOrUnownedCurrentFileConflicts`, `symlinkAndSpecialFileCurrentDestinationConflicts`, `duplicateMcpOwnershipAcrossRecordsFails`, `noMcpSkipsAllConfigIo`, `skillOnlyRebasesConfigPathWithoutConfigRead`, `configRenameUpdatesAllRecordMetadata`, `dryRunUsesPendingJournalClassification`. Assertion examples: `assert.equal(proposedState.toolkits.beta.version, oldVersion)`; `assert.equal(oldPathReads.length, 0)`; `assert.deepEqual(plan.changes.map(c => c.path), expectedCurrentPaths)`.
- [ ] **Step 2: Add explicit race assertions** `unchangedUnrequestedFileChangedBeforeApplyAborts`, `observerChangedBeforeApplyAborts`, `candidateAbsentToPresentBeforeApplyAborts`; assert `InstallerPlan.reads`/observer snapshots reflect all selected evidence and no planned write escapes current root. Assertion example: `await assert.rejects(engine.apply(plan), /planning read changed/)` after changing an unchanged owned file. Engine rejects observer paths lexically tied to forbidden stale provenance before transaction; transaction itself cannot infer that provenance.
- [ ] **Step 2a: Test MCP inventory transitions:** `requestedUpgradeIntroducesFirstMcp` selects the normal supported config/default when no installed entry exists, snapshots candidates/observers, and rejects an already-present unowned name; `requestedUpgradeRemovesMcp` validates old ownership before removing it. If either installed ownership or requested manifests contain MCP, configuration inspection is required. Only when both sets are empty may the engine skip config I/O. Apply normal requested manifest changes after validating installed ownership; retain narrow path-only edits for unchanged entries so relocation does not remove internal comments.
- [ ] **Step 3: Run red engine tests.**

  Run: `bun run build && node --test dist/tests/installer-engine.test.js`.
  Expected: new relocation assertions fail (or unresolved interface compile errors identify the missing implementation) without invalidating pre-existing install/uninstall/list cases.

- [ ] **Step 4: Implement update-only orchestration.** Verify current copies for every state record against stored hash/mode; derive current destinations only from validated relative paths. Use original expected config entries for exact matching then selected rebased entries for state. Catalog load only requested toolkit; unnamed update requests all. Validate every requested manifest path under positive namespace policy. Plan all changes atomically. Build and validate observer paths from Task 1/3 evidence before handoff; pass only canonical explicit read paths. Use `inspectPendingJournal(target)` for dry-run `recoveryPending`/summary; this inspects only selected journal schema/lexical resources, takes no lock, and snapshots no journal change resource. Real unsafe recovery still throws through transaction and never falls through. Preserve no-MCP no-config-read. Do not modify install/uninstall/list semantics.
- [ ] **Step 5: Run green engine regression.**

  Run: `bun run build && node --test dist/tests/installer-engine.test.js`.
  Expected: all old operation tests and new rebase/request/race tests pass.
- [ ] **Step 6: Commit:** `git add installer/src/installer-engine.ts tests/installer-engine.test.ts && git commit -m "feat: rebase owned toolkits during update"`.

### Task 6: IO Guard, Integration/CLI, and Documentation

**Files:**
- Create: `scripts/relocation-io-guard.mjs`, `tests/relocation-io.test.ts`.
- Modify: `package.json` `test:installer` to include compiled relocation/config/repair/transaction/IO suites; modify CLI/help as needed.
- Modify: README, `docs/architecture.md`, `docs/compatibility.md`, repository `AGENTS.md` narrow relocation line.
- Test: `tests/cli.test.ts` and new IO test.

**Interfaces:**
- Child-process guard wraps `node:fs` and `node:fs/promises` before dynamic installer import, calls `syncBuiltinESMExports`, tracks both rename operands and fd/handle provenance, excludes fixture setup/teardown. It is test-only, no production FS abstraction/dependency.
- `test:installer` must retain `toolkit-manifest`, `installer-engine`, `cli` and explicitly include `relocation`, `resource-policy`, `repair-config`, `config-relocation`, `transaction-relocation`, `relocation-io` compiled test files. Set the script to `bun run build && node --test dist/tests/toolkit-manifest.test.js dist/tests/installer-engine.test.js dist/tests/cli.test.js dist/tests/relocation.test.js dist/tests/resource-policy.test.js dist/tests/repair-config.test.js dist/tests/config-relocation.test.js dist/tests/transaction-relocation.test.js dist/tests/relocation-io.test.js`.

- [ ] **Step 1: Add named guard self-tests** `guardTripsOnReadFile`, `guardTripsOnLstatAccessOpenRealpathAndWrite`, `guardTracksBothRenameOperandsAndHandles`, `fixtureSetupIsOutsideObservation`. Each deliberately invokes the wrapped API and asserts guard record; only then test operation checks `assert.deepEqual(stalePathOperations, [])`.
- [ ] **Step 2: Add integration assertions** `projectRelocationOldTreePresentNoOldRead`, `projectRelocationOldTreeAbsent`, `globalRelocationSelectedScopeOnly`, `jsonAndJsoncCommentsPreserved`, `dryRunDirectoryLockJournalSnapshotEquality`, `unsafeJournalGuidanceIncludesJournalAndOffender`, `successPrintsRestartNotice`, `transactionFaultsKeepThirdStateGuarded`. Cover both configured path rename and same-root rename (same-root current access is permitted); overlapping-root cases remain gated, not falsely tested as zero access. Assertion examples: `assert.deepEqual(stalePathOperations, [])`; `assert.deepEqual(snapshotAfter, snapshotBefore)` for dry-run.
- [ ] **Step 3: Map spec tests 1–14:** Task 5 owns current verification/requested inventory; Task 6 owns IO, dry-run, CLI, lock and fault integration; Tasks 2–4 own proof/config/journal cases. Keep unknown precedence explicit, no fabricated fixtures.
- [ ] **Step 4: Run focused tests and prove red.**

  Run: `bun run build && node --test dist/tests/relocation-io.test.js dist/tests/cli.test.js`.
  Expected: before helper implementation its self-test fails on the missing guard; after helper lands, the tripwire self-test passes. Do not require a product regression if Task 5 behavior is already correct; end-to-end tests may already pass before docs/package wiring.

- [ ] **Step 5: Implement guard, package script, CLI and docs.** Unsafe journal uses existing CLI failure exit 1 and exact journal/offender/manual original-location guidance. Document explicit-scope update, requested-vs-all, conflict and unsupported migration, measured source boundary, dry-run, restart. Use writing-for-agents for repository AGENTS change; no consumer AGENTS or toolkit version change.
- [ ] **Step 6: Run new tests directly and full installer task command.**

  Run: `bun run build && node --test dist/tests/relocation-io.test.js dist/tests/cli.test.js && bun run test:installer`.
  Expected: PASS; test:installer visibly runs every new suite, guard catches tripwire and reports zero stale filesystem operations, dry-run exact equality, refused recovery preserves journal/data.
- [ ] **Step 7: Commit exact files:**

  ```sh
  git add scripts/relocation-io-guard.mjs tests/relocation-io.test.ts package.json tests/cli.test.ts README.md docs/architecture.md docs/compatibility.md installer/src/cli.ts AGENTS.md
  git commit -m "docs: explain safe toolkit relocation"
  ```

### Task 7: Full Acceptance and Parent-Owned Final Review

**Files:** Verify all Task 1–6 files. Inspect `npm pack --json --dry-run` listing for missing runtime files and accidental tests/evals/caches/planning artifacts.

**Interfaces:** Consume task outputs/evidence; report acceptance results and remaining prerequisite gaps. Parent owns final fresh read and acceptance command lane; do not duplicate runs unless inputs relevant to that check change.

- [ ] **Step 1: Verify prerequisites** Node 22+, Python 3.10+, Linux, util-linux `flock`, Bun, `uv`, `sshd`, `ssh-keygen`. Do not convert absence into success.
- [ ] **Step 2: Run CONTRIBUTING acceptance commands.**

  ```sh
  bun install --frozen-lockfile
  bun run build
  bun run test
  bun run validate
  bun run test:installer
  bun run test:package
  PYTHONDONTWRITEBYTECODE=1 uv run --isolated --python 3.13 --with 'mcp==2.2.0' python -m unittest discover -s toolkits/libvirt-toolkit/mcp/libvirt/tests -p 'test_*.py' -v
  bun run test:opencode:schema
  bun run test:opencode:discovery
  npm pack --json --dry-run
  ```

  Expected: commands exit 0; optional qemu-img skip may be visible. Schema needs HTTPS; discovery needs actual executable. Dedicated CI installs prerequisites and treats every nonzero including 77 as failure. Inspect package dry-run output.
- [ ] **Step 3: Report exact evidence, command results and unresolved gates to parent.** Do not report tests or versions run unless observed.
- [ ] **Step 4: Commit only approved final corrections; no plan-only commit unless parent directs it.**

## Spec Coverage Map

| Spec test | Tasks | Concrete assertion |
|---|---|---|
| 1 | 5, 6 | All records rebase; named payload/version alone changes; no stale read. |
| 2 | 3, 5, 6 | JSON/JSONC comments/unrelated values survive config rename. |
| 3 | 1, 5, 6 | Explicit XDG/HOME selected scope only. |
| 4 | 2, 5 | Malformed/mixed/traversal/duplicate/symlink/special/manifest conflict before writes. |
| 5 | 5 | Changed/missing/hash/mode/unowned current file conflicts; never copy old bytes. |
| 6 | 3 | Exact generated path only; changed args/fields, extras/missing fields, duplicate keys fail. |
| 7 | 1, 3, 5 | Unique owner, ambiguity, unsupported migration, verified competitor. |
| 8 | 1, 3, 5 | Only measured/versioned precedence sources receive override tests. |
| 9 | 5 | Unrequested missing catalog preserved; requested missing fails; requested inventory alone changes. |
| 10 | 2, 6 | Instrumentation proves zero stale filesystem calls and lexical traversal rejection. |
| 11 | 4, 6 | Dry-run exact snapshots; pending unsafe journal not recovered. |
| 12 | 4, 6 | Every write/journal boundary and third state preserves guarded rollback semantics. |
| 13 | 4, 6 | Inherited FD and Linux/flock behavior remains. |
| 14 | 1, 5, 6 | Scope, requested/all reporting, dry-run, migration/conflict, restart CLI. |

## Mandatory Scope Clarification Before Execution: Overlapping Roots

The selected state file must be read before its records can establish a historical root. If current selected state/config/file paths overlap the inferred previous tree, even initial `assertSafePath`/ancestor inspection may already access an old-root ancestor before proof. Therefore a post-proof reject does not satisfy a literal guarantee of zero previous-root filesystem accesses. Do not silently weaken safety checks, claim zero accesses, or treat a conservative reject after that initial read as resolving this. Parent/user must clarify whether the no-old-root guarantee applies to stale resource paths specifically or also to shared ancestors, and approve the corresponding bounded policy before execution. Same-root config rename is not stale-path access: current selected paths remain permitted. This gate is not a reason to stop drafting.

## Task-Level Adversarial Assertion Checklist

These concrete expectations supplement the named tests in each task; they are not permission to add architecture beyond the spec.

### Historical state and native paths (Task 2)

- Project config at `/work/project/opencode.json` implies payload root `/work/project/.opencode`; nested config at `/work/project/.opencode/opencode.jsonc` implies `/work/project/.opencode`.
- Global config `/home/user/.config/opencode/opencode.json` implies global payload root `/home/user/.config/opencode`; basename or extension lookalikes are rejected.
- Raw `/old/root/skills/name/file` may derive a relative path only after checking raw absolute syntax and strict root containment; raw `../escape`, embedded NUL and alias paths fail before normalization.
- A project root itself named `.opencode` that yields two valid layout interpretations must produce a diagnostic for ambiguous historical layout rather than silently choose one.
- An empty state returns identity roots (`previousPayloadRoot === target.payloadRoot`) and empty rebased records; a nonempty state whose every record has no installed file inventory does not gain a root from config directory names alone.
- Skill-only state rebases `configPath` lexically from historical layout; tests instrument config path and assert zero read/open calls.
- A historical toolkit absent from current catalog remains valid from state inventory; current requested manifest absence fails only in update orchestration.
- Manifest destination validation and state inventory validation share the four positive namespace families; arbitrary assets are not automatically ownership-eligible.
- MCP entrypoint is accepted only if its final generated path is a strict descendant of the toolkit's own managed subtree and is accounted for by that toolkit's inventory.
- For every malformed state test, assert no filesystem calls are made by `proveHistoricalRoot`; helper stays pure by construction.

### Config matching and source evidence (Tasks 1 and 3)

- `CommandPathEdit` contains only `{ index, before, after }`; every emitted edit index equals `actual.command.length - 1` for the generated final entrypoint.
- Old-root prefix must end at a path boundary and preserve the complete suffix exactly. `/old/managed-other` does not match `/old/managed`; a substring embedded in another argument does not match.
- A command array with a current final entrypoint and unchanged non-final arguments is accepted as no-op; reject attempted multiple substitutions or any modification of another argument. An unchanged non-final argument that happens to contain old-root text is not itself a substitution and is compared exactly.
- Removing/adding a config field, changing executable/arguments, `type`, `enabled`, unknown field, array shape, or duplicate JSONC key fails before edit.
- JSONC assertion compares comments and unrelated source regions before/after; only targeted managed path value may differ.
- The config source table records exact candidate path, source role/evidence id, actual OpenCode release/version, exact command, and whether the result was documented, source inspected, or measured.
- Absence snapshots count as evidence: if a candidate is absent during plan and appears before transaction, apply fails with a changed-read conflict.
- Verified-loaded observer conflict is distinct from unsupported-only owner. Observer can fail the repair but can never become destination or grant arbitrary transaction resource access.
- If unsupported source ownership is sole evidence, report migration guidance, leave that file intact, and require manual merge into a supported candidate before retry.

### Journal and observer barrier (Task 4)

- Build an adversarial journal whose first change path is valid and last change malformed; assert zero calls to resource safety or snapshot on the first path.
- Build a valid-schema journal with an old path and an extant old directory; assert no open/stat/lstat/access/realpath/write reaches that resource and journal bytes/data bytes remain unchanged.
- Build a journal entry targeting each control namespace (journal, lock, transaction temporary); assert rejection before resource snapshots.
- A journal targeting a path classified `state` is permitted only by explicit resource policy and still receives normal current-target safety and before/after snapshot checks.
- A malformed or third-state recovery rejects and throws before engine plan generation; the CLI must not report success or create a new repair journal.
- A locked failed recovery may have current lock lifecycle writes; tests must assert journal and payload/config data unchanged rather than claiming absolutely no current lock side effects.
- Dry-run tests snapshot candidate directories, state, payload, config, lock and journal before/after; assert exact structural/byte equality and no lock acquisition. Journal classification reads only the selected journal itself; it does not snapshot any journal change resource.
- Observer path list is validated when passed and again snapshots are revalidated under lock. Supplying a read at an observer path cannot add a `TransactionChange` or authorize journal recovery.

### Update orchestration and filesystem integration (Tasks 5 and 6)

- Relocation update for two records with one named request: compare all old/new state records; only requested record's version and inventory change, while both records' absolute ownership paths rebase.
- Leave original tree present with sentinel and IO guard; assert zero stale resource path calls. Repeat after deleting old tree; both operations use only current inventory and state.
- Change an unrequested current file after planning; apply must fail its `TransactionRead` check, not silently leave state claiming the verified old snapshot.
- Change an observer between plan/apply; apply aborts with no mutation.
- A symlinked current parent and a special-file current destination both conflict; they are current-target tests, not probes against historical root.
- A byte-for-byte unchanged unsupported config source remains untouched after supported owner is repaired; no file deletion or replacement is planned for it.
- Explicit scope never mutates another scope. It reads other-scope config only when Task 1 evidence proves that source is relevant and Task 3 lists it as a bounded observer; in candidate-only fallback mode no other-scope source is read. Compare full temp-root snapshots for writes and instrument every permitted observer read.
- Inject failure after each write and at journal temp-synced/published hooks. Where resource remains before/after, guarded rollback returns bytes/modes; where third state exists, refuse restore and retain actionable journal.
- On success assert explicit restart notice. On unsafe journal assert exit status 1, exact journal path, offending resource, and manual original-location recovery guidance.
- Package test script includes every new compiled suite directly; running `bun run test:installer` must show test counts for IO guard, relocation proof, resource policy, repair config, config edits and journal preflight.

### Red/Green Command Ledger

Run each focused command once at the task's red stage and again after implementation; expected red is a missing export/compile error or the named assertion failure, never an unrelated setup error. The green command must exit zero.

| Task | Red and green command | Green proves |
|---|---|---|
| 1 | `bun run build && node --test dist/tests/opencode-config-matrix.test.js` | Matrix fixture/schema compiles and candidate cases are enumerated. |
| 1 actual evidence | `node scripts/check-opencode-config-matrix.mjs --opencode /absolute/path/to/tested/opencode` | Actual binary/version and measured isolated outcomes are recorded. |
| 2 | `bun run build && node --test dist/tests/relocation.test.js dist/tests/resource-policy.test.js` | Pure historical proof and positive namespace policy pass. |
| 2 state regression | `bun run build && node --test dist/tests/installer-engine.test.js` | Existing valid format-1 install/uninstall/list state fixtures still work. |
| 3 | `bun run build && node --test dist/tests/config-relocation.test.js dist/tests/repair-config.test.js` | Exact path-index edits and async source snapshot ownership pass. |
| 4 | `bun run build && node --test dist/tests/transaction-relocation.test.js` | Journal validation barrier and observer revalidation pass. |
| 5 | `bun run build && node --test dist/tests/installer-engine.test.js` | Update behavior is atomic and requested-vs-unrequested handling is correct. |
| 6 | `bun run build && node --test dist/tests/relocation-io.test.js dist/tests/cli.test.js` | Child process catches tripwire; CLI and stale-path integration assertions pass. |
| 6 package | `bun run test:installer` | Package script executes existing and every new focused suite. |

For TypeScript tests importing newly added exports, a build-time missing-export failure is the intentionally red result. Do not describe that as runtime assertion coverage; after implementing the interface, execute the same command and require Node test assertions to pass.

### Diagnostic and non-mutation assertions

- Historical-root failure identifies that ownership/root proof is unavailable and recommends manual recovery/migration; it does not suggest editing old state to force a guess.
- Config conflicts identify all relevant candidate paths and the managed name; remediation says select/merge one supported config manually, not that installer will merge arbitrary values.
- Unsupported-only ownership names observed source and migration direction; inactive unsupported source is never read as a mutation destination or deleted.
- Journal errors include selected journal and exact offender plus manual original-location recovery instructions; no dedicated exit code is invented (existing CLI failure exit remains 1).
- Current content mismatch errors distinguish missing, changed hash/mode, symlink/special-file and unowned destination; none imply restoration from old tree.
- An absent candidate read is retained as `{ exists: false }` expectation; current candidate created before lock revalidation aborts.
- Observer change between plan and lock aborts before journal publication; verify `afterJournalPublished` hook was not reached for this precondition failure.
- Unsafe journal dry-run reports pending/unsafe state without taking lock, snapshotting journal change resources or writing recovery changes; reading the selected journal for lexical validation is permitted.
- Every successful mutating CLI test asserts restart notice and exactly one selected scope; dry-run tests assert no restart-success claim.
- Verify every native payload path is strictly below current payload root; toolkit asset paths additionally stay below the managed root/own-toolkit subtree. Root itself is never a file destination.
- Assert no source manifest scan occurs for unrequested installed names, even if catalog includes them; state is authority for installed inventory.
- Assert requested update with no explicit names loads current manifests for all state entries; explicit request set is exact, not prefix or namespace matching.
- State format number remains `1` in all generated state and round-trip tests; no migration/version bump appears.
- No CLI argument changes or implicit target discovery are included. Transaction changes remain within selected target; source reads may include only independently proven Task 1/3 observers. Candidate-only fallback reads no other scope.
- Documentation reports measured release/version and bounded candidate policy, not a universal OpenCode precedence guarantee.
- Package dry-run excludes new test-only harness as runtime artifact unless existing package inclusion intentionally requires it; inspect rather than assume packaging behavior.

## Review and Execution Handoff

Before implementation, parent confirms this revision, the root-proof ambiguity review gate, and the overlapping-root scope clarification. If either scope fact remains unresolved, stop before execution; do not invent an allowlist, candidate, or unsupported-path workaround. During execution, each commit should contain one independently tested deliverable, and each change should receive a fresh review before dependent tasks proceed.
