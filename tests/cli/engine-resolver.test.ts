import { describe, test, expect } from "bun:test";
import { resolveEngine } from "../../src/cli/engine-resolver";

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

  test("uses defaults for optional fields", () => {
    const engine = resolveEngine({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(engine.maxContextTokens).toBe(200_000);
  });

  test("throws for unknown provider", () => {
    expect(() =>
      resolveEngine({ provider: "openai", model: "gpt-4" }),
    ).toThrow('Unknown engine provider: "openai"');
  });
});
