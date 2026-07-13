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
import type { AdminInfoBlock, Augment, ContextBlock, TrustLevel, TurnState } from "../../types";
import {
  isSkillAllowedForTrust,
  readSkillFrontmatter,
  type SkillFrontmatter,
} from "../../cli/skill-frontmatter";

export interface SkillsOptions {
  /**
   * Absolute path to the directory containing skill subfolders. Each subfolder
   * should contain a SKILL.md with `name` + `description` YAML frontmatter.
   *
   * The augment-resolver converts relative paths against the agent dir before
   * construction (same pattern as manifest's file:// scheme), so the
   * augment factory only ever sees absolute paths.
   */
  dir: string;
}

interface DiscoveredSkill extends SkillFrontmatter {
  folder: string;
}

function effectiveTrustLevel(turn: TurnState | undefined): TrustLevel {
  return turn?.peer?.trustLevel ?? "creator";
}

function discoverSkills(dir: string, trustLevel?: TrustLevel): DiscoveredSkill[] {
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
    if (trustLevel && !isSkillAllowedForTrust(fm, trustLevel)) continue;
    out.push({ folder, name: fm.name, description: fm.description });
  }

  out.sort((a, b) => a.folder.localeCompare(b.folder));
  return out;
}

function buildBlockContent(discovered: DiscoveredSkill[]): string {
  const lines = [
    "# Skills",
    "",
    "Activation contract: when the current request matches a listed skill description, read that entry's exact `SKILL.md` path with `fs_read` before answering or using tools in that skill's domain. Attempt the read before claiming its documentation is unavailable.",
    "",
  ];
  for (const s of discovered) {
    lines.push(`- ${s.folder} — ${s.description} (read: \`skills/${s.folder}/SKILL.md\`)`);
  }
  return lines.join("\n");
}

export function skills(opts: SkillsOptions): Augment {
  const adminInfo = async (): Promise<AdminInfoBlock> => {
    const discovered = discoverSkills(opts.dir);
    return {
      augmentName: "skills",
      title: "Skills",
      sections: [
        {
          kind: "keyValue",
          rows: [
            { label: "Directory", value: opts.dir },
            { label: "Discovered", value: String(discovered.length) },
          ],
        },
        {
          kind: "table",
          columns: ["Folder", "Name", "Description"],
          caption: `${discovered.length} skill${discovered.length === 1 ? "" : "s"} loaded`,
          rows: discovered.map((s) => [s.folder, s.name ?? "—", s.description ?? ""]),
        },
        {
          kind: "status",
          level: discovered.length > 0 ? "ok" : "warn",
          message:
            discovered.length > 0
              ? "Skill manifest emitted on every turn."
              : "No skills discovered — directory empty or SKILL.md frontmatter unparseable.",
        },
      ],
    };
  };

  return {
    name: "skills",
    type: "skills",
    category: "capabilities",
    capabilities: ["context"],
    context: async (turn) => {
      const discovered = discoverSkills(opts.dir, effectiveTrustLevel(turn));
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
    adminInfo,
  };
}
