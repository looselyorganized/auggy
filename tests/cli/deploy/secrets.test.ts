import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSecretsPlan, parseEnvText, redactValue } from "../../../src/cli/deploy/secrets";

describe("redactValue", () => {
  test("empty stays empty", () => {
    expect(redactValue("")).toBe("");
  });
  test("short values fully masked", () => {
    expect(redactValue("key")).toBe("***");
  });
  test("medium values show a compact fingerprint", () => {
    expect(redactValue("shortish")).toBe("sh...sh");
  });
  test("long values show a compact fixed-width fingerprint", () => {
    expect(redactValue("sk-ant-abc-1234567890")).toBe("sk-a...7890");
  });
});

describe("parseEnvText", () => {
  test("parses simple KEY=value pairs", () => {
    const plan = parseEnvText("ANTHROPIC_API_KEY=sk-secret\nFOO=bar\n");
    expect(plan.variables.map((v) => v.key)).toEqual(["ANTHROPIC_API_KEY", "FOO"]);
    expect(plan.variables.find((v) => v.key === "ANTHROPIC_API_KEY")?.value).toBe("sk-secret");
    expect(plan.warnings).toEqual([]);
  });

  test("skips blank lines and comments", () => {
    const plan = parseEnvText(`# This is a comment
ANTHROPIC_API_KEY=sk-secret

# Another comment
FOO=bar
`);
    expect(plan.variables.length).toBe(2);
    expect(plan.warnings).toEqual([]);
  });

  test("supports quoted values and `export KEY=value` shorthand", () => {
    const plan = parseEnvText(`export ANTHROPIC_API_KEY="sk-secret"
FOO='single-quoted'
BAR=unquoted with spaces
`);
    expect(plan.variables.find((v) => v.key === "ANTHROPIC_API_KEY")?.value).toBe("sk-secret");
    expect(plan.variables.find((v) => v.key === "FOO")?.value).toBe("single-quoted");
    expect(plan.variables.find((v) => v.key === "BAR")?.value).toBe("unquoted with spaces");
  });

  test("records warnings for malformed lines and invalid keys", () => {
    const plan = parseEnvText(`malformed-line
123_BAD=val
GOOD=ok
`);
    expect(plan.warnings.length).toBe(2);
    expect(plan.variables.map((v) => v.key)).toEqual(["GOOD"]);
  });

  test("later duplicate keys override earlier with a warning", () => {
    const plan = parseEnvText("KEY=first\nKEY=second\n");
    expect(plan.variables.length).toBe(1);
    expect(plan.variables[0]?.value).toBe("second");
    expect(plan.warnings.length).toBe(1);
    expect(plan.warnings[0]).toMatch(/duplicate/i);
  });

  test("redactedValue is populated and matches redactValue() output", () => {
    const plan = parseEnvText("ANTHROPIC_API_KEY=sk-ant-abc-1234567890\n");
    expect(plan.variables[0]?.redactedValue).toBe("sk-a...7890");
  });
});

describe("loadSecretsPlan", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "auggy-secrets-test-"));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  test("reads + parses .env from disk", () => {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "ANTHROPIC_API_KEY=sk-secret\n");
    const plan = loadSecretsPlan(envPath);
    expect(plan.variables.length).toBe(1);
    expect(plan.variables[0]?.key).toBe("ANTHROPIC_API_KEY");
  });

  test("returns empty plan + warning when .env doesn't exist", () => {
    const plan = loadSecretsPlan(join(dir, ".env"));
    expect(plan.variables).toEqual([]);
    expect(plan.warnings[0]).toMatch(/no .env file/i);
  });
});
