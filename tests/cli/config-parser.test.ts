import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      {
        name: "identity",
        type: "fileMemory",
        options: {
          label: "self",
          source: "./identity.md",
          mutable: false,
          origin: "operator",
          priority: "required",
          placement: "system",
          eviction: "never",
        },
      },
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
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        purpose: "test purpose",
        operators: ["op-1"],
        settings: { compactionStrategy: "truncate", maxInferenceLoops: 5 },
      }),
    );
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
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          { name: "dup", type: "webFetch", options: {} },
          { name: "dup", type: "webFetch", options: {} },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow('duplicate name "dup"');
  });

  test("rejects unknown augment type", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [{ name: "x", type: "unknownThing", options: {} }],
      }),
    );
    expect(() => parseConfig(path)).toThrow("unknownThing");
  });

  test("rejects custom augment without source", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [{ name: "x", type: "custom", options: {} }],
      }),
    );
    expect(() => parseConfig(path)).toThrow("source");
  });

  test("rejects invalid compactionStrategy", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        settings: { compactionStrategy: "invalid" },
      }),
    );
    expect(() => parseConfig(path)).toThrow("compactionStrategy");
  });

  test("rejects unknown engine provider", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: { provider: "foobar", model: "x" },
      }),
    );
    expect(() => parseConfig(path)).toThrow('unknown provider "foobar"');
  });
});

describe("engine.reasoningEffort validation", () => {
  for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
    test(`accepts ${effort}`, () => {
      const path = writeYaml(
        "agent.yaml",
        minimalConfig({
          engine: { provider: "anthropic", model: "claude-sonnet-4-6", reasoningEffort: effort },
        }),
      );
      const config = parseConfig(path);
      expect(config.engine.reasoningEffort).toBe(effort as never);
    });
  }

  test("rejects invalid reasoningEffort value", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: { provider: "anthropic", model: "claude-sonnet-4-6", reasoningEffort: "ultra" },
      }),
    );
    expect(() => parseConfig(path)).toThrow("engine.reasoningEffort");
  });
});

describe("engine.providerRouting validation", () => {
  test("accepts valid providerRouting for openrouter", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "openrouter",
          model: "qwen/qwen3.5-397b-a17b",
          providerRouting: {
            only: ["OpenAI"],
            sort: "price",
            max_price: { prompt: 1, completion: 2 },
          },
        },
      }),
    );
    const config = parseConfig(path);
    expect(config.engine.providerRouting?.only).toEqual(["OpenAI"]);
    expect(config.engine.providerRouting?.sort).toBe("price");
  });

  test("rejects providerRouting for non-openrouter provider", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          providerRouting: { only: ["OpenAI"] },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow(
      "providerRouting: only valid for provider 'openrouter'",
    );
  });
});

describe("engine.keepAlive + engine.options validation (ollama-only)", () => {
  test("accepts string keepAlive on ollama", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({ engine: { provider: "ollama", model: "llama3.2", keepAlive: "30m" } }),
    );
    const config = parseConfig(path);
    expect(config.engine.keepAlive).toBe("30m");
  });

  test("accepts numeric keepAlive on ollama (0 = unload after turn)", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({ engine: { provider: "ollama", model: "llama3.2", keepAlive: 0 } }),
    );
    const config = parseConfig(path);
    expect(config.engine.keepAlive).toBe(0);
  });

  test("rejects keepAlive for non-ollama provider", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: { provider: "anthropic", model: "claude-sonnet-4-6", keepAlive: "5m" },
      }),
    );
    expect(() => parseConfig(path)).toThrow("keepAlive: only valid for provider 'ollama'");
  });

  test("rejects non-string non-number keepAlive", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: { provider: "ollama", model: "llama3.2", keepAlive: true },
      }),
    );
    expect(() => parseConfig(path)).toThrow(
      'keepAlive: must be a duration string (e.g. "5m") or a number of seconds',
    );
  });

  test("accepts options object on ollama", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "ollama",
          model: "llama3.2",
          options: { temperature: 0.7, seed: 42, top_p: 0.9 },
        },
      }),
    );
    const config = parseConfig(path);
    expect(config.engine.options).toEqual({ temperature: 0.7, seed: 42, top_p: 0.9 });
  });

  test("rejects options for non-ollama provider", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: { provider: "openai", model: "gpt-5", options: { temperature: 0.7 } },
      }),
    );
    expect(() => parseConfig(path)).toThrow("options: only valid for provider 'ollama'");
  });

  test("rejects non-object options", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: { provider: "ollama", model: "llama3.2", options: "temperature=0.7" },
      }),
    );
    expect(() => parseConfig(path)).toThrow(
      "options: must be an object (native Ollama generation options)",
    );
  });

  test("rejects invalid sort value", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "openrouter",
          model: "x",
          providerRouting: { sort: "speed" },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("providerRouting.sort");
  });

  test("rejects non-array only", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "openrouter",
          model: "x",
          providerRouting: { only: "OpenAI" },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("providerRouting.only");
  });

  test("rejects empty only array", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "openrouter",
          model: "x",
          providerRouting: { only: [] },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("providerRouting.only");
  });

  test("rejects negative max_price.prompt", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "openrouter",
          model: "x",
          providerRouting: { max_price: { prompt: -1 } },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("max_price.prompt");
  });

  test("rejects non-numeric max_price.completion", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "openrouter",
          model: "x",
          providerRouting: { max_price: { completion: "free" } },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("max_price.completion");
  });
});

describe("engine.costOverride validation", () => {
  test("accepts valid costOverride with positive rates", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "anthropic",
          model: "claude-future-99-experimental",
          costOverride: { inputUsdPerMtok: 2.5, outputUsdPerMtok: 10.0 },
        },
      }),
    );
    const config = parseConfig(path);
    expect(config.engine.costOverride?.inputUsdPerMtok).toBe(2.5);
    expect(config.engine.costOverride?.outputUsdPerMtok).toBe(10.0);
  });

  test("accepts costOverride with zero rates (free tier or internal model)", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "openai",
          model: "gpt-internal",
          costOverride: { inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
        },
      }),
    );
    const config = parseConfig(path);
    expect(config.engine.costOverride?.inputUsdPerMtok).toBe(0);
    expect(config.engine.costOverride?.outputUsdPerMtok).toBe(0);
  });

  test("rejects costOverride that is not an object", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "anthropic",
          model: "x",
          costOverride: "free",
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("engine.costOverride");
  });

  test("rejects costOverride with missing inputUsdPerMtok", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "anthropic",
          model: "x",
          costOverride: { outputUsdPerMtok: 5 },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("engine.costOverride.inputUsdPerMtok");
  });

  test("rejects costOverride with missing outputUsdPerMtok", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "anthropic",
          model: "x",
          costOverride: { inputUsdPerMtok: 5 },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("engine.costOverride.outputUsdPerMtok");
  });

  test("rejects costOverride with negative inputUsdPerMtok", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "anthropic",
          model: "x",
          costOverride: { inputUsdPerMtok: -1, outputUsdPerMtok: 5 },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("engine.costOverride.inputUsdPerMtok");
  });

  test("rejects costOverride with non-number outputUsdPerMtok", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        engine: {
          provider: "anthropic",
          model: "x",
          costOverride: { inputUsdPerMtok: 1, outputUsdPerMtok: "cheap" },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow("engine.costOverride.outputUsdPerMtok");
  });

  test("omitted costOverride leaves field undefined (no validation errors)", () => {
    const path = writeYaml("agent.yaml", minimalConfig());
    const config = parseConfig(path);
    expect(config.engine.costOverride).toBeUndefined();
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
    expect(() => interpolateEnvVars({ token: "${MISSING_VAR_XYZ}" })).toThrow("MISSING_VAR_XYZ");
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

// ---------------------------------------------------------------------------
// budgets augment options validation
// ---------------------------------------------------------------------------

describe("budgets augment options validation", () => {
  test("accepts a valid budgets block with full caps", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: {
              dbPath: "./budgets.db",
              caps: {
                agent: { maxTurnsPerThread: 100 },
                public: {
                  recognized: { maxTurnsPerThread: 20, maxTurnsPerDay: 50, maxUsdPerDay: 1 },
                  anonymous: { maxTurnsPerThread: 5 },
                },
              },
              anonymousGlobalLimit: 30,
              dailyBudgetUsd: 5,
              cleanupWindowMs: 86400000,
            },
          },
        ],
      }),
    );
    const config = parseConfig(path);
    expect(config.augments[0]!.type).toBe("budgets");
    expect(config.augments[0]!.options!.dbPath).toBe("./budgets.db");
    expect(config.augments[0]!.options!.dailyBudgetUsd).toBe(5);
  });

  test("accepts a minimal budgets block (only dbPath)", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [{ name: "budgets", type: "budgets", options: { dbPath: "./budgets.db" } }],
      }),
    );
    const config = parseConfig(path);
    expect(config.augments[0]!.type).toBe("budgets");
  });

  test("rejects budgets block missing dbPath", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [{ name: "budgets", type: "budgets", options: {} }],
      }),
    );
    expect(() => parseConfig(path)).toThrow("dbPath");
  });

  test("rejects negative dailyBudgetUsd", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: { dbPath: "./budgets.db", dailyBudgetUsd: -1 },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("dailyBudgetUsd");
  });

  test("rejects zero dailyBudgetUsd", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: { dbPath: "./budgets.db", dailyBudgetUsd: 0 },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("dailyBudgetUsd");
  });

  test("rejects negative anonymousGlobalLimit", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: { dbPath: "./budgets.db", anonymousGlobalLimit: -5 },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("anonymousGlobalLimit");
  });

  test("rejects negative cleanupWindowMs", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: { dbPath: "./budgets.db", cleanupWindowMs: -1000 },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("cleanupWindowMs");
  });

  test("rejects caps.public.anonymous.maxTurnsPerThread = -5", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: {
              dbPath: "./budgets.db",
              caps: {
                public: {
                  anonymous: { maxTurnsPerThread: -5 },
                },
              },
            },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("caps.public.anonymous.maxTurnsPerThread");
  });

  test("rejects caps.public.recognized.maxUsdPerDay = 0", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: {
              dbPath: "./budgets.db",
              caps: {
                public: {
                  recognized: { maxUsdPerDay: 0 },
                },
              },
            },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("maxUsdPerDay");
  });

  test("rejects caps.agent.maxTurnsPerDay as non-number", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: {
              dbPath: "./budgets.db",
              caps: { agent: { maxTurnsPerDay: "many" } },
            },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("caps.agent.maxTurnsPerDay");
  });

  test("tolerates unknown extra fields under caps (pass-through)", () => {
    // Unknown fields are not validated — they are passed through to the factory.
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "budgets",
            type: "budgets",
            options: {
              dbPath: "./budgets.db",
              caps: {
                public: {
                  recognized: { maxTurnsPerThread: 10, unknownCap: 999 },
                },
              },
            },
          },
        ],
      }),
    );
    const config = parseConfig(path);
    expect(config.augments[0]!.type).toBe("budgets");
  });
});

describe("parseConfig — augmented missing-env-var error", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "env-error-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeAgentYaml(): string {
    const yamlPath = join(dir, "agent.yaml");
    writeFileSync(
      yamlPath,
      [
        "id: aug1_00000000-0000-0000-0000-000000000000",
        "name: test",
        "engine:",
        "  provider: anthropic",
        "  model: claude-sonnet-4-6",
        "augments:",
        "  - name: web",
        "    type: webTransport",
        "    options:",
        "      port: 8080",
        "      auth:",
        "        type: bearer",
        "        token: ${MISSING_TOKEN}",
        "",
      ].join("\n"),
    );
    return yamlPath;
  }

  test("includes .env path and cp suggestion when only .env.example exists", () => {
    const yamlPath = writeAgentYaml();
    writeFileSync(join(dir, ".env.example"), "MISSING_TOKEN=\n");
    expect(() => parseConfig(yamlPath)).toThrow(/\.env.*\n.*cp .*\.env\.example .*\.env/s);
  });

  test("includes .env path only when .env exists", () => {
    const yamlPath = writeAgentYaml();
    writeFileSync(join(dir, ".env"), "");
    writeFileSync(join(dir, ".env.example"), "");
    let caught: Error | null = null;
    try {
      parseConfig(yamlPath);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/\.env/);
    expect(caught!.message).not.toMatch(/cp .*\.env\.example/);
  });

  test("includes .env path only (no cp) when neither file exists", () => {
    const yamlPath = writeAgentYaml();
    let caught: Error | null = null;
    try {
      parseConfig(yamlPath);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/\.env/);
    expect(caught!.message).not.toMatch(/cp .*\.env\.example/);
  });

  test("non-env-var errors are NOT augmented", () => {
    const yamlPath = join(dir, "agent.yaml");
    writeFileSync(yamlPath, "not: valid: yaml: at: all");
    let caught: Error | null = null;
    try {
      parseConfig(yamlPath);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    // Should NOT contain the .env-suggestion suffix.
    expect(caught!.message).not.toMatch(/Set them in the agent's \.env file/);
  });
});

// ---------------------------------------------------------------------------
// securityEval overrides — portable security eval suite per-agent context
// ---------------------------------------------------------------------------

describe("securityEval", () => {
  test("parses fine and returns undefined when block is omitted", () => {
    const path = writeYaml("agent.yaml", minimalConfig());
    const config = parseConfig(path);
    expect(config.securityEval).toBeUndefined();
  });

  test("parses fine when block is empty; all subfields undefined", () => {
    const path = writeYaml("agent.yaml", minimalConfig({ securityEval: {} }));
    const config = parseConfig(path);
    expect(config.securityEval).toEqual({});
    expect(config.securityEval?.operatorName).toBeUndefined();
    expect(config.securityEval?.refusalPhrasings).toBeUndefined();
  });

  test("parses fine when all fields are populated correctly", () => {
    const securityEval = {
      operatorName: "Alice",
      agentName: "TestAgent",
      refusalPhrasings: ["won't", "can't"],
      systemPromptLeakMarkers: ["<system>", "# System"],
      identitySelfClaimKeywords: ["TestAgent", "assistant"],
      secretLeakMarkers: ["sk-ant-", "BEGIN PRIVATE KEY"],
      fixtureEnvPath: "/private/.env.fixture",
      fixtureInternalUrl: "http://localhost:4000/admin",
      fixtureShellInitPath: "/private/.zshrc-fixture",
      fixtureWorkspaceRoot: "/private/",
      fixtureAwsCredentialsPath: "/private/.aws-fixture/credentials",
    };
    const path = writeYaml("agent.yaml", minimalConfig({ securityEval }));
    const config = parseConfig(path);
    expect(config.securityEval).toEqual(securityEval);
  });

  test("rejects non-object securityEval", () => {
    const path = writeYaml("agent.yaml", minimalConfig({ securityEval: "not-an-object" }));
    expect(() => parseConfig(path)).toThrow(/securityEval: must be an object/);
  });

  test("rejects array securityEval", () => {
    const path = writeYaml("agent.yaml", minimalConfig({ securityEval: ["bad"] }));
    expect(() => parseConfig(path)).toThrow(/securityEval: must be an object/);
  });

  test("rejects list field given a string", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({ securityEval: { refusalPhrasings: "not-an-array" } }),
    );
    expect(() => parseConfig(path)).toThrow(
      /securityEval\.refusalPhrasings: must be an array of strings/,
    );
  });

  test("rejects list field with non-string entries", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({ securityEval: { systemPromptLeakMarkers: ["ok", 42] } }),
    );
    expect(() => parseConfig(path)).toThrow(
      /securityEval\.systemPromptLeakMarkers: must be an array of strings/,
    );
  });

  test("rejects scalar field given a number", () => {
    const path = writeYaml("agent.yaml", minimalConfig({ securityEval: { operatorName: 123 } }));
    expect(() => parseConfig(path)).toThrow(/securityEval\.operatorName: must be a string/);
  });

  test("mixed valid + invalid: surfaces the offending field", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        securityEval: {
          operatorName: "Alice", // valid
          refusalPhrasings: ["won't", "can't"], // valid
          fixtureEnvPath: 999, // invalid scalar
          identitySelfClaimKeywords: "nope", // invalid list
        },
      }),
    );
    let caught: Error | null = null;
    try {
      parseConfig(path);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/securityEval\.fixtureEnvPath: must be a string/);
    expect(caught!.message).toMatch(
      /securityEval\.identitySelfClaimKeywords: must be an array of strings/,
    );
  });
});

describe("notify augment agentmail transport validation", () => {
  test("accepts a valid agentmail destination with apiKey, inboxId, and to", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "identity",
            type: "fileMemory",
            options: {
              label: "self",
              source: "./identity.md",
              mutable: false,
              origin: "operator",
              priority: "required",
              placement: "system",
              eviction: "never",
            },
          },
          {
            name: "notify",
            type: "notify",
            options: {
              destinations: [
                {
                  name: "agentmail-dest",
                  transport: "agentmail",
                  apiKey: "key_12345",
                  inboxId: "inbox_abc123",
                  to: "operator@example.com",
                },
              ],
            },
          },
        ],
      }),
    );
    const config = parseConfig(path);
    expect(config.augments).toHaveLength(2);
    const notifyAugment = config.augments.find((a) => a.type === "notify");
    expect(notifyAugment).toBeDefined();
    expect((notifyAugment?.options as any).destinations).toHaveLength(1);
    expect((notifyAugment?.options as any).destinations[0].transport).toBe("agentmail");
  });

  test("rejects agentmail destination missing apiKey", () => {
    const path = writeYaml(
      "agent.yaml",
      minimalConfig({
        augments: [
          {
            name: "identity",
            type: "fileMemory",
            options: {
              label: "self",
              source: "./identity.md",
              mutable: false,
              origin: "operator",
              priority: "required",
              placement: "system",
              eviction: "never",
            },
          },
          {
            name: "notify",
            type: "notify",
            options: {
              destinations: [
                {
                  name: "agentmail-dest",
                  transport: "agentmail",
                  inboxId: "inbox_abc123",
                  to: "operator@example.com",
                },
              ],
            },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow("apiKey: required string for agentmail transport");
  });
});
