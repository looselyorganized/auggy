/**
 * aug1 create <name> — scaffold a new agent directory.
 *
 * Default location: ~/.auggy/agents/<name>/. Override with --dir <path>
 * for git-tracked / project-folder layouts. Writes an entry to the
 * agent index (~/.auggy/agents.json) on success.
 *
 * Refuses if:
 *   - CWD contains agent.yaml (operator likely meant `cd ..` first)
 *   - <name> already in the index
 *   - target dir already exists on disk
 */

import { existsSync, mkdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { checkbox, select, input } from "@inquirer/prompts";
import { stringify } from "yaml";
import { AUGMENT_CATALOG, type CatalogEntry } from "../augment-catalog";
import { scanSkillManifest, renderSkillManifest } from "../skill-manifest";
import { addAgent, getAgent } from "../agent-index";
import { getModelChoices, formatChoiceLabel, type Provider } from "../model-picker";

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
const ansi = (code: string, s: string): string => (IS_TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string): string => ansi("1", s);
const dim = (s: string): string => ansi("2", s);
const cream = (s: string): string => ansi("38;2;251;247;235", s);
const green = (s: string): string => ansi("32", s);

export async function runCreate(name: string, opts: { dir?: string }): Promise<void> {
  // Wrong-dir guard: refuse if CWD has agent.yaml.
  const cwdAgentYaml = resolve("./agent.yaml");
  if (existsSync(cwdAgentYaml)) {
    throw new Error(
      `You appear to be inside an agent directory.\n\n` +
        `  Found: ${cwdAgentYaml}\n\n` +
        `Run \`cd ..\` first, or pass --dir <path> to scaffold elsewhere.`,
    );
  }

  // Refuse if name already registered in the index.
  const existing = getAgent(name);
  if (existing) {
    throw new Error(
      `Agent "${name}" already exists at ${existing.localDir}.\n\n` +
        `  Use a different name, or remove the existing one with \`aug1 remove ${name}\`.`,
    );
  }

  // Resolve target directory.
  const dir = opts.dir ? resolve(opts.dir) : join(homedir(), ".auggy", "agents", name);

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

  // Model selection: dropdown of priced models + Custom escape hatch.
  const CUSTOM_SENTINEL = "__custom__";
  const choices = getModelChoices(provider);
  const modelSelection = await select<string>({
    message: "Model:",
    choices: [
      ...choices.map((c) => ({ name: formatChoiceLabel(c), value: c.id })),
      { name: "Custom — type your own model ID", value: CUSTOM_SENTINEL },
    ],
  });

  let model: string;
  if (modelSelection === CUSTOM_SENTINEL) {
    model = await input({ message: "Custom model ID:" });
    printCustomModelWarning(model);
    await Bun.sleep(2000);
  } else {
    model = modelSelection;
  }

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

  // Ensure required augments are included.
  const augments = AUGMENT_CATALOG.filter((e) => e.required);
  for (const entry of selected) {
    if (!augments.includes(entry)) {
      augments.push(entry);
    }
  }

  const id = `aug1_${randomUUID()}`;

  // Scaffold the directory.
  let scaffoldComplete = false;
  try {
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "skills"), { recursive: true });
    mkdirSync(join(dir, "workspace"), { recursive: true });
    mkdirSync(join(dir, "augments"), { recursive: true });

    console.log();
    console.log(dim(" Installing augments..."));
    console.log();
    for (const entry of augments) {
      installAugmentSkill(entry, dir);
      console.log(`   ${green("\u2713")} ${cream(entry.defaultName)} ${dim(`(${entry.type})`)}`);
    }

    if (augments.some((e) => e.type === "filesystem")) {
      const fsSkillSrc = resolve(import.meta.dir, "../../augments/filesystem-skill");
      if (existsSync(fsSkillSrc)) {
        cpSync(fsSkillSrc, join(dir, "skills", "filesystem"), { recursive: true });
      }
    }

    const config = buildAgentYaml(id, name, augments, { provider, model });
    writeFileSync(join(dir, "agent.yaml"), config);

    const skillEntries = scanSkillManifest(join(dir, "skills"));
    const skillManifest = renderSkillManifest(skillEntries);
    writeFileSync(join(dir, "identity.md"), buildIdentity(name, skillManifest));

    if (augments.some((e) => e.defaultName === "learned")) {
      writeFileSync(join(dir, "learned.md"), "");
    }

    const envVars = collectEnvVars(augments, provider);
    writeFileSync(join(dir, ".env.example"), buildEnvExample(envVars));
    writeFileSync(join(dir, ".gitignore"), GITIGNORE);

    scaffoldComplete = true;
  } finally {
    // Best-effort cleanup if scaffolding partially failed.
    if (!scaffoldComplete && existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }

  // Register in the index. If this fails, clean up the scaffolded dir.
  try {
    addAgent(name, dir);
  } catch (err) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    throw err;
  }

  const envVar = PROVIDER_DEFAULTS[provider].envVar;

  console.log();
  console.log(dim(" ─────────────────────────────────────────────"));
  console.log();
  console.log(` ${green("\u2713")} ${bold(cream(`Agent "${name}" created`))}`);
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

function printCustomModelWarning(modelId: string): void {
  console.log();
  console.log(`⚠ Warning: "${modelId}" is not in the pricing table.`);
  console.log();
  console.log(`  - Budgets augment cannot enforce dailyBudgetUsd or maxUsdPerDay for this model.`);
  console.log(`  - Eval cost-per-task tracking will report unpriced.`);
  console.log(`  - Future facility cost rollups will not include this agent.`);
  console.log();
  console.log(`Restore cost tracking by adding engine.costOverride to agent.yaml:`);
  console.log();
  console.log(`  engine:`);
  console.log(`    costOverride:`);
  console.log(`      inputUsdPerMtok: <number>`);
  console.log(`      outputUsdPerMtok: <number>`);
  console.log();
  console.log(`Press Ctrl+C now if this is unintended. Otherwise, continuing in 2s...`);
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
  console.log(` ${bold("augment-1")}  ${dim("·  by the Loosely Organized Research Facility")}`);
  console.log();
  console.log(" Auggy is a modular agent runtime. Agents are composed from");
  console.log(" swappable augments — the kernel manages context, tools,");
  console.log(" permissions, and lifecycle.");
  console.log();
  console.log(dim(" ─────────────────────────────────────────────"));
  console.log();
  console.log(" Let's configure your agent. Start by picking an engine.");
  console.log();
  console.log(dim(" The engine is the LLM provider the kernel calls each turn —"));
  console.log(dim(" one per agent (Anthropic, OpenAI, OpenRouter). Augments plug in"));
  console.log(dim(" around it. Both are swappable later in agent.yaml."));
  console.log();
}

function installAugmentSkill(entry: CatalogEntry, agentDir: string): void {
  if (!entry.hasSkill || !entry.skillTemplate) return;

  // Derive skill directory name from the type.
  const skillDirName =
    entry.type === "fileMemory" ? "memory" : entry.type === "webFetch" ? "web-fetch" : entry.type;

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

function collectEnvVars(augments: CatalogEntry[], provider: Provider): string[] {
  const vars = new Set<string>([PROVIDER_DEFAULTS[provider].envVar]);
  for (const entry of augments) {
    if (entry.envVars) {
      for (const v of entry.envVars) vars.add(v);
    }
  }
  return [...vars];
}

function buildEnvExample(vars: string[]): string {
  const lines = ["# Agent secrets — copy to .env and fill in values.", "# .env is gitignored.", ""];
  for (const v of vars) {
    lines.push(`${v}=`);
  }
  return `${lines.join("\n")}\n`;
}

const GITIGNORE = `.env
.env.local
workspace/
*.log
*.err
node_modules/
`;
