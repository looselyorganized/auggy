/**
 * aug1 add — add augments to an existing agent.
 *
 * Lists currently installed vs available augments. User selects
 * from available. Updates agent.yaml, creates SKILL.md files,
 * updates identity.md manifest.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { checkbox } from "@inquirer/prompts";
import { getAvailableAugments, type CatalogEntry } from "../augment-catalog";
import { scanSkillManifest, renderSkillManifest } from "../skill-manifest";
import { resolveConfigPath } from "../resolve-config";

export async function runAdd(name: string, opts: { config?: string }): Promise<void> {
  const configPath = resolveConfigPath(name, opts.config);
  const agentDir = dirname(configPath);

  // Parse current config.
  const raw = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  const currentAugments = (raw.augments ?? []) as Array<{ type: string; name: string }>;

  console.log(`Currently installed: ${currentAugments.map((a) => a.name).join(", ")}`);

  // Find what's available to add.
  const available = getAvailableAugments(currentAugments);

  if (available.length === 0) {
    console.log("All built-in augments are already installed.");
    return;
  }

  // Interactive selection.
  const selected = await checkbox<CatalogEntry>({
    message: "Select augments to add:",
    choices: available.map((entry) => ({
      name: `${entry.label} — ${entry.description}`,
      value: entry,
    })),
  });

  if (selected.length === 0) {
    console.log("No augments selected.");
    return;
  }

  // Add to agent.yaml.
  for (const entry of selected) {
    currentAugments.push({
      name: entry.defaultName,
      type: entry.type,
      ...({ options: entry.defaultOptions } as Record<string, unknown>),
    } as { type: string; name: string });
  }
  raw.augments = currentAugments;

  writeFileSync(configPath, `# Agent configuration\n\n${stringifyYaml(raw)}`);

  // Install skills.
  console.log();
  for (const entry of selected) {
    installAugmentSkill(entry, agentDir);
    console.log(`  \u2713 ${entry.defaultName} (${entry.type})`);
  }

  // Copy filesystem skill if filesystem was just added.
  if (selected.some((e) => e.type === "filesystem")) {
    const fsSkillSrc = resolve(import.meta.dir, "../../augments/filesystem-skill");
    if (existsSync(fsSkillSrc)) {
      cpSync(fsSkillSrc, join(agentDir, "skills", "filesystem"), { recursive: true });
    }
  }

  // Update identity.md skill manifest.
  // Read up-front so a missing file doesn't race a concurrent process between
  // the existence check and the read (CodeQL js/file-system-race).
  const identityPath = join(agentDir, "identity.md");
  let identity: string | null = null;
  try {
    identity = readFileSync(identityPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (identity !== null) {
    const skillEntries = scanSkillManifest(join(agentDir, "skills"));
    const newManifest = renderSkillManifest(skillEntries);
    const updated = identity.replace(/## Available skills[\s\S]*$/, newManifest);
    if (updated !== identity) {
      writeFileSync(identityPath, updated);
      console.log("  \u2713 Updated identity.md skill manifest");
    }
  }

  // Collect any new env vars needed.
  const newEnvVars = selected.flatMap((e) => e.envVars ?? []);
  if (newEnvVars.length > 0) {
    console.log();
    console.log("Add these to your .env:");
    for (const v of newEnvVars) {
      console.log(`  ${v}=`);
    }
  }

  console.log();
  console.log(`Restart to apply: aug1 restart ${name}`);
}

function installAugmentSkill(entry: CatalogEntry, agentDir: string): void {
  if (!entry.hasSkill || !entry.skillTemplate) return;

  const skillDirName =
    entry.type === "fileMemory" ? "memory" : entry.type === "webFetch" ? "web-fetch" : entry.type;

  const skillDir = join(agentDir, "skills", skillDirName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), entry.skillTemplate);
}
