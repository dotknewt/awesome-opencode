#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020Module from "ajv/dist/2020.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultInstaller = path.join(repositoryRoot, "dist", "installer", "src", "cli.js");

function command(executable, args, options) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ code: null, stdout, stderr, error }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseArguments(argv) {
  const mode = argv.shift();
  if (!mode || !["schema", "discovery"].includes(mode)) {
    throw new Error("usage: node scripts/check-opencode.mjs <schema|discovery> [--installer PATH] [--opencode PATH]");
  }
  let installer = defaultInstaller;
  let opencode = "opencode";
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
  const root = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-native-check-"));
  const project = path.join(root, "project");
  await mkdir(project, { recursive: true });
  const installed = await command(process.execPath, [installer, "install", "libvirt-toolkit", "--project", project], {
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
    try {
      response = await fetch("https://opencode.ai/config.json");
    } catch (error) {
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
    const entry = fixture.config.mcp?.["dotknewt-libvirt"];
    assert.equal(validate(entry), true, ajv.errorsText(validate.errors));
    assert.deepEqual(entry.command.slice(0, 3), ["uv", "run", "--script"]);
    assert.equal(path.isAbsolute(entry.command[3]), true);
    console.log("PASS: generated dotknewt-libvirt entry validates against public OpenCode $defs.McpLocalConfig");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function checkDiscovery(installer, opencode) {
  const probeRoot = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-cli-probe-"));
  const probeEnv = {
    PATH: process.env.PATH,
    HOME: path.join(probeRoot, "home"),
    XDG_CONFIG_HOME: path.join(probeRoot, "xdg-config"),
    XDG_DATA_HOME: path.join(probeRoot, "xdg-data"),
    XDG_CACHE_HOME: path.join(probeRoot, "xdg-cache"),
    XDG_STATE_HOME: path.join(probeRoot, "xdg-state"),
    LANG: process.env.LANG ?? "C.UTF-8",
    NO_COLOR: "1",
  };
  const version = await command(opencode, ["--version"], { env: probeEnv });
  if (version.error?.code === "ENOENT") {
    await rm(probeRoot, { recursive: true, force: true });
    console.log(`SKIP: OpenCode CLI is unavailable: ${opencode}`);
    process.exitCode = 77;
    return;
  }
  assert.equal(version.code, 0, version.stderr);
  const help = await command(opencode, ["--help"], { env: probeEnv });
  await rm(probeRoot, { recursive: true, force: true });
  assert.equal(help.code, 0, help.stderr);
  const helpText = `${help.stdout}\n${help.stderr}`;
  assert.match(helpText, /--pure/);
  assert.match(helpText, /debug/);

  const fixture = await isolatedInstall(installer);
  try {
    fixture.config.mcp["dotknewt-libvirt"].enabled = false;
    fixture.config.plugin = [];
    fixture.config.enabled_providers = [];
    fixture.config.skills = { paths: [], urls: [] };
    await writeFile(fixture.configPath, `${JSON.stringify(fixture.config, null, 2)}\n`);
    const isolatedHome = path.join(fixture.root, "home");
    const env = {
      PATH: process.env.PATH,
      HOME: isolatedHome,
      XDG_CONFIG_HOME: path.join(fixture.root, "xdg-config"),
      XDG_DATA_HOME: path.join(fixture.root, "xdg-data"),
      XDG_CACHE_HOME: path.join(fixture.root, "xdg-cache"),
      XDG_STATE_HOME: path.join(fixture.root, "xdg-state"),
      LANG: process.env.LANG ?? "C.UTF-8",
      NO_COLOR: "1",
    };
    const skills = await command(opencode, ["debug", "skill", "--pure"], { cwd: fixture.project, env });
    assert.equal(skills.code, 0, skills.stderr);
    for (const name of ["dotknewt-libvirt-vms", "dotknewt-guest-access"]) {
      assert.match(skills.stdout, new RegExp(name));
      assert.match(skills.stdout, new RegExp(path.join(fixture.project, ".opencode", "skills", name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    const resolved = await command(opencode, ["debug", "config", "--pure"], { cwd: fixture.project, env });
    assert.equal(resolved.code, 0, resolved.stderr);
    const resolvedConfig = JSON.parse(resolved.stdout);
    assert.equal(resolvedConfig.mcp?.["dotknewt-libvirt"]?.enabled, false);
    assert.equal(resolvedConfig.mcp?.["dotknewt-libvirt"]?.command?.at(-1), fixture.config.mcp["dotknewt-libvirt"].command.at(-1));
    console.log(`PASS: OpenCode ${version.stdout.trim()} discovered two native skills with MCP disabled in an isolated environment`);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === "schema") await checkSchema(options.installer);
  else await checkDiscovery(options.installer, options.opencode);
} catch (error) {
  console.error(`FAIL: ${error.stack ?? error.message}`);
  process.exitCode = 1;
}
