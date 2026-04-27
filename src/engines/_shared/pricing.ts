export type EngineProvider = "anthropic" | "openai" | "openrouter";

export interface Pricing {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
}

// USD per million tokens. Update via PR when vendors change pricing.
// Sources verified 2026-04-27. Format: "<vendor-canonical-id>": { in, out }
const TABLES: Record<EngineProvider, Record<string, Pricing>> = {
  anthropic: {
    "claude-opus-4-7":     { inputUsdPerMtok: 15.0, outputUsdPerMtok: 75.0 },
    "claude-opus-4-6":     { inputUsdPerMtok: 15.0, outputUsdPerMtok: 75.0 },
    "claude-sonnet-4-6":   { inputUsdPerMtok: 3.0,  outputUsdPerMtok: 15.0 },
    "claude-haiku-4-5":    { inputUsdPerMtok: 0.8,  outputUsdPerMtok: 4.0  },
  },
  openai: {
    "gpt-5":               { inputUsdPerMtok: 5.0,  outputUsdPerMtok: 20.0 },
    "gpt-5-mini":          { inputUsdPerMtok: 1.0,  outputUsdPerMtok: 4.0  },
  },
  openrouter: {
    // OpenRouter routes to many providers; resolution by underlying model
    // happens in openrouter.ts. This table holds OpenRouter-native slug
    // fallbacks if any are ever needed.
  },
};

export function lookupPricing(
  provider: EngineProvider,
  model: string,
): Pricing | null {
  return TABLES[provider]?.[model] ?? null;
}

export function computeCostUsd(
  rates: Pricing,
  tokens: { inputTokens: number; outputTokens: number },
): number {
  const inputCost = (tokens.inputTokens / 1_000_000) * rates.inputUsdPerMtok;
  const outputCost = (tokens.outputTokens / 1_000_000) * rates.outputUsdPerMtok;
  return inputCost + outputCost;
}
