import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

// A real stdio subprocess, not an in-process server or a live Ollama service.
export async function checkInstalledOllama(configRoot: string, payloadRoot: string, root: string): Promise<void> {
  const config = JSON.parse(await readFile(path.join(configRoot, "opencode.json"), "utf8"));
  const entry = config.mcp["dotknewt-ollama"];
  assert.deepEqual(entry.command, ["uv", "run", "--script", path.join(payloadRoot, "awesome-opencode/toolkits/ollama-toolkit/mcp/ollama/server.py")]);
  assert.equal(entry.enabled, true);
  assert.match(await readFile(path.join(payloadRoot, "skills/dotknewt-ollama-name-cleanup/SKILL.md"), "utf8"), /name: dotknewt-ollama-name-cleanup/);
  const fixture = await mkdtemp(path.join(root, "fake-ollama-"));
  const bin = path.join(fixture, "bin");
  await mkdir(bin);
  await writeFile(path.join(fixture, "models.json"), JSON.stringify({ "old:latest": "abcdef123456" }));
  await writeFile(path.join(bin, "ollama"), `#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ['FAKE_OLLAMA_ROOT'])
args = sys.argv[1:]
with (root / 'trace.jsonl').open('a') as stream: stream.write(json.dumps(args) + '\\n')
models = json.loads((root / 'models.json').read_text())
if args == ['list']:
    print('NAME ID SIZE MODIFIED')
    for name, identity in models.items(): print(f'{name} {identity} 1 GB now')
elif len(args) == 3 and args[0] == 'cp': models[args[2]] = models[args[1]]
elif len(args) == 2 and args[0] == 'rm': del models[args[1]]
else: raise SystemExit('unexpected command')
(root / 'models.json').write_text(json.dumps(models))
`, { mode: 0o755 });
  const child = spawn(entry.command[0], entry.command.slice(1), {
    cwd: fixture,
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: fixture,
      XDG_CONFIG_HOME: path.join(fixture, "config"), XDG_DATA_HOME: path.join(fixture, "data"),
      XDG_CACHE_HOME: path.join(fixture, "cache"), UV_CACHE_DIR: path.join(root, "uv-cache"),
      PYTHONDONTWRITEBYTECODE: "1", FAKE_OLLAMA_ROOT: fixture },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
  child.on("error", fail);
  const closed = new Promise<void>((resolve) => child.on("close", () => {
    fail(new Error(`MCP exited: ${stderr}`)); resolve();
  }));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const response = JSON.parse(line);
      const waiter = pending.get(response.id);
      if (waiter) { pending.delete(response.id); waiter.resolve(response); }
    } catch (error) { fail(error as Error); }
  });
  const timer = setTimeout(() => { fail(new Error(`MCP timeout: ${stderr}`)); child.kill("SIGKILL"); }, 90_000);
  let id = 0;
  const request = (method: string, params: object) => new Promise<any>((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    const initialized = await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "package-test", version: "1" } });
    assert.ok(initialized.result?.serverInfo, JSON.stringify(initialized));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = await request("tools/list", {});
    assert.deepEqual(tools.result.tools.map((tool: any) => tool.name).sort(), ["list_models", "rename_model", "suggest_names"]);
    for (const name of ["list_models", "suggest_names", "rename_model"]) {
      const response = await request("tools/call", { name, arguments: name === "rename_model" ? { source: "old:latest", destination: "new:latest", confirmed: true } : {} });
      assert.ok(response.result, JSON.stringify(response));
      assert.ok(!response.result.isError, JSON.stringify(response));
      assert.deepEqual(JSON.parse(response.result.content[0].text), response.result.structuredContent);
      if (name === "rename_model") assert.equal(response.result.structuredContent.status, "remove_command_succeeded");
    }
    const trace = (await readFile(path.join(fixture, "trace.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(trace, [["list"], ["list"], ["list"], ["cp", "old:latest", "new:latest"], ["list"], ["rm", "old:latest"]]);
    assert.deepEqual(JSON.parse(await readFile(path.join(fixture, "models.json"), "utf8")), { "new:latest": "abcdef123456" });
  } finally {
    clearTimeout(timer);
    lines.close();
    child.kill("SIGKILL");
    await closed;
  }
}
