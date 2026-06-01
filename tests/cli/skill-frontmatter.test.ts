import { describe, it, expect } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readSkillFrontmatter, parseSkillFrontmatter } from "@/cli/skill-frontmatter";

describe("parseSkillFrontmatter", () => {
  it("reads name + description", () => {
    const md = `---\nname: filesystem\ndescription: Read and write files\n---\n\n# body`;
    const out = parseSkillFrontmatter(md);
    expect(out).toEqual({ name: "filesystem", description: "Read and write files" });
  });

  it("returns null when frontmatter is absent", () => {
    expect(parseSkillFrontmatter("# just a heading\n\nbody")).toBeNull();
  });

  it("returns null when frontmatter is malformed YAML", () => {
    expect(parseSkillFrontmatter("---\nname: [unclosed\n---\nbody")).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(parseSkillFrontmatter("---\nname: foo\n---\nbody")).toBeNull();
    expect(parseSkillFrontmatter("---\ndescription: foo\n---\nbody")).toBeNull();
  });

  it("ignores extra frontmatter fields without erroring (forward-compat)", () => {
    const md = `---\nname: foo\ndescription: bar\nwhen_to_use: future\n---\nbody`;
    expect(parseSkillFrontmatter(md)).toEqual({ name: "foo", description: "bar" });
  });

  it("tolerates CRLF line endings", () => {
    const md = `---\r\nname: foo\r\ndescription: bar\r\n---\r\nbody`;
    expect(parseSkillFrontmatter(md)).toEqual({ name: "foo", description: "bar" });
  });
});

describe("readSkillFrontmatter", () => {
  it("reads a file and parses it", () => {
    // mkdtempSync — atomic creation under the OS temp dir (avoids the
    // predictable-temp-path / TOCTOU class CodeQL flags as js/insecure-temporary-file).
    const dir = mkdtempSync(join(tmpdir(), "auggy-skill-fm-"));
    const path = join(dir, "SKILL.md");
    writeFileSync(path, `---\nname: ok\ndescription: works\n---\nbody`);
    try {
      expect(readSkillFrontmatter(path)).toEqual({ name: "ok", description: "works" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when file does not exist", () => {
    expect(readSkillFrontmatter("/nonexistent/SKILL.md")).toBeNull();
  });
});

describe("bundled skill frontmatter", () => {
  const bundledSkills = [
    ["filesystem", "filesystem"],
    ["layeredMemory", "layeredMemory"],
    ["webFetch", "webFetch"],
    ["knowledge", "knowledge"],
    ["bash", "bash"],
    ["notify", "notify"],
    ["turnControl", "turnControl"],
    ["visitorAuth", "visitorAuth"],
  ] as const;

  for (const [folder, expectedName] of bundledSkills) {
    it(`${folder}/skill/SKILL.md has parseable frontmatter`, () => {
      const path = resolve(import.meta.dir, `../../src/augments/${folder}/skill/SKILL.md`);
      const fm = readSkillFrontmatter(path);
      expect(fm).not.toBeNull();
      expect(fm!.name).toBe(expectedName);
      expect(fm!.description.length).toBeGreaterThan(20);
    });
  }
});
