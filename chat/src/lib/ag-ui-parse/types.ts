/**
 * AG-UI events — what Auggy's webTransport streams over SSE on /agent/run.
 *
 * Mirrors `augment-1/src/transports/ag-ui-events.ts` but typed for
 * consumer-side parsing. Local-chat-internal — not exported to other packages.
 */

export type AGUIEventType =
  | "RUN_STARTED"
  | "RUN_FINISHED"
  | "RUN_ERROR"
  | "TEXT_MESSAGE_START"
  | "TEXT_MESSAGE_CONTENT"
  | "TEXT_MESSAGE_END"
  | "TOOL_CALL_START"
  | "TOOL_CALL_ARGS"
  | "TOOL_CALL_RESULT"
  | "TOOL_CALL_END";

interface Base { type: AGUIEventType }

export interface RunStarted extends Base { type: "RUN_STARTED"; threadId?: string; runId?: string; }
export interface RunFinished extends Base { type: "RUN_FINISHED"; threadId?: string; runId?: string; }
export interface RunError extends Base { type: "RUN_ERROR"; message: string; code?: string; }
export interface TextMessageStart extends Base { type: "TEXT_MESSAGE_START"; messageId?: string; role?: "assistant"; }
export interface TextMessageContent extends Base { type: "TEXT_MESSAGE_CONTENT"; messageId?: string; delta: string; }
export interface TextMessageEnd extends Base { type: "TEXT_MESSAGE_END"; messageId?: string; }
export interface ToolCallStart extends Base { type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string; }
export interface ToolCallArgs extends Base { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string; }
export interface ToolCallResult extends Base { type: "TOOL_CALL_RESULT"; toolCallId: string; content: string; }
export interface ToolCallEnd extends Base { type: "TOOL_CALL_END"; toolCallId: string; }

export type AGUIEvent =
  | RunStarted | RunFinished | RunError
  | TextMessageStart | TextMessageContent | TextMessageEnd
  | ToolCallStart | ToolCallArgs | ToolCallResult | ToolCallEnd;
