# 07 — Built-in Augments

> The augments shipped with Auggy in `src/augments/` and `src/transports/`. These are the load-bearing pieces a real Auggy agent uses out of the box.

## Why these specifically

Fourteen augments ship in `src/augments/` (plus `webTransport` under `src/transports/`):
- **`fileMemory`** — file-backed static memory provider
- **`supabaseMemory`** — Supabase-backed namespace memory provider (legacy runtime, not exposed in the default CLI catalog)
- **`layeredMemory`** — peer-scoped episodic memory with L0–L3 provenance tiers (SQLite-backed)
- **`webTransport`** — AG-UI HTTP transport (covered in [06-transports.md](./06-transports.md), not repeated here)
- **`telegramTransport`** — bidirectional Telegram bot transport
- **`filesystem`** — multi-mount scoped file access
- **`webFetch`** — URL fetch with HTML→text rendering
- **`knowledge`** — read-only registry of local-file and API-backed knowledge sources the agent can fetch on demand
- **`skills`** — model-facing skill surface; lists mounted skills (name + description from each SKILL.md's YAML frontmatter). See [11-skills.md](./11-skills.md).
- **`bash`** — scoped shell execution
- **`budgets`** — per-trust-level turn budgets + dollar ceiling
- **`notify`** — outbound messaging to operator-configured destinations
- **`mcp`** — external MCP server tools bridged into Auggy tools with
  allow/block lists and per-server/per-tool trust policy
- **`agentMail`** — policy-gated AgentMail send/receive, durable inbound
  polling/WebSocket/Svix delivery, outbound review, and operator audit
- **`turnControl`** — `request_input` for hand-off prompts
- **`visitorAuth`** — email magic-link verification; promotes anonymous → recognized
- **`link`** — legacy A2A-v0.2 peer transport (preview only; not current A2A)

The selection is deliberate. Together they cover: identity, episodic memory, web chat, Telegram chat, filesystem access, external knowledge, shell execution, cost management, operator alerting, turn-end input requests, and visitor email verification. Anything beyond this (model routing, evals, retrieval over special data sources) belongs in application-specific augments that live in the application's repo, not in Auggy itself.

The principle: Auggy ships the *contracts* (`MemoryProviderSpec`, `TransportSpec`) and a small set of *reference implementations* that prove the contracts work. Domain-specific augments are the user's responsibility.

## Default `auggy create` profile

Fresh agents are scaffolded for the shortest path to chat:

- `fileMemory` learned-behavior store
- `filesystem` with read-only `./skills` and writable `./data/workspace`
- `webTransport` for `/console`, `/console/chat`, `/agent/run`, and `/health`
- `webFetch`
- `turnControl`

The `skills` augment is runtime infrastructure and is auto-mounted when needed.
Stable add-ons (`knowledge`, `layeredMemory`, `notify`, `telegramTransport`,
`visitorAuth`, `agentMail`, `mcp`) are installed after first chat with
`auggy augment add <name>`. Preview augments (`budgets`, `link`, `bash`) remain
available behind an explicit confirmation because their production DX or
security edge cases are still being hardened. `supabaseMemory` remains in the
runtime for legacy/manual configs, but is intentionally not shown in the default
CLI catalog.

`auggy augment list` is the discovery surface. `auggy augment add` installs the
augment config, package dependencies, and bundled skill together. `auggy skill
add` is a repair/update command for restoring a bundled skill folder, not part
of the normal install path.

### Augment-as-folder + bundled-skill convention

Every built-in augment lives at `src/augments/<name>/index.ts` using the
folder shape. Augments that contribute model-callable tools ship a bundled
`<name>/skill/SKILL.md` colocated in the same folder; `auggy create` and
`auggy augment add` copy it to `<agent-dir>/skills/<name>/SKILL.md`, and `auggy skill
add <name>` installs it retroactively. A boot-time validator warns at agent
startup if a tool-providing augment is mounted without a skill — applies to
both factory-declared `tools[]` and namespace memory providers
(kernel-synthesized `memory_*` tools). Tool-less augments (transports, static
memory providers, admission gates) skip the skill folder.

Augments shipping a bundled skill in the current line: `filesystem`,
`layeredMemory`, `webFetch`, `knowledge`, `bash`, `notify`, `mcp`, `agentMail`,
`turnControl`, `visitorAuth`, `link`. The `skills` augment is the model-facing
surface that lists them — it carries no SKILL.md of its own.

### Model-facing surface

As described in [11-skills.md](./11-skills.md), the three Auggy primitives
surface to the engine on three orthogonal channels:

| Channel | What lands there | Cost model |
| --- | --- | --- |
| **Tools** | `{name, description, input_schema}` per declared tool, serialized into the engine's `tools[]` array on every request | Per-tool full schema |
| **Skills** | The `skills` augment emits ONE system-placement context block listing each mounted skill's `name` + `description` from its SKILL.md YAML frontmatter (agentskills.io standard). Body is on-demand via `fs_read` | ~100 tokens per skill in idle context |
| **Augments** | Invisible to the model. The augment as a concept is never named on the wire; only its *contributions* (tools, context blocks, skills) are visible | Zero model-facing cost |

Identity.md is identity. The `## Available skills` section that used to live there moved to the `skills` augment's emitted block; the kernel allocator no longer wraps context blocks with augment-source labels, so augment-name attribution is suppressed pre-send (still present in trace data for operator-facing diagnostics).

## `fileMemory` — File-backed static memory provider

```ts
import { fileMemory } from "auggy";

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

**2. Creator-approved learned behavior.** Agent-global operating guidance the
runtime-verified creator can update across turns. The default store is
operator-origin, preamble-placement, drop-on-eviction, and creator-only for
writes. The model reads and writes it through the generic `memory_read` and
`memory_write({ label: "learned", ... })` tools. Do not use it for operator
identity, authorization facts, autonomous policy changes, or durable
per-visitor profile data; peer-scoped memory belongs in `layeredMemory`.

### Why it's built in

File-backed memory is the lowest-common-denominator memory provider. It works on any system that has a filesystem. It needs no external dependencies. It's the Pre-v0 phase of LORF's roadmap (flat-file context) literally implemented as an augment.

If file-backed memory wasn't built in, every Auggy user would write the same ~70 lines on day one. Instead it ships in a tested form.

### Configuration

```ts
export interface FileMemoryOptions {
  label: string;                    // the static label this provider owns
  source: string;                   // absolute file path
  mutable: boolean;                 // whether write() is exposed
  writeTrustLevels?: TrustLevel[];  // optional additional write allowlist
  origin: ContextOrigin;            // "operator" | "system" | "agent" | "agent-derived" | "peer-derived"
  priority: ContextPriority;        // "required" | "high" | "normal" | "low" | "evictable"
  placement: ContextPlacement;      // "system" | "preamble" | "assistant-preamble"
  eviction: EvictionPolicy;         // "never" | "summarize" | "drop"
  ttl?: "turn" | "session" | "persistent";  // default "persistent"
}
```

The `MemoryDefaults` for the synthesized context block come from these options
directly. Mutable writes are serialized and update the in-memory cache only
after the disk write succeeds. Setting `placement: "system"` is what makes the
file's content show up in the model's system prompt rather than in the
user-side context wrapper.

### Implementation notes

```ts
export function fileMemory(opts: FileMemoryOptions): Augment {
  let cache: string | null = null;
  let writeQueue: Promise<void> = Promise.resolve();

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
        const queuedWrite = writeQueue.then(async () => {
          await writeFile(opts.source, content, "utf-8");
          cache = content;
        });
        writeQueue = queuedWrite.catch(() => undefined);
        await queuedWrite;
      }
    : undefined;

  return {
    name: `file-memory-${opts.label}`,
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

- **`write()` serializes writes and atomically replaces the resolved target.**
  Content is first written to a same-directory temporary file and then renamed
  over the target. A failed temporary write leaves the destination and prior
  cache intact, later queued writes can still proceed, and symlink-backed
  source paths keep pointing at the updated target.

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

In the prompt, this becomes a system-position block without an augment-name
wrapper. The block's `source` remains available in traces and evictions, but
the model does not see internal augment names.

## `supabaseMemory` — Supabase-backed namespace memory provider

```ts
import { createClient } from "@supabase/supabase-js";
import { supabaseMemory } from "auggy";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const episodic = supabaseMemory({
  namespace: "episode",
  scope: "peer",
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

A namespace `MemoryProviderSpec` backed by a Supabase table. `scope` is
required: use `"peer"` for peer-derived memory and `"shared"` only for
deliberately cross-peer operator/system content. Peer scope filters by the
resolved peer in SQL before ordering or limiting results, omits unsafe exact
label reads, and fails closed when no peer identity is available.

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
  scope: "peer" | "shared";           // required authorization boundary
  client: SupabaseLikeClient;
  table: string;                      // the table to read/write
  peerColumn?: string;                // default "peer_id"
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
  peer_id     text not null,
  created_at  timestamptz not null default now()
);

create index agent_memories_label_idx on agent_memories (label);
create index agent_memories_created_at_idx on agent_memories (created_at desc);
create index agent_memories_peer_created_idx
  on agent_memories (peer_id, created_at desc);
```

For an existing peer-derived table, use a staged migration rather than
guessing ownership:

```sql
alter table agent_memories add column if not exists peer_id text;

-- Backfill only from authoritative application/audit data. Quarantine rows
-- whose owner cannot be proven; do not assign them to a convenient peer.
create index concurrently if not exists agent_memories_peer_created_idx
  on agent_memories (peer_id, created_at desc);

-- Run only after the authoritative backfill and quarantine are complete.
alter table agent_memories alter column peer_id set not null;
```

Rows that cannot be assigned to a verified peer must not be made visible
through peer scope. Move deliberately global operator/system content to a
separate table and provider configured with `scope: "shared"`.

Repeat the peer boundary in database RLS as defense in depth. The precise
session/JWT claim is deployment-specific, but the policy must compare it to
the row rather than accept a caller-supplied query value:

```sql
alter table agent_memories enable row level security;
alter table agent_memories force row level security;

-- Replace auggy_runtime with the actual least-privilege runtime role.
-- Audit and remove obsolete broad policies before enabling this role.
create policy agent_memories_runtime_grant on agent_memories
  as permissive for all to auggy_runtime
  using (true)
  with check (true);

create policy agent_memories_peer_isolation on agent_memories
  as restrictive for all to auggy_runtime
  using (peer_id = current_setting('request.jwt.claim.peer_id', true))
  with check (peer_id = current_setting('request.jwt.claim.peer_id', true));
```

PostgreSQL OR-combines permissive policies. A new permissive isolation policy
does not neutralize an existing broad permissive policy. Inventory policies for
the runtime role (including policies granted to `PUBLIC`), remove stale grants,
and use a restrictive peer predicate alongside an explicit role-scoped grant
as shown above.

Supabase service-role credentials bypass RLS. If the runtime uses them, the
augment's SQL predicate and post-validation are the primary boundary; restrict
that credential to the server and monitor it accordingly. The table and
peer-column names are configurable, and the configured identifier is strictly
validated.

Rollback is security-sensitive. An older binary ignores `peer_id` and can
reopen cross-peer reads. Before rolling back, disable this provider or enforce
an equivalent peer predicate in a database role/policy the old binary cannot
bypass. Replace or disable service-role credentials before relying on RLS
during rollback. Do not drop `peer_id`, its index, or the RLS policy.

### Implementation notes

#### `search(query)`

```ts
const scope = opts.scope; // authorization configuration is snapshotted
const search = async (query: string, queryOpts?: MemoryQueryOpts): Promise<MemoryEntry[]> => {
  const peerId = scope === "peer" ? requirePeerId(queryOpts) : undefined;
  let request = opts.client
    .from(opts.table)
    .select("label, content, metadata, created_at, peer_id")
    .ilike("label", "episode:%");
  if (scope === "peer") request = request.eq("peer_id", peerId);
  const { data, error } = await request
    .ilike("content", `%${escapedQuery}%`)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  const rows = (data ?? []) as Array<{ label; content; metadata? }>;
  return rows
    .filter((r) => r.label.startsWith(prefix))     // namespace isolation
    .map((r) => ({ label: r.label, content: r.content, metadata: r.metadata }));
};
```

Namespace and peer predicates are applied before `limit`; post-validation
rejects malformed, wrong-namespace, or wrong-peer rows returned by a faulty
client or policy.

`searchLimit` is validated between 1 and 100. ILIKE wildcard characters in the
query are escaped so a peer cannot broaden a restrictive search with `%`, `_`,
or backslash.

#### `read(label)`

Exact reads are exposed only for `scope: "shared"`. Peer-scoped callers use
`search(query, { peerId })`; a label alone is not ownership evidence.

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
  ? async (label: string, content: string, writeOpts?: MemoryWriteOpts): Promise<void> => {
      if (!label.startsWith(prefix)) {
        throw new Error("label is outside this namespace");
      }
      const peerId = scope === "peer" ? requirePeerId(writeOpts) : undefined;
      if (peerId && !label.startsWith(`${prefix}${peerId}:`)) {
        throw new Error("label is not structurally bound to this peer");
      }
      const row = {
        label,
        content,
        ...(peerId ? { peer_id: peerId } : {}),
        created_at: new Date().toISOString(),
      };
      const { error } = await opts.client.from(opts.table).insert(row);
      if (error) throw error;
    }
  : undefined;
```

`write` is **insert-only**. Each call appends a new row, even if a row with that label already exists. This is intentional for episodic memory — you typically don't want to overwrite past episodes; you want a log of what happened. If a use case needs upsert, that's a different provider.

Peer-scoped writes require a resolved peer, require the label to be
structurally peer-bound, and persist that peer in the configured peer column.

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
  const entries = await aug.memory.search(text, {
    peerId: turnState.trigger.peer?.id,
  });
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

## `layeredMemory` — Peer-scoped episodic memory

```yaml
# agent.yaml
augments:
  - layeredMemory

# augments/layeredMemory/augment.yaml
type: layeredMemory
config:
  backend: sqlite
  namespace: ${AGENT_NAME}
  dbPath: ./data/memory.db
  retentionDays: 90
  autoSave:
    enabled: false
    extractionFrequency:
      creator: every-turn
      agent: every-N-turns
      public:
        recognized: every-turn
        anonymous: session-end-only
    everyNTurns: 3
    confidenceThreshold: 0.5
```

### What it is

`layeredMemory` is the primary peer-scoped episodic memory augment. Every entry is bound to the peer who is talking in the current turn — peers cannot read each other's entries. Storage is pluggable: SQLite (default, runs locally with WAL mode and prepared statements) or Supabase (manual/programmatic configs). All eleven day-one mitigations (provenance, supersession, verbatim flags, embedding versioning, retention classes) are present in the schema from the first write.

`layeredMemory` registers as a namespace memory provider. The kernel's memory bus synthesizes five model-callable tools automatically: `memory_read`, `memory_search`, `memory_write`, `memory_list`, and `memory_forget`.

### Retrieval and auto-save capability

For namespace memory providers, the memory bus automatically adds the current
peer's most recent entries to each message turn, then runs keyword search
against the inbound text. This is what makes a returning verified visitor's
"hey" turn useful even when the latest message has no searchable content.

Auto-save is a capability of `layeredMemory` itself, not a separate augment. In
CLI-created agents it is installed with `autoSave.enabled: false`, so the model
saves memory explicitly with `memory_write({ topic, content })`. The
runtime derives the current peer label from turn context, so the model does not
hand-build visitor IDs or internal labels. Programmatic users can enable
auto-save by providing an extraction engine; when enabled, a background process
runs after user-facing turns, extracts structured facts from the completed
conversation transcript, and writes them to the peer's namespace with
`origin: "agent-derived"`.

The model never invokes auto-save directly. The only visible effect is that `memory_search` results sometimes include entries marked `[AGENT-DERIVED]`.

#### Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `autoSave.enabled` | `boolean` | `false` in CLI scaffold; factory default `true` | Set `false` for explicit-only memory — model must call `memory_write` manually. |
| `autoSave.extractionFrequency.creator` | frequency | `every-turn` | Extraction cadence for creator-trust peers. |
| `autoSave.extractionFrequency.agent` | frequency | `every-N-turns` | Extraction cadence for agent-trust peers (conservative default; agent-to-agent volume may be high). |
| `autoSave.extractionFrequency.public.recognized` | frequency | `every-turn` | Extraction cadence for recognized public peers. |
| `autoSave.extractionFrequency.public.anonymous` | frequency | `session-end-only` | Extraction cadence for anonymous visitors. Keeps per-visitor extraction cost to one batched call at session end rather than every turn. |
| `autoSave.everyNTurns` | `number` | `3` | N for `every-N-turns` frequency. |
| `autoSave.confidenceThreshold` | `number` | `0.5` | Facts with confidence below this threshold are written but flagged low-confidence. |
| `autoSave.engine` | extraction engine object | none | Required for auto-save extraction. Omit to use explicit-only memory. |

**Frequency values:** `every-turn` | `every-N-turns` | `session-end-only` | `never`.

#### Per-trust-level defaults

| Trust | Default | Typical cost per 20-turn conversation |
|-------|---------|---------------------------------------|
| `creator` | `every-turn` | ~$0.20 (low volume; operator chatting with their own agent) |
| `agent` | `every-N-turns` (N=3) | ~$0.07 (conservative; agent-to-agent caps may not be provisioned for every-turn extraction) |
| `public.recognized` | `every-turn` | ~$0.20 (returning identified peer; relationship-relevant) |
| `public.anonymous` | `session-end-only` | ~$0.05 (visitor traffic dominates cost; one batched call at session end) |

Cost estimates are order-of-magnitude and apply only when an extraction engine
is configured. They are based on a small extraction model × ~500 input tokens +
~200 output tokens per extraction call.

#### `[AGENT-DERIVED]` origin marker

Entries written by auto-save carry `origin: "agent-derived"`. When the context allocator renders these entries into context or `memory_search` returns them, they appear with an `[AGENT-DERIVED]` provenance marker. The model's bundled skill teaches it to treat these as paraphrases, not verbatim records, and to prefer `[PEER-DERIVED]` entries when they conflict.

Auto-save never overwrites a verbatim peer entry. Explicit `memory_write` calls from the model and auto-save writes coexist; the trust hierarchy (verbatim peer statements outrank LLM paraphrases) applies at retrieval time.

#### Cost flows through existing budgets

Auto-save extraction runs as an admitted internal turn — it flows through the same `budgets` augment turn-gate and `dailyBudgetUsd` cap as user-facing turns. There is no separate extraction cost surface; operators see one daily-spend total. When the daily budget cap is reached, further extraction turns are denied exactly like user-facing turns.

#### Bundled skill

The bundled `src/augments/layeredMemory/skill/SKILL.md` teaches the model when and how to use `memory_write`, `memory_search`, `memory_list`, and `memory_forget`, plus a section on interpreting `[AGENT-DERIVED]` entries and the privacy boundaries that apply to both manual and auto-saved writes. Copied into `<agent-dir>/skills/layeredMemory/SKILL.md` at `auggy create`/`auggy augment add` time; install retroactively with `auggy skill add layeredMemory`.

### Console/API info

The console dashboard API exposes a **Memory** block with:

- **KV row** — total live entry count, retention-class breakdown (operational vs lesson), namespace prefix.
- **Table** — 50 most-recent live entries (peer, label, content snippet, retention class, age) with a per-row `memory-erase` action.
- **Erase semantics** — invokes `store.forget(peerId)` and reports the deletion count. Per-peer only; there is no "erase all" affordance (intentional — too easy to wipe everything by mistake).

See [docs/06-transports.md § The `/console` route](./06-transports.md#the-console-route) for the route reference.

## How they compose

A typical agent setup uses both:

```ts
const agent = defineAgent({
  name: "zip",
  displayName: "Zip",
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
      scope: "peer",
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
3. The synthetic `memory-bus` augment is appended with the five generic memory tools.
4. `generateAgentCard` produces internal Auggy metadata with capability flags
   and tool-derived skill entries. This generic payload is not a current A2A
   Agent Card and must not be assumed safe to publish without review.
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
import { filesystem } from "auggy";

const fs = filesystem({
  mounts: [
    { name: "skills",    path: "./skills",    writable: false },
    { name: "workspace", path: "./workspace",  writable: true, deletable: true },
    { name: "repo",      path: "/repos/platform", writable: false },
  ],
  workspaceAwareness: { enabled: true, maxEntries: 24, maxDepth: 4 },
});
```

### What it is

A multi-mount filesystem augment following the Docker volumes model. The operator declares named mounts with per-mount permissions. The model uses logical paths (`mount-name/path/to/file`); the augment resolves physical paths and enforces security boundaries.

### When to use it

Two primary use cases:

**1. Skill folder access.** The agent needs to read SKILL.md files and their
supporting references on demand. This is **progressive disclosure** — the
model reads skills via `fs_read` when it decides the conversation needs
guidance. The filesystem augment IS the skill loader. Bundled skill folders
for each tool-providing augment are copied into
`<agent-dir>/skills/<augment-name>/` at scaffold time.

**2. Agent workspace.** The agent needs to create, read, and manage files as
part of its work — drafts, notes, reports, and intermediate outputs. A mount
named `workspace` automatically contributes a bounded, metadata-only catalog
to creator and agent turns. The catalog ranks filenames against the current
request, giving the model cheap awareness before it chooses `fs_search`,
`fs_list`, or `fs_read`. File contents are never injected automatically.

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

interface WorkspaceAwarenessOptions {
  enabled?: boolean;      // auto-enabled when a "workspace" mount exists
  mount?: string;         // default "workspace"
  maxEntries?: number;    // context paths, default 24, max 100
  scanLimit?: number;     // inspected entries, default 500, max 5000
  maxDepth?: number;      // default 4, max 12
  trustLevels?: TrustLevel[]; // default ["creator", "agent"]
}
```

Three permission tiers: **read-only** (default) → **writable** → **writable + deletable**.

### Security model

- **Nearest-existing-ancestor canonicalization** catches escaping symlink
  parents even when the requested leaf and intermediate descendants do not
  exist. Dangling links fail closed.
- **Mutation paths reject symlink components.** Parent directories are created
  one segment at a time and revalidated; file leaves use `O_NOFOLLOW`, reject
  hard-linked inodes, and compare the opened device/inode with preflight state
  before truncation.
- **`path.relative()`-based boundary check** — prevents `../` traversal, prefix-collision escapes (mount `/var/data/work` doesn't accept `/var/data/workspace/...`), and cross-drive escapes on Windows, while still working correctly when the mount itself is a filesystem root (e.g. `/` on POSIX)
- **Search/list isolation** rejects traversal glob patterns, canonicalizes every
  search result, and never follows an escaping symlink to disclose target
  metadata.
- **Binary detection** via file extension — returns an error message instead of garbage content for images, PDFs, compiled binaries
- **Size truncation** — files over `maxReadSize` are truncated with a `[truncated at 256KB, total size: 20MB]` marker
- **Per-mount permissions** — enforced on every operation before any file I/O
- **Mount isolation** — each mount is an independent security boundary; no cross-mount path references
- **Per-trust-level structural defaults** — the augment ships with `perTrustLevel: { public: { neverExpose: ["fs_write", "fs_mkdir", "fs_remove"] }, agent: { neverExpose: ["fs_remove"] } }`. Public peers structurally cannot see the three mutation tools; agent peers cannot see `fs_remove`. This runs at the capability table *before* the model sees the tool list (Layer 1 enforcement). Mount-level `writable` / `deletable` flags remain as a complementary defense — they run inside the tool after it has already been called, so they catch operator-authorized tools being called against the wrong mount.
- **Metadata-only workspace awareness** — the catalog skips hidden paths,
  configured search excludes, and symlinks; bounds traversal by count and
  depth; and injects filenames as `[AGENT-DERIVED]` observations rather than
  trusted instructions. Public turns do not receive it unless explicitly
  configured.

Portable JavaScript does not expose descriptor-relative `openat2` resolution,
so it cannot eliminate every parent-directory replacement race against a
hostile process with write access to the same mount. Writable mount directories
must therefore be inaccessible to less-trusted local users/processes and
confined with OS/container permissions. The no-follow and inode checks reduce
the window but are not a substitute for that deployment boundary.

### Lifecycle

| Hook | What it does |
|------|-------------|
| `onBoot` | Creates missing writable mount roots with owner-only POSIX permissions, then resolves and caches every mount root. Missing read-only roots fail boot. Optionally loads a SKILL.md if `skillFile` is configured. |
| `context` | Produces bounded workspace policy/catalog blocks for allowed peers; scans metadata only. |
| `onShutdown` | None. |

### Important constraint

**Filesystem mount paths must not overlap with `fileMemory` source paths.** If the same file is owned by `fileMemory` (cached at boot) and accessible via a writable filesystem mount, writes through the filesystem augment won't invalidate `fileMemory`'s cache, causing stale context. This is an operator responsibility in v1.

### Bundled skill

The filesystem augment ships a bundled skill folder colocated under its augment directory:

```
src/augments/filesystem/skill/
├── SKILL.md                        # teaches when/how to use the 6 fs tools
└── references/
    └── mount-permissions.md        # full permission matrix + security details
```

Copied into `<agent-dir>/skills/filesystem/` at `auggy create`/`auggy augment add` time; install retroactively with `auggy skill add filesystem`. The model loads it on demand via `fs_read`.

## `notify` — Outbound messaging to operator-configured destinations

```ts
import { notify } from "auggy";

const notifyAugment = notify({
  destinations: [
    {
      name: "creator",
      transport: "webhook",
      url: process.env.ORG_NOTIFY_URL!,
      allowedTrustLevels: ["creator", "agent"],
    },
  ],
});
```

### What it is

The `notify` augment gives the agent a `notify` tool for pushing messages to operator-defined destinations outside the current conversation. Unlike transport replies — where the agent responds to the peer who triggered the current turn — `notify` pushes to destinations that are **not** the active peer. Use it to alert an operator, escalate a situation, share a status ping, or hand off to a human mid-conversation.

Destinations are declared in config, not in the agent prompt. The agent always refers to a destination by its operator-assigned name (`"creator"`, `"ops"`, `"alerts"`, etc.). This keeps Telegram chat IDs and webhook URLs out of the model's context entirely. Destinations default to creator/agent trust and can explicitly opt public peers into an escalation-only policy.

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

Four adapters ship under `src/augments/notify/adapters/`:

- **`webhook`** — HTTP POST of `{ summary, reason?, visitor?, channel: "notify" }` to a configured URL. Uses the shared `src/http.ts` client for redirect security. Any 2xx is success; other statuses are `failed` with the status code and up to 200 chars of the response body.
- **`telegram`** — `sendMessage` via the shared `src/telegram-client.ts`. Formats the payload as Markdown. Multiple telegram destinations sharing the same bot token share one client instance.
- **`agentmail`** — outbound email via AgentMail using a configured inbox and recipient list.
- **`log-to-file`** — appends JSONL records to a local file; this is the zero-secret default installed by `auggy augment add notify`.

### Rate limiting

Rate limiting is stateful and in-memory (resets on restart). Checks in order:

1. **Per-peer cooldown** — suppresses a second notification from the same peer within `perPeerCooldownMs`.
2. **Global hourly cap** — rolling 60-minute window; defaults to 5 notifications per hour.
3. **Dedup** — word-overlap comparison against summaries sent in the last `dedupWindowMs`; suppresses near-duplicates above `dedupThreshold`.

Creator-class senders (and null peers / scheduled triggers) bypass all rate limits entirely.

### Outbound messaging history

`notify` is the successor to the `org_escalate` tool that was removed from `manifest` in roadmap item 6 (commit `59d82c7`). The capability is equivalent; the structural change is that the destination URL is now in augment config rather than embedded in the tool definition.

For the full operator reference, see [docs/13-notify.md](./13-notify.md).

### Bundled skill

This augment ships `src/augments/notify/skill/SKILL.md` with model teaching on the `notify` tool — destination semantics, when to escalate vs answer in-thread, dedup awareness. Copied into `<agent-dir>/skills/notify/SKILL.md` at `auggy create`/`auggy augment add` time; install retroactively with `auggy skill add notify`.

### Console/API info

The console dashboard API exposes a **Notify** block with:

- **KV row** — global cap per hour (with `yaml` or `/console override` source), cooldown ms, configured destination count.
- **Table** — last 50 dispatch attempts from the augment's internal ring buffer (time, destination, status, summary snippet).
- **Actions** — `notify-test` (sends `[test] <message>` via the named destination, **bypassing rate-limit + dedup** for diagnostic dispatch), `notify-cap-adjust` (overrides `globalMaxPerHour`), `notify-cap-reset` (restores yaml).

The override persists across restart when `agentDir` is set in the augment config.

## `knowledge` — Read-only knowledge source registry

```ts
import { knowledgeRoot } from "auggy";

const orgKnowledge = knowledgeRoot({
  root: "./knowledge",
});
```

### What it is

A read-only augment that connects an agent to local project knowledge and optional remote knowledge APIs. It provides two stages of progressive disclosure:

1. **Source manifests** — always in context (~200 tokens per source): org identity, purpose, operator, phase, and a list of available endpoints with descriptions. The agent uses this to know which source covers which topic.
2. **Endpoint content** — on demand via `knowledge_fetch`: the agent fetches the full content of a specific endpoint when the conversation calls for it (docs, ADRs, initiative details, etc.).

### Tool surface

`knowledge` exposes exactly **one tool**: `knowledge_fetch`.

```
knowledge_fetch({ source: string, endpoint: string })
```

Fetches the content at the selected source and endpoint. The agent calls this when the visitor's question warrants pulling in specific org knowledge — for example, `knowledge_fetch({ source: "local", endpoint: "/vision" })` to retrieve the full vision document.

Each source manifest lists available paths. The agent reads the descriptions and decides which source and endpoint to fetch — this is the progressive disclosure model: the skeleton is always present, the detail is fetched on demand.

> **Note:** Outbound messaging lives in `notify`. `knowledge` is read-only — no write operations, no escalation.

### Configuration

```ts
export interface KnowledgeRootOptions {
  root: string;           // Directory containing sources.json
  cacheTtlMs?: number;    // Manifest cache TTL in ms. Default 1 hour.
  client?: HttpClient;    // Optional pre-built HTTP client (for testing)
}
```

### `knowledge/sources.json`

`auggy augment add knowledge` scaffolds `knowledge/sources.json` plus a
`knowledge/local/` source so an adopter has working local knowledge without
standing up an HTTP server.

```json
{
  "sources": [
    {
      "name": "local",
      "description": "Local project knowledge maintained with this agent",
      "baseUrl": "file://./local"
    }
  ]
}
```

Each source directory contains a `manifest` file plus endpoint files. `file://` sources resolve under the configured source directory; realpath validation rejects any path that escapes (mirrors the filesystem augment's defense). HTTP/HTTPS baseUrls retain their original semantics.

### Local setup

The fastest path is to keep source URLs out of augment config and edit files inside `knowledge/`:

```text
knowledge/
  sources.json
  local/
    manifest
    mission.md
    context.md
```

To add a local topic:

1. Create a markdown file under `knowledge/local/`, for example `pricing.md`.
2. Add an endpoint to `knowledge/local/manifest`:

```json
{
  "path": "/pricing",
  "description": "Pricing, plans, and billing policy"
}
```

3. Restart the agent. The model will see `/pricing` in the `local` source and can call:

```ts
knowledge_fetch({ source: "local", endpoint: "/pricing" })
```

The endpoint path maps to a file in the same source directory. `/pricing` resolves to `knowledge/local/pricing` first, then falls back to `knowledge/local/pricing.md`.

### Remote setup

To add a remote source, add a second entry to `knowledge/sources.json`:

```json
{
  "name": "docs",
  "description": "Published product documentation",
  "baseUrl": "https://docs.example.com/knowledge"
}
```

The remote service must expose:

```text
GET /manifest
GET /<endpoint listed in manifest>
```

Use source names that explain where the content lives (`local`, `docs`, `handbook`, `api`) and endpoint descriptions that explain when the model should fetch each endpoint. This is the key DX rule: source selection and endpoint selection are driven by descriptions, not hidden routing logic.

### Boot behavior

Boot is graceful: if a source is unreachable at startup (HTTP) or the configured directory is missing (`file://`), the agent starts without that source's manifest and logs a warning. `knowledge_fetch` will return clear error messages until the source becomes reachable. This prevents a temporarily unavailable knowledge API from taking down a running agent.

### Bundled skill

This augment ships `src/augments/knowledge/skill/SKILL.md` with model teaching on the `knowledge_fetch` tool — source manifests, when to fetch endpoints, progressive-disclosure rationale. Copied into `<agent-dir>/skills/knowledge/SKILL.md` at `auggy create`/`auggy augment add` time; install retroactively with `auggy skill add knowledge`.

## `telegramTransport` — Bidirectional Telegram bot transport

```yaml
# agent.yaml
augments:
  - telegramTransport

# augments/telegramTransport/augment.yaml
type: telegramTransport
config:
  botToken: ${TELEGRAM_BOT_TOKEN}
  inbound:
    mode: polling
    polling:
      timeoutSec: 30
  auth:
    creatorUserIds: []
    creatorUserIdsEnv: TELEGRAM_CREATOR_USER_IDS
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
| 1 | `creatorUserIds` or `creatorUserIdsEnv` contains sender ID | `"creator"` | `tg_user_<userId>` |
| 2 | `admittedAgents` has matching `telegramUserId` | `"agent"` | Agent's logical `id` field |
| 3 | `recognizedUserIds` contains sender ID | `"public"` / `"recognized"` | `tg_user_<userId>` |
| 4 | None of the above | `"public"` / `"anonymous"` | `tg_anon_<threadId>` (ephemeral) or `tg_user_<userId>` (durable) |

**`anonymousIdentityMode`:** The default `"ephemeral"` ties the anonymous peer.id to the Telegram chat thread — memory is retained within a session but not globally. `"durable"` uses the Telegram user ID, enabling cross-session memory recall. Durable mode should be chosen carefully given privacy implications.

### `admittedAgents` boot-time validation

At boot, the augment calls `getChat` for each `admittedAgents` entry to verify the configured `telegramUserId` is reachable. Validation failures log a warning and produce silent trust demotion (the agent peer is treated as `public-anonymous`) rather than aborting boot. Operators should treat validation warnings as misconfigurations to fix promptly — the consequence is the admitted agent losing tool access it expects to have.

For the full operator reference (both modes, full config schema, webhook deployment notes, troubleshooting), see [docs/14-telegram-transport.md](./14-telegram-transport.md).

## `webFetch` — URL fetch with HTML→text rendering

```ts
import { webFetch } from "auggy";

const fetcher = webFetch({
  timeoutMs: 15000,
});
```

A single-tool augment exposing `web_fetch(url, prompt)`. Fetches the URL, strips HTML (or passes JSON through), produces a prompt-aware summary. Built around `createHttpClient` from `src/http.ts`.

### Security model — resolved and pinned SSRF defense

The augment forces its HTTP client to use `urlPolicy: "public"`; callers cannot turn this off through `WebFetchOptions`. Before the initial request and every redirect, the client resolves all A/AAAA answers, rejects the entire answer set if any address is not globally routable, and connects through a lookup pinned to the validated snapshot. The original hostname remains authoritative for the HTTP `Host` header, TLS SNI, and certificate verification.

- Loopback (`localhost`, `127.0.0.0/8`, `::1`)
- RFC 1918 private ranges (`10/8`, `172.16/12`, `192.168/16`)
- Carrier-grade NAT/shared space (`100.64.0.0/10`)
- Link-local (`169.254.0.0/16` — covers AWS EC2 metadata `169.254.169.254` and similar)
- IPv6 link-local (`fe80::/10`) and unique-local (`fc00::/7`)
- Unspecified, documentation, benchmarking, protocol-assignment, multicast, and reserved ranges
- Unsafe IPv4-compatible, IPv4-mapped, and NAT64-embedded destinations
- Cloud metadata FQDNs (`metadata`, `metadata.google.internal`)
- Non-http(s) schemes (`file://`, `ftp://`, `gopher://`, …)
- HTTPS-to-HTTP redirect downgrades

Rejected URLs throw from the HTTP client and are caught by the `web_fetch` tool, surfaced as structured error JSON. Redirects are manual and bounded. On a cross-origin redirect, all custom headers are removed unless the client operator explicitly allowlists a header for that exact destination origin; stripped headers are never reconstructed later in the chain.

Operator-configured clients can select `urlPolicy: "operator-configured"` when an integration intentionally targets a private or loopback service. That policy is for fixed, trusted configuration—not model-, peer-, or request-supplied URLs. Passing a custom client to `webFetch` explicitly transfers enforcement of this network boundary to the operator.

The URL and address helpers live in `src/http.ts`; augment authors handling untrusted URLs should use `createHttpClient({ urlPolicy: "public" })`.

### Bundled skill

This augment ships `src/augments/webFetch/skill/SKILL.md` with model teaching on the `web_fetch` tool — when to fetch vs ask, prompt-aware summarization, blocked-URL handling. Copied into `<agent-dir>/skills/webFetch/SKILL.md` at `auggy create`/`auggy augment add` time; install retroactively with `auggy skill add webFetch`.

## `bash` — Scoped shell execution

```ts
import { bash } from "auggy";

const shell = bash({
  cwd: "/workspace",
  allowedCommands: ["ls", "cat", "grep", "git", "bun", "python3"],
  timeoutMs: 30_000,
});
```

### What it is

A shell execution augment exposing two tools — `shell_exec` (run a command string) and `run_script` (write a script to a temp file and execute it). Both tools are gated by an operator-configured command allowlist: the first token of the command (or the script interpreter) must be in `allowedCommands` or the tool returns an error before forking.

`bash` remains preview in the pre-1.0 line. It executes host processes as the Auggy
process user; it is not a sandbox, container boundary, filesystem jail, or
privilege separator. Treat `risk`, `allowedCommands`, `blockedCommands`,
`workingDir`, environment inheritance, and `perTrustLevel` as operator policy
controls that reduce exposure, not as isolation guarantees.

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
- **No sandbox boundary** — a permitted command can touch anything reachable by the process user.

### Lifecycle

| Hook | What it does |
|------|-------------|
| `onBoot` | Verifies `cwd` exists. Throws if missing (to catch misconfiguration early). |
| `onShutdown` | None. |

### Bundled skill

This augment ships `src/augments/bash/skill/SKILL.md` with model teaching on `shell_exec` and `run_script` — allowlist semantics, risk-tier framing, and per-trust-level defaults. Copied into `<agent-dir>/skills/bash/SKILL.md` at `auggy create`/`auggy augment add` time; install retroactively with `auggy skill add bash`.

## `budgets` — Per-trust-level turn budgets

```ts
import { budgets } from "auggy";

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
  retentionDays: 30,           // optional persisted accounting retention
});
```

### What it does

The budgets augment is a turn-gate (see [03-types.md § Section 7b](./03-types.md#section-7b--turn-gate-admission-2pc)) that enforces per-trust-level turn budgets using a SQLite store. It runs a full 2PC cycle on every turn: reserve on prepare, commit on confirm, debit on cost-commit.

`budgets` remains preview in the pre-1.0 line. It is runtime spend guardrails, not billing
control. USD caps are post-hoc soft caps, so a turn can overshoot the configured
threshold before the next turn is denied. Provider-side hard spend caps are
still required for unattended agents.

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
| `retentionDays` | positive integer | none | Optional UTC-day retention window, in whole days, for persisted accounting rows. |

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

**For unattended cloud-deployed agents, configuring a provider-side spend cap is required, not optional.** The runtime soft cap is the friendly first line of defense; the provider hard cap is the backstop that fires regardless of any Auggy-level configuration error or runtime bug. The engine adapters surface a clear operator-actionable message when the provider cap is reached (see the provider adapter packages such as `packages/anthropic`).

Pre-call cost estimation (a third architectural layer that gates the engine
call before any spend) is explicitly deferred — provider caps are exact where
pre-call estimation would only approximate.

SQLite-backed budgets are single-process and single-replica. The store has no
built-in retention or purge policy yet; reservation and anonymous-request rows
accumulate until the operator removes or archives them.

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

Pre-call cost projection (estimating the turn's cost before running it) is
deferred until budget enforcement needs a stronger pre-turn guarantee.

### v0 limitations

- **Single-instance topology.** The SQLite store is not safe for concurrent processes. Run one agent instance per `dbPath`.
- **One-turn dollar overshoot.** See post-hoc note above.
- **No rebuild path.** If the database is deleted, usage history is lost. The budgets store does not reconstruct from external state.

For a comprehensive operator reference, see [docs/12-budgets.md](./12-budgets.md).

### Console/API info

The console dashboard API exposes a **Budgets** block with:

- **KV row** — daily cap (with `yaml` or `/console override` source), today's total spend, active peer count.
- **Table** — per-peer spend + unpriced turn count for today (top 50 peers).
- **Actions** — `budget-cap-adjust` (POSTs a new daily cap; persists to `admin-overrides.json`) and `budget-cap-reset` (clears the override, restores the yaml value).

The closure variable backing the daily cap is mutated on flip, so the new cap takes effect on the NEXT `prepare()` — no restart required. Pass `agentDir` in the augment config to enable persistence.

## `visitorAuth` — Email magic-link verification

```yaml
# agent.yaml
augments:
  - visitorAuth

# augments/visitorAuth/augment.yaml
type: visitorAuth
config:
  publicUrl: ${AUGGY_PUBLIC_URL}
  dbPath: ./data/visitor-auth.db
  agentMail:
    transport: agentmail
    apiKey: ${AGENTMAIL_API_KEY}
    inboxId: ${AGENTMAIL_INBOX_ID}
  signingKey: ${VISITOR_SIGNING_KEY}
  rateLimit: { perHour: 1, perDay: 3 }
  reverifyAfterDays: 90
  tokenTtlMinutes: 15
  layeredMemoryDbPath: ./data/memory.db
```

### What it is

The first member of the auth-augment family. `visitorAuth` lets a
`public` + `anonymous` visitor verify ownership of an email address and become
`public` + `recognized` — same `vis_<uuid>` identity returns across sessions,
enabling memory continuity and caller recognition.

It adds a model-callable `request_auth({method: "email", email})` tool; a
deterministic `POST /visitor-auth/request` app route for frontend-owned sign-in
forms; verification routes (`GET /visitor-auth/verify?token=<uuid>` and
`POST /visitor-auth/verify`) mounted on `webTransport`; and a per-turn context
block summarizing the active peer's verification state. Verification state is
persisted in `<agent-dir>/data/visitor-auth.db` (token + verified-visitor
tables).

Local testing uses `agentMail.transport: console`, which prints magic links to
stdout. Production email should be configured with:

```bash
auggy augment setup visitorAuth
```

Deploy preflight rejects console magic links on public Railway deploys unless
the operator explicitly acknowledges that links will appear in service logs.

### Key constraint

`visitorAuth.signingKey` and `webTransport.visitorTokens.signingKey` MUST be the same value. If they drift, visitor tokens minted by visitorAuth will fail webTransport's verification on the next request.

### Bundled skill

`visitorAuth` ships `src/augments/visitorAuth/skill/SKILL.md` with model teaching on the `request_auth` tool — when to offer verification, confused-deputy awareness, and rate-limit messaging. Copied into `<agent-dir>/skills/visitorAuth/SKILL.md` at `auggy create`/`auggy augment add` time; install retroactively with `auggy skill add visitorAuth`.

For the full operator reference (config, env vars, security posture, ops commands, troubleshooting), see [docs/19-visitor-auth.md](./19-visitor-auth.md).

### Console/API info

The console dashboard API exposes a **Visitors** block with:

- **KV row** — mail transport, inbox / console mode, public URL, agent binding.
- **Status section** — shows the configured mail transport and warns when console magic links are being used outside a local-only setup.
- **Table** — verified visitors (email, verified-at, revoked) with a per-row `visitor-revoke` action. Revoke uses the email as the rowKey; calls `revokeByEmail` + `addRevokedVisitorId` so the denylist survives `unrevokeAndRotate`.

## `link` — Legacy peer transport (A2A v0.2 preview)

```yaml
# agent.yaml
augments:
  - link

# augments/link/augment.yaml
type: link
config:
  port: 8081
  dbPath: ./link.db
  agentCard:
    id: <agent-uuid>
    name: zip
    description: Front-door agent
    endpointUrl: https://zip.example.org
    capabilities:
      - "answers visitor questions about LORF"
  peers:
    researcher:
      url: https://researcher.example.org
      bearer: ${RESEARCHER_BEARER}
      participantId: <peer-uuid>
      inboundBearer: ${RESEARCHER_INBOUND_BEARER}
      inboundBearerId: <inbound-bearer-uuid>
      purpose: "Research specialist. Knows recent ML literature."
      examples:
        - "What's the state of test-time compute scaling?"
        - "Find recent papers on agent benchmarks"
  outbound:
    allowedTrustLevels: [creator, agent] # default; add public explicitly
    # Required with public: exact receivers verified to enforce signed origin.
    # publicDelegationPeers:
    #   researcher:
    #     url: https://researcher.example.org
    #     participantId: <peer-uuid>
```

### What it is

The legacy preview mesh entry point. It imports the `@auggy/link` library to
expose this agent at an HTTP endpoint using the obsolete A2A v0.2 JSON-RPC
shape, and to send outbound traffic to configured peers. It is not compatible
with current A2A 1.0 clients or cards. Peer-to-peer traffic uses mutual bearer
auth with no central service and binds a separate port from `webTransport`.

`link` remains a legacy preview in the pre-1.0 line. A configured inbound peer
that presents a valid bearer is the authenticated forwarding hop. Auggy-issued
outbound calls add a short-lived HMAC origin assertion bound to the receiver,
content, and idempotency key. The receiver caps the asserted origin at the
forwarding hop's authority. Unsigned legacy traffic is downgraded to public
anonymous rather than receiving agent authority.

### When to use it

Use it only for controlled Auggy-to-Auggy preview evaluation when two or more
agents need to talk to each other. The other agent can be on the same machine,
a different Railway project, or another cloud reachable over HTTPS. Configured
peers are addressed by short name (`researcher`, `analyst`, etc.) in the
LLM-facing tool surface. Do not choose `link` for standards-based A2A
interoperability.

### Tools (2)

- **`link_send(to, text)`** — send a text message to a configured peer. Returns the peer's synchronous reply text (when available) or a task id (when the peer chose async handling).
- **`link_list()`** — enumerate configured peers as `{ peers: [{ name, purpose?, examples? }] }`. The LLM uses this to discover *who* it can reach and *what each peer is good for*. `purpose` and `examples` come from `augments/link/augment.yaml`; both are optional. Beware: bad examples mislead the model more than they help — keep them tight or omit.

Both tools default to `creator` and `agent` turns. To allow a public turn to
delegate while preserving public authority downstream:

```yaml
outbound:
  allowedTrustLevels: [creator, agent, public]
  publicDelegationPeers:
    researcher:
      url: https://researcher.example.org
      participantId: <peer-uuid>
```

The policy is enforced when tools are exposed and again immediately before
network access. Public delegation additionally requires an exact peer-name,
HTTPS endpoint, and participant-id binding in `publicDelegationPeers`. Each
binding is the operator's attestation that that exact receiving agent has been
upgraded and enforces signed delegated-origin provenance; it is never learned
from a peer card or registry. If a registry reassigns a name or endpoint, the
peer disappears from the public roster and sends fail closed. Public turns see
only matching attested peers in `link_list` and the preamble. Missing execution
context fails closed.

### Context block — peer roster

For an allowed turn, the augment surfaces a minimal preamble block listing only
peer **names**:

```
Peers reachable via link_send: researcher, analyst. Call link_list to see what each peer is good for.
```

Names only — not purposes or examples — to keep preamble cost ~10 tokens per peer. Rich details are lazily fetched via `link_list` when the model actually needs to route. Empty peers ⇒ no block emitted.

### Peer fields

| Field | Required | Purpose |
|---|---|---|
| `url` | yes | Peer's link endpoint (`https://...`). For local-only dev, set `LINK_ALLOW_PLAINTEXT=1` to allow `http://localhost`. |
| `bearer` | yes | Bearer this agent sends on outbound to the peer. |
| `participantId` | yes | Peer's UUID. Must match the peer's self-declared id for AddressBook lookup symmetry. |
| `inboundBearer` | yes | Bearer this agent accepts on inbound *from* the peer. Independent of `bearer`; rotate separately. |
| `inboundBearerId` | yes | Opaque audit id paired with `inboundBearer`; logged on verify, never on the wire. |
| `purpose` | no | Natural-language description of what the peer is good for. Surfaced via `link_list`. Semantic, not structural. |
| `examples` | no | 1–2 example asks suitable for delegation. Used by the LLM for few-shot routing. |

### `peerSource` — fetch peers from a registry

For more than a couple of peers, hardcoding `peers` in every agent's yaml becomes painful. The `peerSource` block points the augment at a JSON URL it fetches on boot; the registry serves the org's peer roster as a single source of truth.

```yaml
# agent.yaml
augments:
  - link

# augments/link/augment.yaml
type: link
config:
  port: 8081
  dbPath: ./link.db
  agentCard:
    id: <self-uuid>
    name: zip
    description: Front-door agent
    endpointUrl: https://zip.example.org:8081
  peerSource:
    type: registry
    url: https://lorf-context.up.railway.app/peers.json
    cacheSeconds: 60     # default 60; lower for snappier propagation
    pins:
      frontier:
        url: https://frontier.example.org:8081
        participantId: 54bb9528-05c6-4e2e-a419-62e6e003156c
  # peers: {...}         # optional — fallback if registry is unreachable
```

The registry response shape (the **stable wire contract**):

```json
{
  "peers": [
    {
      "name": "frontier",
      "url": "https://frontier.example.org:8081",
      "participantId": "54bb9528-05c6-4e2e-a419-62e6e003156c",
      "agentCardUrl": "https://frontier.example.org:8081/.well-known/agent.json"
    }
  ]
}
```

Required per entry: `name`, `url`, `participantId`. Optional: `agentCardUrl` (reserved for future capability discovery; not used at v1).

**Discovery separate from authority.** The registry controls whether an
operator-pinned peer is currently present; it cannot introduce a new peer,
change an endpoint, or reassign a participant. Every returned entry must
exactly match `peerSource.pins` or it is skipped. Bearers live in environment
variables on each Auggy, keyed by peer name:

| Env var | What it is |
|---|---|
| `LINK_BEARER_<UPPERCASE_NAME>` | Bearer this agent sends on outbound to the peer |
| `LINK_INBOUND_BEARER_<UPPERCASE_NAME>` | Bearer this agent accepts on inbound *from* the peer |
| `LINK_INBOUND_BEARER_ID_<UPPERCASE_NAME>` | Audit id paired with `inboundBearer`; logged on verify |

Names are uppercased; non-alphanumeric characters become underscores. Peer `data-analyst` → `LINK_BEARER_DATA_ANALYST` etc. Missing bearer for a peer present in the registry → clear actionable error at boot (names which env var is missing).

**Behavior:**
- On boot, the augment fetches `peerSource.url`. On success, peers populate the AddressBook + BearerAuthProvider. On failure, the augment falls back to the inline `peers` block if present, or runs inbound-only if not.
- A periodic refresh (TTL = `cacheSeconds`) propagates presence/removal edits to running agents without a restart. Endpoint or identity changes require an operator config update and restart. Refresh failures preserve the last-good peer state — degradation, not outage.
- Peers absent from a successful refresh are **forgotten**: outbound to that name returns "unknown peer"; inbound from that participant is 401'd. In-flight conversations complete on the bearer they started with — there is no mid-stream eviction.
- **Per-peer error handling:** if a single entry in the registry is invalid (malformed, insecure URL, missing env-var bearer), the augment logs a warning and skips that entry. Other entries — including removals of revoked peers — still apply. This prevents an unrelated misconfiguration from blocking trust revocations.

**Security defaults:**
- `peerSource.url` MUST be `https://`. Plaintext `http://` is rejected at boot. To override for localhost dev, set `LINK_ALLOW_PLAINTEXT=1` (the same env knob the link library uses for plain-HTTP binding).
- Registry-supplied peer URLs (and `agentCardUrl`) MUST be `https://` and must exactly match the operator pin. Plaintext or mismatched entries are skipped—they don't poison the rest of the directory and never receive a bearer. The same `LINK_ALLOW_PLAINTEXT=1` override applies only to the scheme check for localhost development; it does not disable pin matching.
- Registry and outbound peer requests do not follow HTTP redirects. Configure the final exact endpoint; even a same-origin redirect fails closed so bearer credentials and message bodies cannot be replayed to an unreviewed destination.
- Why: the registry is a remote trust boundary. HTTPS authenticates a host but does not authorize it to receive a name-scoped bearer. Exact endpoint and participant pins prevent a compromised or misconfigured registry from redirecting credentials.

**Reliability defaults:**
- Registry fetches have a **10-second timeout** (abortable). A hung registry won't stall agent startup indefinitely.
- The resolver is **single-flight**: concurrent `getPeers()` callers share the same in-flight promise. The refresh timer won't stack concurrent fetches against a slow registry — it joins the existing one.

**Self-filter:** an entry whose `participantId` matches the agent's own `agentCard.id` is dropped from the resolved map. Agents do not call themselves even if the operator forgets to omit them from the registry.

**Forward-compat:** when the coordinator service ships, the registry URL flips to point at the coordinator's `/participants` endpoint. Same JSON contract; no code changes in agents.

The current reference shape above is the authoritative in-repo description for
the preview peer directory.

### AgentCard fields

The `agentCard` block populates the legacy `/.well-known/agent.json` document
served at this agent's link endpoint. This is an obsolete preview shape, not a
current A2A Agent Card. Anyone who can reach the URL can read it — keep
descriptions and `capabilities[]` appropriately vague if you're cross-org.
`capabilities` is a free-form `string[]`: semantic, not structural.

### Trust model and rollout

The bearer authenticates the immediate configured agent; it never proves that
the originating caller was an agent. Auggy therefore signs origin metadata on
each outbound delegation and verifies it before history retrieval or model
execution. Forwarded identities are domain-separated by the receiving Link
instance, audience, authority class, authenticated hop, original subject, and
a signed digest of the complete forwarding path; their thread IDs include the
receiving instance. Different users relayed by one agent—or the same user
arriving through separate paths or Link instances—cannot share a thread or
peer-derived memory identity.

Creator authority is capped to agent when it crosses an agent bearer. Public
anonymous/recognized state remains public. A valid origin assertion is accepted
for at most five minutes and eight hops. Changed audience, body, idempotency
key, origin, or signature is rejected before the kernel runs. Reserved wire
metadata is consumed at the transport boundary and is not shown to the model.

Old sender to new receiver is downgraded to public anonymous. New sender to old
receiver remains wire-compatible for creator/agent callers, but public
delegation is denied unless the operator explicitly attests that the receiver
enforces provenance in `publicDelegationPeers`. Upgrade receivers, verify their
enforcement, and only then add that attestation. Delegated traffic receives new
thread IDs; do not alias old shared history into the new identities.

Existing `peerSource` deployments must add reviewed `pins` for every permitted
registry peer before upgrading. Copy neither values nor endpoints blindly from
the registry being constrained. Public-delegation entries must bind both the
same endpoint and participant id. The parser rejects missing pins and older
participant-id-only public bindings. Endpoint or identity rotation is an
operator configuration change followed by restart, not a registry-only edit.

Operationally, treat each inbound peer bearer like an agent-privilege
credential. Rotate inbound and outbound bearers independently, keep them out of
registries and public metadata documents, and expose the link port only to
configured peers.

### Forward-compat with the coordinator

When a coordinator service ships, the peer list — and per-peer
purpose/examples — can move from `augments/link/augment.yaml` to a participant
registry served by the coordinator. The LLM-facing shape (`link_list`
returning `{name, purpose?, examples?}`) stays the same; only the source
flips. Today's augment-config-described peers are forward-compatible.

### Bundled skill

`link` ships `src/augments/link/skill/SKILL.md` with model teaching on the `link_send` and `link_list` tools: when to delegate (genuinely-different expertise/access) vs answer directly, choosing the right peer from `link_list`, the **probe-on-pushback** pattern (re-ping the peer with the user's clarification instead of refusing on "no visibility into their tools"), synthesis-vs-echo when relaying a peer's reply, failure-mode handling (`unknown peer` / unreachable / refused), and the inbound side (when YOU are the peer being called). Copied into `<agent-dir>/skills/link/SKILL.md` at `auggy create`/`auggy augment add` time; install retroactively with `auggy skill add link`.

## Why these aren't exhaustive

The built-in augments above are the **minimum viable set**. Real agents will mount more — telemetry augments, eval augments, ad-hoc tool augments for domain-specific capabilities. None of those belong in the runtime; they're application-specific.

The line between "ship it built-in" and "user implements" is roughly:
- **Built in:** anything that's a load-bearing reference implementation of a contract Auggy defines (`MemoryProviderSpec`, `TransportSpec`, filesystem access for skills), or infrastructure every public-facing agent needs (budgets, bash defaults, operator alerting).
- **User code:** anything that's domain-specific or where multiple competing implementations make sense.

The augment catalog (Plan 3 CLI) provides a way to publish and consume augments without bundling them into the runtime. Domain augments live there, not here.
