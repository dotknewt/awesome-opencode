import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { mock } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";

import { listRepairConfigSources, selectRepairConfiguration } from "../installer/src/repair-config.js";
import { proveHistoricalRoot } from "../installer/src/relocation.js";
import type { InstallerState } from "../installer/src/state.js";
import type { ConfigSource } from "../installer/src/repair-config.js";
import type { TargetPaths } from "../installer/src/target.js";

const oldManaged = "/old-project/.opencode/awesome-opencode/toolkits";
const toolkit = "demo-toolkit";
const name = "demo-server";

async function fixture() {
  const root = await fs.mkdtemp(path.join("/tmp/opencode", "config-selection-"));
  const payloadRoot = path.join(root, ".opencode");
  const stateRoot = path.join(payloadRoot, "awesome-opencode");
  const candidates = [path.join(root, "opencode.json"), path.join(root, "opencode.jsonc"), path.join(payloadRoot, "opencode.json"), path.join(payloadRoot, "opencode.jsonc")];
  const target: TargetPaths = {
    scope: "project", payloadRoot, managedRoot: path.join(stateRoot, "toolkits"), stateRoot,
    statePath: path.join(stateRoot, "state.json"), journalPath: path.join(stateRoot, "journal.json"),
    lockPath: path.join(stateRoot, "lock"), configPath: candidates[0]!, configCandidates: candidates,
    defaultConfigPath: candidates[0]!,
  };
  const expected = { type: "local", command: ["bun", "run", `${oldManaged}/${toolkit}/bin/server.mjs`] };
  const state: InstallerState = { formatVersion: 1, toolkits: { [toolkit]: {
    version: "1.0.0", configPath: "/old-project/opencode.json", configEntries: [{ name, expected }],
    files: [{ path: `/old-project/.opencode/awesome-opencode/toolkits/${toolkit}/bin/server.mjs`, hash: "a".repeat(64), mode: 0o644, owner: toolkit }],
  } } };
  const proof = proveHistoricalRoot(state, target);
  const supported = listRepairConfigSources(target, {});
  async function put(candidate: string, entry: unknown) {
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    await fs.writeFile(candidate, JSON.stringify({ mcp: { [name]: entry } }));
  }
  async function putConfig(candidate: string, value: unknown) {
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    await fs.writeFile(candidate, JSON.stringify(value));
  }
  async function cleanup() { await fs.rm(root, { recursive: true, force: true }); }
  return { root, target, state, proof, expected, supported, candidates, put, putConfig, cleanup };
}

test("productionSourcesAreExactlyBoundedCandidates", async () => {
  const f = await fixture();
  try {
    const sources = listRepairConfigSources(f.target, { OPENCODE_CONFIG: "/unverified/config.json", XDG_CONFIG_HOME: "/unverified" });
    assert.deepEqual(sources.map(({ path: sourcePath, role }) => [sourcePath, role]), f.candidates.map((candidate) => [candidate, "candidate"]));
    assert.ok(sources.every(({ evidenceId }) => evidenceId.length > 0));
  } finally { await f.cleanup(); }
});

test("oneCandidateOwnsAllEntries", async () => {
  const f = await fixture();
  try {
    const owner = f.supported[0]!;
    const current = { ...f.expected, command: ["bun", "run", `${f.target.managedRoot}/${toolkit}/bin/server.mjs`] };
    await f.put(owner.path, current);
    const selection = await selectRepairConfiguration(f.target, f.state, f.proof, f.supported);
    assert.equal(selection.path, owner.path);
    assert.deepEqual(selection.entries[toolkit], f.proof.rebasedState.toolkits[toolkit]!.configEntries);
    const rebasedExpected = selection.entries[toolkit]![0]!.expected as { command: string[] };
    assert.equal(rebasedExpected.command[2], `${f.target.managedRoot}/${toolkit}/bin/server.mjs`);
  } finally { await f.cleanup(); }
});

test("splitOwnersFail", async () => {
  const f = await fixture();
  try {
    const secondName = "second-server";
    const secondToolkit = "second-toolkit";
    f.state.toolkits[secondToolkit] = {
      version: "2.0.0", configPath: "/old-project/opencode.json",
      configEntries: [{ name: secondName, expected: { type: "local", command: ["bun", "run", `${oldManaged}/${secondToolkit}/bin/server.mjs`] } }],
      files: [{ path: `/old-project/.opencode/awesome-opencode/toolkits/${secondToolkit}/bin/server.mjs`, hash: "b".repeat(64), mode: 0o644, owner: secondToolkit }],
    };
    const proof = proveHistoricalRoot(f.state, f.target);
    await f.putConfig(f.supported[0]!.path, { mcp: { [name]: { type: "local", command: ["bun", "run", `${f.target.managedRoot}/${toolkit}/bin/server.mjs`] } } });
    await f.putConfig(f.supported[1]!.path, { mcp: { [secondName]: { type: "local", command: ["bun", "run", `${f.target.managedRoot}/${secondToolkit}/bin/server.mjs`] } } });
    await assert.rejects(selectRepairConfiguration(f.target, f.state, proof, f.supported), (error: Error) => {
      assert.match(error.message, /owner|multiple|ambiguous|candidate/i);
      assert.ok(error.message.includes(f.supported[0]!.path));
      assert.ok(error.message.includes(f.supported[1]!.path));
      assert.match(error.message, /manual|merge|remove|resolve|single supported/i);
      return true;
    });
  } finally { await f.cleanup(); }
});

test("duplicateOwnersFail", async () => {
  const f = await fixture();
  try {
    const current = { ...f.expected, command: ["bun", "run", `${f.target.managedRoot}/${toolkit}/bin/server.mjs`] };
    await f.put(f.supported[0]!.path, current);
    await f.put(f.supported[1]!.path, current);
    await assert.rejects(selectRepairConfiguration(f.target, f.state, f.proof, f.supported), (error: Error) => {
      assert.match(error.message, /owner|multiple|ambiguous|candidate/i);
      assert.ok(error.message.includes(f.supported[0]!.path));
      assert.ok(error.message.includes(f.supported[1]!.path));
      assert.match(error.message, /manual|merge|remove|resolve|single supported/i);
      return true;
    });
  } finally { await f.cleanup(); }
});

test("oneCandidateOwnsEveryInstalledToolkitEntry", async () => {
  const f = await fixture();
  try {
    const secondName = "second-server";
    const secondToolkit = "second-toolkit";
    const secondOldPath = `${oldManaged}/${secondToolkit}/bin/server.mjs`;
    const secondNewPath = `${f.target.managedRoot}/${secondToolkit}/bin/server.mjs`;
    f.state.toolkits[secondToolkit] = {
      version: "2.0.0", configPath: "/old-project/opencode.json",
      configEntries: [{ name: secondName, expected: { type: "local", command: ["bun", "run", secondOldPath] } }],
      files: [{ path: `/old-project/.opencode/awesome-opencode/toolkits/${secondToolkit}/bin/server.mjs`, hash: "b".repeat(64), mode: 0o644, owner: secondToolkit }],
    };
    const proof = proveHistoricalRoot(f.state, f.target);
    const file = f.supported[0]!.path;
    await f.putConfig(file, { mcp: {
      [name]: { type: "local", command: ["bun", "run", `${f.target.managedRoot}/${toolkit}/bin/server.mjs`] },
      [secondName]: { type: "local", command: ["bun", "run", secondNewPath] },
    } });
    const selection = await selectRepairConfiguration(f.target, f.state, proof, f.supported);
    assert.equal(selection.path, file);
    assert.deepEqual(Object.keys(selection.entries).sort(), [secondToolkit, toolkit].sort());
    assert.equal(selection.entries[secondToolkit]![0]!.name, secondName);
  } finally { await f.cleanup(); }
});

test("sameNameConflictFails", async () => {
  const f = await fixture();
  try {
    await f.put(f.supported[0]!.path, { type: "local", command: ["bun", "run", "/user/changed.mjs"] });
    await assert.rejects(selectRepairConfiguration(f.target, f.state, f.proof, f.supported), /conflict|changed|ownership/i);
  } finally { await f.cleanup(); }
});

test("validOwnerAndChangedCandidateNameBothLocationsAndRemediation", async () => {
  const f = await fixture();
  try {
    const valid = { type: "local", command: ["bun", "run", `${f.target.managedRoot}/${toolkit}/bin/server.mjs`] };
    await f.put(f.supported[0]!.path, valid);
    await f.put(f.supported[1]!.path, { type: "local", command: ["bun", "run", "/user/changed.mjs"] });
    await assert.rejects(selectRepairConfiguration(f.target, f.state, f.proof, f.supported), (error: Error) => {
      assert.ok(error.message.includes(f.supported[0]!.path));
      assert.ok(error.message.includes(f.supported[1]!.path));
      assert.match(error.message, /manual|merge|remove|resolve|single supported/i);
      return true;
    });
  } finally { await f.cleanup(); }
});

test("extraEmptyCandidateCoexistsWhenUnambiguous", async () => {
  const f = await fixture();
  try {
    const owner = f.supported[0]!;
    const current = { ...f.expected, command: ["bun", "run", `${f.target.managedRoot}/${toolkit}/bin/server.mjs`] };
    await f.put(owner.path, current);
    await fs.mkdir(path.dirname(f.supported[1]!.path), { recursive: true });
    await fs.writeFile(f.supported[1]!.path, '{"mcp":{}}');
    assert.equal((await selectRepairConfiguration(f.target, f.state, f.proof, f.supported)).path, owner.path);
  } finally { await f.cleanup(); }
});

test("missingInstalledEntryFails", async () => {
  const f = await fixture();
  try {
    await assert.rejects(selectRepairConfiguration(f.target, f.state, f.proof, f.supported), /missing|owner|entry|ownership/i);
  } finally { await f.cleanup(); }
});

test("unsupportedOnlyOwnerGuidesMigration", async () => {
  const f = await fixture();
  try {
    const observer: ConfigSource = { path: path.join(f.root, "legacy", "opencode.json"), role: "observer", evidenceId: "verified-loaded-legacy" };
    await f.put(observer.path, f.expected);
    await assert.rejects(selectRepairConfiguration(f.target, f.state, f.proof, [observer, ...f.supported]), /migration|unsupported|move/i);
  } finally { await f.cleanup(); }
});

test("verifiedLoadedCompetitorFails", async () => {
  const f = await fixture();
  try {
    const observer: ConfigSource = { path: path.join(f.root, "loaded.json"), role: "observer", evidenceId: "verified-loaded-source" };
    const current = { ...f.expected, command: ["bun", "run", `${f.target.managedRoot}/${toolkit}/bin/server.mjs`] };
    await f.put(f.supported[0]!.path, current);
    await f.put(observer.path, current);
    await assert.rejects(selectRepairConfiguration(f.target, f.state, f.proof, [observer, ...f.supported]), /comp|override|observer|loaded/i);
  } finally { await f.cleanup(); }
});

test("validOwnerAndChangedLoadedObserverNameBothLocationsAndRemediation", async () => {
  const f = await fixture();
  try {
    const observer: ConfigSource = { path: path.join(f.root, "loaded.json"), role: "observer", evidenceId: "verified-loaded-changed-source" };
    const valid = { type: "local", command: ["bun", "run", `${f.target.managedRoot}/${toolkit}/bin/server.mjs`] };
    await f.put(f.supported[0]!.path, valid);
    await f.put(observer.path, { type: "local", command: ["bun", "run", "/user/changed.mjs"] });
    await assert.rejects(selectRepairConfiguration(f.target, f.state, f.proof, [observer, ...f.supported]), (error: Error) => {
      assert.ok(error.message.includes(f.supported[0]!.path));
      assert.ok(error.message.includes(observer.path));
      assert.match(error.message, /manual|merge|remove|resolve|single supported/i);
      return true;
    });
  } finally { await f.cleanup(); }
});

test("composesMixedOldAndCurrentJSONCEntriesAndPreservesSnapshots", async () => {
  const f = await fixture();
  try {
    const secondName = "second-server";
    const secondToolkit = "second-toolkit";
    const firstOld = `${oldManaged}/${toolkit}/bin/server.mjs`;
    const firstCurrent = `${f.target.managedRoot}/${toolkit}/bin/server.mjs`;
    const secondOld = `${oldManaged}/${secondToolkit}/bin/server.mjs`;
    const secondCurrent = `${f.target.managedRoot}/${secondToolkit}/bin/server.mjs`;
    f.state.toolkits[secondToolkit] = {
      version: "2.0.0", configPath: "/old-project/opencode.json",
      configEntries: [{ name: secondName, expected: { type: "local", command: ["bun", "run", secondOld] } }],
      files: [{ path: `/old-project/.opencode/awesome-opencode/toolkits/${secondToolkit}/bin/server.mjs`, hash: "b".repeat(64), mode: 0o644, owner: secondToolkit }],
    };
    const originalState = structuredClone(f.state);
    const proof = proveHistoricalRoot(f.state, f.target);
    const ownerPath = f.supported[0]!.path;
    const originalSource = `{
  // owned entries retain surrounding JSONC formatting
  "mcp": {
    "${name}": { "type": "local", "command": ["bun", "run", "${firstOld}"] },
    "${secondName}": { "type": "local", "command": ["bun", "run", "${secondCurrent}"] }
  },
  "theme": { "name": "preserve me" }
}\n`;
    await fs.mkdir(path.dirname(ownerPath), { recursive: true });
    await fs.writeFile(ownerPath, originalSource);

    const selection = await selectRepairConfiguration(f.target, f.state, proof, f.supported);
    const expectedSource = originalSource.replace(JSON.stringify(firstOld), JSON.stringify(firstCurrent));
    assert.equal(selection.path, ownerPath);
    assert.equal(selection.source, expectedSource);
    const ownerRead = selection.reads.find((read) => read.path === ownerPath);
    assert.equal(ownerRead?.expected.content, originalSource);
    assert.equal(ownerRead?.expected.encoding, "utf8");
    assert.deepEqual(selection.entries, Object.fromEntries(Object.entries(proof.rebasedState.toolkits).map(([toolkitName, installed]) => [toolkitName, installed.configEntries])));
    assert.equal((selection.entries[toolkit]![0]!.expected as { command: string[] }).command[2], firstCurrent);
    assert.equal((selection.entries[secondToolkit]![0]!.expected as { command: string[] }).command[2], secondCurrent);
    assert.deepEqual(f.state, originalState);
  } finally { await f.cleanup(); }
});

test("inactiveUnsupportedSourceIsPreserved", async () => {
  const f = await fixture();
  try {
    const inactivePath = path.join(f.root, "legacy", "opencode.json");
    await fs.mkdir(path.dirname(inactivePath), { recursive: true });
    await fs.writeFile(inactivePath, "{\"consumer\":true}\n");
    const current = { ...f.expected, command: ["bun", "run", `${f.target.managedRoot}/${toolkit}/bin/server.mjs`] };
    await f.put(f.supported[0]!.path, current);
    const result = await selectRepairConfiguration(f.target, f.state, f.proof, f.supported);
    assert.equal(result.path, f.supported[0]!.path);
    assert.equal(await fs.readFile(inactivePath, "utf8"), "{\"consumer\":true}\n");
    assert.ok(!result.reads.some(({ path: readPath }) => readPath === inactivePath));
  } finally { await f.cleanup(); }
});

test("snapshotsEveryCandidateAndAbsence", async () => {
  const f = await fixture();
  try {
    const current = { ...f.expected, command: ["bun", "run", `${f.target.managedRoot}/${toolkit}/bin/server.mjs`] };
    await f.put(f.supported[0]!.path, current);
    const result = await selectRepairConfiguration(f.target, f.state, f.proof, f.supported);
    assert.deepEqual(result.reads.map(({ path: readPath }) => readPath), f.candidates);
    assert.equal(result.reads.filter((read) => read.expected.exists).length, 1);
    assert.equal(result.reads.filter((read) => !read.expected.exists).length, f.candidates.length - 1);
  } finally { await f.cleanup(); }
});

test("neverReadsStaleConfigPath", async () => {
  const f = await fixture();
  try {
    const current = { ...f.expected, command: ["bun", "run", `${f.target.managedRoot}/${toolkit}/bin/server.mjs`] };
    await f.put(f.supported[0]!.path, current);
    const stale = f.state.toolkits[toolkit]!.configPath;
    const check = (filePath: unknown) => {
      if (typeof filePath === "string" && filePath.startsWith("/old-project/")) throw new Error(`stale path access: ${filePath}`);
    };
    const restores = [];
    for (const method of ["access", "lstat", "stat", "realpath", "readFile", "readdir", "open"] as const) {
      const original = fs[method].bind(fs) as (...args: unknown[]) => unknown;
      restores.push(mock.method(fs, method, ((filePath: unknown, ...args: unknown[]) => { check(filePath); return original(filePath, ...args); }) as never));
    }
    for (const method of ["accessSync", "lstatSync", "statSync", "realpathSync", "readFileSync", "readdirSync", "openSync"] as const) {
      const original = fsSync[method].bind(fsSync) as (...args: unknown[]) => unknown;
      restores.push(mock.method(fsSync, method, ((filePath: unknown, ...args: unknown[]) => { check(filePath); return original(filePath, ...args); }) as never));
    }
    const originalStream = fsSync.createReadStream.bind(fsSync);
    restores.push(mock.method(fsSync, "createReadStream", ((filePath: unknown, ...args: unknown[]) => { check(filePath); return originalStream(filePath as never, ...args as []); }) as never));
    syncBuiltinESMExports();
    try {
      await selectRepairConfiguration(f.target, f.state, f.proof, f.supported);
      assert.ok(!stale.startsWith(f.root));
    } finally {
      for (const restore of restores) restore.mock.restore();
      syncBuiltinESMExports();
    }
  } finally { await f.cleanup(); }
});
