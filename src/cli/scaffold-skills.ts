/**
 * Scaffold-skill helpers — copy bundled `src/augments/<name>/skill/` folders
 * into a scaffolded agent's `<agent-dir>/skills/<augment-name>/` directory,
 * and render identity.md from the bundled template.
 *
 * Per ADR-025 (augment-as-folder + skill bundling) Decision 3 and ADR-030
 * (model-facing skill surface separation): identity.md no longer carries
 * the skill manifest. The runtime's `skills` augment surfaces the listing
 * from each SKILL.md's YAML frontmatter; this module only handles disk-copy
 * + template substitution for the three identity-level placeholders
 * (AGENT_NAME, PURPOSE, OPERATOR_NAME).
 */

import { cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Augment-name resolution
// ---------------------------------------------------------------------------

const AUGMENTS_ROOT = resolve(import.meta.dir, "../augments");

function augmentSourceDir(type: string): string {
  return resolve(AUGMENTS_ROOT, type);
}

/** Return the agent skill folder name for a YAML `type:` value, or `null` if unknown. */
export function augmentFolderForType(type: string): string | null {
  if (!type) return null;
  return existsSync(augmentSourceDir(type)) ? type : null;
}

/**
 * Valid built-in skill names are canonical augment type names.
 */
export function buildFolderToTypeMap(): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const entry of readdirSync(AUGMENTS_ROOT, { withFileTypes: true })) {
    if (entry.isDirectory()) map.set(entry.name, entry.name);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Bundled-skill source resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the on-disk location of the bundled `src/augments/<folder>/skill/`
 * directory relative to this module. Returns `null` if the augment has no
 * bundled skill folder.
 */
function bundledSkillDir(folder: string): string | null {
  const dir = resolve(AUGMENTS_ROOT, folder, "skill");
  return existsSync(dir) ? dir : null;
}

// ---------------------------------------------------------------------------
// Skill copy
// ---------------------------------------------------------------------------

/**
 * Copy the bundled skill folder for the given augment type into the agent
 * directory. No-op when the augment has no bundled skill (e.g. budgets,
 * file-memory, transport-only augments, the `skills` augment itself) or when
 * the source folder is not present on disk.
 *
 * Idempotent: re-running overwrites existing files (per ADR-025 Decision 2 —
 * operators opt into updates by re-scaffolding).
 */
export function copyBundledSkill(type: string, agentDir: string): boolean {
  const src = bundledSkillDir(type);
  if (!src) return false;
  const dest = join(agentDir, "skills", type);
  cpSync(src, dest, { recursive: true });
  return true;
}

// ---------------------------------------------------------------------------
// identity.md template substitution
// ---------------------------------------------------------------------------

/**
 * The on-disk path to the identity.md template shipped under
 * `src/scaffold-templates/`. Resolved relative to this module so it works
 * both from source (Bun) and from a bundle that preserves the layout.
 */
const IDENTITY_TEMPLATE_PATH = resolve(import.meta.dir, "../scaffold-templates/identity.md");

/**
 * Read the identity.md template once. The template is part of the source
 * tree, never user-supplied, so failure to read it is a programming error.
 */
function readIdentityTemplate(): string {
  return readFileSync(IDENTITY_TEMPLATE_PATH, "utf-8");
}

export interface IdentityTemplateValues {
  /** The agent's name as written in agent.yaml. */
  agentName: string;
  /** A one-sentence agent purpose ("a helpful assistant" by default). */
  purpose: string;
  /** The operator's name ("the operator" by default). */
  operatorName: string;
}

/**
 * Render identity.md from the bundled template using the provided values.
 *
 * Substitution targets three placeholder tokens by exact name (`{AGENT_NAME}`,
 * `{PURPOSE}`, `{OPERATOR_NAME}`) — not a generic `{...}` regex — so
 * operator-supplied values containing literal braces pass through unmodified.
 * Single-pass replacement means an operator-supplied value containing
 * `{AGENT_NAME}` or any other placeholder is emitted verbatim and is NOT
 * re-scanned by a subsequent substitution.
 *
 * Per ADR-030: the previous `{SKILL_MANIFEST}` placeholder is gone. Skill
 * discovery is the runtime `skills` augment's responsibility, not the
 * identity file's.
 *
 * Limitation: operator values land inside markdown text. An operator who
 * names their agent something that looks like a heading (`# Sneaky`) will
 * break the document's outline — but only for their own identity.md, with
 * no security impact (security rules sit outside the substitution targets
 * and the `{OPERATOR_NAME}` reference is inline prose, not a structural
 * element). Documented for posterity; not mitigated at v1.0.
 */
export function renderIdentityFromTemplate(values: IdentityTemplateValues): string {
  const template = readIdentityTemplate();

  return template.replace(/\{(AGENT_NAME|PURPOSE|OPERATOR_NAME)\}/g, (match, token: string) => {
    switch (token) {
      case "AGENT_NAME":
        return values.agentName;
      case "PURPOSE":
        return values.purpose;
      case "OPERATOR_NAME":
        return values.operatorName;
      default:
        return match;
    }
  });
}
