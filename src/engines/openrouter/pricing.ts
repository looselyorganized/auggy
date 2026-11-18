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

// OpenRouter publishes its own IDs at https://openrouter.ai/api/v1/models.
// Each bundled route is paired with the direct model whose base rates it shares.
const upstreamModels = new Map<string, string>([
  ["anthropic/claude-fable-5", "claude-fable-5"],
  ["anthropic/claude-opus-4.8", "claude-opus-4-8"],
  ["anthropic/claude-opus-4.7", "claude-opus-4-7"],
  ["anthropic/claude-opus-4.6", "claude-opus-4-6"],
  ["anthropic/claude-sonnet-4.6", "claude-sonnet-4-6"],
  ["anthropic/claude-haiku-4.5", "claude-haiku-4-5"],
  ["openai/gpt-5.5", "gpt-5.5"],
  ["openai/gpt-5.4", "gpt-5.4"],
  ["openai/gpt-5.4-mini", "gpt-5.4-mini"],
  ["openai/gpt-5", "gpt-5"],
  ["openai/gpt-5-mini", "gpt-5-mini"],
]);

export function listModels(): string[] {
  return Array.from(upstreamModels.keys());
}

/**
 * Resolve an OpenRouter model slug ("<provider>/<model>") to a pricing entry.
 *
 * v0 SCOPE: anthropic/* and openai/* slugs only. Other providers return null.
 * The resolved freshness binds to the upstream provider's table verifiedAt,
 * not OpenRouter's own (which has no table entries).
 */
export function resolveSlug(model: string): ResolvedPricing | null {
  const upstream = upstreamModels.get(model);
  if (!upstream) return null;
  const resolvedProvider = model.startsWith("anthropic/") ? "anthropic" : "openai";
  const pricing = resolvedProvider === "anthropic" ? anthropicPricing : openaiPricing;
  const rates = pricing.lookup(upstream);
  return rates ? { rates, resolvedProvider, freshness: pricing.getFreshness() } : null;
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
