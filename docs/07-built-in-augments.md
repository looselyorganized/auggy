# 07 — Built-in Augments

> The augments shipped with Auggy in `src/augments/` and `src/transports/`. These are the load-bearing pieces a real Auggy agent uses out of the box.

## Why these specifically

Three augments ship with v1:
- **`fileMemory`** — file-backed static memory provider
- **`supabaseMemory`** — Supabase-backed namespace memory provider
- **`webTransport`** — AG-UI HTTP transport (covered in [06-transports.md](./06-transports.md), not repeated here)

The selection is deliberate. These three together produce **a deployable agent**: identity, episodic memory, and a chat interface. Anything beyond this (model routing, escalation, evals, retrieval over special data sources) belongs in application-specific augments that live in the application's repo, not in Auggy itself.

The principle: Auggy ships the *contracts* (`MemoryProviderSpec`, `TransportSpec`) and a small set of *reference implementations* that prove the contracts work. Domain-specific augments are the user's responsibility.

## `fileMemory` — File-backed static memory provider

```ts
import { fileMemory } from "augment-1";

const identity = fileMemory({
  label: "self",
  source: "/path/to/zip-soul.md",
  mutable: false,
  origin: "operator",
  priority: "required",
  placement: "system",
  eviction: "never",
});
```

### What it is

A static `MemoryProviderSpec` backed by a single file. Loads the file's contents into memory at boot, serves `read()` requests from the cache, and (if `mutable: true`) persists `write()` calls both to the cache and to disk.

### When to use it

Two main use cases:

**1. Identity / soul.** The agent's foundational character — who it is, how it talks, what it knows about itself. Pinned (`mutable: false`), operator-origin, system-placement, never-evict. The model sees it on every turn as part of the system prompt. This is what makes Zip "Zip" instead of a generic assistant.

**2. Self-notes.** A scratchpad the agent can update across turns. Mutable, system-origin, preamble-placement, drop-on-eviction. The model can read and write to it via the generic `memory_write` and `memory_read` tools. Useful for things like "remember the visitor's name" or "track open commitments."

### Why it's built in

File-backed memory is the lowest-common-denominator memory provider. It works on any system that has a filesystem. It needs no external dependencies. It's the Pre-v0 phase of LORF's roadmap (flat-file context) literally implemented as an augment.

If file-backed memory wasn't built in, every Auggy user would write the same ~70 lines on day one. Instead it ships in a tested form.

### Configuration

```ts
export interface FileMemoryOptions {
  label: string;                    // the static label this provider owns
  source: string;                   // absolute file path
  mutable: boolean;                 // whether write() is exposed
  origin: ContextOrigin;            // "operator" | "system" | "peer-derived"
  priority: ContextPriority;        // "required" | "high" | "normal" | "low" | "evictable"
  placement: ContextPlacement;      // "system" | "preamble" | "assistant-preamble"
  eviction: EvictionPolicy;         // "never" | "summarize" | "drop"
  ttl?: "turn" | "session" | "persistent";  // default "persistent"
}
```

The `MemoryDefaults` for the synthesized context block come from these options directly. Setting `placement: "system"` is what makes the file's content show up in the model's system prompt rather than in the user-side context wrapper.

### Implementation notes

```ts
export function fileMemory(opts: FileMemoryOptions): Augment {
  let cache: string | null = null;

  const read = async (label: string): Promise<MemoryEntry | null> => {
    if (label !== opts.label) return null;
    if (cache === null) return null;
    return { label: opts.label, content: cache };
  };

  const write = opts.mutable
    ? async (label: string, content: string): Promise<void> => {
        if (label !== opts.label) {
          throw new Error(`fileMemory: label "${label}" does not match declared label "${opts.label}"`);
        }
        cache = content;
        await writeFile(opts.source, content, "utf-8");
      }
    : undefined;

  return {
    name: `file-memory-${opts.label}`,
    capabilities: ["context", "tools"],
    memory: {
      owns: { kind: "static", labels: [opts.label] },
      defaults: { ...opts, ttl: opts.ttl ?? "persistent" },
      read,
      write,
    },
    onBoot: async () => {
      cache = await readFile(opts.source, "utf-8");
    },
  };
}
```

A few things to note:

- **The augment name is generated** from the label: `file-memory-${label}`. This means you can mount multiple `fileMemory` augments for different labels without name collisions, but you'll get a registry conflict if you try to mount two with the same label (which is correct — the registry catches the issue at boot).

- **`onBoot` is async file IO.** If the file doesn't exist, `readFile` throws and the lifecycle manager wraps the error as `Augment "file-memory-self" failed to boot: ...`. Agent startup fails. This is intentional: if the soul file is missing, the agent shouldn't start serving requests.

- **`write()` validates the label.** Even though `lookupProvider` should never route a non-matching label here, the check prevents bugs where a caller passes the wrong label directly. Defense in depth.

- **`write()` writes to cache then disk.** If the disk write fails, the cache is already updated — there's a brief window where in-memory and disk diverge. v1 doesn't try to atomically swap them; if you need that, write a different provider. The trade-off: simpler code, the failure mode (write failure) is rare and the consequences (in-memory ahead of disk) are non-fatal until restart.

- **The provider is *static* with one label.** A future enhancement could be a "directory of files" provider that loads multiple labels from a directory. v1 is intentionally minimal — the contract supports it via `labels: string[]`.

### Lifecycle

| Hook | What it does |
|------|--------------|
| `onBoot` | Reads the file into the cache. Throws if missing. |
| `onShutdown` | None — the cache is in-memory and dies with the process. |
| `onTurnStart` | None. |
| `onTurnEnd` | None. |
| `onIdle` | None. |

### How the synthesized context block looks

When `wireMemoryBus` calls `synthesizeContextFor(fileMemoryAug)`, the resulting `context()` function does:

```ts
async (turnState) => {
  const entry = await aug.memory.read(opts.label);
  if (!entry) return [];
  return [{
    source: aug.name,                  // "file-memory-self"
    content: entry.content,            // the file's contents
    placement: opts.placement,         // "system" (for identity)
    priority: opts.priority,           // "required"
    eviction: opts.eviction,           // "never"
    origin: opts.origin,               // "operator"
    provenance: "memory",
    ttl: opts.ttl ?? "persistent",
  }];
};
```

In the prompt, this becomes a `[AUGMENT CONTEXT: file-memory-self]`-prefixed block in the system position.

## `supabaseMemory` — Supabase-backed namespace memory provider

```ts
import { createClient } from "@supabase/supabase-js";
import { supabaseMemory } from "augment-1";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const episodic = supabaseMemory({
  namespace: "episode",
  client: supabase,
  table: "agent_memories",
  mutable: true,
  origin: "peer-derived",
  priority: "normal",
  placement: "preamble",
  eviction: "drop",
});
```

### What it is

A namespace `MemoryProviderSpec` backed by a Supabase table. Implements `search` (ILIKE on content), `read` (eq on label), and `write` (insert). Used for episodic memory — open-ended labeled entries that accumulate over time.

### When to use it

The use case it was designed for is **episodic memory**: a record of "interactions, events, things that happened" that the agent can recall later. Each entry is a labeled blob of content with optional metadata, ordered by `created_at`.

Other use cases that fit:
- Visitor profiles (one row per visitor, label = `visitor:${id}`)
- Conversation summaries (one row per conversation, label = `summary:${threadId}`)
- Decision logs (one row per decision, label = `decision:${date}`)

What it's *not* for:
- Real-time chat history — that's what `HistoryManager` does, in-memory.
- Vector / semantic retrieval — `search` is ILIKE only. A pgvector-backed sibling provider is on the future-work list.
- Anything that requires complex queries — `supabaseMemory` is the simplest possible Supabase wrapper.

### Why it's built in

Because LORF is committed to Supabase as the warm-tier database (see the LORF roadmap), and an episodic memory provider that targets it is going to be the second memory provider every Auggy user mounts. Same reasoning as `fileMemory`: ship it tested, save every user from rewriting it.

A second-order benefit: having two reference providers (`fileMemory` static, `supabaseMemory` namespace) **proves the `MemoryProviderSpec` contract handles both kinds of memory.** If the contract were broken in some way, the second implementation would have surfaced it. Both work — the contract is right.

### Configuration

```ts
export interface SupabaseMemoryOptions {
  namespace: string;                  // e.g. "episode" → prefix becomes "episode:"
  client: SupabaseLikeClient;
  table: string;                      // the table to read/write
  mutable: boolean;                   // whether write() is exposed
  origin: ContextOrigin;
  priority: ContextPriority;
  placement: ContextPlacement;
  eviction: EvictionPolicy;
  searchLimit?: number;               // default 10
}
```

The `namespace` becomes the prefix — `"episode"` is normalized to `"episode:"`. All labels in this provider must start with that prefix or the post-filter (see below) drops them.

### `SupabaseLikeClient` — the structural type

```ts
export interface SupabaseLikeClient {
  from(table: string): {
    insert(row: unknown): PromiseLike<{ error: Error | null }>;
    select(columns?: string): {
      eq(column: string, value: unknown): {
        maybeSingle(): PromiseLike<{ data: unknown; error: Error | null }>;
      };
      ilike(column: string, value: string): {
        order(column: string, opts?: { ascending?: boolean }): {
          limit(n: number): PromiseLike<{ data: unknown[]; error: Error | null }>;
        };
      };
    };
  };
}
```

This is the **structural type** the augment expects. It matches the real `@supabase/supabase-js` client's `PostgrestQueryBuilder` API, but written narrowly enough that the test mock (`tests/fixtures/mock-supabase.ts`) can satisfy it without pulling in the real library.

The terminal nodes of the chain return `PromiseLike` (not `Promise`) so that thenable builders — both the real Supabase one and the test mock — satisfy the type structurally. This was a fix from the type-cleanup pass after Plan 2's review.

### Required schema

The Supabase table must have at least these columns:

```sql
create table agent_memories (
  id          bigserial primary key,
  label       text not null,
  content     text not null,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

create index agent_memories_label_idx on agent_memories (label);
create index agent_memories_created_at_idx on agent_memories (created_at desc);
```

You can have additional columns; the augment only reads and writes those four. The table name is configurable (`opts.table`).

### Implementation notes

#### `search(query)`

```ts
const search = async (query: string): Promise<MemoryEntry[]> => {
  const { data, error } = await opts.client
    .from(opts.table)
    .select("label, content, metadata, created_at")
    .ilike("content", `%${query}%`)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  const rows = (data ?? []) as Array<{ label; content; metadata? }>;
  return rows
    .filter((r) => r.label.startsWith(prefix))     // namespace isolation
    .map((r) => ({ label: r.label, content: r.content, metadata: r.metadata }));
};
```

The namespace post-filter (`r.label.startsWith(prefix)`) is **defense-in-depth**: even if the table holds rows from multiple namespaces (e.g. several providers sharing one table), this provider only returns rows it actually owns.

This was the P1 review finding ("Restrict Supabase memory search to the declared namespace"). The original implementation only filtered on `content` and would have leaked rows from other namespaces if a shared table was misconfigured. The post-filter makes the declared namespace ownership a hard guarantee, not a configuration assumption.

There's no upper bound on how many results the post-filter throws away — if you have 100 rows matching the content query but only 5 of them are in this namespace, you get 5. The trade-off: the SQL query stays simple, the worst case is "fewer results than `limit`" (correct behavior), and you can compensate by raising `searchLimit` if you notice starvation.

#### `read(label)`

```ts
const read = async (label: string): Promise<MemoryEntry | null> => {
  if (!label.startsWith(prefix)) return null;       // wrong namespace
  const { data, error } = await opts.client
    .from(opts.table)
    .select("label, content, metadata")
    .eq("label", label)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { label; content; metadata? };
  return { label: row.label, content: row.content, metadata: row.metadata };
};
```

The early-return on prefix mismatch is the same defense as `search`. `lookupProvider` should never route a non-prefix-matching label here, but the explicit check prevents misuse.

#### `write(label, content)`

```ts
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
```

`write` is **insert-only**. Each call appends a new row, even if a row with that label already exists. This is intentional for episodic memory — you typically don't want to overwrite past episodes; you want a log of what happened. If a use case needs upsert, that's a different provider.

The label-prefix check on write is the same defense-in-depth: we never want a write to land outside this provider's declared namespace.

### Lifecycle

| Hook | What it does |
|------|--------------|
| `onBoot` | None — the Supabase client is constructed by the user before passing it to `supabaseMemory(...)`. |
| `onShutdown` | None. |
| `onTurnStart` | None. |
| `onTurnEnd` | None. |
| `onIdle` | None. |

The augment is stateless beyond what's in the database. The Supabase client manages its own connection pool.

### How the synthesized context block looks

When `wireMemoryBus` calls `synthesizeContextFor(supabaseMemoryAug)`, the resulting `context()` function does:

```ts
async (turnState) => {
  if (turnState.trigger.type !== "message") return [];   // only on message triggers
  const text = extractText((turnState.trigger.payload as InboundMessage).parts);
  if (!text) return [];
  const entries = await aug.memory.search(text);
  return entries.map((entry) => ({
    source: aug.name,                       // "supabase-memory-episode"
    content: entry.content,
    placement: opts.placement,              // "preamble"
    priority: opts.priority,                // "normal"
    eviction: opts.eviction,                // "drop"
    origin: opts.origin,                    // "peer-derived"
    provenance: "memory",
    ttl: "session",
  }));
};
```

The `ttl: "session"` is hardcoded by `synthesizeContextFor` for namespace providers (it's not in `MemoryDefaults`). The reasoning: episodic memory is fundamentally session-scoped — the entries that get retrieved depend on the current query, and there's no point caching them across turns since the next query may be entirely different.

The `origin: "peer-derived"` is critical for security. Episodic memory contains content the model produced or the peer sent, and it's been written into a database. Marking it as `peer-derived` ensures it gets the `[PEER-DERIVED]` marker in the prompt and the model knows to treat it with caution.

## How they compose

A typical agent setup uses both:

```ts
const agent = defineAgent({
  name: "zip",
  purpose: "LORF front-door agent",
  model: "claude-sonnet-4-6",
  augments: [
    fileMemory({
      label: "self",
      source: "./zip-soul.md",
      mutable: false,
      origin: "operator",
      priority: "required",
      placement: "system",
      eviction: "never",
    }),
    supabaseMemory({
      namespace: "episode",
      client: supabase,
      table: "agent_memories",
      mutable: true,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    }),
    webTransport({
      port: 8080,
      auth: { type: "bearer", token: process.env.AUTH_TOKEN! },
      rateLimitPerPeer: { maxPerMinute: 30 },
    }),
  ],
}, anthropicModelClient);

await agent.start();
```

What happens at boot:
1. `wireMemoryBus` builds the registry: `{ static: { "self" → fileMemory }, namespaces: [{ "episode:" → supabaseMemory }] }`. No conflicts.
2. Both memory providers get synthesized `context()` functions.
3. The synthetic `memory-bus` augment is appended with the four generic memory tools.
4. `generateAgentCard` produces a card with `capabilities.memory: true`, `capabilities.transport: true`, and four memory tool skills.
5. `lifecycle.boot()` runs: `fileMemory.onBoot()` reads `zip-soul.md`. `supabaseMemory` has no onBoot. `webTransport.onBoot()` starts Bun.serve on port 8080. `memory-bus` has no onBoot.
6. The web transport is registered with a `TransportQueue` (concurrency 1, queue depth 50, rate limit 30/min/peer).
7. The agent is now serving requests on `http://localhost:8080`.

What happens on a turn:
1. A peer POSTs to `/agent/run`. The web transport identifies them, builds a trigger.
2. The transport queue lets the request through (under rate limit, queue not full).
3. Turn loop runs:
   - `onTurnStart`: `memory-bus` resets the budget.
   - Context pipeline: `fileMemory`'s synthesized `context()` reads `zip-soul.md` from cache and returns one system block. `supabaseMemory`'s synthesized `context()` searches the DB for `episode:` rows matching the user's text and returns matching entries as preamble blocks.
   - Allocator assembles the prompt.
   - Model is called. If it calls `memory_search` or `memory_read` or `memory_write`, the generic tools dispatch through the registry to the right provider.
   - Final response streams back as AG-UI events.

This is what a deployable Auggy agent looks like. ~30 lines of user code; everything else is in the library.

## Why these aren't exhaustive

The three built-in augments are the **minimum viable set**. Real agents will mount more — escalation augments (Zip's `ping_human` tool), eval augments, telemetry augments, ad-hoc tool augments. None of those belong in the runtime; they're application-specific.

The line between "ship it built-in" and "user implements" is roughly:
- **Built in:** anything that's a load-bearing reference implementation of a contract Auggy defines (`MemoryProviderSpec`, `TransportSpec`).
- **User code:** anything that's domain-specific or where multiple competing implementations make sense.

A future plan (Plan 3 — CLI & Manifest System) introduces an **augment catalog** — a way to publish and consume augments without bundling them into the runtime. That's where the "second batch" of augments will live: catalog-based, not built-in.
