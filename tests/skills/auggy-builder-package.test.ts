import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const CANONICAL_SKILL = join(ROOT, "src", "scaffold-starter-skills", "auggy");
const MIRRORS = [
  ["portable package", join(ROOT, "packages", "auggy-builder-skill", "auggy")],
  ["concierge example", join(ROOT, "examples", "concierge", "skills", "auggy")],
] as const;

describe("auggy builder skill mirrors", () => {
  test("portable and example skill copies stay in sync with the canonical scaffold skill", () => {
    const canonicalFiles = listFiles(CANONICAL_SKILL);

    for (const [label, mirrorDir] of MIRRORS) {
      expect(existsSync(mirrorDir), `${label} exists`).toBe(true);
      expect(listFiles(mirrorDir), `${label} file list`).toEqual(canonicalFiles);

      for (const file of canonicalFiles) {
        const expected = readFileSync(join(CANONICAL_SKILL, file), "utf-8");
        const actual = readFileSync(join(mirrorDir, file), "utf-8");
        expect(actual, `${label}:${file}`).toBe(expected);
      }
    }
  });

  test("portable package points at the installable auggy skill folder", () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "packages", "auggy-builder-skill", "package.json"), "utf-8"),
    ) as { files?: unknown; private?: unknown };

    expect(manifest.private).toBe(true);
    expect(manifest.files).toEqual(["auggy", "evals"]);
    expect(existsSync(join(ROOT, "packages", "auggy-builder-skill", "auggy", "SKILL.md"))).toBe(
      true,
    );
  });

  test("authoring examples do not teach redundant augment capabilities", () => {
    for (const file of [
      "assets/templates/custom-augment/index.ts.txt",
      "assets/templates/app-auth-bridge/protected-orders-augment.ts.txt",
      "references/routes-tools-augments.md",
    ]) {
      expect(readFileSync(join(CANONICAL_SKILL, file), "utf-8"), file).not.toContain(
        "capabilities:",
      );
    }
  });

  test("custom augment guidance pins layout, modern APIs, and all authorization boundaries", () => {
    const skill = readFileSync(join(CANONICAL_SKILL, "SKILL.md"), "utf-8");
    const reference = readFileSync(
      join(CANONICAL_SKILL, "references", "routes-tools-augments.md"),
      "utf-8",
    );
    const template = readFileSync(
      join(CANONICAL_SKILL, "assets", "templates", "custom-augment", "index.ts.txt"),
      "utf-8",
    );

    expect(skill.replace(/\s+/g, " ")).toContain(
      "Do not give custom-augment file structure or code until that reference read succeeds",
    );
    expect(reference).toContain("skills/<name>/");
    expect(reference).toContain("optional usage guidance, not augment source");
    for (const api of ["defineAugment", "defineRoute", "defineTool", 'from "zod"']) {
      expect(reference, api).toContain(api);
      expect(template, api).toContain(api);
    }
    expect(reference).toContain("Route caller authentication (`auth`)");
    expect(reference).toContain("Delegated authorization (`requires`)");
    expect(reference).toContain("Tool visibility (`constraints.perTrustLevel`)");
    expect(template).toContain("perTrustLevel:");
    expect(template).toContain('neverExpose: ["save_lead"]');
    expect(reference).not.toContain("augments/<name>/\n  SKILL.md");
  });

  test("skill frontmatter advertises implicit builder triggers", () => {
    const skill = readFileSync(join(CANONICAL_SKILL, "SKILL.md"), "utf-8");
    const frontmatter = skill.split("---")[1] ?? "";

    for (const trigger of [
      "self-hosted Auggy agents",
      "custom augments",
      "tools",
      "memory",
      "transports",
      "skills",
      "MCP",
      "deployment",
      "app-integration routes",
      "troubleshoot",
    ]) {
      expect(frontmatter, trigger).toContain(trigger);
    }
  });

  test("auth and memory reference pins persistence outcome semantics", () => {
    const reference = readFileSync(
      join(CANONICAL_SKILL, "references", "authz-memory-trust.md"),
      "utf-8",
    );

    expect(reference).toContain("operator origin");
    expect(reference).toContain("runtime-verified `creator` turns");
    expect(reference).toContain("stable runtime identity");
    expect(reference).toContain("`PERSISTED`");
    expect(reference).toContain("`NOT_PERSISTED`");
    expect(reference).toContain("`PERSISTENCE_UNKNOWN`");
  });

  test("AgentMail guidance pins the operator-owned API key lifecycle", () => {
    const skill = readFileSync(join(CANONICAL_SKILL, "SKILL.md"), "utf-8");
    const workflows = readFileSync(
      join(CANONICAL_SKILL, "references", "cli-workflows.md"),
      "utf-8",
    );
    const compactSkill = skill.replace(/\s+/g, " ");
    const compactWorkflows = workflows.replace(/\s+/g, " ");

    expect(compactSkill).toContain("Key-accepting modes preserve the supplied key unchanged");
    expect(compactSkill).toContain("signup stores AgentMail's provider-returned key");
    expect(compactSkill).toContain("does not prove outbound send or inbound read capability");
    expect(compactWorkflows).toContain("does not mint a child key");
    expect(compactWorkflows).toContain("deprecated compatibility alias for one RC");
    expect(compactWorkflows).toContain("--mode manual --replace-key");
    expect(compactWorkflows).toContain("Do not run AgentMail setup again merely because");
    expect(compactWorkflows).not.toContain("mints a new scoped runtime key");
    expect(compactWorkflows).not.toContain("stores only an inbox-scoped runtime key");
  });
});

function listFiles(root: string): string[] {
  const files: string[] = [];
  visit(root);
  return files.sort();

  function visit(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (entry.isFile() || statSync(path).isFile()) {
        files.push(relative(root, path));
      }
    }
  }
}
