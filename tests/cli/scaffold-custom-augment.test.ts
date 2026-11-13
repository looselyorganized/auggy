import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { scaffoldCustomAugment } from "../../src/cli/scaffold-custom-augment";
import { createCustomAugment } from "../../src/cli/commands/augment";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "custom-augment-scaffold-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("custom augment sample planner", () => {
  test("plans project-owned source and separate tests without writing or generating metadata", () => {
    const files = scaffoldCustomAugment({ slug: "crm-lookup" });
    expect(files.map((file) => file.relativePath)).toEqual([
      "src/augments/crm-lookup/index.ts",
      "src/augments/crm-lookup/schemas.ts",
      "src/augments/crm-lookup/service.ts",
      "src/augments/crm-lookup/README.md",
      "tests/augments/crm-lookup.test.ts",
    ]);
    expect(
      files.some((file) => /augment.yaml|definition.ts|SKILL.md/.test(file.relativePath)),
    ).toBe(false);
    expect(existsSync(join(dir, "src"))).toBe(false);
    const source = Buffer.from(files[0]!.bytes).toString();
    expect(source).toContain('name: "crm_lookup_lookup_record"');
    expect(source).toContain('auth: "creator"');
    expect(source).toContain('context?.peer?.trustLevel !== "creator"');
    expect(source).toContain("public: { neverExpose:");
    expect(source).toContain("agent: { neverExpose:");
  });

  test("skill opt-in uses only root skills and force always refuses", () => {
    const files = scaffoldCustomAugment({ slug: "weather", includeSkill: true });
    expect(files.at(-1)?.relativePath).toBe("skills/weather/SKILL.md");
    expect(Buffer.from(files.at(-1)!.bytes).toString()).toContain(
      "allowedTrustLevels:\n  - creator",
    );
    expect(() => scaffoldCustomAugment({ slug: "weather", force: true })).toThrow(
      /no longer overwrites/,
    );
    for (const slug of ["Bad Name", "UPPER", "../outside", "a".repeat(51), "x/route", "-bad"]) {
      expect(() => scaffoldCustomAugment({ slug })).toThrow(/Invalid augment slug/);
    }
    expect(scaffoldCustomAugment({ slug: "1-service" })).toHaveLength(5);
  });

  test("generated sample typechecks and tests execute against public package exports", async () => {
    writeFileSync(join(dir, "agent.yaml"), "name: sample\naugments: []\n");
    createCustomAugment({ slug: "lookup", cwd: dir });
    mkdirSync(join(dir, "node_modules"));
    symlinkSync(resolve(import.meta.dir, "../.."), join(dir, "node_modules", "auggy"), "dir");
    symlinkSync(
      dirname(Bun.resolveSync("zod/package.json", import.meta.dir)),
      join(dir, "node_modules", "zod"),
      "dir",
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: resolve(import.meta.dir, "../../tsconfig.json"),
        include: ["src/**/*.ts", "tests/**/*.ts"],
        exclude: [],
      }),
    );
    const checker = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../../node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--project",
        join(dir, "tsconfig.json"),
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    const [checkOutput, checkError, checkCode] = await Promise.all([
      new Response(checker.stdout).text(),
      new Response(checker.stderr).text(),
      checker.exited,
    ]);
    expect({ checkCode, checkOutput, checkError }).toMatchObject({ checkCode: 0 });
    const child = Bun.spawn([process.execPath, "test", "tests/augments/lookup.test.ts"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
    expect(stderr).toContain("4 pass");
    expect(readFileSync(join(dir, "src/augments/lookup/README.md"), "utf-8")).toContain(
      "system-of-record adapter",
    );
  }, 30000);
});
