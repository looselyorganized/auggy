/**
 * auggy add — add augments to an existing agent.
 *
 * Lists currently installed vs available augments. User selects from
 * available. Updates agent.yaml and copies bundled
 * `src/augments/<name>/skill/` folders into the agent dir. Per ADR-030
 * the skill listing is owned by the runtime's 'skills' augment surface,
 * NOT injected into identity.md — so no identity-file rewrite happens
 * here. The model picks up new skills automatically because the 'skills'
 * augment rescans its mounted dir at every context() call.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { checkbox } from "@inquirer/prompts";
import { getAvailableAugments, type CatalogEntry } from "../augment-catalog";
import { copyBundledSkill } from "../scaffold-skills";
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

  // Install skills — copy the bundled `src/augments/<name>/skill/` folder
  // for each selected augment that ships one. Idempotent. Per ADR-030 the
  // 'skills' augment surfaces them to the model automatically by rescanning
  // the skills/ dir on every context() call; no identity.md edit needed.
  console.log();
  for (const entry of selected) {
    copyBundledSkill(entry.type, agentDir);
    console.log(`  ✓ ${entry.defaultName} (${entry.type})`);
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
  console.log(`Restart to apply: auggy restart ${name}`);
}
