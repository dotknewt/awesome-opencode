import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function isForbiddenPackedPath(entry: string): boolean {
  return (
    entry.endsWith(".ts") ||
    entry.endsWith(".pyc") ||
    entry.includes(".superpowers") ||
    /(^|\/)(?:\.libvirt-toolkit|__pycache__|\.pytest_cache|\.mypy_cache|plans)(?:\/|$)/.test(entry) ||
    /(^|\/)(?:id_ed25519(?:\.pub)?|connection\.json)$/.test(entry)
  );
}

test("package artifact filter identifies project SSH connection records", () => {
  assert.equal(isForbiddenPackedPath("toolkits/example/connection.json"), true);
});

function command(
  executable: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
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

test("global Git install builds a standalone CLI from clean source", { timeout: 180_000 }, async (t) => {
  const repositoryRoot = path.resolve(import.meta.dirname, "../..");
  const root = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-git-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const prefix = path.join(root, "prefix");
  const cache = path.join(root, "npm-cache");
  const home = path.join(root, "home");
  await Promise.all([source, prefix, cache, home].map((directory) => mkdir(directory)));

  // Copy tracked working-tree files so local fixes are tested without carrying
  // over ignored build output or dependencies from the developer's checkout.
  const tracked = await command("git", ["ls-files", "-z"], { cwd: repositoryRoot });
  assert.equal(tracked.code, 0, tracked.stderr);
  for (const file of tracked.stdout.split("\0").filter(Boolean)) {
    const destination = path.join(source, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(repositoryRoot, file), destination);
  }
  await assert.rejects(access(path.join(source, "dist")), { code: "ENOENT" });
  await assert.rejects(access(path.join(source, "node_modules")), { code: "ENOENT" });

  const env = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Package lifecycle test",
    GIT_AUTHOR_EMAIL: "package-test@example.invalid",
    GIT_COMMITTER_NAME: "Package lifecycle test",
    GIT_COMMITTER_EMAIL: "package-test@example.invalid",
    npm_config_cache: cache,
    npm_config_allow_git: "root",
  };
  // This commit belongs only to the disposable fixture, never the checkout.
  for (const args of [["init"], ["add", "."], ["commit", "-m", "Package lifecycle fixture"]]) {
    const result = await command("git", args, { cwd: source, env });
    assert.equal(result.code, 0, result.stderr);
  }
  const install = await command(
    "npm",
    ["install", "--global", "--prefix", prefix, `git+${pathToFileURL(source).href}`],
    { cwd: root, env },
  );
  assert.equal(install.code, 0, `${install.stdout}\n${install.stderr}`);

  await rm(source, { recursive: true, force: true });
  await rm(cache, { recursive: true, force: true });
  const binary = path.join(prefix, "bin", "awesome-opencode");
  await assert.doesNotReject(access(binary), "Git installation must provide the declared CLI executable");
  const version = await command(binary, ["--version"], { cwd: root, env });
  const metadata = JSON.parse(await readFile(path.join(prefix, "lib", "node_modules", "awesome-opencode", "package.json"), "utf8"));
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout.trim(), metadata.version);
  const validate = await command(binary, ["validate"], { cwd: root, env });
  assert.equal(validate.code, 0, validate.stderr);
});

test("real npm tarball remains functional after disposable package source removal", { timeout: 180_000 }, async (t) => {
  const repositoryRoot = path.resolve(import.meta.dirname, "../..");
  const root = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packed = path.join(root, "packed");
  const disposable = path.join(root, "disposable-source");
  const consumer = path.join(root, "consumer");
  const project = path.join(root, "project");
  const globalRoot = path.join(root, "global-config");
  await Promise.all([
    mkdir(packed, { recursive: true }),
    mkdir(disposable, { recursive: true }),
    mkdir(consumer, { recursive: true }),
    mkdir(project, { recursive: true }),
  ]);

  const pack = await command("npm", ["pack", "--json", "--pack-destination", packed], { cwd: repositoryRoot });
  assert.equal(pack.code, 0, pack.stderr);
  const jsonStart = pack.stdout.indexOf("{");
  assert.notEqual(jsonStart, -1, pack.stdout);
  const parsedPack = JSON.parse(pack.stdout.slice(jsonStart)) as
    | Array<{ filename: string; files: Array<{ path: string }> }>
    | Record<string, { filename: string; files: Array<{ path: string }> }>;
  const packResult = Array.isArray(parsedPack) ? parsedPack[0]! : Object.values(parsedPack)[0]!;
  const archive = path.join(packed, packResult.filename);
  const packedPaths = packResult.files.map((file) => file.path);
  assert.ok(packedPaths.includes("dist/installer/src/cli.js"));
  assert.ok(packedPaths.includes("LICENSE"));
  assert.ok(packedPaths.includes("docs/architecture.md"));
  assert.ok(packedPaths.includes("toolkits/libvirt-toolkit/mcp/libvirt/libvirt_mcp/server.py"));
  assert.ok(
    packedPaths.includes(
      "toolkits/libvirt-toolkit/skills/dotknewt-guest-access/scripts/project_ssh.py",
    ),
  );
  assert.ok(
    packedPaths.includes("toolkits/project-toolkit/skills/dotknewt-handling-todos/SKILL.md"),
  );
  assert.equal(packedPaths.some((entry) => /(^|\/)tests\//.test(entry)), false);
  assert.equal(packedPaths.some((entry) => /(^|\/)evals\//.test(entry)), false);
  assert.equal(
    packedPaths.some(isForbiddenPackedPath),
    false,
  );

  const extract = await command("tar", ["-xzf", archive, "-C", disposable], { cwd: root });
  assert.equal(extract.code, 0, extract.stderr);
  const install = await command(
    "npm",
    ["install", "--ignore-scripts", "--install-links=true", path.join(disposable, "package")],
    { cwd: consumer },
  );
  assert.equal(install.code, 0, install.stderr);
  await rm(disposable, { recursive: true, force: true });
  await rm(archive, { force: true });

  const binary = path.join(consumer, "node_modules", ".bin", "awesome-opencode");
  await access(binary);
  const packagedRoot = path.join(consumer, "node_modules", "awesome-opencode");
  const run = (args: string[], env = process.env) => command(binary, args, { cwd: consumer, env });

  const version = await run(["--version"]);
  const installedMetadata = JSON.parse(await readFile(path.join(packagedRoot, "package.json"), "utf8"));
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout.trim(), installedMetadata.version);

  const validate = await run(["validate"]);
  assert.equal(validate.code, 0, validate.stderr);
  const projectInstall = await run(["install", "libvirt-toolkit", "--project", project]);
  assert.equal(projectInstall.code, 0, projectInstall.stderr);
  const projectToolkitInstall = await run(["install", "project-toolkit", "--project", project]);
  assert.equal(projectToolkitInstall.code, 0, projectToolkitInstall.stderr);
  const projectUpdate = await run(["update", "--project", project]);
  assert.equal(projectUpdate.code, 0, projectUpdate.stderr);

  const globalEnv = {
    ...process.env,
    XDG_CONFIG_HOME: globalRoot,
    HOME: path.join(root, "isolated-home"),
  };
  const globalInstall = await run(["install", "libvirt-toolkit", "--global"], globalEnv);
  assert.equal(globalInstall.code, 0, globalInstall.stderr);
  const globalProjectToolkitInstall = await run(["install", "project-toolkit", "--global"], globalEnv);
  assert.equal(globalProjectToolkitInstall.code, 0, globalProjectToolkitInstall.stderr);
  const globalUpdate = await run(["update", "--global"], globalEnv);
  assert.equal(globalUpdate.code, 0, globalUpdate.stderr);
  const globalUninstall = await run(
    ["uninstall", "libvirt-toolkit", "project-toolkit", "--global"],
    globalEnv,
  );
  assert.equal(globalUninstall.code, 0, globalUninstall.stderr);

  const configPath = path.join(project, "opencode.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const server = config.mcp["dotknewt-libvirt"].command.at(-1) as string;
  assert.equal(path.isAbsolute(server), true);
  await access(server);
  for (const skill of ["dotknewt-libvirt-vms", "dotknewt-guest-access"]) {
    const skillFile = path.join(project, ".opencode", "skills", skill, "SKILL.md");
    const source = await readFile(skillFile, "utf8");
    assert.match(source, new RegExp(`name: ${skill}`));
  }
  const todoSkill = path.join(
    project,
    ".opencode",
    "skills",
    "dotknewt-handling-todos",
    "SKILL.md",
  );
  assert.match(await readFile(todoSkill, "utf8"), /name: dotknewt-handling-todos/);

  const helper = path.join(
    project,
    ".opencode",
    "skills",
    "dotknewt-guest-access",
    "scripts",
    "project_ssh.py",
  );
  await access(helper);
  const prepare = await command(
    "python3",
    [
      helper,
      "prepare",
      "--project-root",
      project,
      "--vm-name",
      "package-test-vm",
      "--provider",
      "libvirt",
      "--guest-user",
      "developer",
    ],
    { cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  assert.equal(prepare.code, 0, prepare.stderr);
  const preparedCredential = JSON.parse(prepare.stdout) as {
    status: string;
    vm_uuid: string | null;
    credential_dir: string;
    private_key_path: string;
    public_key_path: string;
  };
  assert.equal(preparedCredential.status, "pending");
  assert.equal(preparedCredential.vm_uuid, null);
  assert.equal(
    path.relative(project, preparedCredential.credential_dir).startsWith(".libvirt-toolkit/ssh/"),
    true,
  );
  await Promise.all([
    access(preparedCredential.private_key_path),
    access(preparedCredential.public_key_path),
  ]);

  const serverRoot = path.dirname(server);
  const compile = await command("python3", ["-m", "compileall", "-q", serverRoot], { cwd: root });
  assert.equal(compile.code, 0, compile.stderr);
  const importModules = await command(
    "python3",
    ["-c", "import libvirt_mcp.commands, libvirt_mcp.errors, libvirt_mcp.store"],
    { cwd: root, env: { ...process.env, PYTHONPATH: serverRoot, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  assert.equal(importModules.code, 0, importModules.stderr);

  await t.test("packaged PEP 723 server imports under uv without starting MCP", async (uvTest) => {
    let uvVersion: CommandResult;
    try {
      uvVersion = await command("uv", ["--version"], { cwd: root });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        uvTest.skip("uv is unavailable; install uv or provide its pinned dependencies to run packaged server acceptance");
        return;
      }
      throw error;
    }
    assert.equal(uvVersion.code, 0, uvVersion.stderr);
    const uvRoot = path.join(root, "uv-isolated");
    const serverHelp = await command(
      "uv",
      ["run", "--isolated", "--python", "3.13", "--with", "mcp==2.2.0", "--script", server, "--help"],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: path.join(uvRoot, "home"),
          XDG_CONFIG_HOME: path.join(uvRoot, "config"),
          XDG_DATA_HOME: path.join(uvRoot, "data"),
          XDG_CACHE_HOME: path.join(uvRoot, "cache"),
          UV_CACHE_DIR: path.join(uvRoot, "uv-cache"),
          PYTHONDONTWRITEBYTECODE: "1",
        },
      },
    );
    assert.equal(serverHelp.code, 0, serverHelp.stderr);
    assert.match(serverHelp.stdout, /Run the libvirt toolkit MCP server over stdio/);
  });

  await rename(path.join(packagedRoot, "toolkits"), path.join(packagedRoot, "toolkits.unavailable"));
  const list = await run(["list", "--project", project]);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /libvirt-toolkit\s+-\s+0\.2\.0/);
  assert.match(list.stdout, /project-toolkit\s+-\s+0\.1\.0/);
  const uninstall = await run(
    ["uninstall", "libvirt-toolkit", "project-toolkit", "--project", project],
  );
  assert.equal(uninstall.code, 0, uninstall.stderr);
  assert.match(uninstall.stdout, /uninstall libvirt-toolkit@0\.2\.0/);
  assert.match(uninstall.stdout, /uninstall project-toolkit@0\.1\.0/);
  await assert.rejects(access(server));
  await assert.rejects(access(todoSkill));
});
