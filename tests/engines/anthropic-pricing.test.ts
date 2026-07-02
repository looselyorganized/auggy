/**
 * Tests for src/engines/anthropic/pricing.ts
 *
 * Covers: table lookup, freshness, discriminator gates (TTL/service_tier),
 * costOverride, and standard cache-creation/cache-read pricing.
 */
import { describe, it, expect } from "bun:test";
import { lookup, getFreshness, priceAnthropicResponse } from "@/engines/anthropic/pricing";

describe("anthropic lookup", () => {
  it("returns rates for known models", () => {
    const r = lookup("claude-sonnet-4-6");
    expect(r).toBeTruthy();
    expect(r!.inputUsdPerMtok).toBeGreaterThan(0);
    expect(r!.outputUsdPerMtok).toBeGreaterThan(0);
  });

  it("returns null for unknown models", () => {
    expect(lookup("claude-future-99")).toBeNull();
  });

  it("returns correct haiku rates", () => {
    const r = lookup("claude-haiku-4-5");
    expect(r).toBeTruthy();
    expect(r!.inputUsdPerMtok).toBe(0.8);
    expect(r!.outputUsdPerMtok).toBe(4.0);
    expect(r!.cacheWriteUsdPerMtok).toBe(1.0);
    expect(r!.cacheReadUsdPerMtok).toBe(0.08);
  });

  it("returns correct opus 4.8 rates", () => {
    const r = lookup("claude-opus-4-8");
    expect(r).toBeTruthy();
    expect(r!.inputUsdPerMtok).toBe(5.0);
    expect(r!.outputUsdPerMtok).toBe(25.0);
    expect(r!.cacheWriteUsdPerMtok).toBe(6.25);
    expect(r!.cacheReadUsdPerMtok).toBe(0.5);
  });

  it("returns correct fable 5 rates", () => {
    const r = lookup("claude-fable-5");
    expect(r).toBeTruthy();
    expect(r!.inputUsdPerMtok).toBe(10.0);
    expect(r!.outputUsdPerMtok).toBe(50.0);
    expect(r!.cacheWriteUsdPerMtok).toBe(12.5);
    expect(r!.cacheReadUsdPerMtok).toBe(1.0);
  });
});

describe("anthropic getFreshness", () => {
  it("returns a verifiedAt in YYYY-MM-DD format", () => {
    const f = getFreshness();
    expect(f.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("is not stale as of the verified date", () => {
    // Inject 'now' as the verified date itself → age 0.
    const { freshness } = require("@/engines/_shared/cost");
    const f = freshness("2026-06-01", 90, new Date("2026-06-01T12:00:00Z"));
    expect(f.stale).toBe(false);
  });
});

describe("priceAnthropicResponse — standard path", () => {
  it("prices known model correctly (sonnet)", () => {
    const result = priceAnthropicResponse("claude-sonnet-4-6", undefined, {
      input_tokens: 100,
      output_tokens: 50,
    });
    // (100/1e6)*3.0 + (50/1e6)*15.0 = 0.0003 + 0.00075 = 0.00105
    expect(result.priced).toBe(true);
    if (result.priced) expect(result.costUsd).toBeCloseTo(0.00105, 8);
  });

  it("includes cache creation and cache read tokens", () => {
    const result = priceAnthropicResponse("claude-sonnet-4-6", undefined, {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 200_000,
      cache_read_input_tokens: 1_000_000,
    });
    // input: (100/1e6)*3.0 = 0.0003
    // output: (50/1e6)*15.0 = 0.00075
    // cache_write: (200000/1e6)*3.75 = 0.75
    // cache_read: (1000000/1e6)*0.3 = 0.3
    // total: 1.05105
    expect(result.priced).toBe(true);
    if (result.priced) expect(result.costUsd).toBeCloseTo(1.05105, 6);
  });

  it("costOverride takes precedence over pricing table", () => {
    const result = priceAnthropicResponse(
      "claude-sonnet-4-6",
      { inputUsdPerMtok: 1, outputUsdPerMtok: 2 },
      { input_tokens: 300, output_tokens: 150 },
    );
    // (300/1e6)*1 + (150/1e6)*2 = 0.0003 + 0.0003 = 0.0006
    expect(result.priced).toBe(true);
    if (result.priced) expect(result.costUsd).toBeCloseTo(0.0006, 8);
  });

  it("returns unpriced for unknown model with no override", () => {
    const result = priceAnthropicResponse("claude-future-99", undefined, {
      input_tokens: 100,
      output_tokens: 50,
    });
    expect(result.priced).toBe(false);
    if (!result.priced) expect(result.reason).toMatch(/no pricing entry/);
  });
});

describe("priceAnthropicResponse — TTL discriminator gate", () => {
  it("returns unpriced when cache_creation has ephemeral_5m_input_tokens", () => {
    const result = priceAnthropicResponse("claude-sonnet-4-6", undefined, {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 50_000 },
    });
    expect(result.priced).toBe(false);
    if (!result.priced) {
      expect(result.reason).toContain("cache_creation TTL breakdown");
    }
  });

  it("returns unpriced when cache_creation has ephemeral_1h_input_tokens", () => {
    const result = priceAnthropicResponse("claude-sonnet-4-6", undefined, {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation: { ephemeral_1h_input_tokens: 30_000 },
    });
    expect(result.priced).toBe(false);
    if (!result.priced) {
      expect(result.reason).toContain("cache_creation TTL breakdown");
    }
  });

  it("is NOT gated when cache_creation is null", () => {
    const result = priceAnthropicResponse("claude-sonnet-4-6", undefined, {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation: null,
    });
    // null cache_creation → no TTL to gate on → priced normally
    expect(result.priced).toBe(true);
  });

  it("is NOT gated when cache_creation has neither ephemeral field", () => {
    // cache_creation object present but neither TTL field set
    const result = priceAnthropicResponse("claude-sonnet-4-6", undefined, {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation: {},
    });
    expect(result.priced).toBe(true);
  });
});

describe("priceAnthropicResponse — service_tier discriminator gate", () => {
  it("returns unpriced for non-standard service_tier", () => {
    const result = priceAnthropicResponse("claude-sonnet-4-6", undefined, {
      input_tokens: 100,
      output_tokens: 50,
      service_tier: "priority",
    });
    expect(result.priced).toBe(false);
    if (!result.priced) {
      expect(result.reason).toContain("service_tier=priority");
    }
  });

  it("prices normally when service_tier is 'standard'", () => {
    const result = priceAnthropicResponse("claude-sonnet-4-6", undefined, {
      input_tokens: 100,
      output_tokens: 50,
      service_tier: "standard",
    });
    expect(result.priced).toBe(true);
  });

  it("prices normally when service_tier is absent", () => {
    const result = priceAnthropicResponse("claude-sonnet-4-6", undefined, {
      input_tokens: 100,
      output_tokens: 50,
    });
    expect(result.priced).toBe(true);
  });

  it("prices normally when service_tier is null", () => {
    const result = priceAnthropicResponse("claude-sonnet-4-6", undefined, {
      input_tokens: 100,
      output_tokens: 50,
      service_tier: null,
    });
    expect(result.priced).toBe(true);
  });
});
