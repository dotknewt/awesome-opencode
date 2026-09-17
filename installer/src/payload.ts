import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { assertSafePath } from "./path-safety.js";
import { exportDestinationError, isSafeRelativePath, type ToolkitManifest, validateToolkitManifest } from "./toolkit-manifest.js";

export interface PayloadFile {
  relativePath: string;
  content: Buffer;
  hash: string;
  mode: number;
}

export interface ToolkitPayload {
  root: string;
  manifest: ToolkitManifest;
  files: PayloadFile[];
}

export function hashContent(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function walkFiles(root: string, relative = ""): Promise<Array<{ relative: string; content: Buffer; mode: number }>> {
  const current = relative ? path.join(root, relative) : root;
  const metadata = await lstat(current);
  if (metadata.isSymbolicLink()) throw new Error(`source payload contains symlink: ${current}`);
  if (metadata.isFile()) return [{ relative, content: await readFile(current), mode: metadata.mode & 0o777 }];
  if (!metadata.isDirectory()) throw new Error(`source payload contains special file: ${current}`);
  const files: Array<{ relative: string; content: Buffer; mode: number }> = [];
  for (const entry of (await readdir(current)).sort()) files.push(...(await walkFiles(root, path.join(relative, entry))));
  return files;
}

export async function loadToolkitPayload(catalogRoot: string, name: string): Promise<ToolkitPayload> {
  if (!isSafeRelativePath(name) || name.includes("/")) throw new Error(`invalid toolkit name: ${name}`);
  const root = path.join(catalogRoot, name);
  await assertSafePath(catalogRoot, "directory");
  await assertSafePath(root, "directory");
  await assertSafePath(path.join(root, "toolkit.json"), "file");
  let manifest: ToolkitManifest;
  try {
    manifest = JSON.parse(await readFile(path.join(root, "toolkit.json"), "utf8")) as ToolkitManifest;
  } catch (error) {
    throw new Error(`cannot load toolkit ${name}: ${(error as Error).message}`);
  }
  const errors = validateToolkitManifest(manifest);
  if (errors.length > 0 || manifest.name !== name) throw new Error(`invalid toolkit ${name}: ${errors.join("; ") || "manifest name mismatch"}`);
  const files: PayloadFile[] = [];
  const destinations = new Set<string>();
  for (const exported of manifest.exports) {
    const destinationError = exportDestinationError(exported);
    if (destinationError) throw new Error(destinationError);
    const sourceRoot = path.join(root, exported.source);
    await assertSafePath(sourceRoot, "any");
    const destinationRoot = exported.kind === "asset"
      ? path.posix.join("awesome-opencode", "toolkits", manifest.name, exported.destination)
      : exported.destination;
    for (const file of await walkFiles(sourceRoot)) {
      const relativePath = path.posix.join(destinationRoot, file.relative.split(path.sep).join("/"));
      if (!isSafeRelativePath(relativePath) || destinations.has(relativePath)) throw new Error(`unsafe or duplicate payload destination: ${relativePath}`);
      destinations.add(relativePath);
      files.push({ relativePath, content: file.content, hash: hashContent(file.content), mode: file.mode });
    }
  }
  return { root, manifest, files };
}
