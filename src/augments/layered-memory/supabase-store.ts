import { randomUUID } from "node:crypto";
import type {
  MemoryStore,
  RetentionClass,
  StoreEntry,
  SupabaseStoreConfig,
} from "./types";
import type { TrustLevel } from "../../types";

/**
 * Wider Supabase client interface for layeredMemory: adds delete()
 * and update() to the chain so we can implement forget/supersede.
 *
 * Structurally compatible with @supabase/supabase-js and with the
 * extended mock in tests/fixtures/mock-supabase.ts.
 */
export interface LayeredSupabaseClient {
  from(table: string): {
    insert(row: unknown): PromiseLike<{ error: Error | null }>;
    select(columns?: string): {
      eq(
        column: string,
        value: unknown,
      ): {
        maybeSingle(): PromiseLike<{ data: unknown; error: Error | null }>;
      };
      ilike(
        column: string,
        value: string,
      ): {
        order(
          column: string,
          opts?: { ascending?: boolean },
        ): {
          limit(
            n: number,
          ): PromiseLike<{ data: unknown[]; error: Error | null }>;
        };
      };
    };
    delete(): {
      eq(
        column: string,
        value: unknown,
      ): PromiseLike<{ data: unknown[] | null; error: Error | null }>;
    };
    update(patch: Record<string, unknown>): {
      eq(
        column: string,
        value: unknown,
      ): PromiseLike<{ error: Error | null }>;
    };
  };
}

interface Row {
  id: string;
  label: string;
  content: string;
  peer_id: string | null;
  trust_level: string | null;
  created_at: number;
  superseded_by: string | null;
  retention_class: string;
  is_verbatim: boolean | number;
  expires_at: number | null;
}

function rowToEntry(row: Row): StoreEntry {
  return {
    id: row.id,
    label: row.label,
    content: row.content,
    peerId: row.peer_id,
    trustLevel: row.trust_level as TrustLevel | null,
    createdAt: row.created_at,
    supersededBy: row.superseded_by,
    retentionClass: row.retention_class as RetentionClass,
    isVerbatim: !!row.is_verbatim,
    expiresAt: row.expires_at,
  };
}

export function createSupabaseStore(
  config: Omit<SupabaseStoreConfig, "client"> & { client: LayeredSupabaseClient },
): MemoryStore {
  const retentionMs = config.retentionDays * 24 * 60 * 60 * 1000;

  async function initialize(): Promise<void> {
    // Supabase schema is created via migrations, not at runtime.
  }

  async function write(
    input: Omit<StoreEntry, "id"> & { id?: string },
  ): Promise<StoreEntry> {
    const id = input.id ?? randomUUID();
    const expiresAt = input.expiresAt ?? input.createdAt + retentionMs;

    const row: Row = {
      id,
      label: input.label,
      content: input.content,
      peer_id: input.peerId,
      trust_level: input.trustLevel,
      created_at: input.createdAt,
      superseded_by: input.supersededBy,
      retention_class: input.retentionClass,
      is_verbatim: input.isVerbatim,
      expires_at: expiresAt,
    };

    const { error } = await config.client.from(config.table).insert(row);
    if (error) throw error;

    return { ...input, id, expiresAt };
  }

  async function search(
    query: string,
    peerId?: string,
    limit = 10,
  ): Promise<StoreEntry[]> {
    const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
    const pattern = `%${escaped}%`;

    // Peer scoping is filtered client-side here. A production deployment
    // would express this via a Postgres view or RLS policy.
    const { data, error } = await config.client
      .from(config.table)
      .select(
        "id, label, content, peer_id, trust_level, created_at, superseded_by, retention_class, is_verbatim, expires_at",
      )
      .ilike("content", pattern)
      .order("created_at", { ascending: false })
      .limit(limit * 4);

    if (error) throw error;
    const rows = (data ?? []) as Row[];
    const now = Date.now();

    return rows
      .filter((r) => r.superseded_by === null)
      .filter((r) => r.expires_at === null || r.expires_at >= now)
      .filter((r) => !peerId || r.peer_id === peerId)
      .slice(0, limit)
      .map(rowToEntry);
  }

  async function read(label: string): Promise<StoreEntry | null> {
    const { data, error } = await config.client
      .from(config.table)
      .select(
        "id, label, content, peer_id, trust_level, created_at, superseded_by, retention_class, is_verbatim, expires_at",
      )
      .eq("label", label)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;
    return rowToEntry(data as Row);
  }

  async function list(_peerId?: string): Promise<string[]> {
    // Phase 1 doesn't expose memory_list to namespace providers.
    return [];
  }

  async function forget(peerId: string): Promise<number> {
    const { data, error } = await config.client
      .from(config.table)
      .delete()
      .eq("peer_id", peerId);
    if (error) throw error;
    return Array.isArray(data) ? data.length : 0;
  }

  async function supersede(
    entryId: string,
    newEntryId: string,
  ): Promise<void> {
    const { error } = await config.client
      .from(config.table)
      .update({ superseded_by: newEntryId })
      .eq("id", entryId);
    if (error) throw error;
  }

  async function cleanup(): Promise<number> {
    // No-op for Supabase; assume a Postgres cron or trigger handles expiry.
    return 0;
  }

  async function close(): Promise<void> {
    // No-op for Supabase.
  }

  return {
    initialize,
    write,
    search,
    read,
    list,
    forget,
    supersede,
    cleanup,
    close,
  };
}
