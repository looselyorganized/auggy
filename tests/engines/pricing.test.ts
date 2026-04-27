import { describe, it, expect } from "bun:test";
import { lookupPricing, computeCostUsd } from "@/engines/_shared/pricing";

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
});
