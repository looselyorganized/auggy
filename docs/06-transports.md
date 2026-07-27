# 06 — Transports

> The transport contract, the AG-UI event protocol, kernel→AG-UI translation, and how the web transport actually streams events. Everything in `src/transports/`.

## What a transport is

A transport is the boundary between Auggy and the outside world. It is responsible for:

1. **Listening for inbound requests** in some protocol (HTTP, WebSocket, queue subscription, IPC, in-process, ...).
2. **Identifying the peer** behind the request — turning protocol-specific credentials into a `PeerIdentity`.
3. **Translating wire-format input into a `TurnTrigger`** — extracting the message content (as `Part[]`), context/task IDs, and any other metadata the kernel expects.
4. **Calling `kernel.handleInbound(trigger, { onEvent })`** to run the turn.
5. **Translating kernel events back into the wire format** as they arrive (e.g. SSE frames, A2A task updates, A2A messages).
6. **Returning the final response** to the peer in whatever shape the protocol expects.

A transport is just an augment with a `transport` field set to a `TransportSpec`. The runtime knows nothing about HTTP, AG-UI, A2A, MCP, or any other protocol — those are the transport's job.

In v1 there is exactly **one built-in transport**: `webTransport`, which speaks the AG-UI SSE protocol. Future plans add a `spineTransport` (Plan 4 — internal A2A bus) and an `mcpTransport` (Plan 6 — MCP server).

## The contract: `TransportSpec` and `TransportKernel`

### `TransportSpec` — what an augment provides

```ts
export interface TransportSpec {
  register(kernel: TransportKernel, augmentName: string): Promise<void>;
  identify(raw: unknown): PeerIdentity | null;
  concurrency?: number;
  maxQueueDepth?: number;
  rateLimitPerPeer?: {
    maxPerMinute: number;
    anonymousNetwork?: {
      mode?: "shared-store" | "trusted-edge" | "single-process-development";
      ipv6PrefixBits?: number;       // default 64; accepted range 32–64
      globalMaxPerMinute?: number;   // default maxPerMinute * 100
    };
  };
}
```

**`register(kernel, augmentName)`** is called once at agent startup. The transport receives a `TransportKernel` view onto the runtime — a small interface with three methods (`handleInbound`, `onOutbound`, `getAgentCard`). The transport also receives `augmentName`, the operator-chosen runtime name for this augment instance (e.g. `"web"`, `"telegram"`). The transport stores both references and uses them to feed inbound requests.

The `augmentName` parameter was added in commit `0710e2f` (Phase B) to support correct outbound dispatch. See the multi-transport composition section below for why this matters.

**`identify(raw)`** is a pure function from "whatever the transport's wire
format hands you" to `PeerIdentity | null`. It runs before scheduler admission.
Returning `null` means "I cannot identify this peer" — the transport is
responsible for what to do with that.

The web transport's handler first verifies bearer, admitted-agent, visitor,
external-auth, and anonymous-session credentials. It then passes only verified
identity evidence into `identify()`. `x-peer-id`, `x-peer-kind`, and `x-org-id`
are not identity or authorization proof; `x-peer-name` is cosmetic. The
resolved trust level is a deterministic result of the credential path:
creator, agent, public-recognized, or public-anonymous.

**`concurrency`**, **`maxQueueDepth`**, and **`rateLimitPerPeer`** narrow this
source inside the shared agent-wide scheduler. They do not create an
independent execution queue. Generic defaults are `1`, `50`, and none; the
built-in web source defaults concurrency to `4`. See
[04-kernel.md § agent-wide turn admission](./04-kernel.md#srckernelkeyed-turn-schedulerts--agent-wide-turn-admission).

### `TransportKernel` — what the runtime gives back

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
```

**`handleInbound(trigger, options)`** is the function the transport calls to run a turn. The trigger is built by the transport from whatever its wire format is. The optional `onEvent` callback is the streaming hook — the kernel calls it with `KernelEvent`s as they happen, before `handleInbound` resolves.

The function returns a `Promise<TurnResult>` that resolves when the turn is complete. The `TurnResult.status` is one of `completed`, `failed`, `canceled`, or `rejected` — the transport should check it and react appropriately (the web transport synthesizes `RUN_ERROR` events for `rejected` status, since the kernel emits no events for those).

**`onOutbound(callback)`** registers a callback that fires when the kernel wants to send a message *out* to a peer through this transport. The callback receives `(peer, message)`. This is used for proactive communication — when an agent decides on its own to send a follow-up message, not in response to an inbound. The web transport doesn't actively use `onOutbound` (every web turn returns its response synchronously), but a spine transport would.

**`getAgentCard()`** returns the agent card. Used by the web transport to serve `/.well-known/agent-card.json`.

## The AG-UI event protocol

AG-UI is an open protocol for streaming agent execution to user interfaces. It's complementary to MCP (which exposes tools to LLM clients) and A2A (which lets agents talk to other agents). The official spec is at https://docs.ag-ui.com.

Auggy implements **a minimal subset of AG-UI** in v1 — enough to drive a chat UI, but not the full spec. What we implement:

- `RUN_STARTED`
- `RUN_FINISHED`
- `RUN_ERROR`
- `TEXT_MESSAGE_START`
- `TEXT_MESSAGE_CONTENT`
- `TEXT_MESSAGE_END`
- `TOOL_CALL_START`
- `TOOL_CALL_ARGS`
- `TOOL_CALL_END`
- `TOOL_CALL_RESULT`

What we don't implement (deferred to a future enhancement):

- Token-level model streaming (the `TEXT_MESSAGE_CONTENT` delta is a single chunk, not per-token)
- `STATE_SNAPSHOT` / `STATE_DELTA` — state sync
- `REASONING_*` — reasoning visibility
- Activity messages, generative UI
- Full `RunAgentInput` request body parsing (we use a simplified shape)
- Binary protocol (AG-UI has SSE and binary bindings; we implement SSE only)
- Client-side cancellation (the client closing the stream doesn't cancel the turn — yet)

The subset we ship is enough to drive any AG-UI-compatible client (CopilotKit, custom AG-UI consumers, etc.) for basic chat with tool use. The deferred features are upgrade paths on the same transport.

## `src/transports/ag-ui-events.ts` — Event types and translation

This file has three sections.

### Section 1 — AG-UI event type definitions

Every AG-UI event has a base shape:

```ts
export interface AGUIBaseEvent {
  type: string;
  timestamp?: number;
}
```

And ten subtypes, one per event we emit. They follow the AG-UI spec field names:

```ts
export interface AGUIRunStarted extends AGUIBaseEvent {
  type: "RUN_STARTED";
  threadId: string;
  runId: string;
  parentRunId?: string;
}

export interface AGUITextMessageContent extends AGUIBaseEvent {
  type: "TEXT_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
}

// ... etc for all 10 event types
```

The full union is `AGUIEvent`, which is what `serializeSSE` accepts.

### Section 2 — Constructor helpers

For each event type, a small helper function:

```ts
export function runStarted(opts: { threadId; runId }): AGUIRunStarted {
  return { type: "RUN_STARTED", ...opts };
}

export function textMessageContent(opts: { messageId; delta }): AGUITextMessageContent {
  return { type: "TEXT_MESSAGE_CONTENT", ...opts };
}

// ... etc
```

These exist purely for ergonomics — they let `translateKernelEvent` (and the web transport's error handling) construct events without repeating the `type:` literal everywhere.

### Section 3 — `translateKernelEvent`

The translator from internal `KernelEvent` to wire-format `AGUIEvent[]`:

```ts
export function translateKernelEvent(event: KernelEvent): AGUIEvent[] {
  switch (event.kind) {
    case "run_started":
      return [runStarted({ threadId: event.threadId, runId: event.turnId })];

    case "tool_call_started":
      return [toolCallStart({ toolCallId: event.toolCallId, toolCallName: event.toolName })];

    case "tool_call_args":
      return [toolCallArgs({ toolCallId: event.toolCallId, delta: JSON.stringify(event.args) })];

    case "tool_call_result":
      return [
        toolCallEnd({ toolCallId: event.toolCallId }),
        toolCallResult({
          messageId: `${event.toolCallId}-result`,
          toolCallId: event.toolCallId,
          content: event.output,
        }),
      ];

    case "text_message":
      return [
        textMessageStart({ messageId: event.messageId, role: event.role }),
        textMessageContent({ messageId: event.messageId, delta: event.text }),
        textMessageEnd({ messageId: event.messageId }),
      ];

    case "run_finished":
      return [runFinished({ threadId: "", runId: event.turnId })];

    case "run_error":
      // Only emit RUN_ERROR — the turn loop emits a separate run_finished.
      return [runError({ message: event.message, code: event.source })];
  }
}
```

A few translations expand 1→N:

- **`text_message`** → `TEXT_MESSAGE_START` + `TEXT_MESSAGE_CONTENT` + `TEXT_MESSAGE_END`. v1 doesn't stream tokens, so these three arrive in one batch (one `text_message` event from the kernel becomes three AG-UI events emitted back-to-back). When token streaming lands, the kernel will start emitting separate `text_chunk` events that translate to multiple `TEXT_MESSAGE_CONTENT`s.

- **`tool_call_result`** → `TOOL_CALL_END` + `TOOL_CALL_RESULT`. AG-UI separates "the tool call ended" from "here's its result" — the END marks the boundary, the RESULT carries the content.

The `run_error` case used to also emit `RUN_FINISHED`, but that caused **double terminal events** because the turn loop *also* emits a `run_finished` event after `run_error` on aborts and required-augment failures. Codex caught this in review; the fix was to drop the synthetic `RUN_FINISHED` from the translator and rely on the turn loop's emission.

### Section 4 — `serializeSSE`

```ts
export function serializeSSE(event: AGUIEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
```

Standard SSE frame format. The trailing `\n\n` is what marks the frame as complete to the client — without it, the client buffers waiting for more.

## `src/transports/web-transport.ts` — The built-in HTTP transport

The reference transport implementation. ~250 LOC. Speaks AG-UI over SSE on three endpoints.

### Configuration

```ts
export interface WebTransportOptions {
  port: number;
  auth: { type: "bearer"; token: string };
  cors?: { origins: [string] }; // exactly one browser origin in the current static-CORS implementation
  securityNamespace?: string;   // stable logical-agent identity shared by replicas
  maxMessageLength?: number;     // default 4000
  access?: { agents?: AgentAccessEntry[] };  // admitted agent list
  concurrency?: number;          // web source default 4
  maxQueueDepth?: number;        // default 50
  rateLimitPerPeer?: { maxPerMinute: number };
  visitorTokens?: {
    enabled?: boolean;       // opt-in; resolver enables when visitorAuth is mounted
    signingKey?: string;     // required when enabled
    agentBinding?: string;   // defaults to securityNamespace, then registered agent name
  };
  idempotency?: {
    dbPath?: string | null;  // CLI default: data/web-idempotency.db
    maxRecords?: number;     // default 50,000; minimum 3
    maxRateLimitRecords?: number; // default 50,000 live shared network hits
    maxReplayBytes?: number; // default 2 MiB
    maxStoredBytes?: number; // default 256 MiB aggregate replay bodies
    maxRecordsPerPartition?: number; // default min(maxRecords, 10,000)
    maxPublicRecords?: number;  // default 50% of maxRecords
    maxAgentRecords?: number;   // default 30% of maxRecords
    maxCreatorRecords?: number; // default remainder (20% at default)
    waitTimeoutMs?: number;  // default 30 seconds
    staleAfterMs?: number;   // default 30 seconds
    retentionMs?: number;    // replay bytes retained for 24 hours
    maxWaiters?: number;     // default 64 across the process
    maxWaitersPerKey?: number; // default 8
  };
  publicFrontendUrl?: string;    // optional 302 redirect target for GET /
  publicIntegration?: boolean;   // publish legacy discovery: /agent + generic runtime metadata
  adminRoute?: boolean;          // built-in /console surface; default true
  consoleChat?: {
    dbPath?: string | null;      // durable SQLite path; null keeps chat in memory
  };
}
```

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/agent/run` | AG-UI SSE endpoint. Streams events for one turn. |
| `GET` | `/` | Optional 302 redirect to `publicFrontendUrl`; otherwise a minimal public placeholder. |
| `GET` | `/agent` | Optional published developer integration page when `publicIntegration: true`. |
| `GET` | `/health` | Liveness check. Returns `{status: "healthy"}`. It is deliberately not a readiness or capacity probe. |
| `GET` | `/.well-known/agent-card.json` | Legacy Auggy runtime metadata. Published only when `publicIntegration: true`; otherwise bearer-only. Not a current A2A Agent Card. |
| (anything else) | `404 Not Found` |

`/health` remains a compatibility-stable process/listener liveness endpoint.
Do not use it to decide whether a turn will be admitted. Authenticated
operators can inspect the process-local readiness and capacity snapshot in the
console dashboard; embedders can call `agent.operationalSnapshot()`. The
snapshot reports `accepting`, `draining`, `stopped`, and `not-started`
explicitly.

### `POST /agent/run` — the main path

The handler does this in order:

#### 1. Authenticate

```ts
const hasBearerAttempt = authHeader.length > 0;
if (hasBearerAttempt) {
  if (!isValidAuth(authHeader)) {
    return json({ error: "unauthorized" }, 401);
  }
} else if (!allowAnonymous) {
  return json({ error: "unauthorized" }, 401);
}
// else: no bearer + allowAnonymous=true → fall through to identify() Path 4
```

The bearer token is validated with a timing-safe comparison to prevent extraction via timing side-channel. The auth policy has three possible outcomes:

- **Bearer present + valid** → proceed to identity resolution. Resolves to Path 1 / 2 / 3 below depending on which other identity headers are set.
- **Bearer present + invalid** → HTTP 401. Always rejects — never silently downgrades to anonymous.
- **Bearer absent** → outcome depends on the `allowAnonymous` flag (see [Anonymous posture](#anonymous-posture) below). When `true`, falls through to Path 4 (`public:anonymous`). When `false`, HTTP 401.

#### 2. Idempotency-Key

If the `Idempotency-Key` header is present, the web transport claims it in a
dedicated SQLite execution ledger before history access, gates, inference, or
tools. The ledger stores hashes of the key and canonical request binding—not
the raw key, message, or credentials. The binding includes the agent audience,
resolved peer, effective authorization, thread, context/task IDs, roles, and
message content.

The first claimant receives a fresh internal turn UUID. Matching concurrent
requests wait for that execution and receive its exact terminal SSE bytes;
matching later requests replay those bytes, including after a restart. A
changed peer, thread, authorization, or request returns
`409 idempotency_key_conflict`. A crash or oversized unreplayable result leaves
a fail-closed tombstone and returns `409 idempotency_outcome_unknown` rather
than rerunning possibly side-effecting work.

Leaders renew a durable heartbeat while executing. A `running` claim whose
heartbeat is older than `staleAfterMs` (default 30 seconds) is atomically
converted to outcome-unknown; it is never taken over and rerun.

Malformed keys (1–128 `[A-Za-z0-9_-]` characters) return HTTP 400. Unkeyed
requests receive a fresh UUID and are not persisted for replay. Every fresh
anonymous request first returns `428 anonymous_session_required` plus a signed
anonymous-session capability without executing. The client retries with that
capability and, when present, the same idempotency key. Bootstrap responses do
not consume an execution-rate slot. Immediately before the idempotency/kernel
boundary, every admitted anonymous execution atomically reserves both a
caller-network-prefix slot and an audience-scoped deployment-global slot.
IPv6 identities aggregate at `/64` by default; operators may configure a
stricter `/32`–`/64` prefix. The deployment-global default is 100 times the
peer limit. Minting several sessions or rotating addresses within a prefix
therefore cannot multiply the configured `rateLimitPerPeer` without meeting
the global cap.

CLI-managed agents default the ledger to `data/web-idempotency.db` (or the
configured runtime data root). Every programmatic deployment must set
`webTransport.idempotency.dbPath`; keyed requests fail with 503 if storage is
unspecified or unavailable. Tests and disposable local processes can
explicitly choose `dbPath: ":memory:"`, acknowledging that restart safety is
then absent. The bounded ledger fails closed at `maxRecords`
(default 50,000), at the per-partition limit, or at the applicable trust-class
limit. Default class reservations are public 50%, agent 30%, and creator 20%;
custom class limits must sum to no more than the global limit. All anonymous
sessions intentionally share the public partition, so minting new anonymous
credentials cannot evade its cap. This is an availability boundary: sustained
public keyed traffic can exhaust the public allocation, but cannot consume the
agent or creator reservations.

The same SQLite file stores only hashed caller-network and global rate buckets
plus timestamps. Live rate hits are bounded by `maxRateLimitRecords` (default
50,000); capacity exhaustion rejects anonymous execution. A keyed leader claim
and every applicable rate reservation occur in one `BEGIN IMMEDIATE`
transaction. Existing followers, replays, conflicts, and outcome-unknown
tombstones do not consume another execution slot.

`anonymousNetwork.mode` defaults to `shared-store`. Anonymous rate-limited
boot fails closed when that mode has no durable database or uses `:memory:`.
Replicas must point to the same SQLite file on storage that preserves SQLite
locking. An operator may explicitly choose `trusted-edge` only when a trusted
front door enforces equivalent caller-network and deployment-global limits.
`single-process-development` is observable, process-local, and rejected in
production, Railway, or a public `AUGGY_PUBLIC_URL` runtime.

When a trusted proxy supplies malformed, conflicting, oversized, or otherwise
ambiguous forwarded identity headers, `/agent/run` returns
`400 invalid_forwarded_request`; it never falls back to charging the proxy's
shared connection bucket.

Replay capture is capped at 2 MiB per response and 256 MiB in aggregate.
Concurrent followers are also bounded (64 globally and 8 per key by default).
After 24 hours the response bytes are removed and the record becomes an
outcome-unknown tombstone. Complete and unknown execution tombstones are never
automatically deleted because deleting them would permit a late retry to run
again. Operators must provision the ledger for their idempotency horizon; at
capacity the safe behavior is 503, not eviction and duplicate execution.

SQLite coordinates processes only when every replica opens the same database
file on storage whose locking semantics SQLite supports. Replicas with
independent volumes do not provide cross-host exactly-once execution. Such
deployments must use single-writer/sticky routing for keyed execution or defer
enabling keyed requests until a shared coordinator is available. Changing
`securityNamespace` deliberately creates a separate key namespace and
invalidates outstanding anonymous capabilities; it must not be used as an
unsafe capacity reset while old retries remain possible. Replicas of one
logical agent must share a namespace, while unrelated agents sharing a
database or signing key must use different namespaces.

A ledger file is one physical availability boundary. Its row-class and
aggregate replay-byte ceilings are shared even when distinct security
namespaces prevent key collisions. Do not point unrelated agents at one file
unless that capacity coupling is intentional; prefer one ledger file per
logical agent.

`Idempotency-Key` is only a client correlation and execution-claim input. It is
never emitted as the AG-UI `runId`. Keyed responses use a server-minted UUID
that is stable across followers and replay. Clients that previously assumed
`runId === Idempotency-Key` must store those values separately.

Budgets and traces use the internal UUID, never the caller's key. Direct kernel
injection has no response-replay coordinator, so a duplicate turn ID is denied
instead of reusing an earlier allowance.

#### Request and stream bounds

`POST /agent/run` reads at most `maxRequestBodyBytes` (default 1 MiB) before
JSON parsing. The reader enforces both a valid `Content-Length` and the bytes
actually received, so a missing or false-small header does not bypass the cap.
Malformed UTF-8 and JSON fail without invoking the kernel. Authenticated
console mutation routes use route-specific pre-parse caps as well; login and
logout are capped at 4 KiB.

Live SSE delivery maintains an application-owned pending queue capped by both
`maxPendingSseBytes` (default 1 MiB) and `maxPendingSseEvents` (default 1,024).
A slow or abandoned client cannot make that queue grow without bound. Queue
overflow terminates delivery and cancels the turn. An exact durable idempotent
execution may continue after an ordinary client disconnect so another exact
request can join or replay it, but a server-side resource-limit overflow still
aborts it. Console transcript aggregation has a separate
`maxConsoleRunBytes` cap (default 4 MiB). The browser console parser also
rejects more than 1 MiB of unparsed SSE data, a single event above 512 KiB, or
more than 100,000 events.

#### 3. Identity resolution — four paths

Identity is resolved in a fixed priority order:

The runtime categories are `public` + `anonymous`, `public` + `recognized`,
`creator`, and `agent`. Route auth may also expose `auth.principal.kind`; that
field is the typed identity payload for the resolved caller, not another trust
layer.

**Path 1 — Creator:** bearer token valid AND no `x-agent-id`/`x-agent-secret` headers AND no verified visitor token. Mints `{ trustLevel: "creator", id: "creator" }`.

**Path 2 — Agent:** `x-agent-id` and `x-agent-secret` headers both present. Looks up the agent ID in `opts.access.agents`; performs a timing-safe secret comparison. If the secret matches, mints `{ trustLevel: "agent", id: "agent:<agentId>" }`. A missing half, unknown ID, or wrong secret returns HTTP 401 immediately—there is no silent downgrade to public or creator trust.

**Path 3 — Public recognized:** `x-visitor-token` header present and HMAC-verified. Mints `{ trustLevel: "public", publicSubstate: "recognized", id: "<visitorId from token>" }`. The caller's public ID is durable across sessions — memory writes attach to it.

**Path 4 — Public anonymous:** default path. Mints a server-authenticated
anonymous-session subject and returns its capability in
`x-auggy-anonymous-session`. A first-contact request returns
`428 anonymous_session_required` before model or tool execution; only a retry
presenting that capability is admitted. The identity is never derived from the
caller-controlled thread ID. Missing or invalid visitor tokens never mint a
replacement recognized credential. Recognition requires a token from
`visitorAuth` or another explicitly trusted minter. Such a verified token can
carry a one-way proof of its prior anonymous peer and thread scope; revoked or
otherwise invalid credentials cannot downgrade back into that thread.

For public callers, a request `threadId` is a logical client identifier rather
than the kernel's globally addressable thread ID. The transport derives an
opaque HMAC-scoped thread ID from the security namespace, authenticated peer
scope, and logical ID. A caller cannot pre-claim another peer's predictable
thread name. The kernel binds every resulting thread to the first resolved
peer before history retrieval or model execution and rejects mismatches.

Anonymous-session capabilities expire after 24 hours and are also invalidated
by bearer-secret or `securityNamespace` rotation. An invalid capability returns
401 with `x-auggy-anonymous-session-status: invalid` before an idempotency
claim or model execution. Browser clients may then remove only that credential
and retry once with the same key; the resulting fresh anonymous request
receives the normal 428 bootstrap response and can be retried once more. Do not
retry arbitrary 401 responses or loop indefinitely.

Path 2 is evaluated before Path 1 — if agent headers are present, they determine the outcome regardless of whether the bearer token is also valid.

#### Anonymous posture

Path 4 (`public:anonymous`) is gated by the `allowAnonymous` option on `WebTransportOptions`. The option is resolved at factory time across three precedence levels — operator's most-explicit choice wins:

| Precedence | Source | Wins over |
|---|---|---|
| 1 | Explicit yaml value (`allowAnonymous: true \| false` in agent.yaml) | env, default |
| 2 | Env var (`AUGGY_ALLOW_ANONYMOUS=true \| false`, strict literals only) | default |
| 3 | Default rule: `process.env.NODE_ENV !== "production"` | — |

Why this shape:

- **Production deploys** (Railway / Fly / etc.) typically set `NODE_ENV=production` automatically → `allowAnonymous` defaults to `false` → bearer required → safe by default.
- **Local dev** (`NODE_ENV` unset) → `allowAnonymous` defaults to `true` → anonymous chat works out of the box after `auggy create && auggy dev`.
- **Per-environment override** without redeploying: set `AUGGY_ALLOW_ANONYMOUS=true` in the Railway env panel to flip a deployed agent into demo mode (no yaml edit, no redeploy).
- **Operator's deliberate choice** in yaml beats both: if you wrote `allowAnonymous: false` in yaml, env vars cannot override you.

At boot, `webTransport` emits an operator-facing posture line:

```
[web] anonymous local chat enabled
[web] anonymous chat disabled (production default)
[web] anonymous chat enabled (public default)
[web] anonymous chat enabled (agent.yaml)
```

If `allowAnonymous` resolves to `true`, the `visitorAuth` augment is not mounted, the value came from `env` or `default` (not explicit yaml), and the runtime looks publicly reachable (`NODE_ENV=production`, Railway env vars, or a non-local `AUGGY_PUBLIC_URL`), a startup warning fires. Local default runs stay quiet. When `allowAnonymous: true` is explicit in yaml, the warning is suppressed because the operator has signaled intent.

The optional `budgets` augment caps cost for anonymous traffic — typically 5
turns per thread, 30 turns globally per day, and a $5/day global ceiling.
`visitorAuth` (when mounted) gives anonymous visitors a magic-link path to
upgrade to recognized identity for higher trust + budget tiers.

#### 3. Validate the body

```ts
const body = await req.json();
if (!Array.isArray(body.messages) || body.messages.length === 0) {
  return json({ error: "messages array is required" }, 400);
}
const lastMessage = body.messages[body.messages.length - 1];
const text = lastMessage.content ?? "";
if (text.length > maxMessageLength) {
  return json({ error: "message too long", limit: maxMessageLength }, 413);
}
```

The body must have a `messages: [{ role, content }, ...]` array. v1 only uses the last message — the rest are reserved for future use (the AG-UI spec uses the array to pass conversation history, but Auggy maintains its own per-thread history server-side, so this is currently informational).

`maxMessageLength` is enforced at the boundary (default 4000 chars). This is input sanitization against the obvious DoS vector — a peer that sends 10MB of text would otherwise eat tokenization cost trying to fit it in the prompt.

#### 4. Build the trigger

```ts
const requestedThreadId = body.threadId ?? body.contextId;
const threadId =
  peer.trustLevel === "public"
    ? canonicalPublicThreadId(requestedThreadId, idempotencyKey, authenticatedThreadScopeId)
    : requestedThreadId ?? crypto.randomUUID();
const parts: Part[] = [{ kind: "text", text }];
const inbound: InboundMessage = { parts, sourceAugment: "web", peer, timestamp: Date.now(), contextId: body.contextId, taskId: body.taskId };
const trigger: TurnTrigger = { type: "message", turnId: crypto.randomUUID(), threadId, contextId: body.contextId, taskId: body.taskId, timestamp: Date.now(), source: "web", peer, payload: inbound };
```

Creator and admitted-agent callers can supply their logical thread ID.
Public callers cannot attach directly to a raw caller-selected thread:
`canonicalPublicThreadId` binds the logical ID to the authenticated
visitor/anonymous capability and security namespace. Omitting a thread ID
mints a new conversation, except that a keyed request derives one stable
logical thread so its exact retry can join.

#### 5. Open the SSE stream

This is the **streaming part** — the part that the original implementation got wrong (buffered → fixed in post-review).

```ts
const stream = new ReadableStream<Uint8Array>({
  start(controller) {
    const encoder = new TextEncoder();

    const writeEvent = (e: AGUIEvent) => {
      controller.enqueue(encoder.encode(serializeSSE(patchThreadId(e))));
    };

    const onEvent = (kernelEvent: KernelEvent) => {
      for (const e of translateKernelEvent(kernelEvent)) {
        writeEvent(e);
      }
    };

    (async () => {
      try {
        const result = await k.handleInbound(trigger, { onEvent });
        if (result.status === "rejected") {
          writeEvent(runError({ message: result.errorResponse ?? "...", code: "REJECTED" }));
          writeEvent(runFinished({ threadId, runId: trigger.turnId }));
        }
      } catch (err) {
        writeEvent(runError({ message: String(err), code: "INTERNAL" }));
        writeEvent(runFinished({ threadId, runId: trigger.turnId }));
      } finally {
        controller.close();
      }
    })();
  },
});

return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" }});
```

What this does:
1. **Opens a `ReadableStream`** — a web-standard streaming primitive. The `start` function runs synchronously and is given a `controller` that lets us push chunks into the stream.
2. **Wraps the kernel call in an immediately-invoked async function** — this is what lets the response return *before* the kernel finishes. The `(async () => { ... })()` runs in the background; the `Response` is returned immediately with the stream as its body.
3. **Pushes events as they arrive** — the `onEvent` callback fires for every kernel event. Each one gets translated, optionally patched (see below), serialized as an SSE frame, and enqueued onto the controller. The controller flushes to the client immediately.
4. **Handles three terminal cases** in the IIFE:
   - **Normal completion:** the kernel emits its own terminal events. `result.status === "completed"` and we just close the stream.
   - **Queue rejection:** the kernel returned `status: "rejected"` *without* emitting any events (because the queue rejected the turn before it ran). We synthesize `RUN_ERROR` (code: `REJECTED`) + `RUN_FINISHED` so the client always sees a terminal event.
   - **Exception:** something threw out of `handleInbound`. Same fallback — synthesize `RUN_ERROR` (code: `INTERNAL`) + `RUN_FINISHED`.
5. **Always closes the stream** in the `finally` block.

#### `patchThreadId`

```ts
const patchThreadId = (e: AGUIEvent): AGUIEvent => {
  if (e.type === "RUN_FINISHED" && !e.threadId) {
    return runFinished({ threadId, runId: trigger.turnId });
  }
  return e;
};
```

The kernel emits `run_finished` with no `threadId` (because the kernel doesn't know the transport's notion of threadId — `threadId` is a transport-level concept). The translator passes that through as a `RUN_FINISHED` with `threadId: ""`. The transport patches it before serialization, since the transport *does* know the threadId for this particular turn.

This is a small, ugly bit of layering — the alternative is to pass `threadId` into the kernel, but threadId is a wire-protocol concept (each transport mints them differently) so it doesn't belong in the kernel's vocabulary.

### Why ReadableStream and not buffered

The original implementation collected all events into an array and returned them as a single string Response after the turn finished. Codex's review caught this as "P1: Return an actual SSE stream instead of a buffered string." The reasoning:

1. **AG-UI's whole purpose is streaming.** Clients expect to see `RUN_STARTED` immediately, `TOOL_CALL_*` events as tools execute, `TEXT_MESSAGE_CONTENT` as text arrives. Buffering until the turn completes destroys all of that.
2. **For non-trivial turns the latency adds up.** A turn with multiple model inferences and tool calls can take 5-30 seconds. Buffered, the client sees nothing for that whole time. Streaming, the client sees activity from the first 100ms.
3. **It's the difference between "demo of AG-UI" and "actually AG-UI."** Anyone who tried to consume the buffered version with a real AG-UI client (CopilotKit etc.) would find the experience indistinguishable from a non-streaming endpoint.

The fix was small: replace the `collected` array with a `ReadableStream`, replace `return new Response(sseBody)` with `return new Response(stream)`, run the kernel call inside an IIFE so the response can return early. The test for it stands up a real model client gated on a `Promise<void>`, makes the request, reads the first chunk (which contains `RUN_STARTED`), then releases the gate and drains the rest. Without true streaming, the read would block forever waiting for the gate.

### Rejection mapping — error codes in SSE

When a turn is rejected (scheduler capacity, rate limit, or turn-gate denial),
the transport synthesizes `RUN_ERROR` + `RUN_FINISHED` events—the kernel emits
no events for turns that do not run. The `code` field on `RUN_ERROR` is:

| Rejection source | `errorClass` | SSE `code` |
|---|---|---|
| Turn-gate cap denied | `"cap-denied"` | `"CAP_DENIED"` |
| Turn-gate confirm error | `"admission-state-failed"` | `"ADMISSION_FAILED"` |
| Scheduler peer/source/thread limit | `rejection.reason` | `"SCHEDULER_RATE_LIMITED"` |
| Scheduler agent limit / shutdown | `rejection.reason` | `"SCHEDULER_UNAVAILABLE"` |
| Outcome-unknown thread quarantine | `rejection.reason` | `"THREAD_QUARANTINED"` |
| Unhandled exception | _(none)_ | `"INTERNAL"` |

**HTTP status remains 200** for the SSE stream in v0. The gate decision is
embedded in the stream rather than in the HTTP status because the Response
must be opened before the kernel's admission or 2PC result is known (the
stream starts synchronously; the turn runs inside the async IIFE). A future
synchronous reservation API would allow the transport to return 429 or 503
before opening the stream.

### Why the rejection events are synthesized in the transport

The scheduler rejects requests without calling the turn loop. That means **no
kernel events fire** — the turn never ran.

The transport detects `result.status === "rejected"` and synthesizes the error
event. Kernel events remain scoped to turns that actually run.

### `GET /health`

```ts
function handleHealth(): Response {
  return json({ status: "healthy" }, 200);
}
```

Trivial. Used by load balancers / orchestrators to know the agent is up. v1 doesn't ask the lifecycle manager for richer health — that would be an easy enhancement.

### `GET /.well-known/agent-card.json`

```ts
function handleAgentCard(req: Request): Response {
  if (!publicIntegration && !isValidAuth(req.headers.get("authorization") ?? "")) {
    return new Response(null, { status: 404 });
  }
  return json(kernel.getAgentCard(), 200);
}
```

Returns the JSON-encoded internal `AgentCard` generated at `defineAgent` time
and cached. Despite the well-known path, this payload does not implement the
current A2A 1.0 Agent Card schema and must not be advertised to A2A clients as
an interoperable discovery document.

Auggy keeps this legacy discovery payload private by default: unauthenticated
requests return `404` unless the creator sets
`webTransport.config.publicIntegration: true`. Creator/developer requests with
the web bearer can still fetch it while public discovery is disabled.

`publicIntegration: true` publishes `/agent` and this metadata payload. It does
**not** make `POST /agent/run` unauthenticated and does **not** expose
`/console`, but the payload can describe mounted capabilities and tools.
Operators must review that content before publishing it; it is not a
public-safety or A2A-conformance boundary.

### `GET /agent` and `HEAD /agent` — optional published developer integration page

`/agent` is the human-readable companion to the legacy Auggy metadata payload.
It is disabled by default and returns `404`.

When `publicIntegration: true`, `GET /agent` returns a conservative public HTML page containing:

- Agent name and configured purpose
- Protocol-level summary
- Link to the legacy `/.well-known/agent-card.json` metadata
- Generic `POST /agent/run` request shape with no secrets
- Generic authentication guidance

`HEAD /agent` mirrors the `GET /agent` headers with an empty body. `GET /agent/` redirects to `/agent` only when developer discovery is published.

Operator-only integration details belong in `/console/integrations`, including exact auth posture, CORS, generated snippets, frontend redirect config, and diagnostics.

### `GET /` and `HEAD /` — agent info endpoint + optional frontend redirect (G2)

`GET /` and `HEAD /` are both handled. The branch depends on whether `publicFrontendUrl` is configured.

**`publicFrontendUrl` set** → `302 Found` with `Location: <publicFrontendUrl>`. Use this to point visitors at a polished frontend you stand up yourself (your own chat widget, LORF's `platform/chat`, a marketing page, a future spine-visitor-chat URL).

```yaml
- name: web
  type: webTransport
  options:
    port: 8080
    auth:
      type: bearer
      token: ${AUGGY_WEB_TOKEN}
    publicFrontendUrl: https://your-frontend.example/chat
```

`publicFrontendUrl` is validated at agent boot (`agent.start()`) — a malformed URL fails fast with `publicFrontendUrl is not a valid URL` rather than at first request.

**`publicFrontendUrl` unset** → `200 OK` with a minimal HTML info page (~1.3 KB, self-contained, no JS, no external assets). The page contains:

- Agent name (from the agent card's `provider.name`) in `<title>` and `<h1>` (falls back to `"An Auggy agent"` when the name is empty or whitespace-only)
- Agent purpose (from `card.purpose`) in `<meta description>` + Open Graph + a body paragraph (omitted when purpose is undefined, empty, or whitespace-only)
- A link to `/agent` only when `publicIntegration: true`
- `<link rel="alternate" type="application/json" href="/.well-known/agent-card.json">` only when `publicIntegration: true`
- `<meta name="robots" content="noindex, nofollow">` so well-behaved search crawlers don't index passively
- Open Graph tags (`og:title`, `og:description`, `og:type`) so Slack/Discord/iMessage link previews render usefully when the URL is shared
- Brief copy pointing creators at `/console` and `publicFrontendUrl`

Response headers include `Cache-Control: public, max-age=300` — five-minute browser/CDN cache to prevent thundering from uptime monitors and link-preview refreshes.

The HTML body is rendered once at agent boot and cached in the transport — per-request cost is just `Response` construction.

**`HEAD /` mirrors `GET /`** — same status code, same headers (including `Content-Length` matching the GET body, per RFC 9110 §9.3.2), body omitted. Both branches handle HEAD identically to GET.

**Other methods on `/`** (POST, PUT, DELETE, PATCH) continue to return `404 Not Found`. CORS preflight (`OPTIONS /`) is unchanged. `/agent/run`, `/health`, `/agent`, and `/.well-known/agent-card.json` are unaffected by `publicFrontendUrl`.

**Auth posture.** The default `/` page is unauthenticated and intentionally
minimal. Legacy developer discovery is separate and private by default:
`publicIntegration: true` is the creator's explicit decision to publish
`/agent` and the generic runtime metadata. It does not change `/agent/run`
authentication or `/console` access, and it does not sanitize the published
tool-derived entries.

For local operator testing, run `auggy chat` instead — it provides a polished
chat surface against agents you've started with `auggy dev`, without exposing a
public URL.

**Uptime / health checks:** point them at `/health`, not `/`. The `/` route is for visitors; `/health` is for monitoring.

### Lifecycle hooks

```ts
return {
  name: "web",
  transport,
  async onBoot() {
    server = Bun.serve({ port: opts.port, async fetch(req) { /* route */ } });
  },
  async onShutdown() {
    if (server) { server.stop(); server = null; }
  },
};
```

The web transport uses `onBoot` to start the HTTP server (Bun.serve) and `onShutdown` to stop it. Failures in `onBoot` abort agent startup (lifecycle manager throws). The 5-second shutdown timeout from the lifecycle manager applies to `onShutdown`.

## Agent-wide keyed concurrency and source policy

`defineAgent` creates one scheduler before transports register. Every
`TransportKernel.handleInbound()` and `AgentHandle.inject()` enters it.

```yaml
settings:
  turnScheduling:
    maxConcurrent: 4
    maxQueued: 100
    maxQueuedPerThread: 20
    maxCausalDepth: 8
```

The scheduler enforces:

- **One active complete pipeline per resolved thread.** The lane includes
  history, model/tools, durable commit, ordered outbound, and terminal hooks.
- **Agent-wide concurrency.** Different runnable threads share
  `maxConcurrent`.
- **Fairness.** Runnable thread keys are selected round-robin; a same-thread
  waiter consumes no active slot.
- **Finite waiting work.** Agent, per-thread, and source waiting caps all
  apply.
- **Queued cancellation.** An aborted waiting request is removed and never
  reaches persistence or inference.
- **Source policy.** A transport's `concurrency`, `maxQueueDepth`, and peer
  rate limit can narrow its share of the agent boundary.

The built-in web source defaults to four active turns. Set its `concurrency` to
one to restore serialized web ingress, or lower the agent-wide cap to one to
serialize every source. Increasing a source cap above the agent cap cannot
exceed the agent boundary.

When a durable idempotent web leader is rejected by scheduler admission, the
transport abandons only its owned, unstarted claim. Temporary saturation is
therefore not stored as a replayable terminal result; rate-limit reservations
remain consumed.

HTTP status remains `200` after an SSE stream is opened. A real pre-stream
`429`/`503` requires a future synchronous reservation API; current overload is
truthfully represented by the stable SSE error code and structured
`TurnResult.rejection`.

## Why the kernel doesn't speak protocols

Every protocol decision in Auggy is in the transport, not the kernel:
- **AG-UI event names** — `web-transport.ts` and `ag-ui-events.ts` only.
- **HTTP routing, status codes, headers** — `web-transport.ts` only.
- **SSE frame format** — `ag-ui-events.ts` only.
- **Bearer token auth** — `web-transport.ts` only.
- **Rate limiting policy** — `keyed-turn-scheduler.ts` (kernel-side, configured per transport).
- **`threadId` minting** — `web-transport.ts` only.
- **Agent Card serving** — `web-transport.ts` only.

This is what makes adding a new transport (Plan 4 spine, Plan 6 MCP) a self-contained change. Each new transport needs its own file in `src/transports/`, its own `TransportSpec`, its own translation layer for whatever protocol it speaks. The kernel and the rest of `src/` stay the same.

## What testing transports looks like

### Unit tests for ag-ui-events
`tests/transports/ag-ui-events.test.ts` (18 tests):
- One test per constructor helper (10 tests)
- One test per `translateKernelEvent` case (7 tests)
- One test for `serializeSSE` format (1 test)

### Integration tests for the web transport
`tests/transports/web-transport.test.ts` (13 tests):
- 4 structure tests — `webTransport()` returns the right augment shape, `identify()` produces the right `PeerIdentity`
- 9 HTTP server tests — actually start the server on a real port, hit it with `fetch`, assert on the responses:
  - `/health`
  - 401 on missing/wrong bearer
  - 400 on missing peer ID
  - 413 on oversize message
  - End-to-end SSE for a basic chat turn (asserts `RUN_STARTED`, `TEXT_MESSAGE_*`, `RUN_FINISHED` are all present)
  - End-to-end SSE for a tool-call turn (asserts `TOOL_CALL_*` events present)
  - Agent card served at the well-known URL
  - **Progressive streaming** — uses a gated mock model to prove `RUN_STARTED` is observable before the turn finishes
  - **Rate-limit rejection** — fires two requests, asserts the second gets `RUN_ERROR` (code: `REJECTED`) + `RUN_FINISHED`

Plus the full integration test in `tests/integration/full-agent.test.ts` which exercises the web transport with a real `defineAgent`, real `fileMemory`, real `supabaseMemory` (mocked client), and asserts identity context reaches the model and episodic memory shows up in the prompt's `contextBlocks`.

## What's not in v0/v1

These are deferred to future plans or future improvements:

- **Token-level streaming** — the `text_message` kernel event arrives as one chunk; future work splits it.
- **Current A2A wire format** — the generic card and `link` preview are legacy
  Auggy surfaces, not production A2A. See the acceptance criteria in
  [`ROADMAP.md`](./ROADMAP.md#agent-to-agent-mesh).
- **MCP server transport** — Plan 6.
- **Cancellation from the client side** — the client closing the SSE stream doesn't currently abort the kernel turn.
- **Synchronous gate-decision API (T5)** — would allow returning 429/503 before opening the stream, replacing the current in-stream error code approach.
- **CORS preflight handling** — the `cors` option exists; OPTIONS requests return 204 with allowed headers. Full CORS negotiation (multiple origins, credentials) is not implemented.
- **WebSocket transport** — SSE only.
- **Outbound dispatch via web** — the `onOutbound` callback exists but the web transport doesn't have a way to push messages to the peer (one-shot HTTP request/response). A WebSocket version would.

## Augment-registered HTTP routes (PR γ.1)

Augments can register HTTP routes that `webTransport` serves alongside its built-in paths. Routes are collected at `agent.start()` after every augment's `onBoot` runs, so boot-populated route lists are visible to the dispatcher and route manifest. Collisions throw during startup and never silently override another route.

### Declaring a route

In your augment, set the optional `httpRoutes` field:

```ts
import type { Augment } from "auggy";

export function myAugment(): Augment {
  return {
    name: "my-augment",
    httpRoutes: [
      {
        method: "GET",
        path: "/my-augment/status",
        auth: "bearer",
        handler: async (req) =>
          new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json" },
          }),
      },
    ],
  };
}
```

### Auth modes

`auth` is **required** — no implicit default.

- `"bearer"` — the route inherits webTransport's bearer-token check. Legacy name for creator-authorized routes.
- `"creator"` — semantic alias for creator-only routes. Uses the same bearer-token check as `"bearer"`, but route handlers receive `auth.mode === "creator"` so app code can express creator authority directly.
- `"none"` — the route accepts any caller. Use ONLY for genuinely public callbacks (email click-backs, OAuth redirects). The boot log emits a `console.warn` per `auth: "none"` route so operators see the unauthenticated surfaces.
- `"visitor.optional"` — the route accepts anonymous callers but resolves `public` + `recognized` context when a valid `x-visitor-token` is present. The boot log warns because the route is still anonymous-callable.
- `"visitor.required"` — the route requires a valid `x-visitor-token` or configured external auth assertion. Missing, invalid, expired, wrong-agent, or revoked visitor tokens return `401 {"error":"visitor-auth-required"}` unless a valid external assertion is present. Handler auth context always includes `visitorId`; when `visitorAuth` or another `identityLookup` is mounted, it can also include `email`, `verifiedAt`, and `reverifyDueAt`. When an external app assertion resolves the caller, context also includes `externalAuth: { provider, subject, orgId?, roles? }`. If both credentials are supplied, the fresh verified external assertion is authoritative and the visitor token is not composed with it.
- `"agent.required"` — the route requires admitted agent credentials using `x-agent-id` and `x-agent-secret` against `webTransport.access.agents`. Missing, unknown, or wrong credentials return `401 {"error":"agent-auth-required"}`. Handler auth context includes `auth.mode === "agent"`, `agentId`, `peerId`, and optional `displayName` / `orgId` headers.

For app-session bridges and delegated route/tool authorization with `requires`,
see [`26-delegated-authorization.md`](./26-delegated-authorization.md).

### Reserved paths

Augments cannot register these paths (collision throws at `agent.start()`):

- `/`
- `/agent`
- `/agent/run`
- `/health`
- `/.well-known/agent-card.json`
- `/console`

Augments also cannot register routes under reserved prefixes:

- `/agent/`
- `/console/`

Convention: scope routes under `/<augment-name>/...` to make collisions across third-party augments extremely unlikely.

### Per-route safety knobs

| Field | Default | Behavior |
|---|---|---|
| `timeoutMs` | 30,000 | Handler exceeding this returns 504 and receives an aborted signal. The signal combines request disconnect and deadline cancellation. Non-cooperative work may continue, so handlers must treat post-dispatch timeout as outcome-unknown. |
| `maxBodyBytes` | 1,048,576 (1 MB) | Non-GET/HEAD request bodies are buffered up to the cap using actual bytes read. Over-cap bodies return 413 before the handler runs. |
| `rateLimit.maxPerMinute` | (no limit) | Per-route sliding-window counter, keyed on caller IP (see "Caller IP & `trustedProxies`" below). Returns 429 with `Retry-After` before body buffering. |

When `webTransport.cors` is configured, augment route `Response` objects inherit `Access-Control-Allow-Origin` and `Access-Control-Expose-Headers` unless the handler already set those headers. This applies to successful handler responses and parameter-aware 405 method mismatches.

### Route policy metadata

Routes can optionally declare descriptive policy metadata. The first supported
shape is `policy: webhook.signature(provider, { secretEnv })`, which appears in
route manifests, OpenAPI `x-auggy` metadata, route reports, and generated client
target filtering. Browser generated clients omit webhook-policy routes; server
generated clients may include them when the route auth mode is otherwise
server-callable.

`webTransport` currently verifies Stripe policies:

```ts
defineRoute.post("/webhooks/stripe", {
  auth: "none",
  policy: webhook.signature("stripe", {
    secretEnv: "STRIPE_WEBHOOK_SECRET",
  }),
  handler: ({ webhook }) => json({ event: webhook?.event }),
});
```

The transport checks the `Stripe-Signature` header against the raw buffered
request body before the handler runs, applies a 300-second timestamp tolerance
by default, and passes parsed event payload as `ctx.webhook.event`. The manifest
exposes the env var name only, never the secret value.

Other providers are still metadata-only until their verifiers land. For those
providers, augment handlers must still perform any required signature/HMAC
checks before trusting the request body.

### Caller IP & `trustedProxies`

The per-route rate limiter keys on the caller's IP. By default, `webTransport` ignores `X-Forwarded-For` / `X-Real-IP` headers and uses the connection's remote address. This is the default-secure behavior: an untrusted client could otherwise spoof those headers and skip rate limiting.

When deploying behind a proxy (Railway, Fly, Cloudflare, an in-house load
balancer), set `trustedProxies` to the immediate proxy's exact IPs or bounded
IPv4/IPv6 CIDRs:

```ts
webTransport({
  port: 8080,
  auth: { type: "bearer", token: "..." },
  trustedProxies: ["10.20.0.0/16", "2001:db8:1234::/48"],
  consoleSecurity: {
    allowedOrigins: ["https://agent.example.com"],
  },
});
```

Behavior:

- Connection IP is on `trustedProxies` → `X-Forwarded-For` is parsed right-to-left, trusted proxy hops are dropped, and the first untrusted client IP is honored. `X-Real-IP` is used only when `X-Forwarded-For` is absent.
- Connection IP is NOT on `trustedProxies` (or list is empty) → forwarding
  headers are ignored for ordinary route rate limiting. Console requests
  carrying them fail closed.
- The first time an XFF arrives without `trustedProxies` configured, a single `console.warn` per startup nudges operators with a config hint. Latched per-instance — no warning spam.
- Railway or other deployment environment markers do not grant implicit proxy
  trust.
- Malformed, ambiguous, oversized, or mixed forwarding chains fail closed at
  the console boundary. Universal CIDRs such as `0.0.0.0/0` and `::/0` are
  rejected.

For YAML configuration, place both properties under the web transport
augment's `config` block. `AUGGY_PUBLIC_URL` contributes an exact console
origin, but it does not configure or infer a trusted proxy network.

### Status codes

| Status | Trigger |
|---|---|
| 200 | Handler returned a 2xx Response. |
| 401 | `auth: "bearer"` / `auth: "creator"` route with missing/wrong bearer token, `auth: "visitor.required"` route with missing/invalid visitor token, `auth: "agent.required"` route with missing/wrong agent credentials, or Stripe/Svix webhook route with missing/invalid/stale signature. |
| 404 | No augment route matches the requested (method, path). |
| 405 | Augment registered the path for a different method. `Allow:` header lists the registered method. |
| 413 | Request body exceeded `maxBodyBytes`. |
| 429 | Per-route rate limit triggered. `Retry-After:` header set. |
| 500 | Handler threw. Body is opaque `{"error":"internal"}`; the actual error is logged to stderr with the route path. |
| 504 | Handler exceeded `timeoutMs`. |

### Limits

- HTTP only — no WebSocket route registration at v1.
- Methods: `GET` and `POST`. PUT/DELETE/PATCH not supported (no consumer needs them; smaller surface).
- Exact paths and full-segment path params are supported (`/items/:id`). Prefix routes are not supported.
- No streaming response support — handlers return discrete `Response` objects. AG-UI's SSE stays exclusive to `/agent/run`.
- Routes are frozen at `agent.start()` — no dynamic add/remove during runtime.
- Per-route auth schemes are `bearer`, `creator`, `none`, `visitor.optional`, `visitor.required`, and `agent.required`. For OAuth/custom schemes, augments wrap their handler with the additional check. `policy: webhook.signature("stripe", ...)` and `policy: webhook.signature("svix", ...)` are runtime verified by `webTransport`; providers without a verifier remain manifest/client metadata only.

## The `/console` route

The built-in `/console` route gives the creator a chat-first browser surface
for one running agent. `/console` redirects to `/console/chat`; the visible v1
UI is Chat plus Integrations and Capabilities, with a compact Details dialog
for agent identity, URLs, engine, and diagnostics. Integrations shows the
built-in endpoints, web posture, and live augment route manifest. Capabilities
maps mounted augments to routes, tools, memory providers, auth posture, and
runtime warnings. See
[`docs/21-console.md`](./21-console.md).

The `adminInfo()` composition API still backs the dashboard JSON payload,
Integrations posture actions, and augment-owned action dispatch. Older React
workbench tabs have been removed from the preview bundle; the remaining backend
endpoints are intentionally not promoted as top-level `0.5` console tabs.

### Surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/console` | SPA shell; redirects client-side to `/console/chat`. |
| `GET` | `/console/chat` | Chat surface. |
| `GET` | `/console/integrations` | Endpoint, posture, and route-manifest surface. |
| `GET` | `/console/capabilities` | Runtime map of augments, routes, tools, memory, auth posture, and warnings. |
| `GET` | `/console/api/dashboard` | Agent card, agent metadata, augment summaries, tool inventory, web posture, live route manifest, CSRF tokens, skills snapshot, and admin blocks. |
| `POST` | `/console/api/chat` | CSRF-protected chat proxy to `/agent/run`. |
| `GET` | `/console/api/chat/threads` | Authenticated conversation summaries for the creator console. |
| `GET` | `/console/api/chat/threads/<threadId>` | Authenticated conversation detail and transcript. |
| `POST` | `/console/api/chat/threads/<threadId>/rename` | CSRF-protected conversation rename. |
| `POST` | `/console/api/chat/threads/<threadId>/read-state` | CSRF-protected read/unread update. |
| `POST` | `/console/api/chat/threads/<threadId>/delete` | CSRF-protected conversation deletion. |
| `POST` | `/console/action/<id>` | Augment-level action dispatch. CSRF-protected. |
| `POST` | `/console/action/<id>/row/<rowKey>` | Row-scoped action dispatch. CSRF-protected. |

`HEAD /console` returns 405 with `Allow: GET, POST`. Other unsupported methods
on the console surface return 405.

### Opt-out

Set `adminRoute: false` in `webTransport(opts)` to disable the console surface
entirely. When disabled, requests against `/console` fall through to the 404
handler.

### Console conversation storage

When the console is enabled and the CLI supplies an agent directory, console
conversation persistence defaults to `data/console-chat.db` inside that agent
directory. On Railway the same default resolves to
`/app/data/console-chat.db` on the mounted volume.

Override the location, or explicitly select process-memory-only chat, in the
web transport augment config:

```yaml
type: webTransport
config:
  consoleChat:
    dbPath: ./data/console-chat.db # set to null for ephemeral chat
```

Relative local paths resolve from the agent directory. Under a Railway runtime
they resolve within `/app/data`; an absolute path outside the runtime data root
is rejected. Railway must mount a persistent volume at exactly `/app/data`; the
default database is `/app/data/console-chat.db`. SQLite console storage assumes
one Auggy process and one writer, so keep the service at one replica. The volume
survives process replacement but is not a backup; stop writes and capture the
database plus any WAL/SHM siblings together when making a file-level backup.

### Auth

HTTP Basic with the webTransport bearer as the password. Username is ignored:

```
authorization: Basic base64(":<bearer-token>")
```

A `WWW-Authenticate: Basic realm="auggy-admin <agent-name>"` header on 401 lets browsers prompt for credentials. Bearer comparison is timing-safe.

### HTTPS-on-non-loopback gate

When the caller IP is not loopback (not in `127.0.0.0/8`, not `::1`, not IPv4-mapped loopback), the route returns `426 Upgrade Required` with a body explaining how to either expose HTTPS or use an SSH tunnel. The gate fires BEFORE the bearer check, so an attacker probing over plain HTTP cannot learn whether the bearer is correct.

The body is a plain-text guidance message (transcribed from `src/transports/admin/admin-auth.ts`):

```
/console requires HTTPS on non-loopback addresses.

Options:
  1. Configure HTTPS termination in front of this agent.
  2. Access via http://127.0.0.1:<port>/console from the agent host.
  3. SSH tunnel: ssh -L <port>:127.0.0.1:<port> user@host
```

### CSRF

Every POST against `/console/action/*` requires a `_csrf` token in the form
body. `POST /console/api/chat` requires a JSON `csrf` token bound to the
`console-chat` action.

Tokens are HMAC-SHA256 over `<agentName>|<unix-ts>|<actionId>|<rowKey-or-empty>`, signed with the bearer. Format: `<base64url(sig)>.<unix-ts>`.

| Property | Behavior |
|---|---|
| Bearer rotation | Invalidates all prior tokens. |
| Action binding | A token for `posture-flip` will not validate against `posture-reset`. |
| Row binding | A row-scoped token tied to `rowKey=vis_a` will not validate for `rowKey=vis_b`. |
| Expiry | 24h (`CSRF_TTL_SECONDS = 24 * 3600`); future-skew tolerance 60s. |

Validation returns a rich result: `{valid: true}` or `{valid: false; reason: "expired" | "tampered" | "malformed"}`. **Expired** action tokens return `200 OK` with an HTML meta-refresh back to `/console`. **Tampered** and **malformed** return `403`.

### Rate limiting

Per-IP combined rate limit across the console surface: **60 requests / minute**,
synthetic route-key `"admin"` for compatibility with existing internals.
Returns `429` with `Retry-After`. Honors `trustedProxies` for
`X-Forwarded-For`.

### Composition — the `adminInfo()` contract

Each augment that owns inspectable state declares two optional fields on the `Augment` interface:

```ts
interface Augment {
  // ... existing
  adminInfo?: () => Promise<AdminInfoBlock>;
  adminActions?: Record<string, AdminActionHandler>;
}
```

`adminInfo()` returns a block of section primitives:

- **`keyValue`** — labelled rows with optional `source` annotation (`yaml` / `env` / `/console override`) and optional `resetAction`. Used for live posture display and operator-tunable knobs.
- **`table`** — columnar rows with optional `rowActions` (per-row buttons; rowKey extracted from a chosen column index).
- **`status`** — single-line status with `level: "ok" | "info" | "warn" | "error"`.
- **`eventStream`** — recent-events stream (currently rendered as a table; reserved for the deferred Tier-2 telemetry pipeline).

`adminActions[id]` is the handler invoked on POST. Returns `{ok, message}` for the redirect's flash.

At boot, `buildAdminActionRegistry` walks every mounted augment's `adminInfo()` declarations and constructs a global action registry. **Action ids must be globally unique across augments** — collisions throw at boot. Declared actions without a matching handler also throw at boot — the runtime-bomb pattern (handlers missing, only discovered at first POST) cannot occur.

### Persistence — `admin-overrides.json`

Runtime-mutable knobs persist across restart via `<agentDir>/admin-overrides.json`:

| Knob | Owning augment | Override action | Reset action |
|---|---|---|---|
| `allowAnonymous` | `webTransport` | `posture-flip` | `posture-reset` |
| `publicIntegration` | `webTransport` | `posture-public-integration-set` | n/a |
| `dailyBudgetUsd` | `budgets` | `budget-cap-adjust` | `budget-cap-reset` |
| `globalMaxPerHour` | `notify` | `notify-cap-adjust` | `notify-cap-reset` |

Schema is Zod-validated (`{version: 1, lastModified, lastModifiedBy, overrides: {...}}`). File is written atomically (temp + rename) with `0o600` mode. Each augment reads its override at construction time and applies it on top of yaml + env precedence; subsequent admin POSTs persist back via `writeOverrides()` BEFORE mutating the closure — S7 ordering ensures a write failure leaves agent state unchanged.

Resets clear the relevant field from the file (and the augment object key if the field was the last child); the augment re-resolves from yaml/env/default.

### Audit log

Every **dispatched** action emits a structured `console.log` line (i.e., the POST passed auth + CSRF + registry lookup + input coercion and reached the handler):

```
[admin] actor=creator action=<id> rowKey=<key|-> result=<ok|fail> message=<json-quoted>
```

Captured by Bun's stdout/stderr → operator-grep'able. A dedicated audit file is deferred (Tier-2 follow-up; the telemetry-exporter pattern in `lo/telemetry-exporter/` is the planned destination).

Currently NOT logged: rejected POSTs (CSRF failure, unknown action id, input coercion failure). Adding audit lines on the reject branches is a known gap — silent CSRF reject masks probing attempts. Filed as G36-followup.

### Reserved paths

`/console` is reserved; augments cannot register routes there. The route
collector enforces both exact path collisions and the scoped `/console/`
prefix.

### Operator workflow

```bash
# Set up agent with console enabled (default).
auggy create my-agent

# Start the agent.
auggy run my-agent

# Open the console.
open http://localhost:8080/console/chat

# From a remote host? SSH tunnel first — the HTTPS gate blocks non-loopback over HTTP.
ssh -L 8080:127.0.0.1:8080 my-host
```

### What's not in v1

- **Config/workbench tabs** — deferred until adopter signal proves they belong in the browser.
- **Pagination-heavy inspectors** — memory, visitors, traces, and full manifest/schema browsers are post-v1.
- **Multiple operators** — single bearer = single creator. Operator delegation is out of scope.
- **Action audit file** — `console.log` only.

## Multi-transport composition

Auggy's kernel multiplexes turns from N mounted transports into shared agent
state. Each transport is a separate augment with its own source policy,
identity resolver, and boot lifecycle; all share the agent-wide scheduler.

### How the kernel handles multiple transports

When `defineAgent` boots an agent with multiple transport augments, each
transport calls `register(kernel, augmentName)` independently. The handles are
backed by the same turn loop, history cache, memory bus, and keyed scheduler.
Each transport retains source-specific concurrency, depth, and rate policy
inside that common boundary.

Inbound updates from any transport reach the shared turn loop via `kernel.handleInbound(trigger)`. The trigger includes `trigger.source`, which is the `augmentName` the transport received at registration time. After the turn runs, any `OutboundMessage`s the kernel emits are dispatched via `agent.outboundHandlers`, which is keyed by augment name — so replies route back to the originating transport automatically.

### The `TransportSpec.register` signature change (Phase B, commit `0710e2f`)

The original `register(kernel)` signature gave the transport no way to know its operator-assigned runtime name. This worked for a single transport, but broke outbound dispatch for multi-transport setups: `telegramTransport` hardcoded `"telegram-transport"` as `trigger.source`, while `outboundHandlers` was keyed by the operator-chosen name (e.g. `"telegram"`). The mismatch caused every kernel-emitted reply to be silently dropped.

The fix: `register(kernel, augmentName)` passes the operator-assigned name at registration time. Transports SHOULD use this value as `trigger.source` so the outbound dispatch loop finds the right handler. `webTransport` accepts the parameter but currently ignores it — its `onOutbound` is unused since the web transport's response path is synchronous.

### `peer.id` namespacing across transports

Most non-creator peer identities are namespaced by transport. The v1 creator is
the deliberate exception: verified creator surfaces map to the canonical
`peer.id = "creator"` so budgets and layered memory see one owner identity
across web console and Telegram private chat.

| Transport | Recognized / agent peers | Anonymous peers |
|---|---|---|
| `webTransport` | `creator` (bearer), `vis_<uuid>` (visitor token), or `agent:<agentId>` | `anon_session_<uuid>` authenticated by a 24-hour signed capability |
| `telegramTransport` | `creator` (private chat from configured creator user ID), configured agent IDs, or `tg_user_<userId>` (recognized public) | `tg_anon_<threadId>` (ephemeral) or `tg_user_<userId>` (durable) |

The non-creator prefixes are chosen to be non-overlapping by construction. A
visitor token `vis_` UUID cannot coincide with a Telegram `tg_user_` ID. Memory
writes, budget counters, and layered-memory scoping all key on `peer.id`, so
identity mappings here are security-sensitive.

### Example `agent.yaml` — mounting both transports

```yaml
augments:
  - name: web
    type: webTransport
    options:
      port: 8080
      auth:
        type: bearer
        token: ${WEB_AUTH_TOKEN}
      visitorTokens:
        enabled: true

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

Both augments start at the same time. The `web` transport serves the AG-UI HTTP endpoint; the `telegram` transport polls for Telegram updates. Turns from either transport run through the same kernel, share history per thread, and share the same memory, tools, and budget counters.

For full configuration options, see:
- [docs/13-notify.md](./13-notify.md) — the `notify` augment for proactive outbound messages across both transports
- [docs/14-telegram-transport.md](./14-telegram-transport.md) — `telegramTransport` full operator reference

## Distributed coordination topology (preview contract)

`settings.coordination` reserves a stable PostgreSQL coordination namespace for a
logical agent. It contains only a database environment-variable *name*, never a
database URL or credential:

```yaml
settings:
  coordination:
    mode: postgres
    namespace: 5d9b9796-65ba-43d0-9ba9-57f1a9db5ef7
    fleetCapacity:
      maxConcurrent: 8
      maxQueued: 200
      maxQueuedPerThread: 25
    # urlEnv defaults to AUGGY_COORDINATION_DATABASE_URL
    leaseDurationMs: 30000
    heartbeatIntervalMs: 5000
    claimPollMs: 100
    maxWaitMs: 30000
```

This is deliberately a **fail-closed declaration**, not an instruction to run
multiple replicas yet. Current fleet admission, thread serialization, history
commits, idempotency, quarantine, mutable augment stores, and outbound delivery
are process-local or unfenced. The local keyed scheduler will remain the
per-process executor behind a future fleet coordinator. Runtime preflight must
also verify shared budgets, replay ledgers, mutable memory, visitor state, and a
durable fenced delivery outbox before it can enable distributed execution.
Until then deploy one runtime replica for each logical agent namespace.
`fleetCapacity` is an explicit fleet-wide contract: its values are not defaults
for `turnScheduling` and are never multiplied by replica count.

Provision the dedicated coordination database explicitly; the command reads
only the environment variable named by `urlEnv`, never a URL in `agent.yaml`:

```sh
auggy coordination migrate --config ./agent.yaml
```

It prints only the applied schema identifiers plus an explicit reminder that
runtime replicas remain unsupported. It does not start the agent or enable
replicas. Remote PostgreSQL endpoints must use `sslmode=verify-full`;
plaintext or opportunistic TLS is accepted only for exact localhost and
literal loopback development endpoints.
