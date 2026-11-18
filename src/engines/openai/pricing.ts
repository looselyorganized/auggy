import {
  type Pricing,
  type CostResult,
  type PricingFreshness,
  computeCostUsd,
  freshness,
} from "../_shared/cost";

// Standard short-context API USD per million tokens, verified against each
// model's pricing at https://developers.openai.com/api/docs/models/<model>.
const TABLE: Record<string, Pricing> = {
  "gpt-6.2-astra": {
    inputUsdPerMtok: 8,
    outputUsdPerMtok: 40,
    cacheReadUsdPerMtok: 0.4,
    cacheWriteUsdPerMtok: 10,
  },
  "gpt-6.2-sol": {
    inputUsdPerMtok: 2,
    outputUsdPerMtok: 10,
    cacheReadUsdPerMtok: 0.1,
    cacheWriteUsdPerMtok: 2.5,
  },
  "gpt-5.5": { inputUsdPerMtok: 5.0, outputUsdPerMtok: 30.0 },
  "gpt-5.4": { inputUsdPerMtok: 2.5, outputUsdPerMtok: 15.0 },
  "gpt-5.4-mini": { inputUsdPerMtok: 0.75, outputUsdPerMtok: 4.5 },
  "gpt-5": { inputUsdPerMtok: 1.25, outputUsdPerMtok: 10.0 },
  "gpt-5-mini": { inputUsdPerMtok: 0.25, outputUsdPerMtok: 2.0 },
};

/**
 * Enumerate the model IDs in the pricing table. Used by the model picker
 * to derive UI choices without exposing the table's internal shape.
 */
export function listModels(): string[] {
  return Object.keys(TABLE);
}

const VERIFIED_AT = "2026-11-13";

export function lookup(model: string): Pricing | null {
  return TABLE[model] ?? null;
}

export function getFreshness(): PricingFreshness {
  return freshness(VERIFIED_AT);
}

export function usesResponsesAPI(model: string): boolean {
  return model === "gpt-6.2-astra" || model === "gpt-6.2-sol";
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function priceResponsesUsage(
  model: string,
  override: Pricing | undefined,
  tier: unknown,
  usage:
    | {
        input_tokens: number;
        output_tokens: number;
        input_tokens_details?: {
          cached_tokens: number;
          cache_write_tokens: number;
          cache_write_tokens_details?: { ttl_30m_tokens: number; ttl_12h_tokens: number };
        };
      }
    | null
    | undefined,
): CostResult {
  if (tier != null && tier !== "default" && tier !== "standard") {
    return { priced: false, reason: "openai: unsupported service tier" };
  }
  const details = usage?.input_tokens_details;
  const reads = details?.cached_tokens;
  const writes = details?.cache_write_tokens;
  const split = details?.cache_write_tokens_details;
  // The adapter explicitly requests 30m writes. When supplied, the reported
  // lifetime breakdown takes precedence (including upgraded cache entries).
  const short = split ? split.ttl_30m_tokens : writes;
  const long = split ? split.ttl_12h_tokens : 0;
  if (
    !usage ||
    !count(usage.input_tokens) ||
    !count(usage.output_tokens) ||
    !count(reads) ||
    !count(writes) ||
    !count(short) ||
    !count(long) ||
    short + long !== writes ||
    reads + writes > usage.input_tokens
  ) {
    return { priced: false, reason: "openai: invalid Responses usage" };
  }
  const rates = override ?? lookup(model);
  if (
    !rates ||
    (reads && rates.cacheReadUsdPerMtok === undefined) ||
    (writes && rates.cacheWriteUsdPerMtok === undefined)
  ) {
    return { priced: false, reason: "openai: missing applicable token rate" };
  }
  const longContext = !override && usage.input_tokens > 272_000;
  const input =
    (usage.input_tokens - reads - writes) * rates.inputUsdPerMtok +
    reads * (rates.cacheReadUsdPerMtok ?? 0) +
    (short + long * (override ? 1 : 2)) * (rates.cacheWriteUsdPerMtok ?? 0);
  // Responses output_tokens already includes reasoning tokens.
  return {
    priced: true,
    costUsd:
      (input * (longContext ? 2 : 1) +
        usage.output_tokens * rates.outputUsdPerMtok * (longContext ? 1.5 : 1)) /
      1_000_000,
  };
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens?: number;
  /** Reasoning tokens are billed at the output rate for reasoning-capable GPT models. */
  reasoning_tokens?: number;
}

/**
 * Price an OpenAI Chat Completions response.
 *
 * Reasoning tokens are folded into outputTokens because
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
