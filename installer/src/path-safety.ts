import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";

export type LeafRequirement = "any" | "file" | "directory";

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Validate every existing path component without following symlinks. */
export async function assertSafePath(
  filePath: string,
  leaf: LeafRequirement = "any",
): Promise<"missing" | "file" | "directory"> {
  const absolute = path.resolve(filePath);
  const parsed = path.parse(absolute);
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]!);
    let metadata;
    try { metadata = await lstat(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
    const isLeaf = index === components.length - 1;
    if (metadata.isSymbolicLink()) throw new Error(`refusing symlink path component: ${current}`);
    if (!isLeaf && !metadata.isDirectory()) throw new Error(`refusing non-directory path component: ${current}`);
    if (isLeaf) {
      if (leaf === "file" && !metadata.isFile()) throw new Error(`refusing non-regular file: ${current}`);
      if (leaf === "directory" && !metadata.isDirectory()) throw new Error(`refusing non-directory: ${current}`);
      if (leaf === "any" && !metadata.isFile() && !metadata.isDirectory()) throw new Error(`refusing special file: ${current}`);
      return metadata.isDirectory() ? "directory" : "file";
    }
  }
  return "directory";
}

/** Create absent parents one level at a time, syncing each containing directory. */
export async function ensureSafeParents(filePath: string): Promise<void> {
  const missing: string[] = [];
  let current = path.dirname(path.resolve(filePath));
  while (true) {
    let metadata;
    try { metadata = await lstat(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`cannot establish safe parent for ${filePath}`);
      current = parent;
      continue;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`unsafe symlink or non-directory parent: ${current}`);
    break;
  }
  for (const directory of missing.reverse()) {
    const parent = path.dirname(directory);
    await mkdir(directory);
    await syncDirectory(parent);
  }
  await assertSafePath(path.dirname(filePath), "directory");
}

export async function fsyncDirectory(directoryPath: string): Promise<void> {
  await assertSafePath(directoryPath, "directory");
  await syncDirectory(directoryPath);
}
