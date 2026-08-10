import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { confirm } from "@inquirer/prompts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { AUGMENT_CATALOG, resolveCatalogEntry, type CatalogEntry } from "../augment-catalog";
import { runAdd, type AddOpts } from "./add";
import { resolveConfigPath } from "../resolve-config";
import { scaffoldCustomAugment } from "../scaffold-custom-augment";
import { validateCustomAugment } from "../augment-validator";
import { augmentFolderForType } from "../scaffold-skills";
import { displayPath } from "../display-path";
import { VALID_NAME_RE } from "../config-parser";
import { writeFileExclusively, writeFileSafely } from "../safe-write";
import {
  formatAgentMailSetupResult,
  runAgentMailSetup,
  type AgentMailSetupOptions,
} from "./agentmail";

export interface AugmentCommandDeps {
  scaffoldCustomAugment?: typeof scaffoldCustomAugment;
  installCustomAugment?: typeof installCustomAugment;
  validateCustomAugment?: typeof validateCustomAugment;
  runAdd?: typeof runAdd;
  setupAugment?: typeof runAugmentSetup;
  removeAugment?: typeof removeAugment;
  exit?: (code: number) => void;
  auggyDir?: string;
  cwd?: string;
  promptCreateSkill?: (slug: string) => Promise<boolean>;
}

export interface CreateCustomAugmentOptions {
  slug: string;
  cwd?: string;
  includeSkill?: boolean;
  force?: boolean;
}

export interface CreateCustomAugmentResult {
  configPath: string;
  augmentDir: string;
  skillDir: string | null;
  name: string;
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
  warnings: string[];
}

export interface AugmentSetupOptions extends AgentMailSetupOptions {
  agent?: string;
  config?: string;
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
  category: "built-in" | "custom";
  source?: string;
}

export interface AugmentCatalogList {
  installed: ListedAugment[];
  available: CatalogEntry[];
  preview: CatalogEntry[];
}

export function augmentCommand(deps: AugmentCommandDeps = {}): Command {
  const scaffold = deps.scaffoldCustomAugment ?? scaffoldCustomAugment;
  const install = deps.installCustomAugment ?? installCustomAugment;
  const validate = deps.validateCustomAugment ?? validateCustomAugment;
  const add = deps.runAdd ?? runAdd;
  const setup = deps.setupAugment ?? runAugmentSetup;
  const remove = deps.removeAugment ?? removeAugment;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const promptCreateSkill =
    deps.promptCreateSkill ??
    ((slug: string) => {
      if (!process.stdin.isTTY) return Promise.resolve(false);
      return confirm({
        message: `Create skills/${slug}/SKILL.md? It becomes model-visible guidance, so only add it if you plan to edit it.`,
        default: false,
      });
    });

  const command = new Command("augment").description("Add, remove, list, and create augments");

  command
    .command("add")
    .description("Add one or more augments to an agent")
    .argument("[augments...]", "augment names to add; omit to open the selector")
    .option("--agent <name>", "agent project name when running from a parent directory")
    .option("--config <path>", "path to agent.yaml")
    .option("--skip-install", "mutate package.json but don't run bun install")
    .option("--yes", "skip preview confirmations and optional post-add setup prompts")
    .action(
      async (
        augments: string[],
        opts: { agent?: string; config?: string; skipInstall?: boolean; yes?: boolean },
      ) => {
        try {
          const requestedAugments = augments.length > 0 ? augments : undefined;
          const addOpts: AddOpts = {
            augment: requestedAugments,
            config: opts.config,
            skipInstall: opts.skipInstall,
            yes: opts.yes,
            auggyDir: deps.auggyDir,
          };
          await add(opts.agent, addOpts);
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          exit(1);
        }
      },
    );

  command
    .command("setup <augment>")
    .description("Configure secrets and external services for an installed augment")
    .option("--agent <name>", "agent project name when running from a parent directory")
    .option("--config <path>", "path to agent.yaml")
    .option("--mode <mode>", "setup mode where supported")
    .option("--human-email <email>", "human owner email for AgentMail signup")
    .option("--username <username>", "external-service username or inbox name")
    .option("--display-name <name>", "external-service display name")
    .option(
      "--api-key <key>",
      "external-service API key (prefer a secure prompt or provider environment variable)",
    )
    .option("--inbox-id <id>", "existing AgentMail inbox ID for manual mode")
    .option("--base-url <url>", "external-service API base URL")
    .action(async (augment: string, opts: AugmentSetupOptions) => {
      try {
        const result = await setup(augment, opts, { auggyDir: deps.auggyDir });
        console.log(result);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  command
    .command("list")
    .description("List augments installed in an agent")
    .option("--agent <name>", "agent project name when running from a parent directory")
    .option("--config <path>", "path to agent.yaml")
    .action((opts: { agent?: string; config?: string }) => {
      try {
        const result = listAugmentCatalog({
          agentName: opts.agent,
          config: opts.config,
          auggyDir: deps.auggyDir,
        });
        console.log(formatAugmentCatalog(result));
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
        console.log(
          `Removed augment "${result.name}" (${result.type}) from ${displayPath(result.configPath)}.`,
        );
        if (result.skillRemoved) console.log(`Removed skill ${result.skillRemoved}.`);
        for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  command
    .command("create <slug>")
    .description("Create and register a custom augment in the current agent")
    .option("--force", "overwrite an existing target directory")
    .option("--with-skill", "also scaffold skills/<slug>/SKILL.md without prompting")
    .option("--without-skill", "do not scaffold a skill without prompting")
    .action(
      async (
        slug: string,
        opts: { force?: boolean; withSkill?: boolean; withoutSkill?: boolean },
      ) => {
        try {
          if (opts.withSkill && opts.withoutSkill) {
            throw new Error("Choose either --with-skill or --without-skill, not both.");
          }
          if (!VALID_NAME_RE.test(slug.trim())) {
            throw new Error(
              `Invalid augment slug "${slug}". Use lowercase letters, numbers, hyphens, or underscores.`,
            );
          }
          // Fail before prompting when the command is not running at an agent root.
          resolveConfigPath(undefined, undefined, { cwd: deps.cwd ?? process.cwd() });
          const includeSkill = opts.withSkill
            ? true
            : opts.withoutSkill
              ? false
              : await promptCreateSkill(slug);
          const result = createCustomAugment(
            {
              slug,
              cwd: deps.cwd,
              includeSkill,
              force: opts.force ?? false,
            },
            { scaffold },
          );
          console.log(
            `Created and installed custom augment "${slug}" at ${displayPath(result.augmentDir, deps.cwd)}.`,
          );
          if (result.skillDir) {
            console.log(`Created skill at ${displayPath(result.skillDir, deps.cwd)}/SKILL.md.`);
            console.log("Next: customize the augment implementation and skill for your use case.");
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          exit(1);
        }
      },
    );

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
        console.log(
          `Installed custom augment "${result.name}" in ${displayPath(result.configPath)}`,
        );
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

export async function runAugmentSetup(
  augment: string,
  opts: AugmentSetupOptions = {},
  deps: { auggyDir?: string } = {},
): Promise<string> {
  const type = resolveSetupType(augment);
  switch (type) {
    case "agentMail":
    case "visitorAuth": {
      const result = await runAgentMailSetup(type, opts, {
        auggyDir: deps.auggyDir,
        cwd: opts.agent || opts.config ? undefined : process.cwd(),
      });
      return formatAgentMailSetupResult(result);
    }
    default:
      throw new Error(
        `Augment setup is not available for "${augment}" yet.\n\n` +
          "Supported today: agentMail, visitorAuth.",
      );
  }
}

function resolveSetupType(specifier: string): string {
  const entry = resolveCatalogEntry(specifier);
  if (entry) return entry.type;
  return specifier.trim();
}

export function listAugments(opts: ListAugmentsOptions = {}): ListedAugment[] {
  const configPath = resolveConfigPath(opts.agentName, opts.config, {
    auggyDir: opts.auggyDir,
    cwd: opts.cwd,
  });
  const doc = readAgentYaml(configPath);
  const augments = readAugments(doc, dirname(configPath));
  return augments.map((augment) => ({
    label: labelForAugment(augment.type, augment.name),
    name: augment.name,
    type: augment.type,
    category: augment.type === "custom" ? "custom" : "built-in",
    source: augment.source,
  }));
}

export function formatAugmentList(augments: ListedAugment[]): string {
  const rows = augments.map((augment) => {
    const cells = [augment.label, augment.type, augment.category];
    if (augment.type === "custom" && augment.source) cells.push(augment.source);
    return cells;
  });
  const headers = [
    "AUGMENT",
    "TYPE",
    "CATEGORY",
    rows.some((row) => row.length > 3) ? "SOURCE" : "",
  ].filter(Boolean);
  const allRows = [headers, ...rows];
  const widths = headers.map((_, index) =>
    Math.max(...allRows.map((row) => row[index]?.length ?? 0)),
  );
  return allRows
    .map((row) => row.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join("  "))
    .join("\n");
}

export function listAugmentCatalog(opts: ListAugmentsOptions = {}): AugmentCatalogList {
  const installed = listInstalledForCatalog(opts);
  const installedTypes = new Set(installed.map((augment) => augment.type));
  return {
    installed,
    available: AUGMENT_CATALOG.filter(
      (entry) => entry.stability === "stable" && !installedTypes.has(entry.type),
    ),
    preview: AUGMENT_CATALOG.filter(
      (entry) => entry.stability === "preview" && !installedTypes.has(entry.type),
    ),
  };
}

function listInstalledForCatalog(opts: ListAugmentsOptions): ListedAugment[] {
  try {
    return listAugments(opts);
  } catch (err) {
    const message = (err as Error).message;
    const catalogOnly = !opts.agentName && !opts.config && message.startsWith("No agent specified");
    if (catalogOnly) return [];
    throw err;
  }
}

export function formatAugmentCatalog(list: AugmentCatalogList): string {
  return [
    formatCatalogSection("Installed", list.installed, formatInstalledAugment),
    list.available.length > 0
      ? formatCatalogSection("Available", list.available, formatCatalogEntry)
      : "",
    list.preview.length > 0
      ? formatCatalogSection("Preview", list.preview, formatCatalogEntry)
      : "",
    "Add augments:\n  auggy augment add\n  auggy augment add <name...>",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatCatalogSection<T>(
  title: string,
  rows: T[],
  formatRow: (row: T, width: number) => string,
): string {
  if (rows.length === 0) return `${title}:\n  none`;
  const width = Math.max(...rows.map((row) => catalogIdentifier(row).length));
  return [`${title}:`, ...rows.map((row) => formatRow(row, width))].join("\n");
}

function catalogIdentifier(row: unknown): string {
  if (isCatalogEntry(row)) return row.defaultName;
  return (row as ListedAugment).type;
}

function formatInstalledAugment(augment: ListedAugment, width: number): string {
  const suffix = augment.category === "custom" && augment.source ? ` (${augment.source})` : "";
  return `  ${augment.type.padEnd(width)}  ${augment.label}${suffix}`;
}

function formatCatalogEntry(entry: CatalogEntry, width: number): string {
  return `  ${entry.defaultName.padEnd(width)}  # ${capitalize(entry.tagline)}`;
}

function isCatalogEntry(value: unknown): value is CatalogEntry {
  return !!value && typeof value === "object" && "defaultName" in value;
}

function capitalize(value: string): string {
  if (!value) return value;
  return `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

export function removeAugment(opts: RemoveAugmentOptions): RemoveAugmentResult {
  const configPath = resolveConfigPath(opts.agentName, opts.config, {
    auggyDir: opts.auggyDir,
    cwd: opts.cwd,
  });
  const agentDir = dirname(configPath);
  const doc = readAgentYaml(configPath);
  const augments = readAugments(doc, agentDir);
  const index = findAugmentIndex(augments, opts.augment);
  if (index === -1) {
    throw new Error(`Augment "${opts.augment}" is not installed in ${configPath}.`);
  }

  const removed = augments[index]!;
  const removedType = removed.type;
  const removedName = removed.name;
  const catalogEntry = AUGMENT_CATALOG.find((entry) => entry.type === removedType);
  if (catalogEntry?.required) {
    throw new Error(`Augment "${removedName}" (${removedType}) is required and cannot be removed.`);
  }

  const rawAugments = Array.isArray(doc.augments) ? [...doc.augments] : [];
  rawAugments.splice(removed.index, 1);
  doc.augments = rawAugments;
  writeFileSafely(configPath, `# Agent configuration\n\n${stringifyYaml(doc)}`);

  const skillRemoved = removeSkillForAugment(agentDir, removedName, removedType);
  removeAugmentFolder(agentDir, removedName, removedType);
  const warnings = agentMailRemovalWarnings(removedType, augments, index);
  return { configPath, name: removedName, type: removedType, skillRemoved, warnings };
}

function agentMailRemovalWarnings(
  removedType: string,
  augments: readonly AugmentRecord[],
  removedIndex: number,
): string[] {
  if (removedType !== "agentMail" && removedType !== "visitorAuth") return [];

  const remainingSharedConsumer = augments.some(
    (augment, index) =>
      index !== removedIndex && (augment.type === "agentMail" || augment.type === "visitorAuth"),
  );
  if (remainingSharedConsumer) {
    return [
      "AGENTMAIL_* values and the remote AgentMail inbox/key were retained because another shared mail consumer is still installed.",
    ];
  }
  return [
    "Auggy did not remove AGENTMAIL_* values or revoke the remote AgentMail inbox/key. Other configuration may still reference them; if nothing does, revoke the scoped key in AgentMail before removing the local values.",
  ];
}

function readAgentYaml(configPath: string): Record<string, unknown> {
  const raw = parseYaml(readFileSync(configPath, "utf-8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${configPath}: not a valid agent.yaml object`);
  }
  return raw as Record<string, unknown>;
}

interface AugmentRecord {
  index: number;
  name: string;
  type: string;
  source?: string;
}

function readAugments(doc: Record<string, unknown>, agentDir: string): AugmentRecord[] {
  if (!Array.isArray(doc.augments)) return [];

  return doc.augments.map((entry, index) => {
    if (typeof entry === "string") {
      const metadata = readAugmentMetadata(agentDir, entry);
      const type = stringField(metadata.type) ?? "(unknown)";
      return {
        index,
        name: entry,
        type,
        source: stringField(metadata.source) ?? undefined,
      };
    }

    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const type = stringField(record.type) ?? "(unknown)";
      return {
        index,
        name: stringField(record.name) ?? type,
        type,
        source: stringField(record.source) ?? undefined,
      };
    }

    return { index, name: "(invalid)", type: "(invalid)" };
  });
}

function readAugmentMetadata(agentDir: string, id: string): Record<string, unknown> {
  const metadataPath = join(agentDir, "augments", id, "augment.yaml");
  if (!existsSync(metadataPath)) {
    throw new Error(`Augment "${id}" is listed in agent.yaml but ${metadataPath} is missing.`);
  }
  const parsed = parseYaml(readFileSync(metadataPath, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${metadataPath}: not a valid YAML object.`);
  }
  return parsed as Record<string, unknown>;
}

function findAugmentIndex(augments: AugmentRecord[], specifier: string): number {
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

function removeAugmentFolder(agentDir: string, name: string, type: string): string | null {
  const candidates = [...new Set([name, augmentFolderForType(type)].filter(Boolean) as string[])];
  for (const candidate of candidates) {
    const augmentDir = join(agentDir, "augments", candidate);
    if (!existsSync(augmentDir)) continue;
    rmSync(augmentDir, { recursive: true, force: true });
    return join("augments", candidate);
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

/**
 * Create a custom augment inside the current agent project and make it active.
 * Skills are a separate, optional runtime surface under skills/<slug>/.
 */
export function createCustomAugment(
  opts: CreateCustomAugmentOptions,
  deps: { scaffold?: typeof scaffoldCustomAugment } = {},
): CreateCustomAugmentResult {
  const slug = opts.slug.trim();
  if (!VALID_NAME_RE.test(slug)) {
    throw new Error(
      `Invalid augment slug "${opts.slug}". Use lowercase letters, numbers, hyphens, or underscores.`,
    );
  }

  const cwd = resolve(opts.cwd ?? process.cwd());
  const configPath = resolveConfigPath(undefined, undefined, { cwd });
  const agentDir = dirname(configPath);
  const doc = readAgentYaml(configPath);
  if (!Array.isArray(doc.augments)) doc.augments = [];

  const existing = readAugments(doc, agentDir).find((augment) => augment.name === slug);
  if (existing && !opts.force) {
    throw new Error(
      `Augment "${slug}" is already declared in ${configPath}. Re-run with --force to overwrite its scaffold.`,
    );
  }

  const augmentDir = join(agentDir, "augments", slug);
  const skillDir = opts.includeSkill ? join(agentDir, "skills", slug) : null;
  const scaffold = deps.scaffold ?? scaffoldCustomAugment;
  scaffold({
    slug,
    targetDir: augmentDir,
    skillTargetDir: skillDir ?? undefined,
    force: opts.force ?? false,
  });

  if (!existing) {
    (doc.augments as unknown[]).push(slug);
    writeFileSafely(configPath, `# Agent configuration\n\n${stringifyYaml(doc)}`);
  }

  return { configPath, augmentDir, skillDir, name: slug };
}

export function installCustomAugment(
  opts: InstallCustomAugmentOptions,
): InstallCustomAugmentResult {
  const configPath = resolveConfigPath(opts.agentName, opts.config, { auggyDir: opts.auggyDir });
  const agentDir = dirname(configPath);
  const sourceEntry = resolve(opts.sourcePath);
  const sourceFile = resolveSourceFile(sourceEntry);
  const augmentName = basename(dirname(sourceFile));
  if (!VALID_NAME_RE.test(augmentName)) {
    throw new Error(
      `Invalid augment name "${augmentName}". Use letters, numbers, hyphens, or underscores.`,
    );
  }

  const raw = parseYaml(readFileSync(configPath, "utf-8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${configPath}: not a valid agent.yaml object`);
  }

  const doc = raw as Record<string, unknown>;
  if (!Array.isArray(doc.augments)) doc.augments = [];
  const augments = readAugments(doc, agentDir);
  if (augments.some((a) => a.name === augmentName)) {
    throw new Error(`Augment "${augmentName}" is already declared in ${configPath}.`);
  }

  const augmentDir = join(agentDir, "augments", augmentName);
  mkdirSync(augmentDir, { recursive: true });
  const metadataSource = normalizeRelativePath(relative(augmentDir, sourceFile));
  const agentSource = normalizeRelativePath(relative(agentDir, sourceFile));
  const metadataPath = join(augmentDir, "augment.yaml");
  try {
    writeFileExclusively(
      metadataPath,
      stringifyYaml({
        type: "custom",
        source: metadataSource,
        config: {},
      }),
      { mode: 0o600 },
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  (doc.augments as unknown[]).push(augmentName);
  writeFileSafely(configPath, `# Agent configuration\n\n${stringifyYaml(doc)}`);

  return { configPath, agentDir, source: agentSource, name: augmentName };
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
