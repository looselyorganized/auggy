/**
 * Scaffold — generates a new agent directory with auggy create.
 *
 * Creates the standard agent directory convention:
 *   <name>/
 *     agent.yaml         Config (source of truth) — uses `identity:` shorthand
 *     .env               Secrets template (gitignored)
 *     identity.md        Who the agent is — security rules + voice
 *     learned-behaviors.md What the agent has learned about how to operate
 *     skills/            Skill folders (read-only fs mount), one per
 *                        tool-providing augment plus starter authoring skills
 *     data/workspace/    Agent's mutable workspace
 *     augments/          Installed augment config + custom local augments
 *     .gitignore         Ignores .env, data/, *.log, *.db, memory.sqlite
 *
 * Per ADR-025 (augment-as-folder + skill bundling) and the PR α foundation
 * spec: scaffold copies bundled skills, uses the `identity:` YAML shorthand,
 * writes identity.md from a template with the four security rules baked in.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { copyBundledSkill, copyStarterSkills, renderIdentityFromTemplate } from "./scaffold-skills";
import {
  augmentIdForCatalogEntry,
  writeBuiltinAugmentMetadata,
  writeCustomAugmentsReadme,
} from "./augment-metadata";
import { AUGMENT_CATALOG, type CatalogEntry } from "./augment-catalog";
import { writeFileSafely } from "./safe-write";

export interface ScaffoldOptions {
  /** Agent name. */
  name: string;
  /** Human-facing display name. Defaults to `name`. */
  displayName?: string;
  /** Target directory (defaults to ./<name>). */
  targetDir?: string;
  /** Optional purpose string for the agent (default: "a helpful assistant"). */
  purpose?: string;
  /**
   * Creator name used to populate the scaffolded identity.md security rules
   * and the agent.yaml `creator.displayName` field.
   */
  operatorName?: string;
}

/** Default values used when prompts are skipped (non-interactive). */
const DEFAULT_OPERATOR_NAME = "the creator";
const DEFAULT_PURPOSE = "a helpful assistant";
const WORKSPACE_README = `# Workspace

This is the agent's writable scratch space.

Files the agent creates, edits, downloads, drafts, or organizes should go here.
Runtime data and generated artifacts belong here instead of next to agent.yaml,
identity.md, or .env.
`;

/**
 * Scaffold a new agent directory.
 * Throws if the target directory already exists.
 */
export function scaffoldAgent(opts: ScaffoldOptions): string {
  const dir = resolve(opts.targetDir ?? `./${opts.name}`);

  if (existsSync(dir)) {
    throw new Error(`Directory already exists: ${dir}`);
  }

  const id = `aug1_${randomUUID()}`;
  const displayName = opts.displayName?.trim() || opts.name;
  const purpose = opts.purpose ?? DEFAULT_PURPOSE;
  const operatorName = opts.operatorName ?? DEFAULT_OPERATOR_NAME;

  // The augment types this scaffold installs by default. Drives the bundled-
  // skill copy (which copies SKILL.md files into <agent>/skills/<augment>/).
  // The runtime `skills` augment surfaces them to the model from disk at
  // every context() call — no longer threaded into identity.md per ADR-030.
  const augmentTypes = ["fileMemory", "filesystem", "webTransport", "webFetch", "turnControl"];

  // Create directory structure.
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  mkdirSync(join(dir, "data", "workspace"), { recursive: true });
  writeFileSync(join(dir, "data", "workspace", "README.md"), WORKSPACE_README);
  mkdirSync(join(dir, "augments"), { recursive: true });
  writeCustomAugmentsReadme(dir);
  copyStarterSkills(dir);

  // Copy bundled skill folders for each tool-providing augment. Idempotent —
  // re-running the scaffold overwrites; per ADR-025 Decision 2 operators opt
  // into updates by re-scaffolding.
  for (const type of augmentTypes) {
    copyBundledSkill(type, dir);
  }
  for (const type of augmentTypes) {
    const entry = AUGMENT_CATALOG.find((candidate) => candidate.type === type);
    if (entry) writeBuiltinAugmentMetadata(dir, entry, optionsForScaffold(entry));
  }

  // Write identity.md from the bundled template (security rules only —
  // skill manifest moved out per ADR-030).
  writeFileSync(
    join(dir, "identity.md"),
    renderIdentityFromTemplate({
      agentName: opts.name,
      displayName,
      purpose,
      operatorName,
    }),
  );

  // Write learned-behaviors.md (empty, agent appends creator-approved behavior notes).
  writeFileSync(join(dir, "learned-behaviors.md"), "");

  // Write agent.yaml using the identity: shorthand (per α-5).
  writeFileSync(
    join(dir, "agent.yaml"),
    agentYamlTemplate(id, opts.name, displayName, purpose, operatorName, augmentTypes),
  );

  // Write .env with empty values — operator fills in secrets before first run.
  writeFileSafely(join(dir, ".env"), ENV_TEMPLATE, { mode: 0o600 });

  // Write .gitignore.
  writeFileSync(join(dir, ".gitignore"), GITIGNORE_TEMPLATE);

  return dir;
}

function optionsForScaffold(entry: CatalogEntry): Record<string, unknown> | undefined {
  const options = entry.defaultOptions;
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
    out[key] = rewriteMutablePaths(child);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * Render a string as a YAML-safe scalar. Operator-supplied free-text values
 * (purpose, operatorName) reach this function; without escaping, a value
 * containing a quote, newline, or backslash would corrupt the generated
 * agent.yaml. JSON-encoded strings are valid YAML scalars in flow shape,
 * so JSON.stringify produces a double-quoted, escaped form that YAML parses
 * back to the original string.
 *
 * The interactive `auggy create` flow already routes operator input through
 * yaml.stringify; this helper closes the parallel gap in `scaffoldAgent`,
 * the programmatic entry point used by tests and any third-party scaffolder.
 */
function yamlScalar(s: string): string {
  return JSON.stringify(s);
}

function agentYamlTemplate(
  id: string,
  name: string,
  displayName: string,
  purpose: string,
  operatorName: string,
  augmentTypes: string[],
): string {
  const augmentLines = augmentTypes
    .map((type) => AUGMENT_CATALOG.find((entry) => entry.type === type))
    .filter((entry): entry is CatalogEntry => Boolean(entry))
    .map((entry) => `  - ${augmentIdForCatalogEntry(entry)}`)
    .join("\n");

  return `# Agent configuration — the source of truth for this Auggy agent.
# See docs at https://auggy.dev/docs for field reference.

id: ${yamlScalar(id)}
name: ${yamlScalar(name)}
displayName: ${yamlScalar(displayName)}
purpose: ${yamlScalar(purpose)}
creator:
  displayName: ${yamlScalar(operatorName)}

# identity.md is loaded into the agent's system context.
# Operators wanting non-default memory options should replace this shorthand
# with an explicit fileMemory augment.
identity: ./identity.md

engine:
  provider: anthropic        # or: openai, openrouter
  model: claude-sonnet-4-6   # openai: gpt-5.4-mini | openrouter: qwen/qwen3.5-397b-a17b
  maxContextTokens: 200000   # for openrouter, set per-model — defaults vary
  maxTokens: 4096            # sent as max_completion_tokens for openai/openrouter
  # reasoningEffort: medium  # optional: none|minimal|low|medium|high|xhigh
  # providerRouting:         # openrouter only — base slugs verified before inference
  #   only: [openai]         # canonical lowercase slug; variants with "/" are rejected
  #   sort: price

settings:
  compactionStrategy: truncate
  maxInferenceLoops: 10

augments:
${augmentLines}
`;
}

const ENV_TEMPLATE = `# Auggy agent secrets — this file is gitignored.
# Add your API keys and tokens here. Only the key matching the
# configured engine.provider in agent.yaml needs to be filled in.

ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# OPENROUTER_API_KEY=
AUGGY_WEB_TOKEN=
# Uncomment when visitorAuth augment is added (signingKey is owned by visitorAuth,
# injected into webTransport at boot — no need to set it in webTransport's config).
# VISITOR_SIGNING_KEY=
# Stable identifier for visitor-auth tokens — must be unique per agent
# if multiple agents share VISITOR_SIGNING_KEY (otherwise tokens are
# cross-replayable). Pattern: short slug or the agent's id.
AUGGY_AGENT_ID=
# SUPABASE_URL=
# SUPABASE_SERVICE_KEY=
`;

const GITIGNORE_TEMPLATE = `.env
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
