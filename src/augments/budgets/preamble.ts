import type { ContextBlock } from "../../types";
import type { BudgetCaps } from "./types";

export interface BuildBudgetPreambleInput {
  caps: BudgetCaps | null;
  used: { thread: number; day: number; costUsd: number; unpricedTurns: number };
}

/**
 * Build a BATS-style budget context block. Returns null when caps
 * is null (bypass tier — creator/internal trigger) or when no caps
 * fields are configured (nothing to render).
 *
 * The block content includes:
 *   - Per-cap remaining values (turns/thread, turns/day, $/day)
 *   - A behavioral guidance line based on the minimum budgetRatio
 *
 * Bucketed (not continuous) is deliberate — four distinct behavioral
 * modes are more interpretable to a prose model than a smooth gradient.
 *
 *   ratio > 0.6        → "Explore thoroughly. No urgency."
 *   ratio 0.2 ≤ 0.6    → "Focus on the core question. Begin wrapping up."
 *   ratio < 0.2        → "Final response. Deliver a complete answer."
 *   ratio === 0        → "Grace turn — summarize and close."
 *
 * Note on timing: when context() is called the current turn's reservation
 * is already committed (turn-gate confirm runs before the context
 * pipeline). So `used.thread` counts the current turn as consumed —
 * "remaining" values correctly reflect how many turns are left *after*
 * this one.
 */
export function buildBudgetPreamble(input: BuildBudgetPreambleInput): ContextBlock | null {
  if (input.caps === null) return null;

  const ratios: number[] = [];
  if (input.caps.maxTurnsPerThread !== undefined) {
    const remaining = Math.max(0, input.caps.maxTurnsPerThread - input.used.thread);
    ratios.push(remaining / input.caps.maxTurnsPerThread);
  }
  if (input.caps.maxTurnsPerDay !== undefined) {
    const remaining = Math.max(0, input.caps.maxTurnsPerDay - input.used.day);
    ratios.push(remaining / input.caps.maxTurnsPerDay);
  }
  if (input.caps.maxUsdPerDay !== undefined) {
    const remaining = Math.max(0, input.caps.maxUsdPerDay - input.used.costUsd);
    ratios.push(remaining / input.caps.maxUsdPerDay);
  }

  if (ratios.length === 0) return null;
  const ratio = Math.min(...ratios);

  const lines: string[] = [];
  if (input.caps.maxTurnsPerThread !== undefined) {
    const remaining = Math.max(0, input.caps.maxTurnsPerThread - input.used.thread);
    lines.push(`Turns remaining in this thread: ${remaining} of ${input.caps.maxTurnsPerThread}`);
  }
  if (input.caps.maxTurnsPerDay !== undefined) {
    const remaining = Math.max(0, input.caps.maxTurnsPerDay - input.used.day);
    lines.push(`Turns remaining today: ${remaining} of ${input.caps.maxTurnsPerDay}`);
  }
  if (input.caps.maxUsdPerDay !== undefined) {
    lines.push(
      `Estimated spend today: $${input.used.costUsd.toFixed(2)} of $${input.caps.maxUsdPerDay.toFixed(2)}`,
    );
  }
  // Note: `input.used.unpricedTurns` is intentionally NOT rendered into the
  // BATS preamble. Codex adversarial review (2026-05-04) flagged that
  // exposing "Unpriced turns today: N" to the model lets a misaligned agent
  // infer when budget enforcement is degraded — exactly the moment more
  // spend can fly under the cap. The counter remains accessible via
  // store.getPeerUsage() for operator-side tooling (deferred — see ROADMAP
  // "Cost: operator cost-read API").
  lines.push("");
  lines.push(`Behavioral guidance (budgetRatio = ${ratio.toFixed(2)}): ${bucketGuidance(ratio)}`);

  return {
    source: "budgets",
    content: lines.join("\n"),
    placement: "preamble",
    provenance: "augment",
    priority: "high",
    eviction: "drop",
    origin: "system",
    ttl: "turn",
  };
}

function bucketGuidance(ratio: number): string {
  if (ratio <= 0.0) return "Grace turn — summarize and close.";
  if (ratio < 0.2) return "Final response. Deliver a complete answer.";
  if (ratio < 0.6) return "Focus on the core question. Begin wrapping up.";
  return "Explore thoroughly. No urgency.";
}
