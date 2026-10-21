import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const stableV2Output = /^opencode v2\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

export function parseStableV2Version(output) {
  const version = typeof output === "string" ? output.trim() : "";
  if (!stableV2Output.test(version)) {
    throw new Error(`expected a stable OpenCode V2 version (opencode v2.x.y), got ${JSON.stringify(version)}`);
  }
  return version;
}

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

export function readStableV2Version(executable) {
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.error) throw new Error(`could not run OpenCode version check: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`OpenCode --version failed (${result.status}): ${(result.stderr ?? "").trim()}`);
  }
  return parseStableV2Version(result.stdout);
}
