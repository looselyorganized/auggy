/**
 * Post-run evidence loader. After the harness has stopped the agent (which
 * closes the layered-memory store via onShutdown), this opens a fresh sqlite
 * store at the same dbPath and reads back every entry the run produced.
 *
 * The fresh store is needed because the augment's store was closed by
 * onShutdown. SQLite supports multiple sequential readers on the same file;
 * we're not racing with the agent.
 */

import { createSqliteStore } from "auggy/internal/augments/layeredMemory/storage/sqlite-store";
import type {
  MemoryStore,
  StoreEntry,
} from "auggy/internal/augments/layeredMemory/storage/types";

export interface InspectedEntries {
  /** All entries in the store, grouped by peerId (entries with null peerId go under the empty-string key). */
  byPeer: Record<string, StoreEntry[]>;
  /** Flat list, all entries, ordered by createdAt ascending. */
  all: StoreEntry[];
}

export async function inspectStore(opts: {
  dbPath: string;
  namespace: string;
  peerIds: string[];
}): Promise<InspectedEntries> {
  const store: MemoryStore = createSqliteStore({
    dbPath: opts.dbPath,
    retentionDays: 90,
    namespace: opts.namespace,
  });
  await store.initialize();

  const byPeer: Record<string, StoreEntry[]> = {};
  const all: StoreEntry[] = [];

  for (const peerId of opts.peerIds) {
    const labels = await store.list(peerId);
    const entries: StoreEntry[] = [];
    for (const label of labels) {
      const entry = await store.read(label);
      if (entry) entries.push(entry);
    }
    byPeer[peerId] = entries;
    all.push(...entries);
  }

  all.sort((a, b) => a.createdAt - b.createdAt);
  await store.close();
  return { byPeer, all };
}

export async function probeRecall(opts: {
  dbPath: string;
  namespace: string;
  probes: Array<{ query: string; peerId: string }>;
}): Promise<Array<{ probe: string; peerId: string; returnedLabels: string[]; returnedSubjects: string[] }>> {
  const store: MemoryStore = createSqliteStore({
    dbPath: opts.dbPath,
    retentionDays: 90,
    namespace: opts.namespace,
  });
  await store.initialize();

  const results: Array<{
    probe: string;
    peerId: string;
    returnedLabels: string[];
    returnedSubjects: string[];
  }> = [];
  for (const { query, peerId } of opts.probes) {
    const entries = await store.search(query, peerId);
    results.push({
      probe: query,
      peerId,
      returnedLabels: entries.map((e) => e.label),
      returnedSubjects: entries.map((e) => e.subject ?? ""),
    });
  }

  await store.close();
  return results;
}
