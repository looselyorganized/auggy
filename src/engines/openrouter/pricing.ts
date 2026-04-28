import {
  type Pricing,
  type CostResult,
  type PricingFreshness,
  computeCostUsd,
} from "../_shared/cost";
import * as anthropicPricing from "../anthropic/pricing";
import * as openaiPricing from "../openai/pricing";

interface ResolvedPricing {
  rates: Pricing;
  resolvedProvider: "anthropic" | "openai" | "openrouter";
  freshness: PricingFreshness;
}

/**
 * Resolve an OpenRouter model slug ("<provider>/<model>") to a pricing entry.
 *
 * v0 SCOPE: anthropic/* and openai/* slugs only. Other providers return null.
 * The resolved freshness binds to the upstream provider's table verifiedAt,
 * not OpenRouter's own (which has no table entries).
 */
export function resolveSlug(model: string): ResolvedPricing | null {
  const slashIdx = model.indexOf("/");
  if (slashIdx === -1) return null;
  const prefix = model.slice(0, slashIdx);
  const tail = model.slice(slashIdx + 1);

  if (prefix === "anthropic") {
    const rates = anthropicPricing.lookup(tail);
    if (!rates) return null;
    return { rates, resolvedProvider: "anthropic", freshness: anthropicPricing.getFreshness() };
  }

  if (prefix === "openai") {
    const rates = openaiPricing.lookup(tail);
    if (!rates) return null;
    return { rates, resolvedProvider: "openai", freshness: openaiPricing.getFreshness() };
  }

  return null;
}

export interface OpenRouterUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

/**
 * Price an OpenRouter response.
 *
 * Resolution order:
 *  1. If costOverride is set, use it directly.
 *  2. Try to resolve the model slug via anthropic/* or openai/* delegation.
 *  3. If neither applies, return unpriced (out of v0 scope).
 */
export function priceOpenRouterResponse(
  model: string,
  override: Pricing | undefined,
  usage: OpenRouterUsage,
): CostResult {
  if (override) {
    const costUsd = computeCostUsd(override, {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
    });
    return { priced: true, costUsd };
  }

  const resolved = resolveSlug(model);
  if (!resolved) {
    return {
      priced: false,
      reason: `openrouter: slug "${model}" outside v0 scope (anthropic/* and openai/* only)`,
    };
  }

  const costUsd = computeCostUsd(resolved.rates, {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
  });
  return { priced: true, costUsd };
}
