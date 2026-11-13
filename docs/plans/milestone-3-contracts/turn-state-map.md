# M3-00 turn ownership and state contract

Status: map accepted for M3-00; shared TypeScript declarations and freeze packet govern implementation.
existing behavior and specifies the extraction; it does not claim the APIs exist.
Baseline: accepted main `209185d0e7481b4ff5d3b4c87e3447e7583b2fef`, tree
`30bd2b764c6e136708a82fc186ce733e3741a4ff`. Source references below refer to that
tree, also present in planning commit `e1eadf3`. Read with the
[ownership ADR](../../adr/2026-11-12-inspectable-agent-application.md) and
[execution plan](../milestone-3-execution-2026-11-12.md), especially C2.

## Ownership and smallest extraction

`src/agent.ts` retains scheduler admission, startup admission, peer/history
authorization, history pinning/locking, persistence, causal leases, delivery and
hook ordering. `src/kernel/turn-session.ts` should own the per-turn mutable state
currently inside `createTurnLoop().executeTurn`, guarded operations, receipts and
terminal intent settlement. `src/kernel/turn-loop.ts` keeps the history-manager
registry and becomes the adapter that invokes a selected program or the default
program against those same operations. The default program is the one maintained
control-flow recipe; do not retain a second private implementation of the loop.

The session factory, provider, tokenizer, history manager, capability table,
augment callbacks, trusted execution context, event emitter and finalization
machinery are package-private. The application gets no constructor for a session,
completion, scheduler lease, peer or accounting record. It cannot replace an
authorized trigger by returning ordinary `TurnResult` data.

The prelude runs after scheduler ownership and history authorization, but before
calling application code: pre-abort check, transactional turn gate, inbound history
append, `onTurnStart`, and `run_started`. Prelude failure skips the selected
program and still reaches managed settlement/observation. Once that prelude passes,
the application must visibly call internal dispatch, prepare the prompt, choose
inference/tool transitions, and return an issued completion. Merely wrapping
`executeTurn()` is insufficient.

## Existing outer turn path

| Phase / baseline source | Existing behavior that remains package-owned | Regression anchors |
| --- | --- | --- |
| Construction, `src/agent.ts:179`, `src/kernel/turn-loop.ts:209` | Wire memory first, build effective augment set/card/lifecycle, reject multiple gate owners, create shared scheduler/history registry. Construction can throw before any turn attempt exists. | `tests/agent.test.ts:29`; `tests/kernel/turn-gate.test.ts:157` |
| Startup, `src/agent.ts:800` | Refuse ordinary coordination startup; boot; restore durable quarantine; collect/validate routes; register every transport; ready every transport; only then open admission. Roll back attempted resources on failure. | `tests/kernel/runtime-readiness.test.ts`; `tests/agent.test.ts:55` |
| Entry, `src/agent.ts:849`, `:966` | Transport ingress schedules through its registered source; injection requires started agent, validates trusted execution context and combines its deadline with caller cancellation. Auth/schema checks upstream of `handleInbound` are outside a valid turn attempt. | `tests/agent.test.ts:288`, `:371`, `:414`, `:566`, `:630`; `tests/kernel/agent-scheduler.test.ts:99` |
| Admission, `src/agent.ts:686` | Recheck durable quarantine; submit under source/global/thread/peer limits, or use a package-held causal parent lease. Startup barrier and cancellation precede `onExecutionStart`; a failing execution-start callback prevents inference. | `tests/kernel/keyed-turn-scheduler.test.ts`; `tests/kernel/agent-scheduler.test.ts:152`, `:658`, `:830`; `tests/kernel/runtime-readiness.test.ts:247`, `:292` |
| History preparation, `src/agent.ts:373`, `:478` | Same-thread lock, exact peer ownership, authenticated public-peer promotion, persistence provider identity, atomic load/claim, validated restore. Injected continuation may reuse persistence capability, never another peer's authority. Pin exact resident manager through post-turn/causal work. | `tests/kernel/thread-history-persistence.test.ts:92`–`:350`, `:617`, `:652` |
| Kernel execution, `src/agent.ts:499` | Selected program is invoked inside the existing ownership boundary. The full kernel path is inventoried below. | Kernel matrices below |
| History settlement, `src/agent.ts:455`, `:505` | Compact and attempt durable commit after either kernel return or throw. Commit failure discards resident history and throws outcome-unknown, overriding a previous kernel failure. Existing per-turn transcript and durable model-history snapshot are different objects. | `tests/kernel/thread-history-persistence.test.ts:452`, `:492`; `tests/kernel/history-manager.test.ts` |
| Post-turn, `src/agent.ts:533`, `:743` | Quarantine an unknown result; outbound delivery, then declaration-order `onTurnEnd`, then declaration-order `scheduleAfterTurn`, joining causal children after each scheduling hook. Original delivery exception is rethrown only after hooks settle. Generic kernel/history exceptions never enter this pipeline. | `tests/agent.test.ts:682`, `:728`, `:792`–`:952`; `tests/kernel/schedule-after-turn.test.ts`; `tests/kernel/agent-scheduler.test.ts:304`–`:574` |
| Lane settlement, `src/kernel/keyed-turn-scheduler.ts:314`, `:343`, `:389`, `:565` | Await owned detached operations and descendants before releasing lane/capacity. Quarantine is applied before successors dispatch. Causal child lease expires on its own settlement. | `tests/kernel/keyed-turn-scheduler.test.ts:372`–`:640`; `tests/kernel/agent-scheduler.test.ts:407`, `:574` |
| Shutdown, `src/agent.ts:930` | Close admission, drain scheduler, await thread locks, shutdown augments, clear handlers/history, mark stopped. Live effects are not released because an application/host timeout elapsed. | `tests/kernel/agent-scheduler.test.ts:971`, `:1031`; host-specific M3 rollback/timeout tests required |

An expired `SchedulerContext.inject` has a separate immediate rejected return
at `src/agent.ts:579`–`:587`, bypassing `scheduleTurn`. It is still an attempted
causal turn and must receive the new once-only observation. Injection before
startup, invalid trusted execution context, HTTP authentication/schema failures,
and construction/startup failures without a scheduled turn remain excluded.

## Every kernel terminal path

There are **15 terminal `TurnResult` construction sites**, one generic terminal
rethrow, and shared/helper throw paths in `src/kernel/turn-loop.ts`. The table
covers all of them; callback returns that only produce a tool entry or model
response are intermediate operations, listed separately below.

`F` means the existing `finalizeReturn()` at line 414: finalize trace duration,
commit cost once only if admission confirmed and recorded inference steps exist,
then record the per-turn transcript. A failure in that ritual throws rather than
returning the proposed result. Trace duration currently excludes cost I/O.

| ID / return source | Trigger and result | Existing settlement / important precedence | Operation / regression |
| --- | --- | --- | --- |
| K01 `:422`–`:443` | Abort result: unsuccessful, canceled. Called before gate `:447`, around start hooks `:554`, `:559`, `:587`, before/after regular inference `:1051`, `:1058`, after tool processing `:1560`. | Emits error+canceled terminal before F. In-flight inference cancellation can instead throw through K16; do not assume all cancellation returns K01. | Prelude or managed cancellation; `tests/kernel/abort.test.ts`, `turn-loop.test.ts:169`, `:1059`, `thread-history-persistence.test.ts:713` |
| K02 `:466` | Gate prepare throws: rejected, `admission-state-failed`, sanitized gate error. | F without cost; no start hook/inference. | Prelude; `turn-gate.test.ts:377` |
| K03 `:490` | Gate denies: rejected, `cap-denied`, gate reason. | Attempt rollback; rollback error logged and ignored; F without cost. | Prelude; `turn-gate.test.ts:123`, `:229` |
| K04 `:517` | Gate confirm throws: rejected, `admission-state-failed`. | Attempt rollback; rollback failure cannot authorize execution. F without cost. Existing error message interpolates original confirm error; the new observer must not copy it. | Prelude; `turn-gate.test.ts:199`, `:249` |
| K05 `:573` | Required `onTurnStart` throws: failed, sanitized error. | If signal is already aborted in catch, K01 wins. Optional hook errors continue. Emits failed terminal then F. | Prelude; `turn-loop.test.ts:169`; add explicit required-start failure parity fixture |
| K06 `:656` | Internal handler throws: failed, sanitized; retain `outcomeUnknown` classification. | F; warning states handler may have lost private model cost. No fabricated cost. | `dispatchInternalTurn`; `schedule-after-turn.test.ts:212` suite; add throwing-handler accounting/unknown fixture |
| K07 `:712` | First internal handler returns non-null: preserve its success/status/response(s)/error metadata. | Merge handler inference steps into authoritative trace; finalize duration; call cost commit **even with zero recorded steps**; merge only response text into transcript; snapshot; emit terminal. Returned tool records are handler's, but baseline transcript snapshot uses local tool records. Preserve this distinction during extraction. | `dispatchInternalTurn`; `schedule-after-turn.test.ts:213`, `:309`, `:392`, `:482`; `tests/agent.test.ts:158` |
| K08 `:777` | Required context provider throws/times out: failed, sanitized. Optional failure skips that provider. | Emits failed terminal then F. This catch currently has no cancellation-specific branch; keep legacy classification/check ordering. Context timeout may retain a detached operation. | `preparePrompt`; `turn-loop.test.ts:767`, `:792`, `:815` |
| K09 `:849` | Initial allocator assembly throws: failed, budget error. | Emits failed terminal then F. Other setup exceptions outside this narrow catch are in X01 below. | `preparePrompt`; `turn-loop.test.ts:203`; `context-allocator.test.ts` |
| K10 `:1111` | No tool calls **or** finish reason `max_tokens`: successful completed result, optional text. | Output validation flags only; append model text, emit nonstreamed text once, F, terminal. `max_tokens` suppresses supplied tool calls; `end_turn` with tool calls does not. | `infer` answer receipt → `complete`; `turn-loop.test.ts:138`, `:1228`, `:1319`, `:1340`; `output-validator.test.ts`; add explicit `end_turn`+calls / `max_tokens`+calls fixtures |
| K11 `:1429` | Any tool result outcome unknown: failed, unknown, no retry. | All batch promises already observed and ordered history appended; unknown beats terminate, recovery, and later cancellation check. F. Detached effect can retain scheduler lane beyond this logical outcome. | `executeTools` terminal; `turn-loop.test.ts:1113`, `:1150`; `agent-scheduler.test.ts:574`, `:708` |
| K12 `:1488` | First successful allowed terminate directive (`input-required` or `completed`). | Entire batch already executes. Ignore directives from error results and spoofed statuses. Optional directive text in transcript/events, F, terminal. Baseline handles directive before post-batch abort check. | `executeTools` terminal; all `turn-loop-terminate.test.ts` cases |
| K13 `:1544` | Repeated schema failures request one recovery inference, then complete. | Reassemble; recorded bounded inference; append/emit final content; ignore recovery response tool requests; F. This call does not increment the ordinary loop counter and can exceed its maximum by one. No regular output-validation branch here. | `executeTools` final receipt → `inferFinal` → `complete`; `turn-loop.test.ts:1189`; `cost-commit-multi-iteration.test.ts:469` |
| K14 `:1587` | Ordinary inference loop exhausted: successful completed fallback text. | Emit fallback, add transcript text, F, terminal. Baseline does not append that fallback to model-visible assistant history. | `finishAtLimit`; add exact fallback/history parity test and new application-limit tests |
| K15 `:1608` | `ModelResponseLimitError` caught inside inference/tool loop: failed, `engine-error`, safe public message. | Emit error+failed terminal, F; known response accounting retained, unknown billing stays unpriced. | Managed inference failure; `turn-loop.test.ts:841`; `engines/response-limits.test.ts`; `cost-commit-multi-iteration.test.ts:145`–`:265` |
| K16 `:1620` | Any other inference/tool-loop throw, including provider error, canceled request, refresh error or settlement error. | Attempt F, then rethrow original unless F fails. Generic first provider error may have zero recorded steps and therefore zero gate commits. A later provider error still commits prior known costs. No normal post-turn hooks at agent layer. | Wrapper exception path; `turn-gate.test.ts:296`, `:357`; `cost-commit-multi-iteration.test.ts:81`, `:109`, `:590`, `:636`; `thread-history-persistence.test.ts:492` |

Additional thrown/continuing paths that must not disappear in the extraction:

| ID / source | Effect and required handling |
| --- | --- |
| X01 `turn-loop.ts:348`–`:414`, `:538`–`:549`, `:678`–`:706`, `:791`–`:828`, `:860`–`:884` | Trusted callback/event emission, tokenizer, history append/snapshot, capability/context setup or trace operations can throw outside the existing loop catch. Claimed-handler cost commit can throw before transcript snapshot. The agent still attempts history commit when `executeTurn` throws. M3's wrapper must settle/observe these paths without fabricating a successful result or invoking new success behavior. Add fault-injection tests rather than claim existing tests cover every throw. |
| X02 `:125`–`:158`, `:941`–`:1038` | Provider error/stream limit closes stream; retained known accounting is attached to limit error. Timeout/cancellation deactivates late deltas/results; unresolved attempts are tracked separately from side effects. At detached provider budget (`max(2,maxConcurrent)`), further dispatch throws before creating another provider attempt. |
| X03 `:896`–`:938` | Memoized cost commit sums all priced steps; any unpriced step makes entire cost unpriced. Commit callback failure throws `OutcomeUnknownError`; a second call reuses its rejected promise rather than writing again. First generic provider exception with no recorded steps does **not** commit a fake zero cost. |
| X04 `:1144`–`:1254` | Whole batch validation/reservation is synchronous before side effects. Capability denial or exhausted quota appends error and **breaks**, preserving earlier executable entries; approval-needed/unknown tool/invalid authorization requirements/delegated denial append error and continue. Bad schema increments per-tool consecutive failures; second failure adds a second explanatory error entry, marks recovery and breaks. Valid schema clears that tool's failure counter before delegated authorization. |
| X05 `:1257`–`:1385` | `Promise.all` dispatches executable entries concurrently; error entries are model-visible synthetic outputs with no tool call event. Trusted event handler/serialization failures outside the tool try/catch can reject the aggregate while siblings are still active. M3 must own/join every dispatched sibling even on this path; never let an early aggregate rejection drop live effects. |
| X06 `:1291`–`:1359` | Tool returns string or structured result. Plain `Error:` text is not failure; structured `isError` is. Tool throw is sanitized; detached/explicit unknown remains unknown. Output byte cap substitutes safe error without clearing unknown. Quotas count dispatched attempts, including throwing/structured failures; there is no quota refund operation. |
| X07 `:1387`–`:1414` | Append tool use/result pairs in model-request order with matching runtime IDs, despite completion-order events. Only non-error tools enter returned `toolCallRecords`; denied/schema-failed/throwing tools are not successful tool records. |
| X08 `:1505`, `:1563` | Refresh/recovery allocator throws through K16 (different from initial assembly K09). Recovery response errors also take K15/K16; no second recovery and no arbitrary extra inference. |
| X09 `src/agent.ts:491`, `:508`, `:511` | History restore/owner failures occur before session and skip compact/commit; commit failure after a kernel throw replaces it with unknown history outcome. Observation needs both the dominant classification and sanitized prior classifications. |
| X10 `src/agent.ts:553`–`:627` | Abort suppresses remaining delivery/hooks. Hook throws are logged and swallowed; unknown hook error quarantines. Detached causal work is joined, even if public promise ignored. Delivery failure is preserved after hooks; these happen **after** finalization observation and are not retroactively added to it. |

The public contract must not assert that arbitrary trusted callback code is
infallible. The new wrapper closes gaps around unexpected throws, active sibling
ownership and receipt misuse; it does not silently alter normal legacy branches.

## Guarded phases and receipts

The per-session state machine is private. Every asynchronous phase transitions
to a busy state synchronously before invoking any callback. A second phase call,
including a duplicate while the first is pending, fails closed. Receipts are
frozen objects registered by identity in package-held state; TypeScript brands
alone are insufficient. Copying an object, `as` casting, cross-turn reuse, stale
receipt reuse, returning the wrong receipt, and JSON reconstruction all fail.

| State | Legal next operation | Next state / meaning |
| --- | --- | --- |
| `internal-dispatch` | `dispatchInternalTurn()` once | Claimed/failed handler → issued terminal intent; otherwise `needs-prompt` (including non-internal triggers) |
| `needs-prompt` | `preparePrompt()` once | Required context/assembly failure → terminal intent; success → `ready` |
| `ready` | `infer()` when ordinary allowance remains; `finishAtLimit()` when exhausted; `stop("application-limit")` | Inference → `answer-ready` or `tools-pending`; safe stop → terminal intent |
| `answer-ready` | `complete(exactAnswerReceipt)` | Terminal intent; no response rewriting, additional inference or tool dispatch |
| `tools-pending` | `executeTools(exactToolBatchReceipt)` | Batch terminal → terminal intent; repeated validation failure → `final-required`; otherwise `needs-refresh` |
| `needs-refresh` | `refreshPrompt()`; `stop("application-limit")`; `finishAtLimit()` if ordinary allowance exhausted | Refresh → `ready`; quiescent stop/exhaustion → terminal intent |
| `final-required` | `inferFinal(exactFinalInferenceReceipt)`; `stop("application-limit")` | One recovery answer → `answer-ready`; explicit application ceiling exhausted → terminal application-limit intent with no model call |
| `terminal-intent` | Return that exact issued completion to wrapper | Wrapper validates no managed operation remains active, accepts intent once, revokes session, settles |
| `revoked` / `settling` / `closed` | No application operations | Rejected operation cannot change accounting/history, emit late events or start work |

No safe stop exists between a model tool-batch receipt and its managed tool
processing, during active work, or while an unresolved effect is being represented
as quiescent. An app can stop before its first inference or after a settled batch.
It cannot invent a successful result for a dispatched tool. A program returning
`undefined`, another session's receipt, an unconsumed answer, or a completion
while work is active is a contract failure. A program that creates completion
then throws has failed; merely creating the receipt does not publish success.

Cancellation revokes new operations immediately. Package-owned in-flight work
must settle or be fenced/tracked before managed state is finalized. Do not use a
bare `Promise.race(program, timeout)` and then release ownership while an active
phase can still append history. Ordinary post-batch semantic precedence remains
unknown → allowed terminate → recovery → cancellation → refresh; legacy parity
fixtures must capture it rather than reorder it accidentally.

## Proposed public TypeScript signatures

These declarations belong in `src/types.ts` and are re-exported through the
proposed `auggy/application` subpath. Root owns those files and the final naming
decision. The brands below are declaration-only; runtime issuance/validation is
package-private. All data-bearing views are deeply frozen; the read-only signal
is a cancellation capability, not a mutable agent-state handle.

```ts
declare const managedTurnReceipt: unique symbol;

export interface TurnCompletion {
  readonly [managedTurnReceipt]: "completion";
}

export interface TurnAnswerReceipt {
  readonly [managedTurnReceipt]: "answer";
  readonly kind: "answer";
  readonly reason: "answer" | "max-tokens" | "recovery";
}

export interface TurnToolBatchReceipt {
  readonly [managedTurnReceipt]: "tools";
  readonly kind: "tools";
  readonly toolCallCount: number;
}

export interface TurnFinalInferenceReceipt {
  readonly [managedTurnReceipt]: "final-inference";
  readonly kind: "final-answer-required";
}

export interface TurnTerminalStep {
  readonly kind: "terminal";
  readonly completion: TurnCompletion;
}

export interface ManagedTurnSession {
  readonly turnId: string;
  readonly threadId: string;
  readonly triggerType: TurnTriggerType;
  readonly signal: AbortSignal;
  /** Dispatched managed calls, including recovery and unsuccessful attempts. */
  readonly inferenceCount: number;
  /** Ordinary-loop allowance; recovery has its separate guarded transition. */
  readonly remainingInferences: number;

  dispatchInternalTurn(): Promise<
    | Readonly<{ handled: false }>
    | Readonly<{ handled: true; completion: TurnCompletion }>
  >;
  preparePrompt(): Promise<Readonly<{ kind: "ready" }> | TurnTerminalStep>;
  infer(): Promise<TurnAnswerReceipt | TurnToolBatchReceipt>;
  executeTools(batch: TurnToolBatchReceipt): Promise<
    Readonly<{ kind: "continue" }> | TurnFinalInferenceReceipt | TurnTerminalStep
  >;
  inferFinal(recovery: TurnFinalInferenceReceipt): Promise<
    TurnAnswerReceipt | TurnTerminalStep
  >;
  refreshPrompt(): Promise<void>;
  complete(answer: TurnAnswerReceipt): TurnCompletion;
  finishAtLimit(): TurnCompletion;
  stop(reason: "application-limit"): TurnCompletion;
}

export type TurnProgram = (turn: ManagedTurnSession) => Promise<TurnCompletion>;

export interface TurnProgramBinding {
  readonly run: TurnProgram;
  /** Positive safe integer, at most configured maxInferenceLoops. */
  readonly maxInferences?: number;
  /** Positive safe integer, at most 900_000; defaults to 900_000. */
  readonly timeoutMs?: number;
}

export interface ThreadHistoryCommitResult {
  readonly disposition: "committed" | "deferred-to-transport";
}

// Additive change to the existing interface; the other methods stay unchanged.
// Existing void-returning implementations retain their documented durable contract.
// commit(...): Promise<void | ThreadHistoryCommitResult>;

export type TurnFinalizationFailureCode =
  | "scheduler-rejected"
  | "startup-admission-failed"
  | "execution-start-failed"
  | "history-restore-failed"
  | "admission-state-failed"
  | "admission-denied"
  | "required-start-hook-failed"
  | "internal-handler-failed"
  | "required-context-failed"
  | "context-assembly-failed"
  | "provider-failed"
  | "provider-capacity-exhausted"
  | "model-response-limit"
  | "effect-outcome-unknown"
  | "caller-canceled"
  | "program-deadline-exceeded"
  | "program-contract-violation"
  | "program-threw"
  | "kernel-failed"
  | "cost-commit-failed"
  | "history-commit-failed";

export interface TurnFinalizationObservation {
  readonly turnId: string;
  readonly threadId: string;
  readonly triggerType: TurnTriggerType;
  readonly source: "transport" | "inject";
  readonly boundary: "before-post-turn";
  /** Scheduler task entered its execution-start callback boundary. */
  readonly executionStarted: boolean;
  /** Selected application/default program invocation began. */
  readonly sessionStarted: boolean;
  readonly outcome: "completed" | "failed" | "canceled" | "rejected" | "outcome-unknown";
  readonly status: TurnResult["status"];
  readonly disposition: "returned" | "threw";
  readonly outcomeUnknown: boolean;
  readonly primaryFailureCode: TurnFinalizationFailureCode | null;
  readonly priorFailureCodes: readonly TurnFinalizationFailureCode[];
  readonly history:
    | "not-started"
    | "memory-only"
    | "committed"
    | "deferred-to-transport"
    | "restore-failed"
    | "commit-failed";
  readonly accounting: Readonly<{
    state: "not-required" | "not-configured" | "committed" | "failed";
    pricing: "none" | "priced" | "unpriced";
  }>;
  readonly trace: Readonly<{
    started: boolean;
    inferenceAttempts: number;
    recordedInferenceSteps: number;
    toolAttempts: number;
    successfulToolCalls: number;
    capabilityChecks: number;
    snapshot: "not-recorded" | "recorded" | "failed";
  }>;
  /** Snapshot only: logical settlement does not release an occupied lane. */
  readonly pendingEffects: boolean;
}

export type TurnFinalizationObserver = (
  observation: TurnFinalizationObservation,
) => void | Promise<void>;

export interface AgentExecutionOptions {
  readonly turnProgram?: TurnProgramBinding;
  readonly onTurnFinalized?: TurnFinalizationObserver;
}

// Existing callers remain valid:
// defineAgent(config, model, options?: AgentExecutionOptions): AgentHandle;
// Application composition binds these options through the host-owned configured
// composition capability; it does not get a second model or augment list.
```

`inferenceCount` is not `trace.inferenceSteps.length`: a generic failed provider
attempt can lack a recorded trace step. Preserve that distinction for evidence.
No response text, tool inputs/outputs, peer objects, credentials, execution binding
hashes, arbitrary exception messages or raw cause objects cross the new observer.
The count summary is bounded in shape and uses validated finite counters.

The local `src/turn.ts` exports a binding such as `{ run: runTurn,
maxInferences: 2 }`. Its recipe uses the state transitions above, handles the
terminal union from `inferFinal`, and can be edited to `maxInferences: 1` to prove
real orchestration ownership. Root freezes names before producer implementation.

## Limits, cancellation and settlement

The existing ordinary ceiling is `config.maxInferenceLoops ?? 10`. Each regular
inference consumes that allowance before dispatch. A second consecutive schema
failure can trigger exactly one extra recovery call, even on the final ordinary
iteration; the legacy program retains this behavior.

An explicitly supplied `maxInferences` is a hard total over all managed model
calls, including `inferFinal`. Validate it once against the configured positive
ordinary limit; reject unsafe/noninteger/zero/negative/above-package values rather
than silently accepting a larger ceiling. Absent `maxInferences`, preserve the
existing ordinary limit plus conditional one-call recovery. If a recovery is
required but the explicit total is exhausted, `inferFinal` returns a terminal
application-limit completion without dispatch. `remainingInferences` counts only
currently permitted ordinary calls; zero does not authorize the app to synthesize
a recovery receipt. Internal handler privately owned model calls remain outside
this managed-call ceiling and must be documented honestly.

`stop("application-limit")` uses the existing runtime-owned completed fallback
text, "I've completed the available actions.", with normal cost/snapshot/history
settlement. It does not accept arbitrary response text, call the model again, or
invent a tool outcome. Distinguish this supported successful stop from malformed
program return or a deadline; the latter are failures/cancellation, not early
success. `finishAtLimit` remains legal only after ordinary allowance exhaustion.

The opt-in binding deadline is **900,000 ms default and maximum**, with a smaller
positive safe integer allowed. It starts immediately before invoking the selected
application program, after the managed prelude; it combines with caller/job
cancellation at the earliest deadline. It does not bound time spent queued or in
the pre-program admission/hooks. The absent-binding legacy path gets no new
program timer. Per-provider/context/tool deadlines remain active as before.

On application deadline, revoke receipts/phase methods first, abort active managed
operations, settle their guarded terminal paths, and classify the cause using a
fixed code. Late program continuation cannot emit events, append history or
perform a new managed call. A program sleeping forever with no managed work does
not retain a lane merely because its JS promise remains unresolved. An active
context/tool/internal-handler effect does retain ownership if it cannot prove
termination. Non-cooperative provider generation uses the existing bounded
detached-provider pool and stream fence rather than the side-effect lane rule.
Do not track every abandoned program promise as a side effect, nor drop a real
side effect because its parent program timed out. Trusted arbitrary app-side I/O
and synchronous infinite loops are outside the supported recipe guarantees.

All terminal intents are provisional. Accept the returned receipt once; settle
cost once; record the transcript once where applicable; compact/commit history
once per attempt; publish the immutable observation once; then follow the existing
post-turn eligibility rules. Stage terminal success events until intent acceptance
and kernel accounting settlement. Streaming deltas already delivered remain
streaming output, not proof of successful finalization. Preserve the web adapter's
additional buffering until transport persistence completes.

### Failure precedence and observation boundary

Use this deterministic precedence, retaining prior causes as deduplicated fixed
codes in encounter order. Existing caller-visible exception/result compatibility
is preserved; new observation does not replace failures with invented success.

1. A history commit failure dominates any earlier result/error, sets unknown,
   and evicts the resident history. Its prior causes can include cost failure.
2. A cost commit failure dominates proposed success, cancellation or other kernel
   error, sets unknown, and cannot trigger a second cost write.
3. A known unknown-effect outcome cannot be downgraded to success, application
   stop, cancellation or a generic program error. Preserve the unknown flag even
   if a later persistence/accounting failure becomes the primary code.
4. Otherwise preserve the current branch result or thrown failure. For newly
   introduced app failures, observed cancellation/deadline revocation is latched;
   a later rejected continuation cannot overwrite it. A contract violation or
   program throw after provisional `complete()` defeats that unaccepted success.
   Generic provider exceptions keep the existing throw disposition and skip
   normal post-turn hooks. Required context/internal-handler failed results keep
   their existing return disposition and hook eligibility.
5. Observer exceptions, timeout and late completion never replace any outcome.
   Delivery/hook failures occur after this observation boundary and retain their
   separate existing behavior; do not invoke the observer a second time.

`onTurnFinalized` runs once for each valid scheduling attempt: normal return,
kernel/program throw, queued cancellation/rejection, durable quarantine rejection,
failed admission/start callback/history restore, and expired causal injection.
Install the once guard at scheduling-attempt creation, not only in a session.
Emit before post-turn delivery/hooks after kernel settlement and the attempted
history commit. Rejected/pre-session attempts report no invented trace or cost.

The observer has an immutable metadata value, a fixed **1,000 ms package timeout**,
and no retry. It is not passed the canceled turn signal, because failures still
require observation. Use an independently bounded invocation; observe late
promise rejection and suppress late result without extending scheduler ownership
or changing hook behavior. Its own arbitrary external side effects are not a
transactional finalization participant.

An exact durable HTTP replay that never schedules a new execution is not a new
turn attempt and must not create another observation. A new scheduling attempt
with an explicitly reused turn ID is still a separate invocation; the once guard
is scoped to the invocation, not a global set of turn IDs.

`ThreadHistoryPersistence.commit` becomes
`Promise<void | ThreadHistoryCommitResult>`; `void` means the existing durable
contract. `createDeferredConsoleThreadHistoryPersistence` at
`src/transports/admin/console-chat-store.ts:306` returns `committed` on its
non-streaming branch and `deferred-to-transport` when it stages a snapshot.
Never use a static adapter-level flag: the same adapter performs both operations.
Validate any non-void commit result against this exact disposition contract;
an invalid result cannot certify durable success and fails closed as a history
settlement failure. Only `undefined` retains the legacy durable interpretation.
`src/transports/web-transport.ts:3197`–`:3269` still atomically commits console
history plus transcript and buffers `RUN_FINISHED`. An observation marked
deferred cannot certify that later transaction succeeded.

### Hook applicability that must remain unchanged

| Outcome path | `onTurnStart` | Internal handler/context | `onTurnEnd` and `scheduleAfterTurn` |
| --- | --- | --- | --- |
| Scheduler rejection/cancellation; startup barrier/start callback/history restore failure | No | No | No |
| Gate prepare/confirm/denial returns | No | No | Existing post-turn pipeline runs for returned result unless signal canceled |
| Required start-hook failed return | Already-entered start hooks only | No | Existing post-turn eligibility for returned failed result |
| Claimed internal result / handled handler failure | Yes | First handler wins; no normal context/model path | Existing post-turn eligibility, including returned failed result |
| Initial context/assembly failure or response-limit failed return | Yes | Entered phases only | Existing post-turn eligibility for returned failed result |
| Normal answer, terminate, limit, application-limit | Yes | As selected managed path | Delivery → end hooks → scheduled hooks; signal fences apply |
| Generic provider/program exception or accounting/history throw | Entered hooks only | Entered phases only | No fabricated normal post-turn invocation; new finalization observation still runs |
| Canceled result | Entered hooks only | No new work after applicable cancellation fence | Aborted signal suppresses delivery and remaining hooks |
| Outbound delivery exception | Already complete | Already complete | Both hook families still attempted before original delivery exception rethrows |
| Hook exception | Already complete | Already complete | Log fixed category; unknown quarantines; continue according to signal fences; join child work |

## Internal, causal and detached lanes

Every external, injected, scheduled, continuation and internal turn resolves the
same selected program. Internal handlers are offered only internal triggers in
augment declaration order. Handler null/undefined means fallback, not terminal.
Handled private inference is accounted from returned steps, not replayed by the
managed model loop. A throwing handler cannot recover unknown already-incurred
private billing; do not represent this as fixed by exposing the loop.

`SchedulerContext.inject` retains its closure-bound private lease and same-thread,
depth, concurrency and context-expiry checks. Do not expose that lease or a raw
inject method on `ManagedTurnSession`. Each child is a distinct attempt with its
own observation/program; it cannot bypass startup, budget or persistence guards.
The parent remains active through descendants, even when the scheduling hook
discards the returned promise. Only the just-completed transcript is available
through existing closure-bound `getCompletedTranscript`.

Three lifetimes must remain separate:

- Logical managed turn settlement and the new immutable observation.
- Caller-facing completion/delivery, which may await descendants and transport
  persistence and may fail after logical settlement.
- Physical ownership of pending tool/context/internal effects and the scheduler
  lane, which can remain occupied after timeout until actual settlement. Durable
  quarantine can remain after all work settles and requires trusted recovery.

No host/program timeout authorizes unconditional claim release. Provider-only
late generation remains separately fenced and budgeted because it cannot execute
tools or mutate history after its managed await loses. Tests must distinguish it
from live side-effect work; one blanket detached-promise policy is incorrect.

## Extraction regression gates and ownership handoff

Existing regression files certify baseline behavior, not the new API. Run the
relevant suites unchanged against the default program, then equivalent scenario
fixtures against the application recipe. Compare terminal status/disposition,
ordered events, model/tool counts, operation IDs, history pairs/snapshots,
accounting writes, hook order, quarantine and lane ownership. Ignore incidental
UUIDs/timing only through explicit normalization.

| M3 gate | Existing anchors | Required new certification |
| --- | --- | --- |
| Admission/policy | `tests/kernel/turn-gate.test.ts`, `capability-table.test.ts`, `turn-loop.test.ts`; `tests/integration/delegated-authz-agent-run.test.ts` | App cannot infer before gate/start hooks; failures/denials have one observation and zero unauthorized effects |
| Model/stream bounds | `tests/engines/response-limits.test.ts`, `provider-resilience.test.ts`; `tests/kernel/turn-loop.test.ts:44`, `agent-scheduler.test.ts:213`, `:260` | Pending/late phase calls fenced after cancellation/deadline; default legacy provider behavior unchanged |
| Tools | `tests/kernel/tool-id-matching.test.ts`, `turn-loop.test.ts:921`–`:1189`, `turn-loop-terminate.test.ts` | Counterfeit/cross-session/stale/duplicate receipts; concurrent phase call rejection; aggregate event/tokenizer throw cannot abandon running sibling; denied calls have no side effects |
| Accounting | `tests/kernel/cost-commit-multi-iteration.test.ts`, `turn-gate.test.ts:357` | Explicit ceiling includes recovery; account before application exception; complete-then-throw not success; dual cost/history failure precedence and once-only writes |
| History | `tests/kernel/thread-history-persistence.test.ts`, `history-manager.test.ts`; `tests/transports/web-console-persistence.test.ts:293`, `:650`, `:689` | Observer accurately distinguishes durable/deferred/immediate fallback commit; restore failure has no model/hook; provisional success cannot survive commit failure |
| Hook/internal/causal | `tests/kernel/schedule-after-turn.test.ts`, `agent-scheduler.test.ts:356`–`:574`; `tests/agent.test.ts:728`–`:952` | Same selected program for all trigger paths; exception observation without invoking previously skipped hooks; expired causal attempt observed once; internal throw/zero-step accounting parity |
| Observation | `tests/kernel/runtime-signals.test.ts` for bounded immutable metadata conventions | Deep freeze, safe classifications, once coverage including queue failures, hanging/rejecting observer limited to1000ms, late rejection handled, no raw secrets/messages, executionStarted/sessionStarted false/true distinctions |
| App recipe | Existing packed web7 and Link10-per-arm regression harnesses | 2→1 local ceiling edit changes actual installed provider calls; loop/body edit is executed; no extra recovery above explicit ceiling; positive quiescent stop and negative invalid phase controls |
| Lifecycle | `tests/kernel/runtime-readiness.test.ts`; `agent-scheduler.test.ts:971`, `:1031`; `tests/agent.test.ts:29` | Construction throw before ready, ready failure, deadline with live effect, stop timeout retains ownership; no signal/claim regressions |
| Transport terminal integrity | `tests/transports/web-idempotency.test.ts`, `web-console-persistence.test.ts`, `web-transport.test.ts:1337`, `:1377` | Existing success buffering, durable replay, unknown failure, disconnect and overflow behavior survives new recipe/observation seam |

M3-01 owns the extracted session and default recipe plus focused kernel tests.
Root owns the optional agent execution binding, once-only observer placement,
shared types/exports and agent regressions. M3-02 owns the narrow console commit
disposition update and transport parity tests, coordinated with root's public
signature. No specialist should introduce a second persistence adapter or a
competing selected-program configuration. Installed-path evidence remains M3-05.

## Freeze disposition and remaining decisions

No unresolved product-direction question requires returning to the user. Root
must accept exact exported names and the schema above at M3-00, including the
binding's placement, commit-disposition extension, observation boundary and
classification precedence. These are coordinated implementation decisions, not
permission to broaden scope.

The following are explicit acceptance risks, not reasons to silently change
legacy semantics: out-of-loop unexpected throws currently lack some kernel
snapshot ritual; a throwing private internal handler can lose billing evidence;
existing confirm errors contain messages unsafe for the new observer; successful
internal result tool records and transcript records differ; recovery can exceed
the ordinary limit by one; terminate/recovery precede the baseline post-tool
abort check; and callback throws inside a parallel batch can reject before sibling
effects settle. The map makes each visible so extraction tests or narrowly
justified repairs address them without hiding a behavior change in a refactor.

This inventory covers the full baseline kernel function (including all terminal
constructors and helper throws), agent scheduling/history/post-turn wrappers,
causal scheduler ownership, and deferred console persistence. It does not claim
that source review alone certifies the future implementation. M3-00 acceptance
freezes the contract; M3-01 through M3-07 supply the executable proof.
