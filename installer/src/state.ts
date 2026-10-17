import { readFile } from "node:fs/promises";
import path from "node:path";

import { assertSafePath } from "./path-safety.js";
import type { TargetPaths } from "./target.js";

export interface OwnedFile {
  path: string;
  hash: string;
  mode: number;
  owner: string;
}

export interface OwnedConfigEntry {
  name: string;
  expected: unknown;
}

export interface InstalledToolkit {
  version: string;
  files: OwnedFile[];
  configPath: string;
  configEntries: OwnedConfigEntry[];
}

export interface InstallerState {
  formatVersion: 1;
  toolkits: Record<string, InstalledToolkit>;
}

export const emptyInstallerState = (): InstallerState => ({ formatVersion: 1, toolkits: {} });

const identityPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isIdentity = (value: string): boolean => value.length <= 64 && identityPattern.test(value);

function assertCanonicalAbsolutePath(value: string, label: string): void {
  if (!value.startsWith("/") || value.includes("\0") || value.includes("\\") || value === "/" || value.endsWith("/")) {
    throw new Error(`${label} must be a canonical absolute path without traversal or aliases`);
  }
  const components = value.slice(1).split("/");
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    throw new Error(`${label} must be a canonical absolute path without traversal or aliases`);
  }
  if (path.posix.normalize(value) !== value) throw new Error(`${label} must be a canonical absolute path`);
}

export function validateState(value: unknown): asserts value is InstallerState {
  if (typeof value !== "object" || value === null) throw new Error("installer state must be an object");
  const state = value as Partial<InstallerState>;
  if (state.formatVersion !== 1 || typeof state.toolkits !== "object" || state.toolkits === null || Array.isArray(state.toolkits)) {
    throw new Error("unsupported or malformed installer state");
  }
  const fileOwners = new Map<string, string>();
  const configOwners = new Map<string, string>();
  for (const [name, installed] of Object.entries(state.toolkits)) {
    if (!isIdentity(name)) throw new Error(`invalid toolkit identity in state: ${JSON.stringify(name)}`);
    if (!installed || typeof installed !== "object") throw new Error(`malformed state for ${name}`);
    const record = installed as Partial<InstalledToolkit>;
    if (typeof record.version !== "string" || typeof record.configPath !== "string" || !Array.isArray(record.files) || !Array.isArray(record.configEntries)) {
      throw new Error(`malformed state for ${name}`);
    }
    assertCanonicalAbsolutePath(record.configPath, `config path for ${name}`);
    for (const file of record.files) {
      if (!file || typeof file.path !== "string" || typeof file.hash !== "string" || typeof file.mode !== "number" || file.owner !== name) {
        throw new Error(`malformed file ownership state for ${name}`);
      }
      assertCanonicalAbsolutePath(file.path, `owned file path for ${name}`);
      if (!/^[a-f0-9]{64}$/.test(file.hash)) throw new Error(`invalid SHA-256 hash in file ownership state for ${name}`);
      if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) throw new Error(`invalid file mode in ownership state for ${name}`);
      if (fileOwners.has(file.path)) throw new Error(`duplicate file ownership in state: ${file.path} (${fileOwners.get(file.path)}, ${name})`);
      for (const [other, owner] of fileOwners) {
        if (other.startsWith(`${file.path}/`) || file.path.startsWith(`${other}/`)) {
          throw new Error(`prefix-colliding file ownership in state: ${other} (${owner}) and ${file.path} (${name})`);
        }
      }
      fileOwners.set(file.path, name);
    }
    for (const entry of record.configEntries) {
      if (!entry || typeof entry.name !== "string" || !isIdentity(entry.name) || !("expected" in entry)) throw new Error(`malformed config ownership state for ${name}`);
      const key = entry.name;
      if (configOwners.has(key)) throw new Error(`duplicate MCP configuration ownership in state: ${entry.name} (${configOwners.get(key)}, ${name})`);
      configOwners.set(key, name);
    }
  }
}

export async function readInstallerState(target: TargetPaths): Promise<InstallerState> {
  let source: string;
  try {
    const kind = await assertSafePath(target.statePath, "file");
    if (kind === "missing") return emptyInstallerState();
    source = await readFile(target.statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyInstallerState();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`malformed installer state ${target.statePath}: ${(error as Error).message}`);
  }
  validateState(parsed);
  return parsed;
}
