import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const script = path.resolve(import.meta.dirname, "../../scripts/check-opencode.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("generated MCP config validates against the public native OpenCode schema", { timeout: 60_000 }, async (t) => {
  const result = await run(["schema"]);
  if (result.code === 77) {
    t.skip(result.stdout.trim());
    return;
  }
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /validates against public OpenCode/);
});

test("installed skills are discoverable by an optional isolated OpenCode CLI", { timeout: 60_000 }, async (t) => {
  const result = await run(["discovery"]);
  if (result.code === 77) {
    t.skip(result.stdout.trim());
    return;
  }
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /discovered two native skills/);
});
