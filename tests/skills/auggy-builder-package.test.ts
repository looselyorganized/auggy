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
    expect(manifest.files).toEqual(["auggy"]);
    expect(existsSync(join(ROOT, "packages", "auggy-builder-skill", "auggy", "SKILL.md"))).toBe(
      true,
    );
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
