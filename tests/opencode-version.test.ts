import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("shared version helper is self-contained and runner reexports the same validator", async (t) => {
  await mkdir("/tmp/opencode", { recursive: true });
  const root = await mkdtemp("/tmp/opencode/version-helper-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = path.resolve("scripts/opencode-version.mjs");
  await copyFile(helper, path.join(root, "opencode-version.mjs"));
  await copyFile(path.resolve("scripts/check-opencode-config-matrix.mjs"), path.join(root, "driver.mjs"));
  const isolated = await import(pathToFileURL(path.join(root, "opencode-version.mjs")).href);
  const driver = await import(pathToFileURL(path.join(root, "driver.mjs")).href);
  assert.equal(driver.validateOpenCodeVersion, isolated.validateOpenCodeVersion);
  assert.equal(isolated.parseStableV2Version, isolated.validateOpenCodeVersion);
  assert.equal(isolated.readStableV2Version, isolated.readOpenCodeVersion);
  for (const version of ["2.2.1", "2.10.0", "3.0.0", "9007199254740993.0.0", "2.2.1+build.001"]) {
    assert.equal(isolated.validateOpenCodeVersion(`opencode v${version}\n`), `opencode v${version}`);
  }
  for (const output of [null, {}, "opencode v2.1.1", "opencode v2.2.0", "opencode v03.0.0", "opencode v3.0.0-rc.1", "opencode v2.2.1+a..b", "opencode v2.2.1\nnoise"]) {
    assert.throws(() => isolated.validateOpenCodeVersion(output), /unsupported OpenCode version/);
  }
});
