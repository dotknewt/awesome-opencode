import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";

import { InstallerEngine, InstallerError } from "../installer/src/installer-engine.js";
import { readInstallerState } from "../installer/src/state.js";
import { resolveTarget } from "../installer/src/target.js";

async function fixture(version = "0.1.0") {
  const root = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-engine-"));
  const catalogRoot = path.join(root, "catalog");
  const toolkitRoot = path.join(catalogRoot, "libvirt-toolkit");
  const projectRoot = path.join(root, "project");
  await mkdir(path.join(toolkitRoot, "skills", "dotknewt-demo"), { recursive: true });
  await mkdir(path.join(toolkitRoot, "server-source"), { recursive: true });
  await mkdir(projectRoot);
  await writeFile(path.join(toolkitRoot, "skills", "dotknewt-demo", "SKILL.md"), "demo\n");
  await writeFile(path.join(toolkitRoot, "server-source", "server.py"), "# server\n");
  await chmod(path.join(toolkitRoot, "server-source", "server.py"), 0o755);
  await writeFile(path.join(toolkitRoot, "toolkit.json"), JSON.stringify({
    schemaVersion: 1,
    name: "libvirt-toolkit",
    namespace: "dotknewt",
    version,
    description: "fixture",
    license: "MIT",
    exports: [
      { kind: "skill", source: "skills/dotknewt-demo", destination: "skills/dotknewt-demo" },
      { kind: "asset", source: "server-source", destination: "managed/server" },
    ],
    requiredSkills: ["dotknewt-demo"],
    mcp: [{ name: "dotknewt-libvirt", type: "local", command: ["uv", "run", "--script"], entrypoint: "managed/server/server.py", enabled: true }],
    dependencies: { platforms: ["linux"], executables: ["uv"] },
  }, null, 2));
  const target = await resolveTarget({ scope: "project", projectRoot });
  return { root, catalogRoot, toolkitRoot, projectRoot, target };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("resolves explicit project/global targets and honors XDG_CONFIG_HOME", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-target-"));
  const project = await resolveTarget({ scope: "project", projectRoot: path.join(root, "p") });
  assert.equal(project.payloadRoot, path.join(root, "p", ".opencode"));
  assert.equal(project.defaultConfigPath, path.join(root, "p", "opencode.json"));
  const global = await resolveTarget({ scope: "global", env: { XDG_CONFIG_HOME: path.join(root, "xdg") }, home: path.join(root, "home") });
  assert.equal(global.payloadRoot, path.join(root, "xdg", "opencode"));
});

test("installs mapped payload, native MCP config, modes, and ownership state", async () => {
  const f = await fixture();
  const engine = new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target });
  const plan = await engine.planInstall(["libvirt-toolkit"]);
  assert.equal(plan.operation, "install");
  assert.ok(plan.changes.length > 0);
  await engine.apply(plan);
  assert.equal(await readFile(path.join(f.target.payloadRoot, "skills", "dotknewt-demo", "SKILL.md"), "utf8"), "demo\n");
  const server = path.join(f.target.managedRoot, "libvirt-toolkit", "managed", "server", "server.py");
  assert.equal((await lstat(server)).mode & 0o777, 0o755);
  const config = JSON.parse(await readFile(path.join(f.projectRoot, "opencode.json"), "utf8"));
  assert.deepEqual(config.mcp["dotknewt-libvirt"], { type: "local", command: ["uv", "run", "--script", server], enabled: true });
  assert.equal(config.$schema, "https://opencode.ai/config.json");
  const state = await readInstallerState(f.target);
  assert.equal(state.toolkits["libvirt-toolkit"]?.version, "0.1.0");
  assert.ok(state.toolkits["libvirt-toolkit"]?.files.every((file) => file.owner === "libvirt-toolkit"));
});

test("preserves JSONC comments/unrelated values and compares owned config structurally", async () => {
  const f = await fixture();
  const configPath = path.join(f.projectRoot, "opencode.jsonc");
  await writeFile(configPath, "{\n  // consumer setting\n  \"theme\": \"dark\",\n  \"mcp\": {}\n}\n");
  const engine = new InstallerEngine({ catalogRoot: f.catalogRoot, target: await resolveTarget({ scope: "project", projectRoot: f.projectRoot }) });
  await engine.apply(await engine.planInstall(["libvirt-toolkit"]));
  const first = await readFile(configPath, "utf8");
  assert.match(first, /consumer setting/);
  assert.match(first, /"theme": "dark"/);
  const parsed = JSON.parse(first.replace(/\/\/.*$/gm, ""));
  parsed.mcp["dotknewt-libvirt"] = { enabled: true, command: [...parsed.mcp["dotknewt-libvirt"].command], type: "local" };
  await writeFile(configPath, JSON.stringify(parsed, null, 4));
  const reordered = await readFile(configPath, "utf8");
  const update = await engine.planUpdate(["libvirt-toolkit"]);
  assert.doesNotMatch(update.summary.join("\n"), /configuration conflict/i);
  assert.equal(update.changes.some((change) => change.path === configPath), false);
  assert.equal(await readFile(configPath, "utf8"), reordered);
});

test("rejects ambiguous/malformed/duplicate-key configuration before writes", async () => {
  const f = await fixture();
  await writeFile(path.join(f.projectRoot, "opencode.json"), "{}\n");
  await mkdir(path.join(f.projectRoot, ".opencode"), { recursive: true });
  await writeFile(path.join(f.projectRoot, ".opencode", "opencode.jsonc"), "{}\n");
  await assert.rejects(() => resolveTarget({ scope: "project", projectRoot: f.projectRoot }), /multiple.*config/i);
  await writeFile(path.join(f.projectRoot, ".opencode", "opencode.jsonc"), "", { flag: "w" });
  // A single malformed candidate is rejected by planning.
  const other = await fixture();
  await writeFile(path.join(other.projectRoot, "opencode.jsonc"), "{\"mcp\":{}, \"mcp\": {}}");
  const engine = new InstallerEngine({ catalogRoot: other.catalogRoot, target: await resolveTarget({ scope: "project", projectRoot: other.projectRoot }) });
  await assert.rejects(() => engine.planInstall(["libvirt-toolkit"]), /duplicate|configuration/i);
  assert.equal(await lstat(other.target.payloadRoot).then(() => true, () => false), false);
});

test("rejects symlink and non-file config candidates instead of selecting another path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-config-candidate-"));
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);
  const outside = path.join(root, "outside.json");
  await writeFile(outside, "{}\n");
  await symlink(outside, path.join(projectRoot, "opencode.jsonc"));
  await assert.rejects(() => resolveTarget({ scope: "project", projectRoot }), /symlink.*opencode\.jsonc/i);
  await rm(path.join(projectRoot, "opencode.jsonc"));
  await mkdir(path.join(projectRoot, "opencode.jsonc"));
  await assert.rejects(() => resolveTarget({ scope: "project", projectRoot }), /not a regular file/i);
});

test("unowned identical files conflict and owned local modifications block update/uninstall", async () => {
  const f = await fixture();
  await mkdir(path.join(f.target.payloadRoot, "skills", "dotknewt-demo"), { recursive: true });
  const destination = path.join(f.target.payloadRoot, "skills", "dotknewt-demo", "SKILL.md");
  await writeFile(destination, "demo\n");
  const engine = new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target });
  await assert.rejects(() => engine.planInstall(["libvirt-toolkit"]), /unowned.*conflict/i);
  await writeFile(destination, "changed\n");
  await assert.rejects(() => engine.planInstall(["libvirt-toolkit"]), /unowned.*conflict/i);

  const clean = await fixture();
  const installed = new InstallerEngine({ catalogRoot: clean.catalogRoot, target: clean.target });
  await installed.apply(await installed.planInstall(["libvirt-toolkit"]));
  const owned = path.join(clean.target.payloadRoot, "skills", "dotknewt-demo", "SKILL.md");
  await writeFile(owned, "local edit\n");
  await assert.rejects(() => installed.planUpdate(["libvirt-toolkit"]), /modified.*owned/i);
  await assert.rejects(() => installed.planUninstall(["libvirt-toolkit"]), /modified.*owned/i);
});

test("update with no names affects installed entries only and uninstall needs no catalog", async () => {
  const f = await fixture();
  const engine = new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target });
  await engine.apply(await engine.planInstall(["libvirt-toolkit"]));
  const manifestPath = path.join(f.toolkitRoot, "toolkit.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = "0.2.0";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(path.join(f.toolkitRoot, "skills", "dotknewt-demo", "SKILL.md"), "updated\n");
  await engine.apply(await engine.planUpdate([]));
  assert.equal((await readInstallerState(f.target)).toolkits["libvirt-toolkit"]?.version, "0.2.0");
  const noCatalog = new InstallerEngine({ catalogRoot: path.join(f.root, "gone"), target: f.target });
  await noCatalog.apply(await noCatalog.planUninstall(["libvirt-toolkit"]));
  assert.equal(Object.keys((await readInstallerState(f.target)).toolkits).length, 0);
});

test("dry-run is zero-write and reports pending recovery", async () => {
  const f = await fixture();
  const engine = new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target });
  const plan = await engine.planInstall(["libvirt-toolkit"], { dryRun: true });
  assert.equal(await lstat(f.target.payloadRoot).then(() => true, () => false), false);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.recoveryPending, false);
});

test("rejects source symlinks and target symlink escapes", async () => {
  const f = await fixture();
  await symlink(path.join(f.root, "outside"), path.join(f.toolkitRoot, "server-source", "escape"));
  const engine = new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target });
  await assert.rejects(() => engine.planInstall(["libvirt-toolkit"]), /symlink|special/i);
  const other = await fixture();
  await mkdir(other.target.payloadRoot, { recursive: true });
  await symlink(path.join(other.root, "outside"), path.join(other.target.payloadRoot, "skills"));
  await assert.rejects(() => new InstallerEngine({ catalogRoot: other.catalogRoot, target: other.target }).planInstall(["libvirt-toolkit"]), /symlink/i);
});

test("rejects symlinked toolkit roots and intermediate export source components", async () => {
  const linkedRoot = await fixture();
  const realToolkit = `${linkedRoot.toolkitRoot}-real`;
  await rename(linkedRoot.toolkitRoot, realToolkit);
  await symlink(realToolkit, linkedRoot.toolkitRoot);
  await assert.rejects(() => new InstallerEngine({ catalogRoot: linkedRoot.catalogRoot, target: linkedRoot.target }).planInstall(["libvirt-toolkit"]), /symlink.*libvirt-toolkit/i);

  const intermediate = await fixture();
  const manifestPath = path.join(intermediate.toolkitRoot, "toolkit.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.exports[1].source = "linked/server";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await symlink(intermediate.toolkitRoot, path.join(intermediate.toolkitRoot, "linked"));
  await assert.rejects(() => new InstallerEngine({ catalogRoot: intermediate.catalogRoot, target: intermediate.target }).planInstall(["libvirt-toolkit"]), /symlink.*linked/i);
});

test("rejects export kinds outside their native payload namespaces", async () => {
  const f = await fixture();
  const manifestPath = path.join(f.toolkitRoot, "toolkit.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.exports[0].destination = "awesome-opencode/state.json/dotknewt-demo";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(() => new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target }).planInstall(["libvirt-toolkit"]), /skill export destination.*skills/i);
});

test("rejects special source files", async () => {
  const f = await fixture();
  const fifo = path.join(f.toolkitRoot, "server-source", "unsafe.fifo");
  const created = spawnSync("mkfifo", [fifo]);
  assert.equal(created.status, 0, created.stderr.toString());
  await assert.rejects(() => new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target }).planInstall(["libvirt-toolkit"]), /special file/i);
});

test("rollback, durable recovery, and deterministic live-lock concurrency", async () => {
  const f = await fixture();
  const failing = new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target, faults: { failAfterWrites: 1 } });
  const failingPlan = await failing.planInstall(["libvirt-toolkit"]);
  await assert.rejects(() => failing.apply(failingPlan), /injected/i);
  assert.equal(await lstat(path.join(f.target.payloadRoot, "skills", "dotknewt-demo", "SKILL.md")).then(() => true, () => false), false);

  const acquired = deferred();
  const release = deferred();
  const locked = new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target, faults: { pauseAfterLock: async () => { acquired.resolve(); await release.promise; } } });
  const lockedPlan = await locked.planInstall(["libvirt-toolkit"]);
  const pending = locked.apply(lockedPlan);
  await acquired.promise;
  const concurrent = new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target });
  const concurrentPlan = await concurrent.planInstall(["libvirt-toolkit"]);
  await assert.rejects(() => concurrent.apply(concurrentPlan), /locked/i);
  release.resolve();
  await pending;
});

test("retains exclusion after the flock child exits while a transaction operation is outstanding", async () => {
  const f = await fixture();
  const paused = deferred();
  const releasePause = deferred();
  const owner = new InstallerEngine({
    catalogRoot: f.catalogRoot,
    target: f.target,
    faults: {
      afterJournalPublished: async () => { paused.resolve(); await releasePause.promise; },
    },
  });
  const plan = await owner.planInstall(["libvirt-toolkit"]);
  const pending = owner.apply(plan);
  await paused.promise;
  assert.equal((await lstat(f.target.journalPath)).isFile(), true);

  const contender = new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target });
  await assert.rejects(() => contender.apply(plan), /locked by another live installer process/i);

  releasePause.resolve();
  await pending;
  assert.equal((await readInstallerState(f.target)).toolkits["libvirt-toolkit"]?.version, "0.1.0");
  assert.equal(await lstat(f.target.journalPath).then(() => true, () => false), false);
});

test("closes the parent-owned lock fd after post-acquisition setup failure", async () => {
  const f = await fixture();
  const failing = new InstallerEngine({
    catalogRoot: f.catalogRoot,
    target: f.target,
    faults: { failPostFlockSetup: true },
  });
  const plan = await failing.planInstall(["libvirt-toolkit"]);
  await assert.rejects(() => failing.apply(plan), /injected post-flock acquisition setup failure/i);
  assert.equal(await lstat(f.target.journalPath).then(() => true, () => false), false);

  const next = new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target });
  await next.apply(plan);
  assert.equal((await readInstallerState(f.target)).toolkits["libvirt-toolkit"]?.version, "0.1.0");
});

test("claims a stale lock atomically and only the token owner releases it", async () => {
  const f = await fixture();
  const base = new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target });
  const plan = await base.planInstall(["libvirt-toolkit"]);
  await mkdir(f.target.lockPath, { recursive: true });
  await writeFile(path.join(f.target.lockPath, "owner.json"), JSON.stringify({ pid: 999_999_999, token: "stale-token", createdAt: "2026-01-01T00:00:00Z" }));
  const reclaimStarted = deferred();
  const allowReclaim = deferred();
  const acquired = deferred();
  const release = deferred();
  const winners: string[] = [];
  const make = (id: string) => new InstallerEngine({
    catalogRoot: f.catalogRoot,
    target: f.target,
    faults: {
      onStaleLockObserved: async () => { reclaimStarted.resolve(); await allowReclaim.promise; },
      pauseAfterLock: async () => { winners.push(id); acquired.resolve(); await release.promise; },
    },
  });
  const first = make("first").apply(plan);
  const second = make("second").apply(plan);
  const firstResult = first.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
  const secondResult = second.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
  await reclaimStarted.promise;
  allowReclaim.resolve();
  await acquired.promise;
  const loser = await (winners[0] === "first" ? secondResult : firstResult);
  assert.equal(loser.ok, false);
  assert.match((loser as { ok: false; error: Error }).error.message, /locked by another live installer process/i);
  assert.equal((await lstat(f.target.lockPath)).isFile(), true);
  release.resolve();
  const winner = await (winners[0] === "first" ? firstResult : secondResult);
  assert.equal(winner.ok, true);
  const lockOwner = JSON.parse(await readFile(f.target.lockPath, "utf8"));
  assert.equal(typeof lockOwner.token, "string");
});

test("guarded ordinary rollback preserves a third state and journal", async () => {
  const f = await fixture();
  const engine = new InstallerEngine({
    catalogRoot: f.catalogRoot,
    target: f.target,
    faults: {
      afterWrite: async (count, filePath) => { if (count === 1) await writeFile(filePath, "third state\n"); },
      failAfterWrites: 1,
    },
  });
  const plan = await engine.planInstall(["libvirt-toolkit"]);
  await assert.rejects(() => engine.apply(plan), /guarded rollback refused.*intervening edit/i);
  const firstDestination = path.join(f.target.payloadRoot, "skills", "dotknewt-demo", "SKILL.md");
  assert.equal(await readFile(firstDestination, "utf8"), "third state\n");
  assert.equal((await lstat(f.target.journalPath)).isFile(), true);
});

test("publishes journals atomically only after the synced temporary file is complete", async () => {
  const beforePublish = await fixture();
  const first = new InstallerEngine({
    catalogRoot: beforePublish.catalogRoot,
    target: beforePublish.target,
    faults: { afterJournalTempSynced: async () => { throw new Error("stop before journal publish"); } },
  });
  const firstPlan = await first.planInstall(["libvirt-toolkit"]);
  await assert.rejects(() => first.apply(firstPlan), /stop before journal publish/i);
  assert.equal(await lstat(beforePublish.target.journalPath).then(() => true, () => false), false);
  assert.equal(await lstat(path.join(beforePublish.target.payloadRoot, "skills", "dotknewt-demo", "SKILL.md")).then(() => true, () => false), false);

  const afterPublish = await fixture();
  const second = new InstallerEngine({
    catalogRoot: afterPublish.catalogRoot,
    target: afterPublish.target,
    faults: { afterJournalPublished: async () => { throw new Error("stop after journal publish"); } },
  });
  const secondPlan = await second.planInstall(["libvirt-toolkit"]);
  await assert.rejects(() => second.apply(secondPlan), /stop after journal publish/i);
  const journal = JSON.parse(await readFile(afterPublish.target.journalPath, "utf8"));
  assert.equal(journal.formatVersion, 1);
  assert.ok(journal.changes.length > 0);
  await new InstallerEngine({ catalogRoot: afterPublish.catalogRoot, target: afterPublish.target }).install(["libvirt-toolkit"]);
  assert.equal((await readInstallerState(afterPublish.target)).toolkits["libvirt-toolkit"]?.version, "0.1.0");
});

test("revalidates unchanged owned files and configuration from the complete planning read-set", async () => {
  const f = await fixture();
  const engine = new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target });
  await engine.install(["libvirt-toolkit"]);
  const manifestPath = path.join(f.toolkitRoot, "toolkit.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = "0.2.0";
  await writeFile(manifestPath, JSON.stringify(manifest));
  const filePlan = await engine.planUpdate(["libvirt-toolkit"]);
  const owned = path.join(f.target.payloadRoot, "skills", "dotknewt-demo", "SKILL.md");
  await writeFile(owned, "changed after planning\n");
  await assert.rejects(() => engine.apply(filePlan), /planning read changed/i);
  await writeFile(owned, "demo\n");
  const configPlan = await engine.planUpdate(["libvirt-toolkit"]);
  const config = JSON.parse(await readFile(f.target.configPath, "utf8"));
  config.theme = "changed-after-planning";
  await writeFile(f.target.configPath, JSON.stringify(config, null, 2));
  await assert.rejects(() => engine.apply(configPlan), /planning read changed/i);
  assert.equal((await readInstallerState(f.target)).toolkits["libvirt-toolkit"]?.version, "0.1.0");
});

test("rejects new alternate configuration candidates after planning without changing the target", async (t) => {
  for (const candidateKind of ["malformed file", "symlink"] as const) {
    await t.test(candidateKind, async () => {
      const f = await fixture();
      const engine = new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target });
      const plan = await engine.planInstall(["libvirt-toolkit"]);
      const alternate = path.join(f.projectRoot, "opencode.jsonc");
      const outside = path.join(f.root, "outside-config.jsonc");
      if (candidateKind === "malformed file") await writeFile(alternate, "{ malformed\n");
      else {
        await writeFile(outside, "{\"outside\":true}\n");
        await symlink(outside, alternate);
      }

      await assert.rejects(() => engine.apply(plan), /planning read changed|symlink path component/i);
      assert.equal(await lstat(f.target.configPath).then(() => true, () => false), false);
      assert.equal(await lstat(f.target.statePath).then(() => true, () => false), false);
      assert.equal(await lstat(path.join(f.target.payloadRoot, "skills", "dotknewt-demo", "SKILL.md")).then(() => true, () => false), false);
      if (candidateKind === "symlink") assert.equal(await readFile(outside, "utf8"), "{\"outside\":true}\n");
    });
  }
});

test("cleans an owned resource temporary after ordinary write failure and preserves unrelated files", async () => {
  const f = await fixture();
  const destinationDirectory = path.join(f.target.payloadRoot, "skills", "dotknewt-demo");
  const destination = path.join(destinationDirectory, "SKILL.md");
  const unrelated = path.join(destinationDirectory, "consumer-note.txt");
  await mkdir(destinationDirectory, { recursive: true });
  await writeFile(unrelated, "keep me\n");
  let injected = false;
  const engine = new InstallerEngine({
    catalogRoot: f.catalogRoot,
    target: f.target,
    faults: {
      beforeResourceRename: async (filePath: string) => {
        if (filePath === destination && !injected) {
          injected = true;
          throw new Error("injected ordinary resource write failure");
        }
      },
    },
  });
  const plan = await engine.planInstall(["libvirt-toolkit"]);

  await assert.rejects(() => engine.apply(plan), /injected ordinary resource write failure/i);
  assert.equal(injected, true);
  assert.equal(await readFile(unrelated, "utf8"), "keep me\n");
  assert.deepEqual((await readdir(destinationDirectory)).filter((name) => name.includes(".awesome-opencode-") && name.endsWith(".tmp")), []);
  assert.equal(await lstat(destination).then(() => true, () => false), false);
});

test("rechecks symlink parents at apply and cannot delete a matching outside file", async () => {
  const f = await fixture();
  const engine = new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target });
  await engine.install(["libvirt-toolkit"]);
  const plan = await engine.planUninstall(["libvirt-toolkit"]);
  const skills = path.join(f.target.payloadRoot, "skills");
  await rename(skills, `${skills}-owned`);
  const outside = path.join(f.root, "outside-skills", "dotknewt-demo");
  await mkdir(outside, { recursive: true });
  const outsideFile = path.join(outside, "SKILL.md");
  await writeFile(outsideFile, "demo\n");
  await symlink(path.join(f.root, "outside-skills"), skills);
  await assert.rejects(() => engine.apply(plan), /symlink path component/i);
  assert.equal(await readFile(outsideFile, "utf8"), "demo\n");
});

test("recovers interrupted transactions, refuses intervening edits, and dry-run only reports recovery", async () => {
  const recoverable = await fixture();
  const interrupted = new InstallerEngine({ catalogRoot: recoverable.catalogRoot, target: recoverable.target, faults: { interruptAfterWrites: 1 } });
  const interruptedPlan = await interrupted.planInstall(["libvirt-toolkit"]);
  await assert.rejects(() => interrupted.apply(interruptedPlan), /interrupted/i);
  const clean = new InstallerEngine({ catalogRoot: recoverable.catalogRoot, target: recoverable.target });
  const dry = await clean.planInstall(["libvirt-toolkit"], { dryRun: true });
  assert.equal(dry.recoveryPending, true);
  assert.equal(dry.changes.length, 0);
  await clean.install(["libvirt-toolkit"]);
  assert.equal((await readInstallerState(recoverable.target)).toolkits["libvirt-toolkit"]?.version, "0.1.0");

  const conflicted = await fixture();
  const interruptedAgain = new InstallerEngine({ catalogRoot: conflicted.catalogRoot, target: conflicted.target, faults: { interruptAfterWrites: 1 } });
  const interruptedAgainPlan = await interruptedAgain.planInstall(["libvirt-toolkit"]);
  await assert.rejects(() => interruptedAgain.apply(interruptedAgainPlan), /interrupted/i);
  const firstDestination = path.join(conflicted.target.payloadRoot, "skills", "dotknewt-demo", "SKILL.md");
  await writeFile(firstDestination, "intervening edit\n");
  await assert.rejects(
    () => new InstallerEngine({ catalogRoot: conflicted.catalogRoot, target: conflicted.target }).install(["libvirt-toolkit"]),
    (error: unknown) => error instanceof InstallerError && /intervening edit/i.test(error.message),
  );
  assert.equal(await readFile(firstDestination, "utf8"), "intervening edit\n");
});

test("releases the parent-owned lock and recovers after the installer parent is SIGKILLed", { timeout: 15_000 }, async () => {
  const f = await fixture();
  const engineModule = new URL("../installer/src/installer-engine.js", import.meta.url).href;
  const targetModule = new URL("../installer/src/target.js", import.meta.url).href;
  const script = `
    const { InstallerEngine } = await import(${JSON.stringify(engineModule)});
    const { resolveTarget } = await import(${JSON.stringify(targetModule)});
    const target = await resolveTarget({ scope: "project", projectRoot: ${JSON.stringify(f.projectRoot)} });
    const engine = new InstallerEngine({
      catalogRoot: ${JSON.stringify(f.catalogRoot)},
      target,
      faults: { afterWrite: async () => { process.stdout.write("WRITE\\n"); await new Promise(() => {}); } },
    });
    await engine.apply(await engine.planInstall(["libvirt-toolkit"]));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("WRITE\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`child exited before barrier: code=${code} signal=${signal} stderr=${stderr}`)));
  });
  assert.equal(child.kill("SIGKILL"), true);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exit.signal, "SIGKILL", stderr);
  assert.equal((await lstat(f.target.journalPath)).isFile(), true);
  const recovering = new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target });
  await recovering.install(["libvirt-toolkit"]);
  assert.equal((await readInstallerState(f.target)).toolkits["libvirt-toolkit"]?.version, "0.1.0");
  assert.equal(await lstat(f.target.journalPath).then(() => true, () => false), false);
});

test("automatically recovers a journal after a legacy stale-lock reclaimer is killed", { timeout: 15_000 }, async () => {
  const f = await fixture();
  const interrupted = new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target, faults: { interruptAfterWrites: 1 } });
  const interruptedPlan = await interrupted.planInstall(["libvirt-toolkit"]);
  await assert.rejects(() => interrupted.apply(interruptedPlan), /interrupted/i);
  await rm(f.target.lockPath);

  const markerPath = `${f.target.lockPath}.reclaim`;
  const script = `
    const { mkdir, writeFile } = await import("node:fs/promises");
    const owner = JSON.stringify({ pid: process.pid, token: "killed-reclaimer", createdAt: new Date().toISOString() });
    await mkdir(${JSON.stringify(f.target.lockPath)});
    await writeFile(${JSON.stringify(path.join(f.target.lockPath, "owner.json"))}, owner);
    await mkdir(${JSON.stringify(markerPath)});
    await writeFile(${JSON.stringify(path.join(markerPath, "owner.json"))}, owner);
    process.stdout.write("RECLAIMER\\n");
    await new Promise(() => {});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.includes("RECLAIMER\n")) resolve(); });
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`reclaimer exited before barrier: code=${code} signal=${signal} stderr=${stderr}`)));
  });
  assert.equal(child.kill("SIGKILL"), true);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exit.signal, "SIGKILL", stderr);

  let observed = 0;
  const recovering = new InstallerEngine({
    catalogRoot: f.catalogRoot,
    target: f.target,
    faults: { onStaleLockObserved: async () => { observed += 1; } },
  });
  await recovering.install(["libvirt-toolkit"]);
  assert.equal(observed, 1);
  assert.equal(await lstat(markerPath).then(() => true, () => false), false);
  assert.equal(await lstat(f.target.journalPath).then(() => true, () => false), false);
  assert.equal((await readInstallerState(f.target)).toolkits["libvirt-toolkit"]?.version, "0.1.0");
});

test("protects state and config paths from symlink leaves", async () => {
  const f = await fixture();
  const outside = path.join(f.root, "outside-state");
  await writeFile(outside, "outside\n");
  await mkdir(f.target.stateRoot, { recursive: true });
  await symlink(outside, f.target.statePath);
  await assert.rejects(() => new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target }).planInstall(["libvirt-toolkit"]), /symlink/i);
  assert.equal(await readFile(outside, "utf8"), "outside\n");
});

test("list refuses a symlinked installer state root", async () => {
  const f = await fixture();
  const outsideStateRoot = path.join(f.root, "outside-state-root");
  await mkdir(outsideStateRoot);
  await writeFile(path.join(outsideStateRoot, "state.json"), JSON.stringify({ formatVersion: 1, toolkits: {} }));
  await mkdir(f.target.payloadRoot, { recursive: true });
  await symlink(outsideStateRoot, f.target.stateRoot);

  const engine = new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target });
  await assert.rejects(() => engine.list(), /symlink path component/i);
});

test("malformed state is refused", async () => {
  const f = await fixture();
  await mkdir(f.target.stateRoot, { recursive: true });
  await writeFile(f.target.statePath, "not json");
  const engine = new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target });
  await assert.rejects(() => engine.planInstall(["libvirt-toolkit"]), InstallerError);
});

test("rejects duplicate file and MCP ownership in persisted state", async () => {
  const f = await fixture();
  await mkdir(f.target.stateRoot, { recursive: true });
  const record = (owner: string) => ({
    version: "0.1.0",
    files: [{ path: path.join(f.target.payloadRoot, "skills", "shared", "SKILL.md"), hash: "hash", mode: 0o644, owner }],
    configPath: f.target.configPath,
    configEntries: [{ name: "dotknewt-shared", expected: { enabled: true } }],
  });
  await writeFile(f.target.statePath, JSON.stringify({ formatVersion: 1, toolkits: { one: record("one"), two: record("two") } }));
  await assert.rejects(() => readInstallerState(f.target), /duplicate file ownership/i);
  const second = record("two");
  second.files[0]!.path = path.join(f.target.payloadRoot, "skills", "other", "SKILL.md");
  await writeFile(f.target.statePath, JSON.stringify({ formatVersion: 1, toolkits: { one: record("one"), two: second } }));
  await assert.rejects(() => readInstallerState(f.target), /duplicate MCP configuration ownership/i);

  await writeFile(f.target.statePath, JSON.stringify({ formatVersion: 1, toolkits: { "": record("") } }));
  await assert.rejects(() => readInstallerState(f.target), /invalid toolkit identity/i);
});

test("refuses ownership state paths outside the selected target", async () => {
  const f = await fixture();
  const outside = path.join(f.root, "outside-owned-file");
  await writeFile(outside, "do not touch\n");
  await mkdir(f.target.stateRoot, { recursive: true });
  await writeFile(f.target.statePath, JSON.stringify({
    formatVersion: 1,
    toolkits: {
      "libvirt-toolkit": {
        version: "0.1.0",
        files: [{ path: outside, hash: "ignored", mode: 0o644, owner: "libvirt-toolkit" }],
        configPath: f.target.configPath,
        configEntries: [],
      },
    },
  }));
  await assert.rejects(() => new InstallerEngine({ catalogRoot: f.catalogRoot, target: f.target }).planUninstall(["libvirt-toolkit"]), /escapes payload root/i);
  assert.equal(await readFile(outside, "utf8"), "do not touch\n");
});

test("installs the real libvirt manifest mappings and never recursively deletes user additions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-real-engine-"));
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);
  const target = await resolveTarget({ scope: "project", projectRoot });
  const engine = new InstallerEngine({ catalogRoot: path.resolve("toolkits"), target });
  await engine.install(["libvirt-toolkit"]);
  assert.equal((await lstat(path.join(target.payloadRoot, "skills", "dotknewt-libvirt-vms", "SKILL.md"))).isFile(), true);
  assert.equal((await lstat(path.join(target.payloadRoot, "skills", "dotknewt-guest-access", "SKILL.md"))).isFile(), true);
  const server = path.join(target.managedRoot, "libvirt-toolkit", "mcp", "libvirt", "server.py");
  const config = JSON.parse(await readFile(target.configPath, "utf8"));
  assert.equal(config.mcp["dotknewt-libvirt"].command.at(-1), server);
  const userAddition = path.join(target.managedRoot, "libvirt-toolkit", "mcp", "libvirt", "user-note.txt");
  await writeFile(userAddition, "keep me\n");
  await engine.uninstall(["libvirt-toolkit"]);
  assert.equal(await readFile(userAddition, "utf8"), "keep me\n");
  const after = JSON.parse(await readFile(target.configPath, "utf8"));
  assert.equal(after.mcp["dotknewt-libvirt"], undefined);
});
