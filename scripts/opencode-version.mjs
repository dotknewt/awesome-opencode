import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function validateOpenCodeVersion(output) {
  const version = typeof output === "string" ? output.trim() : "";
  const match = /^opencode v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  const unsupported = () => new Error(`unsupported OpenCode version ${JSON.stringify(version)}: require stable v2.2.1 or greater`);
  if (!match) throw unsupported();
  const [major, minor, patch] = match.slice(1, 4).map(BigInt);
  if (!(major > 2n || (major === 2n && (minor > 2n || (minor === 2n && patch >= 1n))))) {
    throw unsupported();
  }
  return version;
}

// Preserve the incoming public interfaces; the historical V2 names now use
// the shared minimum-version policy, including later stable major releases.
export const parseStableV2Version = validateOpenCodeVersion;

export async function resolveOpenCodeExecutable(requested = "opencode", env = process.env) {
  if (typeof requested !== "string" || requested.length === 0) {
    throw new Error("OpenCode executable path must be a non-empty string");
  }
  const candidates = path.isAbsolute(requested)
    ? [requested]
    : requested.includes(path.sep)
      ? [path.resolve(requested)]
      : (env.PATH ?? "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, requested));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch { /* try the next PATH candidate */ }
  }
  throw new Error(`OpenCode executable not found or not executable: ${requested}`);
}

export function readOpenCodeVersion(executable) {
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.error) throw new Error(`could not run OpenCode version check: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`OpenCode --version failed (${result.status}): ${(result.stderr ?? "").trim()}`);
  }
  return validateOpenCodeVersion(result.stdout);
}

export const readStableV2Version = readOpenCodeVersion;
