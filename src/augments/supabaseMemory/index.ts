import type {
  AdminInfoBlock,
  Augment,
  MemoryEntry,
  ContextOrigin,
  ContextPriority,
  ContextPlacement,
  EvictionPolicy,
  MemoryQueryOpts,
  MemoryWriteOpts,
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
    select(columns?: string): SupabaseQueryBuilder;
  };
}

export interface SupabaseQueryBuilder
  extends PromiseLike<{ data: unknown[]; error: Error | null }> {
  eq(column: string, value: unknown): SupabaseQueryBuilder;
  ilike(column: string, value: string): SupabaseQueryBuilder;
  order(column: string, opts?: { ascending?: boolean }): SupabaseQueryBuilder;
  limit(n: number): SupabaseQueryBuilder;
  maybeSingle(): PromiseLike<{ data: unknown; error: Error | null }>;
}

export interface SupabaseMemoryOptions {
  namespace: string;
  /**
   * Explicit storage isolation model.
   *
   * - "peer": every query and write requires a peer identity and uses a
   *   dedicated peer column.
   * - "shared": entries are intentionally global and use the legacy schema.
   */
  scope: "peer" | "shared";
  client: SupabaseLikeClient;
  table: string;
  /** Column that stores the Auggy peer ID in peer scope. Default "peer_id". */
  peerColumn?: string;
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
  if (opts.scope !== "peer" && opts.scope !== "shared") {
    throw new Error('supabaseMemory: scope must be explicitly set to "peer" or "shared"');
  }
  if (opts.scope === "shared" && opts.origin === "peer-derived") {
    throw new Error('supabaseMemory: scope "shared" cannot be used with peer-derived memory');
  }
  // Options are caller-owned and may remain mutable after construction.
  // Snapshot every value that affects authorization so a later mutation
  // cannot switch an already-mounted peer store into shared mode.
  const scope = opts.scope;
  const prefix = opts.namespace.endsWith(":") ? opts.namespace : `${opts.namespace}:`;
  const limit = opts.searchLimit ?? 10;
  const peerColumn = opts.peerColumn ?? "peer_id";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(peerColumn)) {
    throw new Error("supabaseMemory: peerColumn must be a simple SQL identifier");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("supabaseMemory: searchLimit must be an integer between 1 and 100");
  }

  function requirePeerId(queryOpts: MemoryQueryOpts | undefined): string {
    const peerId = queryOpts?.peerId;
    if (typeof peerId !== "string" || peerId.length === 0) {
      throw new Error("supabaseMemory: peer-scoped access requires a resolved peer identity");
    }
    return peerId;
  }

  function escapeIlike(value: string): string {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`);
  }

  function rowToEntry(
    row: unknown,
    expectedPeerId?: string,
    expectedLabel?: string,
  ): MemoryEntry | null {
    if (typeof row !== "object" || row === null) return null;
    const candidate = row as Record<string, unknown>;
    if (typeof candidate.label !== "string" || typeof candidate.content !== "string") return null;
    if (!candidate.label.startsWith(prefix)) return null;
    if (expectedLabel !== undefined && candidate.label !== expectedLabel) return null;
    if (expectedPeerId !== undefined && candidate[peerColumn] !== expectedPeerId) return null;

    const entry: MemoryEntry = {
      label: candidate.label,
      content: candidate.content,
    };
    if (
      candidate.metadata !== undefined &&
      typeof candidate.metadata === "object" &&
      candidate.metadata !== null &&
      !Array.isArray(candidate.metadata)
    ) {
      entry.metadata = candidate.metadata as Record<string, unknown>;
    }
    if (expectedPeerId !== undefined) entry.peerId = expectedPeerId;
    if (typeof candidate.created_at === "string") {
      const createdAt = Date.parse(candidate.created_at);
      if (Number.isFinite(createdAt)) entry.createdAt = createdAt;
    }
    return entry;
  }

  const search = async (query: string, queryOpts?: MemoryQueryOpts): Promise<MemoryEntry[]> => {
    // Escape ILIKE wildcards (% and _) in user input so they're treated
    // as literal characters, not pattern matchers.
    const escaped = escapeIlike(query);
    const expectedPeerId = scope === "peer" ? requirePeerId(queryOpts) : undefined;
    const selectedColumns = [
      "label",
      "content",
      "metadata",
      "created_at",
      ...(expectedPeerId !== undefined ? [peerColumn] : []),
    ].join(", ");
    let builder = opts.client
      .from(opts.table)
      .select(selectedColumns)
      .ilike("label", `${escapeIlike(prefix)}%`);
    if (expectedPeerId !== undefined) {
      builder = builder.eq(peerColumn, expectedPeerId);
    }
    const { data, error } = await builder
      .ilike("content", `%${escaped}%`)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data ?? [])
      .map((row) => rowToEntry(row, expectedPeerId))
      .filter((entry): entry is MemoryEntry => entry !== null);
  };

  // Peer-scoped namespace memory deliberately does not expose exact-label
  // reads. The generic memory_read tool has no independently authenticated
  // ownership proof for an arbitrary label; callers must use peer-filtered
  // search instead. Explicit shared stores retain the legacy global read.
  const read =
    scope === "shared"
      ? async (label: string): Promise<MemoryEntry | null> => {
          if (!label.startsWith(prefix)) return null;
          const { data, error } = await opts.client
            .from(opts.table)
            .select("label, content, metadata, created_at")
            .eq("label", label)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (error) throw error;
          if (!data) return null;
          return rowToEntry(data, undefined, label);
        }
      : undefined;

  const write = opts.mutable
    ? async (label: string, content: string, writeOpts?: MemoryWriteOpts): Promise<void> => {
        if (!label.startsWith(prefix)) {
          throw new Error(
            `supabaseMemory: label "${label}" does not start with namespace prefix "${prefix}"`,
          );
        }
        const peerId = scope === "peer" ? requirePeerId(writeOpts) : writeOpts?.peerId;
        if (
          scope === "peer" &&
          label !== `${prefix}${peerId}` &&
          !label.startsWith(`${prefix}${peerId}:`)
        ) {
          throw new Error(
            `supabaseMemory: label "${label}" is not structurally bound to peer "${peerId}"`,
          );
        }
        const row: Record<string, unknown> = {
          label,
          content,
          created_at: new Date().toISOString(),
        };
        if (scope === "peer") {
          row[peerColumn] = peerId;
        }
        const { error } = await opts.client.from(opts.table).insert(row);
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
          { label: "Scope", value: scope },
          { label: "Peer column", value: scope === "peer" ? peerColumn : "not used" },
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
