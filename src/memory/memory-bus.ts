import type { Augment } from "../types";
import {
  buildRegistry,
  getMemoryProviders,
} from "./registry";
import type { MemoryRegistry } from "./types";
import { synthesizeContextFor } from "./context-synthesis";
import { createMemoryTools, type MemoryToolBudget } from "./tools";

export interface MemoryBusWiring {
  augmentsWithSynthesizedContext: Augment[];
  syntheticToolsAugment: Augment | null;
  registry: MemoryRegistry;
  budget: MemoryToolBudget;
}

export interface WireMemoryBusOptions {
  maxPerTurn?: number;
}

/**
 * Scan an augment list for memory providers, build the label registry
 * (throwing on conflicts), synthesize context() for providers that
 * don't already have one, and create a synthetic augment carrying the
 * four generic memory tools.
 */
export function wireMemoryBus(
  augments: Augment[],
  opts: WireMemoryBusOptions = {},
): MemoryBusWiring {
  const providers = getMemoryProviders(augments);

  if (providers.length === 0) {
    const emptyRegistry: MemoryRegistry = { static: new Map(), namespaces: [] };
    return {
      augmentsWithSynthesizedContext: augments,
      syntheticToolsAugment: null,
      registry: emptyRegistry,
      budget: { calls: 0, max: opts.maxPerTurn ?? 20 },
    };
  }

  const registry = buildRegistry(providers);

  const wired = augments.map((aug) => {
    if (!aug.memory) return aug;
    if (aug.context) return aug; // respect manual context()
    return synthesizeContextFor(aug);
  });

  const maxPerTurn = opts.maxPerTurn ?? 20;
  const budget: MemoryToolBudget = {
    calls: 0,
    max: maxPerTurn,
  };

  const syntheticToolsAugment: Augment = {
    name: "memory-bus",
    capabilities: ["tools"],
    // Align the capability table's per-augment cap with the budget
    // advertised to callers. Without this, the kernel default (5)
    // would kick in and deny memory ops long before the budget runs
    // out.
    constraints: { maxToolCallsPerTurn: maxPerTurn },
    tools: createMemoryTools(registry, { budgetRef: budget }),
    onTurnStart: async () => {
      budget.calls = 0;
    },
  };

  return {
    augmentsWithSynthesizedContext: wired,
    syntheticToolsAugment,
    registry,
    budget,
  };
}
