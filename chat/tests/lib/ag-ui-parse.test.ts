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

  it("parses multi-line data: as a single joined event payload", async () => {
    // Per HTML Living Standard §9.2.6, multiple `data:` lines belonging to a
    // single event are concatenated with "\n" before JSON.parse.
    // Today: each `data:` line is treated as a complete JSON document, so
    //   line 1 ("{...,") fails parse (missing closing brace) and is skipped,
    //   line 2 ('"message":"hi"}') fails parse (not a JSON value) and is skipped.
    //   Net: 0 events.
    // After fix: parser accumulates content lines until blank-line boundary,
    //   joins with "\n" (valid JSON whitespace between fields), parses once.
    const events = await collect(parseSSEStream(streamFrom([
      `data: {"type":"RUN_ERROR",\ndata: "message":"hi"}\n\n`,
    ])));
    expect(events).toEqual([{ type: "RUN_ERROR", message: "hi" }]);
  });

  it("invokes opts.onMalformed when a data: line fails JSON.parse", async () => {
    const malformed: string[] = [];
    const events = await collect(parseSSEStream(
      streamFrom([
        `data: {"type":"RUN_STARTED"}\n\n`,
        `data: not valid json\n\n`,
        `data: {"type":"RUN_FINISHED"}\n\n`,
      ]),
      { onMalformed: (raw) => { malformed.push(raw); } },
    ));
    expect(events.map(e => e.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
    expect(malformed).toEqual(["not valid json"]);
  });

  it("pre-aborted signal throws cleanly without leaking the reader lock", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const stream = streamFrom([`data: {"type":"RUN_STARTED"}\n\n`]);

    let caught: Error | null = null;
    try {
      for await (const _e of parseSSEStream(stream, { signal: ctrl.signal })) {
        /* should not yield anything */
      }
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.name).toBe("AbortError");

    // After the throw, the stream's reader lock should be released so a second
    // consumer can acquire it. Confirm by acquiring a reader directly —
    // getReader() throws TypeError if the lock is still held.
    let lockReleased = true;
    try {
      const reader = stream.getReader();
      reader.releaseLock();
    } catch {
      lockReleased = false;
    }
    expect(lockReleased).toBe(true);
  });

  it("yields final single-line data: event when stream ends without trailing newline", async () => {
    // Regression for the EOF-tail bug Codex caught: a stream ending as
    // `data: {...}` (no trailing \n or \n\n) must still yield the event.
    const events = await collect(parseSSEStream(streamFrom([
      `data: {"type":"RUN_FINISHED","threadId":"t1"}`,
    ])));
    expect(events).toEqual([{ type: "RUN_FINISHED", threadId: "t1" }]);
  });

  it("yields final multi-line data: event when stream ends without trailing blank line", async () => {
    // Multi-line variant — accumulator has both lines, but no blank-line
    // boundary fires; EOF must flush.
    const events = await collect(parseSSEStream(streamFrom([
      `data: {"type":"RUN_ERROR",\ndata: "message":"bye"}`,
    ])));
    expect(events).toEqual([{ type: "RUN_ERROR", message: "bye" }]);
  });

  it("yields final event when stream ends with single trailing newline (no blank line)", async () => {
    // The middle case: one \n closes the line but no blank-line boundary.
    // Both should still yield.
    const events = await collect(parseSSEStream(streamFrom([
      `data: {"type":"RUN_FINISHED"}\n`,
    ])));
    expect(events).toEqual([{ type: "RUN_FINISHED" }]);
  });

  it("isolates a throwing onMalformed callback — stream continues yielding valid events", async () => {
    // Contract: malformed JSON is skipped and never thrown. A throwing
    // onMalformed reporter must not abort the stream.
    const events = await collect(parseSSEStream(
      streamFrom([
        `data: {"type":"RUN_STARTED"}\n\n`,
        `data: not valid json\n\n`,
        `data: {"type":"RUN_FINISHED"}\n\n`,
      ]),
      { onMalformed: () => { throw new Error("reporter blew up"); } },
    ));
    // Both valid events must still be yielded; the throw is swallowed inside emitMalformed.
    expect(events.map(e => e.type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
  });

  it("does not call console.warn when opts.onMalformed is provided", async () => {
    // Defensive contract: onMalformed REPLACES the default console.warn,
    // doesn't supplement it. A buggy reporter shouldn't ALSO produce
    // log spam.
    const original = console.warn;
    let warnCalls = 0;
    console.warn = () => { warnCalls += 1; };
    try {
      await collect(parseSSEStream(
        streamFrom([`data: bad json\n\n`]),
        { onMalformed: () => { /* swallow */ } },
      ));
    } finally {
      console.warn = original;
    }
    expect(warnCalls).toBe(0);
  });

  it("falls back to console.warn when opts.onMalformed is absent", async () => {
    // Mirror of the previous test — verifies the default path still logs.
    const original = console.warn;
    let warnCalls = 0;
    console.warn = () => { warnCalls += 1; };
    try {
      await collect(parseSSEStream(streamFrom([`data: bad json\n\n`])));
    } finally {
      console.warn = original;
    }
    expect(warnCalls).toBe(1);
  });

  it("ignores `event:`, `id:`, and `retry:` SSE field types", async () => {
    // The parser only consumes `data:` per Auggy's webTransport contract.
    // Other SSE field types must be silently dropped.
    const events = await collect(parseSSEStream(streamFrom([
      `event: ping\nid: abc-123\nretry: 1000\ndata: {"type":"RUN_STARTED"}\n\n`,
    ])));
    expect(events).toEqual([{ type: "RUN_STARTED" }]);
  });
});
