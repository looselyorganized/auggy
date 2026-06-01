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
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { checkbox, confirm } from "@inquirer/prompts";
import {
  getAvailableAugments,
  resolveCatalogEntry,
  validAugmentSpecifiers,
  type CatalogEntry,
} from "../augment-catalog";
import { copyBundledSkill } from "../scaffold-skills";
import { readAgentName, resolveConfigPath } from "../resolve-config";
import { mergePackageDeps } from "../scaffold-package-json";
import { runBunInstall, type BunInstallSpawnFactory } from "../bun-install";
import { parseEnvFile, serializeEnv, type EnvLine } from "../env-parse";
import { writeBuiltinAugmentMetadata, writeCustomAugmentsReadme } from "../augment-metadata";
import { writeKnowledgeScaffold } from "../scaffold-knowledge";
import { displayPath } from "../display-path";

export interface AddOpts {
  /** Path override for agent.yaml. */
  config?: string;
  /** Optional non-interactive augment specifier (type, default name, or alias). */
  augment?: string;
  /**
   * Skip the post-mutation `bun install` step. The agent's `package.json` is
   * still updated; the operator can run `bun install` later.
   */
  skipInstall?: boolean;
  /** Test seam: inject a custom `bun install` subprocess factory. */
  bunInstallSpawn?: BunInstallSpawnFactory;
  /** Test seam: override `~/.auggy/` for index reads. */
  auggyDir?: string;
  /** Test seam: override process.cwd() for project-local resolution. */
  cwd?: string;
  /** Skip preview augment confirmation prompts. */
  yes?: boolean;
}

export async function runAdd(target: string | undefined, opts: AddOpts): Promise<void> {
  const localConfig = join(opts.cwd ?? process.cwd(), "agent.yaml");
  const useProjectLocalArg = !opts.config && !opts.augment && !!target && existsSync(localConfig);
  const configPath = resolveConfigPath(useProjectLocalArg ? undefined : target, opts.config, {
    auggyDir: opts.auggyDir,
    cwd: opts.cwd,
  });
  const name = target && !useProjectLocalArg ? target : readAgentName(configPath);
  const selectedAugment = useProjectLocalArg ? target : opts.augment;
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

  const selected = selectedAugment
    ? resolveNonInteractiveSelection(selectedAugment, available)
    : await checkbox<CatalogEntry>({
        message: "Select augments to add:",
        choices: available.map((entry) => ({
          name: `${entry.label}${entry.stability === "preview" ? " (preview)" : ""} - ${entry.description}`,
          value: entry,
        })),
      });

  if (selected.length === 0) {
    console.log("No augments selected.");
    return;
  }

  const proceed = await confirmPreviewAugments(selected, opts.yes);
  if (!proceed) {
    console.log("No changes made.");
    return;
  }

  // === Preflight (atomicity gate, §13.3) ===
  // Compute which external npm packages this add would introduce. If any,
  // verify the agent dir has a `package.json` BEFORE touching disk. Bailing
  // here leaves agent.yaml + skills unchanged so the operator can fix the
  // project scaffold without first rolling back partial mutations.
  const additions = mergeAdditions(selected);
  const hasAdditions = Object.keys(additions).length > 0;
  const pkgPath = join(agentDir, "package.json");

  if (hasAdditions && !existsSync(pkgPath)) {
    // Route this to stderr — it's an error condition (matched by the
    // process.exitCode = 1 below), so operators piping stdout/stderr to
    // different sinks see it on the right stream. Matches the convention
    // for thrown errors at src/cli/index.ts.
    console.error();
    console.error(
      `Error: ${displayPath(pkgPath, opts.cwd)} does not exist. This is not a complete Auggy agent project.`,
    );
    console.error("Run `auggy init` in this directory, or create a fresh project with");
    console.error(`\`auggy create ${name}\`, then re-run \`auggy add\`.`);
    console.error();
    console.error("(No changes made to agent.yaml — atomic bail.)");
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
  // The package.json preflight above guards against partial-state on invalid
  // agent project dirs.
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

  const envUpdate = updateEnvForAddedAugments(agentDir, selected, raw);

  // Install skills — copy the bundled `src/augments/<name>/skill/` folder
  // for each selected augment that ships one. Idempotent. Per ADR-030 the
  // 'skills' augment surfaces them to the model automatically by rescanning
  // the skills/ dir on every context() call; no identity.md edit needed.
  console.log();
  writeCustomAugmentsReadme(agentDir);
  let knowledgeAdded = false;
  let notifyAdded = false;
  let telegramTransportAdded = false;
  for (const entry of selected) {
    const skillCopied = copyBundledSkill(entry.type, agentDir);
    writeBuiltinAugmentMetadata(agentDir, entry);
    if (entry.type === "knowledge") {
      writeKnowledgeScaffold(agentDir, knowledgeValues(raw, agentDir));
      knowledgeAdded = true;
    }
    if (entry.type === "notify") {
      notifyAdded = true;
    }
    if (entry.type === "telegramTransport") {
      telegramTransportAdded = true;
    }
    console.log(`  ✓ ${entry.defaultName} (${entry.type})`);
    if (skillCopied) {
      console.log(
        `    skill: ${displayPath(join(agentDir, "skills", entry.type), opts.cwd)}/SKILL.md`,
      );
    }
  }

  if (knowledgeAdded) {
    console.log();
    console.log("Knowledge scaffold:");
    console.log(`  ${displayPath(join(agentDir, "knowledge", "local", "manifest"), opts.cwd)}`);
    console.log(`  ${displayPath(join(agentDir, "knowledge", "local", "mission.md"), opts.cwd)}`);
    console.log(`  ${displayPath(join(agentDir, "knowledge", "local", "context.md"), opts.cwd)}`);
    console.log();
    console.log("Add knowledge:");
    console.log("  - Edit, rename, or delete the starter markdown files");
    console.log("  - Add more markdown files under knowledge/local/");
    console.log("  - Add each file as an endpoint in knowledge/local/manifest");
    console.log("  - Add API-backed sources in knowledge/sources.json");
  }

  if (notifyAdded) {
    console.log();
    console.log("Use notify:");
    console.log("  - Default destination: creator -> ./notifications.jsonl");
    console.log("  - Ask the agent to notify creator when something needs attention");
    console.log("  - For real delivery, edit notify.destinations in agent.yaml");
    console.log("  - Supported transports: webhook, Telegram, Agent Mail, log-to-file");
  }

  if (telegramTransportAdded) {
    console.log();
    console.log("Use Telegram:");
    console.log("  - Set TELEGRAM_BOT_TOKEN in .env");
    console.log("  - Set TELEGRAM_CREATOR_USER_IDS in .env (comma-separated numeric user IDs)");
    console.log("  - Default inbound mode: polling");
    console.log("  - Find your Telegram user ID with @userinfobot");
    console.log(
      "  - For production webhooks, switch telegramTransport.inbound to webhook in agent.yaml",
    );
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
      console.log(
        `⚠ bun install failed in ${displayPath(agentDir, opts.cwd)} (exit ${result.code}).`,
      );
      console.log("  agent.yaml + package.json are already updated.");
      console.log(`  Retry:  cd ${displayPath(agentDir, opts.cwd)} && bun install`);
      console.log();
      process.exitCode = 1;
    }
  }

  // Collect any new env vars needed.
  if (envUpdate.placeholders.length > 0) {
    console.log();
    console.log("Add these to your .env:");
    for (const v of envUpdate.placeholders) {
      console.log(`  ${v}=`);
    }
  }
  if (envUpdate.generated.length > 0) {
    console.log();
    console.log("Generated local .env values:");
    for (const v of envUpdate.generated) {
      console.log(`  ${v}`);
    }
  }

  console.log();
  if (opts.skipInstall && pkgUpdate) {
    console.log(`Run \`cd ${displayPath(agentDir, opts.cwd)} && bun install\`.`);
    console.log(formatApplyInstructions(name, agentDir, opts.cwd));
  } else if (installOk) {
    console.log(formatApplyInstructions(name, agentDir, opts.cwd));
  }
}

async function confirmPreviewAugments(selected: CatalogEntry[], yes: boolean | undefined) {
  const preview = selected.filter((entry) => entry.stability === "preview");
  if (preview.length === 0 || yes) return true;

  console.log();
  console.log("Preview augment selected:");
  for (const entry of preview) {
    console.log(`  - ${entry.defaultName}: ${previewCaveat(entry)}`);
  }
  return confirm({
    message:
      "Preview augments are available for testing, but their v1.0 production surface is still being hardened. Proceed?",
    default: false,
  });
}

function previewCaveat(entry: CatalogEntry): string {
  switch (entry.type) {
    case "visitorAuth":
      return "identity, token, and production email flows need deliberate setup";
    case "budgets":
      return "spend-limit behavior needs more production soak";
    case "layeredMemory":
      return "long-term memory semantics and storage choices are still being hardened";
    case "link":
      return "agent-to-agent networking has more edge cases to test";
    case "agentMail":
      return "email delivery and policy controls need production hardening";
    default:
      return "production DX is still being hardened";
  }
}

function knowledgeValues(raw: Record<string, unknown>, agentDir: string) {
  const name =
    typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : nameForEnv(agentDir);
  const purpose =
    typeof raw.purpose === "string" && raw.purpose.trim()
      ? raw.purpose.trim()
      : "project knowledge for this agent";
  const operatorName = readFirstOperator(raw) ?? "the operator";
  return {
    orgName: name,
    orgPurpose: purpose,
    operatorName,
  };
}

function readFirstOperator(raw: Record<string, unknown>): string | null {
  if (!Array.isArray(raw.operators)) return null;
  for (const candidate of raw.operators) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function formatApplyInstructions(name: string, agentDir: string, cwd: string | undefined): string {
  const localConfig = join(cwd ?? process.cwd(), "agent.yaml");
  const projectLocal = existsSync(localConfig) && dirname(localConfig) === agentDir;
  const runCommand = projectLocal ? "auggy run" : `auggy run ${name}`;
  return [
    "Apply changes:",
    `  - Foreground: Ctrl-C, then \`${runCommand}\`.`,
    `  - Background: \`auggy restart ${name}\`.`,
  ].join("\n");
}

const AUTO_GENERATED_ADD_ENV_VARS = new Set([
  "AUGGY_AGENT_ID",
  "AUGGY_PUBLIC_URL",
  "AUGGY_WEB_TOKEN",
  "VISITOR_SIGNING_KEY",
]);

function updateEnvForAddedAugments(
  agentDir: string,
  selected: CatalogEntry[],
  rawConfig: Record<string, unknown>,
): { generated: string[]; placeholders: string[] } {
  const requiredEnvVars = unique(selected.flatMap((entry) => entry.envVars ?? []));
  if (requiredEnvVars.length === 0) return { generated: [], placeholders: [] };

  const envPath = join(agentDir, ".env");
  const lines: EnvLine[] = existsSync(envPath)
    ? parseEnvFile(readFileSync(envPath, "utf-8"))
    : [{ kind: "comment", raw: "# Agent secrets — gitignored." }, { kind: "blank" }];

  const existing = new Map<string, { index: number; value: string }>();
  lines.forEach((line, index) => {
    if (line.kind === "kv") existing.set(line.key, { index, value: line.value });
  });

  const generated: string[] = [];
  const placeholders: string[] = [];

  for (const key of requiredEnvVars) {
    const current = existing.get(key);
    if (current && current.value.trim().length > 0) continue;

    const generatedValue = AUTO_GENERATED_ADD_ENV_VARS.has(key)
      ? generateEnvValueForAdd(key, agentDir, rawConfig)
      : null;
    if (generatedValue) {
      upsertEnvLine(lines, existing, key, generatedValue);
      generated.push(key);
    } else {
      upsertEnvLine(lines, existing, key, "");
      placeholders.push(key);
    }
  }

  writeFileSync(envPath, serializeEnv(lines));
  return { generated, placeholders };
}

function upsertEnvLine(
  lines: EnvLine[],
  existing: Map<string, { index: number; value: string }>,
  key: string,
  value: string,
): void {
  const current = existing.get(key);
  if (current) {
    lines[current.index] = { kind: "kv", key, value, raw: `${key}=${value}` };
    existing.set(key, { index: current.index, value });
    return;
  }
  lines.push({ kind: "kv", key, value, raw: `${key}=${value}` });
  existing.set(key, { index: lines.length - 1, value });
}

function generateEnvValueForAdd(
  key: string,
  agentDir: string,
  rawConfig: Record<string, unknown>,
): string | null {
  switch (key) {
    case "AUGGY_AGENT_ID":
      return typeof rawConfig.name === "string" && rawConfig.name.trim()
        ? rawConfig.name.trim()
        : nameForEnv(agentDir);
    case "AUGGY_PUBLIC_URL":
      return `http://localhost:${findWebTransportPort(rawConfig) ?? 8080}`;
    case "AUGGY_WEB_TOKEN":
      return randomBytes(32).toString("hex");
    case "VISITOR_SIGNING_KEY":
      return randomBytes(32).toString("hex");
    default:
      return null;
  }
}

function findWebTransportPort(rawConfig: Record<string, unknown>): number | null {
  const augments = rawConfig.augments;
  if (!Array.isArray(augments)) return null;
  for (const aug of augments) {
    if (!aug || typeof aug !== "object") continue;
    const record = aug as Record<string, unknown>;
    if (record.type !== "webTransport") continue;
    const options = record.options;
    if (!options || typeof options !== "object" || Array.isArray(options)) continue;
    const port = (options as Record<string, unknown>).port;
    if (typeof port === "number" && Number.isInteger(port) && port > 0) return port;
  }
  return null;
}

function nameForEnv(agentDir: string): string {
  return agentDir.split(/[\\/]/).filter(Boolean).at(-1) ?? "auggy";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function resolveNonInteractiveSelection(
  specifier: string,
  available: CatalogEntry[],
): CatalogEntry[] {
  const entry = resolveCatalogEntry(specifier);
  if (!entry) {
    throw new Error(
      `Unknown augment "${specifier}". Valid augment names: ${validAugmentSpecifiers().join(", ")}`,
    );
  }

  const isAvailable = available.some(
    (candidate) => candidate.type === entry.type && candidate.defaultName === entry.defaultName,
  );
  if (!isAvailable) {
    console.log(`Augment "${entry.defaultName}" (${entry.type}) is already installed.`);
    return [];
  }

  return [entry];
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
