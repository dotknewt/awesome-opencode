#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateOpenCodeVersion, resolveOpenCodeExecutable } from "./opencode-version.mjs";
export { validateOpenCodeVersion } from "./opencode-version.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE_ROOT = "/fixture";
const RUNTIME_NODE = "/runtime/node";
const RUNTIME_OPENCODE = "/runtime/opencode";
const RUNTIME_DRIVER = "/runtime/driver.mjs";
const RUNTIME_VERSION_HELPER = "/runtime/opencode-version.mjs";
const VERSION_HELPER = fileURLToPath(new URL("./opencode-version.mjs", import.meta.url));
export const SKILLS = ["dotknewt-libvirt-vms", "dotknewt-guest-access", "dotknewt-handling-todos", "dotknewt-ollama-name-cleanup", "dotknewt-kb-read"];

export function assertKBDiscoveryEvidence(entry, expectedEntrypoint) {
  assertNormalizedMcpDisabled(entry);
  assert.ok(path.posix.isAbsolute(expectedEntrypoint), "KB entrypoint must be absolute");
  assert.deepEqual(entry.command, ["uv", "run", "--script", expectedEntrypoint], "KB default must remain unconfigured with its installed entrypoint");
}

export const matrixCases = [
  ["project-json", ["project/opencode.json"]],
  ["project-jsonc", ["project/opencode.jsonc"]],
  ["project-conflict", ["project/opencode.json", "project/opencode.jsonc"]],
  ["nested-json", ["project/.opencode/opencode.json"]],
  ["nested-jsonc", ["project/.opencode/opencode.jsonc"]],
  ["nested-conflict", ["project/.opencode/opencode.json", "project/.opencode/opencode.jsonc"]],
  ["project-nested-json", ["project/opencode.json", "project/.opencode/opencode.json"]],
  ["project-nested-jsonc", ["project/opencode.jsonc", "project/.opencode/opencode.jsonc"]],
  ["project-json-nested-jsonc", ["project/opencode.json", "project/.opencode/opencode.jsonc"]],
  ["project-jsonc-nested-json", ["project/opencode.jsonc", "project/.opencode/opencode.json"]],
  ["global-xdg-json", ["xdg/opencode/opencode.json"]],
  ["global-xdg-jsonc", ["xdg/opencode/opencode.jsonc"]],
  ["global-home-json", ["home/.config/opencode/opencode.json"]],
  ["global-home-jsonc", ["home/.config/opencode/opencode.jsonc"]],
  ["xdg-conflict", ["xdg/opencode/opencode.json", "xdg/opencode/opencode.jsonc"]],
  ["home-conflict", ["home/.config/opencode/opencode.json", "home/.config/opencode/opencode.jsonc"]],
  ["xdg-home-json-inputs", ["xdg/opencode/opencode.json", "home/.config/opencode/opencode.json"]],
  ["xdg-home-jsonc-inputs", ["xdg/opencode/opencode.jsonc", "home/.config/opencode/opencode.jsonc"]],
].map(([id, inputCandidates]) => ({ id, inputCandidates }));

export const expectedMeasuredCandidates = [
  ["project-json", ["project/opencode.json"]],
  ["project-jsonc", ["project/opencode.jsonc"]],
  ["project-conflict", ["project/opencode.json", "project/opencode.jsonc"]],
  ["nested-json", ["project/.opencode/opencode.json"]],
  ["nested-jsonc", ["project/.opencode/opencode.jsonc"]],
  ["nested-conflict", ["project/.opencode/opencode.json", "project/.opencode/opencode.jsonc"]],
  ["project-nested-json", ["project/opencode.json", "project/.opencode/opencode.json"]],
  ["project-nested-jsonc", ["project/opencode.jsonc", "project/.opencode/opencode.jsonc"]],
  ["project-json-nested-jsonc", ["project/opencode.json", "project/.opencode/opencode.jsonc"]],
  ["project-jsonc-nested-json", ["project/opencode.jsonc", "project/.opencode/opencode.json"]],
  ["global-xdg-json", ["xdg/opencode/opencode.json"]],
  ["global-xdg-jsonc", ["xdg/opencode/opencode.jsonc"]],
  ["global-home-json", ["home/.config/opencode/opencode.json"]],
  ["global-home-jsonc", ["home/.config/opencode/opencode.jsonc"]],
  ["xdg-conflict", ["xdg/opencode/opencode.json", "xdg/opencode/opencode.jsonc"]],
  ["home-conflict", ["home/.config/opencode/opencode.json", "home/.config/opencode/opencode.jsonc"]],
  ["xdg-home-json-inputs", ["xdg/opencode/opencode.json"]],
  ["xdg-home-jsonc-inputs", ["xdg/opencode/opencode.jsonc"]],
].map(([caseId, loadedCandidates]) => ({ caseId, loadedCandidates }));

export function validateMatrixResult(result, expected) {
  assert.equal(result.version, expected.version, `unexpected OpenCode version: ${result.version}`);
  assert.equal(result.caseId, expected.caseId, `unexpected case: ${result.caseId}`);
  assert.ok(Array.isArray(result.loadedCandidates), "loadedCandidates must be an array");
  assert.ok(result.loadedCandidates.every((candidate) => typeof candidate === "string"));
  if (expected.loadedCandidates) {
    assert.deepEqual(result.loadedCandidates, expected.loadedCandidates, `wrong loaded candidates for ${result.caseId}`);
  }
}

export async function parseOkJson(response, description) {
  const body = await response.text();
  assert.equal(response.status, 200, `${description}: ${body}`);
  return JSON.parse(body);
}

export function assertNormalizedMcpDisabled(server) {
  assert.equal(server?.disabled, true, "normalized MCP server must be disabled");
}

export function skillDiagnostics(body) {
  const data = Array.isArray(body?.data) ? body.data : [];
  const skills = data.map(({ id, name, path: skillPath }) => ({ id, name, path: skillPath }));
  return { location: body?.location ?? null, count: Array.isArray(body?.data) ? data.length : null, skills };
}

export function pluginDiagnostics(body) {
  const data = Array.isArray(body?.data) ? body.data : [];
  const plugins = data.map((plugin) => ({
    id: plugin?.id,
    sourceType: plugin?.source?.type,
    status: plugin?.state?.status,
    ...(plugin?.state?.status === "failed"
      ? { error: plugin.state.error, ref: plugin.state.ref }
      : {}),
  }));
  return { location: body?.location ?? null, count: Array.isArray(body?.data) ? data.length : null, plugins };
}

export async function waitForBuiltinSkillPlugin({
  listPlugins,
  timeoutMs = 10_000,
  intervalMs = 250,
  now = () => performance.now(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  expectedDirectory = "/fixture/project",
}) {
  const deadline = now() + timeoutMs;
  let inventory = { location: null, count: null, plugins: [] };
  const fail = (message) => {
    const error = new Error(`${message}; plugin inventory: ${JSON.stringify(inventory)}`);
    error.pluginInventory = inventory;
    throw error;
  };
  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) fail("timed out waiting for active builtin skill plugin");
    const requestTimeoutMs = Math.floor(Math.min(2_000, remaining));
    if (requestTimeoutMs <= 0) fail("timed out waiting for active builtin skill plugin");
    let body;
    try {
      body = await listPlugins(requestTimeoutMs);
    } catch (error) {
      error.pluginInventory = inventory;
      throw error;
    }
    inventory = pluginDiagnostics(body);
    if (!Array.isArray(body?.data)) fail("plugin response data must be an array");
    if (inventory.location?.directory !== expectedDirectory) {
      fail(`plugin response location mismatch (expected ${expectedDirectory})`);
    }
    const target = body.data?.find((plugin) => plugin?.id === "opencode.config.skill");
    if (target?.state?.status === "failed") {
      fail(`builtin skill plugin failed: ${target.state.error ?? "unknown error"}${target.state.ref ? ` (${target.state.ref})` : ""}`);
    }
    if (now() >= deadline) fail("timed out waiting for active builtin skill plugin");
    if (target?.source?.type === "builtin" && target?.state?.status === "active") {
      return inventory;
    }
    const delay = Math.min(intervalMs, deadline - now());
    if (delay <= 0) fail("timed out waiting for active builtin skill plugin");
    await wait(delay);
  }
}

async function inspectExpectedSkillFiles() {
  const metadata = [];
  for (const name of SKILLS) {
    const skillPath = `/fixture/project/.opencode/skills/${name}/SKILL.md`;
    try {
      const stat = await lstat(skillPath);
      const item = { name, path: skillPath, regular: stat.isFile() };
      if (stat.isFile()) {
        const bytes = await readFile(skillPath);
        const text = bytes.toString("utf8");
        const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
        const frontmatterValue = frontmatter.match(/^name:\s*(.*?)\s*$/m)?.[1];
        metadata.push({
          ...item,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          frontmatterName: frontmatterValue?.replace(/^(?:"(.*)"|'(.*)')$/, "$1$2"),
        });
      } else {
        metadata.push(item);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      metadata.push({ name, path: skillPath, regular: false, missing: true });
    }
  }
  return metadata;
}

export function validateSkillDiscovery(body, expectedSkills, expectedProjectDirectory) {
  const diagnostic = skillDiagnostics(body);
  assert.equal(body?.location?.directory, expectedProjectDirectory, `skill response location mismatch; ${JSON.stringify(diagnostic)}`);
  assert.ok(Array.isArray(body?.data), `skill response data must be an array; ${JSON.stringify(diagnostic)}`);
  for (const expected of expectedSkills) {
    const skill = diagnostic.skills.find((item) => item.id === expected || item.name === expected);
    assert.ok(skill, `missing native skill identity ${expected}; ${JSON.stringify(diagnostic)}`);
    assert.ok(
      skill.path === `${expectedProjectDirectory}/.opencode/skills/${expected}/SKILL.md`,
      `unexpected installed skill path for ${expected}; ${JSON.stringify(diagnostic)}`,
    );
  }
  return diagnostic;
}

function appendBind(args, flag, source, destination) {
  args.push(flag, source, destination);
}

export function buildSandboxArgs({ node, opencode, driver, versionHelper = VERSION_HELPER, fixture }) {
  for (const [name, value] of Object.entries({ node, opencode, driver, versionHelper, fixture })) {
    assert.ok(path.isAbsolute(value), `${name} must be an absolute path`);
  }
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--unshare-pid",
    "--clearenv",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--dir", "/usr",
    "--dir", "/usr/lib",
    "--dir", "/lib64",
    "--dir", "/runtime",
    "--dir", "/fixture",
    "--dir", "/fixture/home",
    "--dir", "/fixture/xdg-config",
    "--dir", "/fixture/xdg-data",
    "--dir", "/fixture/xdg-cache",
    "--dir", "/fixture/xdg-state",
  ];
  appendBind(args, "--ro-bind", "/usr/lib", "/usr/lib");
  appendBind(args, "--ro-bind", "/lib64/ld-linux-x86-64.so.2", "/lib64/ld-linux-x86-64.so.2");
  appendBind(args, "--ro-bind", node, RUNTIME_NODE);
  appendBind(args, "--ro-bind", opencode, RUNTIME_OPENCODE);
  appendBind(args, "--ro-bind", driver, RUNTIME_DRIVER);
  appendBind(args, "--ro-bind", versionHelper, RUNTIME_VERSION_HELPER);
  appendBind(args, "--bind", fixture, FIXTURE_ROOT);
  args.push(
    "--setenv", "PATH", "/runtime",
    "--setenv", "HOME", "/fixture/home",
    "--setenv", "XDG_CONFIG_HOME", "/fixture/xdg-config",
    "--setenv", "XDG_DATA_HOME", "/fixture/xdg-data",
    "--setenv", "XDG_CACHE_HOME", "/fixture/xdg-cache",
    "--setenv", "XDG_STATE_HOME", "/fixture/xdg-state",
    "--setenv", "OPENCODE_DISABLE_AUTOUPDATE", "1",
    "--setenv", "NO_COLOR", "1",
    "--chdir", "/fixture/project",
    RUNTIME_NODE, RUNTIME_DRIVER, "--inside",
  );
  return args;
}

export async function assertSandboxAvailable(executable = "bwrap") {
  const candidates = path.isAbsolute(executable)
    ? [executable]
    : (process.env.PATH ?? "").split(path.delimiter).map((directory) => path.join(directory, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch { /* continue searching */ }
  }
  throw new Error(`required bubblewrap sandbox is unavailable: ${executable}`);
}

export async function createTempRoot(base, prefix) {
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, prefix));
}

function command(executable, args, options = {}, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${executable} timed out after ${timeoutMs}ms\n${stderr}`));
      else resolve({ code, stdout, stderr });
    });
  });
}

function candidatePath(root, candidate) {
  const mapped = candidate.startsWith("project/")
    ? path.join(root, "project", candidate.slice("project/".length))
    : candidate.startsWith("xdg/")
      ? path.join(root, "xdg-config", candidate.slice("xdg/".length))
      : path.join(root, candidate);
  return mapped;
}

async function prepareMatrixCase(root, matrixCase) {
  const candidateFiles = [
    "project/opencode.json", "project/opencode.jsonc",
    "project/.opencode/opencode.json", "project/.opencode/opencode.jsonc",
    "xdg/opencode/opencode.json", "xdg/opencode/opencode.jsonc",
    "home/.config/opencode/opencode.json", "home/.config/opencode/opencode.jsonc",
  ];
  for (const file of candidateFiles) await rm(candidatePath(root, file), { force: true });
  for (let index = 0; index < matrixCase.inputCandidates.length; index += 1) {
    const candidate = matrixCase.inputCandidates[index];
    const filePath = candidatePath(root, candidate);
    await mkdir(path.dirname(filePath), { recursive: true });
    const marker = `matrix-${matrixCase.id}-${index}`;
    await writeFile(filePath, `${JSON.stringify({
      mcp: {
        "matrix-marker": {
          type: "local",
          command: ["/runtime/nonexistent", marker],
          enabled: false,
        },
      },
    })}\n`);
  }
}

async function inside() {
  const config = JSON.parse(process.argv[3]);
  const version = await command(RUNTIME_OPENCODE, ["--version"], { cwd: "/fixture/project" }, 15_000);
  assert.equal(version.code, 0, version.stderr);
  const actualVersion = validateOpenCodeVersion(version.stdout);
  const outcomes = [];
  for (const item of config.cases) {
    if (!config.discovery) await prepareMatrixCase("/fixture", item);
    const child = spawn(RUNTIME_OPENCODE, ["serve", "--stdio", "--port", "0"], {
      cwd: "/fixture/project",
      env: {
        PATH: "/runtime", HOME: "/fixture/home",
        XDG_DATA_HOME: "/fixture/xdg-data", XDG_CACHE_HOME: "/fixture/xdg-cache",
        XDG_STATE_HOME: "/fixture/xdg-state", OPENCODE_PASSWORD: config.password,
        OPENCODE_DISABLE_AUTOUPDATE: "1", NO_COLOR: "1",
        ...(item.inputCandidates.some((candidate) => candidate.startsWith("xdg/")) || config.discovery
          ? { XDG_CONFIG_HOME: "/fixture/xdg-config" }
          : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const closePromise = new Promise((resolve) => child.once("close", resolve));
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8192); });
    let failure;
    let discoveryDiagnostic = { location: "/fixture/project", count: null, skills: [] };
    try {
      const readiness = await new Promise((resolve, reject) => {
        let text = "";
        const timer = setTimeout(() => reject(new Error("server readiness timed out")), 20_000);
        child.stdout.setEncoding("utf8").on("data", (chunk) => {
          text += chunk;
          const newline = text.indexOf("\n");
          if (newline !== -1) {
            clearTimeout(timer);
            try { resolve(JSON.parse(text.slice(0, newline))); }
            catch (error) { reject(error); }
          }
        });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("close", (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}): ${stderr}`)); });
      });
      assert.equal(typeof readiness.url, "string");
      const base = new URL(readiness.url);
      assert.ok(["127.0.0.1", "localhost", "::1", "[::1]"].includes(base.hostname), `server URL not loopback: ${base.hostname}`);
      if (base.hostname === "localhost") base.hostname = "127.0.0.1";
      const authorization = `Basic ${Buffer.from(`opencode:${config.password}`).toString("base64")}`;
      const query = new URLSearchParams({ "location[directory]": "/fixture/project" });
      const response = await fetch(new URL(`/api/config?${query}`, base), {
        headers: { authorization }, signal: AbortSignal.timeout(15_000),
      });
      const documents = await parseOkJson(response, "GET /api/config");
      assert.ok(Array.isArray(documents), "config API response must be Config.Entry[]");
      const loadedCandidates = [];
      const loadedDocuments = [];
      for (const entry of documents) {
        assert.ok(entry && typeof entry === "object");
        if (entry.type !== "document") continue;
        assert.ok(typeof entry.path === "string", "file-backed document missing path");
        if (!entry.path.startsWith("/fixture/")) throw new Error(`unexpected file-backed config source: ${entry.path}`);
        if (entry.path.startsWith("/fixture/project/")) {
          const candidate = entry.path.slice("/fixture/".length);
          loadedCandidates.push(candidate);
          loadedDocuments.push({ path: candidate, marker: entry.info?.mcp?.servers?.["matrix-marker"]?.command?.at(-1) });
        } else if (entry.path.startsWith("/fixture/xdg-config/")) {
          const candidate = `xdg/${entry.path.slice("/fixture/xdg-config/".length)}`;
          loadedCandidates.push(candidate);
          loadedDocuments.push({ path: candidate, marker: entry.info?.mcp?.servers?.["matrix-marker"]?.command?.at(-1) });
        } else if (entry.path.startsWith("/fixture/home/")) {
          const candidate = `home/${entry.path.slice("/fixture/home/".length)}`;
          loadedCandidates.push(candidate);
          loadedDocuments.push({ path: candidate, marker: entry.info?.mcp?.servers?.["matrix-marker"]?.command?.at(-1) });
        } else {
          throw new Error(`unexpected file-backed config source: ${entry.path}`);
        }
      }
      outcomes.push({ version: actualVersion, caseId: item.id, loadedCandidates, loadedDocuments });
      if (config.discovery) {
        const projectDocument = documents.find((entry) => entry.type === "document" && entry.path === "/fixture/project/opencode.json");
        assert.ok(projectDocument, "installed project config was not returned as a document");
        const mcp = projectDocument.info?.mcp?.servers?.["dotknewt-libvirt"];
        assertNormalizedMcpDisabled(mcp);
        assert.equal(mcp?.command?.at(-1), config.expectedEntrypoint);
        const ollama = projectDocument.info?.mcp?.servers?.["dotknewt-ollama"];
        assertNormalizedMcpDisabled(ollama);
        assert.equal(ollama?.command?.at(-1), config.expectedOllamaEntrypoint);
        const kb = projectDocument.info?.mcp?.servers?.["dotknewt-kb"];
        assertKBDiscoveryEvidence(kb, config.expectedKBEntrypoint);
        const configDirectories = documents
          .filter((entry) => entry.type === "directory")
          .map((entry) => entry.path);
        discoveryDiagnostic = {
          location: "/fixture/project",
          count: null,
          skills: [],
          configDirectories,
          fixtureSkills: await inspectExpectedSkillFiles(),
        };
        const pluginInventory = await waitForBuiltinSkillPlugin({
          expectedDirectory: "/fixture/project",
          listPlugins: async (timeoutMs) => {
            const pluginResponse = await fetch(new URL(`/api/plugin?${query}`, base), {
              headers: { authorization }, signal: AbortSignal.timeout(timeoutMs),
            });
            return parseOkJson(pluginResponse, "GET /api/plugin");
          },
        });
        const skillResponse = await fetch(new URL(`/api/skill?${query}`, base), {
          headers: { authorization }, signal: AbortSignal.timeout(15_000),
        });
        const skillBody = await parseOkJson(skillResponse, "GET /api/skill");
        const skillMetadata = skillDiagnostics(skillBody);
        discoveryDiagnostic = {
          ...skillMetadata,
          configDirectories,
          fixtureSkills: discoveryDiagnostic.fixtureSkills,
        };
        validateSkillDiscovery(skillBody, SKILLS, "/fixture/project");
        outcomes[outcomes.length - 1].discoveryEvidence = {
          disabled: mcp.disabled,
          command: mcp.command,
          ollama: { disabled: ollama.disabled, command: ollama.command },
          kb: { disabled: kb.disabled, command: kb.command },
          pluginInventory,
          skills: discoveryDiagnostic,
        };
      }
    } catch (error) {
      failure = error;
      if (config.discovery && error.pluginInventory) {
        discoveryDiagnostic = { ...discoveryDiagnostic, pluginInventory: error.pluginInventory };
      }
    } finally {
      child.stdin.end();
      child.kill("SIGTERM");
      const stopped = await Promise.race([closePromise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]);
      if (!stopped) {
        child.kill("SIGKILL");
        await closePromise;
      }
    }
    if (failure) {
      if (config.discovery) {
        throw new Error(`${failure.message}\nDiscovery diagnostics: ${JSON.stringify(discoveryDiagnostic)}\nOpenCode server stderr (last 8192 chars):\n${stderr}`);
      }
      throw failure;
    }
  }
  process.stdout.write(`${JSON.stringify({ version: actualVersion, outcomes })}\n`);
}

async function runMatrix(opencode) {
  assert.ok(path.isAbsolute(opencode), "--opencode requires an absolute executable path");
  const root = await createTempRoot("/tmp/opencode", "config-matrix-");
  try {
    for (const directory of ["project", "home", "xdg-config", "xdg-data", "xdg-cache", "xdg-state"]) {
      await mkdir(path.join(root, directory), { recursive: true });
    }
    const password = `matrix-${randomBytes(24).toString("hex")}`;
    const fixture = {
      password,
      cases: matrixCases,
      discovery: false,
    };
    const configPath = path.join(root, "driver-config.json");
    await writeFile(configPath, JSON.stringify(fixture));
    const args = buildSandboxArgs({
      node: await realpath(process.execPath),
      opencode: await realpath(opencode),
      driver: await realpath(fileURLToPath(import.meta.url)),
      versionHelper: await realpath(VERSION_HELPER),
      fixture: root,
    });
    args[args.length - 1] = "--inside";
    args.push(await readFile(configPath, "utf8"));
    const result = await command(await assertSandboxAvailable(), args, { cwd: repositoryRoot }, 240_000);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim().split("\n").at(-1));
    validateOpenCodeVersion(output.version);
    assert.equal(output.outcomes.length, matrixCases.length);
    for (const [index, outcome] of output.outcomes.entries()) {
      validateMatrixResult(outcome, { version: output.version, caseId: matrixCases[index].id });
      assert.ok(outcome.loadedCandidates.length > 0, `no candidate config loaded for ${outcome.caseId}`);
      for (const candidate of outcome.loadedCandidates) {
        assert.ok(matrixCases[index].inputCandidates.includes(candidate), `unexpected loaded candidate for ${outcome.caseId}: ${candidate}`);
      }
      assert.deepEqual(outcome.loadedDocuments.map(({ path: loadedPath, marker }) => ({ path: loadedPath, marker })),
        outcome.loadedCandidates.map((candidate) => ({
          path: candidate,
          marker: `matrix-${outcome.caseId}-${matrixCases[index].inputCandidates.indexOf(candidate)}`,
        })), `loaded marker values do not match candidate inputs for ${outcome.caseId}`);
      if (matrixCases[index].inputCandidates.length === 1) {
        assert.deepEqual(outcome.loadedCandidates, matrixCases[index].inputCandidates, `single candidate did not load for ${outcome.caseId}`);
      }
      assert.deepEqual(outcome.loadedCandidates, expectedMeasuredCandidates[index].loadedCandidates,
        `measured candidate order changed for ${outcome.caseId}`);
    }
    console.log(JSON.stringify({ executable: opencode, ...output }, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runDiscovery(opencode, project) {
  assert.ok(path.isAbsolute(opencode) && path.isAbsolute(project), "discovery requires absolute --opencode and --project paths");
  const root = path.dirname(project);
  const relativeProject = path.relative(root, project);
  assert.equal(relativeProject, "project", "project must be the direct project directory under its disposable fixture root");
  const configFile = path.join(project, "opencode.json");
  const source = JSON.parse(await readFile(configFile, "utf8"));
  const mcp = source.mcp?.["dotknewt-libvirt"];
  assert.ok(mcp && Array.isArray(mcp.command), "installed fixture lacks dotknewt-libvirt MCP entry");
  mcp.enabled = false;
  const hostEntrypoint = mcp.command.at(-1);
  const relativeEntrypoint = path.relative(project, hostEntrypoint);
  assert.ok(relativeEntrypoint.startsWith(`.opencode${path.sep}`), "MCP entrypoint must be inside installed project payload");
  const expectedEntrypoint = path.posix.join("/fixture/project", relativeEntrypoint.split(path.sep).join("/"));
  mcp.command[mcp.command.length - 1] = expectedEntrypoint;
  const ollama = source.mcp?.["dotknewt-ollama"];
  assert.ok(ollama && Array.isArray(ollama.command), "installed fixture lacks dotknewt-ollama MCP entry");
  const ollamaRelative = path.relative(project, ollama.command.at(-1));
  assert.ok(ollamaRelative.startsWith(`.opencode${path.sep}`) && !ollamaRelative.split(path.sep).includes(".."));
  const expectedOllamaEntrypoint = path.posix.join("/fixture/project", ollamaRelative.split(path.sep).join("/"));
  ollama.enabled = false;
  ollama.command[ollama.command.length - 1] = expectedOllamaEntrypoint;
  const kb = source.mcp?.["dotknewt-kb"];
  assert.ok(kb && Array.isArray(kb.command), "installed fixture lacks dotknewt-kb MCP entry");
  assert.equal(kb.enabled, false, "KB default must already be disabled, not forced off for discovery");
  assert.equal(kb.command.length, 4, "KB default must be unconfigured");
  const kbHostEntrypoint = kb.command.at(-1);
  assert.ok(path.isAbsolute(kbHostEntrypoint), "KB installed entrypoint must be absolute");
  const kbRelative = path.relative(project, kbHostEntrypoint);
  assert.equal(kbRelative.split(path.sep).join("/"), ".opencode/awesome-opencode/toolkits/kb-toolkit/mcp/kb/server.py");
  const expectedKBEntrypoint = path.posix.join("/fixture/project", kbRelative.split(path.sep).join("/"));
  kb.command[kb.command.length - 1] = expectedKBEntrypoint;
  await writeFile(configFile, `${JSON.stringify(source, null, 2)}\n`);
  for (const directory of ["home", "xdg-config", "xdg-data", "xdg-cache", "xdg-state"]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  const password = `discovery-${randomBytes(24).toString("hex")}`;
  const config = { password, discovery: true, expectedEntrypoint, expectedOllamaEntrypoint, expectedKBEntrypoint, cases: [{ id: "discovery", inputCandidates: [] }] };
  const args = buildSandboxArgs({
    node: await realpath(process.execPath),
    opencode: await realpath(opencode),
    driver: await realpath(fileURLToPath(import.meta.url)),
    versionHelper: await realpath(VERSION_HELPER),
    fixture: root,
  });
  args.push(JSON.stringify(config));
  const result = await command(await assertSandboxAvailable(), args, { cwd: repositoryRoot }, 90_000);
  assert.equal(result.code, 0, result.stderr);
  const evidence = JSON.parse(result.stdout.trim().split("\n").at(-1));
  validateOpenCodeVersion(evidence.version);
  assert.equal(evidence.outcomes.length, 1);
  validateMatrixResult(evidence.outcomes[0], { version: evidence.version, caseId: "discovery" });
  assert.equal(evidence.outcomes[0]?.discoveryEvidence?.disabled, true);
  assert.equal(evidence.outcomes[0]?.discoveryEvidence?.command?.at(-1), expectedEntrypoint);
  assert.equal(evidence.outcomes[0]?.discoveryEvidence?.ollama?.disabled, true);
  assert.equal(evidence.outcomes[0]?.discoveryEvidence?.ollama?.command?.at(-1), expectedOllamaEntrypoint);
  assertKBDiscoveryEvidence(evidence.outcomes[0]?.discoveryEvidence?.kb, expectedKBEntrypoint);
  assert.ok(evidence.outcomes[0]?.discoveryEvidence?.pluginInventory?.plugins?.some((plugin) =>
    plugin.id === "opencode.config.skill" && plugin.sourceType === "builtin" && plugin.status === "active"));
  console.log(JSON.stringify(evidence, null, 2));
  console.log(`PASS: ${evidence.version} discovered five native skills with all three MCP servers disabled in isolated config API`);
}

async function main() {
  if (process.argv[2] === "--inside") return inside();
  const args = process.argv.slice(2);
  const discovery = args.includes("--discovery");
  const opencodeIndex = args.indexOf("--opencode");
  const projectIndex = args.indexOf("--project");
  if (opencodeIndex >= 0 && !args[opencodeIndex + 1]) throw new Error("--opencode requires an executable path");
  const selected = opencodeIndex >= 0 ? args[opencodeIndex + 1] : "opencode";
  const opencode = await resolveOpenCodeExecutable(selected);
  if (discovery) {
    if (projectIndex < 0 || !args[projectIndex + 1]) throw new Error("--discovery requires --project PATH");
    await runDiscovery(opencode, path.resolve(args[projectIndex + 1]));
  } else {
    if (args.some((arg, index) => arg.startsWith("--") && !["--opencode"].includes(arg) && index !== opencodeIndex)) {
      throw new Error("usage: node scripts/check-opencode-config-matrix.mjs [--opencode PATH] [--discovery --project PATH]");
    }
    await runMatrix(opencode);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FAIL: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
