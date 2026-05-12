/**
 * Tests for the built-in `skills` augment (ADR-030).
 *
 * The augment scans a configured directory, reads YAML frontmatter from
 * each `<dir>/<folder>/SKILL.md`, and emits ONE system-placement context
 * block listing them. Activation (full SKILL.md body) is `fs_read` via the
 * filesystem augment, not this surface.
 */

import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { skills } from "@/augments/skills";
import type { TurnState } from "@/types";

const stubTurn: TurnState = {
  turnId: "t1",
  threadId: "th1",
  trigger: {
    type: "message",
    turnId: "t1",
    timestamp: Date.now(),
    payload: {} as never,
  },
  peer: null,
  toolCallsSoFar: 0,
  turnStartedAt: Date.now(),
  metadata: {},
};

function makeSkillDir(): string {
  // mkdtempSync — atomic creation under the OS temp dir (avoids the
  // predictable-temp-path / TOCTOU class CodeQL flags as js/insecure-temporary-file).
  const root = mkdtempSync(join(tmpdir(), "auggy-skills-"));
  mkdirSync(join(root, "filesystem"), { recursive: true });
  mkdirSync(join(root, "memory"), { recursive: true });
  writeFileSync(
    join(root, "filesystem", "SKILL.md"),
    `---\nname: filesystem\ndescription: Files and dirs.\n---\n\n# body`,
  );
  writeFileSync(
    join(root, "memory", "SKILL.md"),
    `---\nname: memory\ndescription: Remember things.\n---\n\n# body`,
  );
  return root;
}

describe("skills augment", () => {
  it("emits one context block listing every parseable skill", async () => {
    const dir = makeSkillDir();
    try {
      const aug = skills({ dir });
      const out = await aug.context!(stubTurn, undefined);
      const blocks = typeof out === "string" ? [] : out;
      expect(blocks).toHaveLength(1);
      const block = blocks[0]!;
      expect(block.source).toBe("skills");
      expect(block.placement).toBe("system");
      expect(block.priority).toBe("required");
      expect(block.eviction).toBe("never");
      expect(block.content).toContain("# Skills");
      expect(block.content).toContain("- filesystem — Files and dirs.");
      expect(block.content).toContain("- memory — Remember things.");
      expect(block.content).toContain("fs_read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips subdirectories without a SKILL.md", async () => {
    const dir = makeSkillDir();
    mkdirSync(join(dir, "no-skill-here"));
    try {
      const aug = skills({ dir });
      const out = await aug.context!(stubTurn, undefined);
      const blocks = typeof out === "string" ? [] : out;
      expect(blocks[0]!.content).not.toContain("no-skill-here");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips subdirectories whose SKILL.md has invalid frontmatter", async () => {
    const dir = makeSkillDir();
    mkdirSync(join(dir, "broken"));
    writeFileSync(join(dir, "broken", "SKILL.md"), "# no frontmatter\n");
    try {
      const aug = skills({ dir });
      const out = await aug.context!(stubTurn, undefined);
      const blocks = typeof out === "string" ? [] : out;
      expect(blocks[0]!.content).not.toContain("broken");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits no block when no parseable skills are found", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auggy-skills-empty-"));
    try {
      const aug = skills({ dir });
      const out = await aug.context!(stubTurn, undefined);
      const blocks = typeof out === "string" ? [] : out;
      expect(blocks).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits no block when dir does not exist (graceful)", async () => {
    const aug = skills({ dir: "/nonexistent/skills-dir" });
    const out = await aug.context!(stubTurn, undefined);
    const blocks = typeof out === "string" ? [] : out;
    expect(blocks).toEqual([]);
  });

  it("does not declare any tools", () => {
    const aug = skills({ dir: "/tmp" });
    expect(aug.tools ?? []).toHaveLength(0);
    expect(aug.capabilities).toContain("context");
    expect(aug.capabilities).not.toContain("tools");
  });

  it("entries are sorted alphabetically for deterministic output", async () => {
    const dir = makeSkillDir();
    mkdirSync(join(dir, "alpha"));
    writeFileSync(join(dir, "alpha", "SKILL.md"), `---\nname: alpha\ndescription: First.\n---\n`);
    try {
      const aug = skills({ dir });
      const out = await aug.context!(stubTurn, undefined);
      const blocks = typeof out === "string" ? [] : out;
      const content = blocks[0]!.content;
      const alphaIdx = content.indexOf("- alpha");
      const filesystemIdx = content.indexOf("- filesystem");
      const memoryIdx = content.indexOf("- memory");
      expect(alphaIdx).toBeGreaterThan(0);
      expect(alphaIdx).toBeLessThan(filesystemIdx);
      expect(filesystemIdx).toBeLessThan(memoryIdx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
