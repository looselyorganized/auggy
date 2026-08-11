/**
 * Implementation for `auggy augment add`.
 *
 * Lists currently installed vs available augments. User selects from
 * available. Updates agent.yaml, writes augments/<id>/augment.yaml, and copies
 * bundled `src/augments/<name>/skill/` folders into the agent dir. Per ADR-030
 * the skill listing is owned by the runtime's 'skills' augment surface, NOT
 * injected into identity.md — so no identity-file rewrite happens.
 * here. The model picks up new skills automatically because the 'skills'
 * augment rescans its mounted dir at every context() call.
 */

import { existsSync, readFileSync } from "node:fs";
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
import { writeFileSafely } from "../safe-write";
import { acquireAgentEnvMutationLock } from "../env-mutation-lock";
import { errorLabel, infoLabel } from "../_shared/styles";
import { isWellFormedEmail } from "../../augments/visitorAuth/email-validation";
import { formatAgentMailSetupResult, runAgentMailSetup } from "./agentmail";

export interface AddOpts {
  /** Path override for agent.yaml. */
  config?: string;
  /** Optional non-interactive augment specifier(s) (type, default name, or alias). */
  augment?: string | string[];
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
  /** Skip preview confirmation and optional post-add setup prompts. */
  yes?: boolean;
  /** Test seam: override whether post-install setup prompts are shown. */
  interactive?: boolean;
  /** Test seam: inject the post-install setup confirmation prompt. */
  confirmSetup?: (message: string, defaultValue: boolean) => Promise<boolean>;
  /** Test seam: inject AgentMail setup without reaching the provider. */
  runAgentMailSetup?: typeof runAgentMailSetup;
}

export async function runAdd(target: string | undefined, opts: AddOpts): Promise<void> {
  const localConfig = join(opts.cwd ?? process.cwd(), "agent.yaml");
  const requestedAugments = requestedAugmentList(opts.augment);
  const useProjectLocalArg =
    !opts.config && requestedAugments.length === 0 && !!target && existsSync(localConfig);
  const configPath = resolveConfigPath(useProjectLocalArg ? undefined : target, opts.config, {
    auggyDir: opts.auggyDir,
    cwd: opts.cwd,
  });
  const name = target && !useProjectLocalArg ? target : readAgentName(configPath);
  const selectedAugments = useProjectLocalArg ? [target] : requestedAugments;
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

  const selected =
    selectedAugments.length > 0
      ? resolveNonInteractiveSelection(selectedAugments, available)
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
    console.error(`\`auggy create ${name}\`, then re-run \`auggy augment add\`.`);
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
  const envMutationLease = selected.some((entry) => (entry.envVars?.length ?? 0) > 0)
    ? acquireAgentEnvMutationLock(agentDir)
    : undefined;
  let envUpdate: ReturnType<typeof updateEnvForAddedAugments>;
  try {
    writeFileSafely(configPath, newYaml);

    if (pkgUpdate) {
      writeFileSafely(pkgPath, pkgUpdate.text);
      console.log();
      console.log(
        `  ${pkgUpdate.added.length} package dep${pkgUpdate.added.length === 1 ? "" : "s"} added to package.json:`,
      );
      for (const pkg of pkgUpdate.added) {
        console.log(`    + ${pkg}@${additions[pkg]}`);
      }
    }

    envUpdate = updateEnvForAddedAugments(agentDir, selected, raw);
  } finally {
    envMutationLease?.release();
  }

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
    console.log("  - Run setup: auggy augment setup agentMail");
    console.log(
      "  - Or set AGENTMAIL_API_KEY, AGENTMAIL_INBOX_ID, and AGENTMAIL_INBOX_EMAIL in .env",
    );
    console.log("  - Configure mail policy in augments/agentMail/augment.yaml");
    console.log("  - Default mode: outbound email only, creator trust required");
    console.log("  - For simple operator alerts, notify + Agent Mail is usually simpler");
  }

  if (visitorAuthAdded) {
    console.log();
    console.log("Use visitorAuth:");
    console.log("  - Local testing uses console magic links");
    console.log("  - Production email: auggy augment setup visitorAuth");
    console.log(
      "  - This configures the supplied AgentMail key and updates augments/visitorAuth/augment.yaml",
    );
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
    console.log("  - Configured bearers authenticate the immediate forwarding agent");
    console.log("  - Delegated authority is cryptographically capped at the caller's trust");
    console.log("  - Public outbound delegation is disabled by default");
    console.log("  - Public use also requires a publicDelegationPeers endpoint/id attestation");
    console.log("  - Rotate each peer bearer separately");
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

  // Generated local values do not depend on an optional provider setup.
  if (envUpdate.generated.length > 0) {
    console.log();
    console.log("Generated local .env values:");
    for (const v of envUpdate.generated) {
      console.log(`  ${v}`);
    }
  }

  let setupOk = true;
  if (installOk) {
    setupOk = await offerSetupForAddedAugments(selected, currentAugments, configPath, opts);
  }

  // Setup can resolve placeholders written during the add. Report only values
  // that are still unresolved after the complete post-add flow.
  const unresolvedPlaceholders = unresolvedEnvVars(agentDir, envUpdate.placeholders);
  if (unresolvedPlaceholders.length > 0) {
    console.log();
    console.log("Add these to your .env:");
    for (const v of unresolvedPlaceholders) {
      console.log(`  ${v}=`);
    }
  }

  if (!installOk || !setupOk) return;

  console.log();
  if (opts.skipInstall && pkgUpdate) {
    console.log(`Run \`cd ${displayPath(agentDir, opts.cwd)} && bun install\`.`);
  }
  const agentMailInstalled =
    agentMailAdded || currentAugments.some((augment) => augment.type === "agentMail");
  if (agentMailInstalled && !hasAgentMailRuntimeCredentials(agentDir)) {
    console.log(
      `${infoLabel()} agentMail is installed, but its required credentials are unresolved.`,
    );
    console.log("     Before starting or restarting the agent, choose one:");
    console.log("       - Configure it: `auggy augment setup agentMail`");
    console.log("       - Remove it: `auggy augment remove agentMail`");
    return;
  }
  console.log(formatApplyInstructions(name, agentDir, opts.cwd));
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

async function offerSetupForAddedAugments(
  selected: CatalogEntry[],
  previouslyInstalled: InstalledAugment[],
  configPath: string,
  opts: AddOpts,
): Promise<boolean> {
  if (opts.yes || !(opts.interactive ?? process.stdin.isTTY)) return true;

  const addedAgentMail = selected.some((entry) => entry.type === "agentMail");
  const addedVisitorAuth = selected.some((entry) => entry.type === "visitorAuth");
  if (!addedAgentMail && !addedVisitorAuth) return true;

  const hadAgentMail = previouslyInstalled.some((entry) => entry.type === "agentMail");
  const hadVisitorAuth = previouslyInstalled.some((entry) => entry.type === "visitorAuth");
  const agentDir = dirname(configPath);
  const setup = opts.runAgentMailSetup ?? runAgentMailSetup;

  const ask = async (
    message: string,
    defaultValue: boolean,
    cancellationRecovery: readonly string[],
  ): Promise<boolean | null> => {
    try {
      return opts.confirmSetup
        ? await opts.confirmSetup(message, defaultValue)
        : await confirm({ message, default: defaultValue });
    } catch (error) {
      if (!isPromptCancellation(error)) throw error;
      process.exitCode = 1;
      console.error();
      console.error(
        `${errorLabel({ color: Boolean(process.stderr.isTTY) })} AgentMail post-add setup was cancelled.`,
      );
      for (const line of cancellationRecovery) console.error(`      ${line}`);
      return null;
    }
  };

  const runSetup = async (target: "agentMail" | "visitorAuth", mode?: "env"): Promise<boolean> => {
    try {
      const result = await setup(
        target,
        { config: configPath, ...(mode ? { mode } : {}) },
        { cwd: opts.cwd },
      );
      console.log();
      console.log(formatEmbeddedAgentMailSetupResult(result));
      return true;
    } catch (err) {
      process.exitCode = 1;
      console.error();
      console.error(
        `${errorLabel({ color: Boolean(process.stderr.isTTY) })} AgentMail setup did not complete: ${(err as Error).message}`,
      );
      console.error(`      Local ${target} install is still applied.`);
      console.error(
        `      Retry when ready: auggy augment setup ${target}${mode === "env" ? " --mode env" : ""}`,
      );
      console.error(
        "      Do not restart the agent until setup succeeds or the augment is removed.",
      );
      return false;
    }
  };

  const explainConsoleFallback = () => {
    console.log();
    console.log(`${infoLabel()} visitorAuth will use local console delivery for magic links.`);
    console.log("     Set up AgentMail later: `auggy augment setup visitorAuth`.");
  };

  // A batch containing both consumers is one shared setup operation regardless
  // of picker/argument order: configure agentMail first, then attach
  // visitorAuth to the same API key and inbox without another credential prompt.
  if (addedAgentMail && addedVisitorAuth) {
    const proceed = await ask(
      "Set up one shared AgentMail inbox for agentMail and visitorAuth now?",
      true,
      [
        "Both augments remain installed, but agentMail credentials are unresolved.",
        "Before restarting, run:",
        "  auggy augment setup agentMail",
        "  auggy augment setup visitorAuth --mode env",
        "Or remove agentMail if this agent should not use email.",
      ],
    );
    if (proceed === null) return false;
    if (!proceed) {
      explainConsoleFallback();
      return true;
    }
    if (!(await runSetup("agentMail"))) return false;
    return runSetup("visitorAuth", "env");
  }

  if (addedVisitorAuth) {
    const proceed = await ask("Set up AgentMail delivery for visitorAuth magic links now?", false, [
      "visitorAuth remains installed with local console delivery.",
      "Configure production delivery later: auggy augment setup visitorAuth",
    ]);
    if (proceed === null) return false;
    if (!proceed) {
      explainConsoleFallback();
      return true;
    }

    if (hadAgentMail) {
      // Reuse an already-configured consumer directly. If agentMail is only
      // installed, configure it first and then attach visitorAuth.
      if (!hasAgentMailRuntimeCredentials(agentDir) && !(await runSetup("agentMail"))) return false;
      return runSetup("visitorAuth", "env");
    }
    return runSetup("visitorAuth");
  }

  const visitorAlreadyUsesAgentMail = hadVisitorAuth && visitorAuthUsesAgentMail(agentDir);
  const proceed = await ask(
    visitorAlreadyUsesAgentMail
      ? "Use visitorAuth's AgentMail inbox for agentMail too?"
      : "Set up AgentMail inbox credentials now?",
    true,
    [
      "agentMail remains installed, but its required credentials are unresolved.",
      `Before restarting, run: auggy augment setup agentMail${visitorAlreadyUsesAgentMail ? " --mode env" : ""}`,
      "Or remove it: auggy augment remove agentMail",
    ],
  );
  if (proceed === null) return false;
  if (!proceed) return true;
  if (!(await runSetup("agentMail", visitorAlreadyUsesAgentMail ? "env" : undefined))) return false;

  // Adding agentMail beside an existing console-only visitorAuth is a useful
  // opportunity to share the new inbox, but remains an explicit policy change.
  if (hadVisitorAuth && !visitorAlreadyUsesAgentMail) {
    const attach = await ask("Use this AgentMail inbox for visitorAuth magic links too?", true, [
      "agentMail is configured; visitorAuth remains on local console delivery.",
      "Attach it later: auggy augment setup visitorAuth --mode env",
    ]);
    if (attach === null) return false;
    if (attach) return runSetup("visitorAuth", "env");
    explainConsoleFallback();
  }
  return true;
}

function formatEmbeddedAgentMailSetupResult(
  result: Awaited<ReturnType<typeof runAgentMailSetup>>,
): string {
  // The standalone setup command owns its own "Run" footer. During a batch
  // add, that footer would tell the operator to start the agent before the
  // second shared consumer has been attached. runAdd prints one final apply
  // block only after the entire orchestration succeeds.
  return formatAgentMailSetupResult(result).split("\n\nRun:\n", 1)[0]!;
}

function readEnvValues(agentDir: string): Map<string, string> {
  const envPath = join(agentDir, ".env");
  if (!existsSync(envPath)) return new Map();
  const values = new Map<string, string>();
  for (const line of parseEnvFile(readFileSync(envPath, "utf-8"))) {
    if (line.kind !== "kv" || values.has(line.key) || line.value.trim().length === 0) continue;
    values.set(line.key, line.value);
  }
  return values;
}

function hasAgentMailRuntimeCredentials(agentDir: string): boolean {
  const env = readEnvValues(agentDir);
  const apiKey = resolvedEnvValue(env.get("AGENTMAIL_API_KEY"));
  const inboxId = resolvedEnvValue(env.get("AGENTMAIL_INBOX_ID"));
  const inboxEmail = resolvedEnvValue(env.get("AGENTMAIL_INBOX_EMAIL"));
  return (
    apiKey !== null && inboxId !== null && inboxEmail !== null && isWellFormedEmail(inboxEmail)
  );
}

function resolvedEnvValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || /^\$\{[A-Z0-9_]+\}$/.test(trimmed)) return null;
  return trimmed;
}

function unresolvedEnvVars(agentDir: string, candidates: string[]): string[] {
  const env = readEnvValues(agentDir);
  return candidates.filter((key) => (env.get(key)?.trim().length ?? 0) === 0);
}

function visitorAuthUsesAgentMail(agentDir: string): boolean {
  const augmentPath = join(agentDir, "augments", "visitorAuth", "augment.yaml");
  if (!existsSync(augmentPath)) return false;
  const metadata = parseYaml(readFileSync(augmentPath, "utf-8"));
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const config = (metadata as Record<string, unknown>).config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  const agentMail = (config as Record<string, unknown>).agentMail;
  if (!agentMail || typeof agentMail !== "object" || Array.isArray(agentMail)) return false;
  return (agentMail as Record<string, unknown>).transport !== "console";
}

function isPromptCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "ExitPromptError";
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
    if (current && current.value.trim().length > 0 && key !== "AUGGY_AGENT_ID") continue;

    const generatedValue = AUTO_GENERATED_ADD_ENV_VARS.has(key)
      ? generateEnvValueForAdd(key, agentDir, rawConfig)
      : null;
    if (generatedValue && current?.value !== generatedValue) {
      upsertEnvLine(lines, existing, key, generatedValue);
      generated.push(key);
    } else if (!current || current.value.trim().length === 0) {
      upsertEnvLine(lines, existing, key, "");
      placeholders.push(key);
    }
  }

  writeFileSafely(envPath, serializeEnv(lines), { mode: 0o600 });
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
      return typeof rawConfig.id === "string" && rawConfig.id.trim() ? rawConfig.id.trim() : null;
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

function requestedAugmentList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => item.trim()).filter(Boolean);
}

function resolveNonInteractiveSelection(
  specifiers: string[],
  available: CatalogEntry[],
): CatalogEntry[] {
  const selected: CatalogEntry[] = [];
  const seen = new Set<string>();

  for (const specifier of specifiers) {
    const entry = resolveCatalogEntry(specifier);
    if (!entry) {
      throw new Error(
        `Unknown augment "${specifier}". Valid augment names: ${validAugmentSpecifiers().join(", ")}`,
      );
    }

    if (seen.has(entry.type)) {
      console.log(`Augment "${entry.defaultName}" (${entry.type}) was requested more than once.`);
      continue;
    }
    seen.add(entry.type);

    const isAvailable = available.some(
      (candidate) => candidate.type === entry.type && candidate.defaultName === entry.defaultName,
    );
    if (!isAvailable) {
      console.log(`Augment "${entry.defaultName}" (${entry.type}) is already installed.`);
      continue;
    }

    selected.push(entry);
  }

  return selected;
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
