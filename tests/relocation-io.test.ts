import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, lstat, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { InstallerEngine } from "../installer/src/installer-engine.js";
import { resolveTarget } from "../installer/src/target.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const guardModule = path.join(repo, "scripts/relocation-io-guard.mjs");
const compiledEngine = path.join(repo, "dist/installer/src/installer-engine.js");
const compiledTarget = path.join(repo, "dist/installer/src/target.js");
const toolkit = "io-fixture-toolkit";
const mcp = "dotknewt-io-fixture-server";

function child(source: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: options.cwd ?? repo, encoding: "utf8", env: { ...process.env, ...options.env },
  });
}
function requireSuccess(result: ReturnType<typeof child>) {
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
}

async function makeCatalog(root: string, version: string) {
  const catalog = path.join(root, "catalog");
  const source = path.join(catalog, toolkit);
  await mkdir(path.join(source, "skills", "dotknewt-io"), { recursive: true });
  await mkdir(path.join(source, "server"), { recursive: true });
  await writeFile(path.join(source, "skills", "dotknewt-io", "SKILL.md"), `version ${version}\n`);
  await writeFile(path.join(source, "server", "entry.mjs"), `export default ${JSON.stringify(version)};\n`);
  await chmod(path.join(source, "server", "entry.mjs"), 0o755);
  await writeFile(path.join(source, "toolkit.json"), JSON.stringify({
    schemaVersion: 1, name: toolkit, namespace: "dotknewt", version,
    description: "isolated relocation fixture", license: "MIT",
    exports: [
      { kind: "skill", source: "skills/dotknewt-io", destination: "skills/dotknewt-io" },
      { kind: "asset", source: "server", destination: "managed/server" },
    ], requiredSkills: ["dotknewt-io"],
    mcp: [{ name: mcp, type: "local", command: ["node"], entrypoint: "managed/server/entry.mjs", enabled: true }],
    dependencies: { platforms: ["linux"], executables: ["node"] },
  }, null, 2));
  return catalog;
}

async function makeProjectFixture(opts: { present?: boolean; jsonc?: boolean; sameRoot?: boolean } = {}) {
  const root = await mkdtemp("/tmp/opencode/relocation-io-project-");
  const oldProject = path.join(root, "old-project");
  const currentProject = opts.sameRoot ? oldProject : path.join(root, "new-project");
  await mkdir(oldProject, { recursive: true });
  const oldCatalog = await makeCatalog(path.join(root, "old"), "1.0.0");
  const newCatalog = await makeCatalog(path.join(root, "new"), "2.0.0");
  const oldTarget = await resolveTarget({ scope: "project", projectRoot: oldProject });
  const oldEngine = new InstallerEngine({ catalogRoot: oldCatalog, target: oldTarget });
  await oldEngine.install([toolkit]);
  const oldConfigPath = path.join(oldProject, "opencode.json");
  const oldConfig = await readFile(oldConfigPath, "utf8");
  const oldFinal = path.join(oldTarget.managedRoot, toolkit, "managed/server/entry.mjs");
  const configPath = path.join(currentProject, opts.jsonc ? "opencode.jsonc" : "opencode.json");
  let source = oldConfig;
  if (opts.jsonc) source = source.replace('"command": [', '"command": [/* internal-command-note */ ');
  if (!opts.sameRoot) {
    await mkdir(currentProject, { recursive: true });
    const currentTarget = await resolveTarget({ scope: "project", projectRoot: currentProject });
    await cp(oldTarget.payloadRoot, currentTarget.payloadRoot, { recursive: true });
    await writeFile(configPath, source);
  } else if (configPath !== oldConfigPath) {
    await rm(oldConfigPath);
    await writeFile(configPath, source);
  } else {
    await writeFile(configPath, source);
  }
  if (!opts.sameRoot) {
    await writeFile(path.join(oldTarget.payloadRoot, "old-tree-sentinel"), "leave untouched");
  }
  const currentTarget = await resolveTarget({ scope: "project", projectRoot: currentProject });
  return { root, oldTarget, oldProject, currentProject, oldConfigPath, configPath, oldFinal, newCatalog, currentTarget, source };
}

function observedUpdate(args: { oldRoot: string; catalog: string; target: unknown; toolkitNames?: string[]; dryRun?: boolean }) {
  return child(`
    import assert from 'node:assert/strict';
    import { syncBuiltinESMExports } from 'node:module';
    import { createRelocationIOGuard } from ${JSON.stringify(guardModule)};
    const guard = createRelocationIOGuard({ forbiddenRoots: [${JSON.stringify(args.oldRoot)}] });
    guard.install(); syncBuiltinESMExports(); guard.start();
    try {
      const { InstallerEngine } = await import(${JSON.stringify(compiledEngine)});
      const engine = new InstallerEngine({ catalogRoot: ${JSON.stringify(args.catalog)}, target: ${JSON.stringify(args.target)} });
      const plan = await engine.update(${JSON.stringify(args.toolkitNames ?? [toolkit])}, { dryRun: ${Boolean(args.dryRun)} });
      assert.deepEqual(guard.stalePathOperations, []);
      console.log(JSON.stringify({ plan, stalePathOperations: guard.stalePathOperations }));
    } finally { guard.stop(); guard.restore(); syncBuiltinESMExports(); }
  `);
}

test("guardTripsOnReadFile", () => {
  const result = child(`
    import assert from 'node:assert/strict'; import { syncBuiltinESMExports } from 'node:module';
    import * as fs from 'node:fs'; import * as fsp from 'node:fs/promises';
    import { createRelocationIOGuard } from ${JSON.stringify(guardModule)};
    const root='/tmp/opencode/guard-tripwire'; const guard=createRelocationIOGuard({forbiddenRoots:[root]});
    guard.install(); syncBuiltinESMExports(); guard.start();
    try {
      const before=guard.stalePathOperations.length;
      await assert.rejects(fsp.readFile(root+'/x'),e=>e.code==='ERR_RELOCATION_IO_GUARD');
      assert.deepEqual(guard.stalePathOperations.slice(before).map(x=>[x.method,x.path]),[['fs/promises.readFile',root+'/x']]);
    }
    finally { guard.stop(); guard.restore(); syncBuiltinESMExports(); }
  `);
  requireSuccess(result);
});

test("guardTripsOnLstatAccessOpenRealpathAndWrite", () => {
  const result = child(`
    import assert from 'node:assert/strict'; import { syncBuiltinESMExports } from 'node:module';
    import * as fs from 'node:fs'; import * as fsp from 'node:fs/promises';
    import { createRelocationIOGuard } from ${JSON.stringify(guardModule)};
    const root='/tmp/opencode/guard-tripwire'; const guard=createRelocationIOGuard({forbiddenRoots:[root]});
    guard.install(); syncBuiltinESMExports(); guard.start();
    try {
      for (const [name, expectedPath, call] of [['lstat',root+'/x',()=>fsp.lstat(root+'/x')],['access',root+'/x',()=>fsp.access(root+'/x')],['open',root+'/x',()=>fsp.open(root+'/x','r')],['realpath',root,()=>fsp.realpath(root)],['writeFile',root+'/x',()=>fsp.writeFile(root+'/x','x')]]) {
        const before=guard.stalePathOperations.length;
        await assert.rejects(call,e=>e.code==='ERR_RELOCATION_IO_GUARD');
        assert.deepEqual(guard.stalePathOperations.slice(before).map(x=>[x.method,x.path]),[['fs/promises.'+name,expectedPath]]);
      }
      let before=guard.stalePathOperations.length;
      assert.throws(()=>fs.statSync(root+'/x'),e=>e.code==='ERR_RELOCATION_IO_GUARD');
      assert.deepEqual(guard.stalePathOperations.slice(before).map(x=>[x.method,x.path]),[['fs.statSync',root+'/x']]);
      before=guard.stalePathOperations.length;
      await new Promise((resolve, reject) => fs.readFile(root+'/x', error => error?.code==='ERR_RELOCATION_IO_GUARD' ? resolve(undefined) : reject(new Error('callback read did not receive guard error'))));
      assert.deepEqual(guard.stalePathOperations.slice(before).map(x=>[x.method,x.path]),[['fs.readFile',root+'/x']]);
    } finally { guard.stop(); guard.restore(); syncBuiltinESMExports(); }
  `);
  requireSuccess(result);
});

test("guardTracksBothRenameOperandsAndHandles", () => {
  const result = child(`
    import assert from 'node:assert/strict'; import * as fs from 'node:fs'; import * as fsp from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module'; import { createRelocationIOGuard } from ${JSON.stringify(guardModule)};
    const root='/tmp/opencode/guard-tripwire'; fs.mkdirSync(root,{recursive:true}); fs.writeFileSync(root+'/fd','x');
    const guard=createRelocationIOGuard({forbiddenRoots:[root]}); guard.install(); syncBuiltinESMExports();
    const fd=fs.openSync(root+'/fd','r'); const handle=await fsp.open(root+'/fd','r'); guard.start();
    try {
      let before=guard.stalePathOperations.length;
      assert.throws(()=>fs.renameSync(root+'/source', '/tmp/opencode/other-destination'),e=>e.code==='ERR_RELOCATION_IO_GUARD');
      assert.deepEqual(guard.stalePathOperations.slice(before).map(x=>[x.method,x.path]),[['fs.renameSync',root+'/source']]);
      before=guard.stalePathOperations.length;
      assert.throws(()=>fs.renameSync('/tmp/opencode/other-source', root+'/destination'),e=>e.code==='ERR_RELOCATION_IO_GUARD');
      assert.deepEqual(guard.stalePathOperations.slice(before).map(x=>[x.method,x.path]),[['fs.renameSync',root+'/destination']]);
      before=guard.stalePathOperations.length;
      assert.throws(()=>fs.readSync(fd, Buffer.alloc(1), 0, 1, 0),e=>e.code==='ERR_RELOCATION_IO_GUARD');
      assert.deepEqual(guard.stalePathOperations.slice(before).map(x=>[x.method,x.path]),[['fs.readSync',root+'/fd']]);
      before=guard.stalePathOperations.length;
      await assert.rejects(handle.readFile(),e=>e.code==='ERR_RELOCATION_IO_GUARD');
      assert.deepEqual(guard.stalePathOperations.slice(before).map(x=>[x.method,x.path]),[['FileHandle.readFile',root+'/fd']]);
    } finally { guard.stop(); guard.restore(); syncBuiltinESMExports(); fs.closeSync(fd); await handle.close(); fs.rmSync(root,{recursive:true,force:true}); }
  `);
  requireSuccess(result);
});

test("guardTracksBufferFileURLCallbackAndHandleArgumentOperations", () => {
  const result = child(`
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import fsp from 'node:fs/promises';
    import {pathToFileURL} from 'node:url'; import {syncBuiltinESMExports} from 'node:module';
    import {createRelocationIOGuard} from ${JSON.stringify(guardModule)};
    const root='/tmp/opencode/guard-path-forms'; fs.mkdirSync(root,{recursive:true}); fs.writeFileSync(root+'/item','data');
    const file=root+'/item'; const guard=createRelocationIOGuard({forbiddenRoots:[root]}); guard.install();syncBuiltinESMExports();
    const handle=await fsp.open(file,'r'); guard.start();
      const expectRecord=(before,method)=>{
        const records=guard.stalePathOperations.slice(before).map(x=>[x.method,x.path]);
        assert.ok(records.length>0,'expected fresh '+method+' record');
        assert.ok(records.every(([actualMethod,actualPath])=>actualMethod===method && actualPath===file),JSON.stringify(records));
      };
    try {
      let before=guard.stalePathOperations.length;
      await assert.rejects(fsp.readFile(Buffer.from(file)),e=>e.code==='ERR_RELOCATION_IO_GUARD'); expectRecord(before,'fs/promises.readFile');
      before=guard.stalePathOperations.length;
      await assert.rejects(fsp.lstat(pathToFileURL(file)),e=>e.code==='ERR_RELOCATION_IO_GUARD'); expectRecord(before,'fs/promises.lstat');
      before=guard.stalePathOperations.length;
      await new Promise((resolve,reject)=>fs.access(file,error=>error?.code==='ERR_RELOCATION_IO_GUARD'?resolve(undefined):reject(new Error('callback access did not receive guard error')))); expectRecord(before,'fs.access');
      before=guard.stalePathOperations.length;
      await assert.rejects(fsp.readFile(handle),e=>e.code==='ERR_RELOCATION_IO_GUARD'); expectRecord(before,'fs/promises.readFile');
      before=guard.stalePathOperations.length;
      await assert.rejects(handle.readFile(),e=>e.code==='ERR_RELOCATION_IO_GUARD'); expectRecord(before,'FileHandle.readFile');
      before=guard.stalePathOperations.length;
      await assert.rejects(handle.stat(),e=>e.code==='ERR_RELOCATION_IO_GUARD'); expectRecord(before,'FileHandle.stat');
      before=guard.stalePathOperations.length;
      await assert.rejects(handle.writeFile('changed'),e=>e.code==='ERR_RELOCATION_IO_GUARD'); expectRecord(before,'FileHandle.writeFile');
      before=guard.stalePathOperations.length;
      assert.throws(()=>fs.readSync(handle.fd,Buffer.alloc(1),0,1,0),e=>e.code==='ERR_RELOCATION_IO_GUARD'); expectRecord(before,'fs.readSync');
      before=guard.stalePathOperations.length;
      await assert.rejects(handle.readv([Buffer.alloc(1)]),e=>e.code==='ERR_RELOCATION_IO_GUARD'); expectRecord(before,'FileHandle.readv');
      before=guard.stalePathOperations.length;
      await assert.rejects(handle.writev([Buffer.from('x')]),e=>e.code==='ERR_RELOCATION_IO_GUARD'); expectRecord(before,'FileHandle.writev');
    } finally {guard.stop();guard.restore();syncBuiltinESMExports();await handle.close();fs.rmSync(root,{recursive:true,force:true});}
  `);
  requireSuccess(result);
});

test("fixtureSetupIsOutsideObservation", () => {
  const result = child(`
    import assert from 'node:assert/strict'; import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
    import {syncBuiltinESMExports} from 'node:module'; import {createRelocationIOGuard} from ${JSON.stringify(guardModule)};
    const dir='/tmp/opencode/guard-fixture-outside'; const guard=createRelocationIOGuard({forbiddenRoots:[dir]}); guard.install();syncBuiltinESMExports();
    try { await rm(dir,{recursive:true,force:true}); await mkdir(dir,{recursive:true}); await writeFile(dir+'/fixture','x'); guard.start(); assert.deepEqual(guard.stalePathOperations,[]); guard.stop(); await readFile(dir+'/fixture'); await rm(dir,{recursive:true,force:true}); assert.deepEqual(guard.stalePathOperations,[]); }
    finally {guard.stop();guard.restore();syncBuiltinESMExports();}
  `);
  requireSuccess(result);
});

for (const present of [true, false]) test(present ? "projectRelocationOldTreePresentNoOldRead" : "projectRelocationOldTreeAbsent", async () => {
  const f = await makeProjectFixture({ present });
  try {
    if (!present) await rm(f.oldProject, { recursive: true, force: true });
    const result = observedUpdate({ oldRoot: f.oldProject, catalog: f.newCatalog, target: f.currentTarget });
    requireSuccess(result);
    const output = JSON.parse(result.stdout.trim());
    assert.deepEqual(output.stalePathOperations, []);
    const state = JSON.parse(await readFile(f.currentTarget.statePath, "utf8"));
    assert.equal(state.toolkits[toolkit].version, "2.0.0");
    assert.ok(state.toolkits[toolkit].files.every((file: { path: string }) => file.path.startsWith(f.currentTarget.payloadRoot + path.sep)));
    if (present) assert.equal(await readFile(path.join(f.oldTarget.payloadRoot, "old-tree-sentinel"), "utf8"), "leave untouched");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("globalRelocationSelectedScopeOnly", async () => {
  const root = await mkdtemp("/tmp/opencode/relocation-io-global-");
  const xdgOld = path.join(root, "old-xdg"); const xdgNew = path.join(root, "new-xdg");
  const home = path.join(root, "home"); const project = path.join(root, "project");
  try {
    const oldCat = await makeCatalog(path.join(root, "old-cat"), "1.0.0");
    const newCat = await makeCatalog(path.join(root, "new-cat"), "2.0.0");
    const oldTarget = await resolveTarget({ scope: "global", env: { XDG_CONFIG_HOME: xdgOld }, home });
    await new InstallerEngine({ catalogRoot: oldCat, target: oldTarget }).install([toolkit]);
    await mkdir(xdgNew, { recursive: true });
    const current = await resolveTarget({ scope: "global", env: { XDG_CONFIG_HOME: xdgNew }, home });
    await cp(oldTarget.payloadRoot, current.payloadRoot, { recursive: true });
    await mkdir(project, { recursive: true }); await writeFile(path.join(project, "sentinel"), "other scope");
    await mkdir(home, { recursive: true }); await writeFile(path.join(home, "home-scope-sentinel"), "home scope");
    const result = child(`
      import assert from 'node:assert/strict'; import {syncBuiltinESMExports} from 'node:module';
      import {createRelocationIOGuard} from ${JSON.stringify(guardModule)};
      const guard=createRelocationIOGuard({forbiddenRoots:[${JSON.stringify(oldTarget.payloadRoot)},${JSON.stringify(home)},${JSON.stringify(project)}]}); guard.install(); syncBuiltinESMExports(); guard.start();
      try { const {resolveTarget}=await import(${JSON.stringify(compiledTarget)}); const target=await resolveTarget({scope:'global'}); const {InstallerEngine}=await import(${JSON.stringify(compiledEngine)}); const engine=new InstallerEngine({catalogRoot:${JSON.stringify(newCat)},target}); await engine.update([${JSON.stringify(toolkit)}]); assert.deepEqual(guard.stalePathOperations,[]); console.log(JSON.stringify({stalePathOperations:guard.stalePathOperations,target})); }
      finally {guard.stop();guard.restore();syncBuiltinESMExports();}
    `, { cwd: project, env: { HOME: home, XDG_CONFIG_HOME: xdgNew } });
    requireSuccess(result); const output=JSON.parse(result.stdout.trim()); assert.deepEqual(output.stalePathOperations,[]); assert.equal(output.target.payloadRoot,current.payloadRoot);
    assert.equal(await readFile(path.join(project, "sentinel"), "utf8"), "other scope");
    assert.equal(await readFile(path.join(home, "home-scope-sentinel"), "utf8"), "home scope");
    assert.equal(JSON.parse(await readFile(current.statePath, "utf8")).toolkits[toolkit].version, "2.0.0");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const jsonc of [false, true]) test(jsonc ? "jsoncCommentsPreserved" : "jsonCommentsPreserved", async () => {
  const f = await makeProjectFixture({ jsonc });
  try {
    const expectedFinal = path.join(f.currentTarget.managedRoot, toolkit, "managed/server/entry.mjs");
    const expected = f.source.replace(f.oldFinal, expectedFinal);
    const result = observedUpdate({ oldRoot: f.oldProject, catalog: f.newCatalog, target: f.currentTarget });
    requireSuccess(result);
    assert.equal(await readFile(f.configPath, "utf8"), expected);
    if (jsonc) assert.ok((await readFile(f.configPath, "utf8")).includes("/* internal-command-note */"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

async function treeSnapshot(root: string): Promise<unknown> {
  const entries: unknown[] = [];
  const rootMode = (await lstat(root)).mode & 0o777;
  async function walk(dir: string, rel = "") {
    for (const name of (await readdir(dir)).sort()) {
      const file = path.join(dir, name); const key = path.posix.join(rel, name); const stat = await lstat(file);
      entries.push({ path: key, mode: stat.mode & 0o777, directory: stat.isDirectory(), bytes: stat.isFile() ? (await readFile(file)).toString("base64") : undefined });
      if (stat.isDirectory()) await walk(file, key);
    }
  }
  await walk(root); return { rootMode, entries };
}

for (const pending of [false, true]) test(pending ? "dryRunPendingJournalDirectorySnapshotEquality" : "dryRunDirectoryLockJournalSnapshotEquality", async () => {
  const f = await makeProjectFixture();
  try {
    await mkdir(f.currentTarget.stateRoot, { recursive: true });
    await writeFile(f.currentTarget.lockPath, "control");
    if (pending) {
      const resource = path.join(f.currentTarget.payloadRoot, "skills/dotknewt-io/SKILL.md");
      const contents = await readFile(resource); const stats = await lstat(resource);
      await writeFile(f.currentTarget.journalPath, JSON.stringify({ formatVersion: 1, changes: [{
        path: resource, before: { exists: true, encoding: "base64", content: contents.toString("base64"), mode: stats.mode & 0o777 },
        after: { exists: true, encoding: "base64", content: Buffer.from("pending").toString("base64"), mode: stats.mode & 0o777 }, description: "pending dry-run fixture",
      }] }));
    }
    const before = await treeSnapshot(f.currentProject);
    const result = observedUpdate({ oldRoot: f.oldProject, catalog: f.newCatalog, target: f.currentTarget, dryRun: true });
    requireSuccess(result);
    assert.deepEqual(await treeSnapshot(f.currentProject), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("unsafeJournalGuidanceIncludesJournalAndOffender", async () => {
  const f = await makeProjectFixture();
  const offender = path.join(f.oldTarget.payloadRoot, "skills", "dotknewt-io", "SKILL.md");
  const journal = JSON.stringify({ formatVersion: 1, changes: [{ path: offender, before: { exists: false }, after: { exists: true, encoding: "base64", content: "eA==", mode: 0o644 }, description: "unsafe old resource" }] });
  try {
    await writeFile(f.currentTarget.journalPath, journal);
    const result = child(`
      import assert from 'node:assert/strict'; import {syncBuiltinESMExports} from 'node:module'; import {createRelocationIOGuard} from ${JSON.stringify(guardModule)};
      const guard=createRelocationIOGuard({forbiddenRoots:[${JSON.stringify(f.oldProject)}]}); guard.install();syncBuiltinESMExports();guard.start();
      try { const {InstallerEngine}=await import(${JSON.stringify(compiledEngine)}); const engine=new InstallerEngine({catalogRoot:${JSON.stringify(f.newCatalog)},target:${JSON.stringify(f.currentTarget)}}); await assert.rejects(engine.update([${JSON.stringify(toolkit)}]), e=>{assert.ok(e.message.includes(${JSON.stringify(f.currentTarget.journalPath)}));assert.ok(e.message.includes(${JSON.stringify(offender)}));assert.match(e.message,/manual|original|recover/i);return true;}); assert.deepEqual(guard.stalePathOperations,[]); console.log(JSON.stringify(guard.stalePathOperations)); }
      finally {guard.stop();guard.restore();syncBuiltinESMExports();}
    `);
    requireSuccess(result); assert.deepEqual(JSON.parse(result.stdout.trim()), []);
    assert.equal(await readFile(f.currentTarget.journalPath, "utf8"), journal);
    assert.equal(await readFile(offender, "utf8"), "version 1.0.0\n");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("sameRootConfigRenameAllowsCurrentRootAccess", async () => {
  const f = await makeProjectFixture({ sameRoot: true, jsonc: true });
  try {
    const configPath = f.configPath;
    const target = await resolveTarget({ scope: "project", projectRoot: f.oldProject });
    const result = child(`
      import assert from 'node:assert/strict'; import {syncBuiltinESMExports} from 'node:module'; import {createRelocationIOGuard} from ${JSON.stringify(guardModule)};
      const guard=createRelocationIOGuard({forbiddenRoots:[]}); guard.install();syncBuiltinESMExports();guard.start();
      try { const {InstallerEngine}=await import(${JSON.stringify(compiledEngine)}); const engine=new InstallerEngine({catalogRoot:${JSON.stringify(f.newCatalog)},target:${JSON.stringify(target)}}); await engine.update([${JSON.stringify(toolkit)}]); assert.deepEqual(guard.stalePathOperations,[]); }
      finally {guard.stop();guard.restore();syncBuiltinESMExports();}
    `);
    requireSuccess(result);
    assert.equal(JSON.parse(await readFile(target.statePath, "utf8")).toolkits[toolkit].configPath, configPath);
    assert.equal(await readFile(configPath, "utf8"), f.source);
    assert.ok(f.source.includes("/* internal-command-note */"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
