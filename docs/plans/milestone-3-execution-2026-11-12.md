# Milestone 3 — executable reference application

Status: execution authorized; foundation gate G0 accepted on verified main
`209185d0e7481b4ff5d3b4c87e3447e7583b2fef`. M3-00 contracts are reviewed and
verified; dependent implementation follows the recorded freeze commit.
This is the execution packet for specialized engineering subagents,
orchestrated by the CTO / AI Engineering Lead. It supplements the
[release plan](./release-0.6.0-the-tree-2026-08-18.md) and implements the accepted
[ownership ADR](../adr/2026-11-12-inspectable-agent-application.md).

## Outcome and baseline

An engineer opens one reference application and can follow the code that starts
the service, handles `POST /agent/run`, composes configured augments, and chooses
the next model/tool step. Editing that application changes real execution.
Installed Auggy operations retain authorization, accounting, persistence,
scheduling, and lifecycle guarantees. Built-ins remain package dependencies.

The original architecture inspection used committed main
`29147dfc7af0de59c3631c34a164ed3f3f6f4d5c`. The accepted implementation baseline is
`209185d0e7481b4ff5d3b4c87e3447e7583b2fef` (`M3_BASELINE`), from merged
[foundation PR #226](https://github.com/looselyorganized/auggy/pull/226).
Its tree `30bd2b764c6e136708a82fc186ce733e3741a4ff` exactly matches reviewed
candidate `1f4c6e3fd2f54a2e7f2d3f1f9b0740bac961b38c`. Runtime/host architecture
remains the original main design; foundation changes include dependency policy,
pricing repairs, execution evidence and the narrow Link participant UUID fix.
Neither authoring experiment nor the dirty original checkout supplies assumptions.

**G0 accepted:** Link 0.2.0 is published and registry-verified, integrated in the
root lock and catalog; all 29 PR checks and independent artifact review passed;
foundation merged; fresh [main CI](https://github.com/looselyorganized/auggy/actions/runs/43357821694)
and [CodeQL](https://github.com/looselyorganized/auggy/actions/runs/43357821675)
passed. PostgreSQL 17 completed all 13 registered cases with zero skips, and the
workspace audit has no advisories. Identical-tree local/Linux release rehearsals
each passed 34 scenarios and nine positive audits, including real fresh/retained
registry Link execution. Preserve these as regression gates.

This packet is reconciled against that exact main revision. Runtime implementation
is authorized under the user's instruction to proceed once the foundation is
ready. It does not authorize an Auggy package publication. Worktree retirement
remains independent and deferred; original dirty main and experiments are retained.

## Scope

Deliver one versioned reference application, managed runtime operations, an
externally mounted HTTP adapter, project-local execution, and installed-package
acceptance evidence. Retain the existing application mode for old projects.

Do not implement the generalized `auggy create` scaffold, configuration migration,
static inspection system, Next.js frontend/client SDK, Railway infrastructure,
new provider, distributed coordination, or an upgrade codemod here. Milestones
4–6 retain those outcomes. Existing launch/deploy paths must remain compatible;
their preservation is not a new deployment product.

Use existing inline object entries in `agent.yaml` for the reference application's
augments. Main's parser already supports these and custom `source` paths. This
proves central configuration without importing an experimental parser or writing
an M4 migration. TypeScript must not maintain a second enabled-augment list.

## Source map and extraction boundaries

| Current owner | Existing responsibility | M3 boundary |
| --- | --- | --- |
| `src/cli/index.ts`, `resolve-config.ts` | Command imports and project lookup | Thin package selection before runtime imports; preserve name/config resolution |
| `src/cli/commands/dev.ts` | Config/provider/augment loading, PID and volume ownership, jobs, signals, readiness | Reuse a managed host from both legacy CLI and application startup |
| `src/agent.ts` | Admission barrier, keyed scheduling, thread ownership/history, internal turns, post-turn delivery/hooks | Invoke selected turn program inside existing ownership and settlement boundaries |
| `src/kernel/turn-loop.ts` | Internal-turn handling, context, inference/tool loop, validation, reservations, accounting, snapshots | Extract guarded phase operations; default and application programs share them |
| `src/transports/web-transport.ts` | Auth, routes, stream delivery, durable idempotency, listener lifecycle | Separate guarded request handling from managed listener binding |
| `src/cli/import-from-agent.ts` and resolvers | Explicit project-local dependency loading | Use coherent selection rules; no ancestor/global fallback |
| `src/cli/durable-jobs-runtime.ts` and `src/jobs/` | Worker startup/drain and persistent work | Keep existing ordering and dispatch through the selected turn program |

Kernel changes are justified specifically by the accepted application-owned
orchestration boundary. They are an extraction with behavioral parity, not a
general kernel rewrite. Do not copy security-sensitive operations into the app.

## Reference application and execution path

Proposed application under `examples/inspectable-agent/`:

```text
inspectable-agent/
├── agent.yaml                 # configuration, augments, entrypoint declaration
├── package.json               # local Auggy/provider dependencies; start script
├── bun.lock                   # reproducible standalone consumer install
├── tsconfig.json
├── .env.example               # placeholders only
├── .gitignore
├── README.md                  # request path and supported edits
├── src/
│   ├── index.ts               # actual startup function for every app launch
│   ├── agent.ts               # config-driven composition + turn program binding
│   ├── http.ts                # visible POST /agent/run mount and remaining routes
│   ├── turn.ts                # actual inference/tool control flow
│   └── augments/
│       └── example/
│           ├── index.ts       # narrow tool/route adapters and explicit policy
│           ├── schemas.ts
│           └── service.ts     # deterministic demonstration domain operation
└── node_modules/              # installed, ignored
    ├── auggy/src/             # actual guarded operations and built-in source
    └── @auggy/anthropic/      # installed provider implementation
```

This is a reference application's proposed tree, not a claim that today's
`auggy create` emits it. The built-in `layeredMemory` implementation, if enabled,
still resolves to `node_modules/auggy/src/augments/layeredMemory/`. Do not copy it
or add a misleading local wrapper that is never executed. Use ordinary source
imports/IDE navigation and a concise README map to locate installed operations.

Follow the existing example convention for development dependencies (`file:../..`
and the provider's repository-relative path). Document that this is a development
checkout binding. The packed harness materializes a separate standalone consumer
whose manifest points to exact tarballs, creates/preserves its own lock, and
records both identities. Never commit temporary absolute tarball paths. The
reference has its own typecheck command: root TypeScript configuration currently
excludes `examples/`, so root typecheck alone cannot certify this application.

```text
direct start or selected local CLI
  → src/index.ts main(launchContext)
  → managed host acquires ownership and composes src/agent.ts
  → src/http.ts mounts POST /agent/run through guarded HTTP adapter
  → adapter authenticates, validates and owns durable request delivery
  → agent admits/schedules/restores the authorized thread
  → src/turn.ts selects model/tool steps
  → managed operations invoke configured augment → schemas → service
  → runtime settles accounting/history/hooks; adapter completes/replays stream
```

Package startup helpers may own safe mechanics. The application must visibly
choose its composition, mounts, turn program and listener start. A CLI that
ignores `index.ts` and silently starts a different host does not satisfy M3.

## Contract decisions for implementation

The [M3-00 contract packet](./milestone-3-contracts/README.md) freezes the exact
shared public/private types and compile-only fixtures. Runtime implementation is
still pending; these behavioral constraints bind the dependent tasks. New
operations remain in the existing `auggy` package, with an `auggy/application`
subpath; do not create another npm package for this milestone.
Public runtime types remain in `src/types.ts` under repository conventions.

### C1. Application discovery and startup

Add one opt-in block to `agent.yaml`:

```yaml
application:
  entrypoint: ./src/index.ts
  contractVersion: 1
```

Resolve the path relative to the selected config/project. CLI discovery validates
the declared file and supported contract before importing application or augment
code. Direct `bun src/index.ts` necessarily evaluates ESM imports first: its
helper validates before configured factories/resources start, and trusted app
modules must remain inert at import. No
convention-only auto-execution of an arbitrary `index.ts`; no silent legacy
fallback when application mode is requested but unsupported.

The application exports one named `main(launchContext)` startup function. Direct
execution invokes it through a package launch helper; local CLI invocation calls
the same function with a validated launch context. An import alone does not start
the service. The context carries config location, launch mode and approved host
settings, not user-supplied identity or scheduler lease objects. Ownership is
acquired once, before configured providers/augment factories start resources.

The host owns process identity, lifecycle claims, volume/resource leases, jobs,
startup rollback and shutdown mechanics. The managed launch runner alone owns
process signals and process termination. The application calls
its composition/mount/start operations in readable order. Readiness occurs only
after all required transports and workers are ready. No CLI-only safety mode:
direct application startup must receive the same protection.

The launch runner registers the host and its cleanup before app code can start
it. Proposed shape: `main(launch)` calls `launch.createHost(...)`, then
`host.start()`. `main` throwing after `start()` still triggers owned cleanup;
returning without a ready host fails clearly. The runner owns process signals;
host methods do not call `process.exit` or install duplicate signal handlers.
The project entrypoint guards its direct launch helper with `import.meta.main`
so CLI imports remain inert.

Errors during configuration, module loading, augment boot, listener binding,
worker startup or app startup unwind owned resources exactly once. Shutdown
stops admission, drains/stops work in existing order, closes stores/listeners,
and releases process ownership last. Preserve supported SQLite behavior and
refuse ordinary PostgreSQL coordination startup as today.

A programmatic `host.stop()` deadline does not authorize release of claims while
live or unknown side-effect work remains. Retain required ownership/quarantine
until settlement or process termination makes reclamation safe under the existing
process-identity protocol. Do not put unconditional claim release in a timeout
`finally` block. Test this separately from normal graceful shutdown.

### C2. Guarded turn program

The package creates a managed session after admission and scheduler ownership.
The application receives immutable views and guarded phase methods, not a raw
model client, raw tool callbacks, writable history, peer identity, leases, or
accounting setters. Proposed `TurnProgram` returns a runtime-issued completion;
it cannot construct an authoritative `TurnResult` as ordinary application data.

The application recipe must show real branching and iteration. Illustrative
shape, checked by M3-00's typed contract fixture:

```ts
export const runTurn: TurnProgram = async (turn) => {
  const internal = await turn.dispatchInternalTurn();
  if (internal.handled) return internal.completion;

  const prepared = await turn.preparePrompt();
  if (prepared.kind === "terminal") return prepared.completion;
  while (turn.remainingInferences > 0) {
    const step = await turn.infer();
    if (step.kind === "answer") return turn.complete(step);

    const batch = await turn.executeTools(step);
    if (batch.kind === "terminal") return batch.completion;
    if (batch.kind === "final-answer-required") {
      const recovery = await turn.inferFinal(batch);
      return recovery.kind === "terminal" ? recovery.completion : turn.complete(recovery);
    }
    await turn.refreshPrompt();
  }
  return turn.finishAtLimit();
};
```

Every operation validates its session, phase and receipt at runtime, not only
through TypeScript. Reject cross-session, stale or fabricated receipts, duplicate
tool dispatch, concurrent phase calls, use after close, unfinished-program return,
and calls out of order. This protects supported usage from accidental bypass;
application TypeScript remains trusted code, not a sandbox.

Package-owned operations preserve these existing details:

- Admission, `onTurnStart`, mutable-memory policy, context bounds and tool selection.
- Model response limits, deadlines, cancellation, ordered streaming and accounting.
- `max_tokens` completion even with tool calls; tool dispatch when `end_turn`
  also contains calls; internal-handler early completion before normal inference.
- Validate/authorize/reserve a tool batch before side effects; retain current
  parallel dispatch semantics and ordered history/tool identifiers.
- Termination, unknown outcomes, retry rules, reservation settlement, quarantine,
  and durable history ownership/commit on every existing terminal path.
- The existing extra final-answer inference after repeated tool failures is a
  specific managed transition, not a loophole for unlimited extra inference.
- Internal, injected, scheduled and transport turns use the same selected program.
  Runtime retains causal injection depth and scheduler ownership.

The default legacy program uses these same operations. Two maintained copies of
the loop or guard logic are unacceptable. The session wrapper owns unconditional
settlement on return, exception and cancellation. Preserve existing hook ordering
and success/failure applicability; do not run success hooks on provider exceptions
merely to make a new callback uniform. Add a bounded finalization observation
contract without changing existing `onTurnEnd`/`scheduleAfterTurn` behavior.
Provider/program exceptions require correlated terminal failure evidence.

`complete()` creates terminal intent; it does not itself commit/emit a success
that could be contradicted by a subsequent app exception. The wrapper accepts the
returned receipt and settles once. Finalization observation runs once after
kernel settlement and the durable-history commit attempt, with an explicit
persistence/unknown-outcome result, before the existing post-turn pipeline.
Observation failure is bounded and cannot replace the turn outcome. Logical turn
settlement does not imply release of a lane retained for detached tool effects.
Persistence/accounting failure or unknown outcome must not be overwritten by a
successful receipt; preserve prior causes only as sanitized classification codes,
never raw exception messages or cause objects.
M3-00 freezes explicit error precedence from current behavior and tests it.
Console history may be staged for an atomic transport commit after post-turn
hooks; observation must label that state `deferred-to-transport`, never durably
committed. Existing HTTP already buffers terminal success until transport
persistence completes; preserve that protection.

Observation covers every valid turn scheduling attempt, including queue rejection,
cancellation, failed history restoration and pre-session rejection. HTTP auth or
schema failures and startup failures that never become turn attempts are excluded.
It receives immutable metadata once, with a fixed 1,000 ms package timeout and no
retry; failure or late completion cannot alter the turn result or hook behavior.

Bound opt-in asynchronous program execution and revoke further session operations
after deadline/cancellation. The accepted policy is a 900,000 ms default and
maximum for opt-in application programs, allowing a smaller positive integer.
It begins immediately before the
program runs and combines with caller/job cancellation at the earliest deadline.
Legacy timing remains unchanged. This deadline revokes program operations; it
does not authorize abandoning durable cleanup or releasing live-effect claims.
Test late completions and pending effects with the existing unknown-outcome rules.
Do not claim this can preempt an infinite synchronous loop
in trusted project TypeScript; process isolation is outside M3.

Provide guarded early stop at a quiescent phase (`application-limit` is the
proposed reason). It must settle normal accounting/history without pretending a
pending tool effect completed. This enables a meaningful supported customization:
an app may lower its inference ceiling; it cannot raise package-enforced limits.
An explicitly lowered ceiling is a hard total across managed inference calls,
including recovery inference. It does not certify model calls privately owned by
existing internal augment handlers. Preserve the default legacy recovery allowance.

### C3. HTTP and transport binding

`http.ts` visibly mounts `POST /agent/run` to a package handler that owns auth,
validated identity, request limits, thread ownership, idempotency/replay,
cancellation and streaming. It connects to the composed agent/selected program.
Do not expose `TransportKernel.handleInbound` as an unauthenticated public HTTP
shortcut or let request bodies manufacture trusted `TurnTrigger.peer` values.

Extract handler preparation from listener activation while retaining one guarded
implementation. The existing webTransport can use that adapter internally; the
reference app mounts it explicitly. Retain existing console, health/readiness,
augment routes, CORS/preflight, origin/proxy rules and anonymous/visitor identity.
Current webTransport has no WebSocket upgrade API; do not invent one. Other
augments' existing socket lifecycles remain intact. The fallback handler must use the
same policies and must not create a second, less protected `/agent/run` path.

The managed listener owns required Bun server options, body and
idle limits, startup barrier and shutdown. Binding twice, mounting after readiness,
or selecting conflicting transport ownership must fail clearly. There must never
be both an implicit webTransport listener and an app listener for the same config.
Application code owns the route composition; security-sensitive routing remains
inside the maintained adapter.

Preserve keyed durable runs surviving a client disconnect, non-keyed cancellation,
overflow abort behavior, bounded replay and unknown-outcome handling. A route
refactor must not change those established distinctions.

### C4. Local package selection and compatibility

An updated global CLI is a launcher for project execution. Resolve the selected
project and explicitly installed local Auggy before importing runtime-bearing
commands. Current `index.ts` statically imports them, and `resolve-config.ts`
imports the heavier config parser: delegation inside `buildCli()` is too late.
Extract a minimal location/metadata layer with no runtime or augment imports.

Validate installed package capabilities from declarative metadata; compare the
application contract, not global/local version equality. Delegate once, preserving
argv, config selection, working directory, launch mode, exit code and signals.
Loop detection and actionable missing/incompatible dependency errors are required.
Never auto-install or fall back to an unrelated ancestor/global runtime.

M3 retains the current explicit project-local dependency policy, including
currently supported explicit workspace links. General hoisted-monorepo resolution
is deferred to M4/M5; runtime, provider, Link import and doctor paths must agree
on the supported policy. Do not make core resolve from a location its providers
cannot use.

| Launch path | Required M3 behavior |
| --- | --- |
| Reference `bun run start` / direct entry | Project main + managed host + local package |
| Project-local CLI `run` and `dev` | Same project main and runtime |
| Updated global CLI `run` and `dev` | Select local package first, then same main |
| `start` / `restart` generated launchd execution | Preserve immutable identity/generation fences and launch local application |
| Existing Docker/Railway command path | Preserve generated launch semantics and local selection; no new hosted deployment claim |
| `stop` / `status` and recovery | Remain usable when app imports or its installed dependencies are broken |
| Legacy config without application block | Local legacy program, existing behavior and guards |
| Application opt-in with old/incompatible local runtime | Reject before application/factory imports, claims or provider calls |
| Old global CLI without new bootstrap | Unsupported for app mode; document minimum launcher and authoritative local start command |

A pre-M3 global binary cannot be retroactively fixed. Test honest mixed-version
support, including updated launcher → older local legacy runtime. Read-only
commands must not accidentally import/start the application. Route inspection
currently executes augment lifecycle code; static inspection is still M4 work.

`status`/`stop` recovery uses the existing validated process identity and a narrow
operator path even when local application loading is broken. This is not permission
to start an agent with the global runtime. Never stop a process using only an
unverified numeric PID. Prove recovery after making the installed entrypoint or
local dependency unavailable, with zero application imports during recovery.

The accepted M3 runtime floor is Bun 1.3.14, the certified toolchain. M3-03 must
align the package requirement and generated Docker runtime (currently 1.2.14)
and document this compatibility change. Do not retain a supported 1.2.x claim
without a separate passing certification matrix. No package release is implied.

## Work packages and specialist ownership

The orchestrator owns contract freeze, sequencing, shared files, integration,
review disposition and milestone acceptance. Specialists implement within their
assigned boundaries. Their completion messages are evidence submissions, not
permission to merge. At most three specialists run concurrently, plus root.
Link release is complete. The first execution wave freezes contracts before
parallel runtime, host and harness implementation begins.

| ID | Specialist / outcome | Dependencies | Exclusive implementation scope |
| --- | --- | --- | --- |
| M3-00 | Runtime architect + CTO: freeze contracts and baseline | G0 | CTO owns shared types/exports and contract fixtures |
| M3-01 | Runtime engineer: managed turn phases + legacy parity | M3-00 | `src/kernel/turn-session.ts`, `turn-loop.ts`, focused kernel tests |
| M3-02 | Transport/lifecycle engineer: managed host + external HTTP mounting | M3-00 | `src/application/`, web transport extraction, lifecycle/HTTP tests |
| M3-03 | CLI/platform engineer: local selection and all launch wiring | M3-00; integrate after M3-02 | Minimal bootstrap/resolver modules, CLI launch/doctor integration, CLI tests |
| M3-04 | Application/DX engineer: executable reference app | M3-01, M3-02, M3-03 | `examples/inspectable-agent/`, its README and fixture-owned source |
| M3-05 | Harness engineer: installed execution and edit/delegation proof | Contract work after M3-00; execution after M3-04 | New reference runner/fixtures in `scripts/release-smoke/`, harness tests |
| M3-06 | Independent runtime/security reviewer: adversarial review | M3-01–M3-05 integrated | Read-only findings; fixes go back to owner |
| M3-07 | CTO/integration engineer: certification and reviewable handoff | M3-06, no unresolved blockers | Shared docs/CI/release integration and evidence ledger |

Reserved shared files: `src/types.ts`, `src/index.ts`, `src/agent.ts`,
`src/cli/types.ts`, `src/cli/config-parser.ts`, `package.json`, lockfiles, `tsconfig.json`,
`src/cli/commands/dev.ts`, `scripts/release-smoke.sh`, CI workflow and inventory
files. CTO applies proposed changes serially, or explicitly grants one temporary
owner. No simultaneous writers. M3-01 supplies the agent invocation seam;
M3-02 supplies bootstrap extraction; M3-03 changes command delegation only after
that host contract is integrated. Provider implementations and unrelated pricing
are outside all packets.

Execution waves:

1. G0 → M3-00. Rebase the planning branch onto accepted main; capture exact
   source/lock/toolchain identity; freeze API/state-machine and lifecycle fixtures.
2. M3-01 and M3-02 in parallel. A third specialist prepares M3-05 assertions and
   fixtures against the frozen contract; those tests are not acceptance evidence.
3. Integrate both seams and run focused parity. Complete M3-03, then unlock
   M3-04. The harness specialist can continue independent fixture work meanwhile.
4. M3-04 + M3-05 complete the real installed path. CTO integrates shared changes.
5. Freeze code; M3-06 reviews it independently. Owners fix findings, reviewer
   rechecks, and relevant acceptance reruns before M3-07 certifies the candidate.

Do not parallelize a producer and dependent consumer against different guessed
APIs. A contract change pauses affected dependents, updates fixtures and prompts,
and receives CTO review before work resumes. Do not merge partial phase extraction
that changes legacy semantics while its session tests remain incomplete.

### Task details and handoffs

**M3-00:** Inventory every branch of current turn execution, admission and
settlement; map each to an operation/state and an existing regression. Freeze
startup rollback ordering, app-entry protocol, HTTP ownership and public types.
Output a reviewed contract fixture and ownership table, including normal, denied,
internal, canceled, tool-terminated and outcome-unknown cases. Reject a contract
that needs raw peer/model/tool injection or leaves finalization to app convention.

**M3-01:** Extract operations incrementally and adapt the legacy loop first.
Then enable the application program through the shared agent seam. Characterize
existing unusual branches before changing them; keep repair proposals separate.
Tests include receipts/state misuse, concurrency, hook counts, inference limits,
tool authorization, costs on multi-iteration failure, and durable history after
exceptions. Hand off a source/state map and traces showing old/new default parity.

**M3-02:** Factor existing bootstrap and guarded HTTP processing, preserving all
operator and transport behavior. Show acquisition/rollback/release ordering in
tests. Test duplicate listener prevention, no ingress before readiness, partial
boot failure, concurrent shutdown, active stream drain, jobs ordering and failure
to commit durable state. Include `defineAgent()` construction throwing after
resource claims: main currently constructs it outside the preceding cleanup
catch in `src/cli/commands/dev.ts`. The managed host must cover that failure and
the later boot/bind failures. Hand off a handler surface and exact managed-host
operations for M3-03/M3-04, with no application-required hidden cleanup step.

**M3-03:** Implement minimal pre-import dispatch, protocol preflight and single-hop
delegation. Preserve config lookup, `.env` precedence, browser/console launch,
PID/log management, restart generation and existing deploy command behavior.
Test side-effect sentinels proving rejected launch imports neither app nor
providers/augments. Hand off the launch matrix, supported launcher floor and
actionable errors; do not claim OS service execution from a mocked plist test.

**M3-04:** Build the tree above with one narrow deterministic custom capability.
No extra UI or business workflow. Show a source path for both its tool and route
policy. Use YAML-enabled built-ins without redundant TS factory lists. Provide
the runnable request example and allowed turn customization. The supported
2 → 1 app inference ceiling must actually change provider calls through guarded
early stop while recording tool results and costs. A log-only edit is insufficient.

**M3-05:** Extend the existing deterministic provider fixture and packed runner;
do not build a second mock runtime. Install actual core/provider tarballs outside
the checkout, then copy only the reference's application-owned files. Assert local
runtime identity, startup execution, changed control flow, failures and replay.
Keep legacy packed scenarios too. Hand off sanitized, hashed artifacts and all
scenario assertions, including negative controls that demonstrate test sensitivity.

**M3-06:** Review the frozen candidate against the accepted ownership ADR and
the matrix below. Trace every public operation to its maintained guard. Try to
invalidate package selection, identity, receipt ownership, settlement, readiness,
replay and local-edit evidence. Report severity, reproduction, affected contract,
and required repair; do not rewrite unrelated code or lower the acceptance bar.

**M3-07:** Integrate only reviewed work, update canonical docs and run appropriate
full acceptance once on a frozen commit. Preserve failures, not just the eventual
pass. Refresh affected checks after fixes. Create a reviewable M3 PR with exact
head/base/tested-merge identities, compatibility effects and evidence. Acceptance
requires no unresolved blocking review findings and all required checks green;
merging/publishing still follows repository policy and final review.

## Acceptance matrix

| ID | Required observation | Primary owner |
| --- | --- | --- |
| A01 | Same project startup and turn source executes via direct/local/updated-global paths; installed package hashes identify local core/provider | M3-03/05 |
| A02 | Harmless local HTTP-source edit changes an observed response; actual `/agent/run` mount retains auth, and forged identity causes zero provider/tool calls | M3-02/05 |
| A03 | Real provider → validated custom/built-in tool → provider response, terminal stream and correlated trace | M3-04/05 |
| A04 | 2 → 1 app ceiling changes model calls after a real tool batch; cost/history settle; package budget cannot be increased | M3-01/05 |
| A05 | Invalid tool arguments, denied authorization, duplicate/cross-session receipts and invalid phase order have no unauthorized effects | M3-01/06 |
| A06 | Provider failure, timeout, cancellation, program exception/early return and tool termination settle once with correct hooks/history/quarantine and correlated terminal failure evidence | M3-01/02 |
| A07 | Scheduler isolation, owner mismatch, causal/internal turns, overflow and queued cancellation preserve current behavior | M3-01/02 |
| A08 | Duplicate request and restart replay do not repeat inference/tools; durable vs non-durable disconnect semantics remain distinct | M3-02/05 |
| A09 | Partial boot, listener conflict, repeated stop and active jobs/streams release owned resources correctly; no early readiness | M3-02 |
| A10 | Startup rejects missing/ancestor-only/incompatible local runtime before execution; same-version different artifacts select local code; no delegation loop | M3-03/05 |
| A11 | Legacy/operator/route/launch contracts hold; after entrypoint or dependency removal, global status/stop recovers the exact running process without app import | M3-02/03/05 |
| A12 | Fresh packed app and retained-lock upgrade preserve owned source and use candidate artifacts; all dependency audit surfaces pass | M3-05/07 |
| A13 | An engineer can identify startup → endpoint → turn → augment from the actual app; documented customization is exercised in acceptance | M3-04/06 |

A13 is a technical traceability walkthrough in M3. It is not yet a measured
usability improvement or the five-minute external-engineer study; M6 owns that
claim. Record any navigation confusion as a finding instead of declaring DX
success from a file count.

## Verification and evidence

Use `bun:test` and existing regression families. Relevant starting points include:

- `tests/kernel/turn-loop.test.ts`, `turn-loop-terminate.test.ts`, `turn-gate.test.ts`,
  `cost-commit-multi-iteration.test.ts`, `abort.test.ts`,
  `thread-history-persistence.test.ts`, `runtime-readiness.test.ts`.
- `tests/kernel/keyed-turn-scheduler.test.ts`, `schedule-after-turn.test.ts`,
  `tests/integration/delegated-authz-agent-run.test.ts` and
  `layered-memory-auto-save-cost-flow.test.ts`.
- `tests/transports/web-transport.test.ts`, `web-idempotency.test.ts`,
  `idempotency-store.test.ts`, `console-request-security.test.ts`.
- `tests/cli/commands/dev.test.ts`, `durable-jobs-runtime.test.ts`,
  `pid-registry.test.ts`, `runtime-volume.test.ts`, `runtime-resource-claims.test.ts`,
  `import-from-agent.test.ts`, `start.test.ts`, `restart.test.ts`, and deploy tests.

Add focused tests for the genuinely new state/host/bootstrap contracts. Keep
tracked inventory selectors correct. Contract snapshots/client/OpenAPI/protocol
fixtures change only if their owning public behavior changes; explain that delta.
Do not add tests that merely mirror a helper's implementation.

Each specialist runs `bun test <owned focused paths>`, applicable typecheck and
lint, then the orchestrator runs integrated targeted checks. The final frozen
candidate runs frozen install, inventory, typecheck, lint, full tracked runtime/
console/Temporal suites, console build, strict audit and packed release rehearsal.
Linux boundary jobs, CodeQL and required PostgreSQL 17 execution remain required.
Independently run the reference's frozen installation, `bun run typecheck` and
focused tests, and repeat typecheck against the materialized packed consumer so
repository aliases cannot mask missing package exports or types.
Record macOS launchd execution separately from Linux command-generation evidence;
absence of the platform is an unavailable check, never a pass.

The packed harness retains existing 60-second readiness, 120-second scenario and
15-second shutdown budgets unless an evidence-backed change is reviewed. Allowlist
child environment, isolate HOME/state/ports, use dummy provider credentials and
loopback services, stop every owned child, and retain bounded failure logs.
No live provider credentials, production agent data, or hosted deployment needed.

Record source SHA and dirty diff hash, baseline SHA, toolchain/OS, lock/package/
application hashes, executed paths, commands/durations/exit codes, provider/tool
counts, run/thread correlation, source-edit before/after, process cleanup, and
review disposition. Evidence cannot contain `.env`, auth headers, secrets or
unbounded raw registry output. Do not edit running rehearsal scripts.

Same-version different tarballs are valid package-selection tests but must be
labeled as artifact experiments, not an npm-version release. Legacy and new app
mode must both be tested with installed artifacts. Local source imports, a
symlink into the monorepo, fake TransportKernel, or fake product provider do not
certify the packed path. Supported workspace-link tests are a separate fixture.

## Orchestrator protocol and durable handoff

Task state is tracked in [the execution ledger](./milestone-3-tasks.json).
G0 is accepted; M3-00 contract verification passed. The ledger records its freeze
commit and dependent task states. The CTO alone accepts a task and unlocks its
dependents. State progression is `blocked → ready → in_progress → review →
accepted`; failed checks return work to its owner, not to an implicit exception.

Every assignment includes:

```text
Task ID / specialist / objective:
Accepted baseline SHA and integrated producer commits:
Required reading: AGENTS, ADR, this plan, owning source and regression tests
Exclusive write paths and explicitly reserved shared paths:
Frozen contracts and dependencies:
Acceptance IDs, commands and evidence directory:
Forbidden changes / out-of-scope work:
Escalate: contract conflict, guard regression, new dependency, scope expansion
Handoff: changed paths + rationale + commit + exact results + risks + next step
```

Use isolated checkouts or explicit disjoint ownership; keep dependency installs
and lockfile changes under a single writer. At session start, read task state,
accepted contracts, current diff and prior failure evidence. At handoff, leave a
reviewable coherent change and record what remains. A subagent must not claim
completion from compilation or a self-authored mock alone. The independent
reviewer does not review their own implementation. Root verifies evidence and
keeps the user informed about decisions and blockers, rather than forwarding
unreviewed specialist claims.

## Planning review checkpoints

Planning review completed with the runtime-architecture and harness/CLI
specialists. Their findings were incorporated and rechecked: direct ESM preflight
limits, a consistent task DAG, broken-application operator recovery, real HTTP edit
proof, one signal owner, shutdown ownership retention, failure finalization,
deadline compatibility and constructor-failure rollback. Neither reviewer reported
a remaining planning blocker. That review approved the execution packet, not
unimplemented behavior. G0 was subsequently accepted after merged-main verification,
as recorded above.

Before M3-00 is accepted, settle exact exported names and type shapes, entrypoint
validation, contract capability metadata, HTTP/listener binding, host rollback
order, and all turn-state transitions. The recommended decisions above remove
directional ambiguity; source evidence at `M3_BASELINE` determines the final
signatures. No specialist may fill a gap by inventing a competing API.

Adversarial questions for the CTO's review:

1. Does the shown code execute on every supported launch path, including a
   different global/local artifact pair, or is any file decorative?
2. Can a supported edit bypass admission, budgets, authorization or settlement?
3. Did handler extraction lose console routes, identity, durable replay or
   disconnect behavior, or accidentally bind two listeners?
4. Does direct startup lose CLI-owned resource claims/jobs/cleanup?
5. Are internal turns and the legacy program using the same maintained operations?
6. Is a passing test proving real installed behavior or only mocked wiring?
7. Have source ownership, configuration authority or supported package-resolution
   boundaries silently changed?

## Harness guidance applied

Keep architecture and task knowledge in the repository and enforce important
boundaries with checks instead of relying on increasingly long prompts. This
informs the source map, ownership table and behavioral acceptance gates here.
[OpenAI, Harness engineering](https://openai.com/index/harness-engineering/).

Make bounded increments, leave durable progress records and verify the complete
user path before marking work done. This informs the execution ledger, frozen
candidate rehearsals and evidence-based handoffs.
[Anthropic, Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

Give specialists explicit objectives, boundaries and expected outputs; reserve
parallelism for independent work. This informs the contract freeze, execution
waves and separate reviewer. It is a workflow choice for this repository, not a
claim that research-agent performance results predict coding throughput.
[Anthropic, Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system).
