/**
 * Round-trip + cross-loader tests for the shared `.env` parser.
 *
 * Codex adversarial-review High-2 regression: previously the admin UI
 * decoded `\n`, `\t`, `\"`, `\\` inside double-quoted values while the
 * runtime loader did not. That meant saving a PEM/JSON/multiline secret
 * via the UI silently changed what the agent saw on restart vs. what the
 * operator saw in the UI. These tests lock in: one parser, one disk
 * format, both call sites agree.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeEnvValue,
  encodeEnvValue,
  parseEnvFile,
  serializeEnv,
  type EnvLine,
} from "@/cli/env-parse";
import { loadEnvFile } from "@/cli/config-parser";

function kvLines(lines: EnvLine[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines) if (l.kind === "kv") out[l.key] = l.value;
  return out;
}

describe("env-parse — encode/decode round-trip", () => {
  it("plain alphanumeric value: bare encoding, identity round-trip", () => {
    expect(encodeEnvValue("abc123")).toBe("abc123");
    expect(decodeEnvValue("abc123")).toBe("abc123");
  });

  it("empty value: no quotes, identity round-trip", () => {
    expect(encodeEnvValue("")).toBe("");
    expect(decodeEnvValue("")).toBe("");
  });

  it("value with spaces: double-quoted", () => {
    expect(encodeEnvValue("hello world")).toBe('"hello world"');
    expect(decodeEnvValue('"hello world"')).toBe("hello world");
  });

  it("value with newline: encoded as \\n in double quotes; decode flips back", () => {
    const original = "line1\nline2";
    const encoded = encodeEnvValue(original);
    expect(encoded).toBe('"line1\\nline2"');
    expect(decodeEnvValue(encoded)).toBe(original);
  });

  it("value with tab: encoded as \\t", () => {
    const original = "a\tb";
    const encoded = encodeEnvValue(original);
    expect(encoded).toBe('"a\\tb"');
    expect(decodeEnvValue(encoded)).toBe(original);
  });

  it("value with embedded double quote: backslash-escaped", () => {
    const original = 'has "quotes" in it';
    const encoded = encodeEnvValue(original);
    // Order matters: backslashes first, then quotes.
    expect(encoded).toBe('"has \\"quotes\\" in it"');
    expect(decodeEnvValue(encoded)).toBe(original);
  });

  it("value with backslash + space: backslashes doubled inside quotes", () => {
    // Backslashes alone don't trigger quoting (no special-char match), so
    // bare encoding round-trips losslessly via the unquoted branch. When
    // combined with a space, the value must be quoted — and the backslash
    // must be doubled so the decoder doesn't try to interpret it as the
    // start of an escape sequence.
    const original = "path \\foo";
    const encoded = encodeEnvValue(original);
    expect(encoded).toBe('"path \\\\foo"');
    expect(decodeEnvValue(encoded)).toBe(original);
  });

  it("value with only-backslashes: bare encoding (identity round-trip)", () => {
    const original = "a\\b\\c";
    expect(encodeEnvValue(original)).toBe(original);
    expect(decodeEnvValue(original)).toBe(original);
  });

  it("multi-line PEM-style secret: round-trips losslessly", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n";
    const encoded = encodeEnvValue(pem);
    expect(decodeEnvValue(encoded)).toBe(pem);
  });

  it("JSON blob with newlines and quotes: round-trips losslessly", () => {
    const blob = '{\n  "alpha": "one",\n  "beta": "two\\nthree"\n}';
    const encoded = encodeEnvValue(blob);
    expect(decodeEnvValue(encoded)).toBe(blob);
  });

  it("single-quoted values pass through literally (no escape decoding)", () => {
    // Single quotes are dotenv's "literal" mode.
    expect(decodeEnvValue("'a\\nb'")).toBe("a\\nb");
  });
});

describe("env-parse — parseEnvFile + serializeEnv", () => {
  it("preserves comments and blank lines", () => {
    const text = "# Header comment\n\nKEY=value\n# trailing\n";
    const lines = parseEnvFile(text);
    expect(lines.map((l) => l.kind)).toEqual(["comment", "blank", "kv", "comment"]);
    const round = serializeEnv(lines);
    expect(round).toBe(text);
  });

  it("multi-line value round-trips through parseEnvFile + serializeEnv", () => {
    const lines: EnvLine[] = [{ kind: "kv", key: "PEM", value: "line-a\nline-b", raw: "" }];
    const serialized = serializeEnv(lines);
    const reparsed = parseEnvFile(serialized);
    expect(kvLines(reparsed)).toEqual({ PEM: "line-a\nline-b" });
  });

  it("non-kv lines (unrecognized) are preserved as comments", () => {
    const text = "not a valid line\nKEY=value\n";
    const lines = parseEnvFile(text);
    expect(lines[0]?.kind).toBe("comment");
    expect(lines[1]?.kind).toBe("kv");
  });
});

describe("env-parse — runtime loader agrees with UI parser", () => {
  let dir: string;
  const recordedKeys: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "env-parse-"));
    recordedKeys.length = 0;
  });

  afterEach(() => {
    for (const key of recordedKeys) delete process.env[key];
    rmSync(dir, { recursive: true, force: true });
  });

  function setVia(key: string, value: string): void {
    recordedKeys.push(key);
    // Use encodeEnvValue so this mirrors exactly what admin-credentials
    // setCredential would write to disk.
    writeFileSync(join(dir, ".env"), `${key}=${encodeEnvValue(value)}\n`);
  }

  it("PEM-style multi-line value: runtime sees what the UI wrote", () => {
    const pem = "line1\nline2\nline3";
    setVia("TEST_PEM_VALUE", pem);
    loadEnvFile(dir);
    expect(process.env.TEST_PEM_VALUE).toBe(pem);
  });

  it("value with embedded quotes: runtime sees what the UI wrote", () => {
    const v = 'has "double" quotes';
    setVia("TEST_QUOTED_VALUE", v);
    loadEnvFile(dir);
    expect(process.env.TEST_QUOTED_VALUE).toBe(v);
  });

  it("value with tabs and backslashes: runtime sees what the UI wrote", () => {
    const v = "col1\tcol2\\path";
    setVia("TEST_TABBED_VALUE", v);
    loadEnvFile(dir);
    expect(process.env.TEST_TABBED_VALUE).toBe(v);
  });

  it("does not override existing process.env (shell exports win)", () => {
    process.env.TEST_PREEXISTING = "shell-value";
    recordedKeys.push("TEST_PREEXISTING");
    writeFileSync(join(dir, ".env"), 'TEST_PREEXISTING="file-value"\n');
    loadEnvFile(dir);
    expect(process.env.TEST_PREEXISTING).toBe("shell-value");
  });
});
