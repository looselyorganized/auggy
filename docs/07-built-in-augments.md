# 07 — Built-in Augments

> The augments shipped with Auggy in `src/augments/` and `src/transports/`. These are the load-bearing pieces a real Auggy agent uses out of the box.

## Why these specifically

Nine augments ship with v0.2.0:
- **`fileMemory`** — file-backed static memory provider
- **`supabaseMemory`** — Supabase-backed namespace memory provider
- **`layeredMemory`** — peer-scoped episodic memory with L0–L3 provenance tiers (SQLite-backed)
- **`webTransport`** — AG-UI HTTP transport (covered in [06-transports.md](./06-transports.md), not repeated here)
- **`telegramTransport`** — bidirectional Telegram bot transport
- **`filesystem`** — multi-mount scoped file access
- **`webFetch`** — URL fetch with HTML→text rendering
- **`orgContext`** — read-only org knowledge manifest
- **`bash`** — scoped shell execution
- **`budgets`** — per-trust-level turn budgets + dollar ceiling
- **`notify`** — outbound messaging to operator-configured destinations

The selection is deliberate. Together they cover: identity, episodic memory, web chat, Telegram chat, filesystem access, external knowledge, shell execution, cost management, and operator alerting. Anything beyond this (model routing, evals, retrieval over special data sources) belongs in application-specific augments that live in the application's repo, not in Auggy itself.

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
    priority: opts.priority,               // "normal"
    eviction: opts.eviction,               // "drop"
    origin: opts.origin,                   // "peer-derived"
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

## `filesystem` — Multi-mount scoped file access

```ts
import { filesystem } from "augment-1";

const fs = filesystem({
  mounts: [
    { name: "skills",    path: "./skills",    writable: false },
    { name: "workspace", path: "./workspace",  writable: true, deletable: true },
    { name: "repo",      path: "/repos/platform", writable: false },
  ],
});
```

### What it is

A multi-mount filesystem augment following the Docker volumes model. The operator declares named mounts with per-mount permissions. The model uses logical paths (`mount-name/path/to/file`); the augment resolves physical paths and enforces security boundaries.

### When to use it

Two primary use cases:

**1. Skill folder access.** The agent needs to read SKILL.md files and their supporting references on demand. This is the **progressive disclosure** pattern described in [11-skills.md](./11-skills.md) — the model reads skills via `fs_read` when it decides the conversation needs guidance. The filesystem augment IS the skill loader.

**2. Agent workspace.** The agent needs to create, read, and manage files as part of its work — drafts, notes, reports, intermediate outputs.

Additional use cases: reading external code repositories (read-only mount), writing to shared output directories, accessing configuration files.

### Why it's built in

The skill folder pattern requires the model to read files on demand. Without a filesystem augment, skill files are either boot-loaded into context (wastes tokens) or inaccessible. Every agent that uses skills needs filesystem access — shipping it built-in ensures consistent security boundaries, tool naming, and mount scoping.

### Tools (6)

| Tool | What | Permission gate |
|---|---|---|
| `fs_read(path)` | Read file contents (truncated at `maxReadSize`, binary detection) | Any mount |
| `fs_write(path, content)` | Write/create file (auto-creates parent dirs, capped at `maxWriteSize`) | Writable mounts |
| `fs_list(path)` | List directory with sizes, types, modified dates | Any mount |
| `fs_mkdir(path)` | Create directory (recursive) | Writable mounts |
| `fs_remove(path)` | Delete file or empty directory | Deletable mounts |
| `fs_search(path, pattern)` | Glob search (excludes .git/node_modules by default, caps at 100 results) | Any mount |

### Configuration

```ts
interface FsMount {
  name: string;           // logical name — first path segment the model uses
  path: string;           // physical path on disk
  writable?: boolean;     // allow fs_write, fs_mkdir. Default false.
  deletable?: boolean;    // allow fs_remove. Default false. Requires writable.
  maxReadSize?: number;   // truncation cap on fs_read. Default 256KB.
  maxWriteSize?: number;  // cap on fs_write content. Default 1MB.
  searchExcludes?: string[]; // glob excludes. Default [".git", "node_modules", ".next", "__pycache__"]
}
```

Three permission tiers: **read-only** (default) → **writable** → **writable + deletable**.

### Security model

- **`fs.realpath()`** resolves symlinks before every boundary check — prevents symlink-escape attacks
- **`path.relative()`-based boundary check** — prevents `../` traversal, prefix-collision escapes (mount `/var/data/work` doesn't accept `/var/data/workspace/...`), and cross-drive escapes on Windows, while still working correctly when the mount itself is a filesystem root (e.g. `/` on POSIX)
- **Binary detection** via file extension — returns an error message instead of garbage content for images, PDFs, compiled binaries
- **Size truncation** — files over `maxReadSize` are truncated with a `[truncated at 256KB, total size: 20MB]` marker
- **Per-mount permissions** — enforced on every operation before any file I/O
- **Mount isolation** — each mount is an independent security boundary; no cross-mount path references
- **Per-trust-level structural defaults** — the augment ships with `perTrustLevel: { public: { neverExpose: ["fs_write", "fs_mkdir", "fs_remove"] }, agent: { neverExpose: ["fs_remove"] } }`. Public peers structurally cannot see the three mutation tools; agent peers cannot see `fs_remove`. This runs at the capability table *before* the model sees the tool list (Layer 1 enforcement). Mount-level `writable` / `deletable` flags remain as a complementary defense — they run inside the tool after it has already been called, so they catch operator-authorized tools being called against the wrong mount.

### Lifecycle

| Hook | What it does |
|------|-------------|
| `onBoot` | Resolves and caches all mount root paths. Optionally loads a SKILL.md if `skillFile` is configured. |
| `onShutdown` | None. |

### Important constraint

**Filesystem mount paths must not overlap with `fileMemory` source paths.** If the same file is owned by `fileMemory` (cached at boot) and accessible via a writable filesystem mount, writes through the filesystem augment won't invalidate `fileMemory`'s cache, causing stale context. This is an operator responsibility in v1.

### Ships with a skill folder

The filesystem augment is the first augment to ship with its own SKILL.md + references:

```
src/augments/filesystem-skill/
├── SKILL.md                        # teaches when/how to use the 6 fs tools
└── references/
    └── mount-permissions.md        # full permission matrix + security details
```

This skill is loaded by the model on demand via `fs_read`, following the progressive disclosure pattern.

## `notify` — Outbound messaging to operator-configured destinations

```ts
import { notify } from "augment-1";

const notifyAugment = notify({
  destinations: [
    { name: "creator", transport: "webhook", url: process.env.ORG_NOTIFY_URL! },
  ],
});
```

### What it is

The `notify` augment gives the agent a `notify` tool for pushing messages to operator-defined destinations outside the current conversation. Unlike transport replies — where the agent responds to the peer who triggered the current turn — `notify` pushes to destinations that are **not** the active peer. Use it to alert an operator, escalate a situation, share a status ping, or hand off to a human mid-conversation.

Destinations are declared in config, not in the agent prompt. The agent always refers to a destination by its operator-assigned name (`"creator"`, `"ops"`, `"alerts"`, etc.). This keeps Telegram chat IDs and webhook URLs out of the model's context entirely.

### Tool surface

```
notify({
  to: string,         // required — destination name from config (e.g. "creator")
  summary: string,    // required — brief description of what needs attention
  reason?: string,    // optional — why this notification is being sent
  visitor?: string,   // optional — visitor name or identifier if relevant
})
```

Returns `{ status: "sent" }`, `{ status: "rate_limited", message: "..." }`, or `{ status: "failed", message/detail: "..." }`.

### Adapters

Two adapters ship under `src/augments/notify/adapters/`, each ~50 LOC:

- **`webhook`** — HTTP POST of `{ summary, reason?, visitor?, channel: "notify" }` to a configured URL. Uses the shared `src/http.ts` client for redirect security. Any 2xx is success; other statuses are `failed` with the status code and up to 200 chars of the response body.
- **`telegram`** — `sendMessage` via the shared `src/telegram-client.ts`. Formats the payload as Markdown. Multiple telegram destinations sharing the same bot token share one client instance.

### Rate limiting

Rate limiting is stateful and in-memory (resets on restart). Checks in order:

1. **Per-peer cooldown** — suppresses a second notification from the same peer within `perPeerCooldownMs`.
2. **Global hourly cap** — rolling 60-minute window; defaults to 5 notifications per hour.
3. **Dedup** — word-overlap comparison against summaries sent in the last `dedupWindowMs`; suppresses near-duplicates above `dedupThreshold`.

Creator-class senders (and null peers / scheduled triggers) bypass all rate limits entirely.

### Outbound messaging history

`notify` is the successor to the `org_escalate` tool that was removed from `orgContext` in roadmap item 6 (commit `59d82c7`). The capability is equivalent; the structural change is that the destination URL is now in `agent.yaml` config rather than embedded in the tool definition.

For the full operator reference, see [docs/13-notify.md](./13-notify.md).

## `orgContext` — Read-only org knowledge manifest

```ts
import { orgContext } from "augment-1";

const org = orgContext({
  baseUrl: process.env.ORG_CONTEXT_URL!,
  token: process.env.ORG_CONTEXT_TOKEN,
});
```

### What it is

A read-only augment that connects an agent to an organization's knowledge API. It provides two stages of progressive disclosure:

1. **Manifest** — always in context (~200 tokens): org identity, purpose, operator, phase, and a list of available endpoints with descriptions. The agent uses this to know what the organization is and which content endpoints are available.
2. **Endpoint content** — on demand via `org_fetch`: the agent fetches the full content of a specific endpoint when the conversation calls for it (docs, ADRs, initiative details, etc.).

### Tool surface

`orgContext` exposes exactly **one tool**: `org_fetch`.

```
org_fetch({ path: string })
```

Fetches the content at `<baseUrl><path>`. The agent calls this when the visitor's question warrants pulling in specific org knowledge — for example, `org_fetch({ path: "/vision" })` to retrieve the full vision document.

The manifest lists all available paths. The agent reads the descriptions and decides which (if any) to fetch — this is the progressive disclosure model: the skeleton is always present, the detail is fetched on demand.

> **Note:** Outbound messaging was removed from `orgContext` in roadmap item 6 (commit `59d82c7` on main). `orgContext` is now a read-only manifest registry — no write operations, no escalation. Mount the `notify` augment alongside `orgContext` for outbound messaging capability.

### Configuration

```ts
export interface OrgContextOptions {
  baseUrl: string;        // Base URL of the org API (e.g. "http://localhost:3000")
  token?: string;         // Optional auth token for the org API
  cacheTtlMs?: number;    // Manifest cache TTL in ms. Default 1 hour.
  client?: HttpClient;    // Optional pre-built HTTP client (for testing)
}
```

### Boot behavior

Boot is graceful: if the org API is unreachable at startup, the agent starts without org context and logs a warning. `org_fetch` will return clear error messages until the API becomes reachable. This prevents a temporarily unavailable knowledge API from taking down a running agent.

## `telegramTransport` — Bidirectional Telegram bot transport

```yaml
augments:
  - name: telegram
    type: telegramTransport
    options:
      botToken: ${TELEGRAM_BOT_TOKEN}
      inbound:
        mode: polling
        polling:
          timeoutSec: 30
      auth:
        creatorUserIds:
          - 123456789
        anonymousIdentityMode: ephemeral
```

### What it is

The `telegramTransport` augment wires a Telegram bot as a bidirectional peer transport, equivalent in capability to `webTransport`. Inbound messages from Telegram users become turn triggers; the agent's replies are sent back via `sendMessage`. It is a full `TransportSpec` implementation — the kernel manages concurrency, queueing, and rate limiting the same way it does for `webTransport`.

### Modes

Two inbound modes:

- **Polling** (default): the augment calls `getUpdates` in a long-poll loop. No public URL required. Best for self-hosted / home-lab / development setups.
- **Webhook**: Telegram POSTs updates to a public HTTPS URL. The augment runs a local `Bun.serve()` server on a configured port. The webhook server validates the `X-Telegram-Bot-Api-Secret-Token` header with a timing-safe comparison, returns `401` on mismatch and `405` on non-POST. Best for cloud deployments.

Polling and webhook are mutually exclusive per bot — choose one per augment instance.

### Identity — four-path resolution

Every inbound Telegram update resolves to a `PeerIdentity` via four paths in priority order:

| Priority | Check | Trust level | `peer.id` |
|---|---|---|---|
| 1 | `creatorUserIds` contains sender ID | `"creator"` | `tg_user_<userId>` |
| 2 | `admittedAgents` has matching `telegramUserId` | `"agent"` | Agent's logical `id` field |
| 3 | `recognizedUserIds` contains sender ID | `"public"` / `"recognized"` | `tg_user_<userId>` |
| 4 | None of the above | `"public"` / `"anonymous"` | `tg_anon_<threadId>` (ephemeral) or `tg_user_<userId>` (durable) |

**`anonymousIdentityMode`:** The default `"ephemeral"` ties the anonymous peer.id to the Telegram chat thread — memory is retained within a session but not globally. `"durable"` uses the Telegram user ID, enabling cross-session memory recall. Durable mode should be chosen carefully given privacy implications.

### `admittedAgents` boot-time validation

At boot, the augment calls `getChat` for each `admittedAgents` entry to verify the configured `telegramUserId` is reachable. Validation failures log a warning and produce silent trust demotion (the agent peer is treated as `public-anonymous`) rather than aborting boot. Operators should treat validation warnings as misconfigurations to fix promptly — the consequence is the admitted agent losing tool access it expects to have.

For the full operator reference (both modes, full config schema, webhook deployment notes, troubleshooting), see [docs/14-telegram-transport.md](./14-telegram-transport.md).

## `webFetch` — URL fetch with HTML→text rendering

```ts
import { webFetch } from "augment-1";

const fetcher = webFetch({
  timeoutMs: 15000,
});
```

A single-tool augment exposing `web_fetch(url, prompt)`. Fetches the URL, strips HTML (or passes JSON through), produces a prompt-aware summary. Built around `createHttpClient` from `src/http.ts`.

### Security model — structural SSRF defense

The augment instantiates its http client with `rejectUnsafeUrls: true`. Both the initial URL and every redirect hop are filtered at the http layer, *before* any network I/O, against:

- Loopback (`localhost`, `127.0.0.0/8`, `::1`)
- RFC 1918 private ranges (`10/8`, `172.16/12`, `192.168/16`)
- Link-local (`169.254.0.0/16` — covers AWS EC2 metadata `169.254.169.254` and similar)
- IPv6 link-local (`fe80::/10`) and unique-local (`fc00::/7`)
- `0.0.0.0/8`
- Cloud metadata FQDNs (`metadata`, `metadata.google.internal`)
- Non-http(s) schemes (`file://`, `ftp://`, `gopher://`, …)

Rejected URLs throw from the http client and are caught by the `web_fetch` tool, surfaced as a structured error JSON with the reason (`"blocked: loopback"`, `"blocked: RFC 1918 (10/8)"`, etc.). This is **structural** defense — the filter runs regardless of what the model or the peer says, and it covers the redirect path, not just the first hop.

**Not covered by this layer:**
- DNS rebinding — a public-looking hostname that resolves to a private IP at fetch time. The filter runs against hostnames/IP literals, not the resolved address.
- Allow/deny lists — operators who need a private endpoint reachable (e.g. internal APIs) should build a separate augment with an explicit allowlist, not disable this filter.

The SSRF filter lives in `src/http.ts` as the exported helper `rejectUnsafeUrl(url)` so other augments can adopt it with `createHttpClient({ rejectUnsafeUrls: true })`.

## `bash` — Scoped shell execution

```ts
import { bash } from "augment-1";

const shell = bash({
  cwd: "/workspace",
  allowedCommands: ["ls", "cat", "grep", "git", "bun", "python3"],
  timeoutMs: 30_000,
});
```

### What it is

A shell execution augment exposing two tools — `shell_exec` (run a command string) and `run_script` (write a script to a temp file and execute it). Both tools are gated by an operator-configured command allowlist: the first token of the command (or the script interpreter) must be in `allowedCommands` or the tool returns an error before forking.

### Per-trust-level defaults

By default, `shell_exec` and `run_script` are **blocked for both `public` and `agent` peers**. Only `creator` peers get the full bash surface.

```ts
// Default perTrustLevel (applied when opts.perTrustLevel is omitted):
perTrustLevel: {
  public: { neverExpose: ["shell_exec", "run_script"] },
  agent:  { neverExpose: ["shell_exec", "run_script"] },
}
```

This is a Layer 1 structural default — the capability table removes the tools from the model's tool list before the turn runs. Neither `public` nor `agent` peers can call them no matter how they phrase the request.

**Admitting an agent peer to bash** requires an explicit `perTrustLevel` override:

```ts
bash({
  cwd: "/workspace",
  allowedCommands: ["bun", "git"],
  // Admit agents but keep blocking public:
  perTrustLevel: {
    public: { neverExpose: ["shell_exec", "run_script"] },
    // agent: omitted — agents see both tools
  },
})
```

Passing `perTrustLevel: {}` would expose bash to everyone. Operators are responsible for understanding what they're opening up.

### Security model

- **Allowlist on entry** — the command token must match exactly. No shell expansion, no path traversal.
- **`cwd` is the only working directory** — set it to a directory the agent should be allowed to operate in.
- **`timeoutMs`** — default 30 seconds. Commands that exceed the timeout are killed.
- **No privilege escalation** — runs as the process user. No `sudo`; no setuid.

### Lifecycle

| Hook | What it does |
|------|-------------|
| `onBoot` | Verifies `cwd` exists. Throws if missing (to catch misconfiguration early). |
| `onShutdown` | None. |

## `budgets` — Per-trust-level turn budgets

```ts
import { budgets } from "augment-1";

const budget = budgets({
  dbPath: "./data/budgets.db",
  caps: {
    agent: { maxTurnsPerDay: 500 },
    public: {
      anonymous: { maxTurnsPerThread: 5 },
      recognized: { maxTurnsPerThread: 20, maxTurnsPerDay: 50, maxUsdPerDay: 1.00 },
    },
  },
  anonymousGlobalLimit: 60,    // max anonymous requests per rolling minute
  dailyBudgetUsd: 50.00,       // facility-wide daily USD ceiling
});
```

### What it does

The budgets augment is a turn-gate (see [03-types.md § Section 7b](./03-types.md#section-7b--turn-gate-admission-2pc)) that enforces per-trust-level turn budgets using a SQLite store. It runs a full 2PC cycle on every turn: reserve on prepare, commit on confirm, debit on cost-commit.

`creator` peers and null peers (internal/scheduled triggers) bypass all budget checks — no store writes occur.

### Configuration reference

| Field | Type | Default | Description |
|---|---|---|---|
| `dbPath` | `string` | required | Absolute path to the SQLite database file. Created if absent. |
| `caps.agent` | `BudgetCaps` | none | Caps for `agent`-trust peers. |
| `caps.public.anonymous` | `BudgetCaps` | none | Caps for public+anonymous peers. |
| `caps.public.recognized` | `BudgetCaps` | none | Caps for public+recognized peers. |
| `anonymousGlobalLimit` | `number` | none | Max anonymous requests per rolling minute (facility-wide). |
| `dailyBudgetUsd` | `number` | none | Facility-wide daily USD ceiling (sum across all priced turns). |
| `cleanupWindowMs` | `number` | 3,600,000 | Milliseconds before a stuck reservation is swept to `allow:incomplete`. |

**`BudgetCaps` fields:**

| Field | Type | Description |
|---|---|---|
| `maxUsdPerDay` | `number` | Max USD spend per peer per calendar day. Post-hoc (see below). |
| `maxTurnsPerThread` | `number` | Max turns per `threadId` per calendar day. |
| `maxTurnsPerDay` | `number` | Max turns across all threads per peer per calendar day. |

Omit any field to leave that dimension unconstrained.

### Cost-cap architecture: provider hard cap + runtime soft cap

The `budgets` augment enforces a **runtime soft cap** — `dailyBudgetUsd` denies the next turn after a turn finishes that pushes the cumulative day spend over the threshold. This is post-hoc: the offending turn completes; the next turn is rejected. Worst-case overshoot at the cap boundary is one turn (≈ $0.05 on Haiku, ≈ $0.50 on Sonnet for typical usage).

The runtime soft cap is **not the hard limit on agent spend**. The hard limit is your provider-side spend cap, configured in your provider's console:

- Anthropic: <https://console.anthropic.com/settings/limits>
- OpenAI: <https://platform.openai.com/settings/organization/limits>
- OpenRouter: <https://openrouter.ai/settings/credits>

**For unattended cloud-deployed agents, configuring a provider-side spend cap is required, not optional.** The runtime soft cap is the friendly first line of defense; the provider hard cap is the backstop that fires regardless of any Auggy-level configuration error or runtime bug. The engine adapters surface a clear operator-actionable message when the provider cap is reached (see `src/engines/anthropic.ts` `rewrapCostCapError`).

This is the v1.0 cost-cap architecture per [ADR-024](../../lo/docs/solutions/architecture/adr-024-kernel-surface-v1-lock.md). Pre-call cost estimation (a third architectural layer that gates the engine call before any spend) is explicitly deferred — provider caps are exact where pre-call estimation would only approximate.

### 2PC semantics

On every non-creator turn:

1. **Prepare** — the store opens a SQLite transaction, reads current usage, evaluates all active caps, stages a `turn_reservations` row (and optionally an `anonymous_requests` row), returns a ticket.
2. **Decision** — if any cap is exceeded, `decision: { allow: false, reason }`. Kernel rolls back all tickets, rejects with `errorClass: "cap-denied"`.
3. **Confirm** — kernel calls `ticket.confirm()`, which commits the staged rows.
4. **Context** — `budgets.context()` runs (after confirm, so the current turn is already counted). It reads peer usage and emits a BATS preamble block.
5. **Engine call** — normal turn execution.
6. **Cost commit** — kernel calls `gate.commit({ turnId, peer, cost })`. If `cost.priced === true`, the store debits `peer_daily_costs` and `daily_global`. If `priced: false`, the row is marked unpriced — turn-count caps still applied in prepare.

### Storage schema

Four tables in the SQLite database:

| Table | Purpose |
|---|---|
| `turn_reservations` | One row per turn. PK = `turn_id`. Tracks decision, costs, committed_at. |
| `daily_global` | One row per calendar day. Tracks total cost USD and unpriced turn count. |
| `peer_daily_costs` | One row per (peer, day). Tracks per-peer spend and unpriced turns. |
| `anonymous_requests` | Rolling log of anonymous request timestamps (for `anonymousGlobalLimit` sliding window). |

### BATS preamble

After the gate confirms, `budgets.context()` reads the peer's current usage from the store and emits a `ContextBlock` with placement `"preamble"`. The block includes:

- Remaining turns in this thread (if `maxTurnsPerThread` configured)
- Remaining turns today (if `maxTurnsPerDay` configured)
- Estimated spend today (if `maxUsdPerDay` configured)
- A behavioral guidance line bucketed by the minimum `budgetRatio`:

| `budgetRatio` | Guidance |
|---|---|
| `> 0.6` | "Explore thoroughly. No urgency." |
| `0.2 – 0.6` | "Focus on the core question. Begin wrapping up." |
| `< 0.2` | "Final response. Deliver a complete answer." |
| `= 0` | "Grace turn — summarize and close." |

The preamble is emitted only when at least one cap dimension is configured. `creator` and null peers get no preamble (bypass path).

### Post-hoc dollar caps

`maxUsdPerDay` is enforced **after** the turn runs. The prepare phase evaluates the cap against yesterday's + today's completed turns, not the in-flight turn. This means a single turn can push a peer slightly over their daily dollar limit — one-turn overshoot is acceptable and unavoidable without pre-call cost estimation.

Pre-call cost projection (estimating the turn's cost before running it) is deferred to a future roadmap item. See [ROADMAP.md](../../docs/ROADMAP.md) for "Pre-call cost estimation."

### v0 limitations

- **Single-instance topology.** The SQLite store is not safe for concurrent processes. Run one agent instance per `dbPath`.
- **One-turn dollar overshoot.** See post-hoc note above.
- **No rebuild path.** If the database is deleted, usage history is lost. The budgets store does not reconstruct from external state.

For a comprehensive operator reference, see [docs/12-budgets.md](./12-budgets.md).

## Why these aren't exhaustive

The built-in augments above are the **minimum viable set**. Real agents will mount more — telemetry augments, eval augments, ad-hoc tool augments for domain-specific capabilities. None of those belong in the runtime; they're application-specific.

The line between "ship it built-in" and "user implements" is roughly:
- **Built in:** anything that's a load-bearing reference implementation of a contract Auggy defines (`MemoryProviderSpec`, `TransportSpec`, filesystem access for skills), or infrastructure every public-facing agent needs (budgets, bash defaults, operator alerting).
- **User code:** anything that's domain-specific or where multiple competing implementations make sense.

The augment catalog (Plan 3 CLI) provides a way to publish and consume augments without bundling them into the runtime. Domain augments live there, not here.
