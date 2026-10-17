import path from "node:path";

import { assertInstalledRelativePath } from "./resource-policy.js";
import { validateState, type InstallerState } from "./state.js";
import type { TargetPaths } from "./target.js";

export interface HistoricalRootProof {
  previousPayloadRoot: string;
  previousManagedRoot: string;
  rebasedState: InstallerState;
}

function failure(reason: string): never {
  throw new Error(`historical installer ownership/root cannot be proven (${reason}); use manual recovery or migration`);
}

function configRoots(configPath: string, scope: TargetPaths["scope"]): string[] {
  const base = path.basename(configPath);
  if (base !== "opencode.json" && base !== "opencode.jsonc") return [];
  const parent = path.dirname(configPath);
  if (scope === "global") return path.basename(parent) === "opencode" ? [parent] : [];
  if (path.basename(parent) === ".opencode") return [parent, path.join(parent, ".opencode")];
  return [path.join(parent, ".opencode")];
}

function recordFitsRoot(name: string, files: InstallerState["toolkits"][string]["files"], root: string): boolean {
  for (const file of files) {
    const relative = path.relative(root, file.path);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    try { assertInstalledRelativePath(name, relative.split(path.sep).join("/")); }
    catch { return false; }
  }
  return true;
}

function supportedCurrentConfig(target: TargetPaths, oldConfig: string, oldRoot: string): string {
  const basename = path.basename(oldConfig);
  const oldParentIsRoot = path.dirname(oldConfig) === oldRoot;
  const candidates = target.configCandidates.filter((candidate) => path.basename(candidate) === basename &&
    (path.dirname(candidate) === target.payloadRoot) === oldParentIsRoot);
  if (candidates.length !== 1) failure(`no unique supported current config candidate for ${oldConfig}`);
  return candidates[0]!;
}

export function proveHistoricalRoot(state: InstallerState, target: TargetPaths): HistoricalRootProof {
  validateState(state);
  if (Object.keys(state.toolkits).length === 0) {
    return { previousPayloadRoot: target.payloadRoot, previousManagedRoot: target.managedRoot, rebasedState: structuredClone(state) };
  }

  let intersection: Set<string> | undefined;
  let hasInventory = false;
  for (const [name, installed] of Object.entries(state.toolkits)) {
    const interpretations = [...new Set(configRoots(installed.configPath, target.scope))]
      .filter((root) => recordFitsRoot(name, installed.files, root));
    if (installed.files.length > 0) hasInventory = true;
    const current = new Set(interpretations);
    intersection = intersection === undefined ? current : new Set([...intersection].filter((root) => current.has(root)));
  }
  if (!hasInventory) failure("state contains no installed file inventory");
  if (!intersection || intersection.size !== 1) failure(intersection?.size ? "historical root is ambiguous" : "records do not share one recognized historical root");
  const previousPayloadRoot = [...intersection][0]!;
  const previousManagedRoot = path.join(previousPayloadRoot, "awesome-opencode", "toolkits");
  const rebasedState = structuredClone(state);

  for (const [name, installed] of Object.entries(state.toolkits)) {
    const destination = rebasedState.toolkits[name]!;
    destination.configPath = supportedCurrentConfig(target, installed.configPath, previousPayloadRoot);
    destination.files = installed.files.map((file) => ({ ...file, path: path.join(target.payloadRoot, path.relative(previousPayloadRoot, file.path)) }));
    for (let i = 0; i < installed.configEntries.length; i++) {
      const sourceEntry = installed.configEntries[i]!;
      const targetEntry = destination.configEntries[i]!;
      const expected = sourceEntry.expected;
      if (!expected || typeof expected !== "object" || Array.isArray(expected)) failure(`malformed MCP ownership entry ${sourceEntry.name}`);
      const object = expected as Record<string, unknown>;
      if (object.type !== "local" || !Array.isArray(object.command) || object.command.length === 0 || !object.command.every((part): part is string => typeof part === "string")) {
        failure(`malformed local MCP command for ${sourceEntry.name}`);
      }
      const command = object.command;
      const final = command[command.length - 1];
      if (typeof final !== "string" || !path.posix.isAbsolute(final) || final.includes("\0") || final.includes("\\") || final.endsWith("/") || path.posix.normalize(final) !== final) {
        failure(`MCP entrypoint for ${sourceEntry.name} must be a canonical absolute path`);
      }
      const managedRelative = path.relative(previousManagedRoot, final);
      if (!managedRelative || managedRelative === ".." || managedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(managedRelative)) {
        failure(`MCP entrypoint for ${sourceEntry.name} is outside its owned toolkit subtree`);
      }
      const ownerRoot = path.join(previousManagedRoot, name);
      const ownerRelative = path.relative(ownerRoot, final);
      if (!ownerRelative || ownerRelative === ".." || ownerRelative.startsWith(`..${path.sep}`) || path.isAbsolute(ownerRelative)) failure(`MCP entrypoint for ${sourceEntry.name} is outside toolkit ${name}`);
      if (!installed.files.some((file) => file.path === final)) failure(`MCP entrypoint for ${sourceEntry.name} is not inventoried by ${name}`);
      const rebasedFinal = path.join(target.managedRoot, name, ownerRelative);
      targetEntry.expected = { ...object, command: [...command.slice(0, -1), rebasedFinal] };
    }
  }
  return { previousPayloadRoot, previousManagedRoot, rebasedState };
}
