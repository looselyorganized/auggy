import { describe, test, expect } from "bun:test";
import { getModelChoices, formatChoiceLabel, type ModelChoice } from "../../src/cli/model-picker";

describe("getModelChoices", () => {
  test("anthropic returns all anthropic table keys", () => {
    const choices = getModelChoices("anthropic");
    const ids = choices.map((c) => c.id);
    expect(ids).toContain("claude-haiku-4-5");
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("claude-opus-4-8");
    expect(ids).toContain("claude-opus-4-6");
    expect(ids).toContain("claude-opus-4-7");
    expect(choices.every((c) => typeof c.inputUsdPerMtok === "number")).toBe(true);
  });

  test("openai returns all openai table keys", () => {
    const choices = getModelChoices("openai");
    const ids = choices.map((c) => c.id);
    expect(ids).toContain("gpt-5.5");
    expect(ids).toContain("gpt-5.4");
    expect(ids).toContain("gpt-5.4-mini");
    expect(ids).toContain("gpt-5");
    expect(ids).toContain("gpt-5-mini");
  });

  test("openrouter returns cross-product of upstream tables", () => {
    const choices = getModelChoices("openrouter");
    const ids = choices.map((c) => c.id);
    expect(ids).toContain("anthropic/claude-sonnet-4-6");
    expect(ids).toContain("anthropic/claude-opus-4-8");
    expect(ids).toContain("openai/gpt-5.4-mini");
    expect(ids).toContain("openai/gpt-5");
    expect(ids).toContain("anthropic/claude-haiku-4-5");
    expect(ids).toContain("openai/gpt-5-mini");
  });

  test("choices are ordered cheapest-first by input rate", () => {
    const choices = getModelChoices("anthropic");
    for (let i = 1; i < choices.length; i++) {
      const cur = choices[i]!;
      const prev = choices[i - 1]!;
      expect(cur.inputUsdPerMtok).toBeGreaterThanOrEqual(prev.inputUsdPerMtok);
    }
  });
});

describe("formatChoiceLabel", () => {
  test("formats with two decimal places when below $1", () => {
    const choice: ModelChoice = {
      id: "claude-haiku-4-5",
      inputUsdPerMtok: 0.8,
      outputUsdPerMtok: 4.0,
    };
    expect(formatChoiceLabel(choice)).toBe("claude-haiku-4-5 — $0.80/$4 per Mtok");
  });

  test("formats with no decimal when integer", () => {
    const choice: ModelChoice = {
      id: "claude-sonnet-4-6",
      inputUsdPerMtok: 3,
      outputUsdPerMtok: 15,
    };
    expect(formatChoiceLabel(choice)).toBe("claude-sonnet-4-6 — $3/$15 per Mtok");
  });
});
