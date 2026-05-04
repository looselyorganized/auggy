import { describe, it, expect } from "bun:test";
import { evaluateFreshness } from "../../scripts/check-pricing-freshness";

describe("check-pricing-freshness", () => {
  it("returns ok when all tables are within the threshold", () => {
    const result = evaluateFreshness([
      { name: "anthropic", verifiedAt: "2026-04-27", ageDays: 7, stale: false },
      { name: "openai", verifiedAt: "2026-04-27", ageDays: 7, stale: false },
    ]);
    expect(result.stale).toBe(false);
    expect(result.report).toHaveLength(2);
    expect(result.report[0]).toMatchObject({ name: "anthropic", ok: true });
  });

  it("flags stale tables and returns stale=true overall", () => {
    const result = evaluateFreshness([
      { name: "anthropic", verifiedAt: "2026-01-01", ageDays: 124, stale: true },
      { name: "openai", verifiedAt: "2026-04-27", ageDays: 7, stale: false },
    ]);
    expect(result.stale).toBe(true);
    expect(result.report.find((r) => r.name === "anthropic")?.ok).toBe(false);
    expect(result.report.find((r) => r.name === "openai")?.ok).toBe(true);
  });

  it("returns stale=true when ANY table is stale", () => {
    const result = evaluateFreshness([
      { name: "anthropic", verifiedAt: "2026-04-27", ageDays: 7, stale: false },
      { name: "openai", verifiedAt: "2026-01-01", ageDays: 124, stale: true },
    ]);
    expect(result.stale).toBe(true);
  });
});
