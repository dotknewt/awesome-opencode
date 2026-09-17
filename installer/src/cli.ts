#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { InstallerEngine, type InstallerPlan, type ToolkitListing } from "./installer-engine.js";
import { resolveTarget, type TargetPaths } from "./target.js";
import { validateToolkitCatalog } from "./toolkit-manifest.js";

const packageRoot = fileURLToPath(new URL("../../..", import.meta.url));
const catalogRoot = path.join(packageRoot, "toolkits");
const packageMetadata = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
if (typeof packageMetadata.version !== "string") throw new Error("package.json does not declare a string version");
const packageVersion = packageMetadata.version;

const help = `awesome-opencode - install native OpenCode toolkits

Usage:
  awesome-opencode list (--project PATH | --global)
  awesome-opencode install <toolkit...> (--project PATH | --global) [--dry-run]
  awesome-opencode update [toolkit...] (--project PATH | --global) [--dry-run]
  awesome-opencode uninstall <toolkit...> (--project PATH | --global) [--dry-run]
  awesome-opencode validate
  awesome-opencode --help
  awesome-opencode --version

Target options:
  --project PATH  Manage one explicit project. Relative paths resolve from cwd.
  --global        Manage the OpenCode config root selected by XDG_CONFIG_HOME/HOME.

Mutation options:
  --dry-run       Print the complete plan without locks, recovery, directories, or writes.

Actual mutations are Linux-first and require the util-linux flock executable.
The installer never starts an MCP server. Restart OpenCode after successful changes.`;

interface ParsedArguments {
  command: string;
  names: string[];
  project?: string;
  global: boolean;
  dryRun: boolean;
}

class UsageError extends Error {}

function parseArguments(argv: string[]): ParsedArguments {
  const [command, ...rest] = argv;
  if (!command) throw new UsageError("missing command");
  const names: string[] = [];
  let project: string | undefined;
  let global = false;
  let dryRun = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === "--global") {
      global = true;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--project") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) throw new UsageError("--project requires PATH");
      if (project !== undefined) throw new UsageError("--project may be specified only once");
      project = value;
      index += 1;
    } else if (argument.startsWith("--project=")) {
      const value = argument.slice("--project=".length);
      if (!value) throw new UsageError("--project requires PATH");
      if (project !== undefined) throw new UsageError("--project may be specified only once");
      project = value;
    } else if (argument.startsWith("-")) {
      throw new UsageError(`unknown option: ${argument}`);
    } else {
      names.push(argument);
    }
  }
  return { command, names, ...(project === undefined ? {} : { project }), global, dryRun };
}

async function targetFromArguments(arguments_: ParsedArguments): Promise<TargetPaths> {
  if ((arguments_.project === undefined) === !arguments_.global) {
    throw new UsageError("select exactly one of --project PATH or --global");
  }
  return arguments_.project === undefined
    ? resolveTarget({ scope: "global", env: process.env })
    : resolveTarget({ scope: "project", projectRoot: arguments_.project, env: process.env });
}

function requireMutationSupport(): void {
  if (process.platform !== "linux") {
    throw new Error(`mutations require Linux and util-linux flock (current platform: ${process.platform})`);
  }
  const result = spawnSync("flock", ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0 || !/util-linux/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error("mutations require the Linux util-linux flock executable on PATH");
  }
}

function printListing(rows: ToolkitListing[]): number {
  console.log("TOOLKIT\tAVAILABLE\tINSTALLED\tSTATUS");
  let failed = false;
  for (const row of rows) {
    const status = row.error ?? (row.installedVersion ? "installed" : "available");
    console.log(`${row.name}\t${row.availableVersion ?? "-"}\t${row.installedVersion ?? "-"}\t${status}`);
    if (row.error) failed = true;
  }
  return failed ? 1 : 0;
}

function printPlan(plan: InstallerPlan): void {
  console.log(plan.dryRun ? "DRY RUN - no target writes performed" : "Applied plan");
  for (const summary of plan.summary) console.log(`  ${summary}`);
  if (plan.changes.length === 0) {
    console.log(`${plan.dryRun ? "Planned" : "Applied"} file/config changes: none`);
  } else {
    console.log(`${plan.dryRun ? "Planned" : "Applied"} file/config changes:`);
    for (const change of plan.changes) console.log(`  - ${change.description}`);
  }
  if (plan.recoveryPending) console.log("Recovery pending: interrupted transaction must be recovered by a non-dry-run mutation.");
}

async function validateCatalog(root = packageRoot): Promise<number> {
  const toolkitRoot = path.join(root, "toolkits");
  const results = await validateToolkitCatalog(toolkitRoot);
  if (results.length === 0) {
    console.error("No toolkit manifests found.");
    return 1;
  }

  let failed = false;
  for (const result of results) {
    if (result.errors.length === 0 && result.manifest) {
      console.log(`valid: ${result.manifest.name}@${result.manifest.version}`);
      continue;
    }
    failed = true;
    console.error(`invalid: ${path.relative(root, result.manifestPath)}`);
    for (const error of result.errors) console.error(`  - ${error}`);
  }
  return failed ? 1 : 0;
}

async function run(argv: string[]): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(help);
    return 0;
  }
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    console.log(packageVersion);
    return 0;
  }
  const arguments_ = parseArguments(argv);
  if (arguments_.command === "validate") {
    if (arguments_.names.length > 0 || arguments_.project !== undefined || arguments_.global || arguments_.dryRun) {
      throw new UsageError("validate does not accept target, toolkit, or dry-run arguments");
    }
    return validateCatalog();
  }
  if (!["list", "install", "update", "uninstall"].includes(arguments_.command)) {
    throw new UsageError(`unknown command: ${arguments_.command}`);
  }
  if (arguments_.command === "list" && (arguments_.names.length > 0 || arguments_.dryRun)) {
    throw new UsageError("list accepts only one target option");
  }
  if (["install", "uninstall"].includes(arguments_.command) && arguments_.names.length === 0) {
    throw new UsageError(`${arguments_.command} requires at least one toolkit name`);
  }

  const target = await targetFromArguments(arguments_);
  const engine = new InstallerEngine({ catalogRoot, target });
  if (arguments_.command === "list") return printListing(await engine.list());
  if (!arguments_.dryRun) requireMutationSupport();
  const options = { dryRun: arguments_.dryRun };
  const plan = arguments_.command === "install"
    ? await engine.install(arguments_.names, options)
    : arguments_.command === "update"
      ? await engine.update(arguments_.names, options)
      : await engine.uninstall(arguments_.names, options);
  printPlan(plan);
  if (!arguments_.dryRun) console.log("Restart OpenCode to load the updated native skills and MCP configuration.");
  return 0;
}

async function main(): Promise<void> {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`Error: ${error.message}\n\n${help}`);
      process.exitCode = 2;
    } else {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }
}

await main();
