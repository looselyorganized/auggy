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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { checkbox } from "@inquirer/prompts";
import { getAvailableAugments, type CatalogEntry } from "../augment-catalog";
import { copyBundledSkill } from "../scaffold-skills";
import { resolveConfigPath } from "../resolve-config";
import { mergePackageDeps } from "../scaffold-package-json";
import { runBunInstall, type BunInstallSpawnFactory } from "../bun-install";

export interface AddOpts {
  /** Path override for agent.yaml. */
  config?: string;
  /**
   * Skip the post-mutation `bun install` step. The agent's `package.json` is
   * still updated; the operator can run `bun install` later.
   */
  skipInstall?: boolean;
  /** Test seam: inject a custom `bun install` subprocess factory. */
  bunInstallSpawn?: BunInstallSpawnFactory;
  /** Test seam: override `~/.auggy/` for index reads. */
  auggyDir?: string;
}

export async function runAdd(name: string, opts: AddOpts): Promise<void> {
  const configPath = resolveConfigPath(name, opts.config, { auggyDir: opts.auggyDir });
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

  // Merge per-augment packageDeps into the agent's package.json + install.
  // Skipped silently if no selected augment carries packageDeps. Required
  // for augments like `link` (needs @auggy/link) or `supabaseMemory` (needs
  // @supabase/supabase-js) to actually resolve at runtime via importFromAgent.
  let installOk = true;
  const additions = mergeAdditions(selected);
  if (Object.keys(additions).length > 0) {
    const pkgPath = join(agentDir, "package.json");
    if (!existsSync(pkgPath)) {
      // Pre-v0.3.2 agent dirs have no package.json. The boot-time migration
      // (commands/dev.ts) handles this — but `auggy add` shouldn't silently
      // succeed without doing what was asked. Surface clearly + exit.
      console.log();
      console.log(
        `Error: ${pkgPath} does not exist. This agent predates per-agent package manifests.`,
      );
      console.log(`Run \`auggy dev ${name}\` once first to trigger the boot-time migration,`);
      console.log(`then re-run \`auggy add ${name}\`.`);
      process.exitCode = 1;
      return;
    }
    const existingText = readFileSync(pkgPath, "utf-8");
    const merged = mergePackageDeps(existingText, additions);

    if (merged.added.length > 0) {
      writeFileSync(pkgPath, merged.text);
      console.log();
      console.log(`  ${merged.added.length} package dep${merged.added.length === 1 ? "" : "s"} added to package.json:`);
      for (const pkg of merged.added) {
        console.log(`    + ${pkg}@${additions[pkg]}`);
      }

      if (!opts.skipInstall) {
        console.log();
        console.log(" Installing dependencies...");
        console.log();
        const result = await runBunInstall(agentDir, opts.bunInstallSpawn);
        installOk = result.ok;
        if (!installOk) {
          console.log();
          console.log(`⚠ bun install failed in ${agentDir} (exit ${result.code}).`);
          console.log(`  agent.yaml + package.json are already updated.`);
          console.log(`  Retry:  cd ${agentDir} && bun install`);
          console.log();
          process.exitCode = 1;
        }
      }
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
  if (opts.skipInstall && Object.keys(additions).length > 0) {
    console.log(`Run \`cd ${agentDir} && bun install\`, then \`auggy restart ${name}\`.`);
  } else if (installOk) {
    console.log(`Restart to apply: auggy restart ${name}`);
  }
}

/**
 * Flatten each selected catalog entry's `packageDeps` into a single
 * additions map. Later entries override earlier ones on duplicate keys —
 * the catalog has no collisions today; this is the simplest policy.
 */
function mergeAdditions(selected: CatalogEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of selected) {
    if (!entry.packageDeps) continue;
    for (const [pkg, range] of Object.entries(entry.packageDeps)) {
      out[pkg] = range;
    }
  }
  return out;
}
