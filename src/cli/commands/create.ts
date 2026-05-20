/**
 * auggy create <name> — scaffold a new agent directory.
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

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { checkbox, confirm, select, input } from "@inquirer/prompts";
import { stringify } from "yaml";
import { AUGMENT_CATALOG, type CatalogEntry } from "../augment-catalog";
import { copyBundledSkill, renderIdentityFromTemplate } from "../scaffold-skills";
import { addAgent, getAgent } from "../agent-index";
import { getModelChoices, formatChoiceLabel, type Provider } from "../model-picker";
import { buildAgentPackageJson, getAuggyVersion } from "../scaffold-package-json";
import { runBunInstall, type BunInstallSpawnFactory } from "../bun-install";

const PROVIDER_DEFAULTS: Record<Provider, { model: string; envVar: string }> = {
  anthropic: { model: "claude-sonnet-4-6", envVar: "ANTHROPIC_API_KEY" },
  openai: { model: "gpt-5", envVar: "OPENAI_API_KEY" },
  openrouter: {
    model: "anthropic/claude-sonnet-4-6",
    envVar: "OPENROUTER_API_KEY",
  },
  // Ollama is local + free — no API key. Empty `envVar` signals to
  // `collectEnvVars` to skip the provider env-var entry in .env.example
  // (avoids a stray `=` line for a var that doesn't exist).
  ollama: { model: "llama3.2", envVar: "" },
};

/**
 * Default values surfaced when an operator skips the interactive prompts
 * (Ctrl+D, non-TTY stdin, etc.). The operator-name default matches the
 * security-eval test fixture's fallback so non-interactive scaffolding stays
 * compatible with the canonical eval suite (see evals/security/eval-context.ts
 * deriveOperatorName fallback).
 */
/**
 * Env vars the scaffold computes itself — written to `.env` as concrete
 * values, never surfaced to the operator as "fill in this placeholder."
 * The catalog entries that mount these augments still LIST the env vars
 * in their `envVars` arrays (so the agent.yaml's `${VAR}` interpolation
 * still resolves at boot), but the scaffold filters them out of the
 * "operator needs to fill" set since we already populated them.
 */
const AUTO_GENERATED_ENV_VARS = new Set([
  "AUGGY_WEB_TOKEN",
  "AUGGY_AGENT_ID",
  "AUGGY_PUBLIC_URL",
  "VISITOR_SIGNING_KEY",
]);

const DEFAULT_OPERATOR_NAME = "the operator";
const DEFAULT_PURPOSE = "a helpful assistant";
const DEFAULT_ORG_NAME = "Test Org";
const DEFAULT_ORG_PURPOSE = "for testing only";

// ANSI color helpers. Truecolor #FBF7EB ("cream") matches the facility palette.
// Strips to plain text when stdout is not a TTY so piped output stays clean.
const IS_TTY = Boolean(process.stdout.isTTY);
const ansi = (code: string, s: string): string => (IS_TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string): string => ansi("1", s);
const dim = (s: string): string => ansi("2", s);
const cream = (s: string): string => ansi("38;2;251;247;235", s);
const green = (s: string): string => ansi("32", s);

export interface CreateOpts {
  /** Target directory override (defaults to ~/.auggy/agents/<name>/). */
  dir?: string;
  /**
   * Skip the post-scaffold `bun install` step. The agent's `package.json` is
   * still written; the operator can run `bun install` later. Useful for CI,
   * offline scaffolding, and tests.
   */
  skipInstall?: boolean;
  /**
   * Test seam: inject a custom `bun install` subprocess factory. Production
   * callers omit this and the helper uses the real `Bun.spawn`.
   */
  bunInstallSpawn?: BunInstallSpawnFactory;
  /**
   * Test seam: override `~/.auggy/` for index reads/writes. Production
   * callers omit. Mirrors `IndexOptions.auggyDir` on `agent-index.ts`.
   */
  auggyDir?: string;
}

export async function runCreate(name: string, opts: CreateOpts): Promise<void> {
  // Wrong-dir guard: refuse if CWD has agent.yaml. Skip when --dir is provided
  // (operator has explicitly chosen the target, so CWD is irrelevant).
  if (!opts.dir) {
    const cwdAgentYaml = resolve("./agent.yaml");
    if (existsSync(cwdAgentYaml)) {
      throw new Error(
        `You appear to be inside an agent directory.\n\n` +
          `  Found: ${cwdAgentYaml}\n\n` +
          `Run \`cd ..\` first, or pass --dir <path> to scaffold elsewhere.`,
      );
    }
  }

  // Refuse if name already registered in the index.
  const existing = getAgent(name, { auggyDir: opts.auggyDir });
  if (existing) {
    throw new Error(
      `Agent "${name}" already exists at ${existing.localDir}.\n\n` +
        `  Use a different name, or remove the existing one with \`auggy remove ${name}\`.`,
    );
  }

  // Resolve target directory.
  const finalDir = opts.dir ? resolve(opts.dir) : join(homedir(), ".auggy", "agents", name);

  // Orphan-detection guard (lifecycle F3 fix): when the final dir exists but
  // is NOT in the index, that's a leftover from a prior aborted scaffold or
  // an externally-created directory. Today we'd just error "Directory already
  // exists" with no way forward; instead, prompt to delete + recreate so
  // operators have an in-CLI recovery path.
  if (existsSync(finalDir)) {
    const deleteAndContinue = await confirm({
      message: `Found orphan dir at ${finalDir} (not in agents.json).\n  Delete and start fresh?`,
      default: true,
    });
    if (!deleteAndContinue) {
      throw new Error(
        `Directory already exists: ${finalDir}\n\n` +
          `  Keep it: pick a different agent name.\n` +
          `  Remove it: \`auggy remove ${name} --force\`.`,
      );
    }
    rmSync(finalDir, { recursive: true, force: true });
  }

  // Transactional scaffold (lifecycle F1 fix): write everything to a tempdir
  // sibling, then atomic-rename to `finalDir` at the end. Process kill mid-
  // scaffold leaves a `.tmp-<uuid>` orphan that's distinguishable and
  // garbage-collectable (auggy reconcile handles cleanup). The window
  // between the rename and the index write is one syscall + a few lines —
  // any death there leaves an orphan finalDir that the F3 guard above
  // recovers on the next `auggy create`.
  const tempDir = `${finalDir}.tmp-${randomUUID()}`;
  // For test isolation, the local `dir` variable refers to the tempdir
  // during scaffold and the finalDir after rename. Downstream code (printout,
  // next-steps) uses `finalDir`.
  const dir = tempDir;

  printWelcome();

  // Interactive engine selection.
  const provider = await select<Provider>({
    message: "Engine provider:",
    choices: [
      { name: "anthropic — Claude models", value: "anthropic" },
      { name: "openai — GPT models", value: "openai" },
      { name: "openrouter — any model via OpenRouter", value: "openrouter" },
      { name: "ollama — local LLM (no API key, runs offline)", value: "ollama" },
    ],
    default: "anthropic",
  });

  // Ollama-specific: ask whether it runs locally or against a remote host.
  // Local: default to http://localhost:11434, no auth.
  // Remote: prompt URL + optional bearer-token env var (Ollama Cloud / gated
  // self-hosted proxies use Authorization: Bearer).
  let ollamaBaseURL: string | undefined;
  let ollamaNeedsBearer = false;
  if (provider === "ollama") {
    const ollamaMode = await select<"local" | "remote">({
      message: "Where does Ollama run?",
      choices: [
        { name: "Local (http://localhost:11434, no auth)", value: "local" },
        {
          name: "Remote / Cloud (custom URL, optional bearer)",
          value: "remote",
        },
      ],
      default: "local",
    });
    if (ollamaMode === "remote") {
      ollamaBaseURL = await input({
        message: "Ollama URL (e.g. https://ollama.example.com):",
      });
      if (!ollamaBaseURL || !/^https?:\/\//.test(ollamaBaseURL)) {
        throw new Error(
          `Invalid Ollama URL: ${JSON.stringify(ollamaBaseURL)}. Must start with http:// or https://`,
        );
      }
      ollamaNeedsBearer = await confirm({
        message: "Does the remote Ollama require a bearer token? (Ollama Cloud + gated proxies do)",
        default: true,
      });
    }
  }

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
    const proceed = await confirm({
      message: "Continue with unpriced model? Budget caps will not enforce.",
      default: false,
    });
    if (!proceed) {
      throw new Error(
        "Aborted by operator. Pick a priced model or add `engine.costOverride` to agent.yaml after scaffolding.",
      );
    }
  } else {
    model = modelSelection;
  }

  // Operator + purpose prompts. Used to populate identity.md security rules
  // (operator-name reference) and the agent.yaml `operators[]` array.
  const operatorName = await input({
    message: "Operator name (your name; appears in identity.md security rule):",
    default: DEFAULT_OPERATOR_NAME,
  });
  const purpose = await input({
    message: "Agent purpose (one sentence):",
    default: DEFAULT_PURPOSE,
  });

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

  // Conditional org prompts — only ask when orgContext is selected.
  const orgContextSelected = augments.some((e) => e.type === "orgContext");
  let orgName = DEFAULT_ORG_NAME;
  let orgPurpose = DEFAULT_ORG_PURPOSE;
  if (orgContextSelected) {
    orgName = await input({
      message: "Org name:",
      default: DEFAULT_ORG_NAME,
    });
    orgPurpose = await input({
      message: "Org purpose (one sentence):",
      default: DEFAULT_ORG_PURPOSE,
    });
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
      // Copy bundled skill folder if the augment has one — overrides any
      // legacy inline skillTemplate from the catalog. Idempotent.
      copyBundledSkill(entry.type, dir);
      console.log(`   ${green("✓")} ${cream(entry.defaultName)} ${dim(`(${entry.type})`)}`);
    }

    const config = buildAgentYaml(id, name, augments, {
      provider,
      model,
      operatorName,
      purpose,
      ollamaBaseURL,
    });
    writeFileSync(join(dir, "agent.yaml"), config);

    // Per ADR-030: identity.md no longer carries a skill manifest. The
    // runtime `skills` augment surfaces the listing from disk.
    writeFileSync(
      join(dir, "identity.md"),
      renderIdentityFromTemplate({
        agentName: name,
        purpose,
        operatorName,
      }),
    );

    if (augments.some((e) => e.defaultName === "learned")) {
      writeFileSync(join(dir, "learned.md"), "");
    }

    // Scaffold an example org-context/ directory when orgContext is selected
    // (per spec §Decision 9). The orgContext augment's file:// scheme support
    // (α-6) lets this work without standing up an HTTP server.
    if (orgContextSelected) {
      writeOrgContextExample(dir, { orgName, orgPurpose, operatorName });
    }

    // Build .env with both auto-generated values AND empty placeholders for
    // env vars the operator still needs to fill. Auto-gen drops the "fill 7
    // env vars before booting" friction operators hit in 0.4.3.
    //
    // Auto-generated at scaffold time:
    //   AUGGY_WEB_TOKEN      → 32 random hex bytes (the agent's bearer)
    //   VISITOR_SIGNING_KEY  → 32 random hex bytes (HMAC for visitor tokens)
    //   AUGGY_AGENT_ID       → agent name (anti-replay binding default)
    //   AUGGY_PUBLIC_URL     → http://localhost:<webTransport.port>
    //
    // The rest of the env vars (provider API key when applicable, augment-
    // specific creds) stay as empty `=` lines for the operator to fill.
    const placeholderEnvVars = collectEnvVars(augments, provider).filter(
      (v) => !AUTO_GENERATED_ENV_VARS.has(v),
    );
    if (ollamaNeedsBearer) placeholderEnvVars.push("OLLAMA_API_KEY");

    const autoGenLines: string[] = [];
    if (augments.some((e) => e.type === "webTransport")) {
      autoGenLines.push(`AUGGY_WEB_TOKEN=${randomBytes(32).toString("hex")}`);
      autoGenLines.push(`AUGGY_AGENT_ID=${name}`);
      const webTransportEntry = augments.find((e) => e.type === "webTransport");
      const port =
        (webTransportEntry?.defaultOptions as { port?: number } | undefined)?.port ?? 8080;
      autoGenLines.push(`AUGGY_PUBLIC_URL=http://localhost:${port}`);
    }
    if (augments.some((e) => e.type === "visitorAuth")) {
      autoGenLines.push(`VISITOR_SIGNING_KEY=${randomBytes(32).toString("hex")}`);
    }

    writeFileSync(join(dir, ".env"), buildEnv(autoGenLines, placeholderEnvVars));
    writeFileSync(join(dir, ".gitignore"), GITIGNORE);

    // Per-agent package.json — the engine adapter + auggy + any per-augment
    // packageDeps. Required for the runtime to resolve via importFromAgent.
    // See `src/cli/scaffold-package-json.ts` for the build contract.
    const auggyVersion = getAuggyVersion();
    writeFileSync(
      join(dir, "package.json"),
      buildAgentPackageJson({
        agentName: name,
        auggyVersion,
        provider,
        augments,
      }),
    );

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

  // SIGINT handler scoped to the post-scaffold/pre-index window.
  // After atomic rename, both tempDir and finalDir may exist — clean both
  // best-effort. SIGTERM also covered (lifecycle F2 fix): operators closing
  // a terminal session send SIGHUP/SIGTERM, not SIGINT.
  const sigintHandler = (): void => {
    for (const p of [tempDir, finalDir]) {
      if (existsSync(p)) {
        try {
          rmSync(p, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    }
    console.log();
    console.log("Aborted. Cleaned up partially-scaffolded directory.");
    process.exit(130); // 128 + SIGINT(2)
  };
  process.once("SIGINT", sigintHandler);
  process.once("SIGTERM", sigintHandler);
  process.once("SIGHUP", sigintHandler);

  // Atomic rename: tempDir → finalDir. Single syscall. After this point the
  // scaffold lives at its operator-visible path. If anything fails between
  // here and the addAgent below, the orphan is at finalDir — recovered on
  // the next `auggy create` via the F3 guard above OR via `auggy remove --force`.
  try {
    renameSync(tempDir, finalDir);
  } catch (err) {
    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGTERM", sigintHandler);
    process.removeListener("SIGHUP", sigintHandler);
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    throw new Error(`Failed to install scaffolded agent at ${finalDir}: ${(err as Error).message}`);
  }

  // Register in the index. If this fails, clean up the finalDir (it's now
  // an orphan that the F3 guard can recover, but cleaning eagerly is friendlier).
  try {
    addAgent(name, finalDir, { auggyDir: opts.auggyDir });
  } catch (err) {
    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGTERM", sigintHandler);
    process.removeListener("SIGHUP", sigintHandler);
    try {
      rmSync(finalDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    throw err;
  }
  process.removeListener("SIGINT", sigintHandler);
  process.removeListener("SIGTERM", sigintHandler);
  process.removeListener("SIGHUP", sigintHandler);

  // bun install — populates <dir>/node_modules so `auggy dev` can resolve
  // the engine + augment packages. Skipped under --skip-install; the
  // operator can run `cd <dir> && bun install` themselves.
  //
  // Fail-soft: a failed install leaves the scaffolded dir AND the index
  // entry intact. The package manager has touched node_modules at this
  // point; an auto-rollback would surprise the operator more than the
  // partial state. Print the exact retry command and continue.
  let installOk = true;
  if (!opts.skipInstall) {
    console.log();
    console.log(dim(" Installing dependencies..."));
    console.log();
    const result = await runBunInstall(finalDir, opts.bunInstallSpawn);
    installOk = result.ok;
    if (!installOk) {
      console.log();
      console.log(`⚠ bun install failed in ${finalDir} (exit ${result.code}).`);
      console.log(`  Scaffolding is on disk and registered in the index.`);
      console.log(`  Retry:  cd ${finalDir} && bun install`);
      console.log(`  Then:   auggy dev ${name}`);
      console.log();
    }
  }

  console.log();
  console.log(dim(" ─────────────────────────────────────────────"));
  console.log();
  console.log(` ${green("✓")} ${bold(cream(`Agent "${name}" created`))}`);
  console.log(`   ${dim(finalDir)}`);
  console.log();
  console.log(` ${bold("Next steps:")}`);
  console.log();
  let step = 1;
  if (opts.skipInstall) {
    console.log(`   ${cream(`${step++}.`)}  cd ${finalDir} && bun install`);
  } else if (!installOk) {
    console.log(
      `   ${cream(`${step++}.`)}  cd ${finalDir} && bun install   ${dim("(retry — earlier attempt failed)")}`,
    );
  }
  // Env-vars step: only render when there's actually a secret left for the
  // operator to fill. Auto-generated vars (AUGGY_WEB_TOKEN, VISITOR_SIGNING_KEY,
  // etc.) are written to .env directly by the scaffold and excluded here.
  const envVarsForNextSteps = collectEnvVars(augments, provider).filter(
    (v) => !AUTO_GENERATED_ENV_VARS.has(v),
  );
  if (ollamaNeedsBearer) envVarsForNextSteps.push("OLLAMA_API_KEY");
  if (envVarsForNextSteps.length > 0) {
    console.log(
      `   ${cream(`${step++}.`)}  Fill in ${dir}/.env  ${dim(`(${envVarsForNextSteps.join(", ")})`)}`,
    );
  }
  console.log(`   ${cream(`${step++}.`)}  Edit ${dir}/identity.md   ${dim("(optional)")}`);
  console.log(`   ${cream(`${step++}.`)}  auggy dev ${name}`);
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
  console.log(`Confirm at the next prompt to proceed, or decline to abort.`);
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

function buildAgentYaml(
  id: string,
  name: string,
  augments: CatalogEntry[],
  engine: {
    provider: Provider;
    model: string;
    operatorName: string;
    purpose: string;
    ollamaBaseURL?: string;
  },
): string {
  const engineBlock: Record<string, unknown> = {
    provider: engine.provider,
    model: engine.model,
    maxContextTokens: 200000,
    maxTokens: 4096,
  };
  // Remote Ollama: pin the baseURL so the engine resolver points at the
  // operator-supplied host instead of localhost. Local Ollama leaves
  // baseURL unset → engine adapter uses its built-in default.
  if (engine.provider === "ollama" && engine.ollamaBaseURL) {
    engineBlock.baseURL = engine.ollamaBaseURL;
  }

  const config: Record<string, unknown> = {
    id,
    name,
    purpose: engine.purpose,
    operators: [engine.operatorName],
    // identity shorthand — synthesizes the fileMemory@system entry at parse
    // time (per α-5). Operators wanting non-default options should drop the
    // shorthand and add an explicit fileMemory augment instead.
    identity: "./identity.md",
    engine: engineBlock,
    settings: {
      compactionStrategy: "truncate",
      maxInferenceLoops: 10,
    },
    augments: augments.map((entry) => {
      const options = layeredMemoryNamespaceFor(entry, name) ?? entry.defaultOptions;
      return {
        name: entry.defaultName,
        type: entry.type,
        options,
      };
    }),
  };

  return `# Agent configuration\n\n${stringify(config)}`;
}

/**
 * For a layeredMemory catalog entry, substitute the agent name for the
 * placeholder namespace so each scaffolded agent gets its own logical
 * storage namespace out of the box. Returns `null` for non-layeredMemory
 * entries so the caller can fall back to defaults.
 */
function layeredMemoryNamespaceFor(
  entry: CatalogEntry,
  agentName: string,
): Record<string, unknown> | null {
  if (entry.type !== "layeredMemory") return null;
  return { ...entry.defaultOptions, namespace: agentName };
}

function collectEnvVars(augments: CatalogEntry[], provider: Provider): string[] {
  const vars = new Set<string>();
  // Skip empty envVar (ollama has no provider API key — no env var to add).
  const providerEnvVar = PROVIDER_DEFAULTS[provider].envVar;
  if (providerEnvVar) vars.add(providerEnvVar);
  for (const entry of augments) {
    if (entry.envVars) {
      for (const v of entry.envVars) vars.add(v);
    }
  }
  return [...vars];
}

/**
 * Compose the agent's `.env` from auto-generated lines (concrete values
 * the scaffold knows) + placeholder env vars (operator still needs to
 * fill). The auto-gen section lands first so casual readers see
 * "everything is set" before the empty-equals lines below.
 */
function buildEnv(autoGenLines: string[], placeholderVars: string[]): string {
  const lines = ["# Agent secrets — gitignored.", ""];
  if (autoGenLines.length > 0) {
    lines.push("# Auto-generated at scaffold time:");
    for (const l of autoGenLines) lines.push(l);
    lines.push("");
  }
  if (placeholderVars.length > 0) {
    lines.push("# Fill these in before booting:");
    for (const v of placeholderVars) lines.push(`${v}=`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Write a minimal example `org-context/` directory the orgContext augment
 * can read with `baseUrl: file://./org-context` (α-6). Lets the operator
 * see the augment work end-to-end without standing up an HTTP service.
 */
function writeOrgContextExample(
  agentDir: string,
  values: { orgName: string; orgPurpose: string; operatorName: string },
): void {
  const orgDir = join(agentDir, "org-context");
  mkdirSync(orgDir, { recursive: true });

  const manifest = {
    org: values.orgName,
    purpose: values.orgPurpose,
    operator: values.operatorName,
    phase: "active",
    endpoints: [
      { path: "/mission", description: "Org mission and active focus" },
      { path: "/team", description: "People and roles" },
    ],
  };
  writeFileSync(join(orgDir, "manifest"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(orgDir, "mission.md"),
    `# ${values.orgName} — Mission\n\n${values.orgPurpose}\n`,
  );
  writeFileSync(
    join(orgDir, "team.md"),
    `# ${values.orgName} — Team\n\n- ${values.operatorName} (operator)\n`,
  );
  writeFileSync(
    join(orgDir, "README.md"),
    `# Org context (example)\n\nThis directory backs the orgContext augment via the\n\`baseUrl: file://./org-context\` config in agent.yaml.\n\n- \`manifest\` — JSON listing endpoints the augment exposes\n- \`mission.md\`, \`team.md\` — endpoint targets the manifest references\n\nReplace these files with your real org content, or change \`baseUrl\` in\n\`agent.yaml\` to point at an HTTP-served manifest if you'd rather host\nyour org context elsewhere.\n`,
  );
}

const GITIGNORE = `.env
.env.local
workspace/
*.log
*.err
node_modules/
memory.sqlite
memory.sqlite-journal
memory.sqlite-wal
memory.sqlite-shm
memory.db
memory.db-journal
memory.db-wal
memory.db-shm
budgets.db
budgets.db-journal
budgets.db-wal
budgets.db-shm
`;
