# Concurrency scheduling in OpenClaw, Hermes Agent, and Auggy

Date: 2026-07-24

## Scope and method

This research compares the concurrency boundaries used by OpenClaw and Hermes
Agent with Auggy's current runtime. Three independent read-only reviews traced
the upstream implementations and adversarially checked their documentation
against code.

The upstream evidence is pinned to:

- OpenClaw commit
  [`756b6f70090b5ba9d83ff73b9df1b6d6afe81a87`](https://github.com/openclaw/openclaw/commit/756b6f70090b5ba9d83ff73b9df1b6d6afe81a87)
  from 2026-07-24.
- Hermes Agent commit
  [`c7690818033646a8b0fe86eb5b5ceb77aa019cb5`](https://github.com/NousResearch/hermes-agent/commit/c7690818033646a8b0fe86eb5b5ceb77aa019cb5)
  from 2026-07-24.

Only official repositories and their checked-in documentation were treated as
technical evidence. Inferences are identified separately from verified
behavior.

## Executive conclusion

OpenClaw has the clearest single-process scheduling structure: one serialized
lane per session nested inside a process-wide execution lane. Hermes has strong
single-process messaging guards and additionally leases the final resolved
session ID, but its HTTP paths do not consistently reuse those boundaries.

Neither project supports horizontally replicated copies of one logical agent
with distributed session ownership, shared admission, replica-wide
idempotency, or cross-host rate limits. Their supported scaling shape is
multiple isolated agent cells, each with local concurrency.

Auggy already serializes the security-sensitive
`history load -> turn execution -> history commit` region by `threadId` for
both transport and injected turns. The remaining production gap is therefore
not missing history serialization. It is the absence of one bounded,
agent-wide scheduler that coordinates all transports and injection, provides
fair admission across threads, handles queued cancellation, and exposes
saturation state. Auggy also releases its existing thread lock before outbound
delivery and post-turn hooks, which permits response delivery and post-turn
side effects for adjacent same-thread turns to overlap when transport
concurrency is raised.

## Comparison

| Boundary | OpenClaw | Hermes Agent | Auggy before this follow-up |
| --- | --- | --- | --- |
| Same conversation | `session:<key>` lane, concurrency 1 | Routing-key guards plus a resolved-session lease | `withThreadLock(threadId)` around history load, turn, and commit |
| Different conversations | Process-wide `main` lane, default 4 | Messaging executor with 10 workers | Per-transport queue, default concurrency 1 |
| Busy-session backlog | Default cap 20 with steer/follow-up/collect/interrupt modes | Coalesced pending message; some FIFO paths cap at 32 | Promise tail per thread; transport queue caps pending work at 50 |
| Agent-wide backlog | Underlying lane queue is unbounded | Executor backlog may grow when admission cap is disabled | No shared agent-wide backlog across transports and injection |
| Queued cancellation | Gateway-owned queued run identity | Path-dependent | No direct cancellation removal from a thread tail or transport queue |
| Horizontal replicas | Unsupported shared-state replica model | Unsupported shared-state replica model | Explicitly single-writer for SQLite-backed deployment state |

## OpenClaw

### Verified design

OpenClaw nests a one-at-a-time session lane inside a global lane. The global
main lane defaults to four active turns and the subagent lane defaults to
eight:

- [queue contract](https://github.com/openclaw/openclaw/blob/756b6f70090b5ba9d83ff73b9df1b6d6afe81a87/docs/concepts/queue.md#L9-L22)
- [lane orchestration](https://github.com/openclaw/openclaw/blob/756b6f70090b5ba9d83ff73b9df1b6d6afe81a87/src/agents/embedded-agent-runner/run-orchestrator.ts#L125-L182)
- [configured defaults](https://github.com/openclaw/openclaw/blob/756b6f70090b5ba9d83ff73b9df1b6d6afe81a87/src/config/agent-limits.ts#L4-L30)

Busy sessions default to steering follow-up input into the active run. Operators
can instead select follow-up, collect, or interrupt behavior. The pending
message policy defaults to a 500 ms debounce, 20 entries, and summarizing
dropped oldest entries:

- [queue modes and defaults](https://github.com/openclaw/openclaw/blob/756b6f70090b5ba9d83ff73b9df1b6d6afe81a87/docs/concepts/queue.md#L24-L72)

Selected channel adapters also use a SQLite-backed durable ingress queue with
claims and stale-claim recovery, but this is not the universal chat scheduler:

- [durable ingress claims](https://github.com/openclaw/openclaw/blob/756b6f70090b5ba9d83ff73b9df1b6d6afe81a87/src/channels/message/ingress-queue.ts#L179-L247)

### Caveats

The advertised pending-message cap does not bound the underlying command lane.
The process-wide queue stores closures in an ordinary array and its enqueue
path has no maximum-depth admission check:

- [queue state](https://github.com/openclaw/openclaw/blob/756b6f70090b5ba9d83ff73b9df1b6d6afe81a87/src/process/command-queue.ts#L219-L234)
- [unbounded enqueue](https://github.com/openclaw/openclaw/blob/756b6f70090b5ba9d83ff73b9df1b6d6afe81a87/src/process/command-queue.ts#L539-L565)

The lane key normally prefers the routing `sessionKey`, falling back to the
durable `sessionId`. Two keys that can alias one durable transcript therefore
need another ownership boundary:

- [lane selection](https://github.com/openclaw/openclaw/blob/756b6f70090b5ba9d83ff73b9df1b6d6afe81a87/src/agents/embedded-agent-runner/run-orchestrator.ts#L112-L143)

Timeout handling releases a lane even though a non-cooperative underlying task
may still be unwinding. That favors liveness over strict exclusion:

- [timeout warning](https://github.com/openclaw/openclaw/blob/756b6f70090b5ba9d83ff73b9df1b6d6afe81a87/src/process/command-queue.ts#L31-L35)

OpenClaw's queues are process-local. Multiple Gateways must isolate their
config, state, workspace, and ports; they are separate cells rather than
replicas of one logical agent:

- [multiple-Gateway requirements](https://github.com/openclaw/openclaw/blob/756b6f70090b5ba9d83ff73b9df1b6d6afe81a87/docs/gateway/multiple-gateways.md#L49-L96)
- [Fleet scope](https://github.com/openclaw/openclaw/blob/756b6f70090b5ba9d83ff73b9df1b6d6afe81a87/docs/gateway/multi-tenant-hosting.md#L10-L32)

OpenClaw also documents one trusted operator boundary per Gateway rather than a
hostile multi-tenant boundary. Its default direct-message scope must not be
copied into a public customer concierge:

- [session scoping](https://github.com/openclaw/openclaw/blob/756b6f70090b5ba9d83ff73b9df1b6d6afe81a87/docs/concepts/session.md#L14-L54)
- [security model](https://github.com/openclaw/openclaw/blob/756b6f70090b5ba9d83ff73b9df1b6d6afe81a87/docs/gateway/security/index.md#L8-L27)

## Hermes Agent

### Verified messaging design

Hermes installs a routing-key guard before it spawns messaging work. Later
messages for the same key take a busy path instead of starting another agent.
The runner maintains another active-agent sentinel:

- [adapter guard](https://github.com/NousResearch/hermes-agent/blob/c7690818033646a8b0fe86eb5b5ceb77aa019cb5/gateway/platforms/base.py#L4873-L5048)
- [runner sentinel](https://github.com/NousResearch/hermes-agent/blob/c7690818033646a8b0fe86eb5b5ceb77aa019cb5/gateway/run.py#L12059-L12085)

Hermes additionally serializes by the final resolved `session_id`, closing the
case where two routing keys map to one transcript. The lease covers history
load, execution, and flush:

- [turn-lease design](https://github.com/NousResearch/hermes-agent/blob/c7690818033646a8b0fe86eb5b5ceb77aa019cb5/gateway/turn_lease.py#L1-L66)
- [lease acquisition](https://github.com/NousResearch/hermes-agent/blob/c7690818033646a8b0fe86eb5b5ceb77aa019cb5/gateway/turn_lease.py#L115-L213)

The messaging executor has ten workers. A separate
`max_concurrent_sessions` option is unlimited by default:

- [gateway executor](https://github.com/NousResearch/hermes-agent/blob/c7690818033646a8b0fe86eb5b5ceb77aa019cb5/gateway/run.py#L17206-L17234)
- [session-cap documentation](https://github.com/NousResearch/hermes-agent/blob/c7690818033646a8b0fe86eb5b5ceb77aa019cb5/website/docs/user-guide/configuration.md#L1726-L1745)

Hermes parallelizes explicitly safe tool batches with at most eight tool
workers while keeping unsafe or overlapping operations sequential:

- [tool segment planner](https://github.com/NousResearch/hermes-agent/blob/c7690818033646a8b0fe86eb5b5ceb77aa019cb5/agent/tool_dispatch_helpers.py#L41-L204)

### Caveats

The resolved-session lease is process-local, defaults to a 1,800-second wait,
and fails open after timeout. Its source explicitly notes that CLI processes
remain outside the lock and need a database-level lease.

The active-session registry is a best-effort same-host file lease. Its official
documentation says registry or lock failures fail open and that it is not
intended for one home mounted across machines:

- [active-session limitation](https://github.com/NousResearch/hermes-agent/blob/c7690818033646a8b0fe86eb5b5ceb77aa019cb5/website/docs/user-guide/configuration.md#L1735-L1745)

The HTTP API is a separate concurrency domain. Its default cap is ten active
runs, after which it returns `429` with `Retry-After: 1`:

- [API admission](https://github.com/NousResearch/hermes-agent/blob/c7690818033646a8b0fe86eb5b5ceb77aa019cb5/gateway/platforms/api_server.py#L5033-L5063)

The persisted-session HTTP paths do not use the messaging guards or the
resolved-session turn lease. From the code, two concurrent requests with the
same session ID can load the same starting history and launch separate agents.
This is an inference from the following paths:

- [history load](https://github.com/NousResearch/hermes-agent/blob/c7690818033646a8b0fe86eb5b5ceb77aa019cb5/gateway/platforms/api_server.py#L3147-L3171)
- [agent launch](https://github.com/NousResearch/hermes-agent/blob/c7690818033646a8b0fe86eb5b5ceb77aa019cb5/gateway/platforms/api_server.py#L3291-L3320)

Hermes permits multiple independent profiles, not horizontally scaled replicas
of one profile. Its Docker documentation warns against two gateways sharing
one data directory:

- [Docker deployment limitation](https://github.com/NousResearch/hermes-agent/blob/c7690818033646a8b0fe86eb5b5ceb77aa019cb5/website/docs/user-guide/docker.md#L183-L201)

## Revalidation of Auggy

Auggy's `defineAgent` currently maintains a process-wide `threadTails` map.
`executeThreadTurn()` calls `withThreadLock(threadId)` before:

1. authorizing and loading persistent history;
2. executing the kernel turn, including model and tools;
3. compacting and committing the terminal history snapshot.

Both transport `handleInbound()` and public `AgentHandle.inject()` reach this
same function. This means the previously suspected same-thread model/history
race is already fixed on the current default branch.

The current lock intentionally ends before `runPostTurn()` so
`scheduleAfterTurn()` can inject into the same thread without deadlocking. With
transport concurrency above one, that choice permits:

- the next same-thread model turn to begin while prior outbound delivery is
  still pending;
- adjacent same-thread responses to be delivered out of order when the first
  delivery is slow;
- `onTurnEnd` and scheduled post-turn work to overlap the next inbound turn;
- injected work to bypass every transport's global concurrency and queue-depth
  limits.

The transport queue is separately instantiated for every transport. It bounds
each queue at 50 by default and defaults to one active turn, but there is no
agent-wide active-turn limit or backlog shared by web, Telegram, AgentMail,
links, and injection.

## Design implications for Auggy

The safe local design should retain the existing canonical thread ownership and
history boundary while adding one agent-wide scheduler:

1. The resolved `threadId` is the serialization key.
2. One complete externally initiated turn occupies a thread lane through
   ordered outbound delivery.
3. Different thread lanes share a configurable global execution cap.
4. Global and per-thread pending work are both bounded.
5. Scheduling is fair across active thread keys.
6. A queued caller can be canceled without later model or tool execution.
7. Overload returns a stable rejection result and transport-appropriate
   `429` or `503` semantics with retry guidance.
8. Non-cancelable outcome-unknown work never permits blind same-thread retry.
9. Transport, injection, link, messaging, and background entry paths use the
   same admission boundary.
10. Runtime snapshots expose active, queued, rejected, canceled, and wait-time
    measurements without peer or prompt content.

For transaction-oriented agents, same-thread FIFO should be the default.
Steering or interruption can be a future explicit policy for conversational
surfaces, but must not silently reorder or abandon order mutations.

Horizontal replicas remain a separate deployment tier. A future shared
coordinator must provide distributed thread leases with fencing, durable
admission, shared idempotency and quotas, and authoritative recovery. Sticky
routing can optimize that design but cannot be its correctness boundary.
