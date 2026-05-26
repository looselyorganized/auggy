/**
 * Server-side helpers for the `/admin` Skills tab.
 *
 * Skills live in two places:
 *   - `<agentDir>/skills/<folder>/SKILL.md` — installed (operator-editable)
 *   - `src/augments/<folder>/skill/SKILL.md` — bundled (read-only template
 *     shipped with the augment)
 *
 * The Skills tab needs to:
 *   1. List every installed skill (with frontmatter + status).
 *   2. List every bundled skill that hasn't been installed yet ("available").
 *   3. Edit / remove / reset / install — all writing under `<agentDir>/skills/`.
 *
 * Each helper is small and pure; the route handler in `index.ts` composes
 * them. No filesystem traversal happens at request time without going
 * through the path guards defined below.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readSkillFrontmatter, type SkillFrontmatter } from "../../cli/skill-frontmatter";
import { augmentFolderForType, buildFolderToTypeMap } from "../../cli/scaffold-skills";

// ---------------------------------------------------------------------------
// Types surfaced to the SPA via /admin/api/skills
// ---------------------------------------------------------------------------

export type SkillSource = "bundled" | "modified" | "manual";

export interface InstalledSkillInfo {
  /** Folder name under `<agentDir>/skills/`. Stable identifier. */
  folder: string;
  /** YAML `name` from frontmatter. `null` when frontmatter is missing/invalid. */
  name: string | null;
  /** YAML `description` from frontmatter. `null` when frontmatter is missing/invalid. */
  description: string | null;
  /** Source classification — drives the Edit / Remove / Reset affordances. */
  source: SkillSource;
  /** True when the SKILL.md frontmatter parses cleanly (validator-friendly). */
  frontmatterValid: boolean;
  /** SKILL.md size in bytes (raw file, no parsing). */
  contentBytes: number;
}

export interface AvailableSkillInfo {
  folder: string;
  name: string | null;
  description: string | null;
  /** The augment type whose `src/augments/<folder>/skill/SKILL.md` is the source. */
  fromAugmentType: string;
}

export interface SkillsInfo {
  installed: InstalledSkillInfo[];
  /**
   * Bundled skills whose augment is currently mounted but whose SKILL.md is
   * NOT on disk under `<agentDir>/skills/<folder>/`. These represent gaps —
   * normally `auggy create` / `auggy add` copies the bundled skill alongside
   * the augment. A non-empty list means the operator deleted the file, the
   * agent was scaffolded before the augment shipped its skill, or the agent
   * was assembled outside the scaffold flow (rare).
   */
  available: AvailableSkillInfo[];
  /**
   * Operator's skills directory on disk. Surfaced so the SPA can display
   * the path in the empty state ("No skills installed at …").
   */
  skillsDir: string | null;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve `<repoRoot>/src/augments/<folder>/skill/`. Mirrors the resolution
 * in `cli/scaffold-skills.ts` (`bundledSkillDir`) but exported here so the
 * route handler doesn't import private CLI helpers.
 */
export function bundledSkillSourceDir(folder: string): string | null {
  // `import.meta.url` resolves relative to THIS file: `src/transports/admin/`.
  // From there → up to `src/`, then into `augments/<folder>/skill/`.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "../../augments", folder, "skill");
  return existsSync(candidate) ? candidate : null;
}

function readBundledSkillContent(folder: string): string | null {
  const dir = bundledSkillSourceDir(folder);
  if (!dir) return null;
  const file = join(dir, "SKILL.md");
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Validate a caller-supplied skill folder name. Rejects path-traversal
 * characters and empty strings. The folder name must not contain path
 * separators — it's a single directory under `<agentDir>/skills/`.
 *
 * Returns the normalized folder name on success, `null` on rejection.
 */
export function validateSkillFolderName(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 64) return null;
  if (trimmed.includes("/") || trimmed.includes("\\")) return null;
  if (trimmed === "." || trimmed === "..") return null;
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Compose the absolute installed-skill directory path and verify it stays
 * inside `<agentDir>/skills/`. Returns `null` for invalid folder names or
 * when `agentDir` is unset.
 */
export function installedSkillDir(agentDir: string | undefined, folder: string): string | null {
  if (!agentDir) return null;
  const safe = validateSkillFolderName(folder);
  if (!safe) return null;
  const base = join(agentDir, "skills");
  const full = join(base, safe);
  const baseWithSep = base.endsWith(sep) ? base : base + sep;
  if (!full.startsWith(baseWithSep)) return null;
  return full;
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

function listInstalledFolders(agentDir: string | undefined): string[] {
  if (!agentDir) return [];
  const base = join(agentDir, "skills");
  if (!existsSync(base)) return [];
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }
  const folders: string[] = [];
  for (const name of entries) {
    const safe = validateSkillFolderName(name);
    if (!safe) continue;
    try {
      if (!statSync(join(base, safe)).isDirectory()) continue;
    } catch {
      continue;
    }
    folders.push(safe);
  }
  folders.sort((a, b) => a.localeCompare(b));
  return folders;
}

function classifyInstalledSkill(
  folder: string,
  installedContent: string,
): SkillSource {
  const bundled = readBundledSkillContent(folder);
  if (!bundled) return "manual";
  return bundled === installedContent ? "bundled" : "modified";
}

/**
 * Collect skills info. `mountedAugmentTypes` is the set of augment `type`
 * values currently mounted on the agent — used to filter "available" so we
 * only surface gaps for augments the operator actually has. Pass an empty
 * Set or `undefined` to opt out of the filter (legacy behavior).
 */
export function collectSkillsInfo(
  agentDir: string | undefined,
  mountedAugmentTypes?: ReadonlySet<string>,
): SkillsInfo {
  const installedFolders = listInstalledFolders(agentDir);
  const installedSet = new Set(installedFolders);

  const installed: InstalledSkillInfo[] = installedFolders.map((folder) => {
    const dir = installedSkillDir(agentDir, folder)!;
    const file = join(dir, "SKILL.md");
    let content = "";
    let contentBytes = 0;
    try {
      content = readFileSync(file, "utf-8");
      contentBytes = Buffer.byteLength(content, "utf-8");
    } catch {
      // file missing or unreadable — surfaced as frontmatterValid=false below
    }
    const fm: SkillFrontmatter | null = content ? readSkillFrontmatter(file) : null;
    return {
      folder,
      name: fm?.name ?? null,
      description: fm?.description ?? null,
      source: content ? classifyInstalledSkill(folder, content) : "manual",
      frontmatterValid: fm !== null,
      contentBytes,
    };
  });

  // Available bundled skills: gaps where the augment IS mounted but the
  // bundled SKILL.md is missing on disk. If a caller doesn't pass a mount
  // filter, fall back to showing all bundled skills (legacy callers + tests).
  const folderToType = buildFolderToTypeMap();
  const available: AvailableSkillInfo[] = [];
  for (const [folder, type] of folderToType) {
    if (installedSet.has(folder)) continue;
    if (mountedAugmentTypes && !mountedAugmentTypes.has(type)) continue;
    const bundled = readBundledSkillContent(folder);
    if (!bundled) continue;
    const fm = parseFrontmatterFromString(bundled);
    available.push({
      folder,
      name: fm?.name ?? null,
      description: fm?.description ?? null,
      fromAugmentType: type,
    });
  }
  available.sort((a, b) => a.folder.localeCompare(b.folder));

  return {
    installed,
    available,
    skillsDir: agentDir ? join(agentDir, "skills") : null,
  };
}

function parseFrontmatterFromString(content: string): SkillFrontmatter | null {
  // Re-uses parseSkillFrontmatter via the existing reader's logic, but
  // operates on an in-memory string (no second filesystem read for bundles
  // we already loaded).
  // Inlined to avoid exposing a new export from skill-frontmatter just for
  // this helper.
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return null;
  try {
    const yaml = require("yaml") as { parse: (s: string) => unknown };
    const parsed = yaml.parse(m[1]!);
    if (parsed === null || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.name !== "string" || obj.name.length === 0) return null;
    if (typeof obj.description !== "string" || obj.description.length === 0) return null;
    return { name: obj.name, description: obj.description };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

const MAX_SKILL_BYTES = 256 * 1024; // 256 KiB

export interface MutationResult {
  ok: boolean;
  message: string;
}

export function readInstalledSkillContent(
  agentDir: string | undefined,
  folder: string,
): { content: string } | { error: string } {
  const dir = installedSkillDir(agentDir, folder);
  if (!dir) return { error: "invalid skill folder" };
  const file = join(dir, "SKILL.md");
  if (!existsSync(file)) return { error: "skill not installed" };
  try {
    return { content: readFileSync(file, "utf-8") };
  } catch (err) {
    return { error: `unreadable: ${(err as Error).message}` };
  }
}

export function writeInstalledSkillContent(
  agentDir: string | undefined,
  folder: string,
  content: string,
): MutationResult {
  const dir = installedSkillDir(agentDir, folder);
  if (!dir) return { ok: false, message: "invalid skill folder" };
  if (Buffer.byteLength(content, "utf-8") > MAX_SKILL_BYTES) {
    return { ok: false, message: `SKILL.md exceeds ${MAX_SKILL_BYTES} bytes` };
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
    return { ok: true, message: `Saved ${folder}/SKILL.md` };
  } catch (err) {
    return { ok: false, message: `write failed: ${(err as Error).message}` };
  }
}

export function removeInstalledSkill(
  agentDir: string | undefined,
  folder: string,
): MutationResult {
  const dir = installedSkillDir(agentDir, folder);
  if (!dir) return { ok: false, message: "invalid skill folder" };
  if (!existsSync(dir)) return { ok: false, message: "skill not installed" };
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, message: `Removed ${folder}` };
  } catch (err) {
    return { ok: false, message: `remove failed: ${(err as Error).message}` };
  }
}

export function resetInstalledSkill(
  agentDir: string | undefined,
  folder: string,
): MutationResult {
  const src = bundledSkillSourceDir(folder);
  if (!src) return { ok: false, message: "no bundled skill for this folder" };
  const dest = installedSkillDir(agentDir, folder);
  if (!dest) return { ok: false, message: "invalid skill folder" };
  try {
    // Remove and recopy — atomic enough for a local workbench, no concurrent
    // writers. Avoids leaving stale auxiliary files when the bundled tree shrinks.
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
    return { ok: true, message: `Reset ${folder} to bundled version` };
  } catch (err) {
    return { ok: false, message: `reset failed: ${(err as Error).message}` };
  }
}

const STARTER_SKILL_TEMPLATE = `---
name: {{NAME}}
description: One sentence the model reads to decide when to invoke this skill.
---

# {{NAME}}

When to use:
- Describe the situation that calls for this skill.
- Be specific so the model doesn't reach for it unnecessarily.

How to use:
1. Step-by-step usage. Reference the agent's tools by name.
2. Show example inputs / arguments where useful.

Cautions:
- Anything the model should avoid; edge cases; things to confirm with the operator.
`;

/**
 * Create a new operator-authored skill at `<agentDir>/skills/<folder>/SKILL.md`.
 * Refuses if the folder already exists (use Edit / Reset / Remove instead).
 * `content` is optional — when omitted, a starter template is written with
 * the folder name interpolated into `name` so the frontmatter is valid out
 * of the box.
 */
export function createSkill(
  agentDir: string | undefined,
  folder: string,
  content?: string,
): MutationResult {
  if (!agentDir) return { ok: false, message: "agentDir not configured" };
  const safe = validateSkillFolderName(folder);
  if (!safe) {
    return {
      ok: false,
      message: "invalid folder name (letters, digits, dot/dash/underscore only, max 64 chars)",
    };
  }
  const dir = installedSkillDir(agentDir, safe);
  if (!dir) return { ok: false, message: "invalid skill folder" };
  if (existsSync(dir)) {
    return { ok: false, message: `skill "${safe}" already exists — use Edit / Reset / Remove` };
  }
  const body = content ?? STARTER_SKILL_TEMPLATE.replace(/\{\{NAME\}\}/g, safe);
  if (Buffer.byteLength(body, "utf-8") > MAX_SKILL_BYTES) {
    return { ok: false, message: `SKILL.md exceeds ${MAX_SKILL_BYTES} bytes` };
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), body, "utf-8");
    return { ok: true, message: `Created ${safe}` };
  } catch (err) {
    return { ok: false, message: `create failed: ${(err as Error).message}` };
  }
}

export function installBundledSkill(
  agentDir: string | undefined,
  folder: string,
): MutationResult {
  if (!agentDir) return { ok: false, message: "agentDir not configured" };
  const safe = validateSkillFolderName(folder);
  if (!safe) return { ok: false, message: "invalid skill folder" };
  // Confirm the folder maps to a known augment with a bundled skill.
  const type = augmentTypeForFolder(safe);
  if (!type) return { ok: false, message: "unknown skill folder" };
  const src = bundledSkillSourceDir(safe);
  if (!src) return { ok: false, message: "bundled skill not on disk" };
  const dest = installedSkillDir(agentDir, safe);
  if (!dest) return { ok: false, message: "invalid skill folder" };
  if (existsSync(dest)) return { ok: false, message: "skill already installed (use Reset)" };
  try {
    cpSync(src, dest, { recursive: true });
    return { ok: true, message: `Installed ${safe} from bundle` };
  } catch (err) {
    return { ok: false, message: `install failed: ${(err as Error).message}` };
  }
}

function augmentTypeForFolder(folder: string): string | null {
  const map = buildFolderToTypeMap();
  return map.get(folder) ?? null;
}

// Re-export `augmentFolderForType` so the route handler can do the inverse
// lookup without importing from `cli/`.
export { augmentFolderForType };
