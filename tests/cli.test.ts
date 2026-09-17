import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const cli = path.resolve(import.meta.dirname, "../installer/src/cli.js");

function runCli(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("CLI provides help and rejects ambiguous or missing mutation targets", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-cli-help-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const help = await runCli(["--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /list|install|update|uninstall/);
  assert.match(help.stdout, /--project PATH/);
  assert.match(help.stdout, /--global/);
  assert.match(help.stdout, /--version/);

  const version = await runCli(["--version"]);
  const metadata = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../../package.json"), "utf8"));
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout.trim(), metadata.version);

  const missing = await runCli(["install", "libvirt-toolkit"]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /exactly one of --project PATH or --global/i);

  const ambiguous = await runCli([
    "install",
    "libvirt-toolkit",
    "--project",
    root,
    "--global",
  ]);
  assert.equal(ambiguous.code, 2);
  assert.match(ambiguous.stderr, /exactly one of --project PATH or --global/i);
});

test("CLI project lifecycle reports plans, dry-run, listings, errors, and restart", async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-cli-project-"));
  t.after(() => rm(project, { recursive: true, force: true }));

  const dryRun = await runCli([
    "install",
    "libvirt-toolkit",
    "--project",
    project,
    "--dry-run",
  ]);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /DRY RUN/i);
  assert.match(dryRun.stdout, /install libvirt-toolkit@0\.1\.0/);
  await assert.rejects(access(path.join(project, ".opencode")));

  const install = await runCli(["install", "libvirt-toolkit", "--project", project]);
  assert.equal(install.code, 0, install.stderr);
  assert.match(install.stdout, /install libvirt-toolkit@0\.1\.0/);
  assert.match(install.stdout, /restart OpenCode/i);

  const list = await runCli(["list", "--project", project]);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /libvirt-toolkit\s+0\.1\.0\s+0\.1\.0/);

  const update = await runCli(["update", "--project", project]);
  assert.equal(update.code, 0, update.stderr);
  assert.match(update.stdout, /update libvirt-toolkit@0\.1\.0/);
  assert.match(update.stdout, /restart OpenCode/i);

  const duplicate = await runCli(["install", "libvirt-toolkit", "--project", project]);
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.stderr, /already installed/i);

  const uninstall = await runCli(["uninstall", "libvirt-toolkit", "--project", project]);
  assert.equal(uninstall.code, 0, uninstall.stderr);
  assert.match(uninstall.stdout, /uninstall libvirt-toolkit@0\.1\.0/);
  assert.match(uninstall.stdout, /restart OpenCode/i);
  const config = JSON.parse(await readFile(path.join(project, "opencode.json"), "utf8"));
  assert.deepEqual(config.mcp, {});
});

test("CLI global lifecycle honors XDG_CONFIG_HOME", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-cli-global-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const xdg = path.join(root, "xdg");
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, HOME: path.join(root, "home") };
  const install = await runCli(["install", "libvirt-toolkit", "--global"], { env });
  assert.equal(install.code, 0, install.stderr);
  const configPath = path.join(xdg, "opencode", "opencode.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.mcp["dotknewt-libvirt"].enabled, true);
  assert.match(config.mcp["dotknewt-libvirt"].command.at(-1), new RegExp(`^${xdg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const uninstall = await runCli(["uninstall", "libvirt-toolkit", "--global"], { env });
  assert.equal(uninstall.code, 0, uninstall.stderr);
});
