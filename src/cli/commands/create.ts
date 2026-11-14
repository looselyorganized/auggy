/**
 * auggy create <name> — scaffold a standalone agent project at `./<name>/`.
 *
 * Files are planned first, published with absence preconditions, and activated
 * by central YAML last. Fresh create reserves its directory with exclusive mkdir.
 * Interrupted publication uses the private authoring receipt for guarded recovery.
 */

import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { confirm, input, password, select } from "@inquirer/prompts";
import { stringify } from "yaml";
import { AUGMENT_CATALOG, type CatalogEntry } from "../augment-catalog";
import {
  bundledSkillFiles,
  starterSkillFiles,
  renderIdentityFromTemplate,
} from "../scaffold-skills";
import {
  formatPricing,
  listModelRegistry,
  listStaticModels,
  lookupEnginePricing,
  type ModelRegistryEntry,
  type ModelRegistryResult,
} from "../model-registry";
import {
  createModelSnapshot,
  customModelSelection,
  selectionFromModelRegistryEntry,
  MODEL_SNAPSHOT_RELATIVE_PATH,
  type ModelSnapshot,
  type ModelSnapshotSelection,
} from "../model-snapshot";
import type { Provider } from "../types";
import {
  listInstalledOllamaModels,
  partitionByRecommended,
  RECOMMENDED_FIRST_PULL,
} from "../ollama-discover";
import {
  buildAgentPackageJson,
  getAuggyVersion,
  resolveScaffoldPackageSpecifiersForCreate,
} from "../scaffold-package-json";
import { runBunInstall, type BunInstallSpawnFactory } from "../bun-install";
import { checkAgentRuntimeInstall, type RuntimeInstallCheck } from "../runtime-install-check";
import { withEscRestart, WizardRestartRequested } from "../wizard-restart";
import { planKnowledgeScaffold } from "../scaffold-knowledge";
import { displayPath } from "../display-path";
import { assertSecureCredentialTransport } from "../../engines/_shared/credential-transport";
import { planApplicationScaffold } from "../scaffold-application";
import { createMutationPlan } from "../authoring/mutation";
import { publishMutationPlan } from "../authoring/publication";
import { safeNavigation } from "../authoring/inspection-safety";
import { AUTHORING_LIMITS } from "../authoring/contracts";
import type {
  GeneratedApplicationFile,
  PlannedFile,
  PublicationFaultHook,
} from "../authoring/contracts";
import { inspectProjectRuntime } from "../project-runtime";
import { VALID_NAME_RE } from "../agent-name";

const PROVIDER_DEFAULTS: Record<Provider, { model: string; envVar: string }> = {
  anthropic: { model: "claude-sonnet-4-6", envVar: "ANTHROPIC_API_KEY" },
  openai: { model: "gpt-5.4-mini", envVar: "OPENAI_API_KEY" },
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
const AUTO_GENERATED_ENV_VARS = new Set(["AUGGY_WEB_TOKEN", "AUGGY_AGENT_ID", "AUGGY_PUBLIC_URL"]);

const DEFAULT_OPERATOR_NAME = "the creator";
const DEFAULT_PURPOSE = "a helpful assistant";
const DEFAULT_ORG_NAME = "Test Org";
const DEFAULT_ORG_PURPOSE = "for testing only";
const WORKSPACE_README = `# Workspace

This is the agent's writable scratch space.

Files the agent creates, edits, downloads, drafts, or organizes should go here.
Runtime data and generated artifacts belong here instead of next to agent.yaml,
identity.md, or .env.
`;

// ANSI color helpers. Cream and signal orange mirror the public site palette.
// Strips to plain text when stdout is not a TTY so piped output stays clean.
const IS_TTY = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
const ansi = (code: string, s: string): string => (IS_TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string): string => ansi("1", s);
const dim = (s: string): string => ansi("2", s);
const cream = (s: string): string => ansi("38;2;251;247;235", s);
const signal = (s: string): string => ansi("38;2;236;113;60", s);
const green = (s: string): string => ansi("32", s);

export interface CreateOptions {
  provider?: string;
  model?: string;
  yes?: boolean;
  allowUnpricedModel?: boolean;
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
   * Test seam: verify the agent-local Auggy runtime after dependency install.
   * Production callers omit this and use the real filesystem check.
   */
  runtimeInstallCheck?: RuntimeInstallCheck;
  /** Deprecated test seam retained for older tests; create no longer uses ~/.auggy. */
  auggyDir?: string;
  /** Test seam: override process.cwd(). */
  cwd?: string;
  /** Fetch live provider model catalogs before model selection. */
  refreshModels?: boolean;
  /** Use the saved provider model cache from previous refreshes. Production CLI enables this. */
  useModelCache?: boolean;
  /** Test seam: override the provider model cache directory. */
  modelCacheDir?: string;
  /** Test seam: inject model registry lookup. */
  modelRegistry?: typeof listModelRegistry;
  /** Explicit test-only publication injection; never selected by CLI or environment. */
  publicationFault?: PublicationFaultHook;
}

export type CreateOpts = CreateOptions;

export interface InitOpts extends CreateOpts {
  /** Optional explicit agent name. Defaults to the current directory basename. */
  name?: string;
}

interface WizardAnswers {
  provider: Provider;
  model: string;
  modelSnapshot: ModelSnapshot;
  displayName: string;
  operatorName: string;
  purpose: string;
  augments: CatalogEntry[];
  orgName: string;
  orgPurpose: string;
  knowledgeSelected: boolean;
  ollamaBaseURL: string | undefined;
  ollamaNeedsBearer: boolean;
  providedEnv: Record<string, string>;
}

interface CreateModelChoice {
  name: string;
  value: string;
  priced: boolean;
  snapshot: ModelSnapshotSelection;
}

interface CreateModelChoiceResult {
  choices: CreateModelChoice[];
  warnings: string[];
  source: "static" | "cached" | "live";
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
async function runWizard(agentName: string, opts: CreateOpts = {}): Promise<WizardAnswers> {
  // Interactive engine selection.
  const provider =
    (opts.provider as Provider | undefined) ??
    (await withEscRestart((ctx) =>
      select<Provider>(
        {
          message: "Model provider:",
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
    ));

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
      assertSecureCredentialTransport({
        provider: "Ollama",
        baseURL: ollamaBaseURL,
      });
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
      if (ollamaNeedsBearer) {
        assertSecureCredentialTransport({
          provider: "Ollama",
          baseURL: ollamaBaseURL,
          credential: "<configured bearer>",
        });
      }
    }
  }

  const providedEnv: Record<string, string> = {};
  const providerEnvVar = PROVIDER_DEFAULTS[provider].envVar;
  if (providerEnvVar) {
    const key = await withEscRestart((ctx) =>
      password(
        {
          message: `${providerLabel(provider)} API key (optional, saved to .env):`,
          mask: "*",
        },
        ctx,
      ),
    );
    if (key.trim()) providedEnv[providerEnvVar] = key.trim();
  }
  if (ollamaNeedsBearer) {
    const key = await withEscRestart((ctx) =>
      password(
        {
          message: "Ollama bearer token (optional):",
          mask: "*",
        },
        ctx,
      ),
    );
    if (key.trim()) providedEnv.OLLAMA_API_KEY = key.trim();
  }

  // Model selection: dropdown of priced models + Custom escape hatch.
  //
  // For ollama-local, discover what's installed on the box (`ollama list`)
  // and offer those first; the curated fallback is only shown if discovery
  // turns up nothing tool-capable. See `ollama-discover.ts` for the rules
  // and the BFCL-evidence shortlist.
  const CUSTOM_SENTINEL = "__custom__";
  const isOllamaLocal = provider === "ollama" && !ollamaBaseURL;
  const autoRefreshModels =
    opts.useModelCache === true &&
    !opts.refreshModels &&
    provider !== "ollama" &&
    canAutoRefreshProviderModels(provider, providedEnv);
  const modelChoiceResult = await buildModelChoicesForCreate(provider, {
    refresh: opts.refreshModels,
    autoRefresh: autoRefreshModels,
    useCache: opts.useModelCache === true,
    cacheDir: opts.modelCacheDir,
    env: providedEnv,
    listRegistry: opts.modelRegistry,
  });
  let modelChoices = modelChoiceResult.choices;

  if (isOllamaLocal && !opts.model) {
    const installed = await listInstalledOllamaModels();
    const { recommended, other } = partitionByRecommended(installed);
    if (recommended.length > 0) {
      modelChoices = [
        ...recommended.map((id) => ({
          name: `${id} ${dim("(installed, recommended for tool calling)")}`,
          value: id,
          priced: true,
          snapshot: {
            provider: "ollama" as const,
            model: id,
            source: "provider" as const,
            status: "installed" as const,
            pricingKnown: true,
            pricing: { inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
          },
        })),
        ...other.map((id) => ({
          name: `${id} ${dim("(installed)")}`,
          value: id,
          priced: true,
          snapshot: {
            provider: "ollama" as const,
            model: id,
            source: "provider" as const,
            status: "installed" as const,
            pricingKnown: true,
            pricing: { inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
          },
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

  const modelWarnings =
    (opts.refreshModels || autoRefreshModels) && !isOllamaLocal ? modelChoiceResult.warnings : [];
  if (modelWarnings.length > 0) {
    console.log();
    for (const warning of modelWarnings) {
      console.log(`  ${dim(`Model refresh: ${warning}`)}`);
    }
    console.log();
  }

  const modelSelection =
    opts.model ??
    (await withEscRestart((ctx) =>
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
    ));

  let model: string;
  let selectedSnapshot: ModelSnapshotSelection;
  const selectedChoice = modelChoices.find((choice) => choice.value === modelSelection);
  if (modelSelection === CUSTOM_SENTINEL) {
    model = await withEscRestart((ctx) => input({ message: "Custom model ID:" }, ctx));
    selectedSnapshot = customModelSelection(provider, model);
    await confirmUnpricedModel(model);
  } else {
    model = modelSelection;
    selectedSnapshot = selectedChoice?.snapshot ?? customModelSelection(provider, model);
    if (!selectedSnapshot.pricingKnown) {
      await confirmUnpricedModel(model);
    }
  }

  async function confirmUnpricedModel(modelId: string): Promise<void> {
    printCustomModelWarning(modelId);
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
  }

  // Identity prompts.
  const displayNameAnswer = await withEscRestart((ctx) =>
    input(
      {
        message: "Agent display name (shown in chat):",
        default: agentName,
      },
      ctx,
    ),
  );
  const displayName = displayNameAnswer.trim() || agentName;

  const operatorName = await withEscRestart((ctx) =>
    input(
      {
        message: "Creator name (used after local verification):",
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

  const augments = AUGMENT_CATALOG.filter((e) => e.stability === "core");

  console.log();
  console.log(dim("  Included:"));
  for (const entry of augments) {
    console.log(`    ${dim("-")}  ${entry.label.padEnd(20)} ${dim(entry.tagline)}`);
  }
  console.log();

  return {
    provider,
    model,
    modelSnapshot: createModelSnapshot({
      provider,
      refreshRequested: opts.refreshModels === true,
      warnings: modelChoiceResult.warnings,
      selected: selectedSnapshot,
    }),
    displayName,
    operatorName,
    purpose,
    augments,
    orgName: DEFAULT_ORG_NAME,
    orgPurpose: DEFAULT_ORG_PURPOSE,
    knowledgeSelected: false,
    ollamaBaseURL,
    ollamaNeedsBearer,
    providedEnv,
  };
}

function validateCreateOptions(name: string, opts: CreateOptions): void {
  if (!VALID_NAME_RE.test(name)) {
    throw new Error(
      "Use an agent name containing letters, digits, underscores or hyphens, starting with a letter or digit.",
    );
  }
  if (opts.provider !== undefined && !Object.hasOwn(PROVIDER_DEFAULTS, opts.provider)) {
    throw new Error("Supported providers: anthropic, openai, openrouter, ollama.");
  }
  if (
    opts.model !== undefined &&
    (!opts.model ||
      opts.model.trim() !== opts.model ||
      Buffer.byteLength(opts.model) > 4096 ||
      [...opts.model].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ))
  )
    throw new Error("Supply a nonempty, bounded model ID without control characters.");
  if (opts.yes && (!opts.provider || !opts.model)) {
    throw new Error("Automated creation requires --yes --provider <id> --model <id>.");
  }
  if (opts.yes && opts.refreshModels) {
    throw new Error("--refresh-models is interactive-only; omit it when using --yes.");
  }
}

async function automatedAnswers(name: string, opts: CreateOptions): Promise<WizardAnswers> {
  const provider = opts.provider as Provider;
  const model = opts.model!;
  const result = await buildModelChoicesForCreate(provider, {
    useCache: opts.useModelCache === true,
    cacheDir: opts.modelCacheDir,
    listRegistry: opts.modelRegistry,
  });
  const selected =
    result.choices.find((choice) => choice.value === model)?.snapshot ??
    customModelSelection(provider, model);
  // Pricing tables also recognize aliases and Ollama's existing zero-cost policy.
  const pricing = selected.pricing ?? lookupEnginePricing(provider, model);
  if (pricing) {
    selected.pricing = pricing;
    selected.pricingKnown = true;
  }
  if (!selected.pricingKnown) {
    if (!opts.allowUnpricedModel) {
      throw new Error(
        "This model has no known pricing. Choose a priced model or explicitly pass --allow-unpriced-model; --yes does not acknowledge missing budget enforcement.",
      );
    }
    printCustomModelWarning(model, true);
  }
  return {
    provider,
    model,
    modelSnapshot: createModelSnapshot({
      provider,
      refreshRequested: false,
      warnings: result.warnings,
      selected,
    }),
    displayName: name,
    operatorName: DEFAULT_OPERATOR_NAME,
    purpose: DEFAULT_PURPOSE,
    augments: AUGMENT_CATALOG.filter((entry) => entry.stability === "core"),
    orgName: DEFAULT_ORG_NAME,
    orgPurpose: DEFAULT_ORG_PURPOSE,
    knowledgeSelected: false,
    ollamaBaseURL: undefined,
    ollamaNeedsBearer: false,
    providedEnv: {},
  };
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function runCreate(name: string, opts: CreateOpts = {}): Promise<void> {
  validateCreateOptions(name, opts);
  const finalDir = join(realpathSync(opts.cwd ?? process.cwd()), name);
  if (pathExists(finalDir)) {
    throw new Error(
      `Agent destination already exists: ${finalDir}. Choose a new sibling directory.`,
    );
  }
  await runCreateIntoDir(name, finalDir, opts, "create");
}

export async function runInit(opts: InitOpts = {}): Promise<void> {
  const selectedDir = resolve(opts.cwd ?? process.cwd());
  if (!lstatSync(selectedDir).isDirectory() || lstatSync(selectedDir).isSymbolicLink()) {
    throw new Error("Initialize a real project directory, not a symbolic link.");
  }
  const finalDir = realpathSync(selectedDir);
  const name = opts.name?.trim() || basename(finalDir);
  validateCreateOptions(name, opts);
  await runCreateIntoDir(name, finalDir, opts, "init");
}

async function runCreateIntoDir(
  name: string,
  finalDir: string,
  opts: CreateOpts,
  mode: "create" | "init",
): Promise<void> {
  let attempt = 0;
  let answers: WizardAnswers;
  for (;;) {
    if (attempt === 0) printWelcome();
    try {
      answers = opts.yes ? await automatedAnswers(name, opts) : await runWizard(name, opts);
      break;
    } catch (err) {
      if (err instanceof WizardRestartRequested) {
        attempt += 1;
        console.log("\n  ↺ Restarted (Esc pressed)\n");
        continue;
      }
      throw err;
    }
  }

  const {
    provider,
    model,
    modelSnapshot,
    displayName,
    operatorName,
    purpose,
    augments,
    orgName,
    orgPurpose,
    knowledgeSelected,
    ollamaBaseURL,
    ollamaNeedsBearer,
    providedEnv,
  } = answers;

  const application = planApplicationScaffold({ configFileName: "agent.yaml" });
  const id = `aug1_${randomUUID()}`;
  const file = (
    relativePath: string,
    text: string,
    fileMode = 0o644,
  ): GeneratedApplicationFile => ({
    relativePath,
    bytes: Buffer.from(text),
    mode: fileMode,
  });
  const generated: GeneratedApplicationFile[] = [
    ...application.files,
    ...starterSkillFiles(),
    ...augments.flatMap((entry) => bundledSkillFiles(entry.type)),
    file(
      "agent.yaml",
      buildAgentYaml(id, name, augments, {
        provider,
        model,
        displayName,
        operatorName,
        purpose,
        ollamaBaseURL,
      }),
    ),
    file(MODEL_SNAPSHOT_RELATIVE_PATH, `${JSON.stringify(modelSnapshot, null, 2)}\n`, 0o600),
    file(
      "identity.md",
      renderIdentityFromTemplate({ agentName: name, displayName, purpose, operatorName }),
    ),
    file("data/workspace/README.md", WORKSPACE_README),
    file(".gitignore", GITIGNORE),
  ];
  if (augments.some((entry) => entry.type === "fileMemory"))
    generated.push(file("learned-behaviors.md", ""));
  if (knowledgeSelected)
    generated.push(...planKnowledgeScaffold({ orgName, orgPurpose, creatorName: operatorName }));

  const placeholderEnvVars = collectEnvVars(augments, provider).filter(
    (value) => !AUTO_GENERATED_ENV_VARS.has(value) && !providedEnv[value],
  );
  if (ollamaNeedsBearer && !providedEnv.OLLAMA_API_KEY) placeholderEnvVars.push("OLLAMA_API_KEY");
  const autoGenLines: string[] = [];
  const webTransport = augments.find((entry) => entry.type === "webTransport");
  if (webTransport) {
    autoGenLines.push(`AUGGY_WEB_TOKEN=${randomBytes(32).toString("hex")}`);
    autoGenLines.push(`AUGGY_AGENT_ID=${id}`);
    const port = (webTransport.defaultOptions as { port?: number }).port ?? 8080;
    autoGenLines.push(`AUGGY_PUBLIC_URL=http://localhost:${port}`);
  }
  for (const [key, value] of Object.entries(providedEnv)) autoGenLines.push(`${key}=${value}`);
  const exampleEnvVars = collectEnvVars(augments, provider).filter(
    (value) => !AUTO_GENERATED_ENV_VARS.has(value),
  );
  if (ollamaNeedsBearer) exampleEnvVars.push("OLLAMA_API_KEY");
  generated.push(file(".env", buildEnv(autoGenLines, placeholderEnvVars), 0o600));
  generated.push(file(".env.example", buildEnv([], exampleEnvVars)));

  // An existing init manifest is a collision, never an input to workspace discovery.
  // Preflight every selected output before any package discovery reads the target.
  if (mode === "init") {
    assertGeneratedDestinationsAvailable(finalDir, [
      ...generated,
      { relativePath: "package.json" },
    ]);
  }
  const packageSpecifiers = resolveScaffoldPackageSpecifiersForCreate({
    cwd: finalDir,
    provider,
    version: getAuggyVersion(),
  });
  generated.push(
    file(
      "package.json",
      buildAgentPackageJson({
        agentName: name,
        auggyVersion: getAuggyVersion(),
        packageSpecifiers,
        provider,
        augments,
        application: application.packageFields,
      }),
    ),
  );

  // Reserve a new directory without replacing a concurrent empty directory.
  // It is visible before activation; publication does not claim whole-tree atomicity.
  if (mode === "create") {
    try {
      mkdirSync(finalDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(
          `Agent destination appeared concurrently: ${finalDir}. Choose a new sibling directory.`,
        );
      }
      throw error;
    }
  }
  assertGeneratedDestinationsAvailable(finalDir, generated);
  const files: PlannedFile[] = generated.map((entry) => ({
    ...entry,
    before: { path: join(finalDir, entry.relativePath), exists: false },
    role:
      entry.relativePath === "agent.yaml"
        ? "activation"
        : entry.relativePath === ".gitignore"
          ? "ignore"
          : entry.relativePath === ".env"
            ? "new-env"
            : "support",
  }));
  const plan = createMutationPlan({
    kind: "init",
    projectDir: finalDir,
    configRelativePath: "agent.yaml",
    inputs: files.map((entry) => entry.before),
    files,
    summary: files.map((entry) => ({
      path: entry.relativePath,
      operation: "create",
      reason: "Create owned application file",
    })),
  });
  const publication = publishMutationPlan(plan, { fault: opts.publicationFault });
  if (publication.status !== "complete") {
    // Publication diagnostics contain controlled messages. Never render private
    // receipt fields, diagnostic locations, or an original filesystem cause.
    const diagnostics = publication.diagnostics
      .slice(0, AUTHORING_LIMITS.diagnostics)
      .map(({ code, message }) => {
        const safeCode =
          code.length > 0 && code.length <= 80 && !/[^a-z0-9-]/.test(code)
            ? code
            : "publication-failed";
        return `[${safeCode}] ${safeNavigation(message, "Review the private operation locally before recovery.")}`;
      })
      .join("\n");
    throw new Error(
      `Application publication ${publication.status}; the project is not ready. Preserve private operation ${publication.operationId}. Preview recovery: auggy migrate --project-dir ${shellArgument(finalDir)} --rollback ${publication.operationId}. Review that plan before adding --apply.${diagnostics ? `\n${diagnostics}` : ""}`,
    );
  }
  console.log("\n Adding core augments...\n");
  for (const entry of augments)
    console.log(`   ${green("✓")} ${cream(entry.defaultName)} ${dim(`(${entry.type})`)}`);

  // bun install — populates <finalDir>/node_modules so `auggy dev` can resolve
  // the engine + augment packages. Fail-soft: a failed install leaves the
  // scaffolded dir intact and surfaces a clear retry command.
  let installOk = true;
  let runtimeInstallOk = true;
  if (!opts.skipInstall) {
    console.log();
    console.log(dim(" Installing dependencies..."));
    console.log();
    let result: Awaited<ReturnType<typeof runBunInstall>>;
    try {
      result = await runBunInstall(finalDir, opts.bunInstallSpawn);
    } catch {
      result = { ok: false, code: 1, stderr: "" };
    }
    installOk = result.ok;
    if (!installOk) {
      console.log();
      console.log(
        `⚠ bun install failed in ${displayPath(finalDir, opts.cwd)} (exit ${result.code}).`,
      );
      console.log(`  Scaffolding is on disk.`);
      console.log(`  Retry:  cd ${displayPath(finalDir, opts.cwd)} && bun install`);
      console.log(
        `  Then:   ${mode === "init" ? "auggy run" : `cd ${displayPath(finalDir, opts.cwd)} && auggy run`}`,
      );
      console.log();
    } else {
      const runtimeCheck = (opts.runtimeInstallCheck ?? checkApplicationRuntimeInstall)(finalDir);
      runtimeInstallOk = runtimeCheck.ok;
      if (!runtimeInstallOk) {
        console.log();
        console.log(
          `⚠ ${runtimeCheck.message ?? "Agent installed an incompatible Auggy runtime."}`,
        );
        if (runtimeCheck.fix) console.log(`  ${runtimeCheck.fix}`);
        console.log();
      }
    }
  }

  console.log();
  console.log(signal(" ─────────────────────────────────────────────"));
  console.log();
  const state = opts.skipInstall
    ? "files created (dependencies not verified)"
    : installOk && runtimeInstallOk
      ? "created (application runtime verified)"
      : "files created (not ready)";
  console.log(` ${green("✓")} ${bold(cream(`Agent "${name}" ${state}`))}`);
  console.log(`   ${dim(displayPath(finalDir, opts.cwd))}`);
  console.log();
  console.log(` ${bold("Next steps:")}`);
  console.log();
  let step = 1;
  if (mode === "create") {
    console.log(`   ${cream(`${step++}.`)}  cd ${relativeCreatePath(finalDir, opts.cwd)}`);
  }
  if (opts.skipInstall) {
    console.log(`   ${cream(`${step++}.`)}  bun install`);
    console.log(
      `   ${cream(`${step++}.`)}  bun run typecheck   ${dim("(check public application API)")}`,
    );
  } else if (!installOk) {
    console.log(
      `   ${cream(`${step++}.`)}  bun install   ${dim("(retry — earlier attempt failed)")}`,
    );
  } else if (!runtimeInstallOk) {
    console.log(
      `   ${cream(`${step++}.`)}  Fix package.json   ${dim("(auggy dependency mismatch)")}`,
    );
    console.log(`   ${cream(`${step++}.`)}  bun install`);
  }
  const envVarsForNextSteps = collectEnvVars(augments, provider).filter(
    (v) => !AUTO_GENERATED_ENV_VARS.has(v) && !providedEnv[v],
  );
  if (ollamaNeedsBearer && !providedEnv.OLLAMA_API_KEY) envVarsForNextSteps.push("OLLAMA_API_KEY");
  if (envVarsForNextSteps.length > 0) {
    console.log(
      `   ${cream(`${step++}.`)}  Set .env   ${dim(`(${envVarsForNextSteps.join(", ")})`)}`,
    );
  }
  console.log(`   ${cream(`${step++}.`)}  auggy doctor`);
  console.log(
    `   ${cream(`${step++}.`)}  auggy run${opts.skipInstall ? "   (verifies installed application contract 1)" : ""}`,
  );
  console.log();
  if (!installOk || !runtimeInstallOk) {
    throw new Error(
      "Application files are intact, but dependencies are not ready. Correct the package selection and retry bun install, then bun run typecheck and auggy run.",
    );
  }
}

function relativeCreatePath(finalDir: string, cwd: string | undefined): string {
  const baseDir = realpathSync(cwd ?? process.cwd());
  if (dirname(finalDir) === baseDir) return basename(finalDir);
  return finalDir;
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/** Inspect every generated destination without opening existing customer files. */
function assertGeneratedDestinationsAvailable(
  projectDir: string,
  files: readonly Pick<GeneratedApplicationFile, "relativePath">[],
): void {
  const collisions = new Set<string>();
  for (const file of files) {
    let current = projectDir;
    const segments = file.relativePath.split("/");
    for (const [index, segment] of segments.entries()) {
      const names = readdirSync(current);
      const matches = names.filter((name) => name.toLowerCase() === segment.toLowerCase());
      const match = matches[0];
      if (match === undefined) break;
      const relativePath = segments.slice(0, index).concat(match).join("/");
      if (match !== segment || matches.length > 1) {
        collisions.add(relativePath);
        break;
      }
      current = join(current, match);
      const stats = lstatSync(current);
      if (index === segments.length - 1 || stats.isSymbolicLink() || !stats.isDirectory()) {
        collisions.add(relativePath);
        break;
      }
    }
  }
  if (collisions.size > 0) {
    // JSON escaping keeps hostile pre-existing filenames from becoming terminal controls.
    const paths = [...collisions]
      .slice(0, 100)
      .map((path) => JSON.stringify(path))
      .join(", ");
    throw new Error(
      `Generated-file collisions: ${paths}. No project files were written. Create a sibling service with auggy create <new-name>, or manually review and move these files first.`,
    );
  }
}

const checkApplicationRuntimeInstall: RuntimeInstallCheck = (projectDir) => {
  try {
    const legacy = checkAgentRuntimeInstall(projectDir);
    if (!legacy.ok) return legacy;
    inspectProjectRuntime(projectDir, { applicationContract: 1 });
    return { ok: true };
  } catch {
    return {
      ok: false,
      message:
        "Installed Auggy does not expose a valid project-local application contract 1 runtime.",
      fix: "Select an application-capable Auggy dependency or the exact candidate tarball in package.json, run bun install, then bun run typecheck and auggy run.",
    };
  }
};

function printCustomModelWarning(modelId: string, acknowledged = false): void {
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
  if (!acknowledged) console.log(`Confirm at the next prompt to proceed, or decline to abort.`);
  console.log();
}

function providerLabel(provider: Provider): string {
  switch (provider) {
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "openrouter":
      return "OpenRouter";
    case "ollama":
      return "Ollama";
  }
}

export async function buildModelChoicesForCreate(
  provider: Provider,
  opts: {
    refresh?: boolean;
    autoRefresh?: boolean;
    useCache?: boolean;
    cacheDir?: string;
    env?: Record<string, string | undefined>;
    listRegistry?: typeof listModelRegistry;
  } = {},
): Promise<CreateModelChoiceResult> {
  const listRegistry = opts.listRegistry ?? listModelRegistry;
  let result: ModelRegistryResult;
  let source: CreateModelChoiceResult["source"] = "static";
  if (opts.refresh) {
    try {
      result = await listRegistry({
        provider,
        refresh: true,
        useCache: opts.useCache,
        writeCache: opts.useCache,
        cacheDir: opts.cacheDir,
        env: opts.env,
      });
      source = inferModelChoiceSource(result.models);
    } catch (err) {
      result = {
        models: listStaticModels(provider),
        warnings: [`${provider}: ${(err as Error).message}; using bundled fallback`],
      };
    }
  } else {
    result = await listRegistry({
      provider,
      useCache: opts.useCache,
      cacheDir: opts.cacheDir,
    });
    source = inferModelChoiceSource(result.models);
    if (opts.autoRefresh) {
      const fallback = result;
      const fallbackSource = source;
      try {
        result = await listRegistry({
          provider,
          refresh: true,
          useCache: opts.useCache,
          writeCache: opts.useCache,
          cacheDir: opts.cacheDir,
          env: opts.env,
        });
        source = inferModelChoiceSource(result.models);
      } catch (err) {
        const fallbackModels =
          fallback.models.length > 0 ? fallback.models : listStaticModels(provider);
        const fallbackLabel = fallback.models.length > 0 ? "saved model cache" : "bundled fallback";
        result = {
          models: fallbackModels,
          warnings: [`${provider}: ${(err as Error).message}; using ${fallbackLabel}`],
        };
        source = fallback.models.length > 0 ? fallbackSource : "static";
      }
    }
  }

  let models = result.models.filter((model) => model.provider === provider);
  models = models.filter((model) => model.tools !== false);
  if (opts.refresh) models = models.slice(0, 50);

  if (models.length === 0) {
    models = listStaticModels(provider);
    result = {
      ...result,
      warnings: [...result.warnings, `${provider}: live refresh returned no usable models`],
    };
    source = "static";
  }

  return {
    choices: dedupeCreateModelChoices(models.map(modelToCreateChoice)),
    warnings: result.warnings,
    source,
  };
}

function canAutoRefreshProviderModels(
  provider: Provider,
  providedEnv: Record<string, string>,
): boolean {
  if (provider === "openrouter") return true;
  const envVar = PROVIDER_DEFAULTS[provider].envVar;
  return Boolean(envVar && (providedEnv[envVar]?.trim() || process.env[envVar]?.trim()));
}

function inferModelChoiceSource(models: ModelRegistryEntry[]): CreateModelChoiceResult["source"] {
  if (models.some((model) => model.status === "live")) return "live";
  if (models.some((model) => model.status === "cached" || model.source === "provider")) {
    return "cached";
  }
  return "static";
}

function modelToCreateChoice(model: ModelRegistryEntry): CreateModelChoice {
  const details = [model.pricing ? formatPricing(model.pricing) : "pricing unknown"];
  if (model.contextWindow) details.push(`${formatModelTokens(model.contextWindow)} context`);
  if (model.source === "provider") details.push(model.status === "cached" ? "saved" : "live");
  return {
    name: `${model.id} — ${details.join(", ")}`,
    value: model.id,
    priced: model.pricing !== undefined,
    snapshot: selectionFromModelRegistryEntry(model),
  };
}

function dedupeCreateModelChoices(choices: CreateModelChoice[]): CreateModelChoice[] {
  const seen = new Set<string>();
  const out: CreateModelChoice[] = [];
  for (const choice of choices) {
    if (seen.has(choice.value)) continue;
    seen.add(choice.value);
    out.push(choice);
  }
  return out;
}

function formatModelTokens(value: number): string {
  if (value >= 1_000_000) return `${formatCompactNumber(value / 1_000_000)}M`;
  if (value >= 1_000) return `${formatCompactNumber(value / 1_000)}k`;
  return String(value);
}

function formatCompactNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  if (value >= 100) return String(Math.round(value));
  return value.toFixed(1).replace(/\.0$/, "");
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
  for (const line of banner) console.log(signal(line));
  console.log();
  console.log(` ${bold(cream("auggy"))}  ${dim("·  by the Loosely Organized Research Facility")}`);
  console.log();
  console.log(` ${bold(cream("Turn business operations into agent-ready capabilities."))}`);
  console.log();
  console.log(" Auggy replaces one-off integration glue with TypeScript augments—");
  console.log(" controlled, predictable interfaces that bundle identity, authorization,");
  console.log(" schemas, tools, routes, and domain logic.");
  console.log();
  console.log(signal(" ─────────────────────────────────────────────"));
  console.log();
  console.log(" Let's configure your agent. Start by picking a model provider.");
  console.log();
  console.log(dim(" The provider supplies the model Auggy calls each turn."));
  console.log(dim(" You can change the provider, model, and augments later in agent.yaml."));
  console.log();
}

function buildAgentYaml(
  id: string,
  name: string,
  augments: CatalogEntry[],
  engine: {
    provider: Provider;
    model: string;
    displayName: string;
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
  if (engine.provider === "ollama" && engine.ollamaBaseURL) {
    engineBlock.baseURL = engine.ollamaBaseURL;
  }

  const config: Record<string, unknown> = {
    id,
    name,
    displayName: engine.displayName,
    purpose: engine.purpose,
    creator: { displayName: engine.operatorName },
    identity: "./identity.md",
    engine: engineBlock,
    settings: {
      compactionStrategy: "truncate",
      maxInferenceLoops: 10,
      turnScheduling: {
        maxConcurrent: 4,
        maxQueued: 100,
        maxQueuedPerThread: 20,
        maxCausalDepth: 8,
      },
    },
    application: { entrypoint: "./src/index.ts", contractVersion: 1 },
    augments: augments.map((entry) => ({
      name: entry.defaultName,
      type: entry.type,
      options: optionsForLayout(entry, name, { project: true }),
    })),
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

const GITIGNORE = `.auggy/
.env
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
