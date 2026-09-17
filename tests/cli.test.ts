import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
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
  assert.match(dryRun.stdout, /install libvirt-toolkit@0\.2\.0/);
  await assert.rejects(access(path.join(project, ".opencode")));

  const install = await runCli(["install", "libvirt-toolkit", "--project", project]);
  assert.equal(install.code, 0, install.stderr);
  assert.match(install.stdout, /install libvirt-toolkit@0\.2\.0/);
  assert.match(install.stdout, /restart OpenCode/i);

  const list = await runCli(["list", "--project", project]);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /libvirt-toolkit\s+0\.2\.0\s+0\.2\.0/);

  const update = await runCli(["update", "--project", project]);
  assert.equal(update.code, 0, update.stderr);
  assert.match(update.stdout, /update libvirt-toolkit@0\.2\.0/);
  assert.match(update.stdout, /restart OpenCode/i);

  const duplicate = await runCli(["install", "libvirt-toolkit", "--project", project]);
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.stderr, /already installed/i);

  const uninstall = await runCli(["uninstall", "libvirt-toolkit", "--project", project]);
  assert.equal(uninstall.code, 0, uninstall.stderr);
  assert.match(uninstall.stdout, /uninstall libvirt-toolkit@0\.2\.0/);
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

test("CLI preserves consumer files and protects local edits through the project-toolkit lifecycle", async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-cli-project-toolkit-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const agentsPath = path.join(project, "AGENTS.md");
  const configPath = path.join(project, "opencode.json");
  await writeFile(agentsPath, "# Consumer instructions\n");
  await writeFile(configPath, '{"$schema":"https://opencode.ai/config.json","username":"consumer"}\n');

  const dryRun = await runCli(["install", "project-toolkit", "--project", project, "--dry-run"]);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /DRY RUN/i);
  assert.match(dryRun.stdout, /install project-toolkit@0\.1\.0/);
  await assert.rejects(access(path.join(project, ".opencode")));
  assert.equal(await readFile(agentsPath, "utf8"), "# Consumer instructions\n");
  assert.equal(await readFile(configPath, "utf8"), '{"$schema":"https://opencode.ai/config.json","username":"consumer"}\n');

  const install = await runCli(["install", "project-toolkit", "--project", project]);
  assert.equal(install.code, 0, install.stderr);
  assert.match(install.stdout, /install project-toolkit@0\.1\.0/);
  assert.match(install.stdout, /restart OpenCode/i);
  const skillPath = path.join(project, ".opencode", "skills", "dotknewt-handling-todos", "SKILL.md");
  const installedSkill = await readFile(skillPath, "utf8");
  assert.match(installedSkill, /name: dotknewt-handling-todos/);
  assert.equal(await readFile(agentsPath, "utf8"), "# Consumer instructions\n");
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).username, "consumer");

  const list = await runCli(["list", "--project", project]);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /project-toolkit\s+0\.1\.0\s+0\.1\.0/);
  const update = await runCli(["update", "project-toolkit", "--project", project]);
  assert.equal(update.code, 0, update.stderr);
  assert.match(update.stdout, /update project-toolkit@0\.1\.0/);

  await writeFile(skillPath, `${installedSkill}\nLocal consumer edit.\n`);
  const conflict = await runCli(["update", "project-toolkit", "--project", project]);
  assert.equal(conflict.code, 1);
  assert.match(conflict.stderr, /modified.*owned/i);
  await writeFile(skillPath, installedSkill);

  const uninstall = await runCli(["uninstall", "project-toolkit", "--project", project]);
  assert.equal(uninstall.code, 0, uninstall.stderr);
  assert.match(uninstall.stdout, /uninstall project-toolkit@0\.1\.0/);
  await assert.rejects(access(skillPath));
  assert.equal(await readFile(agentsPath, "utf8"), "# Consumer instructions\n");
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).username, "consumer");
});

test("CLI project-toolkit global lifecycle honors the isolated global selector", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-cli-project-toolkit-global-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const xdg = path.join(root, "xdg");
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, HOME: path.join(root, "home") };

  const install = await runCli(["install", "project-toolkit", "--global"], { env });
  assert.equal(install.code, 0, install.stderr);
  const skillPath = path.join(xdg, "opencode", "skills", "dotknewt-handling-todos", "SKILL.md");
  assert.match(await readFile(skillPath, "utf8"), /name: dotknewt-handling-todos/);
  const list = await runCli(["list", "--global"], { env });
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /project-toolkit\s+0\.1\.0\s+0\.1\.0/);
  const update = await runCli(["update", "project-toolkit", "--global"], { env });
  assert.equal(update.code, 0, update.stderr);
  const uninstall = await runCli(["uninstall", "project-toolkit", "--global"], { env });
  assert.equal(uninstall.code, 0, uninstall.stderr);
  await assert.rejects(access(skillPath));
});

test("CLI skill-only global lifecycle ignores and preserves a dotfiles config symlink", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-cli-symlinked-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const xdg = path.join(root, "xdg");
  const configDirectory = path.join(xdg, "opencode");
  const dotfilesConfig = path.join(root, "dotfiles", "opencode.json");
  const configPath = path.join(configDirectory, "opencode.json");
  await mkdir(path.dirname(dotfilesConfig), { recursive: true });
  await mkdir(configDirectory, { recursive: true });
  await writeFile(dotfilesConfig, '{"theme":"consumer"}\n');
  await symlink(dotfilesConfig, configPath);
  const originalTarget = await readlink(configPath);
  const originalBytes = await readFile(dotfilesConfig, "utf8");
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, HOME: path.join(root, "home") };

  const dryRun = await runCli(["install", "project-toolkit", "--global", "--dry-run"], { env });
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /DRY RUN/i);
  await assert.rejects(access(path.join(configDirectory, "awesome-opencode")));

  const install = await runCli(["install", "project-toolkit", "--global"], { env });
  assert.equal(install.code, 0, install.stderr);
  const skillPath = path.join(configDirectory, "skills", "dotknewt-handling-todos", "SKILL.md");
  const installedSkill = await readFile(skillPath, "utf8");
  assert.match(installedSkill, /name: dotknewt-handling-todos/);

  const list = await runCli(["list", "--global"], { env });
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /project-toolkit\s+0\.1\.0\s+0\.1\.0/);
  assert.equal((await runCli(["update", "project-toolkit", "--global"], { env })).code, 0);
  assert.equal((await runCli(["update", "--global"], { env })).code, 0);

  await writeFile(skillPath, `${installedSkill}\nLocal consumer edit.\n`);
  const conflict = await runCli(["update", "project-toolkit", "--global"], { env });
  assert.equal(conflict.code, 1);
  assert.match(conflict.stderr, /modified.*owned/i);
  await writeFile(skillPath, installedSkill);

  const uninstall = await runCli(["uninstall", "project-toolkit", "--global"], { env });
  assert.equal(uninstall.code, 0, uninstall.stderr);
  assert.equal((await lstat(configPath)).isSymbolicLink(), true);
  assert.equal(await readlink(configPath), originalTarget);
  assert.equal(await readFile(dotfilesConfig, "utf8"), originalBytes);
  await assert.rejects(access(path.join(configDirectory, "opencode.jsonc")));
});

test("CLI skill-only project lifecycle ignores and preserves a dotfiles config symlink", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-cli-project-symlinked-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const dotfilesConfig = path.join(root, "dotfiles", "opencode.jsonc");
  const configPath = path.join(project, "opencode.jsonc");
  await mkdir(path.dirname(dotfilesConfig), { recursive: true });
  await mkdir(project);
  await writeFile(dotfilesConfig, '{"theme":"consumer-project"}\n');
  await symlink(dotfilesConfig, configPath);

  assert.equal((await runCli(["install", "project-toolkit", "--project", project, "--dry-run"])).code, 0);
  await assert.rejects(access(path.join(project, ".opencode")));
  assert.equal((await runCli(["install", "project-toolkit", "--project", project])).code, 0);
  assert.equal((await runCli(["list", "--project", project])).code, 0);
  assert.equal((await runCli(["update", "--project", project])).code, 0);
  assert.equal((await runCli(["uninstall", "project-toolkit", "--project", project])).code, 0);

  assert.equal((await lstat(configPath)).isSymbolicLink(), true);
  assert.equal(await readlink(configPath), dotfilesConfig);
  assert.equal(await readFile(dotfilesConfig, "utf8"), '{"theme":"consumer-project"}\n');
  await assert.rejects(access(path.join(project, "opencode.json")));
});
