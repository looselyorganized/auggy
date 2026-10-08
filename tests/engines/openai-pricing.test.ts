/**
 * Tests for src/engines/openai/pricing.ts
 *
 * Covers: table lookup, freshness, reasoning_token folding, costOverride.
 */
import { describe, it, expect } from "bun:test";
import { lookup, getFreshness, priceOpenAIResponse } from "@/engines/openai/pricing";

describe("openai lookup", () => {
  it("returns rates for known models", () => {
    const r = lookup("gpt-5.5");
    expect(r).toBeTruthy();
    expect(r!.inputUsdPerMtok).toBe(5.0);
    expect(r!.outputUsdPerMtok).toBe(30.0);
  });

  it("returns correct gpt-5.4-mini rates", () => {
    const r = lookup("gpt-5.4-mini");
    expect(r).toBeTruthy();
    expect(r!.inputUsdPerMtok).toBe(0.75);
    expect(r!.outputUsdPerMtok).toBe(4.5);
  });

  it("returns correct gpt-5-mini rates", () => {
    const r = lookup("gpt-5-mini");
    expect(r).toBeTruthy();
    expect(r!.inputUsdPerMtok).toBe(0.25);
    expect(r!.outputUsdPerMtok).toBe(2.0);
  });

  it("returns null for unknown models", () => {
    expect(lookup("gpt-future-99")).toBeNull();
  });
});

describe("openai getFreshness", () => {
  it("returns a verifiedAt in YYYY-MM-DD format", () => {
    const f = getFreshness();
    expect(f.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("priceOpenAIResponse — standard path", () => {
  it("prices known model correctly (gpt-5)", () => {
    const result = priceOpenAIResponse("gpt-5", undefined, {
      prompt_tokens: 200,
      completion_tokens: 100,
    });
    // (200/1e6)*1.25 + (100/1e6)*10.0 = 0.00025 + 0.001 = 0.00125
    expect(result.priced).toBe(true);
    if (result.priced) expect(result.costUsd).toBeCloseTo(0.00125, 8);
  });

  it("prices gpt-5-mini correctly", () => {
    const result = priceOpenAIResponse("gpt-5-mini", undefined, {
      prompt_tokens: 500,
      completion_tokens: 250,
    });
    // (500/1e6)*0.25 + (250/1e6)*2.0 = 0.000125 + 0.0005 = 0.000625
    expect(result.priced).toBe(true);
    if (result.priced) expect(result.costUsd).toBeCloseTo(0.000625, 8);
  });

  it("returns unpriced for unknown model with no override", () => {
    const result = priceOpenAIResponse("gpt-future-99", undefined, {
      prompt_tokens: 100,
      completion_tokens: 50,
    });
    expect(result.priced).toBe(false);
    if (!result.priced) expect(result.reason).toMatch(/no pricing entry/);
  });

  it("costOverride takes precedence over pricing table", () => {
    const result = priceOpenAIResponse(
      "gpt-5",
      { inputUsdPerMtok: 1, outputUsdPerMtok: 4 },
      { prompt_tokens: 600, completion_tokens: 300 },
    );
    // (600/1e6)*1 + (300/1e6)*4 = 0.0006 + 0.0012 = 0.0018
    expect(result.priced).toBe(true);
    if (result.priced) expect(result.costUsd).toBeCloseTo(0.0018, 8);
  });

  it("costOverride populates costUsd for unknown model", () => {
    const result = priceOpenAIResponse(
      "gpt-future-99",
      { inputUsdPerMtok: 3, outputUsdPerMtok: 12 },
      { prompt_tokens: 400, completion_tokens: 200 },
    );
    // (400/1e6)*3 + (200/1e6)*12 = 0.0012 + 0.0024 = 0.0036
    expect(result.priced).toBe(true);
    if (result.priced) expect(result.costUsd).toBeCloseTo(0.0036, 8);
  });
});

describe("priceOpenAIResponse — reasoning token folding", () => {
  it("folds reasoning_tokens into output for billing", () => {
    // gpt-5: $1.25/Mtok in, $10/Mtok out
    // 100 prompt + 50 completion + 30 reasoning = 80 billed output
    // (100/1e6)*1.25 + (80/1e6)*10 = 0.000125 + 0.0008 = 0.000925
    const result = priceOpenAIResponse("gpt-5", undefined, {
      prompt_tokens: 100,
      completion_tokens: 50,
      reasoning_tokens: 30,
    });
    expect(result.priced).toBe(true);
    if (result.priced) expect(result.costUsd).toBeCloseTo(0.000925, 8);
  });

  it("pricing without reasoning_tokens is identical to zero reasoning_tokens", () => {
    const withZero = priceOpenAIResponse("gpt-5", undefined, {
      prompt_tokens: 100,
      completion_tokens: 50,
      reasoning_tokens: 0,
    });
    const withoutField = priceOpenAIResponse("gpt-5", undefined, {
      prompt_tokens: 100,
      completion_tokens: 50,
    });
    expect(withZero.priced).toBe(true);
    expect(withoutField.priced).toBe(true);
    if (withZero.priced && withoutField.priced) {
      expect(withZero.costUsd).toBeCloseTo(withoutField.costUsd, 10);
    }
  });

  it("reasoning_tokens only — zero completion_tokens", () => {
    // 200 reasoning only → billed as 200 output
    // (100/1e6)*1.25 + (200/1e6)*10 = 0.000125 + 0.002 = 0.002125
    const result = priceOpenAIResponse("gpt-5", undefined, {
      prompt_tokens: 100,
      completion_tokens: 0,
      reasoning_tokens: 200,
    });
    expect(result.priced).toBe(true);
    if (result.priced) expect(result.costUsd).toBeCloseTo(0.002125, 8);
  });
});
