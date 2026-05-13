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

  // === Preflight (atomicity gate, §13.3) ===
  // Compute which external npm packages this add would introduce. If any,
  // verify the agent dir has a `package.json` BEFORE touching disk —
  // pre-v0.3.2 agents must migrate first via `auggy dev` (Phase 6). Bailing
  // here leaves agent.yaml + skills unchanged so the operator can retry
  // after migration without first rolling back partial mutations.
  const additions = mergeAdditions(selected);
  const hasAdditions = Object.keys(additions).length > 0;
  const pkgPath = join(agentDir, "package.json");

  if (hasAdditions && !existsSync(pkgPath)) {
    console.log();
    console.log(
      `Error: ${pkgPath} does not exist. This agent has no per-agent manifest.`,
    );
    console.log(`Re-scaffold via \`auggy create ${name}\` (or write package.json manually with`);
    console.log("auggy + your engine adapter as deps, then run `bun install`), then re-run");
    console.log(`\`auggy add ${name}\`.`);
    console.log();
    console.log("(No changes made to agent.yaml — atomic bail.)");
    process.exitCode = 1;
    return;
  }

  // === Compute all changes in memory ===
  // Yaml + package.json text are built without touching disk so a preflight
  // error (e.g. invalid JSON in the existing package.json) can abort before
  // any persisted mutation.
  for (const entry of selected) {
    currentAugments.push({
      name: entry.defaultName,
      type: entry.type,
      ...({ options: entry.defaultOptions } as Record<string, unknown>),
    } as { type: string; name: string });
  }
  raw.augments = currentAugments;
  const newYaml = `# Agent configuration\n\n${stringifyYaml(raw)}`;

  let pkgUpdate: { text: string; added: string[] } | null = null;
  if (hasAdditions) {
    const existingText = readFileSync(pkgPath, "utf-8");
    const merged = mergePackageDeps(existingText, additions);
    if (merged.added.length > 0) {
      pkgUpdate = { text: merged.text, added: merged.added };
    }
  }

  // === Persist: yaml → package.json → skills (in sequence) ===
  // The legacy-bail above guards against partial-state on pre-v0.3.2 dirs.
  // Past this point, all three artifacts are intentional mutations matching
  // the operator's request; install-failure below leaves them in place.
  writeFileSync(configPath, newYaml);

  if (pkgUpdate) {
    writeFileSync(pkgPath, pkgUpdate.text);
    console.log();
    console.log(
      `  ${pkgUpdate.added.length} package dep${pkgUpdate.added.length === 1 ? "" : "s"} added to package.json:`,
    );
    for (const pkg of pkgUpdate.added) {
      console.log(`    + ${pkg}@${additions[pkg]}`);
    }
  }

  // Install skills — copy the bundled `src/augments/<name>/skill/` folder
  // for each selected augment that ships one. Idempotent. Per ADR-030 the
  // 'skills' augment surfaces them to the model automatically by rescanning
  // the skills/ dir on every context() call; no identity.md edit needed.
  console.log();
  for (const entry of selected) {
    copyBundledSkill(entry.type, agentDir);
    console.log(`  ✓ ${entry.defaultName} (${entry.type})`);
  }

  // === Run bun install (last; failure leaves intentional partial state) ===
  // Yaml + package.json mutations represent the operator's request and
  // stay on disk regardless of install outcome. A transient install failure
  // (network, registry) is recovered by re-running `bun install` — not by
  // rolling back the config the operator just asked for.
  let installOk = true;
  if (pkgUpdate && !opts.skipInstall) {
    console.log();
    console.log(" Installing dependencies...");
    console.log();
    const result = await runBunInstall(agentDir, opts.bunInstallSpawn);
    installOk = result.ok;
    if (!installOk) {
      console.log();
      console.log(`⚠ bun install failed in ${agentDir} (exit ${result.code}).`);
      console.log("  agent.yaml + package.json are already updated.");
      console.log(`  Retry:  cd ${agentDir} && bun install`);
      console.log();
      process.exitCode = 1;
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
  if (opts.skipInstall && pkgUpdate) {
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
