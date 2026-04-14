import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { scanSkillManifest, renderSkillManifest } from "../../src/cli/skill-manifest";

const TMP = join(import.meta.dir, ".tmp-skill-test");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("scanSkillManifest", () => {
  test("extracts name and description from SKILL.md frontmatter", () => {
    mkdirSync(join(TMP, "memory"), { recursive: true });
    writeFileSync(
      join(TMP, "memory", "SKILL.md"),
      '---\nname: memory\ndescription: "When and how to use memory tools"\n---\n\n# Memory',
    );

    const entries = scanSkillManifest(TMP);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("memory");
    expect(entries[0]!.description).toBe("When and how to use memory tools");
    expect(entries[0]!.path).toBe("skills/memory/SKILL.md");
  });

  test("returns sorted entries", () => {
    mkdirSync(join(TMP, "zebra"), { recursive: true });
    mkdirSync(join(TMP, "alpha"), { recursive: true });
    writeFileSync(join(TMP, "zebra", "SKILL.md"), "---\nname: zebra\ndescription: Z skill\n---\n");
    writeFileSync(join(TMP, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: A skill\n---\n");

    const entries = scanSkillManifest(TMP);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.name).toBe("alpha");
    expect(entries[1]!.name).toBe("zebra");
  });

  test("skips directories without SKILL.md", () => {
    mkdirSync(join(TMP, "empty"), { recursive: true });
    const entries = scanSkillManifest(TMP);
    expect(entries).toHaveLength(0);
  });

  test("skips SKILL.md without required frontmatter", () => {
    mkdirSync(join(TMP, "bad"), { recursive: true });
    writeFileSync(join(TMP, "bad", "SKILL.md"), "# No frontmatter here");
    const entries = scanSkillManifest(TMP);
    expect(entries).toHaveLength(0);
  });

  test("returns empty array for non-existent directory", () => {
    const entries = scanSkillManifest("/nonexistent/path");
    expect(entries).toHaveLength(0);
  });
});

describe("renderSkillManifest", () => {
  test("renders entries as markdown list", () => {
    const result = renderSkillManifest([
      { name: "memory", description: "Memory tools", path: "skills/memory/SKILL.md" },
      { name: "filesystem", description: "File tools", path: "skills/filesystem/SKILL.md" },
    ]);
    expect(result).toContain("## Available skills");
    expect(result).toContain("`skills/memory/SKILL.md` — Memory tools");
    expect(result).toContain("`skills/filesystem/SKILL.md` — File tools");
  });

  test("renders a message when no skills are installed", () => {
    const result = renderSkillManifest([]);
    expect(result).toContain("No skills installed");
  });
});
