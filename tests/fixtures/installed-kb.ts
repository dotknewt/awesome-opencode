import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export const kbRuntimeFiles = ["server.py", "config.example.json", "kb_mcp/__init__.py", "kb_mcp/config.py", "kb_mcp/registry.py", "kb_mcp/server.py"];

function launchInstalled(command: string[], root: string, env: NodeJS.ProcessEnv) {
  const checkout = path.resolve(import.meta.dirname, "../../..");
  // This check runs in the same process namespace immediately before exec.
  return spawn("bwrap", ["--die-with-parent", "--new-session", "--unshare-pid",
    "--ro-bind", "/", "/", "--bind", root, root,
    "--tmpfs", checkout, "--chmod", "000", checkout,
    "--proc", "/proc", "--dev", "/dev", "--chdir", root,
    "/bin/sh", "-c",
    'if test -r "$1" || test -r "$1/package.json" || test -r "$1/toolkits/kb-toolkit/mcp/kb/server.py"; then echo "checkout remains accessible" >&2; exit 97; fi; shift; exec "$@"',
    "kb-source-denial", checkout, ...command], { cwd: root, env });
}

export async function checkInstalledKB(configRoot: string, payloadRoot: string, root: string, namespace: string, env: NodeJS.ProcessEnv): Promise<Array<{ file: string; content: string }>> {
  // Prevent a vacuous denial check against an incorrectly calculated source path.
  assert.ok((await readFile(path.resolve(import.meta.dirname, "../../../package.json"), "utf8")).includes("awesome-opencode"));
  assert.equal(env.PYTHONPATH, undefined);
  const configPath = path.join(configRoot, "opencode.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const entry = config.mcp["dotknewt-kb"];
  const asset = path.join(payloadRoot, "awesome-opencode/toolkits/kb-toolkit/mcp/kb");
  assert.deepEqual(entry, { type: "local", command: ["uv", "run", "--script", path.join(asset, "server.py")], enabled: false });
  const installedFiles = (await readdir(asset, { recursive: true, withFileTypes: true }))
    .filter(file => file.isFile()).map(file => path.relative(asset, path.join(file.parentPath, file.name)));
  assert.deepEqual(installedFiles.sort(), [...kbRuntimeFiles].sort());
  assert.match(await readFile(path.join(payloadRoot, "skills/dotknewt-kb-read/SKILL.md"), "utf8"), /name: dotknewt-kb-read/);
  assert.equal(config.instructions?.some((item: string) => item.includes("dotknewt-kb-read")) ?? false, false);

  const unconfigured = launchInstalled(entry.command, root, env);
  let stdout = "", stderr = "";
  unconfigured.stdout.on("data", chunk => { stdout += chunk; });
  unconfigured.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => unconfigured.kill("SIGKILL"), 90_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { unconfigured.on("error", reject); unconfigured.on("close", resolve); });
    assert.equal(code, 1, stderr);
    assert.equal(stdout, "");
    assert.match(stderr, /KB startup or transport failed\./);
  } finally { clearTimeout(timer); unconfigured.kill("SIGKILL"); }

  const source = path.join(root, `external-${namespace}`);
  await mkdir(source);
  const uri = `${namespace}://record/one`;
  const uriKey = `${namespace}_uri`;
  const record = `---\n${uriKey}: ${uri}\ntitle: Synthetic ${namespace}\ntype: note\n---\nSynthetic ${namespace} needle. [inert](https://example.invalid/no-fetch)\n`;
  const files = [
    { file: path.join(source, "one.md"), content: record },
    { file: path.join(source, "unpublished.md"), content: "PRIVATE_UNINDEXED_SENTINEL" },
    { file: path.join(source, "index.md"), content: `## Published-record navigation\n\n| Identifier | Record |\n| --- | --- |\n| \`${uri}\` | [One](one.md) |\n` },
    { file: path.join(root, `${namespace}.json`), content: JSON.stringify({ root: source, uri_prefix: `${namespace}://`, uri_key: uriKey, index_path: "index.md", navigation_heading: "Published-record navigation" }) },
  ];
  for (const { file, content } of files) await writeFile(file, content);
  const instance = `fixture-kb-${namespace}`;
  config.mcp[instance] = { type: "local", command: [...entry.command, "--config", files[3]!.file], enabled: true };
  await writeFile(configPath, JSON.stringify(config));
  const configured = JSON.parse(await readFile(configPath, "utf8")).mcp[instance];
  const child = launchInstalled(configured.command, root, env);
  let diagnostics = "";
  child.stderr.on("data", chunk => { diagnostics += chunk; });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
  child.on("error", fail);
  const closed = new Promise<void>(resolve => child.on("close", () => { fail(new Error(`MCP exited: ${diagnostics}`)); resolve(); }));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try { const response = JSON.parse(line); const waiter = pending.get(response.id); if (waiter) { pending.delete(response.id); waiter.resolve(response); } }
    catch (error) { fail(error as Error); }
  });
  const deadline = setTimeout(() => { fail(new Error(`MCP timeout: ${diagnostics}`)); child.kill("SIGKILL"); }, 90_000);
  let id = 0;
  const request = (method: string, params: object) => new Promise<any>((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    const initialized = await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: instance, version: "1" } });
    assert.ok(initialized.result?.serverInfo, JSON.stringify(initialized));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = await request("tools/list", {});
    assert.deepEqual(tools.result.tools.map((tool: any) => tool.name).sort(), ["kb_list", "kb_read", "kb_search"]);
    for (const tool of tools.result.tools) assert.equal(tool.annotations.readOnlyHint, true);
    const resources = await request("resources/list", {});
    assert.deepEqual(resources.result.resources.map((item: any) => item.uri), [uri]);
    const read = await request("resources/read", { uri });
    assert.equal(read.result.contents[0].uri, uri);
    assert.equal(read.result.contents[0].text, record);
    for (const [name, args] of [["kb_list", {}], ["kb_search", { query: "needle" }], ["kb_read", { uri }]] as const) {
      const response = await request("tools/call", { name, arguments: args });
      assert.ok(response.result && !response.result.isError, JSON.stringify(response));
      assert.ok(JSON.stringify(response.result).includes(uri), JSON.stringify(response));
      assert.ok(!JSON.stringify(response).includes("PRIVATE_UNINDEXED_SENTINEL"));
    }
    const denied = await request("tools/call", { name: "kb_read", arguments: { uri: `${namespace === "intel" ? "future" : "intel"}://record/one` } });
    assert.equal(denied.result.isError, true);
    assert.equal(diagnostics, "");
  } finally { clearTimeout(deadline); lines.close(); child.kill("SIGKILL"); await closed; }
  return files;
}
