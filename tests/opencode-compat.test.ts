import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

function run(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const script = path.resolve(import.meta.dirname, "../../scripts/check-opencode.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env,
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

test("installed skills are discoverable by the isolated OpenCode v2 config API harness", { timeout: 150_000 }, async (t) => {
  const result = await run(["discovery"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /discovered three native skills/);
  assert.match(result.stdout, /OpenCode version verified: opencode v2\.\d+\.\d+/);
});

test("stable OpenCode V2 parser accepts stable release versions and rejects other majors or malformed output", async () => {
  const { parseStableV2Version } = await import(pathToFileURL(path.resolve(import.meta.dirname, "../../scripts/opencode-version.mjs")).href);
  for (const output of ["opencode v2.0.30", "opencode v2.1.1", "opencode v2.99.0"]) {
    assert.equal(parseStableV2Version(output), output);
  }
  for (const output of [
    "opencode v1.18.31",
    "opencode v3.0.0",
    "opencode v2.1.0-beta.1",
    "opencode v2.1.0-rc.1",
    "opencode v2.01.0",
    "OpenCode v2.1.1",
    "opencode 2.1.1",
    "opencode v2.1",
    "garbage",
  ]) {
    assert.throws(() => parseStableV2Version(output), /stable OpenCode V2/i, output);
  }
});

test("OpenCode executable selection honors explicit path and PATH default and rejects missing paths", async (t) => {
  const { readStableV2Version, resolveOpenCodeExecutable } = await import(pathToFileURL(path.resolve(import.meta.dirname, "../../scripts/opencode-version.mjs")).href);
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-version-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const explicit = path.join(root, "explicit-opencode");
  const pathDefault = path.join(root, "opencode");
  await Promise.all([explicit, pathDefault].map(async (file) => {
    await writeFile(file, "#!/bin/sh\nprintf 'opencode v2.1.1\\n'\n");
    await chmod(file, 0o755);
  }));

  assert.equal(await resolveOpenCodeExecutable(explicit, { PATH: "" }), explicit);
  assert.equal(await resolveOpenCodeExecutable("opencode", { PATH: root }), pathDefault);
  assert.equal(readStableV2Version(pathDefault), "opencode v2.1.1");
  await assert.rejects(resolveOpenCodeExecutable(path.join(root, "missing"), { PATH: root }), /not found|executable/i);
});

test("OpenCode CLI argument parser keeps explicit path and defaults to PATH opencode", async () => {
  const { parseArguments } = await import(pathToFileURL(path.resolve(import.meta.dirname, "../../scripts/check-opencode.mjs")).href);
  assert.equal(parseArguments(["discovery"]).opencode, undefined);
  assert.equal(parseArguments(["discovery", "--opencode", "/tmp/fake-opencode"]).opencode, "/tmp/fake-opencode");
});

test("discovery CLI rejects unsupported, malformed, missing, and failing OpenCode executables before installation", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-cli-version-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installerMarker = path.join(root, "installer-reached");
  const installer = path.join(root, "fake-installer.mjs");
  await writeFile(installer, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(installerMarker)}, "called");\n`);

  const cases: { name: string; executable?: string; body?: string; expectedError: RegExp }[] = [
    { name: "V1", body: "printf 'opencode v1.18.31\\n'", expectedError: /stable OpenCode V2/i },
    { name: "prerelease", body: "printf 'opencode v2.1.0-beta.1\\n'", expectedError: /stable OpenCode V2/i },
    { name: "malformed", body: "printf 'OpenCode development build\\n'", expectedError: /stable OpenCode V2/i },
    { name: "missing", executable: path.join(root, "missing-opencode"), expectedError: /not found|not executable/i },
    { name: "nonzero --version", body: "printf 'opencode v2.1.1\\n'; exit 9", expectedError: /--version failed \(9\)/i },
  ];

  for (const [index, testCase] of cases.entries()) {
    const executable = testCase.executable ?? path.join(root, `fake-opencode-${index}`);
    if (testCase.body) {
      await writeFile(executable, `#!/bin/sh\n${testCase.body}\n`);
      await chmod(executable, 0o755);
    }
    const result = await run(["discovery", "--opencode", executable, "--installer", installer]);
    assert.notEqual(result.code, 0, `${testCase.name} executable unexpectedly succeeded`);
    assert.notEqual(result.code, 77, `${testCase.name} executable was reported as a skip`);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /\bSKIP\b/i);
    assert.match(`${result.stdout}\n${result.stderr}`, testCase.expectedError, testCase.name);
    await assert.rejects(import("node:fs/promises").then(({ access }) => access(installerMarker)), `${testCase.name} reached the installer`);
  }
});
