import type {
  Augment,
  MemoryEntry,
  MemoryQueryOpts,
  MemoryWriteOpts,
} from "../types";
import { createSqliteStore } from "./layered-memory/sqlite-store";
import {
  createSupabaseStore,
  type LayeredSupabaseClient,
} from "./layered-memory/supabase-store";
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

  const search = async (
    query: string,
    queryOpts?: MemoryQueryOpts,
  ): Promise<MemoryEntry[]> => {
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
    await store.write({
      label,
      content,
      peerId: writeOpts?.peerId ?? null,
      trustLevel: writeOpts?.trustLevel ?? null,
      createdAt: Date.now(),
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });
  };

  const read = async (label: string): Promise<MemoryEntry | null> => {
    if (!label.startsWith(prefix)) return null;
    const entry = await store.read(label);
    return entry ? storeEntryToMemoryEntry(entry) : null;
  };

  const forget = async (peerId: string): Promise<number> => {
    return store.forget(peerId);
  };

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
      read,
      forget,
    },
    onShutdown: async () => {
      await store.close();
    },
  };
}
