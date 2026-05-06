import { randomUUID } from "node:crypto";
import type { MemoryStore, OriginValue, RetentionClass, StoreEntry, SupabaseStoreConfig } from "./types";
import type { TrustLevel } from "../../../types";

/**
 * Wider Supabase client interface for layeredMemory.
 *
 * Adds:
 *   - delete()/update() for forget and supersede
 *   - eq()/is()/gt() chain methods on the search builder so peer_id,
 *     superseded_by, and expires_at predicates run in SQL (not app
 *     code) — critical for tenant isolation under load.
 *
 * Structurally compatible with @supabase/supabase-js and with the
 * extended mock in tests/fixtures/mock-supabase.ts.
 */
export interface SearchBuilder {
  eq(column: string, value: unknown): SearchBuilder;
  is(column: string, value: null): SearchBuilder;
  gt(column: string, value: number): SearchBuilder;
  ilike(column: string, value: string): SearchBuilder;
  or(filterExpr: string): SearchBuilder;
  order(column: string, opts?: { ascending?: boolean }): SearchBuilder;
  limit(n: number): PromiseLike<{ data: unknown[]; error: Error | null }>;
  maybeSingle(): PromiseLike<{ data: unknown; error: Error | null }>;
}

export interface LayeredSupabaseClient {
  from(table: string): {
    insert(row: unknown): PromiseLike<{ error: Error | null }>;
    select(columns?: string): SearchBuilder;
    delete(): {
      eq(
        column: string,
        value: unknown,
      ): PromiseLike<{ data: unknown[] | null; error: Error | null }>;
    };
    update(patch: Record<string, unknown>): {
      eq(column: string, value: unknown): PromiseLike<{ error: Error | null }>;
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
  // Phase 2 fact-fields (nullable)
  subject: string | null;
  predicate: string | null;
  object: string | null;
  source_turn_id: string | null;
  origin: string | null;
}

function rowToEntry(row: Row): StoreEntry {
  const entry: StoreEntry = {
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
  // Phase 2 fact-fields: only populate if non-null to keep entries clean
  if (row.subject != null) entry.subject = row.subject;
  if (row.predicate != null) entry.predicate = row.predicate;
  if (row.object != null) entry.object = row.object;
  if (row.source_turn_id != null) entry.sourceTurnId = row.source_turn_id;
  if (row.origin != null) entry.origin = row.origin as OriginValue;
  return entry;
}

export function createSupabaseStore(
  config: Omit<SupabaseStoreConfig, "client"> & { client: LayeredSupabaseClient },
): MemoryStore {
  const retentionMs = config.retentionDays * 24 * 60 * 60 * 1000;

  async function initialize(): Promise<void> {
    // Supabase schema is created via migrations, not at runtime.
  }

  async function write(input: Omit<StoreEntry, "id"> & { id?: string }): Promise<StoreEntry> {
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
      // Phase 2 fact-fields
      subject: input.subject ?? null,
      predicate: input.predicate ?? null,
      object: input.object ?? null,
      source_turn_id: input.sourceTurnId ?? null,
      origin: input.origin ?? null,
    };

    const { error } = await config.client.from(config.table).insert(row);
    if (error) throw error;

    return { ...input, id, expiresAt };
  }

  async function search(query: string, peerId?: string, limit = 10): Promise<StoreEntry[]> {
    const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
    const pattern = `%${escaped}%`;
    const now = Date.now();

    // All tenant-isolation and freshness predicates run in SQL BEFORE
    // LIMIT. Without this, a busy tenant could crowd out another peer's
    // hits before app-side filtering, returning empty/partial results
    // even when matching rows exist. Production deployments should ALSO
    // back this with RLS so the database refuses cross-tenant reads
    // independent of application code.
    let builder: SearchBuilder = config.client
      .from(config.table)
      .select(
        "id, label, content, peer_id, trust_level, created_at, superseded_by, retention_class, is_verbatim, expires_at, subject, predicate, object, source_turn_id, origin",
      );

    if (peerId) {
      builder = builder.eq("peer_id", peerId);
    }
    builder = builder.is("superseded_by", null);
    // Postgres "or" handles "expires_at IS NULL OR expires_at >= now" —
    // we send it as a single predicate so PostgREST builds the right
    // SQL. The mock parses this as a logical OR over its filters.
    builder = builder.or(`expires_at.is.null,expires_at.gte.${now}`);

    const { data, error } = await builder
      .ilike("content", pattern)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    const rows = (data ?? []) as Row[];
    return rows.map(rowToEntry);
  }

  async function read(label: string): Promise<StoreEntry | null> {
    const { data, error } = await config.client
      .from(config.table)
      .select(
        "id, label, content, peer_id, trust_level, created_at, superseded_by, retention_class, is_verbatim, expires_at, subject, predicate, object, source_turn_id, origin",
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
    const { data, error } = await config.client.from(config.table).delete().eq("peer_id", peerId);
    if (error) throw error;
    return Array.isArray(data) ? data.length : 0;
  }

  async function supersede(entryId: string, newEntryId: string): Promise<void> {
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
