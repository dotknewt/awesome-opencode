import assert from "node:assert/strict";
import fs from "node:fs";
import { mock } from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

import { proveHistoricalRoot } from "../installer/src/relocation.js";
import { emptyInstallerState, type InstallerState } from "../installer/src/state.js";
import { validateState } from "../installer/src/state.js";
import type { TargetPaths } from "../installer/src/target.js";

function target(payloadRoot = "/new/project/.opencode", scope: "project" | "global" = "project"): TargetPaths {
  const stateRoot = `${payloadRoot}/awesome-opencode`;
  const projectRoot = "/new/project";
  const candidates = scope === "project"
    ? [`${projectRoot}/opencode.json`, `${projectRoot}/opencode.jsonc`, `${payloadRoot}/opencode.json`, `${payloadRoot}/opencode.jsonc`]
    : [`${payloadRoot}/opencode.json`, `${payloadRoot}/opencode.jsonc`];
  return {
    scope, payloadRoot, managedRoot: `${stateRoot}/toolkits`, stateRoot,
    statePath: `${stateRoot}/state.json`, journalPath: `${stateRoot}/journal.json`,
    lockPath: `${stateRoot}/lock`, configPath: candidates[0]!, configCandidates: candidates,
    defaultConfigPath: candidates[0]!,
  };
}

function record(configPath: string, files: string[] = ["/old/project/.opencode/skills/dotknewt-demo/SKILL.md"], configEntries: InstallerState["toolkits"][string]["configEntries"] = []) {
  return {
    version: "1.0.0", configPath, configEntries,
    files: files.map((file) => ({ path: file, hash: "a".repeat(64), mode: 0o644, owner: "libvirt-toolkit" })),
  };
}
function state(configPath: string, files?: string[], configEntries?: InstallerState["toolkits"][string]["configEntries"]): InstallerState {
  return { formatVersion: 1, toolkits: { "libvirt-toolkit": record(configPath, files, configEntries) } };
}

test("projectRootConfigInfersProjectPayloadRoot", () => {
  const oldPayloadRoot = "/old/project/.opencode";
  const proof = proveHistoricalRoot(state("/old/project/opencode.json"), target());
  assert.equal(proof.previousPayloadRoot, oldPayloadRoot);
  assert.equal(proof.previousManagedRoot, `${oldPayloadRoot}/awesome-opencode/toolkits`);
});

test("nestedConfigInfersNestedPayloadRoot", () => {
  const oldPayloadRoot = "/old/project/.opencode";
  const proof = proveHistoricalRoot(state(`${oldPayloadRoot}/opencode.json`, [`${oldPayloadRoot}/skills/dotknewt-demo/SKILL.md`]), target());
  assert.equal(proof.previousPayloadRoot, oldPayloadRoot);
});

test("globalConfigRequiresOpencodeDirectory", () => {
  const t = target("/new/config/opencode", "global");
  const good = state("/old/config/opencode/opencode.json", ["/old/config/opencode/skills/dotknewt-demo/SKILL.md"]);
  assert.equal(proveHistoricalRoot(good, t).previousPayloadRoot, "/old/config/opencode");
  assert.throws(() => proveHistoricalRoot(state("/old/config/opencode.json"), t));
});

test("emptyStateUsesIdentityWithoutProof", () => {
  const t = target();
  const proof = proveHistoricalRoot(emptyInstallerState(), t);
  assert.equal(proof.previousPayloadRoot, t.payloadRoot);
  assert.equal(proof.previousManagedRoot, t.managedRoot);
  assert.deepEqual(proof.rebasedState, emptyInstallerState());
});

test("emptyInventoryCannotInventProof", () => {
  assert.throws(() => proveHistoricalRoot(state("/old/project/opencode.json", []), target()));
});

test("skillsOnlyRecordRebasesConfigPathWithoutMcp", () => {
  const t = target();
  const old = state("/old/project/opencode.jsonc");
  const before = structuredClone(old);
  const proof = proveHistoricalRoot(old, t);
  assert.equal(proof.rebasedState.toolkits["libvirt-toolkit"]?.configPath, t.configCandidates[1]);
  assert.equal(proof.rebasedState.toolkits["libvirt-toolkit"]?.files[0]?.path, `${t.payloadRoot}/skills/dotknewt-demo/SKILL.md`);
  assert.deepEqual(old, before);
});

test("opencodeBasenameAmbiguityFailsClosed", () => {
  const t = target();
  assert.throws(() => proveHistoricalRoot(state("/old/project/.opencode/opencode.json", []), t), /ambiguous|prove|root|inventory/i);
  const nestedProject = state("/old/.opencode/opencode.json", ["/old/.opencode/.opencode/skills/public-name/SKILL.md"]);
  assert.equal(proveHistoricalRoot(nestedProject, t).previousPayloadRoot, "/old/.opencode/.opencode");
});

test("malformedStateRejectedBeforePathResolution", () => {
  const malformed = state("/old/project/opencode.json", ["/old/project/../outside"]);
  assert.throws(() => validateState(malformed), /absolute|traversal|path/i);
  assert.throws(() => validateState(state("relative/config.json")), /absolute|path/i);
  for (const invalid of ["/old//project/opencode.json", "/old/./project/opencode.json", "/old/project/\0config", "/old/project/"]) {
    assert.throws(() => validateState(state(invalid)));
  }
});

test("mixedHistoricalRootsAreRejected", () => {
  const mixed = state("/old/project/opencode.json");
  mixed.toolkits.other = record("/other/project/opencode.json", ["/other/project/.opencode/skills/public-name/SKILL.md"]);
  for (const file of mixed.toolkits.other.files) file.owner = "other";
  assert.throws(() => proveHistoricalRoot(mixed, target()));
});

test("emptyRecordsConstrainButDoNotProveRoots", () => {
  const nonempty = state("/old/project/opencode.json");
  const compatible = record("/old/project/.opencode/opencode.json", []);
  nonempty.toolkits.empty = { ...compatible, files: [] };
  assert.equal(proveHistoricalRoot(nonempty, target()).previousPayloadRoot, "/old/project/.opencode");
  const emptyFirst: InstallerState = { formatVersion: 1, toolkits: { empty: structuredClone(nonempty.toolkits.empty!), ...structuredClone(nonempty.toolkits) } };
  assert.equal(proveHistoricalRoot(emptyFirst, target()).previousPayloadRoot, "/old/project/.opencode");
  for (const mixed of [
    { formatVersion: 1 as const, toolkits: { ...nonempty.toolkits, contradictory: { ...record("/other/project/opencode.json", []), files: [] } } },
    { formatVersion: 1 as const, toolkits: { contradictory: { ...record("/other/project/opencode.json", []), files: [] }, ...nonempty.toolkits } },
  ]) assert.throws(() => proveHistoricalRoot(mixed, target()));
});

test("unknownHistoricalToolkitNeedsNoCatalog", () => {
  const unknown = state("/old/project/opencode.json");
  unknown.toolkits["retired-toolkit"] = record("/old/project/opencode.json", ["/old/project/.opencode/skills/public-name/SKILL.md"]);
  for (const file of unknown.toolkits["retired-toolkit"]!.files) file.owner = "retired-toolkit";
  assert.equal(proveHistoricalRoot(unknown, target()).previousPayloadRoot, "/old/project/.opencode");
});

test("historicalProofAcceptsLongNativePublicNames", () => {
  const publicName = "a".repeat(65);
  const proof = proveHistoricalRoot(state("/old/project/opencode.json", [
    `/old/project/.opencode/skills/${publicName}/SKILL.md`,
    `/old/project/.opencode/agents/${publicName}.md`,
    `/old/project/.opencode/commands/${publicName}.md`,
  ]), target());
  assert.equal(proof.previousPayloadRoot, "/old/project/.opencode");
  assert.equal(proof.rebasedState.toolkits["libvirt-toolkit"]?.files[0]?.path, `${target().payloadRoot}/skills/${publicName}/SKILL.md`);
});

test("historicalProofPerformsNoFilesystemProbes", () => {
  let probes = 0;
  const deny = () => { probes++; throw new Error("unexpected filesystem probe"); };
  const asyncMethods = ["access", "lstat", "stat", "realpath", "readFile", "readdir", "open"] as const;
  const callbackMethods = ["access", "lstat", "stat", "realpath", "readFile", "readdir", "open"] as const;
  const syncMethods = ["accessSync", "lstatSync", "statSync", "realpathSync", "readFileSync", "readdirSync", "openSync"] as const;
  const restores = [
    ...asyncMethods.filter((name) => typeof fsPromises[name] === "function").map((name) => mock.method(fsPromises, name, deny as never)),
    ...callbackMethods.filter((name) => typeof fs[name] === "function").map((name) => mock.method(fs, name, deny as never)),
    ...syncMethods.filter((name) => typeof fs[name] === "function").map((name) => mock.method(fs, name, deny as never)),
    mock.method(fs, "createReadStream", deny as never),
  ];
  syncBuiltinESMExports();
  try {
    assert.doesNotThrow(() => proveHistoricalRoot(state("/old/project/opencode.json"), target()));
    const malformedStates = [
      state("relative/config.json"),
      state("/old//project/opencode.json"),
      state("/old/./project/opencode.json"),
      state("/old/project/opencode.json", ["/old/project/../outside"]),
      state("/old/project/opencode.json", ["/old/project//skills/demo/SKILL.md"]),
    ];
    for (const malformed of malformedStates) assert.throws(() => proveHistoricalRoot(malformed, target()));
    const malformedMcp = state("/old/project/opencode.json");
    malformedMcp.toolkits["libvirt-toolkit"]!.configEntries = [{ name: "demo-server", expected: { type: "local", command: ["uv", "relative.py"] } }];
    assert.throws(() => proveHistoricalRoot(malformedMcp, target()));
    assert.equal(probes, 0);
  } finally {
    for (const restore of restores) restore.mock.restore();
    syncBuiltinESMExports();
  }
});
