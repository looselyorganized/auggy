import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { resolveConfigPath } from "../resolve-config";
import { scaffoldCustomAugment } from "../scaffold-custom-augment";
import { validateCustomAugment } from "../augment-validator";

export interface AugmentCommandDeps {
  scaffoldCustomAugment?: typeof scaffoldCustomAugment;
  installCustomAugment?: typeof installCustomAugment;
  validateCustomAugment?: typeof validateCustomAugment;
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

export function augmentCommand(deps: AugmentCommandDeps = {}): Command {
  const scaffold = deps.scaffoldCustomAugment ?? scaffoldCustomAugment;
  const install = deps.installCustomAugment ?? installCustomAugment;
  const validate = deps.validateCustomAugment ?? validateCustomAugment;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  const command = new Command("augment").description("Create and manage custom augments");

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
        console.log(`Valid custom augment "${result.name}" (${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}).`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  return command;
}

export function installCustomAugment(opts: InstallCustomAugmentOptions): InstallCustomAugmentResult {
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

function copyCustomSkillIfPresent(sourceFile: string, agentDir: string, augmentName: string): boolean {
  const sourceDir = dirname(sourceFile);
  const skillPath = join(sourceDir, "SKILL.md");
  if (!existsSync(skillPath)) return false;
  const destDir = join(agentDir, "skills", augmentName);
  mkdirSync(destDir, { recursive: true });
  cpSync(skillPath, join(destDir, "SKILL.md"));
  return true;
}
