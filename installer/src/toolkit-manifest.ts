import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import Ajv2020Module, { type ErrorObject } from "ajv/dist/2020.js";
import schema from "../../schemas/toolkit.schema.json" with { type: "json" };

export type ExportKind = "skill" | "agent" | "command" | "asset";

export interface ToolkitExport {
  kind: ExportKind;
  source: string;
  destination: string;
}

export interface LocalMcpContribution {
  name: string;
  type: "local";
  command: string[];
  entrypoint: string;
  enabled: boolean;
}

export interface ToolkitManifest {
  schemaVersion: 1;
  name: string;
  namespace: string;
  version: string;
  description: string;
  license: string;
  exports: ToolkitExport[];
  requiredSkills: string[];
  mcp: LocalMcpContribution[];
  dependencies: {
    platforms: Array<"linux" | "darwin" | "win32">;
    executables: string[];
  };
}

export interface ToolkitValidationResult {
  manifest?: ToolkitManifest;
  errors: string[];
}

export interface CatalogValidationResult extends ToolkitValidationResult {
  manifestPath: string;
}

const Ajv2020 = Ajv2020Module.default;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile<ToolkitManifest>(schema);

function formatSchemaError(error: ErrorObject): string {
  const location = error.instancePath || "/";
  if (error.keyword === "additionalProperties") {
    const property = (error.params as { additionalProperty: string }).additionalProperty;
    return `${location} has additional properties: ${property}`;
  }
  return `${location} ${error.message ?? "is invalid"}`;
}

export function isSafeRelativePath(value: string): boolean {
  if (!value || path.isAbsolute(value) || value.includes("\\")) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== "." && !normalized.startsWith("../");
}

export function exportDestinationError(item: ToolkitExport): string | undefined {
  const patterns: Record<Exclude<ExportKind, "asset">, RegExp> = {
    skill: /^skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/,
    agent: /^agents\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/,
    command: /^commands\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/,
  };
  if (item.kind === "asset" || !Object.hasOwn(patterns, item.kind) || typeof item.destination !== "string") return undefined;
  if (!patterns[item.kind].test(item.destination)) {
    return `${item.kind} export destination must be ${item.kind === "skill" ? "skills/<public-name>" : `${item.kind}s/<public-name>.md`}: ${item.destination}`;
  }
  return undefined;
}

function assetExportForEntrypoint(
  manifest: ToolkitManifest,
  entrypoint: string,
): ToolkitExport | undefined {
  return manifest.exports.find((item) => {
    if (item.kind !== "asset") return false;
    return entrypoint === item.destination || entrypoint.startsWith(`${item.destination}/`);
  });
}

export function validateToolkitManifest(value: unknown): string[] {
  const errors: string[] = [];
  if (!validateSchema(value)) {
    errors.push(...(validateSchema.errors ?? []).map(formatSchemaError));
  }
  if (typeof value !== "object" || value === null) return errors;

  const manifest = value as Partial<ToolkitManifest>;
  const exports = Array.isArray(manifest.exports) ? manifest.exports : [];
  const destinations = new Set<string>();
  for (const item of exports) {
    if (!item || typeof item !== "object") continue;
    if (!isSafeRelativePath(item.source) || !isSafeRelativePath(item.destination)) {
      errors.push(`export paths must be normalized relative paths without traversal: ${item.source} -> ${item.destination}`);
    }
    const destinationError = exportDestinationError(item);
    if (destinationError) errors.push(destinationError);
    if (destinations.has(item.destination)) {
      errors.push(`duplicate export destination: ${item.destination}`);
    }
    destinations.add(item.destination);
  }

  if (typeof manifest.namespace === "string") {
    for (const item of exports.filter((candidate) => candidate.kind !== "asset")) {
      const name = path.posix.basename(item.destination);
      if (!name.startsWith(`${manifest.namespace}-`)) {
        errors.push(`${item.kind} export must use namespace ${manifest.namespace}: ${item.destination}`);
      }
    }
  }

  const skillNames = new Set(
    exports.filter((item) => item.kind === "skill").map((item) => path.posix.basename(item.destination)),
  );
  for (const required of manifest.requiredSkills ?? []) {
    if (!skillNames.has(required)) errors.push(`required skill is not exported: ${required}`);
  }

  for (const contribution of manifest.mcp ?? []) {
    if (
      typeof manifest.namespace === "string" &&
      !contribution.name.startsWith(`${manifest.namespace}-`)
    ) {
      errors.push(`MCP contribution must use namespace ${manifest.namespace}: ${contribution.name}`);
    }
    if (!assetExportForEntrypoint(manifest as ToolkitManifest, contribution.entrypoint)) {
      errors.push(`MCP entrypoint must be covered by an asset export: ${contribution.entrypoint}`);
    }
    const executable = contribution.command[0];
    if (executable && !manifest.dependencies?.executables?.includes(executable)) {
      errors.push(`MCP executable dependency is not declared: ${executable}`);
    }
  }
  return errors;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function filesWithExtension(root: string, extension: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await filesWithExtension(entryPath, extension)));
    else if (entry.isFile() && entry.name.endsWith(extension)) result.push(entryPath);
  }
  return result;
}

async function symlinksUnder(root: string): Promise<string[]> {
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink()) return [root];
  if (!metadata.isDirectory()) return [];

  const result: string[] = [];
  for (const entry of await readdir(root)) {
    result.push(...(await symlinksUnder(path.join(root, entry))));
  }
  return result;
}

function frontmatterField(content: string, field: string): string | undefined {
  const block = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  return block?.[1]?.match(new RegExp(`^${field}:\\s*(.+?)\\s*$`, "m"))?.[1];
}

function isExternalReference(reference: string): boolean {
  return (
    reference.startsWith("#") ||
    reference.startsWith("/") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference)
  );
}

function markdownLocalReferences(content: string): string[] {
  const references: string[] = [];
  for (const match of content.matchAll(/!?\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)) {
    const reference = match[1];
    if (reference && !isExternalReference(reference)) references.push(reference);
  }
  for (const match of content.matchAll(/`([^`\n]+)`/g)) {
    const reference = match[1];
    if (
      reference &&
      /\.(?:md|png|svg|jpe?g|gif|yaml|yml|toml|txt|sh|py)$/.test(reference) &&
      !isExternalReference(reference)
    ) {
      references.push(reference);
    }
  }
  return references;
}

function evalFileReferences(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(evalFileReferences);
  if (typeof value !== "object" || value === null) return [];

  const references: string[] = [];
  for (const [key, nested] of Object.entries(value)) {
    if (key === "files" && Array.isArray(nested)) {
      references.push(...nested.filter((entry): entry is string => typeof entry === "string"));
    } else {
      references.push(...evalFileReferences(nested));
    }
  }
  return references;
}

function resolveLocalReference(
  skillRoot: string,
  containingFile: string,
  reference: string,
  relativeToSkillRoot: boolean,
): string | undefined {
  const withoutFragment = reference.split(/[?#]/, 1)[0];
  if (!withoutFragment) return undefined;
  const base = relativeToSkillRoot ? skillRoot : path.dirname(containingFile);
  const resolved = path.resolve(base, withoutFragment);
  const relative = path.relative(skillRoot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
  return undefined;
}

async function validateSkill(skillRoot: string, expectedName: string): Promise<string[]> {
  const errors: string[] = [];
  const skillFile = path.join(skillRoot, "SKILL.md");
  if (!(await exists(skillFile))) return [`skill export is missing SKILL.md: ${skillRoot}`];
  const content = await readFile(skillFile, "utf8");
  const actualName = frontmatterField(content, "name");
  if (actualName !== expectedName) {
    errors.push(`skill frontmatter name must match namespaced directory ${expectedName}; got ${actualName ?? "missing"}`);
  }
  if (!frontmatterField(content, "description")) {
    errors.push(`skill frontmatter description is required: ${expectedName}`);
  }

  const reported = new Set<string>();
  for (const markdown of await filesWithExtension(skillRoot, ".md")) {
    const body = await readFile(markdown, "utf8");
    for (const reference of markdownLocalReferences(body)) {
      const resolved = resolveLocalReference(skillRoot, markdown, reference, false);
      const key = `${markdown}:${reference}`;
      if ((!resolved || !(await exists(resolved))) && !reported.has(key)) {
        errors.push(`missing auxiliary reference ${reference} mentioned by ${path.relative(skillRoot, markdown)}`);
        reported.add(key);
      }
    }
  }
  for (const jsonFile of await filesWithExtension(skillRoot, ".json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(jsonFile, "utf8"));
    } catch (error) {
      errors.push(`invalid auxiliary JSON ${path.relative(skillRoot, jsonFile)}: ${(error as Error).message}`);
      continue;
    }
    for (const reference of evalFileReferences(parsed)) {
      const resolved = resolveLocalReference(skillRoot, jsonFile, reference, true);
      if (!resolved || !(await exists(resolved))) {
        errors.push(`missing auxiliary reference ${reference} mentioned by ${path.relative(skillRoot, jsonFile)}`);
      }
    }
  }
  return errors;
}

export async function loadAndValidateToolkit(manifestPath: string): Promise<ToolkitValidationResult> {
  const root = path.dirname(manifestPath);
  let source: string;
  try {
    source = await readFile(manifestPath, "utf8");
  } catch (error) {
    return { errors: [`cannot read manifest ${manifestPath}: ${(error as Error).message}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return { errors: [`invalid JSON in toolkit manifest ${manifestPath}: ${(error as Error).message}`] };
  }
  const errors = validateToolkitManifest(parsed);
  if (errors.length > 0) {
    return typeof parsed === "object" && parsed !== null
      ? { manifest: parsed as ToolkitManifest, errors }
      : { errors };
  }
  const manifest = parsed as ToolkitManifest;

  for (const item of manifest.exports) {
    const source = path.join(root, item.source);
    if (!(await exists(source))) errors.push(`export source does not exist: ${item.source}`);
    if (await exists(source)) {
      for (const symlink of await symlinksUnder(source)) {
        errors.push(`export source contains a symlink: ${path.relative(root, symlink)}`);
      }
      if (item.kind === "skill") {
        errors.push(...(await validateSkill(source, path.posix.basename(item.destination))));
      }
    }
  }
  for (const contribution of manifest.mcp) {
    const asset = assetExportForEntrypoint(manifest, contribution.entrypoint);
    if (!asset) continue;
    const suffix = path.posix.relative(asset.destination, contribution.entrypoint);
    const sourceEntrypoint = path.join(root, asset.source, suffix);
    if (!(await exists(sourceEntrypoint))) {
      errors.push(`MCP entrypoint does not exist: ${contribution.entrypoint}`);
    }
  }
  return { manifest, errors };
}

export async function validateToolkitCatalog(toolkitRoot: string): Promise<CatalogValidationResult[]> {
  let entries;
  try {
    entries = await readdir(toolkitRoot, { withFileTypes: true });
  } catch (error) {
    return [{
      manifestPath: toolkitRoot,
      errors: [`cannot read toolkit catalog ${toolkitRoot}: ${(error as Error).message}`],
    }];
  }

  const results: CatalogValidationResult[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const manifestPath = path.join(toolkitRoot, entry.name, "toolkit.json");
    results.push({ manifestPath, ...(await loadAndValidateToolkit(manifestPath)) });
  }
  return results;
}
