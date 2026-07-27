# 03 — Types

> The shared contract. Every type that crosses a module boundary lives in `src/types.ts` (no runtime code, type definitions only). This doc walks through every group with what each shape is for and what its invariants are.

## Why one types file

Auggy puts every cross-module type in one file by deliberate choice. This is the opposite of "one type per file" or "types-colocated-with-implementation." The reasoning:

1. **Discoverability.** New contributors can read the entire type contract in one sitting. There is exactly one file to grep.
2. **Coherence.** Types that need to be consistent (e.g. `KernelEvent`, `AGUIEvent`, and the `translateKernelEvent` function) are easier to keep in sync when they're visually adjacent.
3. **No circular imports.** Modules import types from one place; runtime modules import from each other. Type-only imports are erased at compile time, so this also costs nothing at runtime.

The trade-off is that `types.ts` is large (~450 LOC). It is structured into clearly labeled sections (`// === Section Name ===`) so it can be navigated by section.

## Section 1 — Context

The vocabulary that augments use to contribute information to the model.

```ts
export type ContextPlacement = "system" | "preamble" | "assistant-preamble";
export type ContextProvenance = "identity" | "memory" | "retrieval" | "augment";
export type ContextPriority = "required" | "high" | "normal" | "low" | "evictable";
export type EvictionPolicy = "never" | "summarize" | "drop";
export type ContextOrigin = "operator" | "system" | "agent" | "agent-derived" | "peer-derived";

export interface ContextBlock {
  source: string;          // augment name, used in trace/evictions; not shown to the model
  content: string;
  placement: ContextPlacement;
  provenance: ContextProvenance;
  priority: ContextPriority;
  eviction: EvictionPolicy;
  origin: ContextOrigin;
  ttl?: "turn" | "session" | "persistent";
  visibility?: "public" | "pipeline-only";
  tokenCount?: number;     // populated by allocator if missing
}
```

**`placement`** decides which array of the `AssembledPrompt` the block ends up in:
- `"system"` → joined into `systemBlocks` (sent as system prompt)
- `"preamble"` → joined into `contextBlocks` (sent as part of the user-side context wrapper)
- `"assistant-preamble"` → joined into `assistantPreamble` (assistant-side priming, used for things like personality reinforcement)

**`provenance`** is purely informational; it's recorded in the trace and helps with debugging and policy decisions but the kernel doesn't switch on it.

**`priority`** determines eviction order when the context budget is exceeded. The allocator sorts blocks by priority (`required` first, `evictable` last) and includes blocks until the budget runs out. Blocks past the budget go into `evictions` for the trace.

**`origin`** is the trust marker. Five values:
- `operator` — block was authored by the operator (e.g. `identity.md`). Preamble-safe.
- `system` — block was produced by system-authored machinery (e.g. a deterministic context augment). Preamble-safe.
- `agent` — direct agent-side writes reserved for system-internal agent output.
- `agent-derived` — block contains an extracted or paraphrased observation produced by the agent during earlier turns (e.g. auto-saved episodic memory). Rendered with an `[AGENT-DERIVED]` marker and preamble rule 7 instructs the model to treat these as observations, not instructions.
- `peer-derived` — block contains content influenced by an external peer (e.g. an episodic entry created from a visitor message). Rendered with a `[PEER-DERIVED]` marker and preamble rule 6 warns the model about adversarial input.

**This is load-bearing for security:** an augment that mishandles the `origin` field can leak adversarial or self-authored content into a position the model treats as authoritative. Mutable memory sources should use `origin: agent-derived` or `origin: peer-derived` with a non-system placement so a successful prompt injection can't elevate to durable system-level context on future turns.

**Naming note (A2A future):** `origin: "agent"` means "this agent wrote it"
(self-authored). A future A2A transport must define peer-agent provenance
without conflating it with this self-authored origin.

**`visibility: "pipeline-only"`** means the block is computed for downstream augments via `priorContext` but never sent to the model. Use case: an augment that runs an LLM-based filter on the user's input and contributes both the filter result (pipeline-only) and a sanitized version (public).

**`tokenCount`** is optional. If absent, the allocator computes it via the tokenizer. Augments can pre-compute it if they have a faster path.

## Section 2 — A2A-inspired content (`Part`)

Content is polymorphic. This internal union was inspired by an earlier A2A
shape; it is not itself a current A2A wire contract:

```ts
export type Part =
  | { kind: "text"; text: string }
  | { kind: "file"; uri: string; mimeType?: string; name?: string }
  | { kind: "data"; data: Record<string, unknown> };
```

Every `InboundMessage`, `OutboundMessage`, and (in `KernelEvent`) `text_message` carries content as `Part[]`, not `string`. v1 only really uses `kind: "text"` end to end, but the type space is open so file and data parts can land in v2 without a breaking change.

Helpers for working with parts live in `src/parts.ts`:
- `extractText(parts)` — joins all `text` parts and JSON-stringifies all `data` parts (file parts are dropped from the text rendering).
- `textPart(text)` and `dataPart(data)` — constructors.

## Section 3 — Task lifecycle

```ts
export type TaskState =
  | "working"
  | "input-required"
  | "auth-required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected";
```

This internal state set was inspired by A2A task states. v1 only ever produces
`completed`, `failed`, `canceled`, and `rejected` — but the type space exists so
transports that need to expose `input-required` (approval gates) or
`auth-required` (credential prompts) can do so without a type change. A future
A2A transport must translate against the then-current protocol explicitly.

`TurnResult.status` is one of these values. `KernelEvent { kind: "run_finished" }` carries one too.

## Section 4 — Memory provider contract

```ts
export interface MemoryDefaults {
  mutable: boolean;
  origin: ContextOrigin;
  priority: ContextPriority;
  placement: ContextPlacement;
  eviction: EvictionPolicy;
  ttl?: "turn" | "session" | "persistent";
}

export interface MemoryEntry {
  label: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface StaticMemoryProvider {
  owns: { kind: "static"; labels: string[] };
  defaults: MemoryDefaults;
  read: (label: string) => Promise<MemoryEntry | null>;
  write?: (label: string, content: string) => Promise<void>;
}

export interface NamespaceMemoryProvider {
  owns: { kind: "namespace"; prefix: string };
  defaults: MemoryDefaults;
  search: (query: string) => Promise<MemoryEntry[]>;
  write?: (label: string, content: string) => Promise<void>;
  read?: (label: string) => Promise<MemoryEntry | null>;
  list?: () => Promise<string[]>;
}

export type MemoryProviderSpec = StaticMemoryProvider | NamespaceMemoryProvider;
```

The discriminator is `owns.kind`. Two flavors:

**Static providers** declare a fixed list of labels they own. `read(label)` is mandatory. `write(label, content)` is optional and only present when the provider is mutable. Used for content that has a known, finite set of named slots — identity files, configuration, pinned notes.

**Namespace providers** declare a prefix string. They own every label that starts with that prefix. `search(query)` is mandatory; `read`, `write`, and `list` are optional. Used for content with an open-ended label space — episodic memories, message history, retrieved documents.

`MemoryDefaults` are the values used by `synthesizeContextFor` when wrapping retrieved entries into `ContextBlock`s. Setting `mutable: true` here means "this provider supports writes via `write`," not "the provider's memory is *somehow* mutable" — it gates whether the synthetic `memory_write` tool can target labels owned by this provider.

See [05-memory-subsystem.md](./05-memory-subsystem.md) for how the registry
enforces uniqueness across providers and how `memory_read`, `memory_write`,
`memory_search`, `memory_list`, and `memory_forget` route to the right provider
at runtime.

## Section 5 — Tools

```ts
export type ToolCategory = "memory" | "search" | "communication" | "meta" | (string & {});

export interface Tool<TInput = any> {
  name: string;
  description: string;
  category: ToolCategory;
  input: z.ZodType<TInput, any, any>;
  inputJsonSchema?: Record<string, unknown>;
  execute: (
    input: TInput,
    context?: ToolExecuteContext,
  ) => Promise<string | ToolResult>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  outcomeUnknown?: boolean;
  terminate?: {
    status: "input-required" | "completed";
    message?: string;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
```

`Tool` is the augment-author-facing type — what you write when you
`defineTool({...})`. Its execution context carries the resolved peer, thread,
authorization claims, and the request/deadline cancellation signal. A plain
string becomes model-visible tool content. `ToolResult` can additionally mark
an expected error, request one of the two augment-controlled terminal states,
or set `outcomeUnknown` after a side effect began without a trustworthy
result. The kernel terminates an outcome-unknown turn before another inference;
it never asks the model to decide whether retry is safe.

`ToolDefinition` is the model-facing type — what gets sent to the model in the tools array. The kernel converts `Tool[]` → `ToolDefinition[]` via `selectTools()` in `src/kernel/tool-selector.ts`.

The `(string & {})` trick on `ToolCategory` is a TypeScript pattern for "give autocomplete on these strings, but accept any string." It lets users add their own categories without losing the type-narrowing benefit on the canonical four.

`inputJsonSchema?` is an optional pre-computed JSON schema. If absent, the kernel uses `{}` (which works for tools without parameters). v1 doesn't auto-derive JSON schema from Zod; users either pre-compute it or accept the empty fallback.

## Section 6 — Peer identity & trust

```ts
export type PeerKind = "human" | "agent" | "system" | "anonymous";
export type TrustLevel = "creator" | "agent" | "public";

export interface PeerIdentity {
  id: string;
  kind: PeerKind;
  trustLevel: TrustLevel;
  publicSubstate?: "anonymous" | "recognized";  // set iff trustLevel === "public"
  authenticatedPriorPeerId?: string; // verified one-way identity transition
  delegatedOrigin?: {
    subject: string;       // original subject, not used directly as local peer.id
    sourceAugment: string; // transport that first resolved the subject
    viaPeerId: string;     // authenticated immediate forwarding peer
    hopCount: number;
  };
  sourceAugment: string;     // which augment minted this identity
  displayName?: string;
  orgId?: string;
}
```

This is the current runtime trust contract. Product roadmap work is expected to
grow a more granular authority model around principals, operators, staff,
channel bindings, webhooks, and permission modes. That future model should
compile down to deterministic runtime policy; it should not make the model
responsible for deciding who a peer is or what they can do.

The product model has four resolved caller categories:

- `public` + `anonymous` — no durable caller identity yet.
- `public` + `recognized` — a known public/app caller with a stable visitor id.
- `creator` — the operator/developer of this Auggy instance.
- `agent` — an admitted machine or agent peer.

Trust levels are ordered from most to least:
- **`creator`** — the deployer of this specific agent. Bypasses budgets and all per-trust-level constraints. Null peer (internal/scheduled trigger) is treated as `creator`.
- **`agent`** — a machine the creator has admitted (via shared-secret in `access.agents`). High trust.
- **`public`** — everyone else. Inputs from `public` peers should be treated as potentially adversarial.

**`publicSubstate`** differentiates two sub-populations within `public` trust:
- `"anonymous"` — no verified visitor token; web callers receive a signed
  anonymous-session capability whose server-minted subject becomes `peer.id`.
  It is not derived from caller-controlled `threadId`.
- `"recognized"` — a valid HMAC visitor token was verified; durable identity (peer.id is `vis_*` from the token). Memory writes attach to this durable ID across sessions.

The generic web transport never exchanges a missing or invalid visitor token
for recognized authority. Anonymous callers receive only a signed
anonymous-session capability; recognized tokens come from `visitorAuth` or
another explicitly trusted minter.

`publicSubstate` is present **only** when `trustLevel === "public"`. Other trust levels must omit it. The budgets augment uses `publicSubstate` to apply differentiated caps (tighter defaults for anonymous, looser for recognized).

`authenticatedPriorPeerId` is authorization evidence for a one-way identity
transition, such as a recognized visitor proving ownership of its earlier
anonymous-session subject. A transport may set it only after
cryptographically verifying that relationship. It is not caller metadata,
must not be copied from headers or model output, and is deliberately omitted
from logs and model-visible identity context. The kernel uses it only to
authorize promotion of already-bound thread and memory state; it never permits
a recognized-to-anonymous downgrade.

`delegatedOrigin` is authenticated transport evidence for an identity relayed
across a delegation boundary. The receiving transport mints a namespaced local
`peer.id`; peer-derived storage never indexes directly by the asserted subject.
Only a transport that verifies the delegation envelope may set this field.
Link uses it to preserve the original subject/source and bounded hop count
while capping trust to the authenticated forwarding peer.

Route auth contexts also expose `auth.principal.kind`. That field is a
TypeScript discriminator for the concrete identity payload (`anonymous`,
`visitor`, `creator`, or `agent`). It is not a second permission system. Use
`trustLevel`, `publicSubstate`, and route/tool `requires` rules to decide what a
caller may do.

The kernel never assigns trust levels — only transports do, in their `identify()` function. The kernel reads `trustLevel` to build the system preamble (which warns the model about public peers) and to mark `peer-derived` context blocks.

`sourceAugment` records which augment minted the identity. This is used in the trace and in `OutboundMessage.targetAugment` (for routing responses back to the right transport when multiple transports are mounted).

## Section 7 — Turns

```ts
export type TurnTriggerType = "message" | "scheduled" | "event" | "continuation";

export interface InboundMessage {
  parts: Part[];
  sourceAugment: string;
  peer: PeerIdentity | null;
  timestamp: number;
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export interface TurnTrigger {
  type: TurnTriggerType;
  turnId: string;
  threadId?: string;
  contextId?: string;
  taskId?: string;
  timestamp: number;
  source?: string;
  peer?: PeerIdentity | null;
  payload: InboundMessage | Record<string, unknown>;
}
```

`TurnTrigger` is the only thing the kernel accepts as input. Everything else (HTTP requests, scheduled jobs, internal events) gets translated into a `TurnTrigger` by the augment that originated it.

**`type`** discriminates the payload shape:
- `"message"` — `payload` is an `InboundMessage`. The user is talking to the agent.
- `"scheduled"` — `payload` is a generic record. A timer fired.
- `"event"` — `payload` is a generic record. Something happened externally that the agent should react to.
- `"continuation"` — `payload` is a generic record. The agent is resuming a task it was working on.

**`turnId`** is per-turn (one round-trip with the model loop). **`threadId`** is per-conversation (many turns share a thread). **`contextId`** and **`taskId`** are A2A-shaped grouping IDs that survive across turns and threads — they're optional in v1 but reserved for future use.

```ts
export interface TurnState {
  turnId: string;
  threadId: string;
  trigger: TurnTrigger;
  peer: PeerIdentity | null;
  toolCallsSoFar: number;
  turnStartedAt: number;
  metadata: Record<string, unknown>;
}
```

`TurnState` is the read-only view of the turn that augments see in their `context()` and `onTurnStart()` hooks. `metadata` is a scratchpad — augments can stash data here that other augments downstream can read.

```ts
export interface OutboundMessage {
  parts: Part[];
  targetAugment?: string;     // which transport to send through (defaults to inbound source)
  targetPeer?: string;
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolCallRecord {
  name: string;
  input: unknown;
  output: string;
  durationMs: number;
}

export interface TurnResult {
  turnId: string;
  success: boolean;
  status: TaskState;
  response?: OutboundMessage;
  responses?: OutboundMessage[];     // for multi-destination dispatch
  errorResponse?: string;
  toolCalls: ToolCallRecord[];
  trace: TurnTrace;
  error?: { message: string; source: string };
  outcomeUnknown?: boolean;
  rejection?: { reason: TurnRejectionReason; retryAfterMs?: number };
}
```

`TurnResult` is what comes back from `kernel.handleInbound()`. The presence of both `response` (singular) and `responses` (plural) supports both the simple case (one reply to the source) and the multi-destination case (e.g. an agent that broadcasts to multiple peers).

`status` and `success` are redundant for the common case (`status === "completed"` ↔ `success === true`) but `status` carries additional information (`canceled`, `rejected`, `failed`) that `success` can't.

**`errorClass`** is set on `status: "rejected"` results to help transports map to the right HTTP status. Values:
- `"cap-denied"` — a turn gate denied admission (over budget). Maps to HTTP 429.
- `"admission-state-failed"` — confirm phase threw (storage issue). Maps to HTTP 5xx.
- `"engine-error"` — the engine call itself threw. Maps to HTTP 5xx.
- Other strings — HTTP 5xx fallback.

`rejection` describes scheduler admission failures such as peer rate limit,
thread/source/agent capacity, runtime shutdown, quarantine, causal-depth, or
overlapping causal-child limits. No prompt or peer data is included.
`outcomeUnknown: true` means work crossed a side-effect boundary without a
trustworthy terminal result; the agent quarantines that thread before
releasing its lane.

Optional for backward compatibility; older rejection sites may omit it.

## Section 7b — Turn gate (admission 2PC)

The turn-gate contract gives augments a structured way to admit or reject a turn **before** the engine is called, with full atomicity guarantees.

```ts
export interface TurnGateProvider {
  prepare(args: {
    turnId: string;
    peer: PeerIdentity | null;
    threadId: string;
    trigger: TurnTrigger;
  }): Promise<TurnGateTicket>;

  commit?(args: {
    turnId: string;
    peer: PeerIdentity | null;
    threadId: string;
    cost: CostResult;
  }): Promise<void>;
}

export interface TurnGateTicket {
  decision: { allow: true } | { allow: false; reason: string };
  confirm(): Promise<void>;   // idempotent
  rollback(): Promise<void>;  // idempotent
}
```

**The 2PC contract:**

1. `prepare(args)` — the gate opens a transaction, evaluates caps against current state, stages reservation rows inside the transaction, and returns a ticket. The ticket carries the decision and owns the open transaction.
2. The kernel evaluates all decisions conjunctively. Any `allow: false` → rollback all tickets → reject with `errorClass: "cap-denied"`. No engine call.
3. All `allow: true` → `confirm()` each ticket in order. Any confirm throw → rollback all → reject with `errorClass: "admission-state-failed"`. No engine call.
4. Engine call proceeds.
5. After the engine returns, `commit(args)` is called on each gate that defines it, passing the `CostResult`. A commit error makes the completed inference outcome-unknown; the kernel withholds a successful terminal result and does not automatically retry it.

**v0 scope:** first-party only. The budgets augment is the sole shipped implementation. The kernel cannot mechanically prevent third-party augments from violating the prepare-then-confirm contract (e.g. writing outside the transaction). Third-party turn-gate augments are out of scope until the contract has real-world miles.

## Section 7c — CostResult discriminated union

```ts
export type CostResult =
  | { priced: true; costUsd: number }
  | { priced: false; reason: string };
```

Engines produce a `CostResult` for each inference step. The discriminated union forces callers to handle the unpriced case explicitly — when a model has no pricing table, or when the adapter can't compute cost, the result is `{ priced: false, reason: "..." }` rather than a silent zero.

Per-provider pricing modules live in `src/engines/<provider>/pricing.ts`. The budgets augment's `commit()` receives the aggregate `CostResult` across all inference steps in the turn; if `priced: false`, it marks the reservation as unpriced but still records the turn (so turn-count caps still apply).

## Section 8 — Kernel events

```ts
export type KernelEvent =
  | { kind: "run_started"; turnId; threadId; contextId?; taskId? }
  | { kind: "tool_call_started"; turnId; toolCallId; toolName; augmentName }
  | { kind: "tool_call_args"; turnId; toolCallId; args: Record<string, unknown> }
  | { kind: "tool_call_result"; turnId; toolCallId; output; isError }
  | { kind: "text_message"; turnId; messageId; role: "assistant"; text }
  | { kind: "run_finished"; turnId; status: TaskState }
  | { kind: "run_error"; turnId; message; source };

export type KernelEventHandler = (event: KernelEvent) => void;
```

This is the **internal** event vocabulary. The kernel emits these via the `onEvent` callback that transports pass into `handleInbound`. Transports translate them into their wire protocol (e.g. AG-UI events for the web transport).

The kernel never speaks AG-UI directly. It only speaks `KernelEvent`. This is what makes it possible to have multiple transports (web/AG-UI, future spine/A2A, future MCP) without coupling the kernel to any specific protocol.

The translator from `KernelEvent` to AG-UI lives in `src/transports/ag-ui-events.ts` (`translateKernelEvent`). It's a switch statement with one case per `kind`.

## Section 9 — Messages and history

```ts
export type MessageRole = "user" | "assistant" | "tool_use" | "tool_result";

export interface Message {
  id: string;
  role: MessageRole;
  peerId?: string;
  toolCallId?: string;       // matches tool_use to tool_result
  content: string;
  timestamp: number;
  tokenCount: number;
}
```

`Message` is the type used inside the `HistoryManager`. Note that `tool_use` and `tool_result` are separate roles (not modeled as Anthropic's nested content blocks) — this keeps the history a flat list and lets the manager track them as ordered atomic pairs.

`tokenCount` is mandatory because the history manager needs to know it without reading content (cumulative budget tracking).

## Section 10 — Model interface

```ts
export interface AssembledPrompt {
  systemBlocks: string[];
  contextBlocks: string[];
  assistantPreamble?: string[];
  messages: Message[];
  tools: ToolDefinition[];
  totalTokens: number;
  evictions: { source: string; priority: ContextPriority; reason: string }[];
}

export interface ModelResponse {
  content: string;
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  inputTokens: number;
  outputTokens: number;
  finishReason: "end_turn" | "tool_use" | "max_tokens";
}

export interface ModelClient {
  complete(
    prompt: AssembledPrompt,
    opts?: { onDelta?: (delta: ModelDelta) => void; signal?: AbortSignal },
  ): Promise<ModelResponse>;
  countTokens(text: string): number;
  maxContextTokens: number;
}
```

`ModelClient` is the only thing the kernel needs to know about the LLM. It's a three-method interface: `complete()`, `countTokens()`, and `maxContextTokens` (a number).

Provider adapters and custom clients must stop work promptly when
`opts.signal` aborts and must not emit more deltas afterward. The kernel fences
late results, but repeatedly ignoring cancellation opens a bounded fail-closed
provider circuit and requires process replacement if those promises never
settle.

This is intentionally not a "chat completions" interface or a "messages API" interface — it's the *kernel's* interface. The adapter for any specific provider (Anthropic, OpenAI, etc.) is responsible for translating between `AssembledPrompt` and the provider's request shape, and between the provider's response shape and `ModelResponse`.

`AssembledPrompt` is produced by `context-allocator.ts`. The allocator splits the context into three placement buckets (`systemBlocks`, `contextBlocks`, `assistantPreamble`) so the adapter can decide how to serialize them — e.g. an Anthropic adapter would join `systemBlocks` into the `system` field, prepend `contextBlocks` to the first user message, and use `assistantPreamble` to seed the assistant turn.

`evictions` is an audit trail — what was dropped, why. The trace emitter writes it to the trace.

## Section 11 — Storage

```ts
export interface Storage {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
```

A minimal KV interface that the history manager uses for `save()` and `restore()`. There is no built-in `Storage` implementation in v1 — it's defined so augments can plug in whatever backend (filesystem, Redis, SQLite, Supabase) without touching the kernel.

## Section 12 — Agent Card (legacy Auggy metadata)

```ts
export interface AgentCardProvider {
  name: string;
  version?: string;
  contact?: string;
}

export interface AgentCardCapabilities {
  streaming: boolean;
  pushNotifications: boolean;
  memory: boolean;
  transport: boolean;
}

export interface AgentCardSkill {
  name: string;
  description: string;
  category: string;
}

export interface AgentCard {
  provider: AgentCardProvider;
  purpose?: string;
  capabilities: AgentCardCapabilities;
  skills?: AgentCardSkill[];
  interfaces: string[];
  extensions: Record<string, unknown> & {
    auggy?: {
      tools: {
        name: string;
        description: string;
        category: string;
      }[];
    };
  };
}
```

This `AgentCard` is the legacy Auggy metadata document served at
`/.well-known/agent-card.json`. It is useful for internal inspection, but it
does not conform to the current A2A 1.0 Agent Card schema and should not be used
as an interoperability contract.

In v1:
- `provider.name` = the `name` from `AgentConfig`
- `purpose` = the `purpose` from `AgentConfig`
- `capabilities.streaming` = `false` (true once token streaming lands)
- `capabilities.pushNotifications` = `false` (reserved for the future webhook augment)
- `capabilities.memory` = `true` if any augment has a `memory` field
- `capabilities.transport` = `true` if any augment has a `transport` field
- `skills` = tool-derived entries from every configured augment
- `interfaces` = `["HTTP+JSON"]` (will grow as more transports land)
- `extensions.auggy.tools` = reserved internal extension field (currently empty
  in generated cards)

The card is built once at `defineAgent` time from the *effective* config (after
`wireMemoryBus` adds the synthetic `memory-bus` augment), so generic memory
tools and other model-facing tools can appear in `skills`. Enabling public
legacy discovery therefore requires an explicit content review; the generator
does not provide a sanitized public-capability boundary.

## Section 13 — Transport contract

```ts
export interface TransportKernel {
  handleInbound(
    trigger: TurnTrigger,
    options?: { onEvent?: KernelEventHandler },
  ): Promise<TurnResult>;
  onOutbound(
    callback: (peer: PeerIdentity, message: OutboundMessage) => Promise<void>,
  ): void;
  getAgentCard(): AgentCard;
}

export interface TransportSpec {
  register(kernel: TransportKernel): Promise<void>;
  identify(raw: unknown): PeerIdentity | null;
  concurrency?: number;
  maxQueueDepth?: number;
  rateLimitPerPeer?: { maxPerMinute: number };
}
```

`TransportSpec` is what an augment puts on its `transport` field. The runtime calls `register(kernel)` once at boot, passing in a `TransportKernel` that the augment can use to feed inbound triggers and listen for outbound messages.

`identify(raw)` is a pure function from "whatever the transport's wire format hands you" to `PeerIdentity | null`. The web transport implements it by reading `x-peer-*` headers; a future spine transport would read auth tokens from a different envelope.

`concurrency`, `maxQueueDepth`, and `rateLimitPerPeer` are source-specific
policies enforced by the agent-wide keyed scheduler. They do not create an
independent queue. `maxQueueDepth` counts waiting work from that source;
`concurrency` limits its active work. Defaults are `1`, `50`, and none for a
generic transport; the built-in web transport defaults its source concurrency
to `4`.

## Section 14 — Augment

```ts
export interface AugmentConstraints {
  maxToolCallsPerTurn?: number;
  requiresHumanApproval?: string[];
  approvalPolicy?: "block-and-queue" | "skip" | "fail";
  neverExpose?: string[];
  contextTimeoutMs?: number;
  toolTimeoutMs?: number;
  perTrustLevel?: Partial<
    Record<
      TrustLevel,
      {
        neverExpose?: string[];
        requiresHumanApproval?: string[];
      }
    >
  >;
}

export interface Augment {
  name: string;
  version?: string;
  required?: boolean;
  context?: (turn: TurnState, priorContext?: ContextBlock[]) =>
    Promise<ContextBlock[] | string>;
  receivesPriorContext?: boolean;
  tools?: Tool[];
  transport?: TransportSpec;
  memory?: MemoryProviderSpec;
  constraints?: AugmentConstraints;
  onBoot?: () => Promise<void>;
  onShutdown?: (signal?: AbortSignal) => Promise<void>;
  onTurnStart?: (turn: TurnState) => Promise<void>;
  onTurnEnd?: (turn: TurnResult, context?: TurnLifecycleContext) => Promise<void>;
  scheduleAfterTurn?: (result: TurnResult, ctx: SchedulerContext) => Promise<void>;
  onIdle?: () => Promise<void>;
}
```

This is the **single most important type in the entire framework.** Everything else exists to support this shape. An augment is anything you can put on this interface; the runtime only knows how to call these methods.

**`name`** is required. Used in traces, error messages, agent-card metadata,
and capability table per-augment limits. Augment names are not rendered into
model-facing context blocks.

**`required: true`** means: if this augment's `context()` or `onTurnStart()` throws, abort the entire turn and return a `failed` result. Without `required`, augment failures are logged and skipped.

An augment's runtime surfaces are defined by the concrete fields it provides.
Tools, context, transports, memory, and lifecycle hooks need no duplicate
capability declaration. Legacy Auggy runtime metadata is likewise derived from
the mounted augment structure; it is not a sanitized A2A discovery contract.

**`context()`** is the augment's contribution to the prompt. Returns either an array of `ContextBlock`s or a single string (which gets wrapped as a default-priority block).

**`receivesPriorContext: true`** opts the augment into seeing the context blocks from previous augments in the pipeline. Used by augments that summarize, deduplicate, or react to other augments' contributions.

**`tools`** is the array of tools this augment provides. The capability table maps each tool back to its owning augment for per-augment enforcement.

**`transport`** is the `TransportSpec` (above). At start time an augment with a
transport registers its trusted source policy with the agent-wide keyed
scheduler and receives a `TransportKernel` that submits through that shared
boundary.

**`memory`** is the `MemoryProviderSpec` (above). The memory bus scans for these and wires them up.

**`constraints`** are policy declarations:
- `maxToolCallsPerTurn` — per-augment cap (default 5; the synthetic `memory-bus` augment overrides this to 20 to match its budget)
- `requiresHumanApproval` — list of tool names that need operator approval before executing (v1: tools matching this skip with a "needs approval" error)
- `approvalPolicy` — what to do when a tool needs approval (v1: always `skip`)
- `neverExpose` — tools the capability table will never let the model see (global; applies to every peer trust level)
- `contextTimeoutMs` — wraps `context()` in `withTimeout` (default 5000ms) and passes the combined request/deadline signal in `TurnState.signal`
- `toolTimeoutMs` — wraps each `execute()` in `withTimeout` (default 30000ms) and passes the combined signal in `ToolExecuteContext.signal`
- `perTrustLevel` — per-trust-level additive constraints (Layer 1). Keyed by `TrustLevel` (`creator` / `agent` / `public`), each level can specify its own `neverExpose` and `requiresHumanApproval` lists. These apply only to peers at that level; top-level `neverExpose` still applies to everyone (no escape). Null peer (internal/scheduled triggers) is treated as `creator`. Example: `perTrustLevel: { public: { neverExpose: ["fs_remove"] } }` hides `fs_remove` from public peers but keeps it visible to agent and creator.

**`turnGate`** is an optional `TurnGateProvider`. Augments that set this field participate in the kernel's pre-dispatch admission 2PC. The kernel calls `prepare` before running any augment context or the engine; the gate can deny the turn or commit a reservation. See Section 7b for the full contract. v0: only the built-in budgets augment ships a turn gate.

**Lifecycle hooks:**
- `onBoot` — called once at `agent.start()`. Failures throw and abort startup.
- `onShutdown` — called once at `agent.stop()`, in reverse order, with a 5s timeout signal. Failures swallowed.
- `onTurnStart` — called at the beginning of every turn, before context assembly. Failures on required augments abort the turn.
- `onTurnEnd` — called after every turn with the caller signal. Hooks run sequentially; failures are logged and swallowed.
- `scheduleAfterTurn` — called sequentially after `onTurnEnd`; its owned causal
  injections and descendants complete inside the current keyed lane.
- `onIdle` — called by the lifecycle manager's idle timer (5min default). Used by augments that do background work like consolidation.

## Section 15 — Agent config and handle

```ts
export type CompactionStrategy = "summarize" | "truncate" | "sliding-window";

export interface AgentConfig {
  name: string;
  displayName?: string;
  creator?: {
    displayName?: string;  // cosmetic; credentials still prove creator trust
  };
  purpose?: string;
  model: string;
  augments: Augment[];
  contextBudget?: {
    historyPercent?: number;        // default 40
    toolSchemaPercent?: number;     // default 10
  };
  compactionStrategy?: CompactionStrategy;  // default "truncate"
  responseLimits?: Partial<ModelResponseLimits>;
  providerRequestTimeoutMs?: number; // default 120000, maximum 600000
  turnScheduling?: Partial<{
    maxConcurrent: number;       // process-local, default 4
    maxQueued: number;           // process-local, default 100
    maxQueuedPerThread: number;  // process-local, default 20
    maxCausalDepth: number;      // default 8
  }>;
  coordination?: {
    mode: "postgres";
    namespace: string;
    urlEnv: string;
    fleetCapacity: {
      maxConcurrent: number;
      maxQueued: number;
      maxQueuedPerThread: number;
    };
    retention: {
      terminalRequestRetentionMs: number;
      maxTerminalRequests: number;
      eventRetentionMs: number;
      maxEvents: number;
    };
    result: {
      maxReplayBytes: number;
    };
    turnState: {
      history: {
        maxSnapshotBytes: number;
        maxMessages: number;
        maxThreads: number;
      };
      maxCostMarkersPerTurn: number;
      outbox: {
        maxIntentsPerTurn: number;
        maxIntentBytes: number;
        maxPendingIntents: number;
      };
    };
    leaseDurationMs: number;
    heartbeatIntervalMs: number;
    claimPollMs: number;
    maxWaitMs: number;
  };
}

export interface AgentHealth {
  status: "healthy" | "degraded" | "unhealthy";
  agent: string;
  uptime: number;
  augments: Record<string, { status: "ok" | "degraded" | "failed"; error?: string }>;
  model: { reachable: boolean };
  scheduler: TurnSchedulerSnapshot;
}

export interface AgentHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  ready(): Promise<void>;
  health(): AgentHealth;
  card(): AgentCard;
  inject(trigger: TurnTrigger, options?: { signal?: AbortSignal }): Promise<TurnResult>;
  recoverThread(threadId: string): boolean;
}
```

`AgentConfig` is what users pass to `defineAgent`. The `model: string` field is just a label that ends up in traces — the actual model client is passed as the second argument to `defineAgent(config, model)`.

`responseLimits` is a mandatory kernel boundary with finite defaults, even
when the field is omitted. One inference is limited to 1 MiB of UTF-8 text, 32
tool calls, 256-byte tool names, 64 KiB per tool argument object, 256 KiB of
arguments in aggregate, depth 32, 10,000 nodes per argument object, 2 MiB
across the retained response, and 10,000 streamed text events. The kernel
validates the completed response before it can dispatch any returned tool.
Streaming adapters also apply the cumulative text/event checks before
forwarding deltas where their transport permits early cancellation. A
violation rejects the whole model response with a stable sanitized error;
Auggy never executes a valid-looking prefix of an oversized response.

`providerRequestTimeoutMs` bounds one model inference across connection,
stream setup, streaming, and response materialization. It defaults to 120
seconds and cannot exceed ten minutes. Model POSTs have one attempt: Auggy does
not retry ambiguous connection, timeout, 408/409/429, or 5xx failures without a
provider idempotency contract. A deadline is outcome-unknown, fences every late
provider event/result, and releases process capacity without allowing late
tool execution. See [29-provider-resilience.md](./29-provider-resilience.md).

`AgentHandle` is what `defineAgent` returns. The methods are explained in [08-agent-lifecycle.md](./08-agent-lifecycle.md).

`turnScheduling` is a finite process-local boundary. `maxConcurrent` limits
complete active turn pipelines across every transport and injection path.
`maxQueued` is the total waiting budget; `maxQueuedPerThread` prevents one hot
conversation from consuming it. `maxCausalDepth` bounds nested same-thread
`SchedulerContext.inject()` work. Queue settings may be zero; active and causal
limits must be positive safe integers.

`coordination.fleetCapacity` is a separate, required declaration for the
preview distributed coordinator. Its limits apply once to the logical agent fleet and
must never be multiplied by replica count or derived from `turnScheduling`.
Declaring coordination remains fail-closed until the shared-store and fencing
preflight is complete; it does not enable replicas by itself.
The required `retention` policy bounds terminal requests and audit events by
both age and count. It never authorizes pruning queued, active, or
outcome-unknown work. `result.maxReplayBytes` bounds one sanitized serialized
replay result by UTF-8 bytes; a result outside that envelope must remain a
terminal non-replayable outcome and must never authorize duplicate execution.
The required `turnState` policy bounds the coordinator-owned history snapshot,
messages and thread count, exact-known inference cost markers, and staged
outbox intents. These values are immutable namespace compatibility inputs.
Checkpoint commits apply history, sanitized replay, cost markers, outbox
intents, and the terminal request state atomically under the current attempt
and fence. Staged outbox rows are not delivered until the transactional
delivery checkpoint is implemented, and public replica startup remains
disabled.

`inject()` lets trusted non-transport code feed a trigger into the same
agent-wide scheduler used by transports. It no longer bypasses concurrency or
queue bounds. Callers may supply an abort signal; cancellation while queued
removes the item before any persistence or model work.

`recoverThread()` is a trusted host API. It clears a fail-closed scheduler
quarantine only after an operator has reconciled an outcome-unknown external
side effect. It is never exposed to the model or inferred from model output.

## How the type sections relate

```
                ┌────────────────────────────────┐
                │           Augment              │
                │  (the central interface)       │
                └──┬─────────────┬───────────────┘
                   │             │
        ┌──────────┘             └────────────┐
        ▼                                     ▼
┌──────────────────┐                ┌──────────────────┐
│  TransportSpec   │                │ MemoryProviderSpec│
└──────────────────┘                └──────────────────┘
        │                                     │
        ▼                                     ▼
┌──────────────────┐                ┌──────────────────┐
│ PeerIdentity     │                │  MemoryEntry     │
│ TurnTrigger      │                │  MemoryDefaults  │
│ TurnResult       │                └──────────────────┘
└──────────────────┘                          │
        │                                     ▼
        ▼                            ┌──────────────────┐
┌──────────────────┐                  │   ContextBlock   │
│  KernelEvent     │                  └──────────────────┘
│ KernelEventHdlr  │                          │
└──────────────────┘                          ▼
                                     ┌──────────────────┐
                                     │ AssembledPrompt  │
                                     │ → ModelClient    │
                                     └──────────────────┘
```

## Where to make type changes

- **Adding a new event the kernel emits:** add a case to `KernelEvent`, update `translateKernelEvent` in `src/transports/ag-ui-events.ts`, update the turn loop to emit it.
- **Adding a new augment lifecycle hook:** add it to `Augment` interface, update `defineAgent`/`turn-loop`/`lifecycle-manager` to call it.
- **Adding a new memory provider kind:** extend the `MemoryProviderSpec` discriminated union, add a case to `buildRegistry` for the new `kind`, add a case to `synthesizeContextFor`, possibly add new generic tools.
- **Adding a new content part kind:** extend the `Part` union, update `extractText` in `src/parts.ts`.
- **Adding a new task state:** add to `TaskState`, update places that switch on it (mostly transports).

In every case: **the type goes in `types.ts`, the behavior change goes in the relevant module.** Don't sneak runtime behavior into the type file.
