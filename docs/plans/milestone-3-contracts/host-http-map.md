# M3-00 managed host and HTTP contract

Status: map accepted for M3-00; shared TypeScript declarations and freeze packet govern implementation.
Inspected `feat/inspectable-application` at `e1eadf3`, based on accepted main
`209185d0e7481b4ff5d3b4c87e3447e7583b2fef`. Source line references below describe
that baseline. The accepted ownership ADR and reconciled M3 execution packet
govern scope. M3-02 owns implementation after the shared contract is frozen;
the CTO owns changes to shared types, exports, `agent.ts`, and `commands/dev.ts`.

## Proposed public contract

These are concrete candidate signatures for `auggy/application`. Opaque brands
are module-private unique symbols; callers cannot mint them through public
constructors. Runtime ownership maps, state checks, and single-use checks remain
mandatory even if TypeScript is bypassed. Names can change during CTO integration;
the capabilities and ordering below must remain consistent across all owners.

```ts
export type ApplicationMain = (launch: ApplicationLaunch) => Promise<void>;

export function runApplication(
  main: ApplicationMain,
  direct: { config: URL; entrypoint: string },
): Promise<void>;

export interface ApplicationLaunch {
  readonly configPath: string;
  readonly mode: "direct" | "foreground" | "launchd" | "railway";
  // Synchronous: register runner-owned cleanup before returning this handle.
  // Does not import configured factories or acquire resources yet.
  createHost(options: { compose: AgentComposer }): ManagedApplicationHost;
}

export type AgentComposer = (
  configured: ConfiguredAgentComposition,
) => AgentComposition | Promise<AgentComposition>;

export interface ConfiguredAgentComposition {
  // Uses exactly this host's parsed YAML, resolved provider and augment graph.
  // No second enabled-augment list, raw model, tool callbacks or peer authority.
  compose(options: {
    turnProgram: TurnProgramBinding;
    onTurnFinalized?: TurnFinalizationObserver;
  }): AgentComposition;
}

export interface AgentComposition { readonly [compositionBrand]: true; }

export interface ManagedApplicationHost {
  prepare(): Promise<PreparedApplication>;
  start(options: { http: readonly ManagedHttpListener[] }): Promise<ApplicationReady>;
  stop(options?: { deadlineMs?: number }): Promise<HostStopResult>;
}

export interface PreparedApplication {
  // In YAML order. Empty when no webTransport is configured.
  readonly http: readonly ConfiguredWebHttp[];
}

export interface ConfiguredWebHttp {
  readonly name: string; // configured augment instance name, not a secret
  readonly agentRun: ManagedHttpHandler;
  readonly fallback: ManagedHttpHandler;
  createListener(options: {
    routes: readonly [AgentRunMount];
    fallback: ManagedHttpHandler;
  }): ManagedHttpListener;
}

export interface AgentRunMount {
  readonly method: "POST";
  readonly path: "/agent/run";
  readonly handle: ManagedHttpHandler;
}

export interface ManagedHttpRequest {
  readonly [httpRequestBrand]: true;
  readonly method: string;
  readonly url: string;
  readonly headers: {
    get(name: string): string | null;
    has(name: string): boolean;
  };
}

export type ManagedHttpHandler = (
  request: ManagedHttpRequest,
) => Response | Promise<Response>;

export interface ManagedHttpListener { readonly [listenerBrand]: true; }

export interface ApplicationReady {
  readonly agentName: string;
  readonly http: readonly {
    name: string;
    port: number;
    localBaseUrl: string;
    consoleUrl: string | null;
  }[];
}

export type HostStopResult =
  | {
      status: "stopped";
      ownership: "released";
      cleanup: "complete" | "failed";
      failures: readonly HostCleanupFailureCode[];
    }
  | {
      status: "retained";
      ownership: "retained";
      reason: "deadline" | "cleanup-failed" | "live-work" | "outcome-unknown";
      failures: readonly HostCleanupFailureCode[];
    };

export type HostCleanupFailureCode =
  | "augment-shutdown-failed"
  | "idle-callback-failed"
  | "job-stop-failed"
  | "job-close-failed"
  | "transport-drain-failed"
  | "resource-release-failed";
```

`TurnProgramBinding` and `TurnFinalizationObserver` come from the runtime owner's
contract, not parallel definitions here. The binding contains `run`, optional
`maxInferences`, and optional `timeoutMs`; the agreed opt-in default/maximum is
900,000 ms. `compose()` is single-use and its receipt belongs to the current host.
It supplies the selected binding to the additive `defineAgent` execution seam.
Legacy hosting constructs the same graph with no binding, preserving legacy
timing and the default managed turn program.

The runner accepts exactly one host per application invocation in M3. It rejects
zero hosts, multiple hosts, and `main()` returning before that host reaches ready.
`main()` throwing after `start()` is a startup failure with owned cleanup.
`runApplication` is the direct-entry helper; CLI calls the same package runner
through its internal validated launch selection, not through public synthetic
identity/lease arguments. The launch owner freezes the internal selection type.
Public input never contains `lifecycleOwned: true`, a PID claim, a process identity,
a launch-generation lease, an arbitrary runtime data root, or trusted caller IP.
The direct runner validates that the configured entrypoint matches the supplied
entrypoint URL before invoking `main`. It remains pending until managed shutdown;
`main` returns after its explicit host start, not after process termination.
The CTO may represent the helper as `ApplicationRunner` and
`ApplicationDirectLaunchOptions` types in `src/types.ts`; the implemented
`runApplication` function belongs in the application module's exports.

`createListener()` only prepares a frozen descriptor. It never binds a port.
`host.start({ http })` is the application's explicit listener activation request;
the package binds at the correct transport-ready phase. This avoids a second
public `listen()` call capable of racing agent boot. `prepare()` is one-shot;
`start()` is one-shot; a stopped application creates a new host on its next
invocation. Concurrent `stop()` calls join one cleanup operation. A caller's
stop deadline bounds observation, not the lifetime of cleanup or ownership.
The CTO has frozen the runner observation deadline at 15,000 ms. Public
`host.stop()` defaults to 15,000 ms and accepts a positive safe-integer override
no greater than 900,000 ms. Repeated/concurrent calls join the same cleanup task
but each caller observes its own deadline. The runner uses 15,000 ms for
signal/startup-error cleanup: clean confirmed signal shutdown exits 0, startup
failure always exits 1, released-with-cleanup-failures exits 1, and retained/live/
unknown ownership at deadline leads to forced process exit 1 without manually
deleting retained claims or quarantine. `host.stop()` never exits the process.

## Actual application code

```ts
// src/index.ts — imported CLI launch is inert; direct launch uses the same runner.
import { runApplication, type ApplicationMain } from "auggy/application";
import { composeAgent } from "./agent";
import { configureHttp } from "./http";

export const main: ApplicationMain = async (launch) => {
  const host = launch.createHost({ compose: composeAgent });
  const prepared = await host.prepare();
  const listeners = prepared.http.map(configureHttp);
  await host.start({ http: listeners });
};

if (import.meta.main) {
  await runApplication(main, {
    config: new URL("../agent.yaml", import.meta.url),
    entrypoint: import.meta.url,
  });
}

// src/agent.ts — binds code; configured YAML remains the composition authority.
import type { AgentComposer } from "auggy/application";
import { turnProgram } from "./turn";

export const composeAgent: AgentComposer = (configured) =>
  configured.compose({ turnProgram });

// src/http.ts — this mount and handler execute on the real service request path.
import type { ConfiguredWebHttp, ManagedHttpListener } from "auggy/application";

export function configureHttp(web: ConfiguredWebHttp): ManagedHttpListener {
  return web.createListener({
    routes: [{ method: "POST", path: "/agent/run", handle: web.agentRun }],
    fallback: web.fallback,
  });
}
```

The app names its composer, loops over the configured HTTP instances, mounts the
canonical route, and requests listener activation. All four files are executed;
`turn.ts` contains the real loop, not a second wrapper around an invisible loop.
No web transport means an empty array and `host.start({ http: [] })`; other
configured transports/jobs retain their lifecycles. Multiple web transports
require exactly one descriptor per configured instance. Runtime validation rejects
duplicates, missing descriptors, descriptors from another host/instance, an
implicit plus external binding conflict, and mounting after start. M3 does not
introduce a general third-party router framework or configurable route aliases.

For the required harmless HTTP source-edit proof, replace the mount's `handle`
with this wrapper and request the actual installed application:

```ts
handle: async (request) => {
  const response = await web.agentRun(request);
  const headers = new Headers(response.headers);
  headers.set("x-auggy-application", "edited-http-v2");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
},
```

Acceptance must observe that header after editing only the consumer's `http.ts`,
and still observe authenticated SSE, denial, persistence and replay behavior.
The wrapper forwards the same stream rather than buffering it. Application
TypeScript is trusted code; the supported handler contract does not promise to
sandbox deliberately malicious response replacement or arbitrary private imports.

## Request, connection, route and listener ownership

The maintained Bun fetch wrapper mints `ManagedHttpRequest`. A private WeakMap
binds it to the original `Request`, the actual server connection information,
adapter identity, invocation state, and lifetime. Exposed fields are frozen
snapshots/read-only header accessors; there is no body reader, mutable `Headers`,
request replacement, server handle, IP setter, kernel handle or peer constructor.
Auth, proxies, signatures and payload validation always read the original
request retained by the adapter. A handler cannot supply a fabricated
`callerIp` or rewrite method/body into a new authoritative request.

`agentRun(receipt)` or `fallback(receipt)` consumes the adapter-delegation slot
synchronously, before its first await. Exactly one delegate call is permitted
per receipt, including rejected/auth-failed requests. Duplicate concurrent or
serial calls, a receipt belonging to another adapter, fabricated receipts and
use after the mounted handler settles reject before turn dispatch. The receipt
is revoked when that handler returns/throws; already-owned streaming execution
continues under the transport's lifetime. An app may return its own early
response without dispatch, or wrap the delegated response as above. A required
fallback must be the same adapter's original fallback reference, not a second
user handler hiding the maintained console/security routes.

Extract one internal web factory that produces the augment plus HTTP binding.
The existing `webTransport(opts): Augment` uses this implementation with its
default canonical route descriptor. App-mode resolution requests external
binding, retains that same augment in the YAML-derived graph, and returns its
binding separately. It does not remove web from the augment list, reconstruct
the graph, or instantiate a second web augment. Preserve names and the visitor
late bindings from `augment-resolver.ts:862-960,1247-1325`, including immutable
security namespace and the accepted Link UUID projection in the other transport.

The request pipeline is:

1. Package listener checks host serving state. No application handler, augment
   route, model, console mutation, or health-success response runs before ready
   or after draining begins. An already-bound startup listener returns a fixed
   503; a startup failure cannot process a turn.
2. Shared routing prelude preserves CORS OPTIONS behavior and console login
   method exceptions (`web-transport.ts:3608-3632`). The console Host/Origin/proxy
   boundary remains in the protected console branch; do not apply public CORS to
   it or let a generic OPTIONS shortcut bypass its route-owned rules.
3. An exact POST `/agent/run` invokes the application mount with a managed receipt.
   Its guarded delegate retains every auth, request/body limit, identity,
   idempotency, stream, accounting/persistence handoff and error behavior from
   `handleAgentRun` (`2360-3450`). Public input cannot manufacture a `TurnTrigger`.
4. Every other request goes through the same-instance maintained fallback.
   The fallback refuses canonical POST `/agent/run` rather than silently
   redispatching it. There is one execution endpoint, with no hidden second path.
5. Protected augment routing retains exact-before-pattern matching, authorization
   and delegated requirements, rate limit before body buffering, actual-byte body
   cap, webhook verification, timeout/cancellation, CORS and method mismatch.

Moving a route out of fallback must not move authentication or body parsing into
the app. Existing handler defaults remain: run body 1 MiB, pending live SSE 1 MiB/
1,024 events, console aggregate 4 MiB; configured limits remain authoritative.
The server currently uses only `{ port: opts.port, idleTimeout: 120, fetch }`
(`web-transport.ts:3603-3607`). No explicit hostname or `maxRequestBodySize` is
configured. Preserve this binding behavior and the handler's actual-byte caps;
do not silently tighten a Bun-level cap that would break configured augment body
limits. Raw Bun listener options are not part of this M3 public API.

Route preservation map:

| Existing surface | Maintained owner and behavior |
| --- | --- |
| `POST /agent/run` | Application mount; package `handleAgentRun` delegate |
| OPTIONS | Shared prelude, preserving special console-owned routes |
| `/console` and `/console/*` | Protected fallback → `evaluateConsoleRequest` → `handleAdminRoute`; login, assets, actions, chat and operator APIs stay intact |
| `GET/HEAD /` | Configured validated redirect or cached info page with HEAD parity |
| `GET/HEAD /agent`, `/agent/` | Public-integration policy, developer page or slash redirect |
| `GET /health` | Existing liveness body after managed readiness; not a new database-readiness API |
| `GET /.well-known/agent-card.json` | Current public/private Agent Card policy |
| Augment routes | Collected after boot; auth/webhook/limits applied before handlers |
| Unsupported methods/paths | Current 405/Allow for augment paths, otherwise 404 |

Connection IP comes from Bun `server.requestIP(req)` (`732-764`), normalized by
the existing proxy helpers. The adapter, not application input, applies trusted
proxy chains, missing-IP behavior and ambiguous-forwarding rejection. Console
same-origin rules use the connection address separately. `AUGGY_PUBLIC_URL`
informs current console origins/display; it does not independently authorize
forwarded headers. The resolver's explicit Railway proxy policy remains intact.
The current console internal proxy needs the actual listener port and private
run marker; preserve its loopback call and secret marker, never export the marker.

**WebSocket correction:** current `web-transport.ts` has no WebSocket handler,
server `upgrade()`, or websocket Bun option. M3 must not claim to preserve an
HTTP WebSocket facility that does not exist or create a new one. AgentMail's
outbound/provider WebSocket is a separate augment lifecycle; preserve it through
the common agent boot/register/ready/shutdown sequence. Link also remains its
own configured transport, not a route silently moved onto the web listener.

## Baseline lifecycle: exact acquisition and failure ordering

The top comment in `commands/dev.ts` is not an accurate ordering authority; the
implementation acquires its PID/resource claims before engine/factory loading.

| Order | Baseline source | Operation and ownership |
| --- | --- | --- |
| 1 | `dev.ts:200-215` | Resolve config; validate launchd installation-generation syntax; parse/validate config |
| 2 | `216-219` | Railway volume admission/identity/restore-fence/durability probe and singleton lease; owned data root `/app/data` |
| 3 | `230-269` | Resolve first web port/bearer for status; foreground claims lifecycle admission unless restart already holds it; reject active launchd generation |
| 4 | `270-293` | Verify OS process incarnation; mint nonce; derive resource claims; claim PID/resource ownership. Railway deliberately skips local PID publication and relies on volume lease |
| 5 | `294-307` | On admission error release acquired ownership; map EEXIST; always release the short lifecycle-admission fence |
| 6 | `313-348` | Resolve provider, then augments; construct `AgentConfig`; on failure release runtime ownership |
| 7 | `350-365` | `defineAgent` then configured jobs construction; jobs-construction catch releases ownership |
| 8 | `368-401` | Install idempotent jobs close, SIGINT/SIGTERM shutdown and process-exit cleanup |
| 9 | `403-413` | `startAgentWithDurableJobs`: agent start, then worker start; failure stops worker/agent and closes jobs |
| 10 | `415-462` | Print readiness; optional delayed browser sign-in; `onReady`; readiness-callback failure tears down and releases |

`claimRuntimePidManifest` (`pid-registry.ts:828`) atomically claims local identity
and declared resources, rejects alive **or unverifiable** prior owners, and
validates launchd installation generation. `releaseRuntimePidManifest` (`969`)
releases only the matching claim. Never substitute a numeric PID check. Railway
volume admission pins descriptor-walked paths and keeps a singleton lock
(`runtime-volume.ts:40-151`); release it after safe cleanup, not after parse/boot
timeouts. Preserve this topology; do not add local registry writes to Railway.

Provider/factory resolution already has side effects. `resolveAugments` cleans
previously returned augments in reverse order when a later factory fails
(`augment-resolver.ts:1401`), but swallows cleanup errors. Once resolution succeeds,
ownership of the complete graph must transfer exactly once to the host/agent.

Concrete baseline construction gap: `defineAgent` at `dev.ts:351` lies outside
the preceding cleanup catch. It can throw (for example, multiple turn-gate owners,
covered by `tests/agent.test.ts:29`) after claims were acquired. Also, jobs
construction failure currently does not dispose the resolved, unbooted augment
graph. The managed host must cover both; retaining this gap is not parity.

## Target host state and acquisition protocol

`created → preparing → prepared → starting → ready → draining → stopped`.
Failure enters `draining`; unresolved cleanup enters `retained`, never `stopped`.
All transitions serialize. Every acquired cleanup resource is registered before
the next potentially throwing operation. Host state and claims stay owned by the
runner from `createHost()` onward, even if `main()` forgets to call another method.

`prepare()` performs baseline steps 1–7 under one cleanup scope:

1. Validate selected config/application contract and supported coordination
   posture before resources/factories. Direct ESM module imports have already
   happened; the helper cannot retroactively prevent module side effects.
2. Acquire volume and process/lifecycle/resource claims in the baseline order,
   preserving the launchd/restart fence. Factory imports start only afterward.
3. Resolve provider and augments once, retaining constructor cleanup ownership.
   Supply application web binding mode through a private resolver seam.
4. Invoke the application's composer and validate its same-host receipt; construct
   `defineAgent` and jobs under the same failure scope. Once ownership transfers
   to agent lifecycle, avoid calling augment shutdown twice.
5. Return the prepared HTTP binding list. No boot hooks, listener, worker polling
   or turn has started yet. If `main()` throws here, dispose constructed resources
   and release claims only after cleanup is confirmed.

`start()` first validates and seals descriptors, then:

1. Agent boot runs augment `onBoot` sequentially, recording each attempted hook
   **before** invocation (`lifecycle-manager.ts:27-45`). Restore durable thread
   quarantine before route collection (`agent.ts:815-828`).
2. Collect/validate augment routes, create frozen augment view, register every
   transport and scheduler source (`agent.ts:821-901`). Registration remains
   preparation-only. The application web descriptor is attached to its existing
   source; it does not create a second scheduler source or raw kernel access.
3. Ready every transport (`903-905`); configured web binds its selected listener
   here. Existing agent startup barrier prevents partial-start turn execution.
4. Agent initialization completes; configured jobs recover expired leases,
   materialize schedules and begin polling (`durable-jobs-runtime.ts:249-257`).
5. Open a host-level admission/readiness latch and publish ready only after every
   required ready hook and worker start succeeds. Return `ApplicationReady`.
   The runner/CLI then logs, opens the console if requested, and publishes ready
   callbacks. Any exception still triggers cleanup of the registered host.

The current agent barrier opens before `durableJobs.start`; the host needs a
small package-private admission latch accepted by the agent scheduling boundary
to prevent transport/injected work entering that window. This is not an app
callback with authority to admit turns. The same latch must close on failed
worker startup and be observed by all transport and job dispatch paths. An HTTP
prelude alone would leave other configured transports unprotected. Preserve
legacy public `defineAgent(config, model)` semantics when no managed host is used.

Partial-start rollback keeps the current order: close admission; stop jobs if
constructed; drain agent scheduling; run attempted augment shutdown in reverse
order; close the jobs store; release process/volume ownership last. Before boot,
the host owns constructor cleanup of resolved augments. After boot begins, the
agent lifecycle owns attempted hooks; any never-attempted factory allocations
still need their registered constructor cleanup. Do not call `agent.stop()` on
an unstarted handle and assume its current no-op disposed those allocations.

Factories that allocate and then throw before returning a disposable resource
must clean their own allocation; the host cannot recover an object it never
received. A pending factory whose completion cannot be confirmed keeps host
ownership retained; a stop request must not allow its late result to boot.

## Draining, durable delivery and unknown cleanup

Baseline successful shutdown is jobs stop → agent stop → jobs close → release
PID/resource/volume claims → process exit (`dev.ts:381-391`). Agent stop closes
the scheduler, drains active work and thread tails, then shuts down augment hooks
in reverse order (`agent.ts:930-948`). Preserve that dependency ordering.

At host stop request, mark readiness false and close new HTTP ingress immediately;
stop future job admission before agent teardown. Existing authorized work remains
owned. Drain agent scheduling and associated HTTP producers/finalizers before
closing the stores they still need. Stop accepting new listener connections
without force-dropping active durable executions. Cleanup must not rely on an
application-supplied `finally` or CLI-only signal handler.

The following source facts require explicit implementation seams, not optimistic
interpretation of an already-resolved `stop()`:

| Source fact | Required managed ownership |
| --- | --- |
| `lifecycle-manager.ts:48-68` times out each shutdown hook after 5 s and returns only a failure count; it clears its attempted list first | Track actual hook promises and sanitized failure/unknown status through settlement. `withTimeout` already accepts an `onDetached` callback (`timeout.ts:27`). Timeout does not prove cleanup |
| Idle interval callbacks can still be in flight after clearing the timer (`lifecycle-manager.ts:84-94`) | Stop scheduling and track/join outstanding callback work, or retain ownership when settlement is unknown |
| Jobs stop has a 5 s grace and may mark a running execution unknown while its promise remains (`jobs/runtime.ts:654-675`) | Preserve job quarantine and observe actual worker settlement; do not close its store or release host ownership while dependent work remains |
| `stopAgentWithDurableJobs` catches stop/close failures and resolves (`durable-jobs-runtime.ts:146-166`) | Supply an internal cleanup report; host success cannot be inferred from this resolved helper alone |
| SSE producer awaits `handleInbound`, then persists console terminal state and idempotency in its own async closure (`web-transport.ts:3283-3425`) | Track producer/finalizer promises separately from the returned `Response` and scheduler drain; await settlement before closing web stores |
| Web shutdown currently calls `server.stop()` and immediately closes stores (`3903-3936`) | Separate stop-admission/listener drain from store disposal; share this operation with legacy and external binding |

The public host does not expose these promises or raw stores. A package-private
settlement snapshot/report should contain pending-owner categories and fixed
classification codes only. Runtime/host owners must agree the reporting seam with
the CTO; `AgentHandle.stop(): Promise<void>` alone cannot establish this stronger
contract. These are bounded lifecycle changes required by the accepted ownership
promise, not authorization for a general scheduler or jobs rewrite.

Recommended internal report shape (not a public export):

```ts
interface ManagedCleanupSnapshot {
  admission: "closed" | "open";
  scheduler: "not-started" | "active" | "drained";
  pending: Readonly<{
    factories: number;
    turns: number;
    idleCallbacks: number;
    shutdownHooks: number;
    httpFinalizers: number;
    jobExecutions: number;
  }>;
  resources: "closed" | "open" | "unknown";
  failures: readonly HostCleanupFailureCode[];
}
```

Use a private managed-agent bridge/registry, not an exported public
`TransportKernel` or caller-supplied snapshot. The CTO's `agent.ts` integration
accepts the host readiness/admission gate and supplies scheduler/thread-tail and
lifecycle settlement observations; it also places the selected turn binding and
finalization observer inside the current scheduling/commit boundaries. M3-02's
host aggregates those observations with factory, HTTP and worker ownership.
Lifecycle manager owns actual hook/idle promise tracking; web adapter owns all
producer/finalizer tracking; the jobs runtime owns its actual execution promise.
Counters increment before callbacks run, decrement only on actual settlement,
and do not become zero merely because a timeout wrapper returned. Closed-resource
status is asserted only by the owning cleanup operation, not by the app or a
timer. The bridge observes future settlement without retrying failed effects.

### Agreed private hosted-agent seam

Agreed with the runtime owner after review of the concrete public types and
compile-only recipe. This supersedes earlier proposals for a caller-supplied gate
or a separate exported gate-controller factory. There is one private factory:

```ts
// Types only in src/application/hosted-agent.ts; no runtime import of agent.ts.
import type {
  AgentConfig,
  AgentExecutionOptions,
  AgentHandle,
  HostCleanupFailureCode,
  ModelClient,
  TurnSchedulerSnapshot,
} from "../types";

export interface HostedAgentSnapshot {
  readonly admission: "pending" | "open" | "closed";
  readonly scheduler: Readonly<TurnSchedulerSnapshot>;
  readonly pendingTurns: number;
  readonly pendingIdleCallbacks: number;
  readonly pendingShutdownHooks: number;
  readonly resourceState: "active" | "closing" | "closed" | "unknown";
  readonly failures: readonly Extract<
    HostCleanupFailureCode,
    "augment-shutdown-failed" | "idle-callback-failed"
  >[];
}

export interface HostedAgentInstance {
  readonly agent: AgentHandle;
  openAdmission(): void;
  closeAdmission(): void;
  snapshot(): HostedAgentSnapshot;
  waitForQuiescence(): Promise<HostedAgentSnapshot>;
}

// Private export from src/agent.ts, absent from src/index.ts/package exports.
export function createHostedAgent(
  config: AgentConfig,
  model: ModelClient,
  execution: AgentExecutionOptions,
): HostedAgentInstance;
```

`createHostedAgent` and public `defineAgent(config, model, execution?)` delegate
to the same internal construction function. The public path has no hosted
admission gate and preserves its existing startup/timing semantics. The private
path internally creates its gate/controller; no raw gate or lifecycle object is
accepted from application composition. These interfaces do not expose peer,
thread, customer, claim, lease, or raw exception data. Snapshot copies and nested
scheduler counters are immutable; caller mutations cannot change runtime state.

Exact controller semantics:

- `openAdmission()` requires completed agent boot/transport readiness and a
  pending gate. The host calls it only after jobs start succeeds; it is one-shot.
  Opening before agent readiness or reopening a closed gate throws a fixed error.
- `closeAdmission()` synchronously and permanently closes this hosted gate and
  settles its waiting tasks. It is idempotent. It never releases ownership,
  closes stores, clears quarantine, or pretends a running effect completed.
- Central `scheduleTurn` rejects a closed gate before enqueueing. A pending gate
  is awaited after the existing `beforeExecute` startup barrier and before
  `onExecutionStart`, history restoration or managed program execution. This
  applies to transport, direct injection and causal scheduling; it adds no second
  semaphore. Closed-gate attempts use the existing `runtime-stopping` rejection
  classification and receive the once-per-attempt finalization observation;
  caller abort retains cancellation classification. Startup failure closes the
  gate rather than reopening or executing queued attempts.
- `snapshot()` reports agent-owned scheduling/lifecycle state only. `pendingTurns`
  covers entered scheduling attempts until their caller-facing processing
  settles, including existing post-turn work; scheduler active lanes separately
  retain physical detached effect ownership. Idle/shutdown counters follow actual
  callback promises. The finalization observer's bounded, non-authoritative late
  completion must not be mistaken for an owned tool effect.
- `waitForQuiescence()` is valid only after `closeAdmission()`. It waits for any
  already-entered start/stop/rollback operation plus agent-owned turns, scheduler
  physical lanes, thread tails, idle callbacks and shutdown hooks to actually
  settle. It neither initiates cleanup nor releases claims. It returns a snapshot
  that may still say resource state `unknown`; physical settlement alone is not
  closure proof. This promise can remain pending after a host caller's deadline.
  The host keeps the same cleanup task observed and races only its observation.
- Before lifecycle boot, lifecycle-owned resources are `closed`; factory
  allocations still belong to the host's separate construction tracker. Boot
  makes them `active`, cleanup makes them `closing`, successful confirmed cleanup
  makes them `closed`, and unproven closure makes them `unknown`. If close occurs
  during startup, the serialized start must roll back and cannot later open
  admission or advertise ready. The host requests cleanup; it cannot abandon an
  in-flight start merely because `start()` has not returned.

The host aggregates this report with its own HTTP finalizers, jobs, factories and
resource claims. It never infers that all those domains settled merely from
`agent.stop()` or `HostedAgentSnapshot.scheduler.state === "stopped"`.

Serial implementation ownership is explicit: the runtime owner first changes
`agent.ts` for selected turn invocation and finalization observation, then hands
that file back to the CTO. The CTO grants one temporary owner for private
`createHostedAgent`, admission checks and lifecycle reporting integration. M3-02
owns the private type module, lifecycle helper tracking and HTTP modules; it must
not edit `agent.ts` concurrently with M3-01. Jobs reporting is a narrow M3-02
proposal/integration agreed with the CTO, not a second jobs implementation.

A rejected but settled hook is different from a still-running hook. If all work
settled and every owned resource is independently confirmed closed, release
claims and return `stopped/released` with `cleanup: "failed"` and fixed failure
codes. This is a failed shutdown outcome for the runner even though ownership
can safely be released. If a generic hook rejection leaves resource closure
unconfirmed, return retained. Do not treat every rejection as permanently live,
and do not treat settled rejection alone as proof of resource closure.

On a programmatic stop deadline, return `retained` while one cleanup task remains
observed. Keep PID, resource, and volume claims held; prohibit restart on that
host. If work later settles and cleanup is confirmed, that same task may finish
release exactly once. Cleanup failure with an unproven resource state remains
retained until process termination or explicit existing recovery protocol can
prove the owner gone. Do not launch a competing cleanup or re-run side effects.

The runner alone installs/removes SIGINT/SIGTERM handlers and decides process
termination. Successful cleanup can exit 0; failed/expired cleanup must not print
"stopped" or exit 0 as a certified clean shutdown. On forced process termination,
do not first explicitly unlock live resources or delete claims; OS-held volume
locks close with the process, while durable owner records are reclaimed through
verified process-incarnation recovery. A process `exit` hook cannot await work
and must not unconditionally erase retained ownership. Persistent thread/job
quarantine survives process death where already required.

HTTP execution/delivery distinctions must remain exact:

- A keyed owner uses delivery-abort, not request-disconnect, as its execution
  signal (`2940-2943`); canceling delivery leaves execution/ledger settlement
  alive for retry/replay (`3016-3023`). Non-keyed work combines both signals.
- Live queue byte/event overflow aborts both kinds (`2987-2995,3068-3073`).
  Replay-storage overflow instead marks the durable result unknown (`3396-3399`).
- A keyed follower waits with bounded capacity/deadline (`2270-2327,2800-2814`);
  its disconnect must not cancel the owner. Binding changes, unknown outcomes,
  ledger unavailability and capacity retain their current fail-closed responses.
- Only proven pre-execution scheduler rejection abandons a claim; post-execution
  fabricated rejection metadata cannot make execution retryable (`3293-3298`).
- Terminal success is buffered until console transcript/history commit
  (`3195-3271`). On commit failure, invalidate resident history and emit failure,
  never a preceding success. The new finalization observer labels staged history
  `deferred-to-transport`; it does not assert that this later commit has happened.
- Idempotency completion failure leaves the running claim to become unknown
  (`3382-3413`). A shutdown extraction must not turn it into a clean retry.

## Implementation and regression handoff

| Work boundary | Source to extract/change | Existing regression anchors and new proof |
| --- | --- | --- |
| Host acquisition and cleanup | `dev.ts:200-413`, runtime volume/resource/PID helpers | `tests/cli/runtime-volume.test.ts`, `runtime-resource-claims.test.ts`, `pid-registry.test.ts`; add real second-process conflict before any factory sentinel |
| Construction failure | `defineAgent` placement; resolver construction ownership | `tests/agent.test.ts` multiple turn-gate case; add claimed host → constructor throws → resources reusable only after confirmed disposal |
| Agent boot/readiness | `agent.ts:299-323,800-928`; transport ready contract | `tests/kernel/agent-route-wiring.test.ts`, `agent-scheduler.test.ts`; boot/register/ready/bind/worker failures, zero model/tool calls before full ready, reverse rollback |
| Jobs ordering/retention | `durable-jobs-runtime.ts`, narrow runtime settlement report | Existing start/stop ordering tests at `tests/cli/durable-jobs-runtime.test.ts:270,315,342`; add uncooperative active job, retained claim and no premature store close |
| HTTP extraction | `web-transport.ts` guarded handlers and deferred listener | Run the same identity, body, CORS, origin/proxy, route authorization and stream tests for legacy/default and app descriptor paths |
| Durable HTTP | `web-idempotency.ts`, console store/history, tracked producers | `tests/transports/web-idempotency.test.ts`, `web-console-persistence.test.ts`; add stop during commit and disconnected owner; no success-before-commit, exact restart replay |
| Receipt/descriptor discipline | New managed adapter/binding validation | Duplicate delegate, forged/cross-adapter/stale receipt, altered read-only view, cross-host listener, missing/duplicate bind, late mount, protected fallback cannot dispatch canonical POST |
| Safe stop | Lifecycle/idle detached reporting; listener/job drain | `tests/kernel/agent-scheduler.test.ts:971,1031`, `tests/jobs/runtime.test.ts`; deadline returns retained and second process stays blocked until safe settlement/death |
| Other operational transports | Common lifecycle, no HTTP WebSocket invention | AgentMail websocket/runtime tests; Link real packed scenarios; preserve non-web transport readiness and internal job turns |
| Launch and reference proof | Runner plus CLI-selected named main | CLI owner's launch matrix; source edits to `index.ts`, actual response header from `http.ts`, and guarded 2→1 turn edit in installed consumer |

New host tests may inject factories/cleanup latches to characterize ordering, but
acceptance requires real process identity claims, real Bun listener, installed
package resolution, provider fixture plus actual tool, durable store restart,
and the original foundation release gates. A mocked `Bun.serve`, fake kernel, or
only calling the handler as a function cannot prove package startup or connection
identity. Tests must observe that auth/schema failures call no provider/tools,
and that the same configured program handles HTTP, jobs and other admitted turns.

Suggested implementation order after freeze:

1. CTO lands shared types/private admission and settlement reporting contract.
2. M3-02 extracts one web instance/handler/listener implementation and lifecycle
   ownership, keeping the existing `webTransport` export as a default adapter.
3. M3-02 adds the cleanup-registered host/runner and focused phase/failure tests;
   proposes the exact `runDev` delegation patch for serial CTO integration.
4. M3-03 integrates launch selection and all existing operator paths using this
   host, without importing app/runtime for recovery commands.
5. M3-04 implements the reference snippets against frozen types; M3-05 proves
   source edits and runtime behavior from packed dependencies outside the repo.

No claim here certifies generalized hoisted monorepos, a new HTTP WebSocket API,
arbitrary framework embedding, distributed coordination, a new scaffold, or a
configuration migration. Those remain outside M3.
