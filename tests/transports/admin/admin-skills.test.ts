import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledSkillSourceDir, collectSkillsInfo } from "@/transports/admin/admin-skills";

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
