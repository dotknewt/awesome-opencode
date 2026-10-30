import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { checkInstalledOllama } from "./fixtures/installed-ollama.js";
import { checkInstalledKB, kbRuntimeFiles } from "./fixtures/installed-kb.js";

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

const kbPackedFiles = ["toolkit.json", "README.md", "CHANGELOG.md", "PROVENANCE.md",
  "skills/dotknewt-kb-read/SKILL.md", ...kbRuntimeFiles.map(file => `mcp/kb/${file}`)]
  .map(file => `toolkits/kb-toolkit/${file}`);

function assertKBPackedFiles(packedPaths: string[]): void {
  assert.deepEqual(packedPaths.filter(entry => entry.startsWith("toolkits/kb-toolkit/")).sort(),
    [...kbPackedFiles].sort(), "KB tarball must contain exactly the complete reviewed toolkit tree");
}

for (const extra of ["private-record.md", ".env", "operator/config.json", "skills/dotknewt-kb-read/private.md"]) {
  test(`KB complete tarball allowlist rejects unexpected ${extra}`, () => {
    assert.throws(() => assertKBPackedFiles([...kbPackedFiles, `toolkits/kb-toolkit/${extra}`]));
  });
}
for (const missing of ["README.md", "CHANGELOG.md", "PROVENANCE.md"]) {
  test(`KB complete tarball allowlist requires ${missing}`, () => {
    assert.throws(() => assertKBPackedFiles(kbPackedFiles.filter(file => file !== `toolkits/kb-toolkit/${missing}`)));
  });
}
test("KB complete tarball allowlist accepts only the reviewed tree", () => {
  assert.doesNotThrow(() => assertKBPackedFiles([...kbPackedFiles, "LICENSE"]));
});

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

async function copyFixtureFiles(repositoryRoot: string, source: string, files: string[]): Promise<void> {
  for (const file of files) {
    const destination = path.join(source, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(repositoryRoot, file), destination);
  }
}

async function copyTrackedFixture(repositoryRoot: string, source: string): Promise<void> {
  const tracked = await command("git", ["ls-files", "-z"], { cwd: repositoryRoot });
  assert.equal(tracked.code, 0, tracked.stderr);
  await copyFixtureFiles(repositoryRoot, source, tracked.stdout.split("\0").filter(Boolean));
}

test("KB clean Git fixture selection excludes untracked files", async (t) => {
  const root = await mkdtemp("/tmp/opencode/kb-tracked-fixture-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository");
  const source = path.join(root, "source");
  await mkdir(path.join(repository, "toolkits/kb-toolkit"), { recursive: true });
  await mkdir(path.join(repository, "tests/fixtures"), { recursive: true });
  await mkdir(source);
  const tracked = "toolkits/kb-toolkit/toolkit.json";
  await writeFile(path.join(repository, tracked), "tracked fixture");
  for (const file of ["toolkits/kb-toolkit/private-record.md", "tests/fixtures/installed-kb.ts"]) {
    await writeFile(path.join(repository, file), "untracked sentinel");
  }
  // Only this disposable repository's index is modified; never the checkout.
  for (const args of [["init"], ["add", "--", tracked]]) {
    const result = await command("git", args, { cwd: repository });
    assert.equal(result.code, 0, result.stderr);
  }
  await copyTrackedFixture(repository, source);
  assert.equal(await readFile(path.join(source, tracked), "utf8"), "tracked fixture");
  for (const file of ["toolkits/kb-toolkit/private-record.md", "tests/fixtures/installed-kb.ts"]) {
    await assert.rejects(access(path.join(source, file)), { code: "ENOENT" });
  }
});

test("KB tarball installs isolated read-only runtimes in both scopes and preserves external sources", { timeout: 240_000 }, async (t) => {
  const repositoryRoot = path.resolve(import.meta.dirname, "../..");
  const root = await mkdtemp("/tmp/opencode/kb-package-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), UV_CACHE_DIR: path.join(root, "uv-cache"),
    PYTHONDONTWRITEBYTECODE: "1" };
  await mkdir(env.HOME);
  const pack = await command("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: repositoryRoot, env });
  assert.equal(pack.code, 0, pack.stderr);
  const parsed = JSON.parse(pack.stdout);
  const artifact = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0] as any;
  const packedPaths: string[] = artifact.files.map((file: { path: string }) => file.path);
  assertKBPackedFiles(packedPaths);
  assert.equal(packedPaths.some(isForbiddenPackedPath), false);
  assert.equal(packedPaths.some(entry => /(^|\/)(tests|evals)\//.test(entry)), false);
  const extract = await command("tar", ["-xzf", path.join(root, artifact.filename), "-C", root], { cwd: root, env });
  assert.equal(extract.code, 0, extract.stderr);
  const packageRoot = path.join(root, "package");
  const installDependencies = await command("npm", ["install", "--omit=dev", "--ignore-scripts"], { cwd: packageRoot, env });
  assert.equal(installDependencies.code, 0, installDependencies.stderr);
  const cli = path.join(packageRoot, "dist/installer/src/cli.js");
  const run = (args: string[]) => command(process.execPath, [cli, ...args], { cwd: root, env });
  const project = path.join(root, "project");
  await mkdir(project);
  for (const scope of [["--project", project], ["--global"]]) {
    const installed = await run(["install", "kb-toolkit", ...scope]);
    assert.equal(installed.code, 0, installed.stderr);
  }
  // Remove every packaged source asset before launching; no checkout imports or CWD.
  await rm(path.join(packageRoot, "toolkits"), { recursive: true });
  const preserved: Array<{ file: string; content: string }> = [];
  for (const [configRoot, payloadRoot, namespace] of [
    [project, path.join(project, ".opencode"), "intel"],
    [path.join(env.XDG_CONFIG_HOME, "opencode"), path.join(env.XDG_CONFIG_HOME, "opencode"), "future"],
  ]) preserved.push(...await checkInstalledKB(configRoot!, payloadRoot!, root, namespace!, env));
  for (const scope of [["--project", project], ["--global"]]) {
    const removed = await run(["uninstall", "kb-toolkit", ...scope]);
    assert.equal(removed.code, 0, removed.stderr);
  }
  for (const { file, content } of preserved) assert.equal(await readFile(file, "utf8"), content, file);
  for (const configRoot of [project, path.join(env.XDG_CONFIG_HOME, "opencode")]) {
    const config = JSON.parse(await readFile(path.join(configRoot, "opencode.json"), "utf8"));
    assert.equal(config.mcp["dotknewt-kb"], undefined);
    assert.equal(Object.keys(config.mcp).filter(name => name.startsWith("fixture-kb-")).length, 1);
  }
  for (const payloadRoot of [path.join(project, ".opencode"), path.join(env.XDG_CONFIG_HOME, "opencode")]) {
    await assert.rejects(access(path.join(payloadRoot, "awesome-opencode/toolkits/kb-toolkit/mcp/kb/server.py")), { code: "ENOENT" });
    await assert.rejects(access(path.join(payloadRoot, "skills/dotknewt-kb-read/SKILL.md")), { code: "ENOENT" });
  }
});

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
  await copyTrackedFixture(repositoryRoot, source);
  // Include the build-time helper even before it is added to the Git index.
  await copyFixtureFiles(repositoryRoot, source, ["bin/awesome-opencode.js", "bun.lock", "tests/fixtures/installed-ollama.ts"]);
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

test("global Git install via Bun builds a standalone CLI from clean source", { timeout: 180_000 }, async (t) => {
  const repositoryRoot = path.resolve(import.meta.dirname, "../..");
  const root = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-bun-git-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const bunInstall = path.join(root, "bun-install");
  const bunGlobal = path.join(root, "bun-global");
  const bunBin = path.join(root, "bun-bin");
  const cache = path.join(root, "bun-cache");
  const home = path.join(root, "home");
  const xdgConfig = path.join(root, "xdg-config");
  await Promise.all(
    [source, bunInstall, bunGlobal, bunBin, cache, home, xdgConfig].map((directory) => mkdir(directory)),
  );

  // Copy tracked working-tree files so local fixes are tested without carrying
  // over ignored build output or dependencies from the developer's checkout.
  await copyTrackedFixture(repositoryRoot, source);
  // Include the build-time helper even before it is added to the Git index.
  await copyFixtureFiles(repositoryRoot, source, ["bin/awesome-opencode.js", "bun.lock", "tests/fixtures/installed-ollama.ts"]);
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
    BUN_INSTALL: bunInstall,
    BUN_INSTALL_GLOBAL_DIR: bunGlobal,
    BUN_INSTALL_BIN: bunBin,
    BUN_INSTALL_CACHE_DIR: cache,
    XDG_CONFIG_HOME: xdgConfig,
  };
  // This commit belongs only to the disposable fixture, never the checkout.
  for (const args of [["init"], ["add", "."], ["commit", "-m", "Package lifecycle fixture"]]) {
    const result = await command("git", args, { cwd: source, env });
    assert.equal(result.code, 0, result.stderr);
  }
  const install = await command(
    "bun",
    ["install", "--global", "--trust", `git+${pathToFileURL(source).href}`],
    { cwd: root, env },
  );
  assert.equal(install.code, 0, `${install.stdout}\n${install.stderr}`);

  await rm(source, { recursive: true, force: true });
  await rm(cache, { recursive: true, force: true });
  const binary = path.join(bunBin, "awesome-opencode");
  await assert.doesNotReject(access(binary), "Bun Git installation must provide the declared CLI executable");
  const version = await command(binary, ["--version"], { cwd: root, env });
  const metadata = JSON.parse(
    await readFile(path.join(bunGlobal, "node_modules", "awesome-opencode", "package.json"), "utf8"),
  );
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
  assert.ok(packedPaths.includes("bin/awesome-opencode.js"));
  assert.ok(packedPaths.includes("LICENSE"));
  for (const file of ["toolkit.json", "skills/dotknewt-ollama-name-cleanup/SKILL.md", "mcp/ollama/server.py", "mcp/ollama/ollama_mcp/cleanup.py", "mcp/ollama/ollama_mcp/server.py"]) {
    assert.ok(packedPaths.includes(`toolkits/ollama-toolkit/${file}`), file);
  }
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
  const consumerEnv = { ...process.env };
  delete consumerEnv.npm_config_allow_scripts;
  const install = await command(
    "npm",
    ["install", "--ignore-scripts", "--install-links=true", path.join(disposable, "package")],
    { cwd: consumer, env: consumerEnv },
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
  const ollamaInstall = await run(["install", "ollama-toolkit", "--project", project]);
  assert.equal(ollamaInstall.code, 0, ollamaInstall.stderr);
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
  const globalOllamaInstall = await run(["install", "ollama-toolkit", "--global"], globalEnv);
  assert.equal(globalOllamaInstall.code, 0, globalOllamaInstall.stderr);
  // Remove the installed package's catalog too: runtime must use only target-owned files.
  await rename(path.join(packagedRoot, "toolkits"), path.join(packagedRoot, "toolkits.unavailable"));
  for (const [configRoot, payloadRoot] of [[project, path.join(project, ".opencode")], [path.join(globalRoot, "opencode"), path.join(globalRoot, "opencode")]]) {
    await checkInstalledOllama(configRoot!, payloadRoot!, root);
  }
  await rename(path.join(packagedRoot, "toolkits.unavailable"), path.join(packagedRoot, "toolkits"));
  const globalUpdate = await run(["update", "--global"], globalEnv);
  assert.equal(globalUpdate.code, 0, globalUpdate.stderr);
  const globalUninstall = await run(
    ["uninstall", "libvirt-toolkit", "project-toolkit", "ollama-toolkit", "--global"],
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
  assert.match(list.stdout, /libvirt-toolkit\s+-\s+0\.2\.1/);
  assert.match(list.stdout, /project-toolkit\s+-\s+0\.1\.0/);
  const uninstall = await run(
    ["uninstall", "libvirt-toolkit", "project-toolkit", "ollama-toolkit", "--project", project],
  );
  assert.equal(uninstall.code, 0, uninstall.stderr);
  assert.match(uninstall.stdout, /uninstall libvirt-toolkit@0\.2\.1/);
  assert.match(uninstall.stdout, /uninstall project-toolkit@0\.1\.0/);
  await assert.rejects(access(server));
  await assert.rejects(access(todoSkill));
});
