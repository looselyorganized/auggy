/**
 * Bundled-skill content audit.
 *
 * Per identity.md security rule 3 ("don't disclose internal architecture")
 * and Codex pre-PR review of PR α: each `src/augments/<name>/skill/SKILL.md`
 * is loaded by the model on demand and may be paraphrased into peer-visible
 * responses. The skill content must therefore stay in functional terms —
 * no internal type names, factory function names, kernel hooks, or
 * facility-private concepts that would leak architecture if quoted.
 *
 * This test walks every bundled `skill/SKILL.md` and asserts no forbidden
 * substring appears. New skills added to the runtime are picked up
 * automatically (the test discovers via filesystem walk).
 *
 * Tool names (memory_write, web_fetch, fs_read, etc.) ARE the public API
 * surface and are explicitly allowed. The discriminator: forbidden terms
 * are camelCase factory names + LORF-private concepts + the internal
 * config file name; tool names are snake_case and stay legitimate.
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const AUGMENTS_DIR = join(import.meta.dir, "..", "..", "src", "augments");

/**
 * Forbidden substrings. A skill mentioning any of these leaks internal
 * implementation detail to a peer-visible context.
 */
const FORBIDDEN_SUBSTRINGS: string[] = [
  // Factory function names
  "layeredMemory",
  "webFetch",
  "fileMemory",
  "supabaseMemory",
  "telegramTransport",
  "webTransport",
  "turnControl",
  // Internal config file
  "agent.yaml",
  // Internal helpers
  "defineAugment",
  "defineTool",
  // LORF-private concepts
  "facility",
  "brain",
  "spine",
  // Operator-private references
  "Zip",
  "Michael",
];

/** Whole-word match for short ambiguous terms (e.g. "mesh" — would false-positive on "meshed"). */
const FORBIDDEN_WHOLE_WORDS: string[] = ["mesh"];

interface BundledSkill {
  augmentName: string;
  path: string;
  content: string;
  body: string;
}

function skillBody(content: string): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---", 4);
  if (end < 0) return content;
  return content.slice(end + "\n---".length);
}

function discoverBundledSkills(): BundledSkill[] {
  const out: BundledSkill[] = [];
  for (const entry of readdirSync(AUGMENTS_DIR)) {
    const augmentDir = join(AUGMENTS_DIR, entry);
    if (!statSync(augmentDir).isDirectory()) continue;
    const skillPath = join(augmentDir, "skill", "SKILL.md");
    if (!existsSync(skillPath)) continue;
    out.push({
      augmentName: entry,
      path: skillPath,
      content: readFileSync(skillPath, "utf-8"),
      body: skillBody(readFileSync(skillPath, "utf-8")),
    });
  }
  return out;
}

const skills = discoverBundledSkills();

describe("bundled-skill content audit", () => {
  test("at least one skill is discovered (test fixture sanity)", () => {
    expect(skills.length).toBeGreaterThan(0);
  });

  test("required frontmatter fields (name, description) are present", () => {
    for (const skill of skills) {
      const frontmatter = skill.content.split("---\n")[1] ?? "";
      expect(frontmatter, `${skill.augmentName} missing 'name:' in frontmatter`).toContain("name:");
      expect(frontmatter, `${skill.augmentName} missing 'description:' in frontmatter`).toContain(
        "description:",
      );
    }
  });

  test("no forbidden substrings (factory names, internal helpers, internal config file, LORF concepts, operator refs)", () => {
    // Case-insensitive matching: a lowercase variant ("michael" vs "Michael")
    // would otherwise slip past — Codex 2nd-pass review caught this on a prior
    // skill content sweep. Matching against a normalized haystack closes the gap.
    const failures: string[] = [];
    for (const skill of skills) {
      const haystack = skill.body.toLowerCase();
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        const needle = forbidden.toLowerCase();
        const idx = haystack.indexOf(needle);
        if (idx >= 0) {
          // Surrounding context from the ORIGINAL casing, not the lowercased
          // haystack — so the failure message reads naturally.
          const start = Math.max(0, idx - 30);
          const end = Math.min(skill.body.length, idx + forbidden.length + 30);
          const snippet = skill.body.slice(start, end).replace(/\n/g, "\\n");
          failures.push(
            `${skill.augmentName}: forbidden "${forbidden}" (case-insensitive) near …${snippet}…`,
          );
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  test("no forbidden whole-word matches", () => {
    const failures: string[] = [];
    for (const skill of skills) {
      for (const word of FORBIDDEN_WHOLE_WORDS) {
        const re = new RegExp(`\\b${word}\\b`, "i");
        const match = skill.body.match(re);
        if (match && match.index !== undefined) {
          const idx = match.index;
          const start = Math.max(0, idx - 30);
          const end = Math.min(skill.body.length, idx + word.length + 30);
          const snippet = skill.body.slice(start, end).replace(/\n/g, "\\n");
          failures.push(`${skill.augmentName}: forbidden whole-word "${word}" near …${snippet}…`);
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  test("skill body has at least one tool-name reference (snake_case identifier)", () => {
    const failures: string[] = [];
    for (const skill of skills) {
      const hasToolName = /\b[a-z]+_[a-z_]+\b/.test(skill.body);
      if (!hasToolName) {
        failures.push(
          `${skill.augmentName}: SKILL.md has no apparent tool-name reference (snake_case identifier)`,
        );
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
