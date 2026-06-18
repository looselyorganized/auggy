/**
 * auggy add — shortcut for auggy augment add.
 *
 * Lists currently installed vs available augments. User selects from
 * available. Updates agent.yaml, writes augments/<id>/augment.yaml, and copies
 * bundled `src/augments/<name>/skill/` folders into the agent dir. Per ADR-030
 * the skill listing is owned by the runtime's 'skills' augment surface, NOT
 * injected into identity.md — so no identity-file rewrite happens.
 * here. The model picks up new skills automatically because the 'skills'
 * augment rescans its mounted dir at every context() call.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { checkbox, confirm, Separator } from "@inquirer/prompts";
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
import {
  augmentIdForCatalogEntry,
  writeBuiltinAugmentMetadata,
  writeCustomAugmentsReadme,
} from "../augment-metadata";
import { writeKnowledgeScaffold } from "../scaffold-knowledge";
import { displayPath } from "../display-path";
import { ensureMcpConfig } from "../mcp-config";

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
  if (!Array.isArray(raw.augments)) raw.augments = [];
  const currentAugments = readInstalledAugments(raw, agentDir);

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
        message: "Select augments to add",
        pageSize: 12,
        choices: buildAddChoices(available),
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
    (raw.augments as unknown[]).push(augmentIdForCatalogEntry(entry));
  }
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
  let agentMailAdded = false;
  let mcpAdded = false;
  let layeredMemoryAdded = false;
  let telegramTransportAdded = false;
  let visitorAuthAdded = false;
  let linkAdded = false;
  let bashAdded = false;
  let budgetsAdded = false;
  for (const entry of selected) {
    const skillCopied = copyBundledSkill(entry.type, agentDir);
    writeBuiltinAugmentMetadata(agentDir, entry, optionsForAddedAugment(entry, name));
    if (entry.type === "knowledge") {
      writeKnowledgeScaffold(agentDir, knowledgeValues(raw, agentDir));
      knowledgeAdded = true;
    }
    if (entry.type === "notify") {
      notifyAdded = true;
    }
    if (entry.type === "agentMail") {
      agentMailAdded = true;
    }
    if (entry.type === "mcp") {
      ensureMcpConfig(agentDir);
      mcpAdded = true;
    }
    if (entry.type === "layeredMemory") {
      layeredMemoryAdded = true;
    }
    if (entry.type === "telegramTransport") {
      telegramTransportAdded = true;
    }
    if (entry.type === "visitorAuth") {
      visitorAuthAdded = true;
    }
    if (entry.type === "link") {
      linkAdded = true;
    }
    if (entry.type === "bash") {
      bashAdded = true;
    }
    if (entry.type === "budgets") {
      budgetsAdded = true;
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
    console.log("  - For real delivery, edit augments/notify/augment.yaml");
    console.log("  - Telegram alerts need a notify destination with botToken + chatId");
    console.log("  - Supported transports: webhook, Telegram, Agent Mail, log-to-file");
  }

  if (agentMailAdded) {
    console.log();
    console.log("Use AgentMail:");
    console.log("  - Set AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID in .env");
    console.log("  - Configure mail policy in augments/agentMail/augment.yaml");
    console.log("  - Default mode: outbound email only, creator trust required");
    console.log("  - For simple operator alerts, notify + Agent Mail is usually simpler");
  }

  if (visitorAuthAdded) {
    console.log();
    console.log("Use visitorAuth:");
    console.log("  - Local testing uses console magic links");
    console.log("  - Production email: auggy agentmail setup visitorAuth");
    console.log("  - This provisions AgentMail and updates augments/visitorAuth/augment.yaml");
  }

  if (layeredMemoryAdded) {
    console.log();
    console.log("Use layeredMemory:");
    console.log("  - Stores peer-scoped memory in data/memory.db");
    console.log("  - Recent memory is added to context automatically on future turns");
    console.log("  - Ask the agent to remember stable preferences or commitments");
    console.log("  - Auto-extraction is off by default; explicit memory_write is active now");
  }

  if (budgetsAdded) {
    console.log();
    console.log("Use budgets (preview):");
    console.log("  - Budgets are runtime spend guardrails, not billing control");
    console.log("  - USD caps are post-hoc soft caps and can overshoot by one turn");
    console.log("  - Configure provider-side hard spend caps for unattended agents");
    console.log("  - SQLite budgets are single-process and single-replica");
    console.log("  - No built-in retention/purge policy yet");
  }

  if (mcpAdded) {
    console.log();
    console.log("Add MCP servers:");
    console.log("  - Config file: .mcp.json");
    console.log("  - Add a server: auggy mcp add-json <name> '<json>'");
    console.log("  - Check setup: auggy mcp doctor");
    console.log("  - Cloud agents need remote HTTP MCP, or local stdio marked cloud: disabled");
  }

  if (telegramTransportAdded) {
    console.log();
    console.log("Use Telegram:");
    console.log("  - This enables Telegram chat with the agent");
    console.log("  - Set TELEGRAM_BOT_TOKEN in .env");
    console.log("  - Set TELEGRAM_CREATOR_USER_IDS in .env (comma-separated numeric user IDs)");
    console.log("  - Default inbound mode: polling");
    console.log("  - Find your Telegram user ID with @userinfobot");
    console.log("  - Proactive Telegram alerts are configured in augments/notify/augment.yaml");
    console.log("  - For production webhooks, edit augments/telegramTransport/augment.yaml");
  }

  if (linkAdded) {
    console.log();
    console.log("Use link (preview):");
    console.log("  - Link opens a peer-to-peer A2A listener on its own port");
    console.log("  - Configured inbound peers are admitted as agent trust");
    console.log("  - Bearer possession is the authority boundary; rotate peer bearers separately");
    console.log(
      "  - Do not use link for public or reduced-privilege peers until granular trust lands",
    );
    console.log("  - Review augments/link/augment.yaml before exposing the port");
  }

  if (bashAdded) {
    console.log();
    console.log("Use bash (preview):");
    console.log("  - Bash runs host processes; it is not a sandbox");
    console.log("  - Default install is restricted to echo, ls, cat, pwd, and date");
    console.log("  - Bash tools are creator-only by default");
    console.log("  - Do not expose bash to public or agent peers without explicit trust policy");
    console.log("  - Review augments/bash/augment.yaml before relying on it in production");
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
    case "budgets":
      return "runtime soft caps are post-hoc; provider hard caps are still required";
    case "bash":
      return "host process execution is not sandboxing; keep command allowlists tight";
    case "link":
      return "peer bearers grant agent trust; reduced-privilege peer auth is not ready";
    case "mcp":
      return "external tool servers require deliberate trust, auth, and cloud transport setup";
    default:
      return "production DX is still being hardened";
  }
}

type AddChoice = {
  name: string;
  short: string;
  description: string;
  value: CatalogEntry;
};

export function buildAddChoices(available: CatalogEntry[]): Array<AddChoice | Separator> {
  const stable = available.filter((entry) => entry.stability === "stable");
  const preview = available.filter((entry) => entry.stability === "preview");
  const width = Math.max(0, ...available.map((entry) => entry.defaultName.length));
  const choices: Array<AddChoice | Separator> = [];

  if (stable.length > 0) {
    choices.push(new Separator("-- Stable --"));
    choices.push(...stable.map((entry) => toAddChoice(entry, width)));
  }

  if (preview.length > 0) {
    if (choices.length > 0) choices.push(new Separator());
    choices.push(new Separator("-- Preview: deliberate setup --"));
    choices.push(...preview.map((entry) => toAddChoice(entry, width)));
  }

  return choices;
}

function toAddChoice(entry: CatalogEntry, width: number): AddChoice {
  const badge = entry.stability === "preview" ? "[preview]" : "         ";
  return {
    name: `${entry.defaultName.padEnd(width)}  ${badge}  ${entry.tagline}`,
    short: entry.defaultName,
    description: entry.description,
    value: entry,
  };
}

interface InstalledAugment {
  name: string;
  type: string;
}

function readInstalledAugments(raw: Record<string, unknown>, agentDir: string): InstalledAugment[] {
  const augments = raw.augments;
  if (!Array.isArray(augments)) return [];

  return augments.map((entry) => {
    if (typeof entry === "string") {
      const metadata = readAugmentMetadata(agentDir, entry);
      return {
        name: entry,
        type: stringField(metadata.type) ?? entry,
      };
    }

    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const type = stringField(record.type) ?? "custom";
      return {
        name: stringField(record.name) ?? type,
        type,
      };
    }

    return { name: "(invalid)", type: "(invalid)" };
  });
}

function readAugmentMetadata(agentDir: string, id: string): Record<string, unknown> {
  const metadataPath = join(agentDir, "augments", id, "augment.yaml");
  if (!existsSync(metadataPath)) {
    throw new Error(`Augment "${id}" is listed in agent.yaml but ${metadataPath} is missing.`);
  }
  const parsed = parseYaml(readFileSync(metadataPath, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${metadataPath}: not a valid YAML object.`);
  }
  return parsed as Record<string, unknown>;
}

function optionsForAddedAugment(
  entry: CatalogEntry,
  agentName: string,
): Record<string, unknown> | undefined {
  const options =
    entry.type === "layeredMemory"
      ? { ...entry.defaultOptions, namespace: agentName }
      : entry.defaultOptions;
  if (!options || Object.keys(options).length === 0) return undefined;
  return rewriteMutablePaths(options) as Record<string, unknown>;
}

function rewriteMutablePaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteMutablePaths(item));
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "path" && child === "./workspace") {
      out[key] = "./data/workspace";
      continue;
    }
    if (typeof child === "string" && isMutableArtifactPath(key, child)) {
      out[key] = `./data/${basename(child)}`;
      continue;
    }
    out[key] = rewriteMutablePaths(child);
  }
  return out;
}

function isMutableArtifactPath(key: string, value: string): boolean {
  if (!value.startsWith("./")) return false;
  if (!/(Path|path)$/.test(key)) return false;
  return /\.(db|sqlite|jsonl)$/.test(value);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function knowledgeValues(raw: Record<string, unknown>, agentDir: string) {
  const name =
    typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : nameForEnv(agentDir);
  const purpose =
    typeof raw.purpose === "string" && raw.purpose.trim()
      ? raw.purpose.trim()
      : "project knowledge for this agent";
  const creatorName = readCreatorDisplayName(raw) ?? "the creator";
  return {
    orgName: name,
    orgPurpose: purpose,
    creatorName,
  };
}

function readCreatorDisplayName(raw: Record<string, unknown>): string | null {
  const creator = raw.creator;
  if (typeof creator !== "object" || creator === null || Array.isArray(creator)) return null;
  const value = (creator as Record<string, unknown>).displayName;
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
      return `http://localhost:${findWebTransportPort(rawConfig, agentDir) ?? 8080}`;
    case "AUGGY_WEB_TOKEN":
      return randomBytes(32).toString("hex");
    case "VISITOR_SIGNING_KEY":
      return randomBytes(32).toString("hex");
    default:
      return null;
  }
}

function findWebTransportPort(rawConfig: Record<string, unknown>, agentDir: string): number | null {
  const augments = rawConfig.augments;
  if (!Array.isArray(augments)) return null;
  for (const aug of augments) {
    if (typeof aug === "string") {
      if (aug !== "webTransport") continue;
      const metadata = readAugmentMetadata(agentDir, aug);
      const config = metadata.config;
      if (!config || typeof config !== "object" || Array.isArray(config)) continue;
      const port = (config as Record<string, unknown>).port;
      if (typeof port === "number" && Number.isInteger(port) && port > 0) return port;
      continue;
    }
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
