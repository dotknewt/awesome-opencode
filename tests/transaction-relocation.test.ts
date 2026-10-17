import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";

import {
  applyTransaction, contentSnapshot, inspectPendingJournal, snapshot,
  validateJournalResources,
  type ResourceSnapshot, type TransactionChange, type TransactionRead,
} from "../installer/src/transaction.js";
import type { TargetPaths } from "../installer/src/target.js";

async function fixture(run: (target: TargetPaths, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp("/tmp/opencode/transaction-relocation-");
  const payloadRoot = path.join(root, ".opencode");
  const stateRoot = path.join(payloadRoot, "awesome-opencode");
  await mkdir(stateRoot, { recursive: true });
  const target: TargetPaths = {
    scope: "project", payloadRoot, managedRoot: path.join(stateRoot, "toolkits"), stateRoot,
    statePath: path.join(stateRoot, "state.json"), journalPath: path.join(stateRoot, "journal.json"),
    lockPath: path.join(stateRoot, "lock"), configPath: path.join(root, "opencode.json"),
    configCandidates: [path.join(root, "opencode.json"), path.join(root, "opencode.jsonc"), path.join(payloadRoot, "opencode.json"), path.join(payloadRoot, "opencode.jsonc")],
    defaultConfigPath: path.join(root, "opencode.json"),
  };
  try { await run(target, root); } finally { await rm(root, { recursive: true, force: true }); }
}

const missing: ResourceSnapshot = { exists: false };
function change(file: string, before: ResourceSnapshot, after: ResourceSnapshot): TransactionChange {
  return { path: file, before, after, description: "relocation test" };
}
const bytes = (value: string) => contentSnapshot(value, 0o600, true);
const snapshotForTest = (file: string) => snapshot(file, true);
async function journal(target: TargetPaths, changes: TransactionChange[]): Promise<void> {
  await writeFile(target.journalPath, JSON.stringify({ formatVersion: 1, changes }));
}
async function rawJournal(target: TargetPaths, value: unknown): Promise<void> {
  await writeFile(target.journalPath, JSON.stringify(value));
}

async function countResourceProbes<T>(resourcePaths: string[], run: () => Promise<T>): Promise<{ value: T; probes: string[] }> {
  const methods = ["lstat", "stat", "open", "readFile", "access"] as const;
  const originals = new Map<string, (...args: any[]) => any>();
  const probes: string[] = [];
  for (const method of methods) {
    const original = fsPromises[method] as (...args: any[]) => any;
    originals.set(method, original);
    (fsPromises as any)[method] = function (filePath: unknown, ...args: unknown[]) {
      const candidate = typeof filePath === "string" ? filePath : filePath instanceof URL ? filePath.pathname : "";
      if (resourcePaths.includes(candidate)) probes.push(`${method}:${candidate}`);
      return original.call(fsPromises, filePath, ...args);
    };
  }
  syncBuiltinESMExports();
  try { return { value: await run(), probes }; }
  finally {
    for (const [method, original] of originals) (fsPromises as any)[method] = original;
    syncBuiltinESMExports();
  }
}

function assertDiagnostic(error: Error, fragments: string[]): void {
  for (const fragment of fragments) assert.ok(error.message.toLowerCase().includes(fragment.toLowerCase()), `expected diagnostic to include ${fragment}: ${error.message}`);
}

test("preflightsWholeJournalBeforeAnyResourceSafetyCheck", async () => fixture(async (target) => {
  const valid = change(path.join(target.payloadRoot, "skills", "demo", "SKILL.md"), missing, bytes("after"));
  const malformed = { ...valid, path: path.join(target.payloadRoot, "skills", "demo", "later.md"), before: { exists: true, encoding: "base64", content: "%%%", mode: 0o100000 } } as unknown as TransactionChange;
  await journal(target, [valid, malformed]);
  const { probes } = await countResourceProbes([valid.path, malformed.path], async () => {
    await assert.rejects(applyTransaction(target, [], []));
  });
  assert.deepEqual(probes, []);
}));

test("rejectsMalformedSnapshotsBeforeSnapshot", async () => fixture(async (target) => {
  const file = path.join(target.payloadRoot, "skills", "demo", "SKILL.md");
  await journal(target, [{ ...change(file, missing, bytes("x")), before: { exists: true, encoding: "wat", content: "x", mode: -1 } } as unknown as TransactionChange]);
  const { probes } = await countResourceProbes([file], async () => assert.rejects(inspectPendingJournal(target)));
  assert.deepEqual(probes, []);
  const journalBefore = await readFile(target.journalPath, "utf8");
  await assert.rejects(applyTransaction(target, [], []), (error: Error) => {
    assertDiagnostic(error, [target.journalPath, file, "snapshot", "inspect", "recover", "original"]);
    return true;
  });
  assert.equal(await readFile(target.journalPath, "utf8"), journalBefore);
  await assert.rejects(readFile(file));
}));

test("malformedJournalChangeDiagnosticsRetainKnownResourceWithoutProbes", async () => fixture(async (target) => {
  const file = path.join(target.payloadRoot, "skills", "demo", "SKILL.md");
  const valid = change(file, missing, bytes("x"));
  for (const changeRecord of [
    { path: file, before: valid.before, after: valid.after },
    { ...valid, undocumented: true },
  ]) {
    await rawJournal(target, { formatVersion: 1, changes: [changeRecord] });
    const journalBefore = await readFile(target.journalPath, "utf8");
    const { probes } = await countResourceProbes([file], async () => assert.rejects(inspectPendingJournal(target), (error: Error) => {
      assertDiagnostic(error, [target.journalPath, file, "malformed", "inspect", "resolve"]);
      return true;
    }));
    assert.deepEqual(probes, []);
    assert.equal(await readFile(target.journalPath, "utf8"), journalBefore);
    await assert.rejects(readFile(file));
    await rm(target.journalPath, { force: true });
  }
}));

test("malformedJsonJournalDiagnosticNamesSelectedJournalAndManualRecovery", async () => fixture(async (target) => {
  await writeFile(target.journalPath, "{");
  const journalBefore = await readFile(target.journalPath, "utf8");
  const { probes } = await countResourceProbes([], async () => assert.rejects(inspectPendingJournal(target), (error: Error) => {
    assertDiagnostic(error, [target.journalPath, "JSON", "inspect", "resolve", "original"]);
    return true;
  }));
  assert.deepEqual(probes, []);
  assert.equal(await readFile(target.journalPath, "utf8"), journalBefore);
}));

test("selectedJournalSymlinkDiagnosticsPreserveLinkAndTarget", async () => fixture(async (target, root) => {
  const outside = path.join(root, "outside-journal-data.json");
  await writeFile(outside, "do-not-touch");
  await symlink(outside, target.journalPath);
  const journalLinkBefore = await fsPromises.lstat(target.journalPath);
  await assert.rejects(inspectPendingJournal(target), (error: Error) => {
    assertDiagnostic(error, [target.journalPath, "symlink", "inspect", "resolve", "original"]);
    return true;
  });
  await assert.rejects(applyTransaction(target, [], []), (error: Error) => {
    assertDiagnostic(error, [target.journalPath, "symlink", "inspect", "resolve", "original"]);
    return true;
  });
  assert.equal((await fsPromises.lstat(target.journalPath)).ino, journalLinkBefore.ino);
  assert.equal((await fsPromises.lstat(target.journalPath)).isSymbolicLink(), true);
  assert.equal(await readFile(outside, "utf8"), "do-not-touch");
}));

test("rejectsOldRootJournalResourceBeforeAccess", async () => fixture(async (target, root) => {
  const old = path.join(root, "old", ".opencode", "skills", "demo", "SKILL.md");
  const record = change(old, missing, bytes("stale")); await journal(target, [record]);
  const journalBefore = await readFile(target.journalPath, "utf8");
  const { probes } = await countResourceProbes([old], async () => assert.rejects(inspectPendingJournal(target), (error: Error) => {
    assertDiagnostic(error, [target.journalPath, old, "authorized", "original", "resolve"]);
    return true;
  }));
  assert.deepEqual(probes, []);
  assert.equal(await readFile(target.journalPath, "utf8"), journalBefore);
}));

test("rejectsJournalLockTempAndControlResources", async () => fixture(async (target) => {
  for (const file of [target.journalPath, target.lockPath, `${target.statePath}.bak`, `${target.journalPath}.123-abc.tmp`]) {
    assert.throws(() => validateJournalResources({ formatVersion: 1, changes: [change(file, missing, bytes("x"))] }, target));
  }
}));

test("rejectsDuplicatePrefixAndNoncanonicalSnapshotRecords", async () => fixture(async (target) => {
  const first = path.join(target.payloadRoot, "skills", "demo", "SKILL.md");
  const child = `${first}/child`;
  const sibling = path.join(target.payloadRoot, "skills", "demo", "SKILL.md-old");
  for (const changes of [
    [change(first, missing, bytes("x")), change(first, missing, bytes("y"))],
    [change(first, missing, bytes("x")), change(child, missing, bytes("y"))],
    [change(first, missing, bytes("x")), change(sibling, missing, bytes("y")), change(child, missing, bytes("z"))],
    [{ ...change(first, missing, bytes("x")), after: { exists: true, encoding: "base64", content: "%%%", mode: 0o600 } } as TransactionChange],
  ]) {
    await journal(target, changes);
    const { probes } = await countResourceProbes([first, child], async () => assert.rejects(applyTransaction(target, [], [])));
    assert.deepEqual(probes, []);
    await rm(target.journalPath, { force: true });
  }
}));

test("rejectsDuplicateAndNonAdjacentPrefixMutationInputsBeforeAccess", async () => fixture(async (target) => {
  const first = path.join(target.payloadRoot, "skills", "demo", "SKILL.md");
  const sibling = path.join(target.payloadRoot, "skills", "demo", "SKILL.md-old");
  const child = `${first}/child`;
  for (const changes of [
    [change(first, missing, bytes("x")), change(first, missing, bytes("y"))],
    [change(first, missing, bytes("x")), change(sibling, missing, bytes("y")), change(child, missing, bytes("z"))],
  ]) {
    await assert.rejects(applyTransaction(target, changes), /duplicate or prefix-colliding/);
    await assert.rejects(readFile(first));
    await assert.rejects(readFile(sibling));
    await assert.rejects(readFile(child));
  }
}));

test("permitsOnlyPolicyStateResource", async () => fixture(async (target) => {
  assert.doesNotThrow(() => validateJournalResources({ formatVersion: 1, changes: [change(target.statePath, missing, bytes("state"))] }, target));
  assert.throws(() => validateJournalResources({ formatVersion: 1, changes: [change(path.join(target.stateRoot, "arbitrary.json"), missing, bytes("x"))] }, target));
}));

test("preservesJournalAndDataOnUnsafeRecovery", async () => fixture(async (target) => {
  const file = path.join(target.payloadRoot, "skills", "demo", "SKILL.md");
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "third-party");
  const record = change(file, missing, bytes("transaction")); await journal(target, [record]);
  const originalJournal = await readFile(target.journalPath, "utf8");
  const { probes } = await countResourceProbes([file], async () => assert.rejects(applyTransaction(target, [], []), (error: Error) => {
    assertDiagnostic(error, [target.journalPath, file, "intervening", "inspect", "resolve"]);
    return true;
  }));
  assert.ok(probes.some((probe) => probe.endsWith(file)), "third-state recovery must inspect the current resource");
  assert.equal(await readFile(target.journalPath, "utf8"), originalJournal);
  assert.equal(await readFile(file, "utf8"), "third-party");
}));

test("recoveryPathSafetyFailuresKeepJournalResourceAndManualGuidance", async () => fixture(async (target, root) => {
  const resource = path.join(target.payloadRoot, "skills", "demo", "SKILL.md");
  const external = path.join(root, "outside-data.txt");
  await mkdir(path.dirname(resource), { recursive: true });
  await writeFile(external, "external-data");
  const record = change(resource, missing, bytes("transaction"));
  for (const kind of ["directory", "symlink"] as const) {
    await rm(resource, { recursive: true, force: true });
    if (kind === "directory") await mkdir(resource);
    else await symlink(external, resource);
    await journal(target, [record]);
    const journalBefore = await readFile(target.journalPath, "utf8");
    const expectedReason = kind === "directory" ? "non-regular" : "symlink";
    await assert.rejects(applyTransaction(target, [], []), (error: Error) => {
      assertDiagnostic(error, [target.journalPath, resource, expectedReason, "inspect", "resolve", "original"]);
      return true;
    });
    assert.equal(await readFile(target.journalPath, "utf8"), journalBefore);
    assert.equal(await readFile(external, "utf8"), "external-data");
    if (kind === "directory") assert.equal((await fsPromises.lstat(resource)).isDirectory(), true);
    else assert.equal((await fsPromises.lstat(resource)).isSymbolicLink(), true);
    await rm(target.journalPath, { force: true });
  }
}));

test("inspectPendingJournalClassifiesSelectedJournalWithoutSnapshots", async () => fixture(async (target) => {
  assert.equal(await inspectPendingJournal(target), "none");
  await journal(target, [change(path.join(target.payloadRoot, "skills", "demo", "SKILL.md"), missing, bytes("x"))]);
  assert.equal(await inspectPendingJournal(target), "pending");
  const resource = path.join(target.payloadRoot, "skills", "demo", "SKILL.md");
  const { value, probes } = await countResourceProbes([resource], () => inspectPendingJournal(target));
  assert.equal(value, "pending");
  assert.deepEqual(probes, []);
}));

test("observerReadRevalidatedUnderLock", async () => fixture(async (target) => {
  const observed = path.join(target.payloadRoot, "loaded.json");
  const planned = path.join(target.payloadRoot, "skills", "other", "SKILL.md");
  const read: TransactionRead = { path: observed, expected: missing, description: "candidate absence" };
  const writes = [change(planned, missing, bytes("new"))];
  await mkdir(path.dirname(observed), { recursive: true });
  await assert.rejects(applyTransaction(target, writes, [read], { pauseAfterLock: async () => writeFile(observed, "appeared") }, { observerPaths: [observed] }), /planning read changed/);
  await assert.rejects(readFile(planned));
}));

test("observerCannotAuthorizeMutation", async () => fixture(async (target) => {
  const observed = path.join(target.payloadRoot, "loaded.json");
  await assert.rejects(applyTransaction(target, [change(observed, missing, bytes("write"))], [], {}, { observerPaths: [observed] }));
  await assert.rejects(readFile(observed));
}));

test("rejectsLockSuffixObserversBeforeAcquisitionWithoutChangingControls", async () => fixture(async (target) => {
  for (const suffix of ["", ".os", ".reclaim", ".legacy"]) {
    const control = `${target.lockPath}${suffix}`;
    for (const existing of [false, true]) {
      await rm(control, { recursive: true, force: true });
      if (existing) {
        const content = suffix === ".reclaim"
          ? JSON.stringify({ pid: 999999999, token: "stale-owner", createdAt: "2026-10-17T00:00:00.000Z" })
          : "pre-existing-os-lock";
        await writeFile(control, content);
      }
      const before = await Promise.all([snapshotForTest(control), snapshotForTest(target.lockPath)]);
      await assert.rejects(applyTransaction(target, [], [], {}, { observerPaths: [control] }), /observer|control/i);
      assert.deepEqual(await Promise.all([snapshotForTest(control), snapshotForTest(target.lockPath)]), before);
    }
  }
}));

test("observerCannotOverlapAuthorizedNativeMutation", async () => fixture(async (target) => {
  const native = path.join(target.payloadRoot, "skills", "demo", "SKILL.md");
  await assert.rejects(applyTransaction(target, [change(native, missing, bytes("write"))], [], {}, { observerPaths: [native] }), /overlap/i);
  await assert.rejects(readFile(native));
  await assert.rejects(readFile(`${target.lockPath}.os`));
}));

test("observerCannotAuthorizeRecovery", async () => fixture(async (target) => {
  const observed = path.join(target.payloadRoot, "loaded.json");
  await journal(target, [change(observed, missing, bytes("stale"))]);
  await assert.rejects(applyTransaction(target, [], [], {}, { observerPaths: [observed] }));
  assert.equal((await readFile(target.journalPath, "utf8")).includes(observed), true);
  await assert.rejects(readFile(observed));
}));

test("unchangedOutOfPolicyObserverCanGuardDistinctMutation", async () => fixture(async (target) => {
  const observed = path.join(target.payloadRoot, "loaded.json");
  await writeFile(observed, "loaded");
  const expected = await snapshotForTest(observed);
  const planned = path.join(target.payloadRoot, "skills", "demo", "SKILL.md");
  await applyTransaction(target, [change(planned, missing, bytes("installed"))], [{ path: observed, expected, description: "loaded config evidence" }], {}, { observerPaths: [observed] });
  assert.equal(await readFile(planned, "utf8"), "installed");
  assert.equal(await readFile(observed, "utf8"), "loaded");
}));

test("arbitraryTransactionReadCannotBecomeObserver", async () => fixture(async (target) => {
  const outside = path.join(target.payloadRoot, "arbitrary", "file");
  await assert.rejects(applyTransaction(target, [], [{ path: outside, expected: missing, description: "unapproved" }]));
  await assert.rejects(readFile(outside));
}));

test("absentCandidateAppearingBeforeApplyAborts", async () => fixture(async (target) => {
  const candidate = target.configCandidates[1]!;
  const planned = change(path.join(target.payloadRoot, "skills", "demo", "SKILL.md"), missing, bytes("owned"));
  await assert.rejects(applyTransaction(target, [planned], [{ path: candidate, expected: missing, description: "unused config candidate" }], {
    pauseAfterLock: async () => writeFile(candidate, "racer"),
  }), /planning read changed/);
  assert.equal(await readFile(candidate, "utf8"), "racer");
  await assert.rejects(readFile(planned.path));
}));

test("dryRunDoesNotLockOrRecover", async () => fixture(async (target) => {
  await journal(target, [change(path.join(target.payloadRoot, "skills", "demo", "SKILL.md"), missing, bytes("stale"))]);
  const before = await readFile(target.journalPath, "utf8");
  assert.equal(await inspectPendingJournal(target), "pending");
  assert.equal(await readFile(target.journalPath, "utf8"), before);
  await assert.rejects(readFile(`${target.lockPath}.os`));
}));

test("recoveryFailureDoesNotFallThroughToPlan", async () => fixture(async (target) => {
  const resource = path.join(target.payloadRoot, "skills", "demo", "SKILL.md");
  await mkdir(path.dirname(resource), { recursive: true }); await writeFile(resource, "unexpected");
  await journal(target, [change(resource, missing, bytes("stale"))]);
  await assert.rejects(applyTransaction(target, [change(path.join(target.payloadRoot, "skills", "next", "SKILL.md"), missing, bytes("planned"))]));
  await assert.rejects(readFile(path.join(target.payloadRoot, "skills", "next", "SKILL.md")));
  assert.equal(await readFile(resource, "utf8"), "unexpected");
}));

test("faultBoundariesRetainJournalForSafeRecoveryAndProtectThirdState", async () => fixture(async (target) => {
  const file = path.join(target.payloadRoot, "skills", "demo", "SKILL.md");
  const planned = change(file, missing, bytes("ours"));
  await assert.rejects(applyTransaction(target, [planned], [], { afterJournalTempSynced: async () => { throw new Error("temp boundary"); } }), /temp boundary/);
  assert.equal(await inspectPendingJournal(target), "none");
  await assert.rejects(applyTransaction(target, [planned], [], { afterJournalPublished: async () => { throw new Error("publish boundary"); } }), /publish boundary/);
  assert.equal(await inspectPendingJournal(target), "pending");
  await assert.rejects(readFile(file));
  await applyTransaction(target, [], []);
  assert.equal(await inspectPendingJournal(target), "none");
  await assert.rejects(applyTransaction(target, [planned], [], {
    afterWrite: async () => writeFile(file, "third-party"), failAfterWrites: 1,
  }), /intervening edit|rollback refused/);
  assert.equal(await readFile(file, "utf8"), "third-party");
}));

test("writeFailureRestoresEarlierWritesAndRemovesJournal", async () => fixture(async (target) => {
  const first = path.join(target.payloadRoot, "skills", "first", "SKILL.md");
  const second = path.join(target.payloadRoot, "skills", "second", "SKILL.md");
  const changes = [change(first, missing, bytes("one")), change(second, missing, bytes("two"))];
  for (const boundary of [1, 2]) {
    await assert.rejects(applyTransaction(target, changes, [], { failAfterWrites: boundary }), /injected transaction failure/);
    await assert.rejects(readFile(first));
    await assert.rejects(readFile(second));
    assert.equal(await inspectPendingJournal(target), "none");
  }
}));
