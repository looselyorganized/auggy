/**
 * aug1 create <name> — scaffold a new agent directory with interactive
 * augment selection.
 *
 * Flow:
 *   1. Name from CLI arg
 *   2. Interactive augment selection (required ones pre-checked)
 *   3. Scaffold directory, agent.yaml, identity.md, skills, .env.example
 */

import { existsSync, mkdirSync, writeFileSync, cpSync } from "fs";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import { checkbox } from "@inquirer/prompts";
import { stringify } from "yaml";
import { AUGMENT_CATALOG, type CatalogEntry } from "../augment-catalog";
import { scanSkillManifest, renderSkillManifest } from "../skill-manifest";

export async function runCreate(
  name: string,
  opts: { dir?: string },
): Promise<void> {
  const dir = resolve(opts.dir ?? `./${name}`);

  if (existsSync(dir)) {
    throw new Error(`Directory already exists: ${dir}`);
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
  for (const entry of augments) {
    installAugmentSkill(entry, dir);
    console.log(`  \u2713 ${entry.defaultName} (${entry.type})`);
  }

  // Copy built-in filesystem skill if available and filesystem is selected.
  if (augments.some((e) => e.type === "filesystem")) {
    const fsSkillSrc = resolve(import.meta.dir, "../../augments/filesystem-skill");
    if (existsSync(fsSkillSrc)) {
      cpSync(fsSkillSrc, join(dir, "skills", "filesystem"), { recursive: true });
    }
  }

  // Generate agent.yaml.
  const config = buildAgentYaml(id, name, augments);
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
  const envVars = collectEnvVars(augments);
  writeFileSync(join(dir, ".env.example"), buildEnvExample(envVars));

  // Generate .gitignore.
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);

  console.log();
  console.log(`Agent "${name}" created at ${dir}`);
  console.log();
  console.log("Next:");
  console.log(`  1. cp ${dir}/.env.example ${dir}/.env`);
  console.log(`  2. Add your API keys to ${dir}/.env`);
  console.log(`  3. Edit ${dir}/identity.md`);
  console.log(`  4. aug1 dev ${name}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
): string {
  const config: Record<string, unknown> = {
    id,
    name,
    engine: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
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

function collectEnvVars(augments: CatalogEntry[]): string[] {
  const vars = new Set<string>(["ANTHROPIC_API_KEY"]);
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
