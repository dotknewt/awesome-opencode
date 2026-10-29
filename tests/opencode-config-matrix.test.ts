import assert from "node:assert/strict";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

interface MatrixCase {
  id: string;
  inputCandidates: string[];
}

interface MatrixResult {
  version: string;
  caseId: string;
  loadedCandidates: string[];
}

interface MatrixRunner {
  validateOpenCodeVersion(output: string): string;
  matrixCases: MatrixCase[];
  expectedMeasuredCandidates: { caseId: string; loadedCandidates: string[] }[];
  validateMatrixResult(result: MatrixResult, expected: { version: string; caseId: string; loadedCandidates?: string[] }): void;
  parseOkJson(response: Response, description: string): Promise<unknown>;
  assertNormalizedMcpDisabled(server: { disabled?: boolean } | undefined): void;
  validateSkillDiscovery(body: unknown, expectedSkills: string[], expectedProjectDirectory: string): { location: unknown; count: number; skills: unknown[] };
  waitForBuiltinSkillPlugin(options: {
    listPlugins(timeoutMs: number): Promise<unknown>;
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    wait?: (milliseconds: number) => Promise<void>;
    expectedDirectory?: string;
  }): Promise<{ location: unknown; count: number | null; plugins: unknown[] }>;
  buildSandboxArgs(options: { node: string; opencode: string; driver: string; fixture: string }): string[];
  assertSandboxAvailable(executable?: string): Promise<string>;
  createTempRoot(base: string, prefix: string): Promise<string>;
}

async function loadRunner(): Promise<MatrixRunner> {
  // Resolve source from the repository working directory; importing a .mjs
  // through the compiled dist/tests tree would resolve the wrong location.
  const source = path.resolve(process.cwd(), "scripts/check-opencode-config-matrix.mjs");
  return (await import(pathToFileURL(source).href)) as MatrixRunner;
}

test("importing runner exports does not execute its CLI entrypoint", async () => {
  const originalExitCode = process.exitCode;
  await loadRunner();
  assert.equal(process.exitCode, originalExitCode);
});

test("stable OpenCode minimum uses numeric semver ordering", async () => {
  const { validateOpenCodeVersion } = await loadRunner();
  for (const version of ["2.2.1", "2.2.10", "2.10.0", "3.0.0", "10.0.0", "9007199254740993.0.0", "2.2.1+build.001"]) {
    assert.equal(validateOpenCodeVersion(`  opencode v${version}\n`), `opencode v${version}`);
  }
  for (const version of ["0.9.0", "1.99.99", "2.0.30", "2.1.99", "2.2.0"]) {
    assert.throws(() => validateOpenCodeVersion(`opencode v${version}`), /unsupported OpenCode version/);
  }
});

test("OpenCode admission rejects malformed or prerelease whole output", async () => {
  const { validateOpenCodeVersion } = await loadRunner();
  for (const output of ["", "2.2.1", "opencode 2.2.1", "opencode v02.2.1", "opencode v2.02.1", "opencode v2.2.01", "opencode v2.2", "opencode v2.2.1.0", "opencode v2.2.1-rc.1", "opencode v3.0.0-beta+build", "opencode v2.2.1+", "opencode v2.2.1+a..b", "opencode v2.2.1+bad_", "noise\nopencode v2.2.1", "opencode v2.2.1\nnoise"]) {
    assert.throws(() => validateOpenCodeVersion(output), /unsupported OpenCode version/);
  }
});

test("eligible but different outcome version is not run evidence", async () => {
  const { validateOpenCodeVersion, validateMatrixResult } = await loadRunner();
  const version = validateOpenCodeVersion("opencode v2.2.1");
  const other = validateOpenCodeVersion("opencode v2.3.0");
  assert.throws(() => validateMatrixResult(
    { version: other, caseId: "project-json", loadedCandidates: [] },
    { version, caseId: "project-json" },
  ), /unexpected OpenCode version/);
});

const inputCases: MatrixCase[] = [
  { id: "project-json", inputCandidates: ["project/opencode.json"] },
  { id: "project-jsonc", inputCandidates: ["project/opencode.jsonc"] },
  { id: "project-conflict", inputCandidates: ["project/opencode.json", "project/opencode.jsonc"] },
  { id: "nested-json", inputCandidates: ["project/.opencode/opencode.json"] },
  { id: "nested-jsonc", inputCandidates: ["project/.opencode/opencode.jsonc"] },
  { id: "nested-conflict", inputCandidates: ["project/.opencode/opencode.json", "project/.opencode/opencode.jsonc"] },
  { id: "project-nested-json", inputCandidates: ["project/opencode.json", "project/.opencode/opencode.json"] },
  { id: "project-nested-jsonc", inputCandidates: ["project/opencode.jsonc", "project/.opencode/opencode.jsonc"] },
  { id: "project-json-nested-jsonc", inputCandidates: ["project/opencode.json", "project/.opencode/opencode.jsonc"] },
  { id: "project-jsonc-nested-json", inputCandidates: ["project/opencode.jsonc", "project/.opencode/opencode.json"] },
  { id: "global-xdg-json", inputCandidates: ["xdg/opencode/opencode.json"] },
  { id: "global-xdg-jsonc", inputCandidates: ["xdg/opencode/opencode.jsonc"] },
  { id: "global-home-json", inputCandidates: ["home/.config/opencode/opencode.json"] },
  { id: "global-home-jsonc", inputCandidates: ["home/.config/opencode/opencode.jsonc"] },
  { id: "xdg-conflict", inputCandidates: ["xdg/opencode/opencode.json", "xdg/opencode/opencode.jsonc"] },
  { id: "home-conflict", inputCandidates: ["home/.config/opencode/opencode.json", "home/.config/opencode/opencode.jsonc"] },
  { id: "xdg-home-json-inputs", inputCandidates: ["xdg/opencode/opencode.json", "home/.config/opencode/opencode.json"] },
  { id: "xdg-home-jsonc-inputs", inputCandidates: ["xdg/opencode/opencode.jsonc", "home/.config/opencode/opencode.jsonc"] },
];

const expectedMeasuredCases = [
  { caseId: "project-json", loadedCandidates: ["project/opencode.json"] },
  { caseId: "project-jsonc", loadedCandidates: ["project/opencode.jsonc"] },
  { caseId: "project-conflict", loadedCandidates: ["project/opencode.json", "project/opencode.jsonc"] },
  { caseId: "nested-json", loadedCandidates: ["project/.opencode/opencode.json"] },
  { caseId: "nested-jsonc", loadedCandidates: ["project/.opencode/opencode.jsonc"] },
  { caseId: "nested-conflict", loadedCandidates: ["project/.opencode/opencode.json", "project/.opencode/opencode.jsonc"] },
  { caseId: "project-nested-json", loadedCandidates: ["project/opencode.json", "project/.opencode/opencode.json"] },
  { caseId: "project-nested-jsonc", loadedCandidates: ["project/opencode.jsonc", "project/.opencode/opencode.jsonc"] },
  { caseId: "project-json-nested-jsonc", loadedCandidates: ["project/opencode.json", "project/.opencode/opencode.jsonc"] },
  { caseId: "project-jsonc-nested-json", loadedCandidates: ["project/opencode.jsonc", "project/.opencode/opencode.json"] },
  { caseId: "global-xdg-json", loadedCandidates: ["xdg/opencode/opencode.json"] },
  { caseId: "global-xdg-jsonc", loadedCandidates: ["xdg/opencode/opencode.jsonc"] },
  { caseId: "global-home-json", loadedCandidates: ["home/.config/opencode/opencode.json"] },
  { caseId: "global-home-jsonc", loadedCandidates: ["home/.config/opencode/opencode.jsonc"] },
  { caseId: "xdg-conflict", loadedCandidates: ["xdg/opencode/opencode.json", "xdg/opencode/opencode.jsonc"] },
  { caseId: "home-conflict", loadedCandidates: ["home/.config/opencode/opencode.json", "home/.config/opencode/opencode.jsonc"] },
  { caseId: "xdg-home-json-inputs", loadedCandidates: ["xdg/opencode/opencode.json"] },
  { caseId: "xdg-home-jsonc-inputs", loadedCandidates: ["xdg/opencode/opencode.jsonc"] },
];

test("testMatrixCoversCandidatesAndConflictPairs", () => {
  return loadRunner().then(({ matrixCases, expectedMeasuredCandidates }) => {
    assert.deepEqual(matrixCases, inputCases);
    assert.deepEqual(expectedMeasuredCandidates, expectedMeasuredCases);
    assert.deepEqual(expectedMeasuredCandidates.at(-2)?.loadedCandidates, ["xdg/opencode/opencode.json"]);
    assert.deepEqual(expectedMeasuredCandidates.at(-1)?.loadedCandidates, ["xdg/opencode/opencode.jsonc"]);
  });
});

test("normalized MCP disabled contract uses disabled=true only", async () => {
  const { assertNormalizedMcpDisabled } = await loadRunner();
  assert.doesNotThrow(() => assertNormalizedMcpDisabled({ disabled: true }));
  assert.throws(() => assertNormalizedMcpDisabled({ disabled: false }), /disabled/i);
  assert.throws(() => assertNormalizedMcpDisabled({}), /disabled/i);
});

test("plugin readiness advances from absent to active builtin", async () => {
  const { waitForBuiltinSkillPlugin } = await loadRunner();
  let clock = 0;
  let calls = 0;
  const result = await waitForBuiltinSkillPlugin({
    timeoutMs: 20,
    intervalMs: 2,
    now: () => clock,
    wait: async (milliseconds) => { clock += milliseconds; },
    listPlugins: async () => ({
      location: { directory: "/fixture/project" },
      data: calls++ === 0 ? [] : [{ id: "opencode.config.skill", source: { type: "builtin" }, state: { status: "active" } }],
    }),
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.plugins, [{ id: "opencode.config.skill", sourceType: "builtin", status: "active" }]);
});

test("plugin readiness passes a positive integer request timeout within the remaining deadline", async () => {
  const { waitForBuiltinSkillPlugin } = await loadRunner();
  let clock = 0;
  let calls = 0;
  const timeoutMs = 10;
  await waitForBuiltinSkillPlugin({
    timeoutMs,
    intervalMs: 8.75,
    now: () => clock,
    wait: async (milliseconds) => { clock += milliseconds; },
    listPlugins: async (requestTimeoutMs) => {
      const remaining = timeoutMs - clock;
      assert.ok(Number.isInteger(requestTimeoutMs), `noninteger request timeout: ${requestTimeoutMs}`);
      assert.ok(requestTimeoutMs > 0 && requestTimeoutMs <= 2_000);
      assert.ok(requestTimeoutMs <= remaining, `request timeout ${requestTimeoutMs} exceeds remaining deadline ${remaining}`);
      calls += 1;
      return {
        location: { directory: "/fixture/project" },
        data: calls === 1 ? [] : [{ id: "opencode.config.skill", source: { type: "builtin" }, state: { status: "active" } }],
      };
    },
  });
  assert.equal(calls, 2);
  assert.ok(clock < timeoutMs);
});

test("plugin readiness does not start a request with less than one millisecond left", async () => {
  const { waitForBuiltinSkillPlugin } = await loadRunner();
  let calls = 0;
  await assert.rejects(waitForBuiltinSkillPlugin({
    timeoutMs: 0.75,
    listPlugins: async () => {
      calls += 1;
      return { location: { directory: "/fixture/project" }, data: [] };
    },
  }), /timed out/);
  assert.equal(calls, 0);
});

test("plugin readiness fails immediately with builtin plugin error and reference", async () => {
  const { waitForBuiltinSkillPlugin } = await loadRunner();
  let calls = 0;
  await assert.rejects(waitForBuiltinSkillPlugin({
    listPlugins: async () => {
      calls += 1;
      return {
        location: { directory: "/fixture/project" },
        data: [{
          id: "opencode.config.skill",
          source: { type: "builtin" },
          state: { status: "failed", error: "fixture failure", ref: "test-ref" },
        }],
      };
    },
  }), /fixture failure.*test-ref/);
  assert.equal(calls, 1);
});

test("plugin readiness times out and does not accept wrong identity or source", async () => {
  const { waitForBuiltinSkillPlugin } = await loadRunner();
  let clock = 0;
  let calls = 0;
  await assert.rejects(waitForBuiltinSkillPlugin({
    timeoutMs: 5,
    intervalMs: 2,
    now: () => clock,
    wait: async (milliseconds) => { clock += milliseconds; },
    listPlugins: async () => {
      calls += 1;
      return {
        location: { directory: "/fixture/project" },
        data: [
          { id: "wrong.plugin", source: { type: "builtin" }, state: { status: "active" } },
          { id: "opencode.config.skill", source: { type: "package" }, state: { status: "active" } },
        ],
      };
    },
  }), /timed out.*wrong.plugin/);
  assert.ok(calls > 0);
});

test("skill discovery validates identity and installed path and emits bounded metadata", async () => {
  const { validateSkillDiscovery } = await loadRunner();
  const expected = ["dotknewt-libvirt-vms", "dotknewt-guest-access", "dotknewt-handling-todos"];
  const valid = {
    location: { directory: "/fixture/project" },
    data: expected.map((name) => ({
      id: name,
      name,
      path: `/fixture/project/.opencode/skills/${name}/SKILL.md`,
      content: "must not be included in diagnostic metadata",
    })),
  };
  const evidence = validateSkillDiscovery(valid, expected, "/fixture/project");
  assert.deepEqual(evidence.skills, expected.map((name) => ({
    id: name,
    name,
    path: `/fixture/project/.opencode/skills/${name}/SKILL.md`,
  })));
  assert.equal(evidence.count, expected.length);
  assert.throws(() => validateSkillDiscovery({ ...valid, data: [] }, expected, "/fixture/project"), /missing native skill/);
  assert.throws(() => validateSkillDiscovery({
    ...valid,
    data: [{ ...valid.data[0], id: "wrong-id", name: "wrong-name" }, ...valid.data.slice(1)],
  }, expected, "/fixture/project"), /missing native skill/);
  assert.throws(() => validateSkillDiscovery({
    ...valid,
    data: [{ ...valid.data[0], path: "/wrong/path/SKILL.md" }, ...valid.data.slice(1)],
  }, expected, "/fixture/project"), /unexpected installed skill path/);
  assert.throws(() => validateSkillDiscovery({
    ...valid,
    data: [{ ...valid.data[0], path: "/prefix/fixture/project/.opencode/skills/dotknewt-libvirt-vms/SKILL.md" }, ...valid.data.slice(1)],
  }, expected, "/fixture/project"), /unexpected installed skill path/);
});

test("matrix result validator rejects wrong version and loaded candidates", async () => {
  const { validateMatrixResult } = await loadRunner();
  const expected = { version: "opencode v2.0.30", caseId: "project-json", loadedCandidates: ["project/opencode.json"] };
  const fixture: MatrixResult = {
    ...expected,
    loadedCandidates: ["project/opencode.json"],
  };

  assert.doesNotThrow(() => validateMatrixResult(fixture, expected));
  assert.throws(() => validateMatrixResult({ ...fixture, version: "opencode v0.0.0" }, expected), /version/i);
  assert.throws(
    () => validateMatrixResult({ ...fixture, loadedCandidates: ["project/opencode.jsonc"] }, expected),
    /candidate|loaded/i,
  );
});

test("response parser consumes a successful Response body once", async () => {
  const { parseOkJson } = await loadRunner();
  const response = new Response(JSON.stringify([{ type: "document", path: "/fixture/project/opencode.json" }]), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  assert.deepEqual(await parseOkJson(response, "fixture config response"), [
    { type: "document", path: "/fixture/project/opencode.json" },
  ]);
});

test("sandbox argv isolates network and exposes only bounded runtime and fixture mounts", async () => {
  const { buildSandboxArgs, assertSandboxAvailable } = await loadRunner();
  const argv = buildSandboxArgs({
    node: "/usr/bin/node",
    opencode: "/home/test/.opencode/bin/opencode",
    driver: "/repo/scripts/check-opencode-config-matrix.mjs",
    fixture: "/tmp/opencode/matrix-fixture",
  });

  assert.deepEqual(argv, [
    "--die-with-parent", "--new-session", "--unshare-all", "--unshare-pid", "--clearenv",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--dir", "/usr", "--dir", "/usr/lib", "--dir", "/lib64", "--dir", "/runtime",
    "--dir", "/fixture", "--dir", "/fixture/home", "--dir", "/fixture/xdg-config",
    "--dir", "/fixture/xdg-data", "--dir", "/fixture/xdg-cache", "--dir", "/fixture/xdg-state",
    "--ro-bind", "/usr/lib", "/usr/lib",
    "--ro-bind", "/lib64/ld-linux-x86-64.so.2", "/lib64/ld-linux-x86-64.so.2",
    "--ro-bind", "/usr/bin/node", "/runtime/node",
    "--ro-bind", "/home/test/.opencode/bin/opencode", "/runtime/opencode",
    "--ro-bind", "/repo/scripts/check-opencode-config-matrix.mjs", "/runtime/driver.mjs",
    "--bind", "/tmp/opencode/matrix-fixture", "/fixture",
    "--setenv", "PATH", "/runtime", "--setenv", "HOME", "/fixture/home",
    "--setenv", "XDG_CONFIG_HOME", "/fixture/xdg-config", "--setenv", "XDG_DATA_HOME", "/fixture/xdg-data",
    "--setenv", "XDG_CACHE_HOME", "/fixture/xdg-cache", "--setenv", "XDG_STATE_HOME", "/fixture/xdg-state",
    "--setenv", "OPENCODE_DISABLE_AUTOUPDATE", "1", "--setenv", "NO_COLOR", "1",
    "--chdir", "/fixture/project", "/runtime/node", "/runtime/driver.mjs", "--inside",
  ]);
  await assert.rejects(assertSandboxAvailable("/tmp/nonexistent-bwrap-for-test"), /sandbox/i);
});

test("temporary-root setup creates a missing disposable base", async () => {
  const { createTempRoot } = await loadRunner();
  const base = `/tmp/opencode-matrix-test-${process.pid}`;
  const alternativeBase = path.join(base, "not-created-yet");
  try {
    const root = await createTempRoot(alternativeBase, "fixture-");
    await access(root);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
