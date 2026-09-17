import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { assertSafePath, ensureSafeParents, fsyncDirectory } from "./path-safety.js";
import { hashContent } from "./payload.js";
import type { TargetPaths } from "./target.js";

export interface ResourceSnapshot {
  exists: boolean;
  content?: string;
  encoding?: "base64" | "utf8";
  mode?: number;
}

export interface TransactionRead {
  path: string;
  expected: ResourceSnapshot;
  description: string;
}

export interface TransactionChange {
  path: string;
  before: ResourceSnapshot;
  after: ResourceSnapshot;
  description: string;
}

interface Journal {
  formatVersion: 1;
  changes: TransactionChange[];
}

interface LockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

interface LockHandle {
  file: FileHandle;
  token: string;
}

export interface TransactionFaults {
  failAfterWrites?: number;
  interruptAfterWrites?: number;
  pauseAfterLock?: () => Promise<void>;
  afterWrite?: (count: number, filePath: string) => Promise<void>;
  afterJournalTempSynced?: () => Promise<void>;
  afterJournalPublished?: () => Promise<void>;
  onStaleLockObserved?: () => Promise<void>;
  failPostFlockSetup?: boolean;
  beforeResourceRename?: (filePath: string, temporaryPath: string) => Promise<void>;
}

export class InterruptedTransactionError extends Error {}

function assertAllowedResource(target: TargetPaths, filePath: string): void {
  const resolved = path.resolve(filePath);
  const payloadRoot = path.resolve(target.payloadRoot);
  const allowedConfig = target.configCandidates.some((candidate) => path.resolve(candidate) === resolved);
  if (!allowedConfig && !resolved.startsWith(`${payloadRoot}${path.sep}`)) throw new Error(`transaction resource escapes target: ${filePath}`);
}

export async function snapshot(filePath: string, text = false): Promise<ResourceSnapshot> {
  const kind = await assertSafePath(filePath, "any");
  if (kind === "missing") return { exists: false };
  if (kind !== "file") throw new Error(`refusing non-regular resource: ${filePath}`);
  const handle = await open(filePath, "r");
  try {
    const opened = await handle.stat();
    await assertSafePath(filePath, "file");
    const current = await lstat(filePath);
    if (opened.dev !== current.dev || opened.ino !== current.ino) throw new Error(`resource changed while opening: ${filePath}`);
    const content = await handle.readFile();
    return { exists: true, content: text ? content.toString("utf8") : content.toString("base64"), encoding: text ? "utf8" : "base64", mode: opened.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

function sameSnapshot(left: ResourceSnapshot, right: ResourceSnapshot): boolean {
  return left.exists === right.exists && left.content === right.content && left.encoding === right.encoding && left.mode === right.mode;
}

async function durableRemove(filePath: string): Promise<void> {
  const kind = await assertSafePath(filePath, "any");
  if (kind === "missing") return;
  if (kind !== "file") throw new Error(`refusing to delete non-regular resource: ${filePath}`);
  await assertSafePath(path.dirname(filePath), "directory");
  await rm(filePath);
  await fsyncDirectory(path.dirname(filePath));
}

async function durableReplace(
  filePath: string,
  content: Buffer,
  mode: number,
  beforeRename?: (filePath: string, temporaryPath: string) => Promise<void>,
): Promise<void> {
  await ensureSafeParents(filePath);
  const existing = await assertSafePath(filePath, "any");
  if (existing === "directory") throw new Error(`refusing to replace directory resource: ${filePath}`);
  const temporary = `${filePath}.awesome-opencode-${process.pid}-${randomUUID()}.tmp`;
  const parent = path.dirname(filePath);
  let temporaryCreated = false;
  let renamed = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(content);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertSafePath(parent, "directory");
    if (beforeRename) await beforeRename(filePath, temporary);
    await rename(temporary, filePath);
    renamed = true;
    await fsyncDirectory(parent);
  } finally {
    if (temporaryCreated && !renamed) {
      try {
        await rm(temporary, { force: true });
        await fsyncDirectory(parent);
      } catch {
        // Preserve the original write failure; never remove anything except this invocation's temporary.
      }
    }
  }
}

async function restore(filePath: string, value: ResourceSnapshot, faults: TransactionFaults = {}): Promise<void> {
  await assertSafePath(path.dirname(filePath), "directory");
  if (!value.exists) {
    await durableRemove(filePath);
    return;
  }
  const content = value.encoding === "base64" ? Buffer.from(value.content ?? "", "base64") : Buffer.from(value.content ?? "", "utf8");
  await durableReplace(filePath, content, value.mode ?? 0o600, faults.beforeResourceRename);
}

async function writePrivateFile(filePath: string, content: string): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function parseLockOwner(ownerPath: string): Promise<LockOwner> {
  const owner = await snapshot(ownerPath, true);
  if (!owner.exists) throw new Error(`target lock ownership is missing: ${ownerPath}`);
  const value = JSON.parse(owner.content ?? "") as Partial<LockOwner>;
  if (!Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0 || typeof value.token !== "string" || !value.token) {
    throw new Error(`target lock ownership is malformed: ${ownerPath}`);
  }
  return value as LockOwner;
}

function processIsLive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

async function applyInheritedFlock(file: FileHandle): Promise<void> {
  const child = spawn("flock", ["--exclusive", "--nonblock", "3"], {
    stdio: ["ignore", "ignore", "pipe", file.fd],
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", (error) => {
      reject((error as NodeJS.ErrnoException).code === "ENOENT"
        ? new Error("OS-backed locking requires the util-linux flock executable")
        : error);
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (result.code === 1) throw new Error("target is locked by another live installer process");
  if (result.code !== 0) {
    throw new Error(`flock failed to acquire target lock: code=${result.code} signal=${result.signal} ${stderr}`.trim());
  }
}

async function startFlock(lockFile: string, faults: TransactionFaults): Promise<FileHandle> {
  await ensureSafeParents(lockFile);
  const existing = await assertSafePath(lockFile, "any");
  if (existing === "directory") throw new Error(`refusing non-regular lock file: ${lockFile}`);
  const file = await open(lockFile, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const opened = await file.stat();
    if (!opened.isFile()) throw new Error(`refusing non-regular lock file: ${lockFile}`);
    await applyInheritedFlock(file);
    await assertSafePath(lockFile, "file");
    const current = await lstat(lockFile);
    if (opened.dev !== current.dev || opened.ino !== current.ino) throw new Error(`target lock file changed while acquiring: ${lockFile}`);
    if (faults.failPostFlockSetup) throw new Error("injected post-flock acquisition setup failure");
    await file.sync();
    await fsyncDirectory(path.dirname(lockFile));
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function removeLegacyLockArtifact(artifactPath: string): Promise<boolean> {
  const kind = await assertSafePath(artifactPath, "any");
  if (kind === "missing") return false;
  const ownerPath = kind === "directory" ? path.join(artifactPath, "owner.json") : artifactPath;
  const owner = await parseLockOwner(ownerPath);
  if (processIsLive(owner.pid)) {
    throw new Error(`target is locked by live legacy installer process ${owner.pid}`);
  }
  if (kind === "directory") await rm(artifactPath, { recursive: true });
  else await rm(artifactPath);
  await fsyncDirectory(path.dirname(artifactPath));
  return true;
}

async function acquireLock(target: TargetPaths, faults: TransactionFaults): Promise<LockHandle> {
  const owner: LockOwner = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
  const file = await startFlock(`${target.lockPath}.os`, faults);
  try {
    const removedMarker = await removeLegacyLockArtifact(`${target.lockPath}.reclaim`);
    const existing = await assertSafePath(target.lockPath, "any");
    let staleMetadata = false;
    if (existing === "directory") staleMetadata = await removeLegacyLockArtifact(target.lockPath);
    else if (existing === "file") staleMetadata = true;
    if ((removedMarker || staleMetadata) && faults.onStaleLockObserved) await faults.onStaleLockObserved();
    await durableReplace(target.lockPath, Buffer.from(JSON.stringify(owner)), 0o600);
    return { file, token: owner.token };
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function releaseLock(target: TargetPaths, lock: LockHandle): Promise<void> {
  let ownershipError: Error | undefined;
  try {
    const owner = await parseLockOwner(target.lockPath);
    if (owner.token !== lock.token) ownershipError = new Error(`refusing to release replacement target lock metadata: ${target.lockPath}`);
  } catch (error) {
    ownershipError = error as Error;
  }
  await lock.file.close();
  if (ownershipError) throw ownershipError;
}

export async function hasPendingJournal(target: TargetPaths): Promise<boolean> {
  const kind = await assertSafePath(target.journalPath, "any");
  if (kind === "missing") return false;
  if (kind !== "file") throw new Error(`unsafe transaction journal: ${target.journalPath}`);
  return true;
}

async function publishJournal(target: TargetPaths, journal: Journal, faults: TransactionFaults): Promise<void> {
  await ensureSafeParents(target.journalPath);
  if (await hasPendingJournal(target)) throw new Error(`transaction journal already exists: ${target.journalPath}`);
  const temporary = `${target.journalPath}.${process.pid}-${randomUUID()}.tmp`;
  await writePrivateFile(temporary, JSON.stringify(journal, null, 2));
  try {
    if (faults.afterJournalTempSynced) await faults.afterJournalTempSynced();
    if (await hasPendingJournal(target)) throw new Error(`transaction journal already exists: ${target.journalPath}`);
    await rename(temporary, target.journalPath);
    await fsyncDirectory(target.stateRoot);
    if (faults.afterJournalPublished) await faults.afterJournalPublished();
  } finally {
    await rm(temporary, { force: true });
    await fsyncDirectory(target.stateRoot);
  }
}

async function readJournal(target: TargetPaths): Promise<Journal> {
  const source = await snapshot(target.journalPath, true);
  if (!source.exists) throw new Error(`transaction journal disappeared: ${target.journalPath}`);
  const journal = JSON.parse(source.content ?? "") as Journal;
  if (journal.formatVersion !== 1 || !Array.isArray(journal.changes)) throw new Error("malformed transaction journal");
  return journal;
}

async function guardedRecover(target: TargetPaths): Promise<void> {
  if (!(await hasPendingJournal(target))) return;
  const journal = await readJournal(target);
  for (const change of journal.changes) {
    assertAllowedResource(target, change.path);
    const actual = await snapshot(change.path, change.before.encoding === "utf8" || change.after.encoding === "utf8");
    if (!sameSnapshot(actual, change.before) && !sameSnapshot(actual, change.after)) {
      throw new Error(`intervening edit prevents recovery: ${change.path}`);
    }
  }
  for (const change of [...journal.changes].reverse()) {
    const actual = await snapshot(change.path, change.before.encoding === "utf8" || change.after.encoding === "utf8");
    if (!sameSnapshot(actual, change.before) && !sameSnapshot(actual, change.after)) throw new Error(`intervening edit prevents recovery: ${change.path}`);
    await restore(change.path, change.before);
  }
  await durableRemove(target.journalPath);
}

export async function applyTransaction(
  target: TargetPaths,
  changes: TransactionChange[],
  reads: TransactionRead[] = [],
  faults: TransactionFaults = {},
): Promise<void> {
  const lock = await acquireLock(target, faults);
  let leaveInterrupted = false;
  let ownsJournal = false;
  try {
    if (faults.pauseAfterLock) await faults.pauseAfterLock();
    await guardedRecover(target);
    for (const read of reads) {
      assertAllowedResource(target, read.path);
      const actual = await snapshot(read.path, read.expected.encoding === "utf8");
      if (!sameSnapshot(actual, read.expected)) throw new Error(`planning read changed before apply: ${read.path}`);
    }
    for (const change of changes) {
      assertAllowedResource(target, change.path);
      const actual = await snapshot(change.path, change.before.encoding === "utf8" || change.after.encoding === "utf8");
      if (!sameSnapshot(actual, change.before)) throw new Error(`precondition changed before apply: ${change.path}`);
    }
    await publishJournal(target, { formatVersion: 1, changes }, faults);
    ownsJournal = true;
    let writes = 0;
    for (const change of changes) {
      const actual = await snapshot(change.path, change.before.encoding === "utf8" || change.after.encoding === "utf8");
      if (!sameSnapshot(actual, change.before)) throw new Error(`precondition changed during apply: ${change.path}`);
      await restore(change.path, change.after, faults);
      writes += 1;
      if (faults.afterWrite) await faults.afterWrite(writes, change.path);
      if (faults.interruptAfterWrites === writes) {
        leaveInterrupted = true;
        throw new InterruptedTransactionError("injected interrupted transaction");
      }
      if (faults.failAfterWrites === writes) throw new Error("injected transaction failure");
    }
    await durableRemove(target.journalPath);
  } catch (error) {
    if (leaveInterrupted) throw error;
    if (ownsJournal && await hasPendingJournal(target)) {
      try { await guardedRecover(target); } catch (rollbackError) {
        throw new Error(`${(error as Error).message}; guarded rollback refused: ${(rollbackError as Error).message}`, { cause: rollbackError });
      }
    }
    throw error;
  } finally {
    await releaseLock(target, lock);
  }
}

export function contentSnapshot(content: Buffer | string, mode: number, text = false): ResourceSnapshot {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return { exists: true, content: text ? buffer.toString("utf8") : buffer.toString("base64"), encoding: text ? "utf8" : "base64", mode };
}

export function snapshotHash(value: ResourceSnapshot): string | undefined {
  if (!value.exists) return undefined;
  return hashContent(value.encoding === "base64" ? Buffer.from(value.content ?? "", "base64") : value.content ?? "");
}
