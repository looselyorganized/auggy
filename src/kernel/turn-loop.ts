import type {
  Augment,
  AgentConfig,
  AssembledPrompt,
  ModelClient,
  ModelResponse,
  TurnTrigger,
  TurnState,
  TurnResult,
  ContextBlock,
  InboundMessage,
  Tool,
  ToolCallRecord,
  KernelEventHandler,
  CostResult,
  TurnGateProvider,
  TurnGateTicket,
  ToolResult,
  Part,
} from "../types";
import type { Tokenizer } from "../tokenizer";
import { extractText } from "../parts";
import { costFromResponse } from "../engines/_shared/cost";
import {
  type ModelResponseAccounting,
  findModelResponseLimitError,
  ModelResponseLimitError,
  resolveModelResponseLimits,
  StreamingResponseLimitTracker,
  utf8ByteLength,
  validateModelResponse,
} from "../engines/_shared/response-limits";

function accountingFromResponse(response: ModelResponse): ModelResponseAccounting {
  return {
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    ...(response.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: response.cacheCreationTokens }
      : {}),
    ...(response.cacheReadTokens !== undefined
      ? { cacheReadTokens: response.cacheReadTokens }
      : {}),
    ...(response.costUsd !== undefined ? { costUsd: response.costUsd } : {}),
    ...(response.unpricedReason !== undefined ? { unpricedReason: response.unpricedReason } : {}),
  };
}

// ---------------------------------------------------------------------------
// Streaming inference helper
// ---------------------------------------------------------------------------

/**
 * Run a model inference call with streaming text deltas. Emits
 * text_message_start / text_message_delta / text_message_end KernelEvents
 * as text arrives. If the engine doesn't call onDelta (non-streaming
 * engines), no streaming events are emitted and the caller falls back to
 * the classic text_message event.
 *
 * On error, closes any open text stream before re-throwing so the client
 * never has an unclosed message stuck in "typing" state.
 */
async function streamingInference(
  model: ModelClient,
  prompt: AssembledPrompt,
  turnId: string,
  emitEvent: KernelEventHandler,
  responseLimits: ReturnType<typeof resolveModelResponseLimits>,
  signal?: AbortSignal,
): Promise<{ response: ModelResponse; streamed: boolean; messageId: string }> {
  const messageId = crypto.randomUUID();
  let streamed = false;
  const limitFailure: { error: ModelResponseLimitError | null } = { error: null };
  const limitAbort = new AbortController();
  const inferenceSignal = signal ? AbortSignal.any([signal, limitAbort.signal]) : limitAbort.signal;
  const tracker = new StreamingResponseLimitTracker(responseLimits);

  let response: ModelResponse;
  try {
    response = await model.complete(prompt, {
      signal: inferenceSignal,
      onDelta: (delta) => {
        if (delta.kind === "text_delta") {
          if (limitFailure.error) return;
          try {
            tracker.pushText(delta.text);
          } catch (error) {
            limitFailure.error =
              error instanceof ModelResponseLimitError
                ? error
                : new ModelResponseLimitError("maxTextBytes");
            limitAbort.abort(limitFailure.error);
            return;
          }
          if (!streamed) {
            emitEvent({
              kind: "text_message_start",
              turnId,
              messageId,
              role: "assistant",
            });
            streamed = true;
          }
          emitEvent({
            kind: "text_message_delta",
            turnId,
            messageId,
            delta: delta.text,
          });
        }
      },
    });
  } catch (err) {
    if (streamed) {
      emitEvent({ kind: "text_message_end", turnId, messageId });
    }
    const providerLimitError = findModelResponseLimitError(err);
    if (limitFailure.error && providerLimitError?.accounting) {
      limitFailure.error.withAccounting(providerLimitError.accounting);
    }
    throw limitFailure.error ?? providerLimitError ?? err;
  }

  if (streamed) {
    emitEvent({ kind: "text_message_end", turnId, messageId });
  }

  if (limitFailure.error) {
    throw limitFailure.error.withAccounting(accountingFromResponse(response));
  }
  return { response, streamed, messageId };
}
import { isOutcomeUnknownError, OutcomeUnknownError } from "../outcome-unknown";
import { withTimeout } from "./timeout";
import { createContextAllocator } from "./context-allocator";
import { createCapabilityTable } from "./capability-table";
import { selectTools } from "./tool-selector";
import { createTraceEmitter } from "./trace-emitter";
import { buildPreamble } from "./preamble";
import { validateOutput } from "./output-validator";
import { createHistoryManager, type HistoryManager } from "./history-manager";
import {
  delegatedAuthorizationDeniedAuditEvent,
  evaluateDelegatedAuthorization,
  validateAuthorizationRequirements,
} from "../authz/delegated-authorization";

export interface TurnLoopOptions {
  signal?: AbortSignal;
  onEvent?: KernelEventHandler;
  trackDetachedOperation?: (operation: Promise<unknown>) => void;
}

export interface TurnLoop {
  executeTurn(
    trigger: TurnTrigger,
    threadId: string,
    options?: TurnLoopOptions,
  ): Promise<TurnResult>;
  getHistoryManager(threadId: string): HistoryManager;
  hasHistoryManager(threadId: string): boolean;
  /** Prevent this thread's exact resident manager from being evicted while active. */
  pinHistoryManager(threadId: string): () => void;
  forgetHistoryManager(threadId: string): void;
  clearHistoryManagers(): void;
}

export function createTurnLoop(opts: {
  augments: Augment[];
  model: ModelClient;
  tokenizer: Tokenizer;
  config: AgentConfig;
  onHistoryEvicted?: (threadId: string) => void;
}): TurnLoop {
  const { augments, model, tokenizer, config } = opts;
  const responseLimits = resolveModelResponseLimits(config.responseLimits);

  const traceEmitter = createTraceEmitter();
  const historyManagers = new Map<string, HistoryManager>();
  const historyLastAccess = new Map<string, number>();
  const historyPins = new Map<string, number>();
  const deferredHistoryEvictions = new Set<string>();
  const MAX_HISTORY_THREADS = 500;

  function evictHistory(threadId: string) {
    if ((historyPins.get(threadId) ?? 0) > 0) {
      deferredHistoryEvictions.add(threadId);
      return false;
    }
    historyManagers.delete(threadId);
    historyLastAccess.delete(threadId);
    deferredHistoryEvictions.delete(threadId);
    opts.onHistoryEvicted?.(threadId);
    return true;
  }

  function evictHistoriesToLimit(): void {
    while (historyManagers.size > MAX_HISTORY_THREADS) {
      let oldestId: string | null = null;
      let oldestTime = Infinity;
      for (const [id, timestamp] of historyLastAccess) {
        if ((historyPins.get(id) ?? 0) > 0) continue;
        if (timestamp < oldestTime) {
          oldestTime = timestamp;
          oldestId = id;
        }
      }
      if (!oldestId || !evictHistory(oldestId)) return;
    }
  }

  function getOrCreateHistory(threadId: string): HistoryManager {
    let hm = historyManagers.get(threadId);
    if (!hm) {
      // Evict the oldest inactive thread if at capacity. When every resident
      // manager is pinned, allow bounded temporary overshoot rather than
      // replacing state that an active turn will later commit.
      if (historyManagers.size >= MAX_HISTORY_THREADS) {
        let oldestId: string | null = null;
        let oldestTime = Infinity;
        for (const [id, t] of historyLastAccess) {
          if ((historyPins.get(id) ?? 0) > 0) continue;
          if (t < oldestTime) {
            oldestTime = t;
            oldestId = id;
          }
        }
        if (oldestId) {
          evictHistory(oldestId);
        }
      }
      hm = createHistoryManager({ threadId });
      historyManagers.set(threadId, hm);
    }
    historyLastAccess.set(threadId, Date.now());
    return hm;
  }

  return {
    getHistoryManager: getOrCreateHistory,
    hasHistoryManager(threadId: string) {
      return historyManagers.has(threadId);
    },
    pinHistoryManager(threadId: string) {
      getOrCreateHistory(threadId);
      historyPins.set(threadId, (historyPins.get(threadId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (historyPins.get(threadId) ?? 1) - 1;
        if (remaining > 0) {
          historyPins.set(threadId, remaining);
          return;
        }
        historyPins.delete(threadId);
        if (deferredHistoryEvictions.has(threadId)) evictHistory(threadId);
        evictHistoriesToLimit();
      };
    },
    forgetHistoryManager(threadId: string) {
      evictHistory(threadId);
    },
    clearHistoryManagers() {
      const threadIds = [...historyManagers.keys()];
      historyManagers.clear();
      historyLastAccess.clear();
      historyPins.clear();
      deferredHistoryEvictions.clear();
      for (const threadId of threadIds) opts.onHistoryEvicted?.(threadId);
    },

    async executeTurn(
      trigger: TurnTrigger,
      threadId: string,
      options?: TurnLoopOptions,
    ): Promise<TurnResult> {
      const signal = options?.signal;
      const emitEvent: KernelEventHandler = options?.onEvent ?? (() => {});
      const peer = trigger.peer ?? null;
      const turnState: TurnState = {
        turnId: trigger.turnId,
        threadId,
        trigger,
        peer,
        toolCallsSoFar: 0,
        turnStartedAt: Date.now(),
        metadata: {},
        ...(signal ? { signal } : {}),
      };

      const toolCallRecords: ToolCallRecord[] = [];

      // Per-turn transcript parts (ADR-027). Accumulates inbound user parts
      // + outbound assistant text as the turn progresses. The snapshot is
      // recorded into history-manager at every terminal return path so
      // SchedulerContext.getCompletedTranscript() finds it.
      const transcriptParts: Part[] = [];
      if (trigger.type === "message" && trigger.payload && "parts" in trigger.payload) {
        const inbound = trigger.payload as InboundMessage;
        transcriptParts.push(...inbound.parts);
      }

      const trace = traceEmitter.startTurn({
        turnId: trigger.turnId,
        threadId,
        trigger: {
          type: trigger.type,
          sourceAugment: trigger.source,
          peerKind: peer?.kind,
          trustLevel: peer?.trustLevel,
        },
      });

      // ADR-027: record a per-turn snapshot before returning. Called at
      // every terminal return path; idempotent on retry. The snapshot is
      // what SchedulerContext.getCompletedTranscript() reads.
      function recordTurnSnapshot() {
        getOrCreateHistory(threadId).recordTurn({
          turnId: trigger.turnId,
          threadId,
          peer,
          parts: [...transcriptParts],
          toolCalls: [...toolCallRecords],
          startedAt: turnState.turnStartedAt,
          endedAt: Date.now(),
        });
      }

      // Ritual that MUST run before every terminal return: stamp the
      // trace's duration, optionally commit accumulated costs, persist
      // the ADR-027 turn snapshot. Each return site previously inlined
      // these calls, which made it easy to forget one when adding a new
      // return path. Wrapping them here makes the contract explicit:
      // call this before any `return { ... }`. The cost-commit slot is
      // optional because admission-rejection paths return before any
      // inference happens (no cost to commit).
      //
      // Note: trace.duration is stamped BEFORE runCostCommit so the
      // reported turn duration excludes the post-turn cost accounting
      // I/O, matching the existing semantics at every refactored site.
      let admissionConfirmed = false;
      let costCommitPromise: Promise<void> | null = null;

      async function finalizeReturn(_opts?: { withCostCommit?: boolean }): Promise<void> {
        traceEmitter.finalize(trace);
        if (admissionConfirmed && trace.inferenceSteps.length > 0) {
          await runCostCommit();
        }
        recordTurnSnapshot();
      }

      async function makeAbortResult(): Promise<TurnResult> {
        emitEvent({
          kind: "run_error",
          turnId: trigger.turnId,
          message: "Turn aborted via AbortSignal",
          source: "kernel",
        });
        emitEvent({
          kind: "run_finished",
          turnId: trigger.turnId,
          status: "canceled",
        });
        await finalizeReturn();
        return {
          turnId: trigger.turnId,
          success: false,
          status: "canceled",
          errorResponse: "Turn was aborted.",
          toolCalls: toolCallRecords,
          trace,
          error: { message: "Turn aborted via AbortSignal", source: "kernel" },
        };
      }

      // Check abort before starting work
      if (signal?.aborted) return makeAbortResult();

      // ---------------------------------------------------------------------------
      // Pre-dispatch: turn-gate admission via 2PC (prepare → confirm/rollback → cost commit)
      // ---------------------------------------------------------------------------
      const turnGates = augments.filter(
        (a): a is Augment & { turnGate: TurnGateProvider } => a.turnGate !== undefined,
      );

      const tickets: TurnGateTicket[] = [];

      // Phase 1: Prepare — each gate stages its writes inside its own open transaction.
      for (const gate of turnGates) {
        let ticket: TurnGateTicket;
        try {
          ticket = await gate.turnGate.prepare({
            turnId: trigger.turnId,
            peer: trigger.peer ?? null,
            threadId,
            trigger,
          });
        } catch {
          // prepare itself threw — treat as admission-state-failed.
          // Roll back any tickets already prepared.
          for (const t of tickets) {
            try {
              await t.rollback();
            } catch (e) {
              console.error(`[turn-gate ${gate.name}] rollback after prepare-throw failed:`, e);
            }
          }
          await finalizeReturn();
          return {
            turnId: trigger.turnId,
            success: false,
            status: "rejected",
            response: undefined,
            toolCalls: [],
            trace,
            error: {
              message: `Turn gate "${gate.name}" failed during admission.`,
              source: gate.name,
            },
            errorClass: "admission-state-failed",
          };
        }
        tickets.push(ticket);
      }

      // Phase 2: Decision evaluation — conjunctive. Any denial rolls back all tickets.
      const denied = tickets.find((t) => !t.decision.allow);
      if (denied) {
        const denialReason = (denied.decision as { allow: false; reason: string }).reason;
        for (const t of tickets) {
          try {
            await t.rollback();
          } catch (err) {
            console.error("[turn-gate] rollback failed:", err);
          }
        }
        await finalizeReturn();
        return {
          turnId: trigger.turnId,
          success: false,
          status: "rejected",
          response: undefined,
          toolCalls: [],
          trace,
          error: { message: denialReason, source: "turn-gate" },
          errorClass: "cap-denied",
        };
      }

      // Phase 3: Confirm — fail-closed. If any confirm throws, roll back all tickets.
      let confirmError: unknown = null;
      let confirmErrorGateName = "turn-gate";
      for (let ci = 0; ci < tickets.length; ci++) {
        try {
          await tickets[ci]!.confirm();
        } catch (err) {
          confirmError = err;
          confirmErrorGateName = turnGates[ci]?.name ?? "turn-gate";
          break;
        }
      }
      if (confirmError !== null) {
        for (const t of tickets) {
          try {
            await t.rollback();
          } catch (err) {
            console.error("[turn-gate] rollback after confirm-throw failed:", err);
          }
        }
        await finalizeReturn();
        return {
          turnId: trigger.turnId,
          success: false,
          status: "rejected",
          response: undefined,
          toolCalls: [],
          trace,
          error: {
            message: `admission state could not be persisted: ${confirmError instanceof Error ? confirmError.message : String(confirmError)}`,
            source: confirmErrorGateName,
          },
          errorClass: "admission-state-failed",
        };
      }
      admissionConfirmed = true;

      // All gates admitted. Fall through to turn body.
      // Phase 5 (cost commit) runs after the engine call returns — see bottom of executeTurn.

      const history = getOrCreateHistory(threadId);

      // Append inbound message to history (extract text from parts)
      if (trigger.type === "message" && trigger.payload && "parts" in trigger.payload) {
        const inbound = trigger.payload as InboundMessage;
        const text = extractText(inbound.parts);
        history.append({
          id: crypto.randomUUID(),
          role: "user",
          peerId: peer?.id,
          content: text,
          timestamp: trigger.timestamp,
          tokenCount: tokenizer.count(text),
        });
      }

      // onTurnStart hooks — fire before context assembly
      for (const aug of augments) {
        if (signal?.aborted) return makeAbortResult();
        if (aug.onTurnStart) {
          try {
            await aug.onTurnStart(turnState);
          } catch {
            if (signal?.aborted) return makeAbortResult();
            if (aug.required) {
              emitEvent({
                kind: "run_error",
                turnId: trigger.turnId,
                message: "A required turn initialization hook failed.",
                source: aug.name,
              });
              emitEvent({
                kind: "run_finished",
                turnId: trigger.turnId,
                status: "failed",
              });
              await finalizeReturn();
              return {
                turnId: trigger.turnId,
                success: false,
                status: "failed",
                errorResponse: "An internal error occurred during turn initialization.",
                toolCalls: [],
                trace,
                error: { message: "Required turn initialization hook failed.", source: aug.name },
              };
            }
            // Non-required: log and continue
          }
        }
      }
      if (signal?.aborted) return makeAbortResult();

      // Emit run_started event
      emitEvent({
        kind: "run_started",
        turnId: trigger.turnId,
        threadId,
        contextId: trigger.contextId,
        taskId: trigger.taskId,
      });

      // ADR-027 Decision 5: internal-trigger handler dispatch.
      // When the trigger type is "internal", walk the augment list in
      // declaration order and offer the trigger to each augment's
      // handleInternalTurn. The first non-null return owns the turn —
      // its TurnResult replaces the standard inference loop's output.
      // The handler-supplied trace.inferenceSteps[] are merged into the
      // kernel trace so runCostCommit aggregates them and turnGate.commit
      // observes the full priced/unpriced cost (this is the path that
      // closes the cost-attribution gap Codex Critical-2 flagged for
      // PR β's option-(b) inline-extraction shortcut).
      //
      // If no handler claims, fall through to the standard inference loop.
      // This preserves the existing behavior where an internal trigger
      // with no augment-side handler runs through the normal model-engine
      // path — useful for kernel-driven internal events that need
      // lifecycle/budgets but no augment-specific execution.
      if (trigger.type === "internal") {
        for (const aug of augments) {
          if (!aug.handleInternalTurn) continue;
          let handlerResult: TurnResult | null;
          try {
            handlerResult = await aug.handleInternalTurn(trigger, {
              threadId,
              peer,
              ...(signal ? { signal } : {}),
            });
          } catch {
            // Handler threw — surface as a failed turn so the augment
            // author can debug, and so cost-commit still fires.
            //
            // BUDGET-ACCOUNTING WARNING: when a handler throws, it has no
            // way to merge already-incurred LLM cost into trace.inferenceSteps.
            // runCostCommit() will fire with no inference recorded, and
            // budgets will see this turn as zero-cost — undercounting if the
            // handler burned LLM spend before throwing. Per ADR-027 Decision 5,
            // the contract is: handlers MUST NOT throw with side effects.
            // Failure modes (engine error, parse error, etc.) MUST be caught
            // inside the handler and returned as a failed TurnResult with
            // accumulated trace.inferenceSteps. Surface a warning so the
            // misbehaving handler is observable to operators.
            console.warn(
              `[kernel] handleInternalTurn for augment "${aug.name}" threw; ` +
                `cost may be undercounted (handler should return failed TurnResult ` +
                `instead of throwing — see ADR-027 Decision 5).`,
            );
            emitEvent({
              kind: "run_error",
              turnId: trigger.turnId,
              message: "An internal turn handler failed.",
              source: aug.name,
            });
            emitEvent({
              kind: "run_finished",
              turnId: trigger.turnId,
              status: "failed",
            });
            await finalizeReturn({ withCostCommit: true });
            return {
              turnId: trigger.turnId,
              success: false,
              status: "failed",
              toolCalls: toolCallRecords,
              trace,
              error: {
                message: "Internal turn handler failed.",
                source: aug.name,
              },
            };
          }
          if (handlerResult === null || handlerResult === undefined) {
            // Augment did not claim — try the next handler.
            continue;
          }
          // Handler claimed. Merge its inference-step costs into the
          // kernel trace so runCostCommit observes them. Other trace
          // fields (turnId, threadId, trigger metadata, timestamps)
          // stay kernel-authoritative; handler-supplied artifacts
          // (response, toolCalls, status) flow through to the caller.
          for (const step of handlerResult.trace?.inferenceSteps ?? []) {
            traceEmitter.recordInference(trace, step);
          }
          // Inlined instead of finalizeReturn() because the snapshot must
          // see the handler's response parts merged into transcriptParts —
          // the merge happens between cost-commit and recordTurnSnapshot.
          traceEmitter.finalize(trace);
          await runCostCommit();
          if (handlerResult.response?.parts) {
            for (const part of handlerResult.response.parts) {
              if (part.kind === "text") {
                transcriptParts.push(part);
              }
            }
          }
          recordTurnSnapshot();
          emitEvent({
            kind: "run_finished",
            turnId: trigger.turnId,
            status: handlerResult.status,
          });
          return {
            turnId: trigger.turnId,
            success: handlerResult.success,
            status: handlerResult.status,
            response: handlerResult.response,
            responses: handlerResult.responses,
            errorResponse: handlerResult.errorResponse,
            toolCalls: handlerResult.toolCalls ?? toolCallRecords,
            trace,
            error: handlerResult.error,
            errorClass: handlerResult.errorClass,
            outcomeUnknown: handlerResult.outcomeUnknown,
            rejection: handlerResult.rejection,
          };
        }
        // No handler claimed; fall through to the standard inference loop.
      }

      // Run augment context pipeline
      const contextBlocks: ContextBlock[] = [];
      for (const aug of augments) {
        if (!aug.context) continue;
        try {
          const timeout = aug.constraints?.contextTimeoutMs ?? 5000;
          const priorContext = aug.receivesPriorContext ? [...contextBlocks] : undefined;
          const result = await withTimeout(
            (deadlineSignal) =>
              aug.context!(
                {
                  ...turnState,
                  signal: deadlineSignal,
                },
                priorContext,
              ),
            timeout,
            signal,
            options?.trackDetachedOperation,
          );
          if (typeof result === "string") {
            contextBlocks.push({
              source: aug.name,
              content: result,
              placement: "preamble",
              provenance: "augment",
              priority: "normal",
              eviction: "drop",
              origin: "system",
            });
          } else {
            contextBlocks.push(...result);
          }
        } catch {
          if (aug.required) {
            emitEvent({
              kind: "run_error",
              turnId: trigger.turnId,
              message: "A required context provider failed.",
              source: aug.name,
            });
            emitEvent({
              kind: "run_finished",
              turnId: trigger.turnId,
              status: "failed",
            });
            await finalizeReturn();
            return {
              turnId: trigger.turnId,
              success: false,
              status: "failed",
              errorResponse: "An internal error occurred. Please try again.",
              toolCalls: [],
              trace,
              error: { message: "Required context provider failed.", source: aug.name },
            };
          }
          // Non-required: skip and continue
        }
      }

      // Assemble context
      const preamble = buildPreamble({
        sourceAugment: trigger.source,
        peer,
      });
      const budgetConfig = config.contextBudget ?? {};
      const allocator = createContextAllocator({
        maxTokens: model.maxContextTokens,
        historyPercent: budgetConfig.historyPercent ?? 40,
        toolSchemaPercent: budgetConfig.toolSchemaPercent ?? 10,
        tokenizer,
        preamble,
      });

      const historyBudget = Math.floor(
        model.maxContextTokens * ((budgetConfig.historyPercent ?? 40) / 100),
      );
      const historyMessages = history.getHistory(historyBudget);

      // Collect tools per turn so augment tools populated during onBoot
      // (for example MCP-discovered tools) are visible to the kernel.
      const capabilityTable = createCapabilityTable(augments);
      const toolRegistry = new Map<string, { tool: Tool; augment: string }>();
      const allTools: Tool[] = [];
      for (const aug of augments) {
        for (const tool of aug.tools ?? []) {
          toolRegistry.set(tool.name, { tool, augment: aug.name });
          allTools.push(tool);
        }
      }

      // Select tools
      const toolSelection = selectTools(allTools, turnState, {
        canExpose: (name) => capabilityTable.canExpose(name, turnState),
      });

      const toolChoiceOpt = config.toolChoice ? { toolChoice: config.toolChoice } : undefined;
      let currentPrompt: AssembledPrompt;
      try {
        currentPrompt = allocator.assemble(
          contextBlocks,
          historyMessages,
          toolSelection.definitions,
          toolChoiceOpt,
        );
      } catch {
        emitEvent({
          kind: "run_error",
          turnId: trigger.turnId,
          message: "Context assembly failed.",
          source: "context-allocator",
        });
        emitEvent({
          kind: "run_finished",
          turnId: trigger.turnId,
          status: "failed",
        });
        await finalizeReturn();
        return {
          turnId: trigger.turnId,
          success: false,
          status: "failed",
          errorResponse: "The agent's required context exceeds its configured model budget.",
          toolCalls: [],
          trace,
          error: { message: "Context assembly failed.", source: "context-allocator" },
        };
      }

      const preambleTokens = currentPrompt.systemBlocks.reduce((s, b) => s + tokenizer.count(b), 0);
      const toolSchemaTokens = currentPrompt.tools.reduce(
        (s, t) => s + tokenizer.count(JSON.stringify(t)),
        0,
      );
      traceEmitter.recordContextAssembly(trace, {
        augmentBlocks: contextBlocks.map((b) => ({
          source: b.source,
          tokens: b.tokenCount ?? tokenizer.count(b.content),
          included: !currentPrompt.evictions.find((e) => e.source === b.source),
          evicted: !!currentPrompt.evictions.find((e) => e.source === b.source),
        })),
        preambleTokens,
        toolSchemaTokens,
        historyTokens: historyMessages.reduce((s, m) => s + m.tokenCount, 0),
        totalTokens: currentPrompt.totalTokens,
        budgetUsed: Math.round((currentPrompt.totalTokens / model.maxContextTokens) * 100),
      });

      traceEmitter.recordToolSelection(trace, {
        totalTools: allTools.length,
        phase1Used: toolSelection.phase1Used,
        mountedTools: toolSelection.mounted.map((t) => t.name),
        withheldTools: toolSelection.withheld,
      });

      // Phase 5 helper: cost commit (post-inference, fail closed).
      // A response is not terminally successful until every gate durably
      // records the known inference cost. Failure after inference is
      // outcome-unknown and must not produce a replayable success.
      //
      // Multi-iteration semantics: a single turn may invoke the model
      // multiple times (tool-use loop). We commit the SUM of all inference
      // steps' priced costs. If any step is unpriced, the whole turn
      // commits as unpriced — partial-priced sums would mislead the budget
      // store and silently suppress unpriced_turns counters.
      async function runCostCommit(): Promise<void> {
        if (!costCommitPromise) {
          costCommitPromise = (async () => {
            const steps = trace.inferenceSteps;
            let cost: CostResult;
            if (steps.length === 0) {
              cost = { priced: false, reason: "no inference recorded" };
            } else {
              let totalCostUsd = 0;
              let unpricedReason: string | null = null;
              for (const step of steps) {
                if (step.cost.priced) {
                  totalCostUsd += step.cost.costUsd;
                } else {
                  unpricedReason = step.cost.reason;
                  break; // any unpriced step → whole turn unpriced
                }
              }
              cost =
                unpricedReason !== null
                  ? { priced: false, reason: unpricedReason }
                  : { priced: true, costUsd: totalCostUsd };
            }
            for (const gate of turnGates) {
              if (!gate.turnGate.commit) continue;
              try {
                await gate.turnGate.commit({
                  turnId: trigger.turnId,
                  peer: trigger.peer ?? null,
                  threadId,
                  cost,
                });
              } catch {
                console.error(`[turn-gate ${gate.name}] cost commit failed after inference`);
                throw new OutcomeUnknownError(
                  "Inference completed but durable cost accounting did not reach a terminal state.",
                );
              }
            }
          })();
        }
        await costCommitPromise;
      }

      async function runRecordedInference(prompt: AssembledPrompt): Promise<{
        response: ModelResponse;
        streamed: boolean;
        messageId: string;
      }> {
        const startedAt = Date.now();
        try {
          const result = await streamingInference(
            model,
            prompt,
            trigger.turnId,
            emitEvent,
            responseLimits,
            signal,
          );
          try {
            validateModelResponse(result.response, responseLimits);
          } catch (error) {
            if (error instanceof ModelResponseLimitError) {
              throw error.withAccounting(accountingFromResponse(result.response));
            }
            throw error;
          }
          traceEmitter.recordInference(trace, {
            model: config.model,
            inputTokens: result.response.inputTokens,
            outputTokens: result.response.outputTokens,
            durationMs: Date.now() - startedAt,
            toolCalls: [],
            cost: costFromResponse(result.response),
          });
          return result;
        } catch (error) {
          if (error instanceof ModelResponseLimitError && error.accounting) {
            traceEmitter.recordInference(trace, {
              model: config.model,
              inputTokens: error.accounting.inputTokens,
              outputTokens: error.accounting.outputTokens,
              durationMs: Date.now() - startedAt,
              toolCalls: [],
              cost: costFromResponse(error.accounting),
            });
          }
          throw error;
        }
      }

      // Inference + tool execution loop
      try {
        capabilityTable.resetTurn();
        const consecutiveFailures = new Map<string, number>();
        let inferenceCount = 0;
        const maxInferenceLoops = config.maxInferenceLoops ?? 10;

        while (inferenceCount < maxInferenceLoops) {
          if (signal?.aborted) return makeAbortResult();
          inferenceCount++;
          const {
            response,
            streamed: streamedText,
            messageId: streamMessageId,
          } = await runRecordedInference(currentPrompt);
          if (signal?.aborted) return makeAbortResult();

          // Always append model content to history (even on tool_use turns)
          if (response.content) {
            history.append({
              id: crypto.randomUUID(),
              role: "assistant",
              content: response.content,
              timestamp: Date.now(),
              tokenCount: tokenizer.count(response.content),
            });
            // ADR-027 transcript capture — assistant content is part of the
            // turn's two-way exchange and must surface to scheduleAfterTurn.
            transcriptParts.push({ kind: "text", text: response.content });
          }

          // No tool calls or context window exhausted — we're done.
          // If tool calls ARE present, always execute them regardless of
          // finishReason. Some engines return "end_turn" alongside tool
          // calls; dropping them would silently lose the model's work.
          if (!response.toolCalls?.length || response.finishReason === "max_tokens") {
            // Output validation (v1: flag and trace, don't block)
            if (response.content) {
              const toolNames = allTools.map((t) => t.name);
              const augmentNames = augments.map((a) => a.name);
              const validation = validateOutput(response.content, [...toolNames, ...augmentNames]);
              if (validation.flagged) {
                trace.outputValidation = {
                  flagged: true,
                  reasons: validation.reasons,
                };
              }
            }

            // Emit text_message event for the final response — only if we
            // didn't already stream it AND there's actual content (skip empty
            // text from pure tool_use responses).
            if (!streamedText && response.content) {
              emitEvent({
                kind: "text_message",
                turnId: trigger.turnId,
                messageId: streamMessageId,
                role: "assistant",
                text: response.content,
              });
            }

            await finalizeReturn({ withCostCommit: true });
            emitEvent({
              kind: "run_finished",
              turnId: trigger.turnId,
              status: "completed",
            });
            return {
              turnId: trigger.turnId,
              success: true,
              status: "completed",
              response: response.content
                ? {
                    parts: [{ kind: "text", text: response.content }],
                    contextId: trigger.contextId,
                  }
                : undefined,
              toolCalls: toolCallRecords,
              trace,
            };
          }

          // Phase 1: Validate all tool calls (synchronous — fast)
          let terminateToolLoop = false;
          type ToolCallEntry =
            | {
                type: "error";
                call: { name: string; arguments: Record<string, unknown> };
                error: string;
              }
            | {
                type: "execute";
                call: { name: string; arguments: Record<string, unknown> };
                reg: { tool: Tool; augment: string };
                validatedInput: unknown;
              };

          const entries: ToolCallEntry[] = [];

          for (const call of response.toolCalls) {
            const check = capabilityTable.canExecute(call.name, call.arguments, turnState);
            traceEmitter.recordCapabilityCheck(trace, {
              tool: call.name,
              result:
                "allowed" in check
                  ? "allowed"
                  : "needsApproval" in check
                    ? "needs-approval"
                    : "denied",
            });

            if ("denied" in check) {
              entries.push({ type: "error", call, error: `Error: ${check.reason}` });
              break;
            }

            if ("needsApproval" in check) {
              entries.push({
                type: "error",
                call,
                error: "Tool requires operator approval. Skipping for now.",
              });
              continue;
            }

            const reg = toolRegistry.get(call.name);
            if (!reg) {
              entries.push({ type: "error", call, error: `Error: Unknown tool "${call.name}"` });
              continue;
            }

            const validation = reg.tool.input.safeParse(call.arguments);
            if (!validation.success) {
              entries.push({
                type: "error",
                call,
                error: `Validation error: ${JSON.stringify(validation.error)}`,
              });
              const prevCount = consecutiveFailures.get(call.name) ?? 0;
              consecutiveFailures.set(call.name, prevCount + 1);
              if ((consecutiveFailures.get(call.name) ?? 0) >= 2) {
                entries.push({
                  type: "error",
                  call,
                  error: `Tool "${call.name}" failed validation 2 consecutive times. Stopping tool use.`,
                });
                terminateToolLoop = true;
                break;
              }
              continue;
            }

            consecutiveFailures.delete(call.name);

            const authorizationConfigError = validateAuthorizationRequirements(reg.tool.requires, {
              binding: "tool",
            });
            if (authorizationConfigError) {
              entries.push({
                type: "error",
                call,
                error: `Error: Tool "${call.name}" has invalid authorization requirements: ${authorizationConfigError}`,
              });
              continue;
            }

            const authorization = evaluateDelegatedAuthorization(reg.tool.requires, {
              auth: trigger.auth,
              input: validation.data,
            });
            if (!authorization.ok) {
              emitEvent(
                delegatedAuthorizationDeniedAuditEvent({
                  decision: authorization,
                  auth: trigger.auth,
                  target: {
                    type: "tool",
                    toolName: call.name,
                    augmentName: reg.augment,
                    turnId: trigger.turnId,
                    threadId,
                  },
                }),
              );
              entries.push({
                type: "error",
                call,
                error: `Error: Tool "${call.name}" authorization denied: ${authorization.reason}`,
              });
              continue;
            }

            const reservation = capabilityTable.reserveToolCall(call.name);
            if ("denied" in reservation) {
              traceEmitter.recordCapabilityCheck(trace, {
                tool: call.name,
                result: "denied",
              });
              entries.push({ type: "error", call, error: `Error: ${reservation.reason}` });
              break;
            }
            turnState.toolCallsSoFar++;
            entries.push({ type: "execute", call, reg, validatedInput: validation.data });
          }

          // Phase 2: Execute validated tools in parallel (with event emission)
          const execResults = await Promise.all(
            entries.map(async (entry) => {
              if (entry.type === "error") {
                return {
                  call: entry.call,
                  output: entry.error,
                  durationMs: 0,
                  isError: true,
                  toolCallId: crypto.randomUUID(),
                  outcomeUnknown: false,
                };
              }
              const toolCallId = `${entry.call.name}-${crypto.randomUUID()}`;
              emitEvent({
                kind: "tool_call_started",
                turnId: trigger.turnId,
                toolCallId,
                toolName: entry.call.name,
                augmentName: entry.reg.augment,
              });
              emitEvent({
                kind: "tool_call_args",
                turnId: trigger.turnId,
                toolCallId,
                args: entry.call.arguments,
              });

              const execStart = Date.now();
              let output: string;
              let isError = false;
              let outcomeUnknown = false;
              let detachedOperation = false;
              let terminate: ToolResult["terminate"] | undefined;
              try {
                const augForTool = augments.find((a) =>
                  a.tools?.some((t) => t.name === entry.reg.tool.name),
                );
                const timeout = augForTool?.constraints?.toolTimeoutMs ?? 30000;
                const raw: string | ToolResult = await withTimeout(
                  (deadlineSignal) =>
                    entry.reg.tool.execute(entry.validatedInput, {
                      turnId: trigger.turnId,
                      peer: peer ?? null,
                      threadId,
                      signal: deadlineSignal,
                      ...(trigger.auth !== undefined ? { auth: trigger.auth } : {}),
                    }),
                  timeout,
                  signal,
                  (operation) => {
                    detachedOperation = true;
                    options?.trackDetachedOperation?.(operation);
                  },
                );
                if (typeof raw === "string") {
                  output = raw;
                } else {
                  output = raw.content;
                  isError = raw.isError === true;
                  outcomeUnknown = raw.outcomeUnknown === true;
                  terminate = raw.terminate;
                }
              } catch (err) {
                outcomeUnknown = detachedOperation || isOutcomeUnknownError(err);
                const failureCategory = err instanceof Error ? "error-object" : "non-error-value";
                console.warn(
                  `[turn-loop] tool execution failed tool=${entry.reg.tool.name} category=${failureCategory} outcomeUnknown=${outcomeUnknown}`,
                );
                output = outcomeUnknown
                  ? "Error: Tool execution ended without a trustworthy result after dispatch; outcome is unknown. Do not retry automatically."
                  : "Error: Tool execution failed. The operator has diagnostic context.";
                isError = true;
              }
              if (utf8ByteLength(output) > responseLimits.maxResponseBytes) {
                output = "Error: Tool output exceeded the configured safety limit.";
                isError = true;
              }

              emitEvent({
                kind: "tool_call_result",
                turnId: trigger.turnId,
                toolCallId,
                output,
                isError,
              });

              return {
                call: entry.call,
                output,
                durationMs: Date.now() - execStart,
                isError,
                toolCallId,
                terminate,
                outcomeUnknown,
              };
            }),
          );

          // Phase 3: Append all results to history in order with matching toolCallIds
          for (const { call, output, durationMs, isError, toolCallId } of execResults) {
            const callStr = JSON.stringify(call);
            history.append({
              id: crypto.randomUUID(),
              role: "tool_use",
              toolCallId,
              content: callStr,
              timestamp: Date.now(),
              tokenCount: tokenizer.count(callStr),
            });
            history.append({
              id: crypto.randomUUID(),
              role: "tool_result",
              toolCallId,
              content: output,
              timestamp: Date.now(),
              tokenCount: tokenizer.count(output),
            });
            if (!isError) {
              toolCallRecords.push({
                name: call.name,
                input: call.arguments,
                output,
                durationMs,
              });
            }
          }

          if (execResults.some((result) => result.outcomeUnknown)) {
            emitEvent({
              kind: "run_error",
              turnId: trigger.turnId,
              message: "A tool timed out after dispatch; its outcome is unknown.",
              source: "kernel",
            });
            emitEvent({
              kind: "run_finished",
              turnId: trigger.turnId,
              status: "failed",
            });
            await finalizeReturn();
            return {
              turnId: trigger.turnId,
              success: false,
              status: "failed",
              errorResponse:
                "A tool operation ended without a trustworthy result after it began. Its outcome is unknown and it was not retried.",
              toolCalls: toolCallRecords,
              trace,
              error: {
                message: "Tool execution outcome unknown after timeout",
                source: "kernel",
              },
              outcomeUnknown: true,
            };
          }

          // Capture first non-error terminate directive from this batch.
          // Reset per-iteration so a directive from one batch doesn't leak forward.
          // Runtime allowlist: although the type narrows status to "input-required" |
          // "completed", custom augments using JS or `as` casts could return any
          // string. Reject anything outside the allowlist — kernel-controlled states
          // (failed/canceled/rejected/auth-required) must not be augment-spoofable.
          let pendingTerminate: ToolResult["terminate"] | undefined;
          for (const r of execResults) {
            if (!r.isError && r.terminate && !pendingTerminate) {
              const s = r.terminate.status;
              if (s === "input-required" || s === "completed") {
                pendingTerminate = r.terminate;
                break;
              }
            }
          }

          if (pendingTerminate) {
            // Emit the directive's message as a normal assistant text message so
            // chat widgets render it in the message bubble (not just the tool-call
            // panel) and old AG-UI consumers see something. Skip when message is
            // empty — emitting an empty text_message produces a blank bubble.
            if (pendingTerminate.message) {
              emitEvent({
                kind: "text_message",
                turnId: trigger.turnId,
                messageId: crypto.randomUUID(),
                role: "assistant",
                text: pendingTerminate.message,
              });
            }
            if (pendingTerminate.message) {
              transcriptParts.push({ kind: "text", text: pendingTerminate.message });
            }
            await finalizeReturn({ withCostCommit: true });
            emitEvent({
              kind: "run_finished",
              turnId: trigger.turnId,
              status: pendingTerminate.status,
              ...(pendingTerminate.message !== undefined && {
                message: pendingTerminate.message,
              }),
            });
            return {
              turnId: trigger.turnId,
              success: true,
              status: pendingTerminate.status,
              response: pendingTerminate.message
                ? {
                    parts: [{ kind: "text", text: pendingTerminate.message }],
                    contextId: trigger.contextId,
                  }
                : undefined,
              toolCalls: toolCallRecords,
              trace,
            };
          }

          // If consecutive failures terminated tool use, let model see the error and respond
          if (terminateToolLoop) {
            const updatedHistory = history.getHistory(historyBudget);
            currentPrompt = allocator.assemble(
              contextBlocks,
              updatedHistory,
              toolSelection.definitions,
              toolChoiceOpt,
            );

            const {
              response: finalResponse,
              streamed: termStreamed,
              messageId: termMessageId,
            } = await runRecordedInference(currentPrompt);

            if (finalResponse.content) {
              history.append({
                id: crypto.randomUUID(),
                role: "assistant",
                content: finalResponse.content,
                timestamp: Date.now(),
                tokenCount: tokenizer.count(finalResponse.content),
              });
              transcriptParts.push({ kind: "text", text: finalResponse.content });
              if (!termStreamed) {
                emitEvent({
                  kind: "text_message",
                  turnId: trigger.turnId,
                  messageId: termMessageId,
                  role: "assistant",
                  text: finalResponse.content,
                });
              }
            }
            await finalizeReturn({ withCostCommit: true });
            emitEvent({
              kind: "run_finished",
              turnId: trigger.turnId,
              status: "completed",
            });
            return {
              turnId: trigger.turnId,
              success: true,
              status: "completed",
              response: finalResponse.content
                ? {
                    parts: [{ kind: "text", text: finalResponse.content }],
                    contextId: trigger.contextId,
                  }
                : undefined,
              toolCalls: toolCallRecords,
              trace,
            };
          }

          // Check abort after tool execution
          if (signal?.aborted) return makeAbortResult();

          // Rebuild prompt with updated history
          const updatedHistory = history.getHistory(historyBudget);
          currentPrompt = allocator.assemble(
            contextBlocks,
            updatedHistory,
            toolSelection.definitions,
            toolChoiceOpt,
          );
        }

        // Max inference loops reached
        emitEvent({
          kind: "text_message",
          turnId: trigger.turnId,
          messageId: crypto.randomUUID(),
          role: "assistant",
          text: "I've completed the available actions.",
        });
        transcriptParts.push({ kind: "text", text: "I've completed the available actions." });
        await finalizeReturn({ withCostCommit: true });
        emitEvent({
          kind: "run_finished",
          turnId: trigger.turnId,
          status: "completed",
        });
        return {
          turnId: trigger.turnId,
          success: true,
          status: "completed",
          response: {
            parts: [{ kind: "text", text: "I've completed the available actions." }],
            contextId: trigger.contextId,
          },
          toolCalls: toolCallRecords,
          trace,
        };
      } catch (error) {
        if (error instanceof ModelResponseLimitError) {
          emitEvent({
            kind: "run_error",
            turnId: trigger.turnId,
            message: error.publicMessage,
            source: "model-response-limits",
          });
          emitEvent({ kind: "run_finished", turnId: trigger.turnId, status: "failed" });
          await finalizeReturn();
          return {
            turnId: trigger.turnId,
            success: false,
            status: "failed",
            errorResponse: error.publicMessage,
            toolCalls: toolCallRecords,
            trace,
            error: { message: error.publicMessage, source: "model-response-limits" },
            errorClass: "engine-error",
          };
        }
        await finalizeReturn();
        throw error;
      }
    },
  };
}
