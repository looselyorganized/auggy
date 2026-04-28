import { describe, it, expect } from "bun:test";
import {
  runStarted,
  textMessageStart,
  textMessageContent,
  textMessageEnd,
  toolCallStart,
  toolCallArgs,
  toolCallEnd,
  toolCallResult,
  runFinished,
  runError,
  translateKernelEvent,
  serializeSSE,
} from "@/transports/ag-ui-events";
import type { KernelEvent } from "@/types";

describe("AG-UI event constructors", () => {
  it("builds a RUN_STARTED event", () => {
    const e = runStarted({ threadId: "th1", runId: "r1" });
    expect(e.type).toBe("RUN_STARTED");
    expect(e.threadId).toBe("th1");
    expect(e.runId).toBe("r1");
  });

  it("builds a TEXT_MESSAGE_START event with role", () => {
    const e = textMessageStart({ messageId: "m1", role: "assistant" });
    expect(e.type).toBe("TEXT_MESSAGE_START");
    expect(e.messageId).toBe("m1");
    expect(e.role).toBe("assistant");
  });

  it("builds a TEXT_MESSAGE_CONTENT event with delta", () => {
    const e = textMessageContent({ messageId: "m1", delta: "hello" });
    expect(e.type).toBe("TEXT_MESSAGE_CONTENT");
    expect(e.delta).toBe("hello");
  });

  it("builds a TEXT_MESSAGE_END event", () => {
    const e = textMessageEnd({ messageId: "m1" });
    expect(e.type).toBe("TEXT_MESSAGE_END");
  });

  it("builds a TOOL_CALL_START event with name", () => {
    const e = toolCallStart({ toolCallId: "tc1", toolCallName: "search" });
    expect(e.type).toBe("TOOL_CALL_START");
    expect(e.toolCallName).toBe("search");
  });

  it("builds a TOOL_CALL_ARGS event with JSON delta", () => {
    const e = toolCallArgs({ toolCallId: "tc1", delta: '{"q":"hi"}' });
    expect(e.type).toBe("TOOL_CALL_ARGS");
    expect(e.delta).toBe('{"q":"hi"}');
  });

  it("builds a TOOL_CALL_END event", () => {
    const e = toolCallEnd({ toolCallId: "tc1" });
    expect(e.type).toBe("TOOL_CALL_END");
  });

  it("builds a TOOL_CALL_RESULT event with content", () => {
    const e = toolCallResult({
      messageId: "m2",
      toolCallId: "tc1",
      content: "result text",
    });
    expect(e.type).toBe("TOOL_CALL_RESULT");
    expect(e.content).toBe("result text");
  });

  it("builds a RUN_FINISHED event", () => {
    const e = runFinished({ threadId: "th1", runId: "r1" });
    expect(e.type).toBe("RUN_FINISHED");
  });

  it("builds a RUN_ERROR event with code", () => {
    const e = runError({ message: "boom", code: "INTERNAL" });
    expect(e.type).toBe("RUN_ERROR");
    expect(e.message).toBe("boom");
    expect(e.code).toBe("INTERNAL");
  });
});

describe("translateKernelEvent", () => {
  it("translates run_started to RUN_STARTED", () => {
    const ke: KernelEvent = {
      kind: "run_started",
      turnId: "t1",
      threadId: "th1",
    };
    const events = translateKernelEvent(ke);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("RUN_STARTED");
  });

  it("translates text_message to START/CONTENT/END triple", () => {
    const ke: KernelEvent = {
      kind: "text_message",
      turnId: "t1",
      messageId: "m1",
      role: "assistant",
      text: "Hello back",
    };
    const events = translateKernelEvent(ke);
    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe("TEXT_MESSAGE_START");
    expect(events[1]!.type).toBe("TEXT_MESSAGE_CONTENT");
    expect((events[1] as { delta: string }).delta).toBe("Hello back");
    expect(events[2]!.type).toBe("TEXT_MESSAGE_END");
  });

  // --- Streaming text lifecycle events ---

  it("translates text_message_start to TEXT_MESSAGE_START", () => {
    const ke: KernelEvent = {
      kind: "text_message_start",
      turnId: "t1",
      messageId: "m1",
      role: "assistant",
    };
    const events = translateKernelEvent(ke);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("TEXT_MESSAGE_START");
  });

  it("translates text_message_delta to TEXT_MESSAGE_CONTENT", () => {
    const ke: KernelEvent = {
      kind: "text_message_delta",
      turnId: "t1",
      messageId: "m1",
      delta: "Hello",
    };
    const events = translateKernelEvent(ke);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("TEXT_MESSAGE_CONTENT");
    expect((events[0] as { delta: string }).delta).toBe("Hello");
  });

  it("translates text_message_end to TEXT_MESSAGE_END", () => {
    const ke: KernelEvent = {
      kind: "text_message_end",
      turnId: "t1",
      messageId: "m1",
    };
    const events = translateKernelEvent(ke);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("TEXT_MESSAGE_END");
  });

  it("translates tool_call_started to TOOL_CALL_START", () => {
    const ke: KernelEvent = {
      kind: "tool_call_started",
      turnId: "t1",
      toolCallId: "tc1",
      toolName: "search",
      augmentName: "memory-bus",
    };
    const events = translateKernelEvent(ke);
    expect(events[0]!.type).toBe("TOOL_CALL_START");
  });

  it("translates tool_call_args to TOOL_CALL_ARGS with JSON delta", () => {
    const ke: KernelEvent = {
      kind: "tool_call_args",
      turnId: "t1",
      toolCallId: "tc1",
      args: { query: "hello" },
    };
    const events = translateKernelEvent(ke);
    expect(events[0]!.type).toBe("TOOL_CALL_ARGS");
    expect((events[0] as { delta: string }).delta).toBe(JSON.stringify({ query: "hello" }));
  });

  it("translates tool_call_result to TOOL_CALL_END + TOOL_CALL_RESULT", () => {
    const ke: KernelEvent = {
      kind: "tool_call_result",
      turnId: "t1",
      toolCallId: "tc1",
      output: "result",
      isError: false,
    };
    const events = translateKernelEvent(ke);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("TOOL_CALL_END");
    expect(events[1]!.type).toBe("TOOL_CALL_RESULT");
  });

  it("translates run_finished to RUN_FINISHED", () => {
    const ke: KernelEvent = {
      kind: "run_finished",
      turnId: "t1",
      status: "completed",
    };
    const events = translateKernelEvent(ke);
    expect(events[0]!.type).toBe("RUN_FINISHED");
  });

  it("translates run_error to RUN_ERROR only (turn loop emits separate run_finished)", () => {
    const ke: KernelEvent = {
      kind: "run_error",
      turnId: "t1",
      message: "boom",
      source: "kernel",
    };
    const events = translateKernelEvent(ke);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("RUN_ERROR");
    expect((events[0] as { message: string }).message).toBe("boom");
  });
});

describe("serializeSSE", () => {
  it("formats an event as a Server-Sent Events data line", () => {
    const out = serializeSSE({
      type: "RUN_STARTED",
      threadId: "th1",
      runId: "r1",
    });
    expect(out).toBe(`data: {"type":"RUN_STARTED","threadId":"th1","runId":"r1"}\n\n`);
  });
});
