import {
  type Pricing,
  type CostResult,
  type PricingFreshness,
  computeCostUsd,
  freshness,
} from "../_shared/cost";

// USD per million tokens. Update via PR when OpenAI changes pricing.
const TABLE: Record<string, Pricing> = {
  "gpt-5": { inputUsdPerMtok: 5.0, outputUsdPerMtok: 20.0 },
  "gpt-5-mini": { inputUsdPerMtok: 1.0, outputUsdPerMtok: 4.0 },
};

/**
 * Enumerate the model IDs in the pricing table. Used by the model picker
 * to derive UI choices without exposing the table's internal shape.
 */
export function listModels(): string[] {
  return Object.keys(TABLE);
}

const VERIFIED_AT = "2026-04-27";

export function lookup(model: string): Pricing | null {
  return TABLE[model] ?? null;
}

export function getFreshness(): PricingFreshness {
  return freshness(VERIFIED_AT);
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens?: number;
  /** Reasoning tokens are billed at the output rate for o-series / gpt-5.1. */
  reasoning_tokens?: number;
}

/**
 * Price an OpenAI Chat Completions response.
 *
 * Reasoning tokens (o-series, gpt-5.1) are folded into outputTokens because
 * they are billed at the output rate.
 *
 * Returns `{ priced: false, reason }` when the model is not in the table and
 * no override is provided.
 */
export function priceOpenAIResponse(
  model: string,
  override: Pricing | undefined,
  usage: OpenAIUsage,
): CostResult {
  const rates = override ?? lookup(model);
  if (!rates) {
    return { priced: false, reason: `openai: no pricing entry for model "${model}"` };
  }

  // Reasoning tokens are billed as output for GPT-5/o-series.
  const outputTokens = usage.completion_tokens + (usage.reasoning_tokens ?? 0);
  const costUsd = computeCostUsd(rates, {
    inputTokens: usage.prompt_tokens,
    outputTokens,
  });
  return { priced: true, costUsd };
}
