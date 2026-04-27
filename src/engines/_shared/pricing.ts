export type EngineProvider = "anthropic" | "openai" | "openrouter";

export interface Pricing {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheWriteUsdPerMtok?: number;  // Anthropic: 1.25× input rate (cache creation)
  cacheReadUsdPerMtok?: number;   // Anthropic: 0.1× input rate (cache read)
}

/** Per-provider pricing table with a freshness timestamp. */
interface ProviderTable {
  /** ISO date (YYYY-MM-DD) when these rates were last verified against
   *  the upstream vendor's pricing page. Used by isPricingStale(). */
  verifiedAt: string;
  models: Record<string, Pricing>;
}

// USD per million tokens. Update via PR when vendors change pricing.
// Format: "<vendor-canonical-id>": { in, out }
// Anthropic cache rates: write = 1.25× input, read = 0.1× input (per Anthropic docs).
const TABLES: Record<EngineProvider, ProviderTable> = {
  anthropic: {
    verifiedAt: "2026-04-27",
    models: {
      "claude-opus-4-7":     { inputUsdPerMtok: 15.0, outputUsdPerMtok: 75.0, cacheWriteUsdPerMtok: 18.75, cacheReadUsdPerMtok: 1.5 },
      "claude-opus-4-6":     { inputUsdPerMtok: 15.0, outputUsdPerMtok: 75.0, cacheWriteUsdPerMtok: 18.75, cacheReadUsdPerMtok: 1.5 },
      "claude-sonnet-4-6":   { inputUsdPerMtok: 3.0,  outputUsdPerMtok: 15.0, cacheWriteUsdPerMtok: 3.75,  cacheReadUsdPerMtok: 0.3 },
      "claude-haiku-4-5":    { inputUsdPerMtok: 0.8,  outputUsdPerMtok: 4.0,  cacheWriteUsdPerMtok: 1.0,   cacheReadUsdPerMtok: 0.08 },
    },
  },
  openai: {
    verifiedAt: "2026-04-27",
    models: {
      "gpt-5":               { inputUsdPerMtok: 5.0,  outputUsdPerMtok: 20.0 },
      "gpt-5-mini":          { inputUsdPerMtok: 1.0,  outputUsdPerMtok: 4.0  },
    },
  },
  openrouter: {
    verifiedAt: "2026-04-27",
    models: {
      // OpenRouter routes to many providers; resolution by underlying model
      // happens in openrouter.ts. This table holds OpenRouter-native slug
      // fallbacks if any are ever needed.
    },
  },
};

export function lookupPricing(
  provider: EngineProvider,
  model: string,
): Pricing | null {
  return TABLES[provider]?.models?.[model] ?? null;
}

/** Return the verifiedAt timestamp for a provider's pricing table. */
export function getPricingVerifiedAt(provider: EngineProvider): string {
  return TABLES[provider].verifiedAt;
}

/**
 * Return true if a provider's pricing table is older than staleDays (default 90).
 * Pass `now` to inject a reference date for testing.
 */
export function isPricingStale(
  provider: EngineProvider,
  staleDays = 90,
  now: Date = new Date(),
): boolean {
  const verified = new Date(TABLES[provider].verifiedAt + "T00:00:00Z");
  const ageMs = now.getTime() - verified.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays > staleDays;
}

export function computeCostUsd(
  rates: Pricing,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  },
): number {
  const inputCost = (tokens.inputTokens / 1_000_000) * rates.inputUsdPerMtok;
  const outputCost = (tokens.outputTokens / 1_000_000) * rates.outputUsdPerMtok;

  // Cache costs only contribute when both the rate AND the tokens are present.
  // If a model has no cache rates (e.g. OpenAI), cache tokens are silently ignored.
  // If the response has no cache tokens, no cost added.
  let cacheWriteCost = 0;
  if (tokens.cacheCreationTokens && rates.cacheWriteUsdPerMtok !== undefined) {
    cacheWriteCost = (tokens.cacheCreationTokens / 1_000_000) * rates.cacheWriteUsdPerMtok;
  }
  let cacheReadCost = 0;
  if (tokens.cacheReadTokens && rates.cacheReadUsdPerMtok !== undefined) {
    cacheReadCost = (tokens.cacheReadTokens / 1_000_000) * rates.cacheReadUsdPerMtok;
  }

  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}
