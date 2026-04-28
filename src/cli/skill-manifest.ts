/**
 * Skill manifest scanner — reads skills directories and extracts
 * SKILL.md frontmatter to build the skill manifest block for the
 * agent's identity file.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillEntry } from "./types";

/**
 * Scan a skills directory for SKILL.md files and extract name +
 * description from their YAML frontmatter.
 *
 * Expected structure: skills/<name>/SKILL.md with frontmatter:
 *   ---
 *   name: <name>
 *   description: <description>
 *   ---
 */
export function scanSkillManifest(skillsDir: string): SkillEntry[] {
  if (!existsSync(skillsDir)) return [];

  const entries: SkillEntry[] = [];

  for (const dir of readdirSync(skillsDir)) {
    const skillPath = join(skillsDir, dir, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    try {
      const content = readFileSync(skillPath, "utf-8");
      const parsed = parseFrontmatter(content);
      if (parsed.name && parsed.description) {
        entries.push({
          name: parsed.name,
          description: parsed.description,
          path: `skills/${dir}/SKILL.md`,
        });
      }
    } catch {
      // Skip unparseable SKILL.md files.
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Generate the markdown skill manifest block for an identity file.
 */
export function renderSkillManifest(entries: SkillEntry[]): string {
  if (entries.length === 0) {
    return "## Available skills\n\nNo skills installed yet. Add SKILL.md files to `skills/<name>/SKILL.md`.";
  }

  const lines = [
    "## Available skills",
    "",
    "Read a skill guide with fs_read when you need guidance on your tools.",
    "",
  ];

  for (const entry of entries) {
    lines.push(`- \`${entry.path}\` — ${entry.description}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Frontmatter parser (minimal, no yaml dependency)
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!content.startsWith("---")) return result;

  const endIdx = content.indexOf("---", 3);
  if (endIdx < 0) return result;

  const block = content.slice(3, endIdx).trim();
  for (const line of block.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Strip surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }

  return result;
}
