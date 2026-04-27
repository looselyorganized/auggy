/**
 * Tests for src/engines/_shared/cost.ts — arithmetic helpers + freshness.
 *
 * Per-adapter pricing table tests live in:
 *   tests/engines/anthropic-pricing.test.ts
 *   tests/engines/openai-pricing.test.ts
 *   tests/engines/openrouter-pricing.test.ts
 */
import { describe, it, expect } from "bun:test";
import { computeCostUsd, freshness } from "@/engines/_shared/cost";

describe("computeCostUsd", () => {
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

describe("freshness", () => {
  it("returns false for a very recent verifiedAt", () => {
    // Same day as verifiedAt → age is 0 days → not stale.
    const f = freshness("2026-04-27", 90, new Date("2026-04-27T12:00:00Z"));
    expect(f.stale).toBe(false);
    expect(f.verifiedAt).toBe("2026-04-27");
    expect(f.ageDays).toBeCloseTo(0.5, 1);
  });

  it("returns false just within the staleDays window", () => {
    // 89 days after verifiedAt → not stale (threshold is >90, not >=90).
    const verifiedDate = new Date("2026-04-27T00:00:00Z");
    const almostStale = new Date(verifiedDate.getTime() + 89 * 86_400_000);
    const f = freshness("2026-04-27", 90, almostStale);
    expect(f.stale).toBe(false);
  });

  it("returns true when now is more than 90 days past verifiedAt", () => {
    // 2027-01-01 is more than 90 days after 2026-04-27.
    const f = freshness("2026-04-27", 90, new Date("2027-01-01"));
    expect(f.stale).toBe(true);
  });

  it("accepts custom staleDays threshold", () => {
    // With staleDays=1, any date > 1 day after verifiedAt should be stale.
    const twoDaysLater = new Date(new Date("2026-04-27T00:00:00Z").getTime() + 2 * 86_400_000);
    const f = freshness("2026-04-27", 1, twoDaysLater);
    expect(f.stale).toBe(true);
  });
});
