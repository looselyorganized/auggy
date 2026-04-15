/**
 * aug1 create <name> — scaffold a new agent directory with interactive
 * engine + augment selection.
 *
 * Flow:
 *   1. Name from CLI arg
 *   2. Interactive engine selection (provider + model)
 *   3. Interactive augment selection (required ones pre-checked)
 *   4. Scaffold directory, agent.yaml, identity.md, skills, .env.example
 */

import { existsSync, mkdirSync, writeFileSync, cpSync } from "fs";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import { checkbox, select, input } from "@inquirer/prompts";
import { stringify } from "yaml";
import { AUGMENT_CATALOG, type CatalogEntry } from "../augment-catalog";
import { scanSkillManifest, renderSkillManifest } from "../skill-manifest";

type Provider = "anthropic" | "openai" | "openrouter";

const PROVIDER_DEFAULTS: Record<Provider, { model: string; envVar: string }> = {
  anthropic: { model: "claude-sonnet-4-6", envVar: "ANTHROPIC_API_KEY" },
  openai: { model: "gpt-5", envVar: "OPENAI_API_KEY" },
  openrouter: {
    model: "anthropic/claude-sonnet-4-6",
    envVar: "OPENROUTER_API_KEY",
  },
};

// ANSI color helpers. Truecolor #FBF7EB ("cream") matches the facility palette.
// Strips to plain text when stdout is not a TTY so piped output stays clean.
const IS_TTY = Boolean(process.stdout.isTTY);
const ansi = (code: string, s: string): string =>
  IS_TTY ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = (s: string): string => ansi("1", s);
const dim = (s: string): string => ansi("2", s);
const cream = (s: string): string => ansi("38;2;251;247;235", s);
const green = (s: string): string => ansi("32", s);

export async function runCreate(
  name: string,
  opts: { dir?: string },
): Promise<void> {
  const dir = resolve(opts.dir ?? `./${name}`);

  if (existsSync(dir)) {
    throw new Error(`Directory already exists: ${dir}`);
  }

  printWelcome();

  // Interactive engine selection.
  const provider = await select<Provider>({
    message: "Engine provider:",
    choices: [
      { name: "anthropic — Claude models", value: "anthropic" },
      { name: "openai — GPT models", value: "openai" },
      { name: "openrouter — any model via OpenRouter", value: "openrouter" },
    ],
    default: "anthropic",
  });

  const model = await input({
    message: "Model:",
    default: PROVIDER_DEFAULTS[provider].model,
  });

  // Interactive augment selection.
  const selected = await checkbox({
    message: "Select augments:",
    choices: AUGMENT_CATALOG.map((entry) => ({
      name: `${entry.label} — ${entry.description}`,
      value: entry,
      checked: entry.required,
      disabled: entry.required ? "(always included)" : false,
    })),
  });

  // Ensure required augments are included even if prompt is skipped.
  const augments = AUGMENT_CATALOG.filter((e) => e.required);
  for (const entry of selected) {
    if (!augments.includes(entry)) {
      augments.push(entry);
    }
  }

  const id = `aug1_${randomUUID()}`;

  // Create directory structure.
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  mkdirSync(join(dir, "workspace"), { recursive: true });
  mkdirSync(join(dir, "augments"), { recursive: true });

  // Install each augment's skill.
  console.log();
  console.log(dim(" Installing augments..."));
  console.log();
  for (const entry of augments) {
    installAugmentSkill(entry, dir);
    console.log(
      `   ${green("\u2713")} ${cream(entry.defaultName)} ${dim(`(${entry.type})`)}`,
    );
  }

  // Copy built-in filesystem skill if available and filesystem is selected.
  if (augments.some((e) => e.type === "filesystem")) {
    const fsSkillSrc = resolve(import.meta.dir, "../../augments/filesystem-skill");
    if (existsSync(fsSkillSrc)) {
      cpSync(fsSkillSrc, join(dir, "skills", "filesystem"), { recursive: true });
    }
  }

  // Generate agent.yaml.
  const config = buildAgentYaml(id, name, augments, { provider, model });
  writeFileSync(join(dir, "agent.yaml"), config);

  // Generate identity.md with skill manifest.
  const skillEntries = scanSkillManifest(join(dir, "skills"));
  const skillManifest = renderSkillManifest(skillEntries);
  writeFileSync(join(dir, "identity.md"), buildIdentity(name, skillManifest));

  // Generate learned.md (empty).
  if (augments.some((e) => e.defaultName === "learned")) {
    writeFileSync(join(dir, "learned.md"), "");
  }

  // Generate .env.example.
  const envVars = collectEnvVars(augments, provider);
  writeFileSync(join(dir, ".env.example"), buildEnvExample(envVars));

  // Generate .gitignore.
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);

  const envVar = PROVIDER_DEFAULTS[provider].envVar;

  console.log();
  console.log(dim(" ─────────────────────────────────────────────"));
  console.log();
  console.log(
    ` ${green("\u2713")} ${bold(cream(`Agent "${name}" created`))}`,
  );
  console.log(`   ${dim(dir)}`);
  console.log();
  console.log(` ${bold("Next steps:")}`);
  console.log();
  console.log(`   ${cream("1.")}  cp ${dir}/.env.example ${dir}/.env`);
  console.log(`   ${cream("2.")}  Add your ${bold(envVar)} to ${dir}/.env`);
  console.log(`   ${cream("3.")}  Edit ${dir}/identity.md`);
  console.log(`   ${cream("4.")}  aug1 dev ${name}`);
  console.log();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printWelcome(): void {
  const banner = [
    "  █████╗ ██╗   ██╗ ██████╗  ██████╗ ██╗   ██╗",
    " ██╔══██╗██║   ██║██╔════╝ ██╔════╝ ╚██╗ ██╔╝",
    " ███████║██║   ██║██║  ███╗██║  ███╗ ╚████╔╝",
    " ██╔══██║██║   ██║██║   ██║██║   ██║  ╚██╔╝",
    " ██║  ██║╚██████╔╝╚██████╔╝╚██████╔╝   ██║",
    " ╚═╝  ╚═╝ ╚═════╝  ╚═════╝  ╚═════╝    ╚═╝",
  ];

  console.log();
  for (const line of banner) console.log(cream(line));
  console.log();
  console.log(
    ` ${bold("augment-1")}  ${dim("·  by the Loosely Organized Research Facility")}`,
  );
  console.log();
  console.log(" Auggy is a modular agent runtime. Agents are composed from");
  console.log(" swappable augments — the kernel manages context, tools,");
  console.log(" permissions, and lifecycle.");
  console.log();
  console.log(dim(" ─────────────────────────────────────────────"));
  console.log();
  console.log(" Let's configure your agent. Start by picking an engine.");
  console.log();
  console.log(
    dim(" The engine is the LLM provider the kernel calls each turn —"),
  );
  console.log(
    dim(" one per agent (Anthropic, OpenAI, OpenRouter). Augments plug in"),
  );
  console.log(dim(" around it. Both are swappable later in agent.yaml."));
  console.log();
}

function installAugmentSkill(entry: CatalogEntry, agentDir: string): void {
  if (!entry.hasSkill || !entry.skillTemplate) return;

  // Derive skill directory name from the type.
  const skillDirName =
    entry.type === "fileMemory" ? "memory" :
    entry.type === "webFetch" ? "web-fetch" :
    entry.type;

  const skillDir = join(agentDir, "skills", skillDirName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), entry.skillTemplate);
}

function buildAgentYaml(
  id: string,
  name: string,
  augments: CatalogEntry[],
  engine: { provider: Provider; model: string },
): string {
  const config: Record<string, unknown> = {
    id,
    name,
    engine: {
      provider: engine.provider,
      model: engine.model,
      maxContextTokens: 200000,
      maxTokens: 4096,
    },
    settings: {
      compactionStrategy: "truncate",
      maxInferenceLoops: 10,
    },
    augments: augments.map((entry) => ({
      name: entry.defaultName,
      type: entry.type,
      options: entry.defaultOptions,
    })),
  };

  return `# Agent configuration\n\n${stringify(config)}`;
}

function buildIdentity(name: string, skillManifest: string): string {
  return `# ${name}

You are ${name}, an Auggy agent.

## Core behaviors

- Be helpful and concise.
- Use your tools when appropriate.
- Read skill guides before using unfamiliar tools.

${skillManifest}
`;
}

function collectEnvVars(
  augments: CatalogEntry[],
  provider: Provider,
): string[] {
  const vars = new Set<string>([PROVIDER_DEFAULTS[provider].envVar]);
  for (const entry of augments) {
    if (entry.envVars) {
      for (const v of entry.envVars) vars.add(v);
    }
  }
  return [...vars];
}

function buildEnvExample(vars: string[]): string {
  const lines = [
    "# Agent secrets — copy to .env and fill in values.",
    "# .env is gitignored.",
    "",
  ];
  for (const v of vars) {
    lines.push(`${v}=`);
  }
  return lines.join("\n") + "\n";
}

const GITIGNORE = `.env
.env.local
workspace/
*.log
*.err
node_modules/
`;
