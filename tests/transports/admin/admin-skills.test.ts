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

describe("collectSkillsInfo installed skill provenance and ownership", () => {
  it("reports Auggy-provided and customized provenance separately from ownership", () => {
    const root = testRoot();
    installBundledSkill(root, "webFetch");

    const bundled = collectSkillsInfo(root, new Set(["webFetch"])).installed[0];
    expect(bundled).toMatchObject({
      folder: "webFetch",
      provenance: "auggy-provided",
      fromAugmentType: "webFetch",
    });
    expect(bundled).not.toHaveProperty("source");

    const skillFile = join(root, "skills", "webFetch", "SKILL.md");
    writeFileSync(skillFile, `${readFileSync(skillFile, "utf-8")}\nOperator customization.\n`);

    const modified = collectSkillsInfo(root, new Set(["webFetch"])).installed[0];
    expect(modified).toMatchObject({
      folder: "webFetch",
      provenance: "customized-auggy-skill",
      fromAugmentType: "webFetch",
    });
  });

  it("leaves user-created skills unowned instead of guessing from frontmatter", () => {
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

    const userCreated = collectSkillsInfo(root, new Set(["webFetch"])).installed[0];
    expect(userCreated).toMatchObject({
      folder: "custom-orders",
      provenance: "user-created",
    });
    expect(userCreated).not.toHaveProperty("source");
    expect(userCreated).not.toHaveProperty("fromAugmentType");
  });

  it("omits ownership when the Auggy-provided skill's augment is not mounted", () => {
    const root = testRoot();
    installBundledSkill(root, "webFetch");

    const installed = collectSkillsInfo(root, new Set(["filesystem"])).installed[0];
    expect(installed).toMatchObject({
      folder: "webFetch",
      provenance: "auggy-provided",
    });
    expect(installed).not.toHaveProperty("fromAugmentType");
  });

  it("marks available skills as Auggy-provided without claiming install timing", () => {
    const root = testRoot();

    const available = collectSkillsInfo(root, new Set(["webFetch"])).available;

    expect(available).toEqual([
      expect.objectContaining({
        folder: "webFetch",
        provenance: "auggy-provided",
        fromAugmentType: "webFetch",
      }),
    ]);
    expect(JSON.stringify(available)).not.toMatch(/bundled|scaffold/i);
  });

  it("classifies a missing known SKILL.md as customized instead of user-created", () => {
    const root = testRoot();
    mkdirSync(join(root, "skills", "webFetch"), { recursive: true });

    expect(collectSkillsInfo(root, new Set(["webFetch"])).installed[0]).toMatchObject({
      folder: "webFetch",
      provenance: "customized-auggy-skill",
      fromAugmentType: "webFetch",
      frontmatterValid: false,
      contentBytes: 0,
    });
  });

  it("preserves edit, reset, and remove behavior across provenance states", () => {
    const root = testRoot();
    installBundledSkill(root, "webFetch");
    const packagedFile = join(root, "skills", "webFetch", "SKILL.md");
    const packagedContent = readFileSync(packagedFile, "utf-8");

    expect(
      writeInstalledSkillContent(root, "webFetch", `${packagedContent}\nCustomized.\n`),
    ).toEqual({
      ok: true,
      message: "Saved webFetch/SKILL.md",
    });
    expect(collectSkillsInfo(root).installed[0]?.provenance).toBe("customized-auggy-skill");
    expect(resetInstalledSkill(root, "webFetch").ok).toBe(true);
    expect(collectSkillsInfo(root).installed[0]?.provenance).toBe("auggy-provided");

    const customDir = join(root, "skills", "order-support");
    mkdirSync(customDir, { recursive: true });
    writeFileSync(
      join(customDir, "SKILL.md"),
      "---\nname: order-support\ndescription: Handle orders.\n---\n",
    );
    expect(
      collectSkillsInfo(root).installed.find((skill) => skill.folder === "order-support"),
    ).toMatchObject({ provenance: "user-created" });
    expect(resetInstalledSkill(root, "order-support")).toEqual({
      ok: false,
      message: "no Auggy-provided skill for this folder",
    });
    expect(removeInstalledSkill(root, "order-support").ok).toBe(true);
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
