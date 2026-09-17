import { applyEdits, modify, parse, parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";

export interface ConfigDocument {
  source: string;
  value: Record<string, unknown>;
}

function findDuplicateKeys(node: JsonNode | undefined, duplicates: string[], location = "$"): void {
  if (!node) return;
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value as string | undefined;
      if (key !== undefined) {
        if (seen.has(key)) duplicates.push(`${location}.${key}`);
        seen.add(key);
        findDuplicateKeys(property.children?.[1], duplicates, `${location}.${key}`);
      }
    }
  } else if (node.type === "array") {
    for (const child of node.children ?? []) findDuplicateKeys(child, duplicates, location);
  }
}

export function parseConfig(source: string): ConfigDocument {
  const errors: ParseError[] = [];
  const value = parse(source, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0) throw new Error(`malformed OpenCode configuration (JSONC parse error ${errors[0]!.error} at offset ${errors[0]!.offset})`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("OpenCode configuration root must be an object");
  const duplicates: string[] = [];
  findDuplicateKeys(parseTree(source, [], { allowTrailingComma: true, disallowComments: false }), duplicates);
  if (duplicates.length > 0) throw new Error(`duplicate configuration key: ${duplicates.join(", ")}`);
  const mcp = (value as Record<string, unknown>).mcp;
  if (mcp !== undefined && (typeof mcp !== "object" || mcp === null || Array.isArray(mcp))) throw new Error("OpenCode configuration mcp value must be an object");
  return { source, value: value as Record<string, unknown> };
}

function formatting(source: string) {
  const tab = source.match(/^([ \t]+)\S/m)?.[1] ?? "  ";
  return { insertSpaces: !tab.includes("\t"), tabSize: tab.includes("\t") ? 1 : tab.length, eol: source.includes("\r\n") ? "\r\n" : "\n" };
}

export function setConfigEntry(source: string, name: string, value: unknown, addSchema: boolean): string {
  parseConfig(source);
  let result = source;
  const options = { formattingOptions: formatting(source) };
  if (addSchema) result = applyEdits(result, modify(result, ["$schema"], "https://opencode.ai/config.json", options));
  result = applyEdits(result, modify(result, ["mcp", name], value, options));
  return result.endsWith("\n") ? result : `${result}\n`;
}

export function removeConfigEntry(source: string, name: string): string {
  parseConfig(source);
  const result = applyEdits(source, modify(source, ["mcp", name], undefined, { formattingOptions: formatting(source) }));
  return result.endsWith("\n") ? result : `${result}\n`;
}

export function configEntry(document: ConfigDocument, name: string): unknown {
  return (document.value.mcp as Record<string, unknown> | undefined)?.[name];
}

export function structurallyEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => structurallyEqual(item, right[index]));
  }
  if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && structurallyEqual(a[key], b[key]));
  }
  return false;
}
