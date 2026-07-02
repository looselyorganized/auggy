/**
 * Skill frontmatter reader for ADR-030.
 *
 * Reads the YAML frontmatter block from a SKILL.md file. Returns null when the
 * frontmatter is absent, malformed, or missing required fields — callers
 * always have a graceful-fallback path (skill is not listed) rather than a
 * crash. The boot-time skill validator (`skill-validator.ts`) catches the
 * "tool-providing augment with no parseable frontmatter" case separately.
 *
 * Source of truth for skill `name` + `description` per agentskills.io.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { TrustLevel } from "../types";

export interface SkillFrontmatter {
  name: string;
  description: string;
  allowedTrustLevels?: TrustLevel[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const VALID_TRUST_LEVELS = new Set<TrustLevel>(["creator", "agent", "public"]);

function parseAllowedTrustLevels(value: unknown): TrustLevel[] | null {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value];
  if (raw.length === 0) return null;

  const out: TrustLevel[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !VALID_TRUST_LEVELS.has(item as TrustLevel)) {
      return null;
    }
    const trustLevel = item as TrustLevel;
    if (!out.includes(trustLevel)) out.push(trustLevel);
  }
  return out;
}

export function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;
  const raw = match[1]!;

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.length === 0) return null;
  if (typeof obj.description !== "string" || obj.description.length === 0) return null;
  const allowedTrustLevels = parseAllowedTrustLevels(obj.allowedTrustLevels);
  if (allowedTrustLevels === null) return null;

  const out: SkillFrontmatter = { name: obj.name, description: obj.description };
  if (allowedTrustLevels.length > 0) out.allowedTrustLevels = allowedTrustLevels;
  return out;
}

export function readSkillFrontmatter(path: string): SkillFrontmatter | null {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  return parseSkillFrontmatter(content);
}

export function isSkillAllowedForTrust(fm: SkillFrontmatter, trustLevel: TrustLevel): boolean {
  return fm.allowedTrustLevels === undefined || fm.allowedTrustLevels.includes(trustLevel);
}
