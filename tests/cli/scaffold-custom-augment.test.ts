import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldCustomAugment } from "../../src/cli/scaffold-custom-augment";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "custom-augment-scaffold-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("scaffoldCustomAugment", () => {
  test("creates a custom augment folder with source, skill, readme, and test", () => {
    const target = join(dir, "weather");

    const result = scaffoldCustomAugment({ slug: "weather", targetDir: target });

    expect(result).toBe(target);
    expect(existsSync(join(target, "augment.yaml"))).toBe(true);
    expect(existsSync(join(target, "index.ts"))).toBe(true);
    expect(existsSync(join(target, "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, "README.md"))).toBe(true);
    expect(existsSync(join(target, "weather.test.ts"))).toBe(true);

    const source = readFileSync(join(target, "index.ts"), "utf-8");
    expect(source).toContain('from "auggy"');
    expect(source).toContain('name: "weather"');
    expect(source).toContain('name: "weather_echo"');
    expect(source).toContain("export default function weather");
    expect(source).not.toContain("capabilities:");

    const metadata = readFileSync(join(target, "augment.yaml"), "utf-8");
    expect(metadata).toContain("type: custom");
    expect(metadata).toContain("source: ./index.ts");
  });

  test("supports hyphenated slugs", () => {
    const target = join(dir, "crm-lookup");

    scaffoldCustomAugment({ slug: "crm-lookup", targetDir: target });

    const source = readFileSync(join(target, "index.ts"), "utf-8");
    expect(source).toContain("interface CrmLookupOptions");
    expect(source).toContain("crm_lookup_echo");
    expect(source).toContain("function crm_lookup");
  });

  test("rejects invalid slugs", () => {
    expect(() => scaffoldCustomAugment({ slug: "Bad Name", targetDir: join(dir, "bad") })).toThrow(
      /invalid augment slug/i,
    );
  });

  test("refuses to overwrite without --force", () => {
    const target = join(dir, "weather");
    scaffoldCustomAugment({ slug: "weather", targetDir: target });

    expect(() => scaffoldCustomAugment({ slug: "weather", targetDir: target })).toThrow(
      /already exists/i,
    );
  });

  test("overwrites when force is true", () => {
    const target = join(dir, "weather");
    scaffoldCustomAugment({ slug: "weather", targetDir: target });
    writeFileSync(join(target, "README.md"), "custom local edits");

    scaffoldCustomAugment({ slug: "weather", targetDir: target, force: true });

    expect(readFileSync(join(target, "README.md"), "utf-8")).toContain(
      "Custom Auggy augment scaffolded",
    );
  });
});
