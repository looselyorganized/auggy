import type {
  Augment,
  ContextBlock,
  TurnState,
  MemoryEntry,
  MemoryDefaults,
  InboundMessage,
  StaticMemoryProvider,
  NamespaceMemoryProvider,
} from "../types";
import { extractText } from "../parts";

/**
 * Wrap a memory provider augment so it exposes a context() function
 * that automatically retrieves its blocks from read()/search() and
 * constructs ContextBlocks using the provider's defaults.
 *
 * - Static providers: iterate all declared labels, call read() for each.
 * - Namespace providers: call search() with the inbound message text,
 *   but only for message triggers. Non-message triggers contribute no
 *   blocks from dynamic providers.
 *
 * Errors are re-thrown iff the augment is marked required, otherwise
 * they are swallowed so memory failures don't abort turns.
 */
export function synthesizeContextFor(aug: Augment): Augment {
  const spec = aug.memory!;
  const { defaults } = spec;
  const isRequired = aug.required === true;

  const context = async (turn: TurnState): Promise<ContextBlock[]> => {
    const entries: MemoryEntry[] = [];

    if (spec.owns.kind === "static") {
      const staticSpec = spec as StaticMemoryProvider;
      for (const label of staticSpec.owns.labels) {
        try {
          const entry = await staticSpec.read(label);
          if (entry) entries.push(entry);
        } catch (err) {
          if (isRequired) throw err;
        }
      }
    } else {
      // Namespace provider — only retrieve on message triggers
      if (turn.trigger.type !== "message") return [];
      const nsSpec = spec as NamespaceMemoryProvider;
      const payload = turn.trigger.payload as InboundMessage;
      const query = extractText(payload?.parts ?? []);
      if (!query) return [];
      try {
        const results = await nsSpec.search(query, { peerId: turn.peer?.id });
        entries.push(...results);
      } catch (err) {
        if (isRequired) throw err;
      }
    }

    return entries.map((entry) => toContextBlock(aug.name, entry, defaults));
  };

  return {
    ...aug,
    context,
  };
}

function toContextBlock(
  source: string,
  entry: MemoryEntry,
  defaults: MemoryDefaults,
): ContextBlock {
  return {
    source,
    content: entry.content,
    placement: defaults.placement,
    provenance: "memory",
    priority: defaults.priority,
    eviction: defaults.eviction,
    origin: defaults.origin,
    ttl: defaults.ttl,
  };
}
