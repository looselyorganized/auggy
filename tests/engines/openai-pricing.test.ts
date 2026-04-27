/**
 * Tests for src/engines/openai/pricing.ts
 *
 * Covers: table lookup, freshness, reasoning_token folding, costOverride.
 */
import { describe, it, expect } from "bun:test";
import { lookup, getFreshness, priceOpenAIResponse } from "@/engines/openai/pricing";

describe("openai lookup", () => {
  it("returns rates for known models", () => {
    const r = lookup("gpt-5");
    expect(r).toBeTruthy();
    expect(r!.inputUsdPerMtok).toBe(5.0);
    expect(r!.outputUsdPerMtok).toBe(20.0);
  });

  it("returns correct gpt-5-mini rates", () => {
    const r = lookup("gpt-5-mini");
    expect(r).toBeTruthy();
    expect(r!.inputUsdPerMtok).toBe(1.0);
    expect(r!.outputUsdPerMtok).toBe(4.0);
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
    // (200/1e6)*5.0 + (100/1e6)*20.0 = 0.001 + 0.002 = 0.003
    expect(result.priced).toBe(true);
    if (result.priced) expect(result.costUsd).toBeCloseTo(0.003, 8);
  });

  it("prices gpt-5-mini correctly", () => {
    const result = priceOpenAIResponse("gpt-5-mini", undefined, {
      prompt_tokens: 500,
      completion_tokens: 250,
    });
    // (500/1e6)*1.0 + (250/1e6)*4.0 = 0.0005 + 0.001 = 0.0015
    expect(result.priced).toBe(true);
    if (result.priced) expect(result.costUsd).toBeCloseTo(0.0015, 8);
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
    // gpt-5: $5/Mtok in, $20/Mtok out
    // 100 prompt + 50 completion + 30 reasoning = 80 billed output
    // (100/1e6)*5 + (80/1e6)*20 = 0.0005 + 0.0016 = 0.0021
    const result = priceOpenAIResponse("gpt-5", undefined, {
      prompt_tokens: 100,
      completion_tokens: 50,
      reasoning_tokens: 30,
    });
    expect(result.priced).toBe(true);
    if (result.priced) expect(result.costUsd).toBeCloseTo(0.0021, 8);
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
    // (100/1e6)*5 + (200/1e6)*20 = 0.0005 + 0.004 = 0.0045
    const result = priceOpenAIResponse("gpt-5", undefined, {
      prompt_tokens: 100,
      completion_tokens: 0,
      reasoning_tokens: 200,
    });
    expect(result.priced).toBe(true);
    if (result.priced) expect(result.costUsd).toBeCloseTo(0.0045, 8);
  });
});
