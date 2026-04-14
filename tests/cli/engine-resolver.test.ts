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
