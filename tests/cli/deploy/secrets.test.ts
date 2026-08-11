import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSecretsPlan, parseEnvText, redactValue } from "../../../src/cli/deploy/secrets";
import { serializeEnv } from "../../../src/cli/env-parse";

describe("redactValue", () => {
  test("empty uses a fixed marker", () => {
    expect(redactValue("")).toBe("<empty>");
  });
  test("all non-empty values use the same non-derived marker", () => {
    for (const value of ["a", "shortish", "sk-ant-abc-1234567890"]) {
      expect(redactValue(value)).toBe("<set>");
    }
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

  test("deploys only the AgentMail runtime key and skips legacy setup-only keys", () => {
    const plan = parseEnvText(
      [
        "AGENTMAIL_API_KEY=am_supplied",
        "AGENTMAIL_ACCOUNT_API_KEY=am_legacy_account",
        "AGENTMAIL_PARENT_API_KEY=am_legacy_parent",
        "AGENTMAIL_INBOX_ID=inbox_123",
        "",
      ].join("\n"),
    );

    expect(plan.variables.map((variable) => variable.key)).toEqual([
      "AGENTMAIL_API_KEY",
      "AGENTMAIL_INBOX_ID",
    ]);
    expect(plan.variables[0]?.value).toBe("am_supplied");
    expect(plan.warnings).toEqual([
      "line 2: AGENTMAIL_ACCOUNT_API_KEY is not a runtime credential; skipped. Deploy AGENTMAIL_API_KEY instead",
      "line 3: AGENTMAIL_PARENT_API_KEY is not a runtime credential; skipped. Deploy AGENTMAIL_API_KEY instead",
    ]);
  });

  test("decodes a serialized AgentMail key without changing printable bytes", () => {
    const exact = `am_!@#$%^&*()[]{};:'"\\|,./<>?~`;
    const source = serializeEnv([{ kind: "kv", key: "AGENTMAIL_API_KEY", value: exact, raw: "" }]);

    expect(parseEnvText(source).variables).toEqual([
      { key: "AGENTMAIL_API_KEY", value: exact, redactedValue: "<set>" },
    ]);
  });

  test("never includes malformed raw input in warnings", () => {
    const sentinel = "GROUP9_ENV_SECRET_DO_NOT_LOG";
    const plan = parseEnvText(
      `${sentinel}\n${sentinel}-INVALID=value\nDUPLICATE=first\nDUPLICATE=second\n`,
    );

    expect(plan.warnings).toEqual([
      "line 1: missing '=' delimiter; skipped",
      "line 2: invalid variable name; skipped",
      "line 4: duplicate variable name; first nonempty value is retained",
    ]);
    expect(plan.warnings.join("\n")).not.toContain(sentinel);
    expect(plan.warnings.join("\n")).not.toContain("DUPLICATE");
  });

  test("first nonempty duplicate wins like the runtime loader", () => {
    const plan = parseEnvText("KEY=\nKEY=first\nKEY=second\n");
    expect(plan.variables.length).toBe(1);
    expect(plan.variables[0]?.value).toBe("first");
    expect(plan.warnings).toHaveLength(2);
    expect(plan.warnings.every((warning) => /duplicate/i.test(warning))).toBe(true);
  });

  test("redactedValue never contains a secret substring", () => {
    const plan = parseEnvText("ANTHROPIC_API_KEY=sk-ant-abc-1234567890\n");
    expect(plan.variables[0]?.redactedValue).toBe("<set>");
    expect(plan.variables[0]?.redactedValue).not.toContain("sk-");
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
