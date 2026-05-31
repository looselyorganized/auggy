import { Command } from "commander";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { AUGMENT_CATALOG, resolveCatalogEntry } from "../augment-catalog";
import { runAdd, type AddOpts } from "./add";
import { resolveConfigPath } from "../resolve-config";
import { scaffoldCustomAugment } from "../scaffold-custom-augment";
import { validateCustomAugment } from "../augment-validator";
import { augmentFolderForType } from "../scaffold-skills";

export interface AugmentCommandDeps {
  scaffoldCustomAugment?: typeof scaffoldCustomAugment;
  installCustomAugment?: typeof installCustomAugment;
  validateCustomAugment?: typeof validateCustomAugment;
  runAdd?: typeof runAdd;
  removeAugment?: typeof removeAugment;
  exit?: (code: number) => void;
  auggyDir?: string;
}

export interface InstallCustomAugmentOptions {
  agentName: string;
  sourcePath: string;
  config?: string;
  auggyDir?: string;
}

export interface InstallCustomAugmentResult {
  configPath: string;
  agentDir: string;
  source: string;
  name: string;
  skillCopied: boolean;
}

export interface RemoveAugmentOptions {
  agentName?: string;
  augment: string;
  config?: string;
  auggyDir?: string;
  cwd?: string;
}

export interface RemoveAugmentResult {
  configPath: string;
  name: string;
  type: string;
  skillRemoved: string | null;
}

export interface ListAugmentsOptions {
  agentName?: string;
  config?: string;
  auggyDir?: string;
  cwd?: string;
}

export interface ListedAugment {
  label: string;
  name: string;
  type: string;
  source?: string;
}

export function augmentCommand(deps: AugmentCommandDeps = {}): Command {
  const scaffold = deps.scaffoldCustomAugment ?? scaffoldCustomAugment;
  const install = deps.installCustomAugment ?? installCustomAugment;
  const validate = deps.validateCustomAugment ?? validateCustomAugment;
  const add = deps.runAdd ?? runAdd;
  const remove = deps.removeAugment ?? removeAugment;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  const command = new Command("augment").description("Add, remove, list, and create augments");

  command
    .command("add <augment>")
    .description("Add an augment to an agent")
    .option("--agent <name>", "agent project name when running from a parent directory")
    .option("--config <path>", "path to agent.yaml")
    .option("--skip-install", "mutate package.json but don't run bun install")
    .action(
      async (augment: string, opts: { agent?: string; config?: string; skipInstall?: boolean }) => {
        try {
          const addOpts: AddOpts = {
            augment: opts.agent || opts.config ? augment : undefined,
            config: opts.config,
            skipInstall: opts.skipInstall,
            auggyDir: deps.auggyDir,
          };
          await add(opts.agent ?? (opts.config ? undefined : augment), addOpts);
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          exit(1);
        }
      },
    );

  command
    .command("list")
    .description("List augments installed in an agent")
    .option("--agent <name>", "agent project name when running from a parent directory")
    .option("--config <path>", "path to agent.yaml")
    .action((opts: { agent?: string; config?: string }) => {
      try {
        const result = listAugments({
          agentName: opts.agent,
          config: opts.config,
          auggyDir: deps.auggyDir,
        });
        if (result.length === 0) {
          console.log("No augments installed.");
          return;
        }
        console.log(formatAugmentList(result));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  command
    .command("remove <augment>")
    .description("Remove an augment from an agent")
    .option("--agent <name>", "agent project name when running from a parent directory")
    .option("--config <path>", "path to agent.yaml")
    .action((augment: string, opts: { agent?: string; config?: string }) => {
      try {
        const result = remove({
          agentName: opts.agent,
          augment,
          config: opts.config,
          auggyDir: deps.auggyDir,
        });
        console.log(`Removed augment "${result.name}" (${result.type}) from ${result.configPath}.`);
        if (result.skillRemoved) console.log(`Removed skill ${result.skillRemoved}.`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  command
    .command("create <slug>")
    .description("Scaffold a local custom augment")
    .option("--dir <path>", "target directory (defaults to ./augments/<slug>)")
    .option("--force", "overwrite an existing target directory")
    .action(async (slug: string, opts: { dir?: string; force?: boolean }) => {
      try {
        const dir = scaffold({
          slug,
          targetDir: opts.dir,
          force: opts.force ?? false,
        });
        console.log(`Created custom augment "${slug}" at ${dir}`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  command
    .command("install <agent> <path>")
    .description("Install a local custom augment into an agent")
    .option("--config <path>", "path to agent.yaml")
    .action(async (agentName: string, sourcePath: string, opts: { config?: string }) => {
      try {
        const result = install({
          agentName,
          sourcePath,
          config: opts.config,
          auggyDir: deps.auggyDir,
        });
        console.log(`Installed custom augment "${result.name}" in ${result.configPath}`);
        if (result.skillCopied) {
          console.log(`Copied skill to ${join(result.agentDir, "skills", result.name)}/`);
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  command
    .command("test <path>")
    .description("Validate a local custom augment module")
    .action(async (sourcePath: string) => {
      try {
        const sourceFile = resolveSourceFile(resolve(sourcePath));
        const result = await validate(sourceFile);
        console.log(
          `Valid custom augment "${result.name}" (${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}).`,
        );
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  return command;
}

export function listAugments(opts: ListAugmentsOptions = {}): ListedAugment[] {
  const configPath = resolveConfigPath(opts.agentName, opts.config, {
    auggyDir: opts.auggyDir,
    cwd: opts.cwd,
  });
  const doc = readAgentYaml(configPath);
  const augments = readAugments(doc);
  return augments.map((augment) => ({
    label: labelForAugment(stringField(augment.type), stringField(augment.name)),
    name: stringField(augment.name) ?? "(unnamed)",
    type: stringField(augment.type) ?? "(unknown)",
    source: stringField(augment.source) ?? undefined,
  }));
}

export function formatAugmentList(augments: ListedAugment[]): string {
  const rows = augments.map((augment) => {
    const cells = [augment.label, augment.type];
    if (augment.type === "custom" && augment.source) cells.push(augment.source);
    return cells;
  });
  const headers = ["AUGMENT", "TYPE", rows.some((row) => row.length > 2) ? "SOURCE" : ""].filter(
    Boolean,
  );
  const allRows = [headers, ...rows];
  const widths = headers.map((_, index) =>
    Math.max(...allRows.map((row) => row[index]?.length ?? 0)),
  );
  return allRows
    .map((row) => row.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join("  "))
    .join("\n");
}

export function removeAugment(opts: RemoveAugmentOptions): RemoveAugmentResult {
  const configPath = resolveConfigPath(opts.agentName, opts.config, {
    auggyDir: opts.auggyDir,
    cwd: opts.cwd,
  });
  const agentDir = dirname(configPath);
  const doc = readAgentYaml(configPath);
  const augments = readAugments(doc);
  const index = findAugmentIndex(augments, opts.augment);
  if (index === -1) {
    throw new Error(`Augment "${opts.augment}" is not installed in ${configPath}.`);
  }

  const [removed] = augments.splice(index, 1);
  const removedName = stringField(removed?.name) ?? opts.augment;
  const removedType = stringField(removed?.type) ?? "custom";
  const catalogEntry = AUGMENT_CATALOG.find((entry) => entry.type === removedType);
  if (catalogEntry?.required) {
    throw new Error(`Augment "${removedName}" (${removedType}) is required and cannot be removed.`);
  }

  doc.augments = augments;
  writeFileSync(configPath, `# Agent configuration\n\n${stringifyYaml(doc)}`);

  const skillRemoved = removeSkillForAugment(agentDir, removedName, removedType);
  return { configPath, name: removedName, type: removedType, skillRemoved };
}

function readAgentYaml(configPath: string): Record<string, unknown> {
  const raw = parseYaml(readFileSync(configPath, "utf-8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${configPath}: not a valid agent.yaml object`);
  }
  return raw as Record<string, unknown>;
}

function readAugments(doc: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(doc.augments) ? (doc.augments as Record<string, unknown>[]) : [];
}

function findAugmentIndex(augments: Record<string, unknown>[], specifier: string): number {
  const normalized = specifier.trim();
  const direct = augments.findIndex(
    (augment) => augment.name === normalized || augment.type === normalized,
  );
  if (direct !== -1) return direct;

  const catalogType = resolveCatalogType(normalized);
  if (!catalogType) return -1;
  return augments.findIndex((augment) => augment.type === catalogType);
}

function resolveCatalogType(specifier: string): string | null {
  try {
    return resolveCatalogEntry(specifier)?.type ?? null;
  } catch {
    return null;
  }
}

function removeSkillForAugment(agentDir: string, name: string, type: string): string | null {
  const candidates = [...new Set([augmentFolderForType(type), name].filter(Boolean) as string[])];
  for (const candidate of candidates) {
    const skillDir = join(agentDir, "skills", candidate);
    if (!existsSync(skillDir)) continue;
    rmSync(skillDir, { recursive: true, force: true });
    return join("skills", candidate);
  }
  return null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function labelForAugment(type: string | null, name: string | null): string {
  const entry = type ? AUGMENT_CATALOG.find((catalogEntry) => catalogEntry.type === type) : null;
  if (entry) return entry.label;
  return humanizeIdentifier(name ?? type ?? "custom");
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function installCustomAugment(
  opts: InstallCustomAugmentOptions,
): InstallCustomAugmentResult {
  const configPath = resolveConfigPath(opts.agentName, opts.config, { auggyDir: opts.auggyDir });
  const agentDir = dirname(configPath);
  const sourceEntry = resolve(opts.sourcePath);
  const sourceFile = resolveSourceFile(sourceEntry);
  const augmentName = basename(dirname(sourceFile));

  const raw = parseYaml(readFileSync(configPath, "utf-8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${configPath}: not a valid agent.yaml object`);
  }

  const doc = raw as Record<string, unknown>;
  const augments = Array.isArray(doc.augments) ? (doc.augments as Record<string, unknown>[]) : [];
  if (augments.some((a) => a.name === augmentName)) {
    throw new Error(`Augment "${augmentName}" is already declared in ${configPath}.`);
  }

  const source = normalizeRelativePath(relative(agentDir, sourceFile));
  augments.push({
    name: augmentName,
    type: "custom",
    source,
    options: {},
  });
  doc.augments = augments;
  writeFileSync(configPath, `# Agent configuration\n\n${stringifyYaml(doc)}`);

  const skillCopied = copyCustomSkillIfPresent(sourceFile, agentDir, augmentName);
  return { configPath, agentDir, source, name: augmentName, skillCopied };
}

function resolveSourceFile(sourceEntry: string): string {
  if (!existsSync(sourceEntry)) {
    throw new Error(`Custom augment path not found: ${sourceEntry}`);
  }
  const indexPath = join(sourceEntry, "index.ts");
  if (existsSync(indexPath)) return indexPath;
  if (sourceEntry.endsWith(".ts")) return sourceEntry;
  throw new Error(`Custom augment path must be a .ts file or a directory containing index.ts.`);
}

function normalizeRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

function copyCustomSkillIfPresent(
  sourceFile: string,
  agentDir: string,
  augmentName: string,
): boolean {
  const sourceDir = dirname(sourceFile);
  const skillPath = join(sourceDir, "SKILL.md");
  if (!existsSync(skillPath)) return false;
  const destDir = join(agentDir, "skills", augmentName);
  mkdirSync(destDir, { recursive: true });
  cpSync(skillPath, join(destDir, "SKILL.md"));
  return true;
}
