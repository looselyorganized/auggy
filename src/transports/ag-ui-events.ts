import type { KernelEvent, TaskState } from "../types";

// === AG-UI event shapes (subset we emit in v1) ===
// These match the AG-UI spec at https://docs.ag-ui.com/concepts/events.md

export interface AGUIBaseEvent {
  type: string;
  timestamp?: number;
}

export interface AGUIRunStarted extends AGUIBaseEvent {
  type: "RUN_STARTED";
  threadId: string;
  runId: string;
  parentRunId?: string;
}

export interface AGUIRunFinished extends AGUIBaseEvent {
  type: "RUN_FINISHED";
  threadId: string;
  runId: string;
  /**
   * Optional structured result. v1 carries the terminal status discriminator
   * so consumers can distinguish "agent finished" from "agent waiting for
   * user input." Old AG-UI clients that ignore `result` keep working.
   */
  result?: {
    status: TaskState;
    message?: string;
  };
}

export interface AGUIRunError extends AGUIBaseEvent {
  type: "RUN_ERROR";
  message: string;
  code?: string;
}

export interface AGUITextMessageStart extends AGUIBaseEvent {
  type: "TEXT_MESSAGE_START";
  messageId: string;
  role: "assistant" | "user" | "system" | "tool" | "developer";
}

export interface AGUITextMessageContent extends AGUIBaseEvent {
  type: "TEXT_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
}

export interface AGUITextMessageEnd extends AGUIBaseEvent {
  type: "TEXT_MESSAGE_END";
  messageId: string;
}

export interface AGUIToolCallStart extends AGUIBaseEvent {
  type: "TOOL_CALL_START";
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
}

export interface AGUIToolCallArgs extends AGUIBaseEvent {
  type: "TOOL_CALL_ARGS";
  toolCallId: string;
  delta: string;
}

export interface AGUIToolCallEnd extends AGUIBaseEvent {
  type: "TOOL_CALL_END";
  toolCallId: string;
}

export interface AGUIToolCallResult extends AGUIBaseEvent {
  type: "TOOL_CALL_RESULT";
  messageId: string;
  toolCallId: string;
  content: string;
  role?: "tool";
}

export type AGUIEvent =
  | AGUIRunStarted
  | AGUIRunFinished
  | AGUIRunError
  | AGUITextMessageStart
  | AGUITextMessageContent
  | AGUITextMessageEnd
  | AGUIToolCallStart
  | AGUIToolCallArgs
  | AGUIToolCallEnd
  | AGUIToolCallResult;

// === Constructor helpers ===

export function runStarted(opts: { threadId: string; runId: string }): AGUIRunStarted {
  return { type: "RUN_STARTED", ...opts };
}

export function runFinished(opts: {
  threadId: string;
  runId: string;
  status?: TaskState;
  message?: string;
}): AGUIRunFinished {
  const base: AGUIRunFinished = {
    type: "RUN_FINISHED",
    threadId: opts.threadId,
    runId: opts.runId,
  };
  if (opts.status !== undefined) {
    base.result = opts.message
      ? { status: opts.status, message: opts.message }
      : { status: opts.status };
  }
  return base;
}

export function runError(opts: { message: string; code?: string }): AGUIRunError {
  return { type: "RUN_ERROR", ...opts };
}

export function textMessageStart(opts: {
  messageId: string;
  role: AGUITextMessageStart["role"];
}): AGUITextMessageStart {
  return { type: "TEXT_MESSAGE_START", ...opts };
}

export function textMessageContent(opts: {
  messageId: string;
  delta: string;
}): AGUITextMessageContent {
  return { type: "TEXT_MESSAGE_CONTENT", ...opts };
}

export function textMessageEnd(opts: { messageId: string }): AGUITextMessageEnd {
  return { type: "TEXT_MESSAGE_END", ...opts };
}

export function toolCallStart(opts: {
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
}): AGUIToolCallStart {
  return { type: "TOOL_CALL_START", ...opts };
}

export function toolCallArgs(opts: { toolCallId: string; delta: string }): AGUIToolCallArgs {
  return { type: "TOOL_CALL_ARGS", ...opts };
}

export function toolCallEnd(opts: { toolCallId: string }): AGUIToolCallEnd {
  return { type: "TOOL_CALL_END", ...opts };
}

export function toolCallResult(opts: {
  messageId: string;
  toolCallId: string;
  content: string;
}): AGUIToolCallResult {
  return { type: "TOOL_CALL_RESULT", role: "tool", ...opts };
}

// === Kernel → AG-UI translation ===

/**
 * Translate a single kernel event into zero or more AG-UI events.
 * Some kernel events map 1:1, others expand (e.g. text_message emits
 * a START / CONTENT / END triple since v1 doesn't stream tokens).
 *
 * Note: run_finished and run_error emit events with empty threadId —
 * the transport patches it before serialization, since threadId is
 * known at the transport layer.
 */
export function translateKernelEvent(event: KernelEvent): AGUIEvent[] {
  switch (event.kind) {
    case "run_started":
      return [runStarted({ threadId: event.threadId, runId: event.turnId })];

    case "tool_call_started":
      return [
        toolCallStart({
          toolCallId: event.toolCallId,
          toolCallName: event.toolName,
        }),
      ];

    case "tool_call_args":
      return [
        toolCallArgs({
          toolCallId: event.toolCallId,
          delta: JSON.stringify(event.args),
        }),
      ];

    case "tool_call_result":
      return [
        toolCallEnd({ toolCallId: event.toolCallId }),
        toolCallResult({
          messageId: `${event.toolCallId}-result`,
          toolCallId: event.toolCallId,
          content: event.output,
        }),
      ];

    case "text_message":
      return [
        textMessageStart({ messageId: event.messageId, role: event.role }),
        textMessageContent({ messageId: event.messageId, delta: event.text }),
        textMessageEnd({ messageId: event.messageId }),
      ];

    // Streaming text lifecycle: emitted by engines that support onDelta.
    // Each maps 1:1 to its AG-UI counterpart.
    case "text_message_start":
      return [textMessageStart({ messageId: event.messageId, role: event.role })];

    case "text_message_delta":
      return [textMessageContent({ messageId: event.messageId, delta: event.delta })];

    case "text_message_end":
      return [textMessageEnd({ messageId: event.messageId })];

    case "run_finished":
      return [
        runFinished({
          threadId: "",
          runId: event.turnId,
          status: event.status,
          ...(event.message !== undefined && { message: event.message }),
        }),
      ];

    case "run_error":
      // Only emit RUN_ERROR here. The turn loop always emits a separate
      // run_finished kernel event after run_error (see turn-loop.ts), which
      // produces the terminal RUN_FINISHED. Emitting one here would cause
      // clients to see two terminal events for a single failing turn.
      return [runError({ message: event.message, code: event.source })];
  }
}

// === SSE serialization ===

/**
 * Format an AG-UI event as a single Server-Sent Events data frame.
 * Each event is a JSON object prefixed with `data: ` and followed
 * by two newlines to mark the end of the frame.
 */
export function serializeSSE(event: AGUIEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
