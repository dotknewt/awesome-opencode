import assert from "node:assert/strict";
import test from "node:test";

import { editOwnedCommandPaths, matchRelocatedEntry, parseConfig } from "../installer/src/config.js";

const oldRoot = "/old/project/.opencode/awesome-opencode/toolkits";
const currentRoot = "/new/project/.opencode/awesome-opencode/toolkits";
const oldPath = `${oldRoot}/demo-toolkit/bin/server.mjs`;
const currentPath = `${currentRoot}/demo-toolkit/bin/server.mjs`;
const expected = { type: "local", command: ["bun", "run", oldPath] };
const relocated = { type: "local", command: ["bun", "run", currentPath] };

test("acceptsExactGeneratedFinalCommandPath", () => {
  assert.deepEqual(matchRelocatedEntry(expected, expected, oldRoot, currentRoot), [
    { index: 2, before: oldPath, after: currentPath },
  ]);
});

test("alreadyCurrentEntryNeedsNoEdit", () => {
  assert.deepEqual(matchRelocatedEntry({ ...expected, command: ["bun", "run", currentPath] }, expected, oldRoot, currentRoot), []);
});

test("sameManagedRootNeedsNoEdit", () => {
  assert.deepEqual(matchRelocatedEntry(expected, expected, oldRoot, oldRoot), []);
});

test("rejectsPrefixSubstringAndSuffixLookalikes", () => {
  for (const bad of [
    `${oldPath}.backup`, `${oldPath}/nested`, `/prefix${oldPath}`, oldPath.replace("/demo-toolkit/", "/other-demo-toolkit/"),
  ]) {
    assert.throws(() => matchRelocatedEntry({ ...expected, command: ["bun", "run", bad] }, expected, oldRoot, currentRoot));
  }
});

test("rejectsMultiplePathSubstitutions", () => {
  assert.deepEqual(matchRelocatedEntry(
    { type: "local", command: [oldPath, currentPath] },
    { type: "local", command: [oldPath, oldPath] }, oldRoot, currentRoot,
  ), []);
  assert.deepEqual(matchRelocatedEntry(
    { type: "local", command: [oldPath, oldPath] },
    { type: "local", command: [oldPath, oldPath] }, oldRoot, currentRoot,
  ), [{ index: 1, before: oldPath, after: currentPath }]);
  assert.throws(() => matchRelocatedEntry(
    { type: "local", command: [currentPath, currentPath] },
    { type: "local", command: [oldPath, oldPath] }, oldRoot, currentRoot,
  ));
});

test("rejectsChangedExecutableAndOtherArguments", () => {
  for (const command of [["node", "run", currentPath], ["bun", "other", currentPath], ["bun", "run", "--flag", currentPath]]) {
    assert.throws(() => matchRelocatedEntry({ ...relocated, command }, expected, oldRoot, currentRoot));
  }
});

test("rejectsMissingExtraAndChangedFields", () => {
  for (const actual of [
    { ...relocated, command: ["bun", "run"] },
    { ...relocated, extra: true },
    { type: "local", command: ["bun", "run", currentPath], environment: {} },
  ]) assert.throws(() => matchRelocatedEntry(actual, expected, oldRoot, currentRoot));
});

test("rejectsTypeEnabledAndUnknownFieldChanges", () => {
  for (const actual of [
    { ...relocated, type: "remote" },
    { ...relocated, enabled: false },
    { ...relocated, custom: "changed" },
  ]) assert.throws(() => matchRelocatedEntry(actual, expected, oldRoot, currentRoot));
});

test("preservesJsoncCommentsAndUnrelatedBytes", () => {
  const source = '{\n  // consumer note\n  "theme": {"name": "custom"},\n  "mcp": {\n    "demo-server": {\n      "type": "local",\n      "command": ["bun", /* executable stays */ "run", "' + oldPath + '"]\n    }\n  }\n}\n';
  const edited = editOwnedCommandPaths(source, "demo-server", [{ index: 2, before: oldPath, after: currentPath }]);
  assert.equal(edited, source.replace(JSON.stringify(oldPath), JSON.stringify(currentPath)));
});

test("rejectsDuplicateJsoncKeys", () => {
  assert.throws(() => parseConfig('{"mcp":{"demo-server":{},"demo-server":{}}}'), /duplicate/i);
  assert.throws(() => editOwnedCommandPaths('{"mcp":{"demo-server":{"command":[],"command":[]}}}', "demo-server", []), /duplicate/i);
});
