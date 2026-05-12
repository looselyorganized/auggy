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

export interface SkillFrontmatter {
  name: string;
  description: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

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

  return { name: obj.name, description: obj.description };
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
