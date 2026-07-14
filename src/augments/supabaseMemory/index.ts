import type {
  AdminInfoBlock,
  Augment,
  MemoryEntry,
  ContextOrigin,
  ContextPriority,
  ContextPlacement,
  EvictionPolicy,
} from "../../types";

/**
 * Minimal Supabase client interface used by supabaseMemory. Compatible
 * with @supabase/supabase-js and with the test mock.
 *
 * Terminal nodes in the chain return `PromiseLike` (not `Promise`) so
 * thenable builders — like Supabase's PostgrestBuilder, and our mock —
 * satisfy the type structurally.
 */
export interface SupabaseLikeClient {
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
          limit(n: number): PromiseLike<{ data: unknown[]; error: Error | null }>;
        };
      };
    };
  };
}

export interface SupabaseMemoryOptions {
  namespace: string;
  client: SupabaseLikeClient;
  table: string;
  mutable: boolean;
  origin: ContextOrigin;
  priority: ContextPriority;
  placement: ContextPlacement;
  eviction: EvictionPolicy;
  searchLimit?: number;
}

/**
 * Namespace-based memory provider backed by a Supabase table.
 * Stores rows with { label, content, metadata?, created_at } and
 * supports recent-or-relevant retrieval via ILIKE + ordering by
 * created_at desc. Intended for episodic memory.
 */
export function supabaseMemory(opts: SupabaseMemoryOptions): Augment {
  const prefix = opts.namespace.endsWith(":") ? opts.namespace : `${opts.namespace}:`;
  const limit = opts.searchLimit ?? 10;

  const search = async (query: string): Promise<MemoryEntry[]> => {
    // Escape ILIKE wildcards (% and _) in user input so they're treated
    // as literal characters, not pattern matchers.
    const escaped = query.replace(/[%_]/g, (c) => `\\${c}`);
    const { data, error } = await opts.client
      .from(opts.table)
      .select("label, content, metadata, created_at")
      .ilike("content", `%${escaped}%`)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    const rows = (data ?? []) as Array<{
      label: string;
      content: string;
      metadata?: Record<string, unknown>;
    }>;
    // Defense-in-depth: even if the backing table holds rows from other
    // namespaces (e.g. several providers sharing one table), this provider
    // only returns rows it actually owns. Without this filter, the
    // declared ownership of `${prefix}*` would be silently violated.
    return rows
      .filter((r) => r.label.startsWith(prefix))
      .map((r) => ({
        label: r.label,
        content: r.content,
        metadata: r.metadata,
      }));
  };

  const read = async (label: string): Promise<MemoryEntry | null> => {
    if (!label.startsWith(prefix)) return null;
    const { data, error } = await opts.client
      .from(opts.table)
      .select("label, content, metadata")
      .eq("label", label)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;
    const row = data as {
      label: string;
      content: string;
      metadata?: Record<string, unknown>;
    };
    return {
      label: row.label,
      content: row.content,
      metadata: row.metadata,
    };
  };

  const write = opts.mutable
    ? async (label: string, content: string): Promise<void> => {
        if (!label.startsWith(prefix)) {
          throw new Error(
            `supabaseMemory: label "${label}" does not start with namespace prefix "${prefix}"`,
          );
        }
        const { error } = await opts.client.from(opts.table).insert({
          label,
          content,
          created_at: new Date().toISOString(),
        });
        if (error) throw error;
      }
    : undefined;

  const augmentName = `supabase-memory-${opts.namespace}`;
  const adminInfo = async (): Promise<AdminInfoBlock> => ({
    augmentName,
    title: `Supabase memory — ${opts.namespace}`,
    sections: [
      {
        kind: "keyValue",
        rows: [
          { label: "Namespace", value: opts.namespace },
          { label: "Prefix", value: prefix },
          { label: "Table", value: opts.table },
          { label: "Mutable", value: opts.mutable ? "true" : "false" },
          { label: "Search limit", value: String(limit) },
          { label: "Origin", value: opts.origin },
          { label: "Priority", value: opts.priority },
          { label: "Placement", value: opts.placement },
          { label: "Eviction", value: opts.eviction },
        ],
      },
    ],
  });

  return {
    name: augmentName,
    type: "supabaseMemory",
    category: "memory",
    memory: {
      owns: { kind: "namespace", prefix },
      defaults: {
        mutable: opts.mutable,
        origin: opts.origin,
        priority: opts.priority,
        placement: opts.placement,
        eviction: opts.eviction,
        ttl: "session",
      },
      search,
      read,
      write,
    },
    adminInfo,
  };
}
