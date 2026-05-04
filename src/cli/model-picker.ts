/**
 * Model picker — derives `aug1 create` model choices from per-provider
 * pricing tables. Single source of truth for "models we can cost-track."
 *
 * The Custom escape hatch is handled in `commands/create.ts`, not here —
 * this module only enumerates priced choices.
 */

import * as anthropicPricing from "../engines/anthropic/pricing";
import * as openaiPricing from "../engines/openai/pricing";

export type Provider = "anthropic" | "openai" | "openrouter";

export interface ModelChoice {
  /** Model ID as it appears in agent.yaml `engine.model`. */
  id: string;
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
}

interface PricingTableEntry {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
}

/**
 * Read raw pricing tables. We import each provider's pricing module and
 * call `listModels()` + `lookup()` to enumerate priced choices without
 * coupling to the internal table shape.
 */
function readEntry(provider: Provider, id: string): PricingTableEntry | null {
  if (provider === "anthropic") return anthropicPricing.lookup(id);
  if (provider === "openai") return openaiPricing.lookup(id);
  return null;
}

/**
 * Get the priced model choices for a provider, ordered cheapest-first.
 */
export function getModelChoices(provider: Provider): ModelChoice[] {
  let pairs: Array<{ id: string; entry: PricingTableEntry }> = [];

  if (provider === "anthropic") {
    const ids = anthropicPricing.listModels();
    pairs = ids
      .map((id) => ({ id, entry: readEntry(provider, id) }))
      .filter((p): p is { id: string; entry: PricingTableEntry } => p.entry !== null);
  } else if (provider === "openai") {
    const ids = openaiPricing.listModels();
    pairs = ids
      .map((id) => ({ id, entry: readEntry(provider, id) }))
      .filter((p): p is { id: string; entry: PricingTableEntry } => p.entry !== null);
  } else if (provider === "openrouter") {
    const anthropicSlugs = anthropicPricing.listModels().map((id) => ({
      id: `anthropic/${id}`,
      entry: readEntry("anthropic", id),
    }));
    const openaiSlugs = openaiPricing.listModels().map((id) => ({
      id: `openai/${id}`,
      entry: readEntry("openai", id),
    }));
    pairs = [...anthropicSlugs, ...openaiSlugs].filter(
      (p): p is { id: string; entry: PricingTableEntry } => p.entry !== null,
    );
  }

  return pairs
    .map((p) => ({
      id: p.id,
      inputUsdPerMtok: p.entry.inputUsdPerMtok,
      outputUsdPerMtok: p.entry.outputUsdPerMtok,
    }))
    .sort((a, b) => a.inputUsdPerMtok - b.inputUsdPerMtok);
}

/**
 * Format a choice as: `<id> — $<input>/$<output> per Mtok`.
 *
 * Sub-dollar rates render with two decimals ($0.80, not $0.8); whole-dollar
 * rates render without decimals ($3, not $3.00).
 */
export function formatChoiceLabel(choice: ModelChoice): string {
  const fmt = (n: number): string => {
    if (Number.isInteger(n)) return `$${n}`;
    if (n < 1) return `$${n.toFixed(2)}`;
    return `$${n}`;
  };
  return `${choice.id} — ${fmt(choice.inputUsdPerMtok)}/${fmt(choice.outputUsdPerMtok)} per Mtok`;
}
