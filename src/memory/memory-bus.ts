import type { Augment } from "../types";
import { buildRegistry, getMemoryProviders } from "./registry";
import type { MemoryRegistry } from "./types";
import { synthesizeContextFor } from "./context-synthesis";
import { createMemoryTools } from "./tools";

export interface MemoryBusWiring {
  augmentsWithSynthesizedContext: Augment[];
  syntheticToolsAugment: Augment | null;
  registry: MemoryRegistry;
}

export interface WireMemoryBusOptions {
  maxPerTurn?: number;
}

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
    };
  }

  const registry = buildRegistry(providers);

  const wired = augments.map((aug) => {
    if (!aug.memory) return aug;
    if (aug.context) return aug;
    return synthesizeContextFor(aug);
  });

  const maxPerTurn = opts.maxPerTurn ?? 20;
  const { tools, onTurnEnd, onTurnStart } = createMemoryTools(registry, { maxPerTurn });

  const syntheticToolsAugment: Augment = {
    name: "memory-bus",
    capabilities: ["tools"],
    constraints: { maxToolCallsPerTurn: maxPerTurn },
    tools,
    onTurnStart: async () => {
      onTurnStart();
    },
    onTurnEnd: async (turn) => {
      onTurnEnd(turn.turnId);
    },
  };

  return {
    augmentsWithSynthesizedContext: wired,
    syntheticToolsAugment,
    registry,
  };
}
