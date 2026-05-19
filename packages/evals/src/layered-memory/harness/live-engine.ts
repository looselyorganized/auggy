/**
 * Live extraction engine — thin wrapper around @anthropic-ai/sdk conforming
 * to the layered-memory ExtractionEngine interface.
 *
 * Used by the Haiku smoke test (evals/layered-memory/smoke.ts) to validate
 * that the wiring works end-to-end against a real model. NOT used by the
 * mock-mode runner.
 *
 * The smoke test is deliberately tiny and Haiku-only — budget is ≤ $1.50.
 * If you find yourself wanting to extend this to Sonnet or to a saturating
 * A/B, see docs/solutions/findings/autosave-default-decision-2026-05-12.md
 * for why pre-user-stage A/B at scale is theater.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ExtractionEngine } from "auggy/internal/augments/layered-memory/extractor/inject-handler";
import { computeCostUsd, type Pricing } from "auggy/internal/cost";

const HAIKU_MODEL = "claude-haiku-4-5";

const HAIKU_PRICING: Pricing = {
  inputUsdPerMtok: 0.8,
  outputUsdPerMtok: 4.0,
};

export interface LiveEngineHandle {
  engine: ExtractionEngine;
  /** Per-call cost the engine reported; sum gives total spend. */
  costs: number[];
  /** Per-call latency in ms. */
  latencies: number[];
}

export function createHaikuExtractionEngine(opts?: { apiKey?: string }): LiveEngineHandle {
  const client = new Anthropic({ apiKey: opts?.apiKey });
  const costs: number[] = [];
  const latencies: number[] = [];

  const engine: ExtractionEngine = {
    async complete(prompt: string) {
      const start = Date.now();
      const response = await client.messages.create({
        model: HAIKU_MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });
      const latency = Date.now() - start;

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("");

      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      const costUsd = computeCostUsd(HAIKU_PRICING, { inputTokens, outputTokens });

      costs.push(costUsd);
      latencies.push(latency);
      return { text, costUsd };
    },
  };

  return { engine, costs, latencies };
}
