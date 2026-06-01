import {
  type Pricing,
  type CostResult,
  type PricingFreshness,
  computeCostUsd,
  freshness,
} from "../_shared/cost";

// USD per million tokens. Update via PR when Anthropic changes pricing.
// Cache rates: write = 1.25× input, read = 0.1× input (per Anthropic docs).
const TABLE: Record<string, Pricing> = {
  "claude-opus-4-8": {
    inputUsdPerMtok: 5.0,
    outputUsdPerMtok: 25.0,
    cacheWriteUsdPerMtok: 6.25,
    cacheReadUsdPerMtok: 0.5,
  },
  "claude-opus-4-7": {
    inputUsdPerMtok: 15.0,
    outputUsdPerMtok: 75.0,
    cacheWriteUsdPerMtok: 18.75,
    cacheReadUsdPerMtok: 1.5,
  },
  "claude-opus-4-6": {
    inputUsdPerMtok: 15.0,
    outputUsdPerMtok: 75.0,
    cacheWriteUsdPerMtok: 18.75,
    cacheReadUsdPerMtok: 1.5,
  },
  "claude-sonnet-4-6": {
    inputUsdPerMtok: 3.0,
    outputUsdPerMtok: 15.0,
    cacheWriteUsdPerMtok: 3.75,
    cacheReadUsdPerMtok: 0.3,
  },
  "claude-haiku-4-5": {
    inputUsdPerMtok: 0.8,
    outputUsdPerMtok: 4.0,
    cacheWriteUsdPerMtok: 1.0,
    cacheReadUsdPerMtok: 0.08,
  },
  "claude-haiku-4-5-20251001": {
    inputUsdPerMtok: 1.0,
    outputUsdPerMtok: 5.0,
    cacheWriteUsdPerMtok: 1.25,
    cacheReadUsdPerMtok: 0.1,
  },
};

/**
 * Enumerate the model IDs in the pricing table. Used by the model picker
 * to derive UI choices without exposing the table's internal shape.
 */
export function listModels(): string[] {
  return Object.keys(TABLE);
}

const VERIFIED_AT = "2026-06-01";

export function lookup(model: string): Pricing | null {
  return TABLE[model] ?? null;
}

export function getFreshness(): PricingFreshness {
  return freshness(VERIFIED_AT);
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  /** TTL-breakdown cache field (ephemeral_5m / ephemeral_1h tokens). */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  } | null;
  service_tier?: string | null;
}

/**
 * Price an Anthropic API response.
 *
 * Returns `{ priced: false, reason }` when the response contains
 * discriminators that v0 pricing cannot model faithfully:
 *   - `usage.cache_creation` with TTL breakdown (ephemeral_5m / ephemeral_1h)
 *   - `usage.service_tier` !== "standard"
 *   - Model not in the pricing table and no override provided
 *
 * In all other cases returns `{ priced: true, costUsd }`.
 */
export function priceAnthropicResponse(
  model: string,
  override: Pricing | undefined,
  usage: AnthropicUsage,
): CostResult {
  // Discriminator gate: TTL breakdown present → unpriced.
  if (
    usage.cache_creation &&
    (usage.cache_creation.ephemeral_5m_input_tokens ||
      usage.cache_creation.ephemeral_1h_input_tokens)
  ) {
    return {
      priced: false,
      reason: "anthropic: cache_creation TTL breakdown not modeled in v0 pricing",
    };
  }

  // Discriminator gate: non-standard service tier → unpriced.
  if (usage.service_tier && usage.service_tier !== "standard") {
    return {
      priced: false,
      reason: `anthropic: service_tier=${usage.service_tier} not modeled in v0 pricing`,
    };
  }

  const rates = override ?? lookup(model);
  if (!rates) {
    return { priced: false, reason: `anthropic: no pricing entry for model "${model}"` };
  }

  const costUsd = computeCostUsd(rates, {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? undefined,
    cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
  });
  return { priced: true, costUsd };
}
