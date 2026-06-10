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
  rateLimitPerPeer?: { maxPerMinute: number };
}
```

**`register(kernel, augmentName)`** is called once at agent startup. The transport receives a `TransportKernel` view onto the runtime — a small interface with three methods (`handleInbound`, `onOutbound`, `getAgentCard`). The transport also receives `augmentName`, the operator-chosen runtime name for this augment instance (e.g. `"web"`, `"telegram"`). The transport stores both references and uses them to feed inbound requests.

The `augmentName` parameter was added in commit `0710e2f` (Phase B) to support correct outbound dispatch. See the multi-transport composition section below for why this matters.

**`identify(raw)`** is a pure function from "whatever the transport's wire format hands you" to `PeerIdentity | null`. It runs once per inbound request, before the request enters the queue. Returning `null` means "I cannot identify this peer" — the transport is responsible for what to do with that (the web transport returns a 400 error).

The web transport's `identify()` reads `x-peer-id`, `x-peer-kind`, `x-peer-name`, and `x-org-id` headers from a request and returns a `PeerIdentity` with `trustLevel` set from `opts.trustLevel` (default `"public"`). A future spine transport would read auth tokens from a different envelope and probably set `trustLevel: "agent"`.

**`concurrency`**, **`maxQueueDepth`**, and **`rateLimitPerPeer`** are configuration for the per-transport queue that the runtime constructs when the agent starts. Defaults: `1`, `50`, none. See [04-kernel.md § transport-queue.ts](./04-kernel.md#srckerneltransport-queuets--per-transport-queue) for details.

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
  cors?: { origins: string[] };
  maxMessageLength?: number;     // default 4000
  access?: { agents?: AgentAccessEntry[] };  // admitted agent list
  concurrency?: number;          // default 1
  maxQueueDepth?: number;        // default 50
  rateLimitPerPeer?: { maxPerMinute: number };
  visitorTokens?: {
    enabled?: boolean;       // default true
    ttlSeconds?: number;     // default 30 days
    signingKey?: string;     // derive from VISITOR_SIGNING_KEY; ephemeral if absent
  };
  publicFrontendUrl?: string;    // optional 302 redirect target for GET /
  publicIntegration?: boolean;   // publish developer discovery: /agent + public agent-card JSON
}
```

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/agent/run` | AG-UI SSE endpoint. Streams events for one turn. |
| `GET` | `/` | Optional 302 redirect to `publicFrontendUrl`; otherwise a minimal public placeholder. |
| `GET` | `/agent` | Optional published developer integration page when `publicIntegration: true`. |
| `GET` | `/health` | Liveness check. Returns `{status: "healthy"}`. |
| `GET` | `/.well-known/agent-card.json` | Agent card discovery. Published only when `publicIntegration: true`; otherwise bearer-only. |
| (anything else) | `404 Not Found` |

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

If the `Idempotency-Key` header is present, it is validated and used as `turnId`:

```ts
// Valid: 1–128 chars matching [A-Za-z0-9_-]
turnId = idempotencyKey;    // used as trigger.turnId
```

Malformed key → HTTP 400. Absent → fresh `crypto.randomUUID()`.

When the budgets augment is mounted, `turnId` is also the primary key of `turn_reservations`. Retrying with the same `Idempotency-Key` hits the store's PK conflict path — the reservation already exists and the store returns the cached decision rather than re-evaluating caps. This is what makes retries safe under budget caps.

#### 3. Identity resolution — four paths

Identity is resolved in a fixed priority order:

**Path 1 — Creator:** bearer token valid AND no `x-agent-id`/`x-agent-secret` headers AND no `x-visitor-token` header. Mints `{ trustLevel: "creator", id: "creator" }`.

**Path 2 — Agent:** `x-agent-id` and `x-agent-secret` headers both present. Looks up the agent ID in `opts.access.agents`; performs a timing-safe secret comparison. If the secret matches, mints `{ trustLevel: "agent", id: "agent:<agentId>" }`. Wrong secret → HTTP 401 immediately — no silent downgrade to public trust.

**Path 3 — Public recognized:** `x-visitor-token` header present and HMAC-verified. Mints `{ trustLevel: "public", publicSubstate: "recognized", id: "<visitorId from token>" }`. The visitor's ID is durable across sessions — memory writes attach to it.

**Path 4 — Public anonymous:** default path. Mints `{ trustLevel: "public", publicSubstate: "anonymous", id: "anon-<threadId>" }`. For fresh anonymous visitors, the transport issues a new visitor token in the `x-visitor-token` response header so subsequent requests can become "recognized."

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
const threadId = body.threadId ?? body.contextId ?? crypto.randomUUID();
const parts: Part[] = [{ kind: "text", text }];
const inbound: InboundMessage = { parts, sourceAugment: "web", peer, timestamp: Date.now(), contextId: body.contextId, taskId: body.taskId };
const trigger: TurnTrigger = { type: "message", turnId: crypto.randomUUID(), threadId, contextId: body.contextId, taskId: body.taskId, timestamp: Date.now(), source: "web", peer, payload: inbound };
```

The `threadId` is taken from the request if present, otherwise minted fresh. This is what makes a new conversation actually new — clients that don't pass a `threadId` get a per-request thread, which means the agent's history doesn't carry across requests.

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

When a turn is rejected (queue full, rate limit, or turn-gate denial), the transport synthesizes `RUN_ERROR` + `RUN_FINISHED` events — the kernel emits no events for turns that don't run. The `code` field on `RUN_ERROR` is:

| Rejection source | `errorClass` | SSE `code` |
|---|---|---|
| Turn-gate cap denied | `"cap-denied"` | `"CAP_DENIED"` |
| Turn-gate confirm error | `"admission-state-failed"` | `"ADMISSION_FAILED"` |
| Queue full / rate limit | _(none)_ | `"REJECTED"` |
| Unhandled exception | _(none)_ | `"INTERNAL"` |

**HTTP status remains 200** for the SSE stream in v0. The gate decision is embedded in the stream rather than in the HTTP status because the Response must be opened before the kernel's 2PC result is known (the stream starts synchronously; the turn runs inside the async IIFE). A future enhancement (T5) adds a synchronous gate-decision API that would allow the transport to return 429 or 503 before opening the stream at all.

### Why the rejection events are synthesized in the transport

The transport-queue rejects requests without ever calling the turn loop. That means **no kernel events fire** — the turn loop never ran. The kernel can't emit events for a turn that didn't happen.

The transport has to detect this case (by checking `result.status === "rejected"`) and synthesize the error event itself. This is a layering choice: we could have made the transport-queue emit a kernel event when it rejects, but kernel events are scoped to a turn that's running, and a rejected turn doesn't have a running turn loop. Putting the synthesis in the transport is cleaner.

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

Returns the JSON-encoded `AgentCard`. The card was generated once at `defineAgent` time and cached.

The path `/.well-known/agent-card.json` is an A2A convention — A2A discovery clients know to check this path on any agent host. Auggy keeps that discovery private by default: unauthenticated requests return `404` unless the creator sets `webTransport.options.publicIntegration: true`. Creator/developer requests with the web bearer can still fetch the card while public discovery is disabled.

`publicIntegration: true` publishes developer discovery surfaces only. It does **not** make `POST /agent/run` unauthenticated, does **not** expose `/console`, and does **not** publish secrets or operator-only setup details.

### `GET /agent` and `HEAD /agent` — optional published developer integration page

`/agent` is the human-readable companion to the agent card. It is disabled by default and returns `404`.

When `publicIntegration: true`, `GET /agent` returns a conservative public HTML page containing:

- Agent name and public-safe purpose
- Protocol-level summary
- Link to `/.well-known/agent-card.json`
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

**Auth posture.** The default `/` page is unauthenticated and intentionally minimal. Developer discovery is separate and private by default: `publicIntegration: true` is the creator's explicit decision to publish `/agent` and the agent card. It does not change `/agent/run` authentication or `/console` access.

For local operator testing, run `auggy chat` instead — it provides a polished
chat surface against agents you've started with `auggy dev`, without exposing a
public URL.

**Uptime / health checks:** point them at `/health`, not `/`. The `/` route is for visitors; `/health` is for monitoring.

### Lifecycle hooks

```ts
return {
  name: "web",
  capabilities: ["transport"],
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

## Per-transport concurrency and queueing

When `defineAgent.start()` registers a transport, it constructs a `TransportQueue` around it:

```ts
const queue = createTransportQueue({
  concurrency: aug.transport.concurrency ?? 1,
  maxQueueDepth: aug.transport.maxQueueDepth ?? 50,
  rateLimitPerPeer: aug.transport.rateLimitPerPeer,
});
```

The `TransportKernel`'s `handleInbound` method wraps the actual turn-loop call in `queue.enqueue(trigger, handler)`. This means **every inbound request goes through the queue** before reaching the kernel. The queue enforces:

- **Rate limit per peer** — sliding 60-second window, configurable max.
- **Max queue depth** — if more than `maxQueueDepth` requests are waiting, new ones get rejected immediately.
- **Concurrency cap** — only `concurrency` turns run at once. Excess requests wait.

For the web transport, the default concurrency is 1 (one turn at a time) which is appropriate for an agent that expects to be talked to by one peer at a time. Bumping concurrency lets multiple peers' turns run in parallel — which is safe because each turn has its own `TurnState`, history is per-thread, and the kernel doesn't share mutable state across turns.

## Why the kernel doesn't speak protocols

Every protocol decision in Auggy is in the transport, not the kernel:
- **AG-UI event names** — `web-transport.ts` and `ag-ui-events.ts` only.
- **HTTP routing, status codes, headers** — `web-transport.ts` only.
- **SSE frame format** — `ag-ui-events.ts` only.
- **Bearer token auth** — `web-transport.ts` only.
- **Rate limiting policy** — `transport-queue.ts` (kernel-side, but configured per transport).
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
- **Full A2A wire format** — the spine transport (Plan 4) will speak A2A natively.
- **MCP server transport** — Plan 6.
- **Cancellation from the client side** — the client closing the SSE stream doesn't currently abort the kernel turn.
- **Synchronous gate-decision API (T5)** — would allow returning 429/503 before opening the stream, replacing the current in-stream error code approach.
- **CORS preflight handling** — the `cors` option exists; OPTIONS requests return 204 with allowed headers. Full CORS negotiation (multiple origins, credentials) is not implemented.
- **WebSocket transport** — SSE only.
- **Outbound dispatch via web** — the `onOutbound` callback exists but the web transport doesn't have a way to push messages to the peer (one-shot HTTP request/response). A WebSocket version would.

## Augment-registered HTTP routes (PR γ.1)

Augments can register HTTP routes that `webTransport` serves alongside its built-in paths. Routes are collected at `agent.start()` after every augment's `onBoot` runs and before any port binds — collisions throw early, never silently override.

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

- `"bearer"` — the route inherits webTransport's bearer-token check. Use for any route that represents a creator-authenticated action.
- `"none"` — the route accepts any caller. Use ONLY for genuinely public callbacks (email click-backs, OAuth redirects). The boot log emits a `console.warn` per `auth: "none"` route so operators see the unauthenticated surfaces.
- `"visitor.optional"` — the route accepts anonymous callers but resolves a recognized visitor when a valid `x-visitor-token` is present. The boot log warns because the route is still anonymous-callable.
- `"visitor.required"` — the route requires a valid `x-visitor-token`. Missing, invalid, expired, wrong-agent, or revoked tokens return `401 {"error":"visitor-auth-required"}`. Handler auth context always includes `visitorId`; when `visitorAuth` or another `identityLookup` is mounted, it can also include `email`, `verifiedAt`, and `reverifyDueAt`.

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
| `timeoutMs` | 30,000 | Handler exceeding this returns 504. The handler's promise is not cancelled (continues running; result discarded). |
| `maxBodyBytes` | 1,048,576 (1 MB) | Request with `content-length` over the cap returns 413 before the handler runs. |
| `rateLimit.maxPerMinute` | (no limit) | Per-route sliding-window counter, keyed on caller IP (see "Caller IP & `trustedProxies`" below). Returns 429 with `Retry-After`. |

### Caller IP & `trustedProxies`

The per-route rate limiter keys on the caller's IP. By default, `webTransport` ignores `X-Forwarded-For` / `X-Real-IP` headers and uses the connection's remote address. This is the default-secure behavior: an untrusted client could otherwise spoof those headers and skip rate limiting.

When deploying behind a proxy (Railway, Fly, Cloudflare, an in-house load balancer), set `trustedProxies` to the proxy's IP(s):

```ts
webTransport({
  port: 8080,
  auth: { type: "bearer", token: "..." },
  trustedProxies: ["10.0.0.5"],  // your proxy's IP
});
```

Behavior:

- Connection IP is on `trustedProxies` → first `X-Forwarded-For` value (else `X-Real-IP`) is honored.
- Connection IP is NOT on `trustedProxies` (or list is empty) → headers ignored, connection IP used directly.
- The first time an XFF arrives without `trustedProxies` configured, a single `console.warn` per startup nudges operators with a config hint. Latched per-instance — no warning spam.

CIDR ranges are not yet supported (v1 keeps it simple); list the exact IPs.

### Status codes

| Status | Trigger |
|---|---|
| 200 | Handler returned a 2xx Response. |
| 401 | `auth: "bearer"` route with missing/wrong bearer token, or `auth: "visitor.required"` route with missing/invalid visitor token. |
| 404 | No augment route matches the requested (method, path). |
| 405 | Augment registered the path for a different method. `Allow:` header lists the registered method. |
| 413 | Request `content-length` exceeded `maxBodyBytes`. |
| 429 | Per-route rate limit triggered. `Retry-After:` header set. |
| 500 | Handler threw. Body is opaque `{"error":"internal"}`; the actual error is logged to stderr with the route path. |
| 504 | Handler exceeded `timeoutMs`. |

### Limits

- HTTP only — no WebSocket route registration at v1.
- Methods: `GET` and `POST`. PUT/DELETE/PATCH not supported (no consumer needs them; smaller surface).
- Exact paths and full-segment path params are supported (`/items/:id`). Prefix routes are not supported.
- No streaming response support — handlers return discrete `Response` objects. AG-UI's SSE stays exclusive to `/agent/run`.
- Routes are frozen at `agent.start()` — no dynamic add/remove during runtime.
- Per-route auth schemes are `bearer`, `none`, `visitor.optional`, and `visitor.required`. For OAuth/HMAC/custom schemes, augments wrap their handler with the additional check.

## The `/console` route

The built-in `/console` route gives the creator a chat-first browser surface
for one running agent. `/console` redirects to `/console/chat`; the visible v1
UI is chat plus a compact Details dialog for agent identity, URLs, engine, and
diagnostics. See [`docs/21-console.md`](./21-console.md).

The older `adminInfo()` composition API still backs JSON endpoints and
augment-owned action dispatch. Those endpoints are intentionally not exposed as
top-level v1 tabs.

### Surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/console` | SPA shell; redirects client-side to `/console/chat`. |
| `GET` | `/console/chat` | Chat surface. |
| `GET` | `/console/api/dashboard` | Agent card, agent metadata, augment summaries, CSRF tokens, and admin blocks for future developer tools. |
| `POST` | `/console/api/chat` | CSRF-protected chat proxy to `/agent/run`. |
| `POST` | `/console/action/<id>` | Augment-level action dispatch. CSRF-protected. |
| `POST` | `/console/action/<id>/row/<rowKey>` | Row-scoped action dispatch. CSRF-protected. |

`HEAD /console` returns 405 with `Allow: GET, POST`. Other unsupported methods
on the console surface return 405.

### Opt-out

Set `adminRoute: false` in `webTransport(opts)` to disable the console surface
entirely. When disabled, requests against `/console` fall through to the 404
handler.

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

- **Config/admin tabs** — deferred until adopter signal proves they belong in the browser.
- **Pagination-heavy inspectors** — memory, visitors, traces, and manifest browsers are post-v1.
- **Multiple operators** — single bearer = single creator. Operator delegation is out of scope.
- **Action audit file** — `console.log` only.

## Multi-transport composition

Auggy's kernel multiplexes turns from N mounted transports into shared agent state. Each transport is a separate augment with its own queue, its own identity resolver, and its own boot lifecycle. The kernel never talks directly to individual transports — everything flows through the `TransportSpec`/`TransportKernel` interface described above.

### How the kernel handles multiple transports

When `defineAgent` boots an agent with multiple transport augments, each transport calls `register(kernel, augmentName)` independently. The `kernel` handle passed to each transport is backed by the same turn loop, the same history manager, and the same memory bus — but each transport gets its own `TransportQueue` (independent concurrency, depth, and rate-limit counters).

Inbound updates from any transport reach the shared turn loop via `kernel.handleInbound(trigger)`. The trigger includes `trigger.source`, which is the `augmentName` the transport received at registration time. After the turn runs, any `OutboundMessage`s the kernel emits are dispatched via `agent.outboundHandlers`, which is keyed by augment name — so replies route back to the originating transport automatically.

### The `TransportSpec.register` signature change (Phase B, commit `0710e2f`)

The original `register(kernel)` signature gave the transport no way to know its operator-assigned runtime name. This worked for a single transport, but broke outbound dispatch for multi-transport setups: `telegramTransport` hardcoded `"telegram-transport"` as `trigger.source`, while `outboundHandlers` was keyed by the operator-chosen name (e.g. `"telegram"`). The mismatch caused every kernel-emitted reply to be silently dropped.

The fix: `register(kernel, augmentName)` passes the operator-assigned name at registration time. Transports SHOULD use this value as `trigger.source` so the outbound dispatch loop finds the right handler. `webTransport` accepts the parameter but currently ignores it — its `onOutbound` is unused since the web transport's response path is synchronous.

### `peer.id` namespacing across transports

Each transport uses a distinct `peer.id` prefix. This ensures no peer identity collisions across transport boundaries even if the same human uses both Telegram and the web chat:

| Transport | Recognized / agent peers | Anonymous peers |
|---|---|---|
| `webTransport` | `vis_<uuid>` (visitor token) or `agent:<agentId>` | `anon-<threadId>` |
| `telegramTransport` | `tg_user_<userId>` (creator/agent/recognized) | `tg_anon_<threadId>` (ephemeral) or `tg_user_<userId>` (durable) |

The prefixes are chosen to be non-overlapping by construction. A visitor token `vis_` UUID cannot coincide with a Telegram `tg_user_` ID. Memory writes, budget counters, and layered-memory scoping all key on `peer.id` — the prefix isolation means each transport's peers are fully independent.

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
