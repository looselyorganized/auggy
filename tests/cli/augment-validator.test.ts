import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAugmentShape, validateCustomAugment } from "../../src/cli/augment-validator";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "augment-validator-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeModule(name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

describe("validateAugmentShape", () => {
  test("accepts a minimal augment object", () => {
    expect(() => validateAugmentShape({ name: "ok" })).not.toThrow();
  });

  test("rejects duplicate tool names", () => {
    expect(() =>
      validateAugmentShape({
        name: "bad",
        tools: [
          { name: "dup", description: "one", inputJsonSchema: {}, execute: async () => "" },
          { name: "dup", description: "two", inputJsonSchema: {}, execute: async () => "" },
        ],
      }),
    ).toThrow(/duplicate tool name/i);
  });

  test("rejects tools without inputJsonSchema", () => {
    expect(() =>
      validateAugmentShape({
        name: "bad",
        tools: [{ name: "x", description: "x", execute: async () => "" }],
      }),
    ).toThrow(/inputJsonSchema/i);
  });
});

describe("validateCustomAugment", () => {
  test("imports a valid module and returns summary", async () => {
    const path = writeModule(
      "valid.ts",
      `export default function factory() {
        return {
          name: "weather",
          tools: [{ name: "weather_echo", description: "echo", inputJsonSchema: {}, execute: async () => "ok" }]
        };
      }`,
    );

    await expect(validateCustomAugment(path)).resolves.toEqual({
      name: "weather",
      toolCount: 1,
    });
  });

  test("rejects missing default export", async () => {
    const path = writeModule("missing-default.ts", `export const x = 1;`);

    await expect(validateCustomAugment(path)).rejects.toThrow(/default augment factory/i);
  });

  test("rejects factory returning a non-object", async () => {
    const path = writeModule("bad-return.ts", `export default function factory() { return null; }`);

    await expect(validateCustomAugment(path)).rejects.toThrow(/factory must return/i);
  });
});
