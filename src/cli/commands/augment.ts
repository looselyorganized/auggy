import { Command } from "commander";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { AUGMENT_CATALOG, resolveCatalogEntry, type CatalogEntry } from "../augment-catalog";
import { runAdd, type AddOpts } from "./add";
import { selectInspectionDocument } from "../authoring/inspection-selection";
import { scaffoldCustomAugment, validateCustomAugmentSlug } from "../scaffold-custom-augment";
import { validateCustomAugment } from "../augment-validator";
import { displayPath } from "../display-path";
import { VALID_NAME_RE } from "../agent-name";
import {
  assertInlineAuthoring,
  planAugmentAssets,
  publishAugmentMutation,
  rootSkillsEdit,
} from "../augment-metadata";
import { AUTHORING_LIMITS, type PublicationOptions } from "../authoring/contracts";
import { AuthoringError, readFileSnapshot } from "../authoring/document-io";
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
  config?: string;
  cwd?: string;
  includeSkill?: boolean;
  force?: boolean;
  publication?: PublicationOptions;
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
  cwd?: string;
  publication?: PublicationOptions;
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
  yes?: boolean;
  publication?: PublicationOptions;
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
    .description("Connect an installed augment to existing external credentials")
    .option("--agent <name>", "agent project name when running from a parent directory")
    .option("--config <path>", "path to agent.yaml")
    .option("--mode <mode>", "AgentMail connection mode: connect or env")
    .option(
      "--api-key <key>",
      "external-service API key (prefer a secure prompt or provider environment variable)",
    )
    .option("--inbox-id <id>", "existing AgentMail inbox ID for connect mode")
    .option("--base-url <url>", "external-service API base URL")
    .option(
      "--allow-insecure-http-with-credentials",
      "allow plaintext remote AgentMail only when NODE_ENV=development",
    )
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
    .description("Unregister an augment; retain source, skills, dependencies, env, and data")
    .option("--yes", "accept configuration-only removal (no confirmation needed)")
    .option("--agent <name>", "agent project name when running from a parent directory")
    .option("--config <path>", "path to agent.yaml")
    .action((augment: string, opts: { agent?: string; config?: string; yes?: boolean }) => {
      try {
        const result = remove({
          agentName: opts.agent,
          augment,
          yes: opts.yes,
          config: opts.config,
          auggyDir: deps.auggyDir,
        });
        console.log(
          `Removed augment "${result.name}" (${result.type}) from ${displayPath(result.configPath)}.`,
        );
        console.log(
          "Source, skills, dependencies, env, and data were retained. Root skills remain discoverable and model-visible while mounted.",
        );
        for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  command
    .command("create <slug>")
    .description("Create and register a custom augment in the current agent")
    .option("--config <path>", "path to the central agent configuration")
    .option("--force", "deprecated; refuses overwrites, use a new slug")
    .option("--with-skill", "also scaffold skills/<slug>/SKILL.md")
    .option("--without-skill", "omit the optional skill (default)")
    .action(
      async (
        slug: string,
        opts: { config?: string; force?: boolean; withSkill?: boolean; withoutSkill?: boolean },
      ) => {
        try {
          if (opts.withSkill && opts.withoutSkill) {
            throw new Error("Choose either --with-skill or --without-skill, not both.");
          }
          validateCustomAugmentSlug(slug);
          const includeSkill = opts.withSkill === true;
          const result = createCustomAugment(
            {
              slug,
              config: opts.config,
              cwd: deps.cwd,
              includeSkill,
              force: opts.force ?? false,
            },
            { scaffold },
          );
          console.log(
            `Created and installed custom augment "${slug}" at ${displayPath(result.augmentDir, realpathSync(deps.cwd ?? process.cwd()))}.`,
          );
          if (result.skillDir) {
            console.log(
              `Created skill at ${displayPath(result.skillDir, realpathSync(deps.cwd ?? process.cwd()))}/SKILL.md.`,
            );
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
  const augments = selectInspectionDocument(opts.agentName, opts.config, {
    cwd: opts.cwd ?? (opts.auggyDir ? join(opts.auggyDir, "agents") : undefined),
  }).declarations;
  return augments.map((augment) => ({
    label: labelForAugment(augment.type, augment.name),
    name: augment.name ?? "(unresolved)",
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
    const catalogOnly =
      !opts.agentName &&
      !opts.config &&
      err instanceof AuthoringError &&
      err.diagnostic.code === "missing-config";
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
  const document = selectInspectionDocument(opts.agentName, opts.config, {
    cwd: opts.cwd ?? (opts.auggyDir ? join(opts.auggyDir, "agents") : undefined),
  });
  const configPath = document.configPath;
  assertInlineAuthoring(document);
  const augments = document.declarations.map((entry) => ({ ...entry, name: entry.name! }));
  const index = findAugmentIndex(augments, opts.augment);
  if (index === -1) throw new Error(`Augment "${opts.augment}" is not installed in ${configPath}.`);
  const removed = augments[index]!;
  if (AUGMENT_CATALOG.find((entry) => entry.type === removed.type)?.required) {
    throw new Error(
      `Augment "${removed.name}" (${removed.type}) is required and cannot be removed.`,
    );
  }
  publishAugmentMutation(
    document,
    "augment-remove",
    [{ kind: "remove-augment", name: removed.name }],
    [],
    [],
    opts.publication,
  );
  return {
    configPath,
    name: removed.name,
    type: removed.type,
    skillRemoved: null,
    warnings: agentMailRemovalWarnings(removed.type, augments, index),
  };
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
      "AGENTMAIL_* values and the supplied AgentMail key were retained because another shared mail consumer is still installed.",
    ];
  }
  return [
    "Auggy did not remove AGENTMAIL_* values or change the supplied AgentMail key. Review every AgentMail consumer before removing local values or changing the key in AgentMail.",
  ];
}

interface AugmentRecord {
  index: number;
  name: string;
  type: string;
  source?: string;
}

function findAugmentIndex(augments: AugmentRecord[], specifier: string): number {
  const normalized = specifier.trim();
  const named = augments.findIndex((augment) => augment.name === normalized);
  if (named !== -1) return named;
  const type = resolveCatalogType(normalized) ?? normalized;
  const matches = augments.filter((augment) => augment.type === type);
  if (matches.length > 1)
    throw new Error("Multiple augment instances match. Remove one by its exact instance name.");
  return matches.length === 1 ? augments.indexOf(matches[0]!) : -1;
}

function resolveCatalogType(specifier: string): string | null {
  try {
    return resolveCatalogEntry(specifier)?.type ?? null;
  } catch {
    return null;
  }
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
  const slug = opts.slug;
  validateCustomAugmentSlug(slug);
  if (opts.force)
    throw new Error(
      "--force no longer overwrites augment source or skills. Choose another slug or review and move existing files manually.",
    );
  const document = selectInspectionDocument(undefined, opts.config, {
    cwd: resolve(opts.cwd ?? process.cwd()),
  });
  const configPath = document.configPath;
  assertInlineAuthoring(document);
  if (document.declarations.some((entry) => entry.name === slug))
    throw new Error(
      `Augment "${slug}" is already declared. Choose another slug or review the declaration manually.`,
    );
  const augmentDir = join(dirname(configPath), "src", "augments", slug);
  const skillDir = opts.includeSkill ? join(dirname(configPath), "skills", slug) : null;
  for (const path of [augmentDir, skillDir].filter((path): path is string => path !== null)) {
    try {
      lstatSync(path);
      throw new Error(
        "Augment source or skill directory already exists. Choose another slug or review and move the existing directory manually.",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const assets = planAugmentAssets(
    document,
    (deps.scaffold ?? scaffoldCustomAugment)({ slug, includeSkill: opts.includeSkill }),
  );
  publishAugmentMutation(
    document,
    "augment-create",
    [
      {
        kind: "append-augment",
        entry: {
          name: slug,
          type: "custom",
          source: `./src/augments/${slug}/index.ts`,
          options: {},
        },
      },
      ...(opts.includeSkill ? rootSkillsEdit(document) : []),
    ],
    assets.files,
    assets.inputs,
    opts.publication,
  );
  return { configPath, augmentDir, skillDir, name: slug };
}

export function installCustomAugment(
  opts: InstallCustomAugmentOptions,
): InstallCustomAugmentResult {
  const document = selectInspectionDocument(opts.agentName, opts.config, {
    cwd: opts.cwd ?? (opts.auggyDir ? join(opts.auggyDir, "agents") : undefined),
  });
  const configPath = document.configPath;
  assertInlineAuthoring(document);
  const agentDir = document.projectDir;
  const sourceFile = resolveSourceFile(resolve(opts.cwd ?? process.cwd(), opts.sourcePath));
  const augmentName = basename(dirname(sourceFile));
  if (!VALID_NAME_RE.test(augmentName))
    throw new Error(
      `Invalid augment name "${augmentName}". Use letters, numbers, hyphens, or underscores.`,
    );
  if (document.declarations.some((entry) => entry.name === augmentName))
    throw new Error(`Augment "${augmentName}" is already declared in ${configPath}.`);
  const source = normalizeRelativePath(
    relative(agentDir, join(realpathSync(dirname(sourceFile)), basename(sourceFile))),
  );
  const snapshot = readFileSnapshot(sourceFile, AUTHORING_LIMITS.outputBytes);
  publishAugmentMutation(
    document,
    "augment-install",
    [{ kind: "append-augment", entry: { name: augmentName, type: "custom", source, options: {} } }],
    [],
    [snapshot],
    opts.publication,
  );
  if (source.startsWith("../"))
    console.warn(
      "External custom source was referenced in place. This reference is nonportable; deployment requires an explicit source portability review.",
    );
  return { configPath, agentDir, source, name: augmentName };
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
