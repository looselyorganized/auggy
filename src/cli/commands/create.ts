/**
 * auggy create <name> — scaffold a standalone agent project at `./<name>/`.
 *
 * Atomicity: the scaffold writes into a sibling `.tmp-<uuid>/` dir and lifts
 * it into place with a single `renameSync` at the end. If the process dies
 * mid-scaffold, the tempdir is left behind next to the intended project dir.
 *
 * Refuses if:
 *   - <name>/agent.yaml already exists at the canonical path
 */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { checkbox, confirm, select, input } from "@inquirer/prompts";
import { stringify } from "yaml";
import { AUGMENT_CATALOG, type CatalogEntry } from "../augment-catalog";
import { copyBundledSkill, renderIdentityFromTemplate } from "../scaffold-skills";
import { getModelChoices, formatChoiceLabel, type Provider } from "../model-picker";
import {
  listInstalledOllamaModels,
  partitionByRecommended,
  RECOMMENDED_FIRST_PULL,
} from "../ollama-discover";
import { buildAgentPackageJson, getAuggyVersion } from "../scaffold-package-json";
import { runBunInstall, type BunInstallSpawnFactory } from "../bun-install";
import { withEscRestart, WizardRestartRequested } from "../wizard-restart";

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
 * Env vars the scaffold computes itself — written to `.env` as concrete
 * values, never surfaced to the operator as "fill in this placeholder."
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
  /** Deprecated test seam retained for older tests; create no longer uses ~/.auggy. */
  auggyDir?: string;
  /** Test seam: override process.cwd(). */
  cwd?: string;
}

interface WizardAnswers {
  provider: Provider;
  model: string;
  operatorName: string;
  purpose: string;
  augments: CatalogEntry[];
  orgName: string;
  orgPurpose: string;
  manifestSelected: boolean;
  ollamaBaseURL: string | undefined;
  ollamaNeedsBearer: boolean;
}

/**
 * Drive the interactive wizard. Returns the collected answers on success.
 * Pressing Esc at any prompt throws `WizardRestartRequested`; the caller
 * catches that and re-invokes this fn.
 *
 * Each prompt is wrapped in `withEscRestart(ctx => prompt(config, ctx))`
 * so the keypress listener lives only for the duration of the call. The
 * lazy thunk preserves ESM live-binding of the prompt imports (tests
 * replace `@inquirer/prompts` via `mock.module`).
 */
async function runWizard(): Promise<WizardAnswers> {
  // Interactive engine selection.
  const provider = await withEscRestart((ctx) =>
    select<Provider>(
      {
        message: "Engine provider:",
        choices: [
          { name: "anthropic — Claude models", value: "anthropic" },
          { name: "openai — GPT models", value: "openai" },
          { name: "openrouter — any model via OpenRouter", value: "openrouter" },
          { name: "ollama — local LLM (Qwen, Llama, & more)", value: "ollama" },
        ],
        default: "anthropic",
      },
      ctx,
    ),
  );

  // Ollama-specific: ask whether it runs locally or against a remote host.
  let ollamaBaseURL: string | undefined;
  let ollamaNeedsBearer = false;
  if (provider === "ollama") {
    const ollamaMode = await withEscRestart((ctx) =>
      select<"local" | "remote">(
        {
          message: "Where does Ollama run?",
          choices: [
            { name: "Local (http://localhost:11434, no auth)", value: "local" },
            {
              name: "Remote / Cloud (custom URL, optional bearer)",
              value: "remote",
            },
          ],
          default: "local",
        },
        ctx,
      ),
    );
    if (ollamaMode === "remote") {
      ollamaBaseURL = await withEscRestart((ctx) =>
        input(
          {
            message: "Ollama URL (e.g. https://ollama.example.com):",
          },
          ctx,
        ),
      );
      if (!ollamaBaseURL || !/^https?:\/\//.test(ollamaBaseURL)) {
        throw new Error(
          `Invalid Ollama URL: ${JSON.stringify(ollamaBaseURL)}. Must start with http:// or https://`,
        );
      }
      ollamaNeedsBearer = await withEscRestart((ctx) =>
        confirm(
          {
            message:
              "Does the remote Ollama require a bearer token? (Ollama Cloud + gated proxies do)",
            default: true,
          },
          ctx,
        ),
      );
    }
  }

  // Model selection: dropdown of priced models + Custom escape hatch.
  //
  // For ollama-local, discover what's installed on the box (`ollama list`)
  // and offer those first; the curated fallback is only shown if discovery
  // turns up nothing tool-capable. See `ollama-discover.ts` for the rules
  // and the BFCL-evidence shortlist.
  const CUSTOM_SENTINEL = "__custom__";
  const isOllamaLocal = provider === "ollama" && !ollamaBaseURL;
  let modelChoices: Array<{ name: string; value: string }> = getModelChoices(provider).map((c) => ({
    name: formatChoiceLabel(c),
    value: c.id,
  }));

  if (isOllamaLocal) {
    const installed = await listInstalledOllamaModels();
    const { recommended, other } = partitionByRecommended(installed);
    if (recommended.length > 0) {
      modelChoices = [
        ...recommended.map((id) => ({
          name: `${id} ${dim("(installed, recommended for tool calling)")}`,
          value: id,
        })),
        ...other.map((id) => ({
          name: `${id} ${dim("(installed)")}`,
          value: id,
        })),
      ];
    } else {
      // Discovery returned nothing tool-capable. Tell the operator how to
      // get a usable model on disk, then fall through to the curated list
      // + Custom so the wizard doesn't dead-end.
      console.log();
      console.log(`  ${dim("No tool-capable Ollama model found on this box.")}`);
      console.log(`  ${dim("Recommended:")}  ${cream(`ollama pull ${RECOMMENDED_FIRST_PULL}`)}`);
      console.log(
        `  ${dim("Re-run `auggy create` after pulling; your installed models will appear here.")}`,
      );
      if (other.length > 0) {
        console.log();
        console.log(
          `  ${dim(`Installed but not on the tool-capable shortlist: ${other.join(", ")}`)}`,
        );
      }
      console.log();
    }
  }

  const modelSelection = await withEscRestart((ctx) =>
    select<string>(
      {
        message: "Model:",
        choices: [
          ...modelChoices,
          { name: "Custom — type your own model ID", value: CUSTOM_SENTINEL },
        ],
      },
      ctx,
    ),
  );

  let model: string;
  if (modelSelection === CUSTOM_SENTINEL) {
    model = await withEscRestart((ctx) => input({ message: "Custom model ID:" }, ctx));
    printCustomModelWarning(model);
    const proceed = await withEscRestart((ctx) =>
      confirm(
        {
          message: "Continue with unpriced model? Budget caps will not enforce.",
          default: false,
        },
        ctx,
      ),
    );
    if (!proceed) {
      throw new Error(
        "Aborted by operator. Pick a priced model or add `engine.costOverride` to agent.yaml after scaffolding.",
      );
    }
  } else {
    model = modelSelection;
  }

  // Operator + purpose prompts.
  const operatorName = await withEscRestart((ctx) =>
    input(
      {
        message: "Operator name (your name; appears in identity.md security rule):",
        default: DEFAULT_OPERATOR_NAME,
      },
      ctx,
    ),
  );
  const purpose = await withEscRestart((ctx) =>
    input(
      {
        message: "Agent purpose (one sentence):",
        default: DEFAULT_PURPOSE,
      },
      ctx,
    ),
  );

  // Interactive augment selection.
  //
  // Two-step visual: print the always-included augments above the picker
  // as a dimmed header (no checkbox, no scrollable position) so they don't
  // compete for attention or confuse first-runners about what's actually
  // a choice. Then run checkbox() only on the optional entries with
  // one-line taglines + a detail panel for the focused row.
  const requiredEntries = AUGMENT_CATALOG.filter((e) => e.required);
  const optionalEntries = AUGMENT_CATALOG.filter((e) => !e.required);

  if (requiredEntries.length > 0) {
    console.log();
    console.log(dim("  Always included:"));
    for (const entry of requiredEntries) {
      console.log(`    ${dim("•")}  ${entry.label.padEnd(20)} ${dim(entry.tagline)}`);
    }
    console.log();
  }

  const selected = await withEscRestart((ctx) =>
    checkbox(
      {
        message: "Pick the rest:",
        choices: optionalEntries.map((entry) => ({
          name: `${entry.label.padEnd(20)} ${entry.tagline}`,
          value: entry,
          description: entry.description,
        })),
      },
      ctx,
    ),
  );

  const augments = [...requiredEntries];
  for (const entry of selected) {
    if (!augments.includes(entry)) {
      augments.push(entry);
    }
  }

  // Conditional org prompts — only ask when manifest is selected.
  const manifestSelected = augments.some((e) => e.type === "manifest");
  let orgName = DEFAULT_ORG_NAME;
  let orgPurpose = DEFAULT_ORG_PURPOSE;
  if (manifestSelected) {
    orgName = await withEscRestart((ctx) =>
      input(
        {
          message: "Org name:",
          default: DEFAULT_ORG_NAME,
        },
        ctx,
      ),
    );
    orgPurpose = await withEscRestart((ctx) =>
      input(
        {
          message: "Org purpose (one sentence):",
          default: DEFAULT_ORG_PURPOSE,
        },
        ctx,
      ),
    );
  }

  return {
    provider,
    model,
    operatorName,
    purpose,
    augments,
    orgName,
    orgPurpose,
    manifestSelected,
    ollamaBaseURL,
    ollamaNeedsBearer,
  };
}

export async function runCreate(name: string, opts: CreateOpts): Promise<void> {
  const finalDir = resolve(opts.cwd ?? process.cwd(), name);

  if (existsSync(finalDir)) {
    throw new Error(
      `Agent "${name}" already exists at ${finalDir}.\n\n` +
        "  Use a different directory name, or remove the existing directory.",
    );
  }

  // Wizard loop — Esc at any prompt restarts from the engine-provider
  // step. We only print the welcome banner on the first attempt; restart
  // attempts skip it to keep the terminal scrollback clean.
  let attempt = 0;
  let answers: WizardAnswers;
  for (;;) {
    if (attempt === 0) printWelcome();
    try {
      answers = await runWizard();
      break;
    } catch (err) {
      if (err instanceof WizardRestartRequested) {
        attempt += 1;
        console.log();
        console.log(dim("  ↺ Restarted (Esc pressed)"));
        console.log();
        continue;
      }
      throw err;
    }
  }

  const {
    provider,
    model,
    operatorName,
    purpose,
    augments,
    orgName,
    orgPurpose,
    manifestSelected,
    ollamaBaseURL,
    ollamaNeedsBearer,
  } = answers;

  const id = `aug1_${randomUUID()}`;

  // Stage everything into a sibling `.tmp-<uuid>` dir beside the final project.
  // The rename at the end is the atomic publish step.
  const stagingParent = join(finalDir, "..");
  mkdirSync(stagingParent, { recursive: true });
  const tempDir = join(stagingParent, `.tmp-${randomUUID()}`);

  try {
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "skills"), { recursive: true });
    mkdirSync(join(tempDir, "data", "workspace"), { recursive: true });
    mkdirSync(join(tempDir, "augments"), { recursive: true });

    console.log();
    console.log(dim(" Installing augments..."));
    console.log();
    for (const entry of augments) {
      copyBundledSkill(entry.type, tempDir);
      console.log(`   ${green("✓")} ${cream(entry.defaultName)} ${dim(`(${entry.type})`)}`);
    }

    const config = buildAgentYaml(
      id,
      name,
      augments,
      {
        provider,
        model,
        operatorName,
        purpose,
        ollamaBaseURL,
      },
      { project: true },
    );
    writeFileSync(join(tempDir, "agent.yaml"), config);

    writeFileSync(
      join(tempDir, "identity.md"),
      renderIdentityFromTemplate({
        agentName: name,
        purpose,
        operatorName,
      }),
    );

    if (augments.some((e) => e.defaultName === "learned")) {
      writeFileSync(join(tempDir, "learned.md"), "");
    }

    if (manifestSelected) {
      writeManifestExample(tempDir, { orgName, orgPurpose, operatorName });
    }

    // Build .env with both auto-generated values AND empty placeholders for
    // env vars the operator still needs to fill.
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

    writeFileSync(join(tempDir, ".env"), buildEnv(autoGenLines, placeholderEnvVars));
    writeFileSync(join(tempDir, ".gitignore"), GITIGNORE);

    const auggyVersion = getAuggyVersion();
    writeFileSync(
      join(tempDir, "package.json"),
      buildAgentPackageJson({
        agentName: name,
        auggyVersion,
        provider,
        augments,
      }),
    );

    // No per-agent metadata file is written for fresh agents. createdAt
    // derives from the dir's filesystem birthtime/mtime, and there is no
    // cloud record until `auggy deploy` runs.
  } catch (err) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    throw err;
  }

  // Atomic publish: rename the staging dir into the canonical path.
  // If the target appeared between the existsSync check above and now,
  // renameSync throws ENOTEMPTY/EEXIST — we clean up the staging dir and
  // surface a clear error.
  try {
    renameSync(tempDir, finalDir);
  } catch (err) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    if (
      (err as NodeJS.ErrnoException).code === "ENOTEMPTY" ||
      (err as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      throw new Error(
        `Agent "${name}" was created concurrently at ${finalDir}.\n\n` +
          `  Use a different name, or remove the existing one with \`auggy remove ${name}\`.`,
      );
    }
    throw err;
  }

  // bun install — populates <finalDir>/node_modules so `auggy dev` can resolve
  // the engine + augment packages. Fail-soft: a failed install leaves the
  // scaffolded dir intact and surfaces a clear retry command.
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
      console.log(`  Scaffolding is on disk.`);
      console.log(`  Retry:  cd ${finalDir} && bun install`);
      console.log(`  Then:   auggy run ${name}`);
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
  const envVarsForNextSteps = collectEnvVars(augments, provider).filter(
    (v) => !AUTO_GENERATED_ENV_VARS.has(v),
  );
  if (ollamaNeedsBearer) envVarsForNextSteps.push("OLLAMA_API_KEY");
  if (envVarsForNextSteps.length > 0) {
    console.log(
      `   ${cream(`${step++}.`)}  Fill in ${finalDir}/.env  ${dim(`(${envVarsForNextSteps.join(", ")})`)}`,
    );
  }
  console.log(
    `   ${cream(`${step++}.`)}  Open ${finalDir} in your editor   ${dim("(identity.md, agent.yaml — optional)")}`,
  );
  console.log(
    `   ${cream(`${step++}.`)}  auggy run ${name}   ${dim("(boots + opens /console/chat in your browser)")}`,
  );
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
  layout: { project: boolean } = { project: false },
): string {
  const engineBlock: Record<string, unknown> = {
    provider: engine.provider,
    model: engine.model,
    maxContextTokens: 200000,
    maxTokens: 4096,
  };
  if (engine.provider === "ollama" && engine.ollamaBaseURL) {
    engineBlock.baseURL = engine.ollamaBaseURL;
  }

  const config: Record<string, unknown> = {
    id,
    name,
    purpose: engine.purpose,
    operators: [engine.operatorName],
    identity: "./identity.md",
    engine: engineBlock,
    settings: {
      compactionStrategy: "truncate",
      maxInferenceLoops: 10,
    },
    augments: augments.map((entry) => {
      const options = optionsForLayout(entry, name, layout);
      return {
        name: entry.defaultName,
        type: entry.type,
        options,
      };
    }),
  };

  return `# Agent configuration\n\n${stringify(config)}`;
}

function optionsForLayout(
  entry: CatalogEntry,
  agentName: string,
  layout: { project: boolean },
): Record<string, unknown> | undefined {
  const options = layeredMemoryNamespaceFor(entry, agentName) ?? entry.defaultOptions;
  if (!options || !layout.project) return options;
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

function layeredMemoryNamespaceFor(
  entry: CatalogEntry,
  agentName: string,
): Record<string, unknown> | null {
  if (entry.type !== "layeredMemory") return null;
  return { ...entry.defaultOptions, namespace: agentName };
}

function collectEnvVars(augments: CatalogEntry[], provider: Provider): string[] {
  const vars = new Set<string>();
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
 * Write a minimal example `manifest/` directory the manifest augment
 * can read with `baseUrl: file://./manifest` (α-6).
 */
function writeManifestExample(
  agentDir: string,
  values: { orgName: string; orgPurpose: string; operatorName: string },
): void {
  const manifestDir = join(agentDir, "manifest");
  mkdirSync(manifestDir, { recursive: true });

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
  writeFileSync(join(manifestDir, "manifest"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(manifestDir, "mission.md"),
    `# ${values.orgName} — Mission\n\n${values.orgPurpose}\n`,
  );
  writeFileSync(
    join(manifestDir, "team.md"),
    `# ${values.orgName} — Team\n\n- ${values.operatorName} (operator)\n`,
  );
  writeFileSync(
    join(manifestDir, "README.md"),
    `# Manifest (example)\n\nThis directory backs the manifest augment via the\n\`baseUrl: file://./manifest\` config in agent.yaml.\n\n- \`manifest\` — JSON listing the endpoints the augment exposes\n- \`mission.md\`, \`team.md\` — endpoint targets the manifest references\n\nReplace these files with your real content, or change \`baseUrl\` in\n\`agent.yaml\` to point at an HTTP-served manifest if you'd rather host\nit elsewhere.\n`,
  );
}

const GITIGNORE = `.env
.env.local
workspace/
data/
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
