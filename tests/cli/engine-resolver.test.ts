import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { resolveEngine } from "../../src/cli/engine-resolver";

const ORIGINAL_OPENROUTER = process.env.OPENROUTER_API_KEY;

describe("resolveEngine", () => {
  test("creates an Anthropic engine from config", () => {
    const engine = resolveEngine({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      maxContextTokens: 100_000,
      maxTokens: 2048,
    });
    expect(engine.maxContextTokens).toBe(100_000);
    expect(typeof engine.countTokens).toBe("function");
    expect(typeof engine.complete).toBe("function");
  });

  test("uses Anthropic defaults for optional fields", () => {
    const engine = resolveEngine({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(engine.maxContextTokens).toBe(200_000);
  });

  test("creates an OpenAI engine from config", () => {
    const engine = resolveEngine({
      provider: "openai",
      model: "gpt-5",
      maxContextTokens: 256_000,
    });
    expect(engine.maxContextTokens).toBe(256_000);
    expect(typeof engine.countTokens).toBe("function");
    expect(typeof engine.complete).toBe("function");
  });

  test("uses OpenAI default maxContextTokens of 128_000", () => {
    const engine = resolveEngine({ provider: "openai", model: "gpt-5" });
    expect(engine.maxContextTokens).toBe(128_000);
  });

  test("creates an OpenRouter engine from config", () => {
    process.env.OPENROUTER_API_KEY = "sk-test-resolver";
    const engine = resolveEngine({
      provider: "openrouter",
      model: "qwen/qwen3.5-397b-a17b",
    });
    expect(engine.maxContextTokens).toBe(128_000);
    expect(typeof engine.complete).toBe("function");
  });

  test("OpenRouter engine accepts providerRouting and reasoningEffort", () => {
    process.env.OPENROUTER_API_KEY = "sk-test-resolver";
    const engine = resolveEngine({
      provider: "openrouter",
      model: "qwen/qwen3.5-397b-a17b",
      reasoningEffort: "high",
      providerRouting: { only: ["DeepInfra"], sort: "throughput" },
    });
    // No assertion on internal state — just verify construction succeeds
    // (the providerRouting + reasoningEffort tests live in openrouter.test.ts).
    expect(engine).toBeDefined();
  });

  test("throws for unknown provider with full supported list in message", () => {
    expect(() =>
      resolveEngine({ provider: "foobar", model: "x" }),
    ).toThrow(
      'Unknown engine provider: "foobar" (supported: anthropic, openai, openrouter)',
    );
  });

  test("throws clearly when provider is empty string", () => {
    expect(() => resolveEngine({ provider: "", model: "x" })).toThrow(
      "engine.provider is required",
    );
  });

  test("throws clearly when provider is undefined (programmatic misuse)", () => {
    expect(() =>
      resolveEngine({
        provider: undefined as unknown as string,
        model: "x",
      }),
    ).toThrow("engine.provider is required");
  });

  test("does NOT forward baseURL to OpenRouter engine (hardcoded URL)", () => {
    process.env.OPENROUTER_API_KEY = "sk-test-resolver";
    // The engine factory hardcodes the OpenRouter URL. The resolver MUST NOT
    // pass `config.baseURL` through — doing so would let an operator
    // accidentally redirect OpenRouter calls to a wrong host. The resolver
    // omits the field; we confirm here by passing a baseURL that, if
    // forwarded, would break Qwen calls.
    expect(() =>
      resolveEngine({
        provider: "openrouter",
        model: "qwen/qwen3.5-397b-a17b",
        baseURL: "https://wrong-host.example.com/v1",
      }),
    ).not.toThrow();
    // The engine constructed successfully — if baseURL had been forwarded,
    // the openrouter engine would still construct (it's just the wrong URL),
    // so this test on its own can't fully prove non-forwarding. The static
    // contract is: src/cli/engine-resolver.ts openrouter branch does not
    // pass baseURL. Codify it as a regression-grep test instead:
    const fs = require("node:fs");
    const source = fs.readFileSync(
      "src/cli/engine-resolver.ts",
      "utf-8",
    ) as string;
    // Find the openrouter branch and confirm baseURL is absent within it.
    const openrouterBlock = source.match(
      /config\.provider === "openrouter"[\s\S]*?createOpenRouterEngine\([\s\S]*?\}\);/,
    );
    expect(openrouterBlock).not.toBeNull();
    expect(openrouterBlock![0]).not.toMatch(/baseURL\s*:/);
  });
});

afterAll(() => {
  if (ORIGINAL_OPENROUTER === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ORIGINAL_OPENROUTER;
});

beforeEach(() => {
  // Default to env clean unless a test explicitly sets it.
  if (ORIGINAL_OPENROUTER === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ORIGINAL_OPENROUTER;
});
