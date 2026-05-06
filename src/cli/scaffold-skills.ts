/**
 * Scaffold-skill helpers — copy bundled `src/augments/<name>/skill/` folders
 * into a scaffolded agent's `<agent-dir>/skills/<augment-name>/` directory,
 * and render the {SKILL_MANIFEST} block for the agent's identity.md.
 *
 * Per ADR-025 (augment-as-folder + skill bundling) Decision 3 and the
 * PR α foundation spec §C. Used by both `auggy create` and `auggy add` so
 * the two surfaces stay in sync.
 *
 * The tool-inventory mapping is hardcoded (not introspected from the augment
 * factories). Rationale: scaffold runs once at create-time; the mapping is
 * small and stable; introspection at scaffold-time would force importing the
 * augment factories purely for their tool names. Drift between actual tool
 * surface and the manifest entry is bounded by the boot-time skill validator
 * (PR α task 7) which warns at agent startup if a tool-providing augment is
 * mounted without a skill.
 */

import { existsSync, readFileSync, cpSync } from "node:fs";
import { resolve, join } from "node:path";

// ---------------------------------------------------------------------------
// Augment-name resolution
// ---------------------------------------------------------------------------

/**
 * Map an augment `type` (the YAML `type:` field, e.g. `webFetch`) to the
 * folder name under `src/augments/`. The folder convention is kebab-case;
 * the type identifier is camelCase. This lookup is the inverse of the
 * augment-resolver dispatch.
 *
 * Returned name doubles as the `<agent-dir>/skills/<name>/` directory name
 * so the model's identity-mounted skill manifest entries match the bundled
 * skill folder layout.
 */
const TYPE_TO_AUGMENT_FOLDER: Record<string, string> = {
  filesystem: "filesystem",
  layeredMemory: "layered-memory",
  webFetch: "web-fetch",
  orgContext: "org-context",
  bash: "bash",
  notify: "notify",
  turnControl: "turn-control",
  // Augments below intentionally have no skill folder today (no model-callable
  // tools, transport-only, or legacy). Listed for completeness so a lookup
  // never silently returns undefined for a known type.
  fileMemory: "file-memory",
  supabaseMemory: "supabase-memory",
  budgets: "budgets",
  webTransport: "web-transport",
  telegramTransport: "telegram-transport",
};

/**
 * Hardcoded tool inventory per augment folder name. Used to render the
 * {SKILL_MANIFEST} bullet list in identity.md. Drift between this map and
 * the actual augment tools is caught at agent boot by the skill validator.
 */
const TOOL_INVENTORY: Record<string, string> = {
  filesystem: "fs_read, fs_write, fs_list, fs_mkdir, fs_remove, fs_search",
  "layered-memory": "memory_read, memory_write, memory_search, memory_list, memory_forget",
  "web-fetch": "web_fetch",
  "org-context": "org_fetch",
  bash: "shell_exec, run_script",
  notify: "notify",
  "turn-control": "request_input",
};

/** Return the augment folder name for a YAML `type:` value, or `null` if unknown. */
export function augmentFolderForType(type: string): string | null {
  return TYPE_TO_AUGMENT_FOLDER[type] ?? null;
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
  const dir = resolve(import.meta.dir, "../augments", folder, "skill");
  return existsSync(dir) ? dir : null;
}

/**
 * Determine the SKILL.md frontmatter `description` for the augment's bundled
 * skill, used as the manifest bullet text. Falls back to the tool inventory
 * if the SKILL.md is missing or malformed (defensive — boot validator catches
 * the misconfiguration separately).
 */
function descriptionForSkill(folder: string): string | null {
  const dir = bundledSkillDir(folder);
  if (!dir) return null;
  const skillPath = join(dir, "SKILL.md");
  if (!existsSync(skillPath)) return null;
  try {
    const content = readFileSync(skillPath, "utf-8");
    return parseFrontmatterDescription(content);
  } catch {
    return null;
  }
}

function parseFrontmatterDescription(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const endIdx = content.indexOf("---", 3);
  if (endIdx < 0) return null;
  const block = content.slice(3, endIdx);
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line.toLowerCase().startsWith("description:")) continue;
    let value = line.slice("description:".length).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Skill copy + manifest rendering
// ---------------------------------------------------------------------------

/**
 * Copy the bundled skill folder for the given augment type into the agent
 * directory. No-op when the augment has no bundled skill (e.g. budgets,
 * file-memory, transport-only augments) or when the source folder is not
 * present on disk for some reason.
 *
 * Idempotent: re-running overwrites existing files (per ADR-025 Decision 2 —
 * operators opt into updates by re-scaffolding).
 */
export function copyBundledSkill(type: string, agentDir: string): boolean {
  const folder = TYPE_TO_AUGMENT_FOLDER[type];
  if (!folder) return false;
  const src = bundledSkillDir(folder);
  if (!src) return false;
  const dest = join(agentDir, "skills", folder);
  cpSync(src, dest, { recursive: true });
  return true;
}

/**
 * Build the {SKILL_MANIFEST} substitution string for identity.md. Walks the
 * provided augment types in order, emits one bullet per augment that has a
 * bundled skill folder, and prefixes the section with the conventional
 * "Available skills" header. Returns an empty string when no augments
 * contribute a skill — the heading is omitted entirely so identity.md
 * doesn't carry a dead section.
 */
export function buildSkillManifest(augmentTypes: string[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const type of augmentTypes) {
    const folder = TYPE_TO_AUGMENT_FOLDER[type];
    if (!folder) continue;
    if (seen.has(folder)) continue;
    if (!bundledSkillDir(folder)) continue;
    seen.add(folder);
    const description = descriptionForSkill(folder) ?? TOOL_INVENTORY[folder];
    const tools = TOOL_INVENTORY[folder];
    // Prefer the tool list over the long-form description in the manifest —
    // matches Critical Pattern §7's CORRECT example shape (tool inventory
    // per skill bullet, not prose). Fall back to the SKILL.md description
    // when no tool inventory is registered.
    const bullet = tools ?? description ?? folder;
    lines.push(`- \`skills/${folder}/SKILL.md\` — ${bullet}`);
  }
  if (lines.length === 0) return "";
  return [
    "## Available skills",
    "",
    "Read a skill guide with fs_read when you need guidance on your tools.",
    "",
    ...lines,
  ].join("\n");
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
  /** The augment types the agent will load — used to render the skill manifest. */
  augmentTypes: string[];
}

/**
 * Render identity.md from the bundled template using the provided values.
 *
 * Substitution targets each placeholder by exact token (`{AGENT_NAME}`,
 * `{PURPOSE}`, `{OPERATOR_NAME}`, `{SKILL_MANIFEST}`) — not a generic
 * `{...}` regex — so operator-supplied values containing literal braces
 * pass through unmodified. The {SKILL_MANIFEST} placeholder also strips a
 * trailing newline before substitution when the manifest is empty so the
 * generated identity.md doesn't end with two consecutive blank lines.
 *
 * Limitation: operator values land inside markdown text. An operator who
 * names their agent something that looks like a heading (`# Sneaky`) will
 * break the document's outline — but only for their own identity.md, with
 * no security impact (security rules sit outside the substitution targets
 * and the `{OPERATOR_NAME}` reference is inline prose, not a structural
 * element). Documented for posterity; not mitigated at v1.0.
 */
export function renderIdentityFromTemplate(values: IdentityTemplateValues): string {
  const skillManifest = buildSkillManifest(values.augmentTypes);
  let template = readIdentityTemplate();

  if (skillManifest === "") {
    // Drop the placeholder line and any leading blank line so we don't
    // leave a dead `## Available skills` section behind. Apply BEFORE
    // the single-pass replacement so the regex sees the original template
    // shape, not a partially-substituted string.
    template = template.replace(/\n+\{SKILL_MANIFEST\}\n?/, "\n");
  }

  // Single-pass substitution. The regex matches all four placeholder tokens
  // at once and the callback returns each token's value. An operator-supplied
  // value containing literal `{AGENT_NAME}` or another placeholder string
  // is NOT re-scanned — it's emitted verbatim, because String.prototype.replace
  // does not recurse into substituted text. This closes the sequential-pass
  // hole where a value of `{PURPOSE}` would have been overwritten by a later
  // token's substitution.
  return template.replace(
    /\{(AGENT_NAME|PURPOSE|OPERATOR_NAME|SKILL_MANIFEST)\}/g,
    (match, token: string) => {
      switch (token) {
        case "AGENT_NAME":
          return values.agentName;
        case "PURPOSE":
          return values.purpose;
        case "OPERATOR_NAME":
          return values.operatorName;
        case "SKILL_MANIFEST":
          return skillManifest;
        default:
          return match;
      }
    },
  );
}

/**
 * Replace every occurrence of `token` (a literal string, not a regex) with
 * `value` in `source`. Uses split/join so the replacement string is treated
 * as a literal and `$` characters in operator-supplied values aren't
 * interpreted as backreferences.
 */
function replaceToken(source: string, token: string, value: string): string {
  return source.split(token).join(value);
}
