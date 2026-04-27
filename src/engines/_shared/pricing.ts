export type EngineProvider = "anthropic" | "openai" | "openrouter";

export interface Pricing {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheWriteUsdPerMtok?: number;  // Anthropic: 1.25× input rate (cache creation)
  cacheReadUsdPerMtok?: number;   // Anthropic: 0.1× input rate (cache read)
}

// USD per million tokens. Update via PR when vendors change pricing.
// Sources verified 2026-04-27. Format: "<vendor-canonical-id>": { in, out }
// Anthropic cache rates: write = 1.25× input, read = 0.1× input (per Anthropic docs).
const TABLES: Record<EngineProvider, Record<string, Pricing>> = {
  anthropic: {
    "claude-opus-4-7":     { inputUsdPerMtok: 15.0, outputUsdPerMtok: 75.0, cacheWriteUsdPerMtok: 18.75, cacheReadUsdPerMtok: 1.5 },
    "claude-opus-4-6":     { inputUsdPerMtok: 15.0, outputUsdPerMtok: 75.0, cacheWriteUsdPerMtok: 18.75, cacheReadUsdPerMtok: 1.5 },
    "claude-sonnet-4-6":   { inputUsdPerMtok: 3.0,  outputUsdPerMtok: 15.0, cacheWriteUsdPerMtok: 3.75,  cacheReadUsdPerMtok: 0.3 },
    "claude-haiku-4-5":    { inputUsdPerMtok: 0.8,  outputUsdPerMtok: 4.0,  cacheWriteUsdPerMtok: 1.0,   cacheReadUsdPerMtok: 0.08 },
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
