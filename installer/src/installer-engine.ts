import { readdir } from "node:fs/promises";
import path from "node:path";

import { configEntry, parseConfig, removeConfigEntry, setConfigEntry, structurallyEqual } from "./config.js";
import { assertSafePath } from "./path-safety.js";
import { loadToolkitPayload, type ToolkitPayload } from "./payload.js";
import { readInstallerState, type InstallerState, type InstalledToolkit, type OwnedFile } from "./state.js";
import type { TargetPaths } from "./target.js";
import {
  applyTransaction,
  contentSnapshot,
  hasPendingJournal,
  snapshot,
  snapshotHash,
  type TransactionChange,
  type TransactionFaults,
  type TransactionRead,
} from "./transaction.js";

export class InstallerError extends Error {
  override name = "InstallerError";
}

export type InstallerOperation = "install" | "update" | "uninstall";

export interface InstallerPlan {
  operation: InstallerOperation;
  toolkits: string[];
  changes: TransactionChange[];
  reads: TransactionRead[];
  summary: string[];
  dryRun: boolean;
  recoveryPending: boolean;
}

export interface PlanOptions { dryRun?: boolean }

export interface InstallerEngineOptions {
  catalogRoot: string;
  target: TargetPaths;
  faults?: TransactionFaults;
}

export interface ToolkitListing {
  name: string;
  availableVersion?: string;
  installedVersion?: string;
  error?: string;
}

function cloneState(state: InstallerState): InstallerState {
  return structuredClone(state);
}

function managedMcp(payload: ToolkitPayload, target: TargetPaths, contribution: ToolkitPayload["manifest"]["mcp"][number]): Record<string, unknown> {
  const entrypoint = path.resolve(target.managedRoot, payload.manifest.name, contribution.entrypoint);
  const toolkitRoot = path.resolve(target.managedRoot, payload.manifest.name);
  if (entrypoint !== toolkitRoot && !entrypoint.startsWith(`${toolkitRoot}${path.sep}`)) throw new Error(`unsafe MCP entrypoint: ${contribution.entrypoint}`);
  return { type: contribution.type, command: [...contribution.command, entrypoint], enabled: contribution.enabled };
}

export class InstallerEngine {
  readonly catalogRoot: string;
  readonly target: TargetPaths;
  readonly faults: TransactionFaults;

  constructor(options: InstallerEngineOptions) {
    this.catalogRoot = path.resolve(options.catalogRoot);
    this.target = options.target;
    this.faults = options.faults ?? {};
  }

  async list(): Promise<ToolkitListing[]> {
    let names: string[] = [];
    try { names = (await readdir(this.catalogRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const state = await readInstallerState(this.target);
    this.validateStatePaths(state);
    const all = new Set([...names, ...Object.keys(state.toolkits)]);
    const results: ToolkitListing[] = [];
    for (const name of [...all].sort()) {
      let availableVersion: string | undefined;
      let error: string | undefined;
      try { availableVersion = (await loadToolkitPayload(this.catalogRoot, name)).manifest.version; } catch (cause) {
        if (names.includes(name)) error = (cause as Error).message;
      }
      const installedVersion = state.toolkits[name]?.version;
      results.push({ name, ...(availableVersion === undefined ? {} : { availableVersion }), ...(installedVersion === undefined ? {} : { installedVersion }), ...(error === undefined ? {} : { error }) });
    }
    return results;
  }

  async planInstall(names: string[], options: PlanOptions = {}): Promise<InstallerPlan> {
    return this.plan("install", names, options);
  }

  async planUpdate(names: string[] = [], options: PlanOptions = {}): Promise<InstallerPlan> {
    return this.plan("update", names, options);
  }

  async planUninstall(names: string[], options: PlanOptions = {}): Promise<InstallerPlan> {
    return this.plan("uninstall", names, options);
  }

  async apply(plan: InstallerPlan): Promise<void> {
    if (plan.dryRun) return;
    try { await applyTransaction(this.target, plan.changes, plan.reads, this.faults); } catch (error) { throw this.wrap(error); }
  }

  async install(names: string[], options: PlanOptions = {}): Promise<InstallerPlan> {
    return this.run("install", names, options);
  }

  async update(names: string[] = [], options: PlanOptions = {}): Promise<InstallerPlan> {
    return this.run("update", names, options);
  }

  async uninstall(names: string[], options: PlanOptions = {}): Promise<InstallerPlan> {
    return this.run("uninstall", names, options);
  }

  private async run(operation: InstallerOperation, names: string[], options: PlanOptions): Promise<InstallerPlan> {
    try {
      if (!options.dryRun && await hasPendingJournal(this.target)) await applyTransaction(this.target, []);
      const plan = await this.plan(operation, names, options);
      if (!options.dryRun) await this.apply(plan);
      return plan;
    } catch (error) {
      throw this.wrap(error);
    }
  }

  private wrap(error: unknown): InstallerError {
    return error instanceof InstallerError ? error : new InstallerError((error as Error).message, { cause: error });
  }

  private async plan(operation: InstallerOperation, requested: string[], options: PlanOptions): Promise<InstallerPlan> {
    try {
      const recoveryPending = await hasPendingJournal(this.target);
      if (options.dryRun && recoveryPending) {
        return {
          operation,
          toolkits: [...new Set(requested)],
          changes: [],
          reads: [],
          summary: ["interrupted transaction recovery is pending; no recovery or target writes were performed"],
          dryRun: true,
          recoveryPending: true,
        };
      }
      const stateBefore = await snapshot(this.target.statePath, true);
      const state = await readInstallerState(this.target);
      const stateAfterRead = await snapshot(this.target.statePath, true);
      if (!this.sameSnapshot(stateBefore, stateAfterRead)) throw new Error(`installer state changed during planning: ${this.target.statePath}`);
      this.validateStatePaths(state);
      const names = operation === "update" && requested.length === 0 ? Object.keys(state.toolkits).sort() : [...new Set(requested)];
      if (names.length === 0 && operation !== "update") throw new Error(`${operation} requires at least one toolkit name`);
      const next = cloneState(state);
      const changes = new Map<string, TransactionChange>();
      const reads = new Map<string, TransactionRead>();
      const summary: string[] = [];
      const ownedByPath = new Map<string, OwnedFile>();
      for (const installed of Object.values(state.toolkits)) for (const file of installed.files) ownedByPath.set(file.path, file);

      let configPath: string | undefined;
      for (const name of names) {
        const installed = state.toolkits[name];
        if (operation === "install" && installed) throw new Error(`${name} is already installed; use update`);
        if (operation !== "install" && !installed) throw new Error(`${name} is not installed`);
        if (installed) {
          if (configPath && configPath !== installed.configPath) throw new Error("selected toolkits use different configuration files");
          configPath = installed.configPath;
          await this.verifyOwnedFiles(name, installed, reads);
        }
      }
      configPath ??= this.target.configPath;
      const selectedConfigPath = path.resolve(configPath);
      const configCandidateSnapshots = new Map<string, Awaited<ReturnType<typeof snapshot>>>();
      for (const candidate of this.target.configCandidates) {
        const resolved = path.resolve(candidate);
        const candidateSnapshot = await snapshot(candidate, true);
        configCandidateSnapshots.set(resolved, candidateSnapshot);
        if (resolved !== selectedConfigPath) {
          reads.set(candidate, {
            path: candidate,
            expected: candidateSnapshot,
            description: `verify alternate OpenCode configuration candidate ${candidate}`,
          });
        }
      }
      const unexpectedConfig = [...configCandidateSnapshots.entries()].find(([candidate, candidateSnapshot]) => candidate !== selectedConfigPath && candidateSnapshot.exists);
      if (unexpectedConfig) throw new Error(`supported OpenCode config candidate changed after target resolution: ${unexpectedConfig[0]}`);
      const configBefore = configCandidateSnapshots.get(selectedConfigPath);
      if (!configBefore) throw new Error(`selected OpenCode config path is not a supported candidate: ${configPath}`);
      let configSource = configBefore.exists ? configBefore.content ?? "" : "{}\n";
      let configDocument = parseConfig(configSource);

      for (const name of names) {
        const installed = state.toolkits[name];
        if (operation === "uninstall") {
          for (const owned of installed!.files) {
            changes.set(owned.path, { path: owned.path, before: await snapshot(owned.path), after: { exists: false }, description: `delete ${owned.path}` });
          }
          for (const owned of installed!.configEntries) {
            const actual = configEntry(configDocument, owned.name);
            if (!structurallyEqual(actual, owned.expected)) throw new Error(`modified owned configuration entry: ${owned.name}`);
            configSource = removeConfigEntry(configSource, owned.name);
            configDocument = parseConfig(configSource);
          }
          delete next.toolkits[name];
          summary.push(`uninstall ${name}@${installed!.version}`);
          continue;
        }

        const payload = await loadToolkitPayload(this.catalogRoot, name);
        const desiredFiles: OwnedFile[] = [];
        for (const file of payload.files) {
          const destination = path.resolve(this.target.payloadRoot, file.relativePath);
          const payloadRoot = path.resolve(this.target.payloadRoot);
          if (!destination.startsWith(`${payloadRoot}${path.sep}`)) throw new Error(`payload destination escapes target: ${file.relativePath}`);
          await assertSafePath(destination, "any");
          const existingOwner = ownedByPath.get(destination);
          if (existingOwner && existingOwner.owner !== name) throw new Error(`destination owned by ${existingOwner.owner}: ${destination}`);
          const before = await snapshot(destination);
          if (before.exists && !existingOwner) throw new Error(`unowned destination conflict (identical files are not adopted): ${destination}`);
          const desired: OwnedFile = { path: destination, hash: file.hash, mode: file.mode, owner: name };
          desiredFiles.push(desired);
          ownedByPath.set(destination, desired);
          const after = contentSnapshot(file.content, file.mode);
          if (!before.exists || snapshotHash(before) !== file.hash || before.mode !== file.mode) {
            changes.set(destination, { path: destination, before, after, description: `write ${destination}` });
            reads.delete(destination);
          } else {
            reads.set(destination, { path: destination, expected: before, description: `verify unchanged owned file ${destination}` });
          }
        }
        for (const stale of installed?.files ?? []) {
          if (!desiredFiles.some((file) => file.path === stale.path)) {
            changes.set(stale.path, { path: stale.path, before: await snapshot(stale.path), after: { exists: false }, description: `delete stale ${stale.path}` });
          }
        }

        const desiredEntries: InstalledToolkit["configEntries"] = [];
        for (const contribution of payload.manifest.mcp) {
          const desired = managedMcp(payload, this.target, contribution);
          const prior = installed?.configEntries.find((entry) => entry.name === contribution.name);
          const actual = configEntry(configDocument, contribution.name);
          if (prior) {
            if (!structurallyEqual(actual, prior.expected)) throw new Error(`modified owned configuration entry: ${contribution.name}`);
          } else if (actual !== undefined) {
            throw new Error(`unowned configuration conflict: ${contribution.name}`);
          }
          if (!structurallyEqual(actual, desired)) {
            configSource = setConfigEntry(configSource, contribution.name, desired, !configBefore.exists);
            configDocument = parseConfig(configSource);
          }
          desiredEntries.push({ name: contribution.name, expected: desired });
        }
        for (const stale of installed?.configEntries ?? []) {
          if (!desiredEntries.some((entry) => entry.name === stale.name)) {
            const actual = configEntry(configDocument, stale.name);
            if (!structurallyEqual(actual, stale.expected)) throw new Error(`modified owned configuration entry: ${stale.name}`);
            configSource = removeConfigEntry(configSource, stale.name);
            configDocument = parseConfig(configSource);
          }
        }
        next.toolkits[name] = { version: payload.manifest.version, files: desiredFiles, configPath, configEntries: desiredEntries };
        summary.push(`${operation} ${name}@${payload.manifest.version}`);
      }

      if (configSource !== (configBefore.exists ? configBefore.content : "{}\n")) {
        changes.set(configPath, { path: configPath, before: configBefore, after: contentSnapshot(configSource, configBefore.mode ?? 0o644, true), description: `edit OpenCode configuration ${configPath}` });
      } else {
        reads.set(configPath, { path: configPath, expected: configBefore, description: `verify OpenCode configuration ${configPath}` });
      }
      const stateSource = `${JSON.stringify(next, null, 2)}\n`;
      if (stateBefore.content !== stateSource) {
        changes.set(this.target.statePath, { path: this.target.statePath, before: stateBefore, after: contentSnapshot(stateSource, 0o600, true), description: "update installer ownership state" });
      } else {
        reads.set(this.target.statePath, { path: this.target.statePath, expected: stateBefore, description: "verify installer ownership state" });
      }
      return {
        operation,
        toolkits: names,
        changes: [...changes.values()],
        reads: [...reads.values()],
        summary,
        dryRun: options.dryRun ?? false,
        recoveryPending,
      };
    } catch (error) {
      throw this.wrap(error);
    }
  }

  private async verifyOwnedFiles(name: string, installed: InstalledToolkit, reads: Map<string, TransactionRead>): Promise<void> {
    for (const owned of installed.files) {
      await assertSafePath(owned.path, "file");
      const actual = await snapshot(owned.path);
      if (!actual.exists || snapshotHash(actual) !== owned.hash || actual.mode !== owned.mode) {
        throw new Error(`modified or missing owned file for ${name}: ${owned.path}`);
      }
      reads.set(owned.path, { path: owned.path, expected: actual, description: `verify owned file ${owned.path}` });
    }
  }

  private validateStatePaths(state: InstallerState): void {
    const payloadRoot = path.resolve(this.target.payloadRoot);
    const configs = new Set(this.target.configCandidates.map((candidate) => path.resolve(candidate)));
    for (const [name, installed] of Object.entries(state.toolkits)) {
      if (!configs.has(path.resolve(installed.configPath))) throw new Error(`unsafe configuration path in state for ${name}: ${installed.configPath}`);
      for (const file of installed.files) {
        const resolved = path.resolve(file.path);
        if (!resolved.startsWith(`${payloadRoot}${path.sep}`)) throw new Error(`owned file escapes payload root for ${name}: ${file.path}`);
      }
    }
  }

  private sameSnapshot(left: Awaited<ReturnType<typeof snapshot>>, right: Awaited<ReturnType<typeof snapshot>>): boolean {
    return left.exists === right.exists && left.content === right.content && left.encoding === right.encoding && left.mode === right.mode;
  }
}
