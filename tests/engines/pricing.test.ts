import { describe, it, expect } from "bun:test";
import { lookupPricing, computeCostUsd, getPricingVerifiedAt, isPricingStale } from "@/engines/_shared/pricing";

describe("pricing", () => {
  it("returns rates for known Anthropic models", () => {
    const r = lookupPricing("anthropic", "claude-sonnet-4-6");
    expect(r).toBeTruthy();
    expect(r!.inputUsdPerMtok).toBeGreaterThan(0);
    expect(r!.outputUsdPerMtok).toBeGreaterThan(0);
  });

  it("returns null for unknown models", () => {
    expect(lookupPricing("anthropic", "claude-future-99")).toBeNull();
  });

  it("getPricingVerifiedAt returns the verifiedAt string for anthropic", () => {
    const ts = getPricingVerifiedAt("anthropic");
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("getPricingVerifiedAt returns a string for all providers", () => {
    expect(typeof getPricingVerifiedAt("openai")).toBe("string");
    expect(typeof getPricingVerifiedAt("openrouter")).toBe("string");
  });

  it("isPricingStale returns false for a very recent verifiedAt", () => {
    // Inject 'now' as the same day as the verifiedAt → age is 0 days → not stale.
    const verifiedAt = getPricingVerifiedAt("anthropic");
    const sameDay = new Date(verifiedAt + "T12:00:00Z");
    expect(isPricingStale("anthropic", 90, sameDay)).toBe(false);
  });

  it("isPricingStale returns false just within the staleDays window", () => {
    // 89 days after verifiedAt → not stale (threshold is >90, not >=90).
    const verifiedAt = getPricingVerifiedAt("anthropic");
    const verifiedDate = new Date(verifiedAt + "T00:00:00Z");
    const almostStale = new Date(verifiedDate.getTime() + 89 * 24 * 60 * 60 * 1000);
    expect(isPricingStale("anthropic", 90, almostStale)).toBe(false);
  });

  it("isPricingStale returns true when now is more than 90 days past verifiedAt", () => {
    // 2027-01-01 is more than 90 days after 2026-04-27.
    expect(isPricingStale("anthropic", 90, new Date("2027-01-01"))).toBe(true);
  });

  it("isPricingStale accepts custom staleDays threshold", () => {
    // With staleDays=1, any date > 1 day after verifiedAt should be stale.
    const verifiedAt = getPricingVerifiedAt("anthropic");
    const twoDaysLater = new Date(new Date(verifiedAt + "T00:00:00Z").getTime() + 2 * 24 * 60 * 60 * 1000);
    expect(isPricingStale("anthropic", 1, twoDaysLater)).toBe(true);
  });

  it("computes cost from token counts", () => {
    const cost = computeCostUsd(
      { inputUsdPerMtok: 3.0, outputUsdPerMtok: 15.0 },
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    );
    expect(cost).toBeCloseTo(18.0, 4);
  });

  it("handles partial token counts proportionally", () => {
    const cost = computeCostUsd(
      { inputUsdPerMtok: 3.0, outputUsdPerMtok: 15.0 },
      { inputTokens: 100_000, outputTokens: 50_000 },
    );
    expect(cost).toBeCloseTo(0.3 + 0.75, 4);
  });

  it("computes cache-write cost when cache creation tokens are present", () => {
    const cost = computeCostUsd(
      { inputUsdPerMtok: 3.0, outputUsdPerMtok: 15.0, cacheWriteUsdPerMtok: 3.75, cacheReadUsdPerMtok: 0.3 },
      { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 1_000_000 },
    );
    expect(cost).toBeCloseTo(3.75, 4);
  });

  it("computes cache-read cost when cache read tokens are present", () => {
    const cost = computeCostUsd(
      { inputUsdPerMtok: 3.0, outputUsdPerMtok: 15.0, cacheWriteUsdPerMtok: 3.75, cacheReadUsdPerMtok: 0.3 },
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
    );
    expect(cost).toBeCloseTo(0.3, 4);
  });

  it("ignores cache tokens silently when rates aren't configured", () => {
    // OpenAI pricing has no cache rates — cache tokens shouldn't add cost.
    const cost = computeCostUsd(
      { inputUsdPerMtok: 5.0, outputUsdPerMtok: 20.0 },
      { inputTokens: 100_000, outputTokens: 0, cacheCreationTokens: 100_000, cacheReadTokens: 100_000 },
    );
    expect(cost).toBeCloseTo(0.5, 4); // only input cost = 100k/1M × $5 = $0.50
  });

  it("sums all four token classes correctly", () => {
    const cost = computeCostUsd(
      { inputUsdPerMtok: 3.0, outputUsdPerMtok: 15.0, cacheWriteUsdPerMtok: 3.75, cacheReadUsdPerMtok: 0.3 },
      {
        inputTokens: 1_000_000,         // $3.00
        outputTokens: 100_000,          // $1.50
        cacheCreationTokens: 200_000,   // $0.75
        cacheReadTokens: 1_000_000,     // $0.30
      },
    );
    expect(cost).toBeCloseTo(5.55, 4);
  });
});
