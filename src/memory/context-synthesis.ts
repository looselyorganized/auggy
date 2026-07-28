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

const RECENT_NAMESPACE_MEMORY_LIMIT = 5;

/**
 * Wrap a memory provider augment so it exposes a context() function
 * that automatically retrieves its blocks from read()/search() and
 * constructs ContextBlocks using the provider's defaults.
 *
 * - Static providers: iterate all declared labels, call read() for each.
 * - Namespace providers: for message triggers, list recent entries for the
 *   current peer when supported, then call search() with the inbound message
 *   text. Non-message triggers contribute no blocks from dynamic providers.
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
      const peerId = turn.peer?.id;

      // The coordinator currently exposes canonical query reads, not an
      // unbounded "recent entries" listing primitive. Do not silently read a
      // process-local store while this turn has distributed authority.
      if (peerId && nsSpec.listEntries && !turn.executionAuthority) {
        try {
          const recent = await nsSpec.listEntries({
            peerId,
            limit: RECENT_NAMESPACE_MEMORY_LIMIT,
          });
          appendUniqueEntries(entries, recent);
        } catch (err) {
          if (isRequired) throw err;
        }
      }

      const query = extractText(payload?.parts ?? []);
      if (query) {
        try {
          const results = await nsSpec.search(query, {
            peerId,
            ...(turn.executionContext ? { executionContext: turn.executionContext } : {}),
            ...(turn.executionAuthority ? { executionAuthority: turn.executionAuthority } : {}),
          });
          appendUniqueEntries(entries, results);
        } catch (err) {
          if (isRequired) throw err;
        }
      }
    }

    return entries.map((entry) => toContextBlock(aug.name, entry, defaults));
  };

  return {
    ...aug,
    context,
  };
}

function appendUniqueEntries(target: MemoryEntry[], next: MemoryEntry[]): void {
  const seen = new Set(target.map(memoryEntryKey));
  for (const entry of next) {
    const key = memoryEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(entry);
  }
}

function memoryEntryKey(entry: MemoryEntry): string {
  return `${entry.label}\0${entry.createdAt ?? ""}\0${entry.content}`;
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
    origin: entry.origin ?? defaults.origin,
    ttl: defaults.ttl,
  };
}
