import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { stringify } from "yaml";
import { parseConfig, interpolateEnvVars, loadEnvFile } from "../../src/cli/config-parser";

const TMP = join(import.meta.dir, ".tmp-config-test");

function writeYaml(name: string, content: string): string {
  const path = join(TMP, name);
  writeFileSync(path, content);
  return path;
}

function minimalConfig(overrides: Record<string, unknown> = {}): string {
  const base = {
    id: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
    name: "test-agent",
    engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
    augments: [
      { name: "identity", type: "fileMemory", options: { label: "self", source: "./identity.md", mutable: false, origin: "operator", priority: "required", placement: "system", eviction: "never" } },
    ],
    ...overrides,
  };
  return stringify(base);
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  // Write a dummy identity file so fileMemory doesn't fail path checks.
  writeFileSync(join(TMP, "identity.md"), "# Test Identity");
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseConfig", () => {
  test("parses a minimal valid config", () => {
    const path = writeYaml("agent.yaml", minimalConfig());
    const config = parseConfig(path);
    expect(config.id).toBe("aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c");
    expect(config.name).toBe("test-agent");
    expect(config.engine.provider).toBe("anthropic");
    expect(config.engine.model).toBe("claude-sonnet-4-6");
    expect(config.augments).toHaveLength(1);
    expect(config.augments[0]!.name).toBe("identity");
    expect(config.augments[0]!.type).toBe("fileMemory");
  });

  test("includes optional fields when present", () => {
    const path = writeYaml("agent.yaml", minimalConfig({
      purpose: "test purpose",
      operators: ["op-1"],
      settings: { compactionStrategy: "truncate", maxInferenceLoops: 5 },
    }));
    const config = parseConfig(path);
    expect(config.purpose).toBe("test purpose");
    expect(config.operators).toEqual(["op-1"]);
    expect(config.settings.compactionStrategy).toBe("truncate");
    expect(config.settings.maxInferenceLoops).toBe(5);
  });

  test("defaults settings to empty object when omitted", () => {
    const path = writeYaml("agent.yaml", minimalConfig());
    const config = parseConfig(path);
    expect(config.settings).toBeDefined();
  });
});

describe("validation errors", () => {
  test("rejects missing id", () => {
    const path = writeYaml("agent.yaml", minimalConfig({ id: undefined }));
    expect(() => parseConfig(path)).toThrow("id:");
  });

  test("rejects invalid aug1_ id format", () => {
    const path = writeYaml("agent.yaml", minimalConfig({ id: "bad-id" }));
    expect(() => parseConfig(path)).toThrow("aug1_");
  });

  test("rejects missing name", () => {
    const path = writeYaml("agent.yaml", minimalConfig({ name: undefined }));
    expect(() => parseConfig(path)).toThrow("name:");
  });

  test("rejects missing engine", () => {
    const path = writeYaml("agent.yaml", minimalConfig({ engine: undefined }));
    expect(() => parseConfig(path)).toThrow("engine:");
  });

  test("rejects empty augments array", () => {
    const path = writeYaml("agent.yaml", minimalConfig({ augments: [] }));
    expect(() => parseConfig(path)).toThrow("augments:");
  });

  test("rejects duplicate augment names", () => {
    const path = writeYaml("agent.yaml", minimalConfig({
      augments: [
        { name: "dup", type: "webFetch", options: {} },
        { name: "dup", type: "webFetch", options: {} },
      ],
    }));
    expect(() => parseConfig(path)).toThrow('duplicate name "dup"');
  });

  test("rejects unknown augment type", () => {
    const path = writeYaml("agent.yaml", minimalConfig({
      augments: [{ name: "x", type: "unknownThing", options: {} }],
    }));
    expect(() => parseConfig(path)).toThrow("unknownThing");
  });

  test("rejects custom augment without source", () => {
    const path = writeYaml("agent.yaml", minimalConfig({
      augments: [{ name: "x", type: "custom", options: {} }],
    }));
    expect(() => parseConfig(path)).toThrow("source");
  });

  test("rejects invalid compactionStrategy", () => {
    const path = writeYaml("agent.yaml", minimalConfig({
      settings: { compactionStrategy: "invalid" },
    }));
    expect(() => parseConfig(path)).toThrow("compactionStrategy");
  });
});

describe("env var interpolation", () => {
  test("replaces ${VAR} with env value", () => {
    process.env.TEST_INTERP_VAR = "replaced-value";
    const result = interpolateEnvVars({ key: "${TEST_INTERP_VAR}" });
    expect(result).toEqual({ key: "replaced-value" });
    delete process.env.TEST_INTERP_VAR;
  });

  test("replaces nested ${VAR} references", () => {
    process.env.TEST_NESTED = "deep";
    const result = interpolateEnvVars({ a: { b: { c: "${TEST_NESTED}" } } });
    expect(result).toEqual({ a: { b: { c: "deep" } } });
    delete process.env.TEST_NESTED;
  });

  test("replaces ${VAR} in arrays", () => {
    process.env.TEST_ARR = "item";
    const result = interpolateEnvVars({ list: ["${TEST_ARR}", "static"] });
    expect(result).toEqual({ list: ["item", "static"] });
    delete process.env.TEST_ARR;
  });

  test("throws on missing env var with location context", () => {
    expect(() => interpolateEnvVars({ token: "${MISSING_VAR_XYZ}" })).toThrow(
      "MISSING_VAR_XYZ",
    );
  });

  test("leaves non-string values unchanged", () => {
    const result = interpolateEnvVars({ num: 42, bool: true, nil: null });
    expect(result).toEqual({ num: 42, bool: true, nil: null });
  });
});

describe("loadEnvFile", () => {
  test("loads KEY=VALUE pairs into process.env", () => {
    writeFileSync(join(TMP, ".env"), "TEST_LOAD_KEY=hello\nTEST_LOAD_KEY2=world");
    loadEnvFile(TMP);
    expect(process.env.TEST_LOAD_KEY).toBe("hello");
    expect(process.env.TEST_LOAD_KEY2).toBe("world");
    delete process.env.TEST_LOAD_KEY;
    delete process.env.TEST_LOAD_KEY2;
  });

  test("strips surrounding quotes from values", () => {
    writeFileSync(join(TMP, ".env"), 'TEST_QUOTED="quoted-value"');
    loadEnvFile(TMP);
    expect(process.env.TEST_QUOTED).toBe("quoted-value");
    delete process.env.TEST_QUOTED;
  });

  test("skips comments and blank lines", () => {
    writeFileSync(join(TMP, ".env"), "# comment\n\nTEST_COMMENT_KEY=val");
    loadEnvFile(TMP);
    expect(process.env.TEST_COMMENT_KEY).toBe("val");
    delete process.env.TEST_COMMENT_KEY;
  });

  test("does not override existing env vars", () => {
    process.env.TEST_EXISTING = "original";
    writeFileSync(join(TMP, ".env"), "TEST_EXISTING=overridden");
    loadEnvFile(TMP);
    expect(process.env.TEST_EXISTING).toBe("original");
    delete process.env.TEST_EXISTING;
  });

  test("silently skips if .env does not exist", () => {
    expect(() => loadEnvFile("/nonexistent/path")).not.toThrow();
  });
});
