/**
 * Tests for src/engines/openrouter/pricing.ts
 *
 * Covers: slug resolution, provider delegation, freshness binding,
 * costOverride path, and unpriced fallback for out-of-scope slugs.
 */
import { describe, it, expect } from "bun:test";
import { resolveSlug, priceOpenRouterResponse } from "@/engines/openrouter/pricing";

describe("resolveSlug", () => {
  it("resolves anthropic/* slug to anthropic provider", () => {
    const r = resolveSlug("anthropic/claude-sonnet-4-6");
    expect(r).toBeTruthy();
    expect(r!.resolvedProvider).toBe("anthropic");
    expect(r!.rates.inputUsdPerMtok).toBe(3.0);
  });

  it("resolves openai/* slug to openai provider", () => {
    const r = resolveSlug("openai/gpt-5");
    expect(r).toBeTruthy();
    expect(r!.resolvedProvider).toBe("openai");
    expect(r!.rates.inputUsdPerMtok).toBe(5.0);
  });

  it("returns null for unknown provider prefix", () => {
    expect(resolveSlug("qwen/qwen3.5-397b-a17b")).toBeNull();
  });

  it("returns null for slug with no slash", () => {
    expect(resolveSlug("somemodel")).toBeNull();
  });

  it("returns null for anthropic/* with unknown tail", () => {
    expect(resolveSlug("anthropic/claude-future-99")).toBeNull();
  });

  it("freshness binds to resolved provider's verifiedAt (not empty openrouter table)", () => {
    const r = resolveSlug("anthropic/claude-sonnet-4-6");
    expect(r).toBeTruthy();
    // verifiedAt should come from the anthropic pricing module, which has a real date
    expect(r!.freshness.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The verifiedAt date should be a known date (not empty/default)
    expect(r!.freshness.verifiedAt).toBe("2026-04-27");
  });

  it("openai/* freshness binds to openai table's verifiedAt", () => {
    const r = resolveSlug("openai/gpt-5");
    expect(r).toBeTruthy();
    expect(r!.freshness.verifiedAt).toBe("2026-04-27");
  });
});

describe("priceOpenRouterResponse — costOverride path", () => {
  it("uses costOverride directly when set", () => {
    const result = priceOpenRouterResponse(
      "qwen/qwen3.5-397b-a17b",
      { inputUsdPerMtok: 4, outputUsdPerMtok: 16 },
      { prompt_tokens: 250, completion_tokens: 125 },
    );
    // (250/1e6)*4 + (125/1e6)*16 = 0.001 + 0.002 = 0.003
    expect(result.priced).toBe(true);
    if (result.priced) expect(result.costUsd).toBeCloseTo(0.003, 8);
  });

  it("costOverride takes precedence over slug routing", () => {
    // anthropic/claude-sonnet-4-6 would resolve to $3/$15 via routing,
    // but costOverride ($2/$6) wins.
    const result = priceOpenRouterResponse(
      "anthropic/claude-sonnet-4-6",
      { inputUsdPerMtok: 2, outputUsdPerMtok: 6 },
      { prompt_tokens: 600, completion_tokens: 300 },
    );
    // (600/1e6)*2 + (300/1e6)*6 = 0.0012 + 0.0018 = 0.003
    expect(result.priced).toBe(true);
    if (result.priced) expect(result.costUsd).toBeCloseTo(0.003, 8);
  });
});

describe("priceOpenRouterResponse — slug routing path", () => {
  it("prices anthropic/* slug via anthropic pricing module", () => {
    // anthropic/claude-sonnet-4-6: $3.00/Mtok in, $15.00/Mtok out
    // 200 in + 100 out → 0.0006 + 0.0015 = 0.0021 USD
    const result = priceOpenRouterResponse("anthropic/claude-sonnet-4-6", undefined, {
      prompt_tokens: 200,
      completion_tokens: 100,
    });
    expect(result.priced).toBe(true);
    if (result.priced) expect(result.costUsd).toBeCloseTo(0.0021, 8);
  });

  it("prices openai/* slug via openai pricing module", () => {
    // openai/gpt-5: $5.00/Mtok in, $20.00/Mtok out
    // 400 in + 200 out → 0.002 + 0.004 = 0.006 USD
    const result = priceOpenRouterResponse("openai/gpt-5", undefined, {
      prompt_tokens: 400,
      completion_tokens: 200,
    });
    expect(result.priced).toBe(true);
    if (result.priced) expect(result.costUsd).toBeCloseTo(0.006, 8);
  });

  it("returns unpriced for unknown provider slug", () => {
    const result = priceOpenRouterResponse("qwen/qwen3.5-397b-a17b", undefined, {
      prompt_tokens: 100,
      completion_tokens: 50,
    });
    expect(result.priced).toBe(false);
    if (!result.priced) {
      expect(result.reason).toContain("anthropic/* and openai/* only");
    }
  });

  it("returns unpriced for slug with no slash (no table)", () => {
    const result = priceOpenRouterResponse("somemodel", undefined, {
      prompt_tokens: 100,
      completion_tokens: 50,
    });
    expect(result.priced).toBe(false);
    if (!result.priced) {
      expect(result.reason).toContain("anthropic/* and openai/* only");
    }
  });

  it("returns unpriced for anthropic/* with unknown model tail", () => {
    const result = priceOpenRouterResponse("anthropic/claude-future-99", undefined, {
      prompt_tokens: 100,
      completion_tokens: 50,
    });
    expect(result.priced).toBe(false);
  });
});
