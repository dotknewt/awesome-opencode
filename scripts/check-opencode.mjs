#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020Module from "ajv/dist/2020.js";
import { readOpenCodeVersion, resolveOpenCodeExecutable } from "./opencode-version.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultInstaller = path.join(repositoryRoot, "dist", "installer", "src", "cli.js");
const matrixRunner = path.join(repositoryRoot, "scripts", "check-opencode-config-matrix.mjs");

function command(executable, args, options, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, options);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr, error }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

export function parseArguments(argv) {
  const mode = argv.shift();
  if (!mode || !["schema", "discovery"].includes(mode)) {
    throw new Error("usage: node scripts/check-opencode.mjs <schema|discovery> [--installer PATH] [--opencode PATH]");
  }
  let installer = defaultInstaller;
  let opencode;
  while (argv.length > 0) {
    const option = argv.shift();
    const value = argv.shift();
    if (!value) throw new Error(`${option} requires a path`);
    if (option === "--installer") installer = path.resolve(value);
    else if (option === "--opencode") opencode = value;
    else throw new Error(`unknown option: ${option}`);
  }
  return { mode, installer, opencode };
}

async function isolatedInstall(installer) {
  const tempBase = "/tmp/opencode";
  await mkdir(tempBase, { recursive: true });
  const root = await mkdtemp(path.join(tempBase, "awesome-opencode-native-check-"));
  const project = path.join(root, "project");
  await mkdir(project, { recursive: true });
  const installed = await command(process.execPath, [installer, "install", "libvirt-toolkit", "project-toolkit", "ollama-toolkit", "kb-toolkit", "--project", project], {
    cwd: repositoryRoot,
    env: process.env,
  });
  assert.equal(installed.code, 0, installed.stderr || installed.error?.message);
  const configPath = path.join(project, "opencode.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  return { root, project, configPath, config };
}

async function checkSchema(installer) {
  const fixture = await isolatedInstall(installer);
  try {
    let response;
    try { response = await fetch("https://opencode.ai/config.json"); }
    catch (error) {
      console.log(`SKIP: public OpenCode schema is unavailable: ${error.message}`);
      process.exitCode = 77;
      return;
    }
    if (!response.ok) {
      console.log(`SKIP: public OpenCode schema returned HTTP ${response.status}`);
      process.exitCode = 77;
      return;
    }
    const schema = await response.json();
    const localMcpSchema = schema?.$defs?.McpLocalConfig;
    assert.ok(localMcpSchema, "public schema does not define $defs.McpLocalConfig");
    assert.equal(fixture.config.$schema, "https://opencode.ai/config.json");
    const Ajv2020 = Ajv2020Module.default;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validate = ajv.compile(localMcpSchema);
    for (const name of ["dotknewt-libvirt", "dotknewt-ollama", "dotknewt-kb"]) {
      const entry = fixture.config.mcp?.[name];
      assert.equal(validate(entry), true, ajv.errorsText(validate.errors));
      assert.deepEqual(entry.command.slice(0, 3), ["uv", "run", "--script"]);
      assert.equal(path.isAbsolute(entry.command[3]), true);
      console.log(`PASS: generated ${name} entry validates against public OpenCode $defs.McpLocalConfig`);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function checkDiscovery(installer, opencode) {
  const executable = await resolveOpenCodeExecutable(opencode ?? "opencode");
  const version = readOpenCodeVersion(executable);
  const fixture = await isolatedInstall(installer);
  try {
    const result = await command(process.execPath, [matrixRunner, "--discovery", "--opencode", executable, "--project", fixture.project], {
      cwd: repositoryRoot,
      env: { PATH: process.env.PATH },
    }, 120_000);
    assert.equal(result.code, 0, result.stderr);
    const evidence = JSON.parse(result.stdout.slice(0, result.stdout.lastIndexOf("\nPASS:")));
    assert.equal(evidence.version, version, "discovery version differs from preflight version");
    assert.equal(evidence.outcomes.length, 1);
    assert.equal(evidence.outcomes[0].version, version, "discovery outcome differs from preflight version");
    process.stdout.write(`OpenCode version verified: ${version}\n`);
    process.stdout.write(result.stdout);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.mode === "schema") await checkSchema(options.installer);
  else await checkDiscovery(options.installer, options.opencode);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FAIL: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
