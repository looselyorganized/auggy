import { describe, it, expect } from "bun:test";
import { parseSSEStream } from "../../src/lib/ag-ui-parse/parse";
import type { AGUIEvent } from "../../src/lib/ag-ui-parse/types";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); },
  });
}

async function collect(s: AsyncIterable<AGUIEvent>): Promise<AGUIEvent[]> {
  const out: AGUIEvent[] = [];
  for await (const e of s) out.push(e);
  return out;
}

describe("parseSSEStream", () => {
  it("parses RUN_STARTED", async () => {
    const events = await collect(parseSSEStream(streamFrom([
      `data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}\n\n`,
    ])));
    expect(events).toEqual([{ type: "RUN_STARTED", threadId: "t1", runId: "r1" }]);
  });

  it("parses TEXT_MESSAGE_CONTENT deltas in order", async () => {
    const events = await collect(parseSSEStream(streamFrom([
      `data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Hello"}\n\n`,
      `data: {"type":"TEXT_MESSAGE_CONTENT","delta":" world"}\n\n`,
    ])));
    expect(events.map(e => (e as any).delta)).toEqual(["Hello", " world"]);
  });

  it("buffers across chunk boundaries", async () => {
    const events = await collect(parseSSEStream(streamFrom([
      `data: {"type":"TEXT_MESS`, `AGE_CONTENT","delta":"x"}\n\n`,
    ])));
    expect(events).toEqual([{ type: "TEXT_MESSAGE_CONTENT", delta: "x" }]);
  });

  it("handles multiple events in one chunk", async () => {
    const events = await collect(parseSSEStream(streamFrom([
      `data: {"type":"RUN_STARTED"}\n\ndata: {"type":"RUN_FINISHED"}\n\n`,
    ])));
    expect(events.map(e => e.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
  });

  it("ignores SSE comment lines starting with ':'", async () => {
    const events = await collect(parseSSEStream(streamFrom([
      `: ping\n\ndata: {"type":"RUN_STARTED"}\n\n`,
    ])));
    expect(events).toEqual([{ type: "RUN_STARTED" }]);
  });

  it("ignores blank lines between events", async () => {
    const events = await collect(parseSSEStream(streamFrom([
      `\n\ndata: {"type":"RUN_STARTED"}\n\n\n\n`,
    ])));
    expect(events).toEqual([{ type: "RUN_STARTED" }]);
  });

  it("skips malformed JSON without throwing", async () => {
    const events = await collect(parseSSEStream(streamFrom([
      `data: {"type":"RUN_STARTED"}\n\n`,
      `data: not valid json\n\n`,
      `data: {"type":"RUN_FINISHED"}\n\n`,
    ])));
    expect(events.map(e => e.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
  });

  it("ignores [DONE] sentinel", async () => {
    const events = await collect(parseSSEStream(streamFrom([
      `data: {"type":"RUN_FINISHED"}\n\n`, `data: [DONE]\n\n`,
    ])));
    expect(events).toEqual([{ type: "RUN_FINISHED" }]);
  });

  it("parses TOOL_CALL_* sequence", async () => {
    const events = await collect(parseSSEStream(streamFrom([
      `data: {"type":"TOOL_CALL_START","toolCallId":"tc1","toolCallName":"web_fetch"}\n\n`,
      `data: {"type":"TOOL_CALL_ARGS","toolCallId":"tc1","delta":"{\\"url\\":\\"x\\"}"}\n\n`,
      `data: {"type":"TOOL_CALL_RESULT","toolCallId":"tc1","content":"OK"}\n\n`,
      `data: {"type":"TOOL_CALL_END","toolCallId":"tc1"}\n\n`,
    ])));
    expect(events.map(e => e.type)).toEqual([
      "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_RESULT", "TOOL_CALL_END",
    ]);
  });

  it("parses RUN_ERROR with message + optional code", async () => {
    const events = await collect(parseSSEStream(streamFrom([
      `data: {"type":"RUN_ERROR","message":"cap denied","code":"CAP_DENIED"}\n\n`,
    ])));
    expect(events).toEqual([{ type: "RUN_ERROR", message: "cap denied", code: "CAP_DENIED" }]);
  });

  it("yields nothing for empty stream", async () => {
    const events = await collect(parseSSEStream(streamFrom([])));
    expect(events).toEqual([]);
  });

  it("yields nothing for comments-only stream", async () => {
    const events = await collect(parseSSEStream(streamFrom([`: keepalive\n\n: another\n\n`])));
    expect(events).toEqual([]);
  });

  it("aborts on signal", async () => {
    const ctrl = new AbortController();
    const stream = streamFrom([
      `data: {"type":"RUN_STARTED"}\n\n`,
      `data: {"type":"TEXT_MESSAGE_CONTENT","delta":"a"}\n\n`,
    ]);
    const seen: AGUIEvent[] = [];
    let caught: Error | null = null;
    try {
      for await (const e of parseSSEStream(stream, { signal: ctrl.signal })) {
        seen.push(e);
        if (e.type === "RUN_STARTED") ctrl.abort();
      }
    } catch (err) {
      caught = err as Error;
    }
    expect(seen.map(e => e.type)).toEqual(["RUN_STARTED"]);
    expect(caught?.name).toBe("AbortError");
  });
});
