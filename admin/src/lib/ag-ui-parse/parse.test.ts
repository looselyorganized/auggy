import { describe, expect, it } from "bun:test";
import { parseSSEStream, SSEParseLimitError } from "./parse";
import type { AGUIEvent } from "./types";

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("parseSSEStream limits", () => {
  it("rejects an oversized partial line", async () => {
    const consume = async () => {
      for await (const _event of parseSSEStream(stream(`data: ${"x".repeat(100)}`), {
        maxBufferedBytes: 16,
      })) {
        // no-op
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(SSEParseLimitError);
  });

  it("rejects an oversized multi-line event before JSON parsing", async () => {
    const consume = async () => {
      for await (const _event of parseSSEStream(stream("data: 123456\ndata: 7890\n\n"), {
        maxEventBytes: 8,
      })) {
        // no-op
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(SSEParseLimitError);
  });

  it("bounds event count while preserving valid events", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"RUN_STARTED"}\n\ndata: {"type":"RUN_FINISHED"}\n\n',
          ),
        );
      },
      cancel() {
        canceled = true;
      },
    });
    const events: AGUIEvent[] = [];
    const consume = async () => {
      for await (const event of parseSSEStream(body, { maxEvents: 1 })) events.push(event);
    };
    await expect(consume()).rejects.toBeInstanceOf(SSEParseLimitError);
    expect(events).toHaveLength(1);
    expect(canceled).toBe(true);
  });

  it("handles a highly fragmented line with bounded incremental copying", async () => {
    const encoded = new TextEncoder().encode(
      `data: ${JSON.stringify({ type: "RUN_STARTED", value: "x".repeat(8192) })}\n\n`,
    );
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= encoded.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(encoded.subarray(offset, offset + 1));
        offset++;
      },
    });
    const events: AGUIEvent[] = [];

    for await (const event of parseSSEStream(body, {
      maxBufferedBytes: encoded.byteLength,
      maxEventBytes: encoded.byteLength,
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("RUN_STARTED");
  });
});
