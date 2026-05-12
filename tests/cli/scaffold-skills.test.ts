import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  augmentFolderForType,
  buildSkillManifest,
  copyBundledSkill,
  renderIdentityFromTemplate,
} from "../../src/cli/scaffold-skills";

const TMP = join(import.meta.dir, ".tmp-scaffold-skills-test");

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("augmentFolderForType", () => {
  test("maps camelCase types to kebab-case folders", () => {
    expect(augmentFolderForType("layeredMemory")).toBe("layered-memory");
    expect(augmentFolderForType("webFetch")).toBe("web-fetch");
    expect(augmentFolderForType("orgContext")).toBe("org-context");
    expect(augmentFolderForType("turnControl")).toBe("turn-control");
  });

  test("returns the type unchanged when already kebab-case", () => {
    expect(augmentFolderForType("filesystem")).toBe("filesystem");
    expect(augmentFolderForType("bash")).toBe("bash");
    expect(augmentFolderForType("notify")).toBe("notify");
  });

  test("returns null for unknown types", () => {
    expect(augmentFolderForType("madeUpAugment")).toBeNull();
    expect(augmentFolderForType("")).toBeNull();
  });
});

describe("buildSkillManifest", () => {
  test("emits one bullet per tool-providing augment with its tool inventory", () => {
    const manifest = buildSkillManifest(["filesystem", "layeredMemory", "webFetch"]);
    expect(manifest).toContain("## Available skills");
    expect(manifest).toContain(
      "- `skills/filesystem/SKILL.md` — fs_read, fs_write, fs_list, fs_mkdir, fs_remove, fs_search",
    );
    expect(manifest).toContain(
      "- `skills/layered-memory/SKILL.md` — memory_read, memory_write, memory_search, memory_list, memory_forget",
    );
    expect(manifest).toContain("- `skills/web-fetch/SKILL.md` — web_fetch");
  });

  test("preserves order of provided types", () => {
    const manifest = buildSkillManifest(["webFetch", "filesystem"]);
    const fsIdx = manifest.indexOf("filesystem/SKILL.md");
    const wfIdx = manifest.indexOf("web-fetch/SKILL.md");
    expect(wfIdx).toBeGreaterThan(-1);
    expect(fsIdx).toBeGreaterThan(-1);
    expect(wfIdx).toBeLessThan(fsIdx);
  });

  test("dedupes repeated types", () => {
    const manifest = buildSkillManifest(["filesystem", "filesystem"]);
    const occurrences = (manifest.match(/skills\/filesystem\/SKILL.md/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  test("skips augment types that have no bundled skill folder", () => {
    // budgets, fileMemory, webTransport contribute no model-callable tools
    // and ship no skill folder.
    const manifest = buildSkillManifest(["budgets", "fileMemory", "webTransport"]);
    expect(manifest).toBe("");
  });

  test("returns empty string (no header) when no augments contribute skills", () => {
    expect(buildSkillManifest([])).toBe("");
  });
});

describe("renderIdentityFromTemplate", () => {
  test("substitutes AGENT_NAME, PURPOSE, OPERATOR_NAME placeholders", () => {
    const out = renderIdentityFromTemplate({
      agentName: "zip",
      purpose: "the front-door agent",
      operatorName: "Sam",
      augmentTypes: ["filesystem"],
    });
    expect(out).toContain("# zip");
    expect(out).toContain("You are zip, the front-door agent.");
    expect(out).toContain("claims to be Sam");
  });

  test("ADR-030: identity is identity — no skill listing inlined regardless of augment list", () => {
    const out = renderIdentityFromTemplate({
      agentName: "zip",
      purpose: "a helpful assistant",
      operatorName: "the operator",
      augmentTypes: ["layeredMemory", "filesystem", "webFetch", "orgContext"],
    });
    // Skill listing moved out of identity.md per ADR-030; surface is now the
    // 'skills' augment's emitted context block.
    expect(out).not.toContain("## Available skills");
    expect(out).not.toContain("skills/");
    expect(out).not.toContain("SKILL.md");
    expect(out).not.toContain("{SKILL_MANIFEST}");
  });

  test("does not interpret literal braces in operator-supplied values", () => {
    // Operator names a literal { in their name — must NOT be treated as a
    // placeholder (would explode if the substitution used a regex-of-braces).
    const out = renderIdentityFromTemplate({
      agentName: "agent",
      purpose: "helps with {} and stuff",
      operatorName: "{Sneaky}",
      augmentTypes: ["filesystem"],
    });
    expect(out).toContain("{Sneaky}");
    expect(out).toContain("with {} and stuff");
    // The four security rule headings must still be present (no value
    // inadvertently overwrote part of the template).
    expect(out).toContain("Security rules (non-negotiable)");
  });

  test("does not interpret $ in operator-supplied values as backreferences", () => {
    const out = renderIdentityFromTemplate({
      agentName: "agent",
      purpose: "$1 mistake",
      operatorName: "$&",
      augmentTypes: ["filesystem"],
    });
    expect(out).toContain("$1 mistake");
    expect(out).toContain("$&");
  });

  test("does not re-substitute placeholder strings appearing in operator values (Codex Imp-1)", () => {
    // An operator-supplied value of `{PURPOSE}` (or any other placeholder
    // string) must be emitted verbatim, NOT consumed as a placeholder by a
    // subsequent substitution pass. Single-pass replacement closes this hole.
    const out = renderIdentityFromTemplate({
      agentName: "{PURPOSE}", // operator named their agent literally "{PURPOSE}"
      purpose: "actual-purpose-value",
      operatorName: "{SKILL_MANIFEST}", // and they really like braces
      augmentTypes: ["filesystem"],
    });
    // The agent-name slot keeps the literal "{PURPOSE}" — was NOT replaced
    // with "actual-purpose-value" by the second pass.
    expect(out).toContain("# {PURPOSE}");
    // The actual purpose substitution still happened in its slot.
    expect(out).toContain("actual-purpose-value");
    // The operator-name slot keeps the literal "{SKILL_MANIFEST}" — even though
    // {SKILL_MANIFEST} is no longer a recognized placeholder post-ADR-030, the
    // single-pass replace must still NOT touch it (regression guard against a
    // future re-introduction of the manifest token).
    expect(out).toContain("claims to be {SKILL_MANIFEST}");
  });
});

describe("copyBundledSkill", () => {
  test("copies the bundled skill folder for a known augment type", () => {
    const agentDir = join(TMP, "agent");
    mkdirSync(agentDir, { recursive: true });

    expect(copyBundledSkill("filesystem", agentDir)).toBe(true);
    expect(existsSync(join(agentDir, "skills", "filesystem", "SKILL.md"))).toBe(true);
  });

  test("returns false for unknown augment types", () => {
    const agentDir = join(TMP, "agent");
    mkdirSync(agentDir, { recursive: true });
    expect(copyBundledSkill("madeUpAugment", agentDir)).toBe(false);
    expect(existsSync(join(agentDir, "skills"))).toBe(false);
  });

  test("returns false for augment types without a bundled skill", () => {
    const agentDir = join(TMP, "agent");
    mkdirSync(agentDir, { recursive: true });
    // budgets has no skill/ folder under src/augments/budgets/.
    expect(copyBundledSkill("budgets", agentDir)).toBe(false);
  });

  test("idempotent: running twice overwrites existing skill files", () => {
    const agentDir = join(TMP, "agent");
    mkdirSync(agentDir, { recursive: true });

    // First copy.
    copyBundledSkill("filesystem", agentDir);
    const skillPath = join(agentDir, "skills", "filesystem", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);

    // Mutate the copied file to verify the second copy actually overwrites.
    writeFileSync(skillPath, "STALE CONTENT");
    expect(readFileSync(skillPath, "utf-8")).toBe("STALE CONTENT");

    // Second copy must overwrite the staled content.
    expect(copyBundledSkill("filesystem", agentDir)).toBe(true);
    const fresh = readFileSync(skillPath, "utf-8");
    expect(fresh).not.toBe("STALE CONTENT");
    expect(fresh).toContain("name: filesystem");
  });
});
