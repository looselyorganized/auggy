/**
 * Skills augment — emits one context block listing the agent's mounted skills.
 *
 * Per ADR-030 (model-facing skill surface separation): identity stays
 * identity; the kernel surfaces the skill manifest via this augment, sourced
 * from each SKILL.md's YAML frontmatter (agentskills.io standard). Activation
 * is `fs_read` via the filesystem augment; the full SKILL.md body is never
 * boot-loaded.
 *
 * The augment is read-only and emits no tools. On every `context()` call it
 * walks `options.dir`, reading frontmatter from `<dir>/<folder>/SKILL.md`.
 * Subdirectories without a SKILL.md, with unparseable frontmatter, or with
 * missing required fields are silently skipped — the boot-time skill
 * validator (`src/cli/skill-validator.ts`) surfaces those operator-facing.
 *
 * The skill folder name (not the frontmatter `name` field) is the canonical
 * model-facing identifier in the listing, because the model invokes the
 * skill by file path (`fs_read skills/<folder>/SKILL.md`) — using the
 * folder name keeps the listing entry and the read path aligned.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Augment, ContextBlock } from "../../types";
import { readSkillFrontmatter, type SkillFrontmatter } from "../../cli/skill-frontmatter";

export interface SkillsOptions {
  /**
   * Absolute path to the directory containing skill subfolders. Each subfolder
   * should contain a SKILL.md with `name` + `description` YAML frontmatter.
   *
   * The augment-resolver converts relative paths against the agent dir before
   * construction (same pattern as orgContext's file:// scheme), so the
   * augment factory only ever sees absolute paths.
   */
  dir: string;
}

interface DiscoveredSkill extends SkillFrontmatter {
  folder: string;
}

function discoverSkills(dir: string): DiscoveredSkill[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const out: DiscoveredSkill[] = [];
  for (const folder of entries) {
    const sub = join(dir, folder);
    let isDir = false;
    try {
      isDir = statSync(sub).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const fm = readSkillFrontmatter(join(sub, "SKILL.md"));
    if (fm === null) continue;
    out.push({ folder, name: fm.name, description: fm.description });
  }

  out.sort((a, b) => a.folder.localeCompare(b.folder));
  return out;
}

function buildBlockContent(discovered: DiscoveredSkill[]): string {
  const lines = [
    "# Skills",
    "",
    "Each skill is a guide stored on disk. Read a guide with `fs_read skills/<folder>/SKILL.md` before using its tools when you need usage detail.",
    "",
  ];
  for (const s of discovered) {
    lines.push(`- ${s.folder} — ${s.description}`);
  }
  return lines.join("\n");
}

export function skills(opts: SkillsOptions): Augment {
  return {
    name: "skills",
    capabilities: ["context"],
    context: async () => {
      const discovered = discoverSkills(opts.dir);
      if (discovered.length === 0) return [];
      const block: ContextBlock = {
        source: "skills",
        content: buildBlockContent(discovered),
        placement: "system",
        priority: "required",
        eviction: "never",
        origin: "operator",
        provenance: "augment",
        ttl: "persistent",
      };
      return [block];
    },
  };
}
