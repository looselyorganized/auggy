/**
 * Model picker — derives `auggy create` model choices from per-provider
 * pricing tables. Single source of truth for "models we can cost-track."
 *
 * The Custom escape hatch is handled in `commands/create.ts`, not here —
 * this module only enumerates priced choices.
 */

import * as anthropicPricing from "../engines/anthropic/pricing";
import * as openaiPricing from "../engines/openai/pricing";

// Provider lives in `./types` (single source of truth for the union +
// runtime mirror). Re-exported here for backward compat with the existing
// import path `import { Provider } from "./model-picker"`.
export type { Provider } from "./types";
import type { Provider } from "./types";

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
function readEntry(provider: "anthropic" | "openai", id: string): PricingTableEntry | null {
  switch (provider) {
    case "anthropic":
      return anthropicPricing.lookup(id);
    case "openai":
      return openaiPricing.lookup(id);
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

/**
 * Get the priced model choices for a provider, ordered cheapest-first.
 */
export function getModelChoices(provider: Provider): ModelChoice[] {
  const isPriced = (p: {
    id: string;
    entry: PricingTableEntry | null;
  }): p is { id: string; entry: PricingTableEntry } => p.entry !== null;

  let pairs: Array<{ id: string; entry: PricingTableEntry }>;
  switch (provider) {
    case "anthropic":
      pairs = anthropicPricing
        .listModels()
        .map((id) => ({ id, entry: readEntry("anthropic", id) }))
        .filter(isPriced);
      break;
    case "openai":
      pairs = openaiPricing
        .listModels()
        .map((id) => ({ id, entry: readEntry("openai", id) }))
        .filter(isPriced);
      break;
    case "openrouter":
      pairs = [
        ...anthropicPricing.listModels().map((id) => ({
          id: `anthropic/${id}`,
          entry: readEntry("anthropic", id),
        })),
        ...openaiPricing.listModels().map((id) => ({
          id: `openai/${id}`,
          entry: readEntry("openai", id),
        })),
      ].filter(isPriced);
      break;
    case "ollama":
      // Ollama is free + local. The wizard's primary path queries the
      // operator's installed models (see `ollama-discover.ts`) and offers
      // those. This curated list is the FALLBACK shown when discovery is
      // unavailable (ollama not installed, daemon down, remote ollama).
      //
      // Curated for tool-call reliability from Ollama's current "tools"
      // catalog plus the structured tool-call examples in Ollama docs.
      // Models with weak/ambiguous structured tool-use behavior are
      // deliberately excluded from the default list.
      return [
        { id: "qwen3.6:27b", inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
        { id: "qwen3.5:9b", inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
        { id: "qwen3.5:27b", inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
        { id: "qwen3:8b", inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
        { id: "qwen3:14b", inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
        { id: "qwen3:32b", inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
        { id: "gemma4", inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
        { id: "glm-5.1", inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
        { id: "deepseek-v3.2", inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
      ];
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
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
