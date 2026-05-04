#!/usr/bin/env bun
/**
 * Pricing freshness CI gate.
 *
 * Imports each engine's getFreshness() and exits non-zero when any table
 * has verifiedAt > 90 days old. Forces a quarterly verification PR.
 *
 * Run via: bun run scripts/check-pricing-freshness.ts
 *
 * OpenRouter is NOT checked here — it has no own table (delegates to
 * anthropic and openai by slug prefix). Checking the two upstream tables
 * covers OpenRouter transitively.
 */
import type { PricingFreshness } from "../src/engines/_shared/cost";
import { getFreshness as anthropicFreshness } from "../src/engines/anthropic/pricing";
import { getFreshness as openaiFreshness } from "../src/engines/openai/pricing";

interface FreshnessInput {
  name: string;
  verifiedAt: string;
  ageDays: number;
  stale: boolean;
}

interface FreshnessReport {
  name: string;
  verifiedAt: string;
  ageDays: number;
  ok: boolean;
}

interface EvaluationResult {
  stale: boolean;
  report: FreshnessReport[];
}

/**
 * Pure function the test harness exercises. Takes the freshness inputs,
 * returns whether any are stale plus a per-table report.
 */
export function evaluateFreshness(inputs: FreshnessInput[]): EvaluationResult {
  const report = inputs.map((i) => ({
    name: i.name,
    verifiedAt: i.verifiedAt,
    ageDays: i.ageDays,
    ok: !i.stale,
  }));
  return {
    stale: report.some((r) => !r.ok),
    report,
  };
}

function inputFromFreshness(name: string, f: PricingFreshness): FreshnessInput {
  return { name, verifiedAt: f.verifiedAt, ageDays: f.ageDays, stale: f.stale };
}

function main(): void {
  const inputs: FreshnessInput[] = [
    inputFromFreshness("anthropic", anthropicFreshness()),
    inputFromFreshness("openai", openaiFreshness()),
  ];
  const result = evaluateFreshness(inputs);

  for (const r of result.report) {
    if (r.ok) {
      // eslint-disable-next-line no-console
      console.log(
        `[pricing-freshness] ${r.name}: verifiedAt ${r.verifiedAt} (${Math.floor(r.ageDays)} days old) — ok`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.error(
        `[pricing-freshness] ${r.name}: verifiedAt ${r.verifiedAt} is ${Math.floor(r.ageDays)} days old (threshold 90). ` +
          `Verify rates against the provider's pricing page and update src/engines/${r.name}/pricing.ts.`,
      );
    }
  }

  if (result.stale) {
    process.exit(1);
  }
}

// Only invoke main when run as a script. import.meta.main is true when
// `bun run scripts/check-pricing-freshness.ts`; false when imported by a test.
if (import.meta.main) {
  main();
}
