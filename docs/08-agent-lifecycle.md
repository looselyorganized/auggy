# 08 — Agent Lifecycle

> `defineAgent`, `AgentHandle`, the augment lifecycle hooks, and the agent card. How a config becomes a running agent.

## The flow at a glance

```
defineAgent(config, model)        ─┐
   │                               │  construction
   ▼                               │
returns AgentHandle                ─┘
   │
   │
agent.start()                     ─┐
   │                               │
   ├─ lifecycle.boot()             │
   ├─ register transports          │  startup
   └─ start idle timer             │
                                  ─┘
   │
(running — turns happen via transports or inject)
   │
   │
agent.stop()                      ─┐
   │                               │  shutdown
   ├─ stop idle timer              │
   └─ lifecycle.shutdown()         │
                                  ─┘
```

There are three phases — **construction**, **startup**, and **runtime** — plus a shutdown sequence. This doc walks through each.

## Phase 1 — Construction (`defineAgent`)

```ts
import { defineAgent } from "augment-1";

const agent = defineAgent({
  name: "zip",
  purpose: "LORF front-door agent",
  model: "claude-sonnet-4-6",
  augments: [identity, episodic, webTransport],
}, modelClient);
```

`defineAgent` is **synchronous** — it does not call any async operations, does not do IO, does not start anything. It builds an `AgentHandle` and returns it. The handle is dormant until `start()` is called.

What it does internally, in order:

### 1. Create the tokenizer

```ts
const tokenizer = createTokenizer();
```

Default tokenizer is character-divided-by-4. Used by the context allocator and the history manager. (See [04-kernel.md § tokenizer](./04-kernel.md) — the tokenizer is a small module separate from the kernel.)

### 2. Wire the memory bus

```ts
const wiring = wireMemoryBus(config.augments);
const effectiveAugments = wiring.syntheticToolsAugment
  ? [...wiring.augmentsWithSynthesizedContext, wiring.syntheticToolsAugment]
  : wiring.augmentsWithSynthesizedContext;
```

This is the most consequential thing `defineAgent` does. The memory bus:
- Detects every augment with a `memory` field.
- Builds the registry, throwing on conflicts.
- Synthesizes `context()` for memory providers that don't already have one.
- Creates the synthetic `memory-bus` augment (with the four generic tools and the budget reset hook) if any providers exist.
- Returns the new augment list with synthesis applied.

The result is `effectiveAugments` — what the rest of the kernel sees. **Every downstream component uses `effectiveAugments`, never the raw `config.augments`.** This is what makes the synthetic memory tools "real" from the kernel's perspective.

See [05-memory-subsystem.md](./05-memory-subsystem.md) for the details of what `wireMemoryBus` does.

### 3. Build the effective config

```ts
const effectiveConfig: AgentConfig = {
  ...config,
  augments: effectiveAugments,
};
```

This is the config the lifecycle manager and turn loop are constructed from. The user's original `config.augments` is never touched after this point.

### 4. Generate the agent card

```ts
const agentCard: AgentCard = generateAgentCard(effectiveConfig);
```

The card is built **once at construction time**, from the effective config. This means:

- The `memory-bus`'s four generic tools show up under `extensions.auggy.tools` (because they're in `effectiveAugments`).
- `capabilities.memory` is `true` if any augment has a `memory` field.
- `capabilities.transport` is `true` if any augment has a `transport` field.
- The card is cached for the agent's lifetime — calls to `agent.card()` and `transportKernel.getAgentCard()` return the same object.

The card is immutable after construction. If you change augments at runtime (which you can't, because there's no API to do that), the card wouldn't update. This is intentional — the card represents what the agent *advertised at startup*, and changing it mid-flight would invalidate any consumer that cached it.

See [03-types.md § agent card](./03-types.md#section-12--agent-card-a2a-discovery) for the card schema.

### 5. Construct the lifecycle manager

```ts
const lifecycle = createLifecycleManager({
  name: effectiveConfig.name,
  augments: effectiveAugments,
  model,
});
```

The lifecycle manager owns boot, shutdown, the idle timer, and health reporting. It is constructed but does nothing until `agent.start()` calls `lifecycle.boot()`.

See [04-kernel.md § lifecycle-manager](./04-kernel.md#srckernellifecycle-managerts--lifecycle-manager) for what it does.

### 6. Construct the turn loop

```ts
const turnLoop = createTurnLoop({
  augments: effectiveAugments,
  model,
  tokenizer,
  config: effectiveConfig,
});
```

The turn loop is constructed once and reused for every turn. It owns the capability table, the trace emitter, and the per-thread history managers. It does not run anything until `executeTurn` is called.

### 7. Build the `AgentHandle` and return it

```ts
const handle: AgentHandle = {
  start(),
  stop(),
  ready(),
  health(),
  card(),
  inject(trigger),
};
return handle;
```

After `defineAgent` returns:
- The agent has not started.
- No augment's `onBoot` has fired.
- No transport is listening.
- The model client has not been called.
- `effectiveAugments` is built and the agent card is cached.

This is the "configured but dormant" state. You can hold an `AgentHandle` indefinitely without doing anything.

## Phase 2 — Startup (`agent.start()`)

```ts
await agent.start();
```

`start()` is async and **must be awaited**. It does the following in order:

### 1. Boot all augments

```ts
await lifecycle.boot();
```

Inside the lifecycle manager:

```ts
for (const aug of augments) {
  try {
    if (aug.onBoot) await aug.onBoot();
    augmentStatus.set(aug.name, { status: "ok" });
  } catch (err) {
    augmentStatus.set(aug.name, { status: "failed", error: String(err) });
    throw new Error(`Augment "${aug.name}" failed to boot: ${err}`);
  }
}
```

Two important properties:

**Sequential, in declared order.** If you have `[identity, episodic, web]`, `identity.onBoot` runs first, completes, then `episodic.onBoot`, then `web.onBoot`. There is no parallelism. This matters because augments may have dependencies — e.g. a memory provider that the transport needs to know about must boot first.

**Fail-fast.** If any augment's `onBoot` throws, the lifecycle manager throws immediately, with a wrapped error message identifying the failing augment. The remaining augments **do not boot**. The agent fails to start.

This is intentional: a half-booted agent is worse than a non-running agent. If one augment is broken, you want to know immediately, not after some turns succeed and others mysteriously fail.

### 2. Register transports

```ts
for (const aug of effectiveAugments) {
  if (aug.transport) {
    const queue = createTransportQueue({
      concurrency: aug.transport.concurrency ?? 1,
      maxQueueDepth: aug.transport.maxQueueDepth ?? 50,
      rateLimitPerPeer: aug.transport.rateLimitPerPeer,
    });

    const transportKernel: TransportKernel = {
      handleInbound: ...,
      onOutbound: ...,
      getAgentCard: () => agentCard,
    };

    await aug.transport.register(transportKernel);
  }
}
```

For each augment with a `transport` field:

1. **Construct a `TransportQueue`** with the augment's queue config (concurrency, max queue depth, rate limit). Each transport gets its own queue — they don't share.

2. **Build a `TransportKernel` view.** This is the small interface the transport sees. It doesn't expose the full kernel — only `handleInbound`, `onOutbound`, and `getAgentCard`. The transport cannot reach into the agent for anything else.

3. **`await aug.transport.register(transportKernel)`.** This is what the transport uses to "wake up." The web transport's `register` is a no-op — it just stores the kernel reference. Other transports (e.g. a future spine transport) might do more work here (subscribing to a queue, opening a connection).

**Note that `register` is awaited.** If a transport's `register` is slow (e.g. it needs to handshake with an external service), `agent.start()` blocks until it's done. This is the correct behavior — the agent isn't fully started until all transports are registered.

### 3. Start the idle timer

```ts
lifecycle.startIdleTimer(async () => {
  for (const aug of effectiveAugments) {
    if (aug.onIdle) {
      try { await aug.onIdle(); }
      catch { /* swallow */ }
    }
  }
});
```

The idle timer is a `setInterval` that fires every 5 minutes (default). Every time it fires, all augments with an `onIdle` hook get called. Errors are swallowed — the timer keeps firing.

The timer is **reset every time a turn happens** (via `lifecycle.resetIdleTimer()` in the transport handler and in `inject()`). This means:
- If an agent is busy, idle hooks never fire.
- If an agent has been idle for 5 minutes, idle hooks fire.
- After idle hooks complete, the timer resets and waits another 5 minutes.

In v1 nothing actually uses `onIdle` — it's reserved for future memory consolidators, background indexers, etc.

### 4. Mark started

```ts
started = true;
```

A flag the `AgentHandle.ready()` method checks.

After `start()` returns:
- All augments have booted successfully (or `start()` threw).
- All transports have been registered. The web transport's HTTP server is listening.
- The idle timer is running.
- Inbound requests can flow.

## Phase 3 — Runtime

While the agent is running, three things can happen:

### A. A transport receives an inbound request

The transport calls `transportKernel.handleInbound(trigger, { onEvent })`. Inside `agent.ts`:

```ts
async handleInbound(trigger, opts) {
  return queue.enqueue(trigger, async (t) => {
    lifecycle.resetIdleTimer();
    const threadId = t.threadId ?? t.turnId;
    const result = await turnLoop.executeTurn(t, threadId, { onEvent: opts?.onEvent });

    await dispatchOutbound(result, t);

    // Eager compaction
    const historyBudget = Math.floor(model.maxContextTokens * ((config.contextBudget?.historyPercent ?? 40) / 100));
    turnLoop.getHistoryManager(threadId).compact(historyBudget, config.compactionStrategy ?? "truncate");

    // Run onTurnEnd hooks (non-blocking)
    for (const a of effectiveAugments) {
      if (a.onTurnEnd) {
        a.onTurnEnd(result).catch(() => {});
      }
    }

    return result;
  });
}
```

What happens:

1. **Queue enqueue.** The trigger goes into the transport's queue. If rate-limited or queue-full, the queue immediately returns a `rejected` result without running the handler. The transport sees `result.status === "rejected"` and reacts (the web transport synthesizes RUN_ERROR/RUN_FINISHED SSE events).

2. **Reset idle timer.** Activity pushes the idle timer back.

3. **Compute `threadId`.** From the trigger if present, otherwise the turn ID (which makes each turn its own thread — the default for one-shot requests).

4. **Run the turn loop.** `turnLoop.executeTurn(trigger, threadId, { onEvent })` does everything described in [04-kernel.md](./04-kernel.md) — context pipeline, prompt assembly, inference loop, tool execution, return result. The `onEvent` callback fires events as the loop progresses.

5. **Dispatch outbound.** If the turn produced a `response` or `responses[]`, send each one through the appropriate transport's `onOutbound` callback. The default target is the trigger's source augment, but messages can specify `targetAugment` to route through a different transport.

6. **Eager compaction.** Run the history manager's `compact()` method against the configured strategy. This keeps history under the threshold for the next turn so the budget walk doesn't have to evict on every call.

7. **`onTurnEnd` hooks.** Fire-and-forget. Failures are swallowed (`.catch(() => {})`). These don't block the response.

8. **Return the result** to the queue, which resolves the promise the transport is awaiting.

The transport now has the `TurnResult` and can finalize its response (close the SSE stream, send the final JSON, etc.).

### B. Internal code calls `agent.inject(trigger)`

```ts
async inject(trigger) {
  lifecycle.resetIdleTimer();
  const threadId = trigger.threadId ?? trigger.turnId;
  const result = await turnLoop.executeTurn(trigger, threadId);

  await dispatchOutbound(result, trigger);
  // (eager compaction, onTurnEnd — same as the transport path)
  return result;
}
```

`inject` is the back door — it bypasses the queue entirely. Used by:
- **Tests.** Most kernel tests call `inject` to fire a turn directly without standing up a transport.
- **Augments that need to schedule their own work.** A future cron augment might use `onIdle` to call `inject` with a `scheduled`-type trigger.
- **Internal events.** An augment that detects an external event (file change, queue message, webhook) might use `inject` to feed it to the kernel.

`inject` does NOT pass an `onEvent` callback (since there's no transport to forward events to). If the caller wants events, they have to pass one explicitly via `executeTurn` directly (which `inject` doesn't expose — but you can construct your own `turnLoop` for that case, or refactor `inject` to accept the option).

### C. Periodic idle hooks

The idle timer fires every 5 minutes (or whenever it last reset). Every augment with `onIdle` runs in sequence. Failures are swallowed.

In v1 nothing uses this, but the hook is in place for memory consolidation, background indexing, periodic snapshots, etc.

## Phase 4 — Shutdown (`agent.stop()`)

```ts
async stop() {
  lifecycle.stopIdleTimer();
  await lifecycle.shutdown();
  started = false;
}
```

### 1. Stop the idle timer

```ts
stopIdleTimer() {
  if (idleTimerId) {
    clearInterval(idleTimerId);
    idleTimerId = null;
  }
}
```

The interval is cleared. No more idle hooks will fire after this point.

### 2. Shutdown all augments

```ts
async shutdown() {
  if (idleTimerId) clearInterval(idleTimerId);
  for (const aug of [...augments].reverse()) {
    try {
      if (aug.onShutdown) {
        await withTimeout(() => aug.onShutdown!(), 5000);
      }
    } catch {
      // Best-effort shutdown
    }
  }
}
```

Two important properties:

**Reverse declared order.** If you booted `[a, b, c]`, you shutdown `[c, b, a]`. This mirrors the boot order so dependencies stay valid: if `c` depended on `b` being available during boot, `b` is still available during `c`'s shutdown.

**5-second timeout per augment, failures swallowed.** Each augment gets up to 5 seconds to shut down. If it takes longer, `withTimeout` rejects with `TimeoutError`, which is caught and swallowed. The next augment shuts down anyway.

This is the inverse of the boot policy: **boot is fail-fast, shutdown is best-effort.** The reasoning: at boot time, a broken augment means the agent shouldn't run. At shutdown time, a broken augment means the agent is still going down regardless — we want to give every augment a chance to clean up, but we don't want one stuck augment to block the whole shutdown.

### 3. Clear `started`

The handle's `started` flag goes back to `false`. `agent.ready()` would now throw.

### What's NOT shut down

- **In-flight turns.** If a turn was running when `stop()` was called, the queue's promise will still resolve (or reject) when the turn completes. v1 doesn't try to cancel in-flight turns. This is acceptable for the LORF use case (graceful shutdown happens when the operator restarts the agent intentionally).
- **The `historyManagers` map.** Per-thread history managers are kept in memory and die with the process. This is the right behavior for v1 — no persistent state across restarts.
- **The `outboundHandlers` map.** Same — dies with the process.

## The augment lifecycle hooks

Every hook on `Augment` is optional. Here's the full set and when each fires:

| Hook | Signature | When | Failure handling |
|------|-----------|------|------------------|
| `onBoot` | `() => Promise<void>` | Once at `agent.start()`, before transports register | Fail-fast — throws abort startup |
| `onShutdown` | `() => Promise<void>` | Once at `agent.stop()`, in reverse order, with 5s timeout | Best-effort — failures swallowed |
| `onTurnStart` | `(turn: TurnState) => Promise<void>` | Beginning of every turn, before context assembly | Required augment failures abort the turn; non-required failures are swallowed |
| `onTurnEnd` | `(turn: TurnResult) => Promise<void>` | After every turn, fire-and-forget | Always swallowed (`.catch(() => {})`) |
| `onIdle` | `() => Promise<void>` | When the idle timer fires (default 5min after last activity) | Swallowed |

### Why the asymmetry between boot and shutdown

**Boot is fail-fast** because a half-booted agent has unknown failure modes. If `fileMemory.onBoot` fails because the file doesn't exist, the agent shouldn't start serving requests that ask for that file's contents — the failure mode (silent empty content vs the model expecting real content) would be confusing and hard to debug.

**Shutdown is best-effort** because shutting down is the right thing to do regardless. Even if every augment's `onShutdown` throws, the process is going to exit. The hooks are an opportunity to clean up, not a requirement.

### Why `onTurnStart` and `onTurnEnd` are different shapes

`onTurnStart` receives `TurnState` — the *read-only* view of the turn before context assembly. It can mutate `turnState.metadata` (the augment scratchpad), but not anything else.

`onTurnEnd` receives `TurnResult` — the *complete* result of the turn, including the response, tool calls, and trace. It can read everything but cannot affect the result (the result has already been built and is on its way back to the transport).

This is what lets `onTurnStart` be used for setup (the `memory-bus` resets its budget here) and `onTurnEnd` for observability (a future trace exporter would write `result.trace` to a backend here).

### Why `onTurnEnd` is fire-and-forget

If `onTurnEnd` blocked the response, slow telemetry exporters would slow down every turn. By making it fire-and-forget with swallowed errors, telemetry/observability augments can take as long as they need without affecting user-visible latency.

The trade-off: if your `onTurnEnd` hook needs to *guarantee* it ran before the next turn (e.g. to maintain durable state), this isn't the right hook. Use `inject` with a "continuation" trigger instead, or write the work into a queue that the next turn waits on.

## The `AgentHandle` interface

```ts
export interface AgentHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  ready(): Promise<void>;
  health(): AgentHealth;
  card(): AgentCard;
  inject(trigger: TurnTrigger): Promise<TurnResult>;
}
```

Six methods. Most users only call `start()`, `stop()`, and let transports do the rest. The other three are utility:

- **`ready()`** — throws if the agent hasn't been started. Useful as a precondition check in code that expects the agent to be running. It does *not* wait for ready — it's synchronous in spirit.
- **`health()`** — returns an `AgentHealth` object: `status`, `agent`, `uptime`, per-augment statuses, model reachability. Used by external health checks (a load balancer pinging an internal endpoint). The web transport's `/health` doesn't actually call this in v1 — it returns a hardcoded `{status: "healthy"}`. A future enhancement would have the web transport delegate to `agent.health()` for richer health info.
- **`card()`** — returns the cached `AgentCard`. Same object the web transport serves at `/.well-known/agent-card.json`.
- **`inject()`** — the back door, described above.

There is **no method to mutate the augment list at runtime**. Once an agent is constructed, its augments are fixed. To change them, stop the agent, construct a new one with the new config, start it. This is intentional: hot-reloading augments without restarting the kernel is a complex problem that's not in v1's scope, and the semantics (what happens to in-flight turns? what happens to pending tool calls in those turns?) are hard to get right.

## What "creator" trust means here

`AgentConfig.operators?: string[]` is reserved but unused in v1. The intent: a list of peer IDs that have `trustLevel: "creator"` regardless of how they authenticate. A future spine transport will use this to identify the human operator across different communication channels (web, Telegram, email, IRC).

In v1, no peer ever gets `trustLevel: "creator"` via the web transport — the highest the web transport mints is configurable but defaults to `"public"`. The `creator` trust level is reserved for null-peer (internal/scheduled) triggers and future spine use.
