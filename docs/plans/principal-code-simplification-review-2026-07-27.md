# Principal Code Quality and Simplification Review

Date: 2026-07-27

Branch: `refactor/code-simplification`

Base: `main` at `f8c21c3`

## Executive assessment

The repository has strong security-boundary tests and several deliberately
defensive state machines. The best simplification strategy is not a broad
rewrite. It is to:

1. fix three correctness boundaries where the implementation contradicts its
   contract;
2. remove code only when repository-wide usage proves it dead or redundant;
3. converge duplicated configuration, transport, and DTO authorities; and
4. require an explicit compatibility decision before removing public or
   durable legacy behavior.

This pass applied the first evidence-backed cleanup and deleted 2,111 tracked
lines before adding this report. No public API or persisted-data compatibility
behavior was intentionally changed.

## Priority findings

### P0: reject non-boolean web-transport security options

The YAML validator in
[`config-parser.ts`](../../src/cli/config-parser.ts#L389) does not validate
`allowAnonymous`, `adminRoute`, or `publicIntegration`. The resolver then casts
the unchanged runtime values in
[`augment-resolver.ts`](../../src/cli/augment-resolver.ts#L421), and
[`resolveConfigBool`](../../src/config/resolve.ts#L34) accepts any defined value
as its boolean result. A quoted YAML value such as `allowAnonymous: "false"`
therefore remains a truthy string. Similarly, `adminRoute: "false"` does not
equal `false`, so the console remains enabled in
[`web-transport.ts`](../../src/transports/web-transport.ts#L3598).

This is a security configuration defect, not a style issue.

Recommended smallest fix:

- reject non-booleans for `allowAnonymous`, `adminRoute`, `publicIntegration`,
  and `visitorTokens.enabled` during config parsing;
- repeat the invariant at the programmatic `webTransport()` boundary; and
- add regression tests for quoted booleans before consolidating the broader
  web-transport schema.

### P0: terminal hooks must run after outbound delivery failure

[`runPostTurn`](../../src/agent.ts#L526) awaits outbound delivery before
`onTurnEnd` and `scheduleAfterTurn`. A delivery exception exits the pipeline and
skips every terminal hook. This contradicts the lifecycle intent documented in
the same function and can skip memory auto-save or cleanup. The emergency stale
budget cleanup in [`memory/tools.ts`](../../src/memory/tools.ts#L113) is evidence
that missed terminal hooks are already considered possible.

Recommended smallest fix: capture the delivery error, run terminal hooks in all
cases, then rethrow or classify the saved delivery error. Add one agent-level
test proving both hook families execute when the outbound handler fails.

### P0: the multi-gate admission protocol is not atomic

The confirmation loop in
[`turn-loop.ts`](../../src/kernel/turn-loop.ts#L504) commits gate tickets
sequentially. If gate A confirms and gate B throws, gate A's documented
idempotent rollback is already a no-op. The test at
[`turn-gate.test.ts`](../../tests/kernel/turn-gate.test.ts#L248) explicitly
preserves this partial commit even though the public contract in
[`types.ts`](../../src/types.ts#L1180) describes atomic two-phase admission.

Only the budgets augment currently provides a production turn gate.

Recommended smallest fix: enforce one turn-gate owner at boot and simplify the
kernel to one optional ticket. A real multi-participant protocol should not be
advertised until there is a coordinator capable of atomic commit or durable
recovery.

### P1: bound console login rate-limit state

[`admin/index.ts`](../../src/transports/admin/index.ts#L326) keeps a process-wide
map keyed by caller IP. [`checkLoginRateLimit`](../../src/transports/admin/index.ts#L1992)
only prunes the current key, so stale keys from other callers live for the
process lifetime.

Recommended smallest fix: extract one bounded keyed sliding-window primitive,
reuse it for login and augment-route rate limiting, periodically sweep expired
keys, and enforce a hard cardinality ceiling with fail-closed behavior.

### P1: stop translating arbitrary storage failures into chat conflicts

The console chat store throws a generic error when deletion races a streaming
thread. The admin route catches every storage error, re-reads state, and emits
409 when the later view happens to be streaming. This can hide a real database
failure and makes classification timing-dependent.

Recommended smallest fix: introduce a dedicated
`ConsoleChatStreamingConflictError`, classify it with `instanceof`, and delete
the follow-up read and nested catch.

### P1: make the dashboard contract single-source and validated

[`admin/src/lib/types.ts`](../../admin/src/lib/types.ts#L1) is a 312-line
hand-maintained mirror of server contracts. The console fetch path casts
untrusted JSON directly to `DashboardData`, while the server independently
assembles an untyped envelope.

Recommended smallest fix: define one side-effect-free dashboard DTO contract,
annotate the server envelope with `satisfies`, and import its types into the
console. If rollback across schema versions is required, add an explicit
version and boundary parser rather than relying on comments and unchecked
casts.

### P1: lint all shipped TypeScript

[`biome.json`](../../biome.json#L8) omits `admin/src` and `packages`, so the
declared root lint gate does not cover the console or published providers.
The admin `lint` script is actually a typecheck.

Recommended smallest fix: include console TSX and package TypeScript in the
root Biome gate, rename the admin script to `typecheck`, and make CI invoke one
authoritative lint definition.

### P1: remove false optionality from provider peer dependencies

All four provider packages import `auggy` contracts at module load but publish
the `auggy` peer as optional. This permits a package-manager-valid installation
that fails on import and requires repeated README caveats.

Recommended smallest fix: remove `peerDependenciesMeta.auggy.optional`, keep
the compatible peer range, and update the manifest test to assert the actual
runtime dependency contract.

## Consolidation opportunities

These are worthwhile after the P0/P1 fixes, but should remain small utilities
rather than new frameworks.

- Replace the private `readBodyWithCap` in
  [`web-transport.ts`](../../src/transports/web-transport.ts#L570) with the
  canonical bounded helper in
  [`request-body.ts`](../../src/transports/request-body.ts#L27).
- Extract exact SQLite schema declaration parsing and comparison from the
  repeated implementations in idempotency, console-chat, jobs, notify, and
  Telegram replay stores into [`lib/sqlite.ts`](../../src/lib/sqlite.ts).
- Share constant-time comparison and admin CSRF-result translation instead of
  maintaining several nearly identical security helpers.
- Normalize capability-route facts once, then derive both presentation badges
  and findings from that record.
- Remove `chatVisible` from console workspace state and derive it from
  `visibleTarget !== null`; keep the reducer/effect separation intact.

## Cleanup applied in this pass

Repository-wide reference searches proved the following code unreachable or
redundant:

- Deleted the unused parallel `scaffoldAgent` implementation and its private
  test suite. The operator-facing create flow is owned by
  `src/cli/commands/create.ts`.
- Deleted seven isolated generated console UI primitives with no production or
  test consumers: sidebar, breadcrumb, scroll-area, switch, separator, sheet,
  and skeleton.
- Removed the unused `HistoryManager.save/restore` path; production persistence
  already uses versioned `snapshot/replace` through `ThreadHistoryPersistence`.
- Removed unused tool-selector turn/threshold scaffolding and its unpopulated
  internal category field.
- Removed the ignored `finalizeReturn` option, an obsolete memory-origin
  serializer, stale commentary/type scaffolding, and an exact duplicate memory
  authorization test.
- Updated the historical audit reference that pointed at the removed legacy
  scaffolder.

The deleted files are recoverable from Git history.

## Compatibility decisions intentionally deferred

The following code is old or currently unreachable, but removing it without a
decision would change public or durable behavior:

- `summarize` is a public compaction option but currently aliases truncation;
  deprecate it for a release or remove it as an explicit breaking change.
- Bare-array history snapshots are durable-data compatibility and need a
  migration/support-window decision.
- Distributed coordination is publicly configurable and implemented but not
  connected to agent runtime startup; move it behind an explicit preview
  boundary or finish the integration.
- Multiple turn gates are publicly composable in types/tests even though the
  protocol cannot guarantee atomic confirmation.
- `handleInternalTurn` makes augments manufacture kernel traces and accounting;
  narrowing it is architecturally sound but requires an augment API migration.
- Public trace fields for deferred two-phase tool selection should be removed
  only with a trace-schema compatibility decision.

## Areas to preserve

- `kernel/execution-context.ts`, `kernel/timeout.ts`, and
  `kernel/trace-emitter.ts` are compact security/accounting boundaries.
- `memory/registry.ts` has cohesive ownership and lookup rules.
- `console-request-security.ts` is explicit and fail-closed.
- The pure console chat reducer is complex because it models real race and
  rollback behavior; do not fold it back into the React provider.
- Route artifact parity tests and the tracked-test inventory are release
  controls, not simplification targets.
- Provider-specific adapters should keep distinct failure semantics; OpenRouter
  already shares the appropriate OpenAI wire helpers.

## Verification

- `bun run typecheck`
- `bun run lint` (passes; existing Biome schema-version informational message)
- `bun run --cwd admin lint`
- 98 focused kernel/memory tests after cleanup
- test-surface inventory against the post-deletion index: 279 runtime, 29 admin,
  and 3 isolated external tests across 14 shards
- before cleanup, broader kernel/coordination/memory, CLI, and console slices
  passed 450, 1,186, and 243 tests respectively

The monolithic `bun run test` command could not be used as final evidence in
this sandbox: its first HTTP shard exhausted its bounded port probes with
`EADDRINUSE` before tests ran. The independently executed non-listener slices
above passed.
