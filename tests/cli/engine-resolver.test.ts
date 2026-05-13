import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { resolveEngine } from "../../src/cli/engine-resolver";
import type { EngineConfig } from "../../src/cli/types";

const ORIGINAL_OPENROUTER = process.env.OPENROUTER_API_KEY;
const ORIGINAL_OPENAI = process.env.OPENAI_API_KEY;

/**
 * `agentDir` is required as of v0.3.2 — the resolver dynamic-imports the
 * matching `@auggy/<engine>` package from `<agentDir>/node_modules`. In this
 * monorepo, the workspace symlinks every adapter package into the root
 * `node_modules/@auggy/*`, so `process.cwd()` (run from the repo root) is a
 * valid agentDir for tests.
 */
const AGENT_DIR = process.cwd();

describe("resolveEngine", () => {
  test("creates an Anthropic engine from config", async () => {
    const engine = await resolveEngine(
      {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        maxContextTokens: 100_000,
        maxTokens: 2048,
      },
      AGENT_DIR,
    );
    expect(engine.maxContextTokens).toBe(100_000);
    expect(typeof engine.countTokens).toBe("function");
    expect(typeof engine.complete).toBe("function");
  });

  test("uses Anthropic defaults for optional fields", async () => {
    const engine = await resolveEngine(
      {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
      AGENT_DIR,
    );
    expect(engine.maxContextTokens).toBe(200_000);
  });

  test("creates an OpenAI engine from config", async () => {
    process.env.OPENAI_API_KEY = "sk-test-resolver";
    const engine = await resolveEngine(
      {
        provider: "openai",
        model: "gpt-5",
        maxContextTokens: 256_000,
      },
      AGENT_DIR,
    );
    expect(engine.maxContextTokens).toBe(256_000);
    expect(typeof engine.countTokens).toBe("function");
    expect(typeof engine.complete).toBe("function");
  });

  test("uses OpenAI default maxContextTokens of 128_000", async () => {
    process.env.OPENAI_API_KEY = "sk-test-resolver";
    const engine = await resolveEngine(
      { provider: "openai", model: "gpt-5" },
      AGENT_DIR,
    );
    expect(engine.maxContextTokens).toBe(128_000);
  });

  test("creates an OpenRouter engine from config", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-resolver";
    const engine = await resolveEngine(
      {
        provider: "openrouter",
        model: "qwen/qwen3.5-397b-a17b",
      },
      AGENT_DIR,
    );
    expect(engine.maxContextTokens).toBe(128_000);
    expect(typeof engine.complete).toBe("function");
  });

  test("OpenRouter engine accepts providerRouting and reasoningEffort", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-resolver";
    const engine = await resolveEngine(
      {
        provider: "openrouter",
        model: "qwen/qwen3.5-397b-a17b",
        reasoningEffort: "high",
        providerRouting: { only: ["DeepInfra"], sort: "throughput" },
      },
      AGENT_DIR,
    );
    // No assertion on internal state — just verify construction succeeds
    // (the providerRouting + reasoningEffort tests live in openrouter.test.ts).
    expect(engine).toBeDefined();
  });

  // The next three tests deliberately exercise the runtime guard for
  // malformed `engine.provider` values. The type system narrows `provider`
  // to the `Provider` union, so we cast via `as unknown as EngineConfig`
  // to simulate a programmatic caller that bypassed the YAML parser /
  // config validator.
  test("throws for unknown provider with full supported list in message", async () => {
    await expect(
      resolveEngine(
        { provider: "foobar", model: "x" } as unknown as EngineConfig,
        AGENT_DIR,
      ),
    ).rejects.toThrow('Unknown engine provider: "foobar" (supported: anthropic, openai, openrouter)');
  });

  test("throws clearly when provider is empty string", async () => {
    await expect(
      resolveEngine(
        { provider: "", model: "x" } as unknown as EngineConfig,
        AGENT_DIR,
      ),
    ).rejects.toThrow("engine.provider is required");
  });

  test("throws clearly when provider is undefined (programmatic misuse)", async () => {
    await expect(
      resolveEngine(
        { provider: undefined, model: "x" } as unknown as EngineConfig,
        AGENT_DIR,
      ),
    ).rejects.toThrow("engine.provider is required");
  });

  test("does NOT forward baseURL to OpenRouter engine (hardcoded URL)", async () => {
    process.env.OPENROUTER_API_KEY = "sk-test-resolver";
    // The engine factory hardcodes the OpenRouter URL. The resolver MUST NOT
    // pass `config.baseURL` through — doing so would let an operator
    // accidentally redirect OpenRouter calls to a wrong host. The resolver
    // omits the field; we confirm here by passing a baseURL that, if
    // forwarded, would break Qwen calls.
    const engine = await resolveEngine(
      {
        provider: "openrouter",
        model: "qwen/qwen3.5-397b-a17b",
        baseURL: "https://wrong-host.example.com/v1",
      },
      AGENT_DIR,
    );
    expect(engine).toBeDefined();
    // Static regression-grep: assert the openrouter branch in source does NOT
    // assign baseURL into the options literal. The branch runs from
    // `case "openrouter":` to the `return mod.createOpenRouterEngine` line.
    const fs = require("node:fs");
    const source = fs.readFileSync("src/cli/engine-resolver.ts", "utf-8") as string;
    const openrouterBlock = source.match(
      /case "openrouter":[\s\S]*?return mod\.createOpenRouterEngine\(opts\);/,
    );
    expect(openrouterBlock).not.toBeNull();
    expect(openrouterBlock![0]).not.toMatch(/baseURL\s*:/);
  });

  test("test seam: passing a custom importer bypasses agent-dir resolution", async () => {
    // Verifies the EngineImporter parameter actually drives factory selection,
    // and that resolveEngine doesn't reach into the filesystem when stubbed.
    let importerCalls: Array<{ agentDir: string; specifier: string }> = [];
    const fakeFactory = () => ({
      maxContextTokens: 99_999,
      countTokens: (_: string) => 0,
      complete: async () => {
        throw new Error("not exercised");
      },
    });

    const importer = async <T>(agentDir: string, specifier: string): Promise<T> => {
      importerCalls.push({ agentDir, specifier });
      return { createAnthropicEngine: fakeFactory } as unknown as T;
    };

    const engine = await resolveEngine(
      { provider: "anthropic", model: "claude-sonnet-4-6" },
      "/nonexistent/agent/dir",
      importer,
    );

    expect(importerCalls).toHaveLength(1);
    expect(importerCalls[0]).toEqual({
      agentDir: "/nonexistent/agent/dir",
      specifier: "@auggy/anthropic",
    });
    expect(engine.maxContextTokens).toBe(99_999);
  });
});

afterAll(() => {
  if (ORIGINAL_OPENROUTER === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ORIGINAL_OPENROUTER;
  if (ORIGINAL_OPENAI === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI;
});

beforeEach(() => {
  // Default to env clean unless a test explicitly sets it.
  if (ORIGINAL_OPENROUTER === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ORIGINAL_OPENROUTER;
  if (ORIGINAL_OPENAI === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI;
});
