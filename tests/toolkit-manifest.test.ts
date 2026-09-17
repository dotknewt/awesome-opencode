import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadAndValidateToolkit,
  type ToolkitManifest,
  validateToolkitCatalog,
  validateToolkitManifest,
} from "../installer/src/toolkit-manifest.js";

const validManifest: ToolkitManifest = {
  schemaVersion: 1,
  name: "libvirt-toolkit",
  namespace: "dotknewt",
  version: "0.1.0",
  description: "Safe local libvirt lifecycle support.",
  license: "MIT",
  exports: [
    {
      kind: "skill",
      source: "skills/dotknewt-libvirt-vms",
      destination: "skills/dotknewt-libvirt-vms",
    },
    {
      kind: "asset",
      source: "mcp/libvirt",
      destination: "mcp/libvirt",
    },
  ],
  requiredSkills: ["dotknewt-libvirt-vms"],
  mcp: [
    {
      name: "dotknewt-libvirt",
      type: "local",
      command: ["uv", "run", "--script"],
      entrypoint: "mcp/libvirt/server.py",
      enabled: true,
    },
  ],
  dependencies: {
    platforms: ["linux"],
    executables: ["uv", "virsh", "qemu-img"],
  },
};

test("accepts the versioned manifest interface used by the engine", () => {
  assert.deepEqual(validateToolkitManifest(validManifest), []);
});

test("accepts full SemVer and rejects invalid prerelease identifiers", () => {
  const withMetadata = structuredClone(validManifest);
  withMetadata.version = "1.2.3-alpha.1+build.5";
  assert.deepEqual(validateToolkitManifest(withMetadata), []);

  for (const version of ["1.0.0-..", "1.0.0-01", "1.0.0+build..5"]) {
    const invalid = structuredClone(validManifest);
    invalid.version = version;
    assert.match(validateToolkitManifest(invalid).join("\n"), /version.*pattern/i, version);
  }
});

test("rejects unknown properties, duplicate destinations, and traversal", () => {
  const invalid = structuredClone(validManifest) as ToolkitManifest & {
    surprise?: boolean;
  };
  invalid.surprise = true;
  invalid.exports.push({
    kind: "command",
    source: "../outside",
    destination: "mcp/libvirt",
  });

  const errors = validateToolkitManifest(invalid).join("\n");
  assert.match(errors, /additional properties/i);
  assert.match(errors, /relative path|traversal/i);
  assert.match(errors, /duplicate export destination/i);
});

test("loads toolkit content and verifies frontmatter and auxiliary references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-manifest-"));
  await mkdir(path.join(root, "skills", "dotknewt-libvirt-vms", "references"), {
    recursive: true,
  });
  await mkdir(path.join(root, "mcp", "libvirt"), { recursive: true });
  await writeFile(path.join(root, "toolkit.json"), JSON.stringify(validManifest));
  await writeFile(
    path.join(root, "skills", "dotknewt-libvirt-vms", "SKILL.md"),
    "---\nname: dotknewt-libvirt-vms\ndescription: Use when testing libvirt.\n---\n\nRead `references/setup.md`.\n",
  );
  await writeFile(
    path.join(root, "skills", "dotknewt-libvirt-vms", "references", "setup.md"),
    "# Setup\n",
  );
  await writeFile(path.join(root, "mcp", "libvirt", "server.py"), "# server\n");

  const loaded = await loadAndValidateToolkit(path.join(root, "toolkit.json"));
  assert.equal(loaded.manifest?.name, "libvirt-toolkit");
  assert.deepEqual(loaded.errors, []);

  await writeFile(
    path.join(root, "skills", "dotknewt-libvirt-vms", "SKILL.md"),
    "---\nname: libvirt-vms\ndescription: Use when testing libvirt.\n---\n\nRead `references/missing.md`.\n",
  );
  const broken = await loadAndValidateToolkit(path.join(root, "toolkit.json"));
  assert.match(broken.errors.join("\n"), /frontmatter name/i);
  assert.match(broken.errors.join("\n"), /missing auxiliary reference/i);
});

test("requires MCP entrypoints and commands to be declared by exports and dependencies", () => {
  const invalid = structuredClone(validManifest);
  invalid.mcp[0]!.name = "libvirt";
  invalid.mcp[0]!.entrypoint = "private/server.py";
  invalid.dependencies.executables = ["virsh", "qemu-img"];

  const errors = validateToolkitManifest(invalid).join("\n");
  assert.match(errors, /MCP contribution must use namespace dotknewt/i);
  assert.match(errors, /entrypoint.*asset export/i);
  assert.match(errors, /executable dependency.*uv/i);
});

test("resolves MCP entrypoints through nonidentity asset destinations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-mcp-map-"));
  const manifest = structuredClone(validManifest);
  manifest.exports[1] = {
    kind: "asset",
    source: "server-source",
    destination: "managed/server",
  };
  manifest.mcp[0]!.entrypoint = "managed/server/server.py";
  await mkdir(path.join(root, "skills", "dotknewt-libvirt-vms"), { recursive: true });
  await mkdir(path.join(root, "server-source"), { recursive: true });
  await writeFile(path.join(root, "toolkit.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(root, "skills", "dotknewt-libvirt-vms", "SKILL.md"),
    "---\nname: dotknewt-libvirt-vms\ndescription: Use when testing libvirt.\n---\n",
  );
  await writeFile(path.join(root, "server-source", "server.py"), "# server\n");

  const loaded = await loadAndValidateToolkit(path.join(root, "toolkit.json"));
  assert.deepEqual(loaded.errors, []);
});

test("reports missing Markdown links, images, relative prefixes, and eval attachments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-refs-"));
  const skillRoot = path.join(root, "skills", "dotknewt-libvirt-vms");
  await mkdir(path.join(skillRoot, "evals"), { recursive: true });
  await mkdir(path.join(root, "mcp", "libvirt"), { recursive: true });
  await writeFile(path.join(root, "toolkit.json"), JSON.stringify(validManifest));
  await writeFile(
    path.join(skillRoot, "SKILL.md"),
    [
      "---",
      "name: dotknewt-libvirt-vms",
      "description: Use when testing libvirt.",
      "---",
      "",
      "Read [setup](./references/setup.md).",
      "See ![network diagram](references/network.png).",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(skillRoot, "evals", "evals.json"),
    JSON.stringify({ evals: [{ files: ["evals/files/scenario.md"] }] }),
  );
  await writeFile(path.join(root, "mcp", "libvirt", "server.py"), "# server\n");

  const loaded = await loadAndValidateToolkit(path.join(root, "toolkit.json"));
  const errors = loaded.errors.join("\n");
  assert.match(errors, /references\/setup\.md/);
  assert.match(errors, /references\/network\.png/);
  assert.match(errors, /evals\/files\/scenario\.md/);
});

test("catalog validation reports malformed and missing manifests without stopping", async () => {
  const catalog = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-catalog-"));
  const validRoot = path.join(catalog, "valid");
  const malformedRoot = path.join(catalog, "malformed");
  await mkdir(path.join(validRoot, "skills", "dotknewt-libvirt-vms"), { recursive: true });
  await mkdir(path.join(validRoot, "mcp", "libvirt"), { recursive: true });
  await mkdir(malformedRoot, { recursive: true });
  await mkdir(path.join(catalog, "missing"), { recursive: true });
  await writeFile(path.join(validRoot, "toolkit.json"), JSON.stringify(validManifest));
  await writeFile(
    path.join(validRoot, "skills", "dotknewt-libvirt-vms", "SKILL.md"),
    "---\nname: dotknewt-libvirt-vms\ndescription: Use when testing libvirt.\n---\n",
  );
  await writeFile(path.join(validRoot, "mcp", "libvirt", "server.py"), "# server\n");
  await writeFile(path.join(malformedRoot, "toolkit.json"), "{ not-json\n");

  const results = await validateToolkitCatalog(catalog);
  assert.equal(results.length, 3);
  assert.deepEqual(results.find((result) => result.manifest?.name === "libvirt-toolkit")?.errors, []);
  assert.match(
    results.find((result) => result.manifestPath.endsWith("malformed/toolkit.json"))!.errors.join("\n"),
    /invalid JSON/i,
  );
  assert.match(
    results.find((result) => result.manifestPath.endsWith("missing/toolkit.json"))!.errors.join("\n"),
    /cannot read manifest/i,
  );
});

test("requires discoverable skill descriptions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-frontmatter-"));
  await mkdir(path.join(root, "skills", "dotknewt-libvirt-vms"), { recursive: true });
  await mkdir(path.join(root, "mcp", "libvirt"), { recursive: true });
  await writeFile(path.join(root, "toolkit.json"), JSON.stringify(validManifest));
  await writeFile(
    path.join(root, "skills", "dotknewt-libvirt-vms", "SKILL.md"),
    "---\nname: dotknewt-libvirt-vms\n---\n\n# Missing description\n",
  );
  await writeFile(path.join(root, "mcp", "libvirt", "server.py"), "# server\n");

  const loaded = await loadAndValidateToolkit(path.join(root, "toolkit.json"));
  assert.match(loaded.errors.join("\n"), /frontmatter description/i);
});

test("rejects symlinks so exported toolkit content is self-contained", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-outside-"));
  await mkdir(path.join(root, "skills", "dotknewt-libvirt-vms"), { recursive: true });
  await mkdir(path.join(root, "mcp", "libvirt"), { recursive: true });
  await writeFile(path.join(root, "toolkit.json"), JSON.stringify(validManifest));
  await writeFile(
    path.join(root, "skills", "dotknewt-libvirt-vms", "SKILL.md"),
    "---\nname: dotknewt-libvirt-vms\ndescription: Use when testing libvirt.\n---\n",
  );
  await writeFile(path.join(root, "mcp", "libvirt", "server.py"), "# server\n");
  await symlink(outside, path.join(root, "mcp", "libvirt", "external"));

  const loaded = await loadAndValidateToolkit(path.join(root, "toolkit.json"));
  assert.match(loaded.errors.join("\n"), /symlink/i);
});

test("the packaged CLI validates its bundled catalog outside the source cwd", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "awesome-opencode-cli-"));
  const cli = path.resolve(import.meta.dirname, "../installer/src/cli.js");
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(process.execPath, [cli, "validate"], { cwd });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /valid: libvirt-toolkit@0\.1\.0/);
});
