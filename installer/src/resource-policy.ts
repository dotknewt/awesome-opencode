import path from "node:path";

import type { TargetPaths } from "./target.js";

const identityPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isIdentity = (value: string): boolean => value.length <= 64 && identityPattern.test(value);
const isPublicName = (value: string): boolean => identityPattern.test(value);

function isNativePayloadPath(components: string[], owner?: string): boolean {
  return (
    (components[0] === "skills" && components.length >= 3 && isPublicName(components[1]!)) ||
    ((components[0] === "agents" || components[0] === "commands") && components.length === 2 &&
      components[1]!.endsWith(".md") && isPublicName(components[1]!.slice(0, -3))) ||
    (components[0] === "awesome-opencode" && components[1] === "toolkits" &&
      components.length >= 4 && isIdentity(components[2]!) && (owner === undefined || components[2] === owner))
  );
}

function normalizedAbsolute(value: string): string | undefined {
  if (!path.isAbsolute(value) || value.includes("\0") || value.includes("\\")) return undefined;
  if (path.normalize(value) !== value || value.endsWith(path.sep)) return undefined;
  return value;
}

export function assertInstalledRelativePath(toolkitName: string, relativePath: string): void {
  if (!isIdentity(toolkitName) || !relativePath || relativePath.includes("\0") || relativePath.includes("\\") || path.posix.isAbsolute(relativePath)) {
    throw new Error(`invalid installed relative path for ${toolkitName}: ${relativePath}`);
  }
  const components = relativePath.split("/");
  if (components.some((part) => !part || part === "." || part === "..") || path.posix.normalize(relativePath) !== relativePath) {
    throw new Error(`installed path must be normalized without traversal: ${relativePath}`);
  }
  if (!isNativePayloadPath(components, toolkitName)) throw new Error(`installed path is outside native toolkit namespaces: ${relativePath}`);
}

function isBelow(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export function classifyMutationResource(target: TargetPaths, resourcePath: string): "payload" | "config" | "state" {
  const resource = normalizedAbsolute(resourcePath);
  if (!resource) throw new Error(`invalid mutation resource path: ${resourcePath}`);
  const configCandidates = new Set(target.configCandidates.map(normalizedAbsolute));
  if (configCandidates.has(resource)) return "config";
  if (resource === target.statePath) return "state";
  if (resource === target.journalPath || resource === target.lockPath ||
      resource.startsWith(`${target.statePath}.`) || resource.startsWith(`${target.journalPath}.`) ||
      /\.awesome-opencode-[0-9]+-[0-9a-f-]+\.tmp$/.test(resource)) {
    throw new Error(`control or temporary path is not a mutation resource: ${resource}`);
  }
  if (isBelow(target.payloadRoot, resource)) {
    const relative = path.relative(target.payloadRoot, resource).split(path.sep).join("/");
    const parts = relative.split("/");
    if (isNativePayloadPath(parts)) return "payload";
  }
  throw new Error(`path is not an authorized mutation resource: ${resource}`);
}
