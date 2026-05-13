import type { TurnTrace } from "../types";

type InferenceStep = TurnTrace["inferenceSteps"][number];

export interface TraceEmitter {
  startTurn(opts: { turnId: string; threadId: string; trigger: TurnTrace["trigger"] }): TurnTrace;

  recordContextAssembly(trace: TurnTrace, data: TurnTrace["contextAssembly"]): void;
  recordToolSelection(trace: TurnTrace, data: TurnTrace["toolSelection"]): void;
  recordInference(trace: TurnTrace, data: InferenceStep): void;
  recordCapabilityCheck(
    trace: TurnTrace,
    check: { tool: string; result: "allowed" | "needs-approval" | "denied" },
  ): void;
  finalize(trace: TurnTrace): void;
}

/**
 * Build a fresh TurnTrace with all sub-structures initialized to empty.
 * Shared between TraceEmitter.startTurn (the regular turn path) and
 * transport-queue admission rejections (where no real trace is ever
 * accumulated but the TurnResult.trace shape must still be filled in).
 */
export function emptyTrace(opts: {
  turnId: string;
  threadId: string;
  trigger: TurnTrace["trigger"];
}): TurnTrace {
  return {
    turnId: opts.turnId,
    threadId: opts.threadId,
    timestamp: Date.now(),
    duration: 0,
    trigger: opts.trigger,
    contextAssembly: {
      augmentBlocks: [],
      preambleTokens: 0,
      toolSchemaTokens: 0,
      historyTokens: 0,
      totalTokens: 0,
      budgetUsed: 0,
    },
    toolSelection: {
      totalTools: 0,
      phase1Used: false,
      mountedTools: [],
      withheldTools: [],
    },
    inferenceSteps: [],
    capabilityChecks: [],
  };
}

export function createTraceEmitter(): TraceEmitter {
  return {
    startTurn(opts): TurnTrace {
      return emptyTrace(opts);
    },

    recordContextAssembly(trace, data) {
      trace.contextAssembly = data;
    },

    recordToolSelection(trace, data) {
      trace.toolSelection = data;
    },

    recordInference(trace, data) {
      trace.inferenceSteps.push(data);
    },

    recordCapabilityCheck(trace, check) {
      trace.capabilityChecks.push(check);
    },

    finalize(trace) {
      trace.duration = Date.now() - trace.timestamp;
    },
  };
}
