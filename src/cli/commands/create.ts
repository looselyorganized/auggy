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

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
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
};

/**
 * Default values surfaced when an operator skips the interactive prompts
 * (Ctrl+D, non-TTY stdin, etc.). The operator-name default matches the
 * security-eval test fixture's fallback so non-interactive scaffolding stays
 * compatible with the canonical eval suite (see evals/security/eval-context.ts
 * deriveOperatorName fallback).
 */
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
  const dir = opts.dir ? resolve(opts.dir) : join(homedir(), ".auggy", "agents", name);

  if (existsSync(dir)) {
    throw new Error(`Directory already exists: ${dir}`);
  }

  printWelcome();

  // Interactive engine selection.
  const provider = await select<Provider>({
    message: "Engine provider:",
    choices: [
      { name: "anthropic — Claude models", value: "anthropic" },
      { name: "openai — GPT models", value: "openai" },
      { name: "openrouter — any model via OpenRouter", value: "openrouter" },
    ],
    default: "anthropic",
  });

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

    const envVars = collectEnvVars(augments, provider);
    writeFileSync(join(dir, ".env.example"), buildEnvExample(envVars));
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
  // Without this, Ctrl+C between scaffold completion and addAgent leaves
  // an orphan dir with no index entry — neither create nor remove can recover.
  const sigintHandler = (): void => {
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    console.log();
    console.log("Aborted. Cleaned up partially-scaffolded directory.");
    process.exit(130); // 128 + SIGINT(2)
  };
  process.once("SIGINT", sigintHandler);

  // Register in the index. If this fails, clean up the scaffolded dir.
  try {
    addAgent(name, dir, { auggyDir: opts.auggyDir });
  } catch (err) {
    process.removeListener("SIGINT", sigintHandler);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    throw err;
  }
  process.removeListener("SIGINT", sigintHandler);

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
    const result = await runBunInstall(dir, opts.bunInstallSpawn);
    installOk = result.ok;
    if (!installOk) {
      console.log();
      console.log(`⚠ bun install failed in ${dir} (exit ${result.code}).`);
      console.log(`  Scaffolding is on disk and registered in the index.`);
      console.log(`  Retry:  cd ${dir} && bun install`);
      console.log(`  Then:   auggy dev ${name}`);
      console.log();
    }
  }

  const envVar = PROVIDER_DEFAULTS[provider].envVar;

  console.log();
  console.log(dim(" ─────────────────────────────────────────────"));
  console.log();
  console.log(` ${green("✓")} ${bold(cream(`Agent "${name}" created`))}`);
  console.log(`   ${dim(dir)}`);
  console.log();
  console.log(` ${bold("Next steps:")}`);
  console.log();
  let step = 1;
  if (opts.skipInstall) {
    console.log(`   ${cream(`${step++}.`)}  cd ${dir} && bun install`);
  } else if (!installOk) {
    console.log(
      `   ${cream(`${step++}.`)}  cd ${dir} && bun install   ${dim("(retry — earlier attempt failed)")}`,
    );
  }
  console.log(`   ${cream(`${step++}.`)}  cp ${dir}/.env.example ${dir}/.env`);
  console.log(`   ${cream(`${step++}.`)}  Add your ${bold(envVar)} to ${dir}/.env`);
  console.log(`   ${cream(`${step++}.`)}  Edit ${dir}/identity.md`);
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
  engine: { provider: Provider; model: string; operatorName: string; purpose: string },
): string {
  const config: Record<string, unknown> = {
    id,
    name,
    purpose: engine.purpose,
    operators: [engine.operatorName],
    // identity shorthand — synthesizes the fileMemory@system entry at parse
    // time (per α-5). Operators wanting non-default options should drop the
    // shorthand and add an explicit fileMemory augment instead.
    identity: "./identity.md",
    engine: {
      provider: engine.provider,
      model: engine.model,
      maxContextTokens: 200000,
      maxTokens: 4096,
    },
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
  const vars = new Set<string>([PROVIDER_DEFAULTS[provider].envVar]);
  for (const entry of augments) {
    if (entry.envVars) {
      for (const v of entry.envVars) vars.add(v);
    }
  }
  return [...vars];
}

function buildEnvExample(vars: string[]): string {
  const lines = ["# Agent secrets — copy to .env and fill in values.", "# .env is gitignored.", ""];
  for (const v of vars) {
    lines.push(`${v}=`);
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
