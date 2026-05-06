/**
 * Scaffold — generates a new agent directory with auggy create.
 *
 * Creates the standard agent directory convention:
 *   <name>/
 *     agent.yaml         Config (source of truth) — uses `identity:` shorthand
 *     .env               Secrets template (gitignored)
 *     identity.md        Who the agent is — security rules + skill manifest
 *     learned.md         What the agent has learned (mutable)
 *     skills/            Skill folders (read-only fs mount), one per
 *                        tool-providing augment, copied from src/augments/<name>/skill/
 *     workspace/         Agent's mutable workspace
 *     augments/          Custom augments directory
 *     .gitignore         Ignores .env, workspace/, *.log, *.db, memory.sqlite
 *
 * Per ADR-025 (augment-as-folder + skill bundling) and the PR α foundation
 * spec: scaffold copies bundled skills, uses the `identity:` YAML shorthand,
 * includes layeredMemory by default, and writes identity.md from a template
 * with the four security rules baked in.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { copyBundledSkill, renderIdentityFromTemplate } from "./scaffold-skills";

export interface ScaffoldOptions {
  /** Agent name. */
  name: string;
  /** Target directory (defaults to ./<name>). */
  targetDir?: string;
  /** Optional purpose string for the agent (default: "a helpful assistant"). */
  purpose?: string;
  /**
   * Operator name used to populate the operator-identity reference in the
   * scaffolded identity.md security rules and the agent.yaml `operators[]`
   * array. Defaults to "the operator" — matches the security-eval test
   * fixture's fallback behavior so non-interactive scaffolding stays
   * compatible with the canonical eval suite.
   */
  operatorName?: string;
}

/** Default values used when prompts are skipped (non-interactive). */
const DEFAULT_OPERATOR_NAME = "the operator";
const DEFAULT_PURPOSE = "a helpful assistant";

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
  const purpose = opts.purpose ?? DEFAULT_PURPOSE;
  const operatorName = opts.operatorName ?? DEFAULT_OPERATOR_NAME;

  // The augment types this scaffold installs by default. Drives both the
  // bundled-skill copy and the identity.md skill-manifest entries so the two
  // surfaces always agree.
  const augmentTypes = [
    "fileMemory", // identity (mounted via shorthand) + learned.md
    "filesystem",
    "layeredMemory",
    "budgets",
    "webFetch",
    "turnControl",
    "webTransport",
  ];

  // Tool-providing types whose bundled skills should be copied. Subset of
  // augmentTypes — fileMemory / budgets / webTransport contribute no tools.
  const skillProvidingTypes = augmentTypes.filter((t) =>
    ["filesystem", "layeredMemory", "webFetch", "turnControl"].includes(t),
  );

  // Create directory structure.
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  mkdirSync(join(dir, "workspace"), { recursive: true });
  mkdirSync(join(dir, "augments"), { recursive: true });

  // Copy bundled skill folders for each tool-providing augment. Idempotent —
  // re-running the scaffold overwrites; per ADR-025 Decision 2 operators opt
  // into updates by re-scaffolding.
  for (const type of skillProvidingTypes) {
    copyBundledSkill(type, dir);
  }

  // Write identity.md from the new template (security rules + manifest).
  writeFileSync(
    join(dir, "identity.md"),
    renderIdentityFromTemplate({
      agentName: opts.name,
      purpose,
      operatorName,
      augmentTypes,
    }),
  );

  // Write learned.md (empty, agent appends as it learns).
  writeFileSync(join(dir, "learned.md"), "");

  // Write agent.yaml using the identity: shorthand (per α-5).
  writeFileSync(join(dir, "agent.yaml"), agentYamlTemplate(id, opts.name, purpose, operatorName));

  // Write .env with empty values — operator fills in secrets before first run.
  writeFileSync(join(dir, ".env"), ENV_TEMPLATE);

  // Write .gitignore.
  writeFileSync(join(dir, ".gitignore"), GITIGNORE_TEMPLATE);

  return dir;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function agentYamlTemplate(
  id: string,
  name: string,
  purpose: string,
  operatorName: string,
): string {
  return `# Agent configuration — the source of truth for this Auggy agent.
# See docs at augment-1/docs/ for field reference.

id: ${id}
name: ${name}
purpose: "${purpose}"
operators:
  - "${operatorName}"

# identity shorthand — synthesizes a fileMemory@system entry from ./identity.md
# at parse time. Operators wanting non-default options (e.g. mutable: true)
# should drop this and add an explicit fileMemory augment instead.
identity: ./identity.md

engine:
  provider: anthropic        # or: openai, openrouter
  model: claude-sonnet-4-6   # openai: gpt-5 | openrouter: qwen/qwen3.5-397b-a17b
  maxContextTokens: 200000   # for openrouter, set per-model — defaults vary
  maxTokens: 4096            # sent as max_completion_tokens for openai/openrouter
  # reasoningEffort: medium  # optional: none|minimal|low|medium|high|xhigh
  # providerRouting:         # openrouter only — slugs not semantically validated
  #   only: [OpenAI]
  #   sort: price

settings:
  compactionStrategy: truncate
  maxInferenceLoops: 10

augments:
  - name: learned
    type: fileMemory
    options:
      label: learned
      source: ./learned.md
      mutable: true
      origin: system
      priority: high
      placement: preamble
      eviction: drop

  - name: memory
    type: layeredMemory
    options:
      backend: sqlite
      namespace: ${name}
      dbPath: ./memory.sqlite
      retentionDays: 90

  - name: budgets
    type: budgets
    options:
      dbPath: ./budgets.db
      caps:
        public:
          recognized:
            maxTurnsPerThread: 20
            maxTurnsPerDay: 50
            maxUsdPerDay: 1
          anonymous:
            maxTurnsPerThread: 5
      anonymousGlobalLimit: 30
      dailyBudgetUsd: 5

  - name: files
    type: filesystem
    options:
      mounts:
        - name: skills
          path: ./skills
          writable: false
        - name: workspace
          path: ./workspace
          writable: true
          deletable: true

  - name: fetch
    type: webFetch
    options:
      timeoutMs: 15000

  - name: turn-control
    type: turnControl

  - name: web
    type: webTransport
    options:
      port: 8080
      auth:
        type: bearer
        token: \${AUGGY_WEB_TOKEN}
      visitorTokens:
        signingKey: \${VISITOR_SIGNING_KEY}
`;
}

const ENV_TEMPLATE = `# Auggy agent secrets — this file is gitignored.
# Add your API keys and tokens here. Only the key matching the
# configured engine.provider in agent.yaml needs to be filled in.

ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# OPENROUTER_API_KEY=
AUGGY_WEB_TOKEN=
VISITOR_SIGNING_KEY=
# SUPABASE_URL=
# SUPABASE_SERVICE_KEY=
`;

const GITIGNORE_TEMPLATE = `.env
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
