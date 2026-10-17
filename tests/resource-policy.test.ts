import assert from "node:assert/strict";
import test from "node:test";

import { assertInstalledRelativePath, classifyMutationResource } from "../installer/src/resource-policy.js";
import { validateState, type InstallerState } from "../installer/src/state.js";
import { proveHistoricalRoot } from "../installer/src/relocation.js";
import type { TargetPaths } from "../installer/src/target.js";

const target: TargetPaths = {
  scope: "project", payloadRoot: "/project/.opencode", managedRoot: "/project/.opencode/awesome-opencode/toolkits",
  stateRoot: "/project/.opencode/awesome-opencode", statePath: "/project/.opencode/awesome-opencode/state.json",
  journalPath: "/project/.opencode/awesome-opencode/journal.json", lockPath: "/project/.opencode/awesome-opencode/lock",
  configPath: "/project/opencode.json", configCandidates: ["/project/opencode.json", "/project/opencode.jsonc", "/project/.opencode/opencode.json", "/project/.opencode/opencode.jsonc"],
  defaultConfigPath: "/project/opencode.json",
};

test("installedPathsRejectAbsoluteAndTraversal", () => {
  assert.throws(() => assertInstalledRelativePath("alpha", "/tmp/file"));
  assert.throws(() => assertInstalledRelativePath("alpha", "../outside"));
  assert.throws(() => assertInstalledRelativePath("alpha", "skills/../outside"));
  assert.throws(() => assertInstalledRelativePath("alpha", "skills//demo/file"));
});

test("aliasesAndPrefixCollisionsAreRejected", () => {
  assert.throws(() => assertInstalledRelativePath("alpha", "skills/demo/./file"));
  assert.throws(() => assertInstalledRelativePath("alpha", "skills/demo/"));
  assert.throws(() => assertInstalledRelativePath("alpha", "agents/alpha.md/child"));
  const state: InstallerState = { formatVersion: 1, toolkits: { alpha: {
    version: "1", configPath: "/project/opencode.json", configEntries: [],
    files: ["/project/.opencode/skills/demo", "/project/.opencode/skills/demo/SKILL.md"].map((path) => ({ path, hash: "a".repeat(64), mode: 0o644, owner: "alpha" })),
  } } };
  assert.throws(() => validateState(state), /prefix|ancestor|collision|ownership/i);
  const alphaRecord = state.toolkits.alpha!;
  assert.throws(() => validateState({ ...state, toolkits: { alpha: { ...alphaRecord, files: [alphaRecord.files[0]!, { ...alphaRecord.files[0]! }] } } }), /duplicate|ownership/i);
});

test("nativeNamespacesRequireOwnerLayout", () => {
  const longPublicName = "a".repeat(65);
  assert.doesNotThrow(() => assertInstalledRelativePath("alpha", "skills/public-name/SKILL.md"));
  assert.doesNotThrow(() => assertInstalledRelativePath("alpha", "agents/public-name.md"));
  assert.doesNotThrow(() => assertInstalledRelativePath("alpha", "commands/public-name.md"));
  assert.doesNotThrow(() => assertInstalledRelativePath("alpha", "awesome-opencode/toolkits/alpha/server/main.py"));
  assert.throws(() => assertInstalledRelativePath("alpha", "awesome-opencode/toolkits/beta/server/main.py"));
  assert.throws(() => assertInstalledRelativePath("alpha", "arbitrary/namespace/file"));
  assert.throws(() => assertInstalledRelativePath("NOT_A_TOOLKIT", "skills/public-name/SKILL.md"));
  assert.throws(() => assertInstalledRelativePath("a".repeat(65), "skills/public-name/SKILL.md"));
  assert.throws(() => assertInstalledRelativePath("alpha", `awesome-opencode/toolkits/${"a".repeat(65)}/file`));
  assert.throws(() => assertInstalledRelativePath("alpha", "awesome-opencode/toolkits/.control/file"));
  assert.doesNotThrow(() => assertInstalledRelativePath("alpha", `skills/${longPublicName}/SKILL.md`));
  assert.doesNotThrow(() => assertInstalledRelativePath("alpha", `agents/${longPublicName}.md`));
  assert.doesNotThrow(() => assertInstalledRelativePath("alpha", `commands/${longPublicName}.md`));
});

test("mcpEntrypointMustBeOwnedAndInventoried", () => {
  const entrypoint = "/old/project/.opencode/awesome-opencode/toolkits/alpha/server.py";
  const state = (path: string, commandPath = entrypoint): InstallerState => ({ formatVersion: 1, toolkits: { alpha: {
    version: "1", configPath: "/old/project/opencode.json", configEntries: [{ name: "alpha-server", expected: { type: "local", command: ["uv", "run", "--script", commandPath], enabled: true } }],
    files: [{ path, hash: "a".repeat(64), mode: 0o755, owner: "alpha" }],
  } } });
  assert.doesNotThrow(() => assertInstalledRelativePath("alpha", "awesome-opencode/toolkits/alpha/server.py"));
  const valid = state(entrypoint);
  valid.toolkits.alpha!.configEntries[0]!.expected = { type: "local", command: ["uv", "--note=/old/project/unchanged", "--script", entrypoint], enabled: true, extra: "preserved" };
  const before = structuredClone(valid);
  const validProof = proveHistoricalRoot(valid, target);
  assert.equal(validProof.previousPayloadRoot, "/old/project/.opencode");
  assert.deepEqual(validProof.rebasedState.toolkits.alpha!.configEntries[0]!.expected, {
    type: "local", command: ["uv", "--note=/old/project/unchanged", "--script", `${target.managedRoot}/alpha/server.py`], enabled: true, extra: "preserved",
  });
  assert.deepEqual(valid, before);
  const outside = "/old/project/.opencode/awesome-opencode/toolkits/other/server.py";
  assert.throws(() => assertInstalledRelativePath("alpha", "awesome-opencode/toolkits/other/server.py"));
  assert.throws(() => proveHistoricalRoot(state(outside, outside), target));
  assert.throws(() => proveHistoricalRoot(state(entrypoint, outside), target));
  assert.throws(() => proveHistoricalRoot(state("/old/project/.opencode/awesome-opencode/toolkits/alpha/absent.py"), target));
  for (const expected of [null, "invalid", { type: "remote", command: ["uv", entrypoint] }, { type: "local" }, { type: "local", command: [] }, { type: "local", command: ["uv", "relative.py"] }, { type: "local", command: ["uv", 42] }]) {
    const malformed = state(entrypoint);
    malformed.toolkits.alpha!.configEntries = [{ name: "alpha-server", expected }];
    assert.throws(() => proveHistoricalRoot(malformed, target));
  }
  const noncanonical = state(entrypoint);
  noncanonical.toolkits.alpha!.configEntries = [{ name: "alpha-server", expected: { type: "local", command: ["uv", `${entrypoint}/../server.py`] } }];
  assert.throws(() => proveHistoricalRoot(noncanonical, target));
});

test("hashAndModeAreStrict", () => {
  const base = { formatVersion: 1 as const, toolkits: { alpha: {
    version: "1", configPath: "/old/project/opencode.json", configEntries: [],
    files: [{ path: "/old/project/skills/demo/SKILL.md", hash: "a".repeat(64), mode: 0o644, owner: "alpha" }],
  } } };
  assert.doesNotThrow(() => validateState(base));
  for (const hash of ["a".repeat(63), "g".repeat(64), "A".repeat(64)]) {
    assert.throws(() => validateState({ ...base, toolkits: { alpha: { ...base.toolkits.alpha, files: [{ ...base.toolkits.alpha.files[0]!, hash }] } } }));
  }
  for (const mode of [-1, 1.5, Number.NaN, 0o1000]) {
    assert.throws(() => validateState({ ...base, toolkits: { alpha: { ...base.toolkits.alpha, files: [{ ...base.toolkits.alpha.files[0]!, mode }] } } }));
  }
});

test("classifierRejectsJournalLockTempAndControlPaths", () => {
  assert.equal(classifyMutationResource(target, target.configCandidates[0]!), "config");
  assert.equal(classifyMutationResource(target, `${target.payloadRoot}/skills/demo/SKILL.md`), "payload");
  assert.equal(classifyMutationResource(target, `${target.payloadRoot}/agents/demo.md`), "payload");
  assert.equal(classifyMutationResource(target, `${target.payloadRoot}/commands/demo.md`), "payload");
  const longPublicName = "a".repeat(65);
  assert.equal(classifyMutationResource(target, `${target.payloadRoot}/skills/${longPublicName}/SKILL.md`), "payload");
  assert.equal(classifyMutationResource(target, `${target.payloadRoot}/agents/${longPublicName}.md`), "payload");
  assert.equal(classifyMutationResource(target, `${target.payloadRoot}/commands/${longPublicName}.md`), "payload");
  assert.equal(classifyMutationResource(target, `${target.managedRoot}/alpha/server.py`), "payload");
  assert.equal(classifyMutationResource(target, target.statePath), "state");
  assert.equal(classifyMutationResource(target, `${target.managedRoot}/beta/server.py`), "payload");
  assert.equal(classifyMutationResource(target, `${target.payloadRoot}/skills/demo/AGENTS.md`), "payload");
  for (const denied of [target.journalPath, target.lockPath, `${target.statePath}.123-abc.tmp`, `${target.journalPath}.123-abc.tmp`, `${target.payloadRoot}/skills/demo/file.awesome-opencode-123-abc.tmp`, target.payloadRoot, `${target.configCandidates[0]}.backup`, "/project/AGENTS.md", `${target.payloadRoot}/control/state.json`, `${target.managedRoot}/beta`, `${target.managedRoot}/NOT_A_TOOLKIT/file`, `${target.managedRoot}/.control/file`, `${target.managedRoot}/${"a".repeat(65)}/file`]) {
    assert.throws(() => classifyMutationResource(target, denied));
  }
  assert.throws(() => classifyMutationResource(target, `${target.statePath}.old`));
});
