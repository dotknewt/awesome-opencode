import os from "node:os";
import path from "node:path";

import { assertSafePath } from "./path-safety.js";

export type TargetScope = "project" | "global";

export interface TargetOptions {
  scope: TargetScope;
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface TargetPaths {
  scope: TargetScope;
  payloadRoot: string;
  managedRoot: string;
  stateRoot: string;
  statePath: string;
  journalPath: string;
  lockPath: string;
  configPath: string;
  configCandidates: string[];
  defaultConfigPath: string;
}

async function inspectConfigCandidate(candidate: string): Promise<boolean> {
  const kind = await assertSafePath(candidate, "any");
  if (kind === "missing") return false;
  if (kind !== "file") throw new Error(`supported OpenCode config candidate is not a regular file: ${candidate}`);
  return true;
}

export async function resolveTarget(options: TargetOptions): Promise<TargetPaths> {
  const env = options.env ?? process.env;
  let payloadRoot: string;
  let candidates: string[];
  let defaultConfigPath: string;
  if (options.scope === "project") {
    if (!options.projectRoot) throw new Error("project target requires projectRoot");
    const root = path.resolve(options.projectRoot);
    payloadRoot = path.join(root, ".opencode");
    defaultConfigPath = path.join(root, "opencode.json");
    candidates = [
      path.join(root, "opencode.json"),
      path.join(root, "opencode.jsonc"),
      path.join(payloadRoot, "opencode.json"),
      path.join(payloadRoot, "opencode.jsonc"),
    ];
  } else {
    const globalRoot = env.XDG_CONFIG_HOME
      ? path.resolve(env.XDG_CONFIG_HOME)
      : path.join(path.resolve(options.home ?? os.homedir()), ".config");
    payloadRoot = path.join(globalRoot, "opencode");
    defaultConfigPath = path.join(payloadRoot, "opencode.json");
    candidates = [defaultConfigPath, path.join(payloadRoot, "opencode.jsonc")];
  }
  const existing: string[] = [];
  for (const candidate of candidates) if (await inspectConfigCandidate(candidate)) existing.push(candidate);
  if (existing.length > 1) {
    throw new Error(`multiple supported OpenCode config files found: ${existing.join(", ")}`);
  }
  const stateRoot = path.join(payloadRoot, "awesome-opencode");
  return {
    scope: options.scope,
    payloadRoot,
    managedRoot: path.join(stateRoot, "toolkits"),
    stateRoot,
    statePath: path.join(stateRoot, "state.json"),
    journalPath: path.join(stateRoot, "journal.json"),
    lockPath: path.join(stateRoot, "lock"),
    configPath: existing[0] ?? defaultConfigPath,
    configCandidates: candidates,
    defaultConfigPath,
  };
}
