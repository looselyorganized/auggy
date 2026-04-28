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
} from "../types";
import type { Tokenizer } from "../tokenizer";
import { extractText } from "../parts";

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
): Promise<{ response: ModelResponse; streamed: boolean; messageId: string }> {
  const messageId = crypto.randomUUID();
  let streamed = false;

  let response: ModelResponse;
  try {
    response = await model.complete(prompt, {
      onDelta: (delta) => {
        if (delta.kind === "text_delta") {
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
    throw err;
  }

  if (streamed) {
    emitEvent({ kind: "text_message_end", turnId, messageId });
  }

  return { response, streamed, messageId };
}
import { withTimeout } from "./timeout";
import { createContextAllocator } from "./context-allocator";
import { createCapabilityTable } from "./capability-table";
import { selectTools } from "./tool-selector";
import { createTraceEmitter } from "./trace-emitter";
import { buildPreamble } from "./preamble";
import { validateOutput } from "./output-validator";
import { createHistoryManager, type HistoryManager } from "./history-manager";

export interface TurnLoopOptions {
  signal?: AbortSignal;
  onEvent?: KernelEventHandler;
}

export interface TurnLoop {
  executeTurn(
    trigger: TurnTrigger,
    threadId: string,
    options?: TurnLoopOptions,
  ): Promise<TurnResult>;
  getHistoryManager(threadId: string): HistoryManager;
}

export function createTurnLoop(opts: {
  augments: Augment[];
  model: ModelClient;
  tokenizer: Tokenizer;
  config: AgentConfig;
}): TurnLoop {
  const { augments, model, tokenizer, config } = opts;

  const capabilityTable = createCapabilityTable(augments);
  const traceEmitter = createTraceEmitter();
  const historyManagers = new Map<string, HistoryManager>();
  const historyLastAccess = new Map<string, number>();
  const MAX_HISTORY_THREADS = 500;

  // Collect all tools with their owning augment
  const toolRegistry = new Map<string, { tool: Tool; augment: string }>();
  const allTools: Tool[] = [];
  for (const aug of augments) {
    for (const tool of aug.tools ?? []) {
      toolRegistry.set(tool.name, { tool, augment: aug.name });
      allTools.push(tool);
    }
  }

  function getOrCreateHistory(threadId: string): HistoryManager {
    let hm = historyManagers.get(threadId);
    if (!hm) {
      // Evict oldest thread if at capacity
      if (historyManagers.size >= MAX_HISTORY_THREADS) {
        let oldestId: string | null = null;
        let oldestTime = Infinity;
        for (const [id, t] of historyLastAccess) {
          if (t < oldestTime) {
            oldestTime = t;
            oldestId = id;
          }
        }
        if (oldestId) {
          historyManagers.delete(oldestId);
          historyLastAccess.delete(oldestId);
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
      };

      const toolCallRecords: ToolCallRecord[] = [];

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

      function makeAbortResult(): TurnResult {
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
        traceEmitter.finalize(trace);
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
        } catch (err) {
          // prepare itself threw — treat as admission-state-failed.
          // Roll back any tickets already prepared.
          for (const t of tickets) {
            try {
              await t.rollback();
            } catch (e) {
              console.error(`[turn-gate ${gate.name}] rollback after prepare-throw failed:`, e);
            }
          }
          traceEmitter.finalize(trace);
          return {
            turnId: trigger.turnId,
            success: false,
            status: "rejected",
            response: undefined,
            toolCalls: [],
            trace,
            error: {
              message: `turn-gate "${gate.name}" prepare failed: ${err instanceof Error ? err.message : String(err)}`,
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
        traceEmitter.finalize(trace);
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
        traceEmitter.finalize(trace);
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
        if (aug.onTurnStart) {
          try {
            await aug.onTurnStart(turnState);
          } catch (err) {
            if (aug.required) {
              emitEvent({
                kind: "run_error",
                turnId: trigger.turnId,
                message: String(err),
                source: aug.name,
              });
              emitEvent({
                kind: "run_finished",
                turnId: trigger.turnId,
                status: "failed",
              });
              traceEmitter.finalize(trace);
              return {
                turnId: trigger.turnId,
                success: false,
                status: "failed",
                errorResponse: "An internal error occurred during turn initialization.",
                toolCalls: [],
                trace,
                error: { message: String(err), source: aug.name },
              };
            }
            // Non-required: log and continue
          }
        }
      }

      // Emit run_started event
      emitEvent({
        kind: "run_started",
        turnId: trigger.turnId,
        threadId,
        contextId: trigger.contextId,
        taskId: trigger.taskId,
      });

      // Run augment context pipeline
      const contextBlocks: ContextBlock[] = [];
      for (const aug of augments) {
        if (!aug.context) continue;
        try {
          const timeout = aug.constraints?.contextTimeoutMs ?? 5000;
          const priorContext = aug.receivesPriorContext ? [...contextBlocks] : undefined;
          const result = await withTimeout(() => aug.context!(turnState, priorContext), timeout);
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
        } catch (err) {
          if (aug.required) {
            emitEvent({
              kind: "run_error",
              turnId: trigger.turnId,
              message: String(err),
              source: aug.name,
            });
            emitEvent({
              kind: "run_finished",
              turnId: trigger.turnId,
              status: "failed",
            });
            traceEmitter.finalize(trace);
            return {
              turnId: trigger.turnId,
              success: false,
              status: "failed",
              errorResponse: "An internal error occurred. Please try again.",
              toolCalls: [],
              trace,
              error: { message: String(err), source: aug.name },
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

      // Select tools
      const toolSelection = selectTools(allTools, turnState, {
        canExpose: (name) => capabilityTable.canExpose(name, turnState),
      });

      const toolChoiceOpt = config.toolChoice ? { toolChoice: config.toolChoice } : undefined;
      let currentPrompt = allocator.assemble(
        contextBlocks,
        historyMessages,
        toolSelection.definitions,
        toolChoiceOpt,
      );

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

      // Phase 5 helper: cost commit (post-response, fail-safe).
      // Called after each successful engine exit. Errors are logged; they
      // do NOT fail the turn because the response already exists.
      async function runCostCommit(): Promise<void> {
        const lastInferenceStep = trace.inferenceSteps[trace.inferenceSteps.length - 1];
        const cost: CostResult = lastInferenceStep?.cost ?? {
          priced: false,
          reason: "no inference recorded",
        };
        for (const gate of turnGates) {
          if (!gate.turnGate.commit) continue;
          try {
            await gate.turnGate.commit({
              turnId: trigger.turnId,
              peer: trigger.peer ?? null,
              threadId,
              cost,
            });
          } catch (err) {
            console.error(`[turn-gate ${gate.name}] commit failed:`, err);
          }
        }
      }

      // Inference + tool execution loop
      capabilityTable.resetTurn();
      const consecutiveFailures = new Map<string, number>();
      let inferenceCount = 0;
      const maxInferenceLoops = config.maxInferenceLoops ?? 10;

      while (inferenceCount < maxInferenceLoops) {
        if (signal?.aborted) return makeAbortResult();
        inferenceCount++;
        const inferStart = Date.now();
        const {
          response,
          streamed: streamedText,
          messageId: streamMessageId,
        } = await streamingInference(model, currentPrompt, trigger.turnId, emitEvent);
        const inferDuration = Date.now() - inferStart;

        const cost: CostResult =
          response.costUsd !== undefined
            ? { priced: true, costUsd: response.costUsd }
            : { priced: false, reason: response.unpricedReason ?? "engine returned no costUsd" };

        traceEmitter.recordInference(trace, {
          model: config.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          durationMs: inferDuration,
          toolCalls: [],
          cost,
        });

        // Always append model content to history (even on tool_use turns)
        if (response.content) {
          history.append({
            id: crypto.randomUUID(),
            role: "assistant",
            content: response.content,
            timestamp: Date.now(),
            tokenCount: tokenizer.count(response.content),
          });
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

          // Emit run_finished
          emitEvent({
            kind: "run_finished",
            turnId: trigger.turnId,
            status: "completed",
          });

          traceEmitter.finalize(trace);
          await runCostCommit();
          return {
            turnId: trigger.turnId,
            success: true,
            status: "completed",
            response: response.content
              ? { parts: [{ kind: "text", text: response.content }] }
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
            try {
              const augForTool = augments.find((a) =>
                a.tools?.some((t) => t.name === entry.reg.tool.name),
              );
              const timeout = augForTool?.constraints?.toolTimeoutMs ?? 30000;
              const toolContext = {
                turnId: trigger.turnId,
                peer: peer ?? null,
                threadId,
              };
              output = await withTimeout(
                () => entry.reg.tool.execute(entry.validatedInput, toolContext),
                timeout,
              );
            } catch (err) {
              output = `Error: ${String(err)}`;
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
            capabilityTable.recordToolCall(call.name);
          }
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
          } = await streamingInference(model, currentPrompt, trigger.turnId, emitEvent);

          if (finalResponse.content) {
            history.append({
              id: crypto.randomUUID(),
              role: "assistant",
              content: finalResponse.content,
              timestamp: Date.now(),
              tokenCount: tokenizer.count(finalResponse.content),
            });
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
          emitEvent({
            kind: "run_finished",
            turnId: trigger.turnId,
            status: "completed",
          });
          traceEmitter.finalize(trace);
          await runCostCommit();
          return {
            turnId: trigger.turnId,
            success: true,
            status: "completed",
            response: finalResponse.content
              ? { parts: [{ kind: "text", text: finalResponse.content }] }
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
      emitEvent({
        kind: "run_finished",
        turnId: trigger.turnId,
        status: "completed",
      });
      traceEmitter.finalize(trace);
      await runCostCommit();
      return {
        turnId: trigger.turnId,
        success: true,
        status: "completed",
        response: {
          parts: [{ kind: "text", text: "I've completed the available actions." }],
        },
        toolCalls: toolCallRecords,
        trace,
      };
    },
  };
}
