/**
 * Server-side helpers for the console skills API.
 *
 * Skills live in two places:
 *   - `<agentDir>/skills/<folder>/SKILL.md` — installed (operator-editable)
 *   - `src/augments/<folder>/skill/SKILL.md` — bundled (read-only template
 *     shipped with the augment)
 *
 * Console skill endpoints need to:
 *   1. List every installed skill (with frontmatter + status).
 *   2. List every bundled skill that hasn't been installed yet ("available").
 *   3. Edit / remove / reset / install — all writing under `<agentDir>/skills/`.
 *
 * Each helper is small and pure; the route handler in `index.ts` composes
 * them. No filesystem traversal happens at request time without going
 * through the path guards defined below.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillFrontmatter } from "../../cli/skill-frontmatter";
import { augmentFolderForType, buildFolderToTypeMap } from "../../cli/scaffold-skills";
import {
  ensureManagedDirectory,
  inspectManagedDirectory,
  listManagedDirectoryNames,
  readManagedText,
  removeManagedTree,
  resolveManagedPath,
  writeManagedText,
} from "./admin-managed-files";

// ---------------------------------------------------------------------------
// Types surfaced to the SPA via /console/api/skills
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
  /**
   * Canonical type of the mounted augment that owns this bundled skill.
   * Absent for manual skills and bundled skills whose augment is not mounted.
   */
  fromAugmentType?: string;
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
   * normally `auggy create` / `auggy augment add` copies the bundled skill alongside
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
  const root = resolve(here, "../../augments");
  const candidate = resolve(root, folder, "skill");
  try {
    for (const path of [resolve(root, folder), candidate]) {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isDirectory()) return null;
    }
    const canonicalRoot = realpathSync.native(root);
    const canonicalCandidate = realpathSync.native(candidate);
    const rootPrefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
    if (!canonicalCandidate.startsWith(rootPrefix)) return null;

    let cursor = canonicalRoot;
    for (const part of relative(canonicalRoot, canonicalCandidate).split(sep)) {
      cursor = join(cursor, part);
      const info = lstatSync(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) return null;
    }
    return canonicalCandidate;
  } catch {
    return null;
  }
}

function readBundledSkillContent(folder: string): string | null {
  const dir = bundledSkillSourceDir(folder);
  if (!dir) return null;
  return readTrustedBundledFile(join(dir, "SKILL.md"));
}

function readTrustedBundledFile(file: string): string | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(descriptor);
    // Bundled sources live inside the trusted application tree. A hard link
    // does not change their resolved path or let a console request traverse
    // outside that tree, and package/worktree tooling may legitimately use
    // hard links. Managed destination files still require a single link.
    if (!info.isFile()) return null;
    return readFileSync(descriptor, "utf-8");
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
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
  const safe = validateSkillFolderName(folder);
  if (!safe) return null;
  return resolveManagedPath(agentDir, join("skills", safe));
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

function listInstalledFolders(agentDir: string | undefined): string[] {
  if (!agentDir) return [];
  const listed = listManagedDirectoryNames(agentDir, "skills");
  if ("error" in listed || "missing" in listed) return [];
  const folders: string[] = [];
  for (const name of listed.names) {
    const safe = validateSkillFolderName(name);
    if (!safe) continue;
    const child = inspectManagedDirectory(agentDir, join("skills", safe));
    if ("error" in child || !child.exists) continue;
    folders.push(safe);
  }
  folders.sort((a, b) => a.localeCompare(b));
  return folders;
}

function classifyInstalledSkill(folder: string, installedContent: string): SkillSource {
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
  const folderToType = buildFolderToTypeMap();

  const installed: InstalledSkillInfo[] = installedFolders.map((folder) => {
    let content = "";
    let contentBytes = 0;
    const file = readManagedText(agentDir, join("skills", folder, "SKILL.md"), MAX_SKILL_BYTES);
    if (!("error" in file) && !("missing" in file)) {
      content = file.content;
      contentBytes = file.contentBytes;
    }
    const fm: SkillFrontmatter | null = content ? parseFrontmatterFromString(content) : null;
    const source = content ? classifyInstalledSkill(folder, content) : "manual";
    const fromAugmentType = folderToType.get(folder);
    const isMountedOwner =
      fromAugmentType !== undefined &&
      (mountedAugmentTypes === undefined || mountedAugmentTypes.has(fromAugmentType));
    return {
      folder,
      name: fm?.name ?? null,
      description: fm?.description ?? null,
      source,
      ...(source !== "manual" && isMountedOwner ? { fromAugmentType } : {}),
      frontmatterValid: fm !== null,
      contentBytes,
    };
  });

  // Available bundled skills: gaps where the augment IS mounted but the
  // bundled SKILL.md is missing on disk. If a caller doesn't pass a mount
  // filter, fall back to showing all bundled skills (legacy callers + tests).
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
  const result = readManagedText(agentDir, join("skills", folder, "SKILL.md"), MAX_SKILL_BYTES);
  if ("error" in result) return result;
  if ("missing" in result) return { error: "skill not installed" };
  return { content: result.content };
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
  const ensured = ensureManagedDirectory(agentDir, join("skills", folder));
  if ("error" in ensured) return { ok: false, message: ensured.error };
  const result = writeManagedText(agentDir, join("skills", folder, "SKILL.md"), content, {
    maxBytes: MAX_SKILL_BYTES,
    mode: 0o600,
  });
  if ("error" in result) return { ok: false, message: result.error };
  return { ok: true, message: `Saved ${folder}/SKILL.md` };
}

export function removeInstalledSkill(agentDir: string | undefined, folder: string): MutationResult {
  const dir = installedSkillDir(agentDir, folder);
  if (!dir) return { ok: false, message: "invalid skill folder" };
  const inspected = inspectManagedDirectory(agentDir, join("skills", folder));
  if ("error" in inspected) return { ok: false, message: inspected.error };
  if (!inspected.exists) return { ok: false, message: "skill not installed" };
  const removed = removeManagedTree(agentDir, join("skills", folder));
  if ("error" in removed) return { ok: false, message: `remove failed: ${removed.error}` };
  return removed.removed
    ? { ok: true, message: `Removed ${folder}` }
    : { ok: false, message: "skill not installed" };
}

export function resetInstalledSkill(agentDir: string | undefined, folder: string): MutationResult {
  const src = bundledSkillSourceDir(folder);
  if (!src) return { ok: false, message: "no bundled skill for this folder" };
  const dest = installedSkillDir(agentDir, folder);
  if (!dest) return { ok: false, message: "invalid skill folder" };
  const inspected = inspectManagedDirectory(agentDir, join("skills", folder));
  if ("error" in inspected) return { ok: false, message: inspected.error };
  try {
    if (inspected.exists) {
      const removed = removeManagedTree(agentDir, join("skills", folder));
      if ("error" in removed) throw new Error(removed.error);
    }
    return copyBundledTree(agentDir, folder, src, "Reset");
  } catch {
    return { ok: false, message: "reset failed: managed tree changed or contains a symlink" };
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
  const inspected = inspectManagedDirectory(agentDir, join("skills", safe));
  if ("error" in inspected) return { ok: false, message: inspected.error };
  if (inspected.exists) {
    return { ok: false, message: `skill "${safe}" already exists — use Edit / Reset / Remove` };
  }
  const body = content ?? STARTER_SKILL_TEMPLATE.replace(/\{\{NAME\}\}/g, safe);
  if (Buffer.byteLength(body, "utf-8") > MAX_SKILL_BYTES) {
    return { ok: false, message: `SKILL.md exceeds ${MAX_SKILL_BYTES} bytes` };
  }
  const ensured = ensureManagedDirectory(agentDir, join("skills", safe));
  if ("error" in ensured) return { ok: false, message: ensured.error };
  const result = writeManagedText(agentDir, join("skills", safe, "SKILL.md"), body, {
    maxBytes: MAX_SKILL_BYTES,
    mode: 0o600,
  });
  if ("error" in result) return { ok: false, message: result.error };
  return { ok: true, message: `Created ${safe}` };
}

export function installBundledSkill(agentDir: string | undefined, folder: string): MutationResult {
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
  const inspected = inspectManagedDirectory(agentDir, join("skills", safe));
  if ("error" in inspected) return { ok: false, message: inspected.error };
  if (inspected.exists) return { ok: false, message: "skill already installed (use Reset)" };
  return copyBundledTree(agentDir, safe, src, "Installed");
}

function assertTreeHasNoSymlinks(root: string, requireSingleLink = true): void {
  const info = lstatSync(root);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("unsafe skill directory");
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error("unsafe skill symlink");
    if (entry.isDirectory()) {
      assertTreeHasNoSymlinks(path, requireSingleLink);
      continue;
    }
    const file = lstatSync(path);
    if (!entry.isFile() || !file.isFile() || (requireSingleLink && file.nlink !== 1)) {
      throw new Error("unsafe skill file");
    }
  }
}

function copyBundledTree(
  agentDir: string | undefined,
  folder: string,
  sourceRoot: string,
  verb: "Installed" | "Reset",
): MutationResult {
  try {
    // Bundled sources live in the trusted application tree. A hard link there
    // does not expand authority beyond code the same account can already
    // mutate; managed destination files still require exactly one link.
    assertTreeHasNoSymlinks(sourceRoot, false);
    const ensured = ensureManagedDirectory(agentDir, join("skills", folder));
    if ("error" in ensured) return { ok: false, message: ensured.error };
    copyBundledDirectory(agentDir, folder, sourceRoot, sourceRoot);
    return {
      ok: true,
      message:
        verb === "Installed"
          ? `Installed ${folder} from bundle`
          : `Reset ${folder} to bundled version`,
    };
  } catch {
    const dest = installedSkillDir(agentDir, folder);
    if (dest) {
      try {
        removeManagedTree(agentDir, join("skills", folder));
      } catch {
        // Leave a changed tree untouched rather than following it during cleanup.
      }
    }
    return { ok: false, message: `${verb.toLowerCase()} failed: unsafe bundled skill tree` };
  }
}

function copyBundledDirectory(
  agentDir: string | undefined,
  folder: string,
  sourceRoot: string,
  sourceDir: string,
): void {
  const relativeDir = relative(sourceRoot, sourceDir);
  if (relativeDir) {
    const ensured = ensureManagedDirectory(agentDir, join("skills", folder, relativeDir));
    if ("error" in ensured) throw new Error(ensured.error);
  }
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const source = join(sourceDir, entry.name);
    const destination = join("skills", folder, relativeDir, entry.name);
    if (entry.isSymbolicLink()) throw new Error("bundled skill contains a symlink");
    if (entry.isDirectory()) {
      copyBundledDirectory(agentDir, folder, sourceRoot, source);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error("bundled skill contains a non-regular file");
    }
    const content = readTrustedBundledFile(source);
    if (content === null) throw new Error("bundled skill contains an unsafe file");
    const written = writeManagedText(agentDir, destination, content, {
      maxBytes: MAX_SKILL_BYTES,
      mode: 0o600,
      createParents: true,
    });
    if ("error" in written) throw new Error(written.error);
  }
}

function augmentTypeForFolder(folder: string): string | null {
  const map = buildFolderToTypeMap();
  return map.get(folder) ?? null;
}

// Re-export `augmentFolderForType` so the route handler can do the inverse
// lookup without importing from `cli/`.
export { augmentFolderForType };
