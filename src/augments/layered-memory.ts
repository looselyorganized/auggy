import type { Augment, MemoryEntry, MemoryQueryOpts, MemoryWriteOpts } from "../types";
import { createSqliteStore } from "./layered-memory/sqlite-store";
import { createSupabaseStore, type LayeredSupabaseClient } from "./layered-memory/supabase-store";
import type { MemoryStore, StoreEntry } from "./layered-memory/types";

export interface LayeredMemoryOptions {
  backend: "sqlite" | "supabase";
  namespace: string;
  retentionDays?: number;
  // SQLite-specific
  dbPath?: string;
  // Supabase-specific
  client?: LayeredSupabaseClient;
  table?: string;
}

function storeEntryToMemoryEntry(e: StoreEntry): MemoryEntry {
  return {
    label: e.label,
    content: e.content,
    peerId: e.peerId ?? undefined,
    trustLevel: e.trustLevel ?? undefined,
    createdAt: e.createdAt,
    supersededBy: e.supersededBy ?? undefined,
    retentionClass: e.retentionClass,
    isVerbatim: e.isVerbatim,
  };
}

export async function layeredMemory(opts: LayeredMemoryOptions): Promise<Augment> {
  const prefix = opts.namespace.endsWith(":") ? opts.namespace : `${opts.namespace}:`;
  const retentionDays = opts.retentionDays ?? 90;

  let store: MemoryStore;
  if (opts.backend === "sqlite") {
    if (!opts.dbPath) throw new Error("layeredMemory: sqlite backend requires dbPath");
    store = createSqliteStore({ dbPath: opts.dbPath, retentionDays });
  } else if (opts.backend === "supabase") {
    if (!opts.client || !opts.table) {
      throw new Error("layeredMemory: supabase backend requires client and table");
    }
    store = createSupabaseStore({
      client: opts.client,
      table: opts.table,
      retentionDays,
    });
  } else {
    throw new Error(`layeredMemory: unknown backend "${opts.backend}"`);
  }

  await store.initialize();

  const search = async (query: string, queryOpts?: MemoryQueryOpts): Promise<MemoryEntry[]> => {
    const results = await store.search(query, queryOpts?.peerId);
    return results.map(storeEntryToMemoryEntry);
  };

  const write = async (
    label: string,
    content: string,
    writeOpts?: MemoryWriteOpts,
  ): Promise<void> => {
    if (!label.startsWith(prefix)) {
      throw new Error(
        `layeredMemory: label "${label}" does not start with namespace prefix "${prefix}"`,
      );
    }
    // Structural peer-binding: if a peerId is provided, the label MUST be
    // scoped to that peer (format: <prefix><peerId> or <prefix><peerId>:<rest>).
    // This prevents peer A from writing to a label like "ep:vis_b:1" — even if
    // they guessed it — by storing a row whose label segment claims another
    // peer. Without this, search remains peer-isolated (rows are stored with
    // the caller's peer_id, not the label's), but the database accumulates
    // misleading rows that could surface in audit/forget paths.
    const peerId = writeOpts?.peerId;
    if (peerId) {
      const peerScopedPrefix = `${prefix}${peerId}`;
      if (label !== peerScopedPrefix && !label.startsWith(`${peerScopedPrefix}:`)) {
        throw new Error(
          `layeredMemory: peer "${peerId}" cannot write to label "${label}" — labels must be scoped as "${peerScopedPrefix}" or "${peerScopedPrefix}:<topic>"`,
        );
      }
    }

    await store.write({
      label,
      content,
      peerId: peerId ?? null,
      trustLevel: writeOpts?.trustLevel ?? null,
      createdAt: Date.now(),
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });
  };

  const forget = async (peerId: string): Promise<number> => {
    return store.forget(peerId);
  };

  // NOTE: read() is intentionally NOT exposed on this NamespaceMemoryProvider.
  // Episodic memory is peer-scoped — direct label reads bypass that scoping
  // because the generic memory_read tool only checks origin, not peer
  // ownership of the label. Callers must use search (peer-scoped via
  // ToolExecuteContext) instead. memory_read on an "ep:" label will return
  // "does not support reading by label", which is the desired behavior.

  return {
    name: `layered-memory-${opts.namespace}`,
    capabilities: ["context", "tools"],
    memory: {
      owns: { kind: "namespace", prefix },
      defaults: {
        mutable: true,
        origin: "peer-derived",
        priority: "normal",
        placement: "preamble",
        eviction: "drop",
        ttl: "session",
      },
      search,
      write,
      forget,
    },
    onShutdown: async () => {
      await store.close();
    },
  };
}
