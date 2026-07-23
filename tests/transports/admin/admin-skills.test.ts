import { afterEach, describe, expect, it } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundledSkillSourceDir,
  collectSkillsInfo,
  readInstalledSkillContent,
  removeInstalledSkill,
  resetInstalledSkill,
  writeInstalledSkillContent,
} from "@/transports/admin/admin-skills";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("collectSkillsInfo installed skill ownership", () => {
  it("attributes bundled and modified skills to their mounted augment type", () => {
    const root = testRoot();
    installBundledSkill(root, "webFetch");

    const bundled = collectSkillsInfo(root, new Set(["webFetch"])).installed[0];
    expect(bundled).toMatchObject({
      folder: "webFetch",
      source: "bundled",
      fromAugmentType: "webFetch",
    });

    const skillFile = join(root, "skills", "webFetch", "SKILL.md");
    writeFileSync(skillFile, `${readFileSync(skillFile, "utf-8")}\nOperator customization.\n`);

    const modified = collectSkillsInfo(root, new Set(["webFetch"])).installed[0];
    expect(modified).toMatchObject({
      folder: "webFetch",
      source: "modified",
      fromAugmentType: "webFetch",
    });
  });

  it("leaves manual skills unowned instead of guessing from frontmatter", () => {
    const root = testRoot();
    const skillDir = join(root, "skills", "custom-orders");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: webFetch",
        "description: A manual skill whose name resembles a bundled augment.",
        "---",
        "",
        "# Manual skill",
        "",
      ].join("\n"),
    );

    const manual = collectSkillsInfo(root, new Set(["webFetch"])).installed[0];
    expect(manual).toMatchObject({ folder: "custom-orders", source: "manual" });
    expect(manual).not.toHaveProperty("fromAugmentType");
  });

  it("omits ownership when the bundled skill's augment is not mounted", () => {
    const root = testRoot();
    installBundledSkill(root, "webFetch");

    const installed = collectSkillsInfo(root, new Set(["filesystem"])).installed[0];
    expect(installed).toMatchObject({ folder: "webFetch", source: "bundled" });
    expect(installed).not.toHaveProperty("fromAugmentType");
  });
});

describe("admin-skills — managed tree isolation", () => {
  it("omits and refuses a symlinked skill folder without touching its target", () => {
    const root = testRoot();
    const outside = testRoot();
    const outsideSkill = join(outside, "outside-skill");
    mkdirSync(outsideSkill, { recursive: true });
    const target = join(outsideSkill, "SKILL.md");
    const sentinel = "---\nname: outside\ndescription: SENTINEL_SKILL\n---\n";
    writeFileSync(target, sentinel);
    mkdirSync(join(root, "skills"), { recursive: true });
    symlinkSync(outsideSkill, join(root, "skills", "webFetch"));

    expect(collectSkillsInfo(root).installed).toEqual([]);
    expect(readInstalledSkillContent(root, "webFetch")).toHaveProperty("error");
    expect(writeInstalledSkillContent(root, "webFetch", "changed").ok).toBe(false);
    expect(resetInstalledSkill(root, "webFetch").ok).toBe(false);
    expect(removeInstalledSkill(root, "webFetch").ok).toBe(false);
    expect(readFileSync(target, "utf-8")).toBe(sentinel);
  });

  it("refuses a symlinked skills root", () => {
    const root = testRoot();
    const outside = testRoot();
    mkdirSync(join(outside, "manual"), { recursive: true });
    writeFileSync(join(outside, "manual", "SKILL.md"), "SENTINEL_ROOT");
    symlinkSync(outside, join(root, "skills"));

    expect(collectSkillsInfo(root).installed).toEqual([]);
    expect(readInstalledSkillContent(root, "manual")).toHaveProperty("error");
    expect(writeInstalledSkillContent(root, "manual", "changed").ok).toBe(false);
    expect(readFileSync(join(outside, "manual", "SKILL.md"), "utf-8")).toBe("SENTINEL_ROOT");
  });
});

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "auggy-admin-skills-"));
  roots.push(root);
  return root;
}

function installBundledSkill(root: string, folder: string): void {
  const source = bundledSkillSourceDir(folder);
  if (!source) throw new Error(`Missing bundled test skill: ${folder}`);
  cpSync(source, join(root, "skills", folder), { recursive: true });
}
