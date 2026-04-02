import type {
  Augment,
  AgentConfig,
  ModelClient,
  TurnTrigger,
  TurnState,
  TurnResult,
  ContextBlock,
  InboundMessage,
  Tool,
  ToolCallRecord,
} from "../types";
import type { Tokenizer } from "../tokenizer";
import { withTimeout } from "./timeout";
import { createContextAllocator } from "./context-allocator";
import { createCapabilityTable } from "./capability-table";
import { selectTools } from "./tool-selector";
import { createTraceEmitter } from "./trace-emitter";
import { buildPreamble } from "./preamble";
import { validateOutput } from "./output-validator";
import {
  createHistoryManager,
  type HistoryManager,
} from "./history-manager";

export interface TurnLoopOptions {
  signal?: AbortSignal;
}

export interface TurnLoop {
  executeTurn(trigger: TurnTrigger, threadId: string, options?: TurnLoopOptions): Promise<TurnResult>;
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
      hm = createHistoryManager({ threadId });
      historyManagers.set(threadId, hm);
    }
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
        traceEmitter.finalize(trace);
        return {
          turnId: trigger.turnId,
          success: false,
          errorResponse: "Turn was aborted.",
          toolCalls: toolCallRecords,
          trace,
          error: { message: "Turn aborted via AbortSignal", source: "kernel" },
        };
      }

      // Check abort before starting work
      if (signal?.aborted) return makeAbortResult();

      const history = getOrCreateHistory(threadId);

      // Append inbound message to history
      if (trigger.type === "message" && trigger.payload && "text" in trigger.payload) {
        const inbound = trigger.payload as InboundMessage;
        history.append({
          id: crypto.randomUUID(),
          role: "user",
          peerId: peer?.id,
          content: inbound.text,
          timestamp: trigger.timestamp,
          tokenCount: tokenizer.count(inbound.text),
        });
      }

      // Run augment context pipeline
      const contextBlocks: ContextBlock[] = [];
      for (const aug of augments) {
        if (!aug.context) continue;
        try {
          const timeout = aug.constraints?.contextTimeoutMs ?? 5000;
          const priorContext = aug.receivesPriorContext
            ? [...contextBlocks]
            : undefined;
          const result = await withTimeout(
            () => aug.context!(turnState, priorContext),
            timeout,
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
        } catch (err) {
          if (aug.required) {
            traceEmitter.finalize(trace);
            return {
              turnId: trigger.turnId,
              success: false,
              errorResponse:
                "An internal error occurred. Please try again.",
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
        model.maxContextTokens *
          ((budgetConfig.historyPercent ?? 40) / 100),
      );
      const historyMessages = history.getHistory(historyBudget);

      // Select tools
      const toolSelection = selectTools(allTools, turnState, {
        canExpose: (name) => capabilityTable.canExpose(name, turnState),
      });

      let currentPrompt = allocator.assemble(
        contextBlocks,
        historyMessages,
        toolSelection.definitions,
      );

      traceEmitter.recordContextAssembly(trace, {
        augmentBlocks: contextBlocks.map((b) => ({
          source: b.source,
          tokens: b.tokenCount ?? tokenizer.count(b.content),
          included: !currentPrompt.evictions.find(
            (e) => e.source === b.source,
          ),
          evicted: !!currentPrompt.evictions.find(
            (e) => e.source === b.source,
          ),
        })),
        historyTokens: historyMessages.reduce(
          (s, m) => s + m.tokenCount,
          0,
        ),
        totalTokens: currentPrompt.totalTokens,
        budgetUsed: Math.round(
          (currentPrompt.totalTokens / model.maxContextTokens) * 100,
        ),
      });

      traceEmitter.recordToolSelection(trace, {
        totalTools: allTools.length,
        phase1Used: toolSelection.phase1Used,
        mountedTools: toolSelection.mounted.map((t) => t.name),
        withheldTools: toolSelection.withheld,
      });

      // Inference + tool execution loop
      capabilityTable.resetTurn();
      const consecutiveFailures = new Map<string, number>();
      let inferenceCount = 0;
      const maxInferenceLoops = 10;

      while (inferenceCount < maxInferenceLoops) {
        if (signal?.aborted) return makeAbortResult();
        inferenceCount++;
        const inferStart = Date.now();
        const response = await model.complete(currentPrompt);
        const inferDuration = Date.now() - inferStart;

        traceEmitter.recordInference(trace, {
          model: config.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          durationMs: inferDuration,
          toolCalls: [],
          cost: { inputCost: 0, outputCost: 0, total: 0 },
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

        // No tool calls, end_turn, or context window exhausted — we're done
        if (!response.toolCalls?.length || response.finishReason === "end_turn" || response.finishReason === "max_tokens") {
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

          traceEmitter.finalize(trace);
          return {
            turnId: trigger.turnId,
            success: true,
            response: response.content
              ? { text: response.content }
              : undefined,
            toolCalls: toolCallRecords,
            trace,
          };
        }

        // Phase 1: Validate all tool calls (synchronous — fast)
        let terminateToolLoop = false;
        type ToolCallEntry =
          | { type: "error"; call: { name: string; arguments: Record<string, unknown> }; error: string }
          | { type: "execute"; call: { name: string; arguments: Record<string, unknown> }; reg: { tool: Tool; augment: string }; validatedInput: unknown };

        const entries: ToolCallEntry[] = [];

        for (const call of response.toolCalls) {
          const check = capabilityTable.canExecute(
            call.name,
            call.arguments,
            turnState,
          );
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
            capabilityTable.recordToolCall(call.name);
            break;
          }

          if ("needsApproval" in check) {
            entries.push({ type: "error", call, error: "Tool requires operator approval. Skipping for now." });
            capabilityTable.recordToolCall(call.name);
            continue;
          }

          const reg = toolRegistry.get(call.name);
          if (!reg) {
            entries.push({ type: "error", call, error: `Error: Unknown tool "${call.name}"` });
            capabilityTable.recordToolCall(call.name);
            continue;
          }

          const validation = reg.tool.input.safeParse(call.arguments);
          if (!validation.success) {
            entries.push({ type: "error", call, error: `Validation error: ${JSON.stringify(validation.error)}` });
            capabilityTable.recordToolCall(call.name);
            const prevCount = consecutiveFailures.get(call.name) ?? 0;
            consecutiveFailures.set(call.name, prevCount + 1);
            if ((consecutiveFailures.get(call.name) ?? 0) >= 2) {
              entries.push({ type: "error", call, error: `Tool "${call.name}" failed validation 2 consecutive times. Stopping tool use.` });
              terminateToolLoop = true;
              break;
            }
            continue;
          }

          consecutiveFailures.delete(call.name);
          entries.push({ type: "execute", call, reg, validatedInput: validation.data });
        }

        // Phase 2: Execute validated tools in parallel
        const execResults = await Promise.all(
          entries.map(async (entry) => {
            if (entry.type === "error") {
              return { call: entry.call, output: entry.error, durationMs: 0, isError: true };
            }
            const execStart = Date.now();
            let output: string;
            try {
              const augForTool = augments.find((a) =>
                a.tools?.some((t) => t.name === entry.reg.tool.name),
              );
              const timeout = augForTool?.constraints?.toolTimeoutMs ?? 30000;
              output = await withTimeout(
                () => entry.reg.tool.execute(entry.validatedInput),
                timeout,
              );
            } catch (err) {
              output = `Error: ${String(err)}`;
            }
            return { call: entry.call, output, durationMs: Date.now() - execStart, isError: false };
          }),
        );

        // Phase 3: Append all results to history in order with matching toolCallIds
        for (const { call, output, durationMs, isError } of execResults) {
          const callStr = JSON.stringify(call);
          const toolCallId = crypto.randomUUID();
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
          currentPrompt = allocator.assemble(contextBlocks, updatedHistory, toolSelection.definitions);
          // One more inference to let model acknowledge the failure
          const finalResponse = await model.complete(currentPrompt);
          if (finalResponse.content) {
            history.append({
              id: crypto.randomUUID(),
              role: "assistant",
              content: finalResponse.content,
              timestamp: Date.now(),
              tokenCount: tokenizer.count(finalResponse.content),
            });
          }
          traceEmitter.finalize(trace);
          return {
            turnId: trigger.turnId,
            success: true,
            response: finalResponse.content ? { text: finalResponse.content } : undefined,
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
        );
      }

      // Max inference loops reached
      traceEmitter.finalize(trace);
      return {
        turnId: trigger.turnId,
        success: true,
        response: { text: "I've completed the available actions." },
        toolCalls: toolCallRecords,
        trace,
      };
    },
  };
}
