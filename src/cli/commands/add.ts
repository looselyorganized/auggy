/**
 * auggy add — add augments to an existing agent.
 *
 * Lists currently installed vs available augments. User selects from
 * available. Updates agent.yaml, copies bundled `src/augments/<name>/skill/`
 * folders into the agent dir, and refreshes identity.md's skill manifest.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { checkbox } from "@inquirer/prompts";
import { getAvailableAugments, type CatalogEntry } from "../augment-catalog";
import { scanSkillManifest, renderSkillManifest } from "../skill-manifest";
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
  // for each selected augment that ships one. Idempotent.
  console.log();
  for (const entry of selected) {
    copyBundledSkill(entry.type, agentDir);
    console.log(`  ✓ ${entry.defaultName} (${entry.type})`);
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
      console.log("  ✓ Updated identity.md skill manifest");
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
  console.log(`Restart to apply: auggy restart ${name}`);
}
