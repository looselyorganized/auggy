import { describe, it, expect } from "bun:test";
import { buildBudgetPreamble, type BuildBudgetPreambleInput } from "@/augments/budgets/preamble";
import type { BudgetCaps } from "@/augments/budgets/types";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function zeroUsed() {
  return { thread: 0, day: 0, costUsd: 0 };
}

function input(caps: BudgetCaps | null, used = zeroUsed()): BuildBudgetPreambleInput {
  return { caps, used };
}

// ──────────────────────────────────────────────────────────────────────────────
// Suite
// ──────────────────────────────────────────────────────────────────────────────

describe("buildBudgetPreamble", () => {
  // ── 1. Null caps → null ────────────────────────────────────────────────────

  it("returns null when caps is null (bypass tier)", () => {
    expect(buildBudgetPreamble(input(null))).toBeNull();
  });

  // ── 2. Empty caps (no fields configured) → null ───────────────────────────

  it("returns null when caps has no configured fields", () => {
    expect(buildBudgetPreamble(input({}))).toBeNull();
  });

  // ── 3. Minimum ratio: takes the tightest constraint ───────────────────────

  it("computes the minimum ratio across all configured caps", () => {
    // maxTurnsPerThread: 10, used 6 → ratio 0.4
    // maxTurnsPerDay:    10, used 2 → ratio 0.8
    // Minimum should be 0.4 → "Focus on the core question. Begin wrapping up."
    const block = buildBudgetPreamble(
      input({ maxTurnsPerThread: 10, maxTurnsPerDay: 10 }, { thread: 6, day: 2, costUsd: 0 }),
    );
    expect(block).not.toBeNull();
    expect(block!.content).toContain("budgetRatio = 0.40");
    expect(block!.content).toContain("Focus on the core question. Begin wrapping up.");
  });

  // ── 4. Bucket guidance: ratio > 0.6 ──────────────────────────────────────

  it("bucket > 0.6 → 'Explore thoroughly. No urgency.'", () => {
    // 4 used of 10 → 6 remaining → ratio 0.6 is NOT > 0.6 …
    // use 3 used of 10 → 7 remaining → ratio 0.7
    const block = buildBudgetPreamble(
      input({ maxTurnsPerThread: 10 }, { thread: 3, day: 0, costUsd: 0 }),
    );
    expect(block!.content).toContain("Explore thoroughly. No urgency.");
  });

  it("bucket = exactly 0.6 → 'Explore thoroughly. No urgency.' (boundary is >= 0.6)", () => {
    // 4 used of 10 → 6 remaining → ratio exactly 0.6 → falls into Explore bucket (>= 0.6)
    const block = buildBudgetPreamble(
      input({ maxTurnsPerThread: 10 }, { thread: 4, day: 0, costUsd: 0 }),
    );
    expect(block!.content).toContain("Explore thoroughly. No urgency.");
  });

  it("bucket 0.2 <= ratio < 0.6 → 'Focus on the core question. Begin wrapping up.'", () => {
    // 7 used of 10 → 3 remaining → ratio 0.3
    const block = buildBudgetPreamble(
      input({ maxTurnsPerThread: 10 }, { thread: 7, day: 0, costUsd: 0 }),
    );
    expect(block!.content).toContain("Focus on the core question. Begin wrapping up.");
  });

  it("bucket ratio < 0.2 → 'Final response. Deliver a complete answer.'", () => {
    // 9 used of 10 → 1 remaining → ratio 0.1
    const block = buildBudgetPreamble(
      input({ maxTurnsPerThread: 10 }, { thread: 9, day: 0, costUsd: 0 }),
    );
    expect(block!.content).toContain("Final response. Deliver a complete answer.");
  });

  it("bucket ratio === 0 → 'Grace turn — summarize and close.'", () => {
    // 10 used of 10 → 0 remaining → ratio 0.0
    const block = buildBudgetPreamble(
      input({ maxTurnsPerThread: 10 }, { thread: 10, day: 0, costUsd: 0 }),
    );
    expect(block!.content).toContain("Grace turn — summarize and close.");
  });

  // ── 5. Verbatim remaining values appear in content ────────────────────────

  it("content includes verbatim turns-remaining-in-thread line", () => {
    const block = buildBudgetPreamble(
      input({ maxTurnsPerThread: 20 }, { thread: 5, day: 0, costUsd: 0 }),
    );
    expect(block!.content).toContain("Turns remaining in this thread: 15 of 20");
  });

  it("content includes verbatim turns-remaining-today line", () => {
    const block = buildBudgetPreamble(
      input({ maxTurnsPerDay: 50 }, { thread: 0, day: 10, costUsd: 0 }),
    );
    expect(block!.content).toContain("Turns remaining today: 40 of 50");
  });

  it("content includes verbatim USD spend line", () => {
    const block = buildBudgetPreamble(
      input({ maxUsdPerDay: 2.0 }, { thread: 0, day: 0, costUsd: 0.75 }),
    );
    expect(block!.content).toContain("Estimated spend today: $0.75 of $2.00");
  });

  // ── 6. USD formatting uses two decimals ───────────────────────────────────

  it("USD spend is formatted with exactly 2 decimal places", () => {
    const block = buildBudgetPreamble(
      input({ maxUsdPerDay: 1.5 }, { thread: 0, day: 0, costUsd: 0.1 }),
    );
    // $0.10 of $1.50 — must not appear as $0.1 or $1.5
    expect(block!.content).toContain("$0.10 of $1.50");
  });

  // ── 7. Negative remaining clamps to 0 ────────────────────────────────────

  it("clamps remaining to 0 when used exceeds cap (no negative remaining)", () => {
    // 12 used against cap of 10 → remaining = 0 (not -2)
    const block = buildBudgetPreamble(
      input({ maxTurnsPerThread: 10 }, { thread: 12, day: 0, costUsd: 0 }),
    );
    expect(block!.content).toContain("Turns remaining in this thread: 0 of 10");
    expect(block!.content).not.toContain("-");
  });

  it("clamps USD remaining to 0 and does not go negative", () => {
    const block = buildBudgetPreamble(
      input({ maxUsdPerDay: 1.0 }, { thread: 0, day: 0, costUsd: 1.5 }),
    );
    // ratio should be 0 → grace turn
    expect(block!.content).toContain("Grace turn — summarize and close.");
    // content must not show negative spend
    expect(block!.content).not.toMatch(/\$-/);
  });

  // ── 8. ContextBlock fields ────────────────────────────────────────────────

  it("returned block has correct source, placement, provenance, priority, eviction, origin, ttl", () => {
    const block = buildBudgetPreamble(input({ maxTurnsPerThread: 10 }, zeroUsed()));
    expect(block).not.toBeNull();
    expect(block!.source).toBe("budgets");
    expect(block!.placement).toBe("preamble");
    expect(block!.provenance).toBe("augment");
    expect(block!.priority).toBe("high");
    expect(block!.eviction).toBe("drop");
    expect(block!.origin).toBe("system");
    expect(block!.ttl).toBe("turn");
  });

  // ── 9. Multiple caps: all relevant lines appear ───────────────────────────

  it("emits all configured cap lines when all three caps are set", () => {
    const block = buildBudgetPreamble(
      input(
        { maxTurnsPerThread: 20, maxTurnsPerDay: 50, maxUsdPerDay: 1.0 },
        { thread: 5, day: 10, costUsd: 0.25 },
      ),
    );
    expect(block!.content).toContain("Turns remaining in this thread: 15 of 20");
    expect(block!.content).toContain("Turns remaining today: 40 of 50");
    expect(block!.content).toContain("Estimated spend today: $0.25 of $1.00");
  });

  // ── 10. Only maxUsdPerDay configured → still produces a block ────────────

  it("produces a block when only maxUsdPerDay is configured", () => {
    const block = buildBudgetPreamble(
      input({ maxUsdPerDay: 1.0 }, { thread: 0, day: 0, costUsd: 0.5 }),
    );
    expect(block).not.toBeNull();
    expect(block!.content).toContain("Estimated spend today: $0.50 of $1.00");
  });

  // ── 11. budgetRatio line shows two-decimal ratio ──────────────────────────

  it("budgetRatio in guidance line is formatted to two decimal places", () => {
    // 1 of 3 used → 2 remaining → ratio = 2/3 ≈ 0.67
    const block = buildBudgetPreamble(
      input({ maxTurnsPerThread: 3 }, { thread: 1, day: 0, costUsd: 0 }),
    );
    // ratio = 0.67 (toFixed(2) of 0.6666...)
    expect(block!.content).toContain("budgetRatio = 0.67");
  });
});
