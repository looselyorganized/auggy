/**
 * Tests for src/cli/yaml-helpers.ts.
 *
 * The helper unifies the YAML-extraction path used by `auggy visitors` and
 * `auggy visitors --revoke` (F15). The previous open-coded raw YAML parse
 * in those commands skipped env-var interpolation, so an operator's
 * `dbPath: ${MY_DB_PATH}` would arrive as the literal placeholder string.
 * The helper interpolates env vars + .env files, matching the behavior of
 * the kernel's parseConfig path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAugmentConfigOnly } from "../../src/cli/yaml-helpers";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "yaml-helpers-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  // Clean up any env vars set during the test runs so they don't leak.
  delete process.env.YAML_HELPERS_TEST_DB_PATH;
  delete process.env.YAML_HELPERS_TEST_MEMORY_PATH;
  delete process.env.YAML_HELPERS_TEST_PUBLIC_URL;
});

function writeYaml(content: string): string {
  const path = join(tmp, "agent.yaml");
  writeFileSync(path, content);
  return path;
}

describe("parseAugmentConfigOnly", () => {
  test("returns the augment options for a matching type", () => {
    const path = writeYaml(`
augments:
  - type: visitorAuth
    options:
      dbPath: /var/data/visitor-auth.db
      publicUrl: https://zip.test
`);
    const result = parseAugmentConfigOnly(path, "visitorAuth");
    expect(result).toEqual({
      dbPath: "/var/data/visitor-auth.db",
      publicUrl: "https://zip.test",
    });
  });

  test("returns options for string augment entries backed by augments/<id>/augment.yaml", () => {
    mkdirSync(join(tmp, "augments", "webTransport"), { recursive: true });
    writeFileSync(
      join(tmp, "augments", "webTransport", "augment.yaml"),
      `
type: webTransport
config:
  port: 9123
  auth:
    type: bearer
    token: tok
`,
    );
    const path = writeYaml(`
augments:
  - webTransport
`);

    const result = parseAugmentConfigOnly(path, "webTransport");

    expect(result).toEqual({
      port: 9123,
      auth: { type: "bearer", token: "tok" },
    });
  });

  test("returns null when no augment of the requested type is configured", () => {
    const path = writeYaml(`
augments:
  - type: notify
    options: { destinations: [] }
`);
    const result = parseAugmentConfigOnly(path, "visitorAuth");
    expect(result).toBeNull();
  });

  test("interpolates ${VAR_NAME} references against process.env (F15)", () => {
    process.env.YAML_HELPERS_TEST_DB_PATH = "/data/from-env.db";
    process.env.YAML_HELPERS_TEST_PUBLIC_URL = "https://from-env.test";
    const path = writeYaml(`
augments:
  - type: visitorAuth
    options:
      dbPath: \${YAML_HELPERS_TEST_DB_PATH}
      publicUrl: \${YAML_HELPERS_TEST_PUBLIC_URL}
`);
    const result = parseAugmentConfigOnly(path, "visitorAuth");
    expect(result?.dbPath).toBe("/data/from-env.db");
    expect(result?.publicUrl).toBe("https://from-env.test");
  });

  test("loads .env from the agent dir before interpolating (F15)", () => {
    // Write a .env in the agent dir; the helper must load it before
    // interpolating, matching parseConfig's behavior.
    writeFileSync(join(tmp, ".env"), "YAML_HELPERS_TEST_MEMORY_PATH=/from-dotenv/memory.db\n");
    const path = writeYaml(`
augments:
  - type: visitorAuth
    options:
      dbPath: ./visitor-auth.db
      layeredMemoryDbPath: \${YAML_HELPERS_TEST_MEMORY_PATH}
`);
    const result = parseAugmentConfigOnly(path, "visitorAuth");
    expect(result?.layeredMemoryDbPath).toBe("/from-dotenv/memory.db");
  });

  test("throws with a clear message when the file does not exist", () => {
    expect(() => parseAugmentConfigOnly(join(tmp, "nonexistent.yaml"), "visitorAuth")).toThrow(
      /agent\.yaml not found/,
    );
  });

  test("throws when an env-var reference cannot be resolved", () => {
    const path = writeYaml(`
augments:
  - type: visitorAuth
    options:
      dbPath: \${YAML_HELPERS_TEST_NEVER_DEFINED}
`);
    expect(() => parseAugmentConfigOnly(path, "visitorAuth")).toThrow(
      /YAML_HELPERS_TEST_NEVER_DEFINED/,
    );
  });

  test("returns the FIRST matching augment when the type repeats", () => {
    // Multi-instance is a misconfiguration the resolver warns about (F18),
    // but the operator-only CLI should still pick a deterministic entry.
    const path = writeYaml(`
augments:
  - type: visitorAuth
    options: { dbPath: ./first.db }
  - type: visitorAuth
    options: { dbPath: ./second.db }
`);
    const result = parseAugmentConfigOnly(path, "visitorAuth");
    expect(result?.dbPath).toBe("./first.db");
  });
});
