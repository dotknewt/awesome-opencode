import path from "node:path";

import { configEntry, editOwnedCommandPaths, matchRelocatedEntry, parseConfig, type CommandPathEdit } from "./config.js";
import type { HistoricalRootProof } from "./relocation.js";
import type { InstallerState, OwnedConfigEntry } from "./state.js";
import { snapshot, type TransactionRead } from "./transaction.js";
import type { TargetPaths } from "./target.js";

export interface ConfigSource {
  path: string;
  role: "candidate" | "observer";
  evidenceId: string;
}

export interface RepairConfigSelection {
  path: string | undefined;
  source: string | undefined;
  reads: TransactionRead[];
  entries: Record<string, OwnedConfigEntry[]>;
}

export function listRepairConfigSources(target: TargetPaths, _env: NodeJS.ProcessEnv): ConfigSource[] {
  return target.configCandidates.map((candidate, index) => ({
    path: candidate,
    role: "candidate",
    evidenceId: `target.configCandidates[${index}]`,
  }));
}

function fail(message: string): never {
  throw new Error(message);
}

function isSupportedCandidate(target: TargetPaths, source: ConfigSource): boolean {
  return source.role === "candidate" && target.configCandidates.some((candidate) => path.resolve(candidate) === path.resolve(source.path));
}

export async function selectRepairConfiguration(
  target: TargetPaths,
  state: InstallerState,
  proof: HistoricalRootProof,
  sources: readonly ConfigSource[],
): Promise<RepairConfigSelection> {
  const supportedPaths = new Set(target.configCandidates.map((candidate) => path.resolve(candidate)));
  const stalePaths = new Set(Object.values(state.toolkits)
    .map((installed) => installed.configPath)
    .filter((configPath) => !supportedPaths.has(path.resolve(configPath)))
    .map((configPath) => path.resolve(configPath)));
  const seenPaths = new Set<string>();
  for (const source of sources) {
    if (!path.isAbsolute(source.path) || path.normalize(source.path) !== source.path || !source.evidenceId) {
      fail(`invalid configuration source evidence: ${source.path}`);
    }
    const resolved = path.resolve(source.path);
    if (stalePaths.has(resolved)) fail(`refusing stale configuration source before snapshot: ${source.path}`);
    if (seenPaths.has(resolved)) fail(`duplicate configuration source: ${source.path}`);
    seenPaths.add(resolved);
    if (source.role === "candidate" && !supportedPaths.has(resolved)) fail(`configuration candidate is outside the selected target: ${source.path}`);
  }

  // Take all current-source snapshots first. The stored configPath is only
  // provenance and is never accessed here.
  const reads: TransactionRead[] = [];
  const documents = new Map<string, { source: ConfigSource; text: string | undefined; value: ReturnType<typeof parseConfig>["value"] | undefined }>();
  for (const source of sources) {
    const expected = await snapshot(source.path, true);
    reads.push({ path: source.path, expected, description: `configuration ownership candidate (${source.evidenceId})` });
    if (!expected.exists) {
      documents.set(path.resolve(source.path), { source, text: undefined, value: undefined });
      continue;
    }
    const text = expected.content ?? "";
    const parsed = parseConfig(text);
    documents.set(path.resolve(source.path), { source, text, value: parsed.value });
  }

  const ownedEntries = Object.entries(state.toolkits).flatMap(([toolkit, installed]) =>
    installed.configEntries.map((entry) => ({ toolkit, entry })));
  const rebasedEntries: Record<string, OwnedConfigEntry[]> = Object.fromEntries(
    Object.entries(proof.rebasedState.toolkits).map(([toolkit, installed]) => [toolkit, structuredClone(installed.configEntries)]),
  );
  if (ownedEntries.length === 0) return { path: undefined, source: undefined, reads, entries: rebasedEntries };

  const ownersByEntry = new Map<string, Array<{ source: ConfigSource; edits: CommandPathEdit[] }>>();
  for (const { toolkit, entry } of ownedEntries) {
    const matches: Array<{ source: ConfigSource; edits: CommandPathEdit[] }> = [];
    const conflicts: Array<{ source: ConfigSource; reason: string }> = [];
    for (const document of documents.values()) {
      if (!document.value) continue;
      const actual = configEntry({ source: document.text!, value: document.value }, entry.name);
      if (actual === undefined) continue;
      let edits: CommandPathEdit[];
      try {
        edits = matchRelocatedEntry(actual, entry.expected, proof.previousManagedRoot, target.managedRoot);
      } catch (error) {
        conflicts.push({ source: document.source, reason: (error as Error).message });
        continue;
      }
      matches.push({ source: document.source, edits });
    }
    if (conflicts.length > 0) {
      const locations = [...new Set([...matches.map(({ source }) => source.path), ...conflicts.map(({ source }) => source.path)])];
      const loaded = [...matches.map(({ source }) => source), ...conflicts.map(({ source }) => source)].some((source) => source.role === "observer");
      fail(`owned MCP configuration conflict for ${entry.name} at ${locations.join(", ")}: ${conflicts.map(({ reason }) => reason).join("; ")}. ${loaded ? "Manually resolve the loaded-source conflict" : "Manually resolve the supported-config conflict"}, remove or migrate duplicate entries, and consolidate this MCP entry into exactly one supported configuration before retrying.`);
    }
    if (matches.length === 0) fail(`installed MCP entry ${entry.name} for ${toolkit} is missing from current configuration sources`);
    ownersByEntry.set(entry.name, matches);
  }

  const ownerPaths = new Set<string>();
  for (const [entryName, matches] of ownersByEntry) {
    const candidateMatches = matches.filter(({ source }) => isSupportedCandidate(target, source));
    const observerMatches = matches.filter(({ source }) => source.role === "observer");
    if (observerMatches.length > 0) {
      const locations = matches.map(({ source }) => source.path).join(", ");
      if (candidateMatches.length > 0) fail(`verified-loaded configuration source competes for MCP ${entryName} at ${locations}; manually resolve the competing entries, remove or migrate duplicates, and consolidate this MCP entry into exactly one supported configuration before retrying.`);
      fail(`MCP ${entryName} is owned only by unsupported configuration source ${locations}; manually migrate it to a supported candidate and preserve consumer settings before retrying.`);
    }
    if (candidateMatches.length === 0) fail(`no supported configuration owns installed MCP entry ${entryName}`);
    if (candidateMatches.length > 1) fail(`multiple supported configuration owners for MCP ${entryName} at ${candidateMatches.map(({ source }) => source.path).join(", ")}; manually remove or migrate duplicate entries and consolidate this MCP entry into exactly one supported configuration before retrying.`);
    ownerPaths.add(path.resolve(candidateMatches[0]!.source.path));
  }
  if (ownerPaths.size !== 1) fail(`installed MCP entries have split configuration owners at ${[...ownerPaths].join(", ")}; manually resolve the split ownership, remove or migrate duplicate entries, and consolidate all managed MCP entries into exactly one supported configuration before retrying.`);
  const selectedPath = [...ownerPaths][0]!;

  // Any supplied observer carrying a managed name competes, including one
  // whose entry belongs to another installed toolkit.
  for (const entry of ownedEntries) {
    const matches = ownersByEntry.get(entry.entry.name)!;
    for (const match of matches) {
      if (match.source.role === "observer") {
        const locations = matches.map(({ source }) => source.path).join(", ");
        fail(`verified-loaded configuration source competes for MCP ${entry.entry.name} at ${locations}; manually resolve the competing entries, remove or migrate duplicates, and consolidate this MCP entry into exactly one supported configuration before retrying.`);
      }
    }
  }

  const selected = documents.get(selectedPath);
  if (!selected?.text) fail(`selected configuration snapshot is missing: ${selectedPath}`);
  let sourceText = selected.text;
  for (const { entry } of ownedEntries) {
    const owner = ownersByEntry.get(entry.name)!.find((match) => path.resolve(match.source.path) === selectedPath);
    if (!owner) fail(`selected configuration does not own MCP entry ${entry.name}`);
    if (owner.edits.length > 0) sourceText = editOwnedCommandPaths(sourceText, entry.name, owner.edits);
  }
  return { path: selected.source.path, source: sourceText, reads, entries: rebasedEntries };
}
