export interface Pricing {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheWriteUsdPerMtok?: number; // Anthropic: 1.25× input rate (cache creation)
  cacheReadUsdPerMtok?: number; // Anthropic: 0.1× input rate (cache read)
}

export type CostResult = { priced: true; costUsd: number } | { priced: false; reason: string };

export interface PricingFreshness {
  verifiedAt: string;
  ageDays: number;
  stale: boolean;
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

/**
 * Returns freshness metadata for a pricing table given its verifiedAt date.
 * Pass `now` to inject a reference date for testing.
 */
export function freshness(
  verifiedAt: string,
  staleDays = 90,
  now: Date = new Date(),
): PricingFreshness {
  const verified = new Date(`${verifiedAt}T00:00:00Z`);
  const ageDays = (now.getTime() - verified.getTime()) / 86_400_000;
  return { verifiedAt, ageDays, stale: ageDays > staleDays };
}

/**
 * Derive a CostResult from a ModelResponse's pricing fields. Used at every
 * trace-recording site in the turn loop so the priced/unpriced classification
 * is consistent across the regular inference loop, the consecutive-failure
 * recovery path, and any future terminal-inference sites.
 *
 * Typed loosely on the shape rather than importing ModelResponse to avoid
 * the dependency cycle (engines/_shared/ is below kernel in the layering).
 */
export function costFromResponse(response: {
  costUsd?: number;
  unpricedReason?: string;
}): CostResult {
  if (response.costUsd !== undefined) {
    if (Number.isFinite(response.costUsd) && response.costUsd >= 0) {
      return { priced: true, costUsd: response.costUsd };
    }
    return { priced: false, reason: "engine returned invalid costUsd" };
  }
  return { priced: false, reason: response.unpricedReason ?? "engine returned no costUsd" };
}

/**
 * Emit a warning when an operator supplies cache-rate overrides for an
 * adapter that doesn't parse cache tokens from the upstream response.
 * No-op when neither cache rate is set. Used by the OpenAI + OpenRouter
 * adapters; Anthropic parses cache tokens natively and doesn't need it.
 *
 * `adapterLabel` is the short string used in the engine-warning prefix
 * (e.g. "openai", "openrouter"). It's interpolated into both the message
 * prefix and the body so operators see a consistent breadcrumb.
 */
export function warnCacheRatesIgnored(adapterLabel: string, override: Pricing): void {
  if (override.cacheWriteUsdPerMtok === undefined && override.cacheReadUsdPerMtok === undefined) {
    return;
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[engines/${adapterLabel}] costOverride.cacheWriteUsdPerMtok/cacheReadUsdPerMtok set but ignored — ` +
      `the ${adapterLabel} adapter does not parse cache tokens from upstream responses. Cache rates will not contribute to costUsd.`,
  );
}
