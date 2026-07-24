import type { AGUIEvent } from "./types";

export interface ParseOptions {
  /** Optional abort signal — when fired, the underlying reader is cancelled and
   *  the iterator throws AbortError on the next yield. */
  signal?: AbortSignal;
  /**
   * Optional callback for malformed JSON. By default, malformed `data:` lines
   * are logged via `console.warn` and skipped. Pass a callback to suppress the
   * default log AND get programmatic access (telemetry, UI banner, etc.).
   *
   * Receives the raw line content (without the `data:` prefix).
   */
  onMalformed?: (rawJson: string) => void;
  /** Maximum undecoded/partial-line UTF-8 bytes. Default 1 MiB. */
  maxBufferedBytes?: number;
  /** Maximum aggregate data bytes in one SSE event. Default 512 KiB. */
  maxEventBytes?: number;
  /** Maximum events accepted from one response. Default 100,000. */
  maxEvents?: number;
}

export class SSEParseLimitError extends Error {
  constructor() {
    super("The event stream exceeded a configured safety limit.");
    this.name = "SSEParseLimitError";
  }
}

/**
 * Parses an SSE response body from Auggy's webTransport into an async iterable
 * of AG-UI events.
 *
 * Tolerant of:
 *  - UTF-8 split across chunks (TextDecoder stream mode)
 *  - SSE comment lines (":...")
 *  - Blank lines between events
 *  - Multi-line `data:` events per HTML Living Standard §9.2.6 — adjacent
 *    `data:` lines belonging to a single event are joined with "\n" before
 *    JSON.parse
 *  - "[DONE]" sentinel (single-line standalone event; ignored)
 *  - Other SSE field types (`event:`, `id:`, `retry:`) — silently ignored;
 *    the parser only consumes `data:` per Auggy's webTransport contract
 *  - CRLF line endings — `.trim()` on each line + `data:` prefix strip absorbs
 *    a trailing `\r`. Documented invariant.
 *  - Malformed JSON (skipped; reported via opts.onMalformed if provided,
 *    otherwise via console.warn; never thrown — including if the
 *    onMalformed callback itself throws, which is suppressed)
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  opts: ParseOptions = {},
): AsyncIterable<AGUIEvent> {
  // Pre-iteration abort check BEFORE acquiring the reader, so an already-aborted
  // signal doesn't leak the lock.
  if (opts.signal?.aborted) {
    const e = new Error("Aborted");
    e.name = "AbortError";
    throw e;
  }

  const maxBufferedBytes = opts.maxBufferedBytes ?? 1024 * 1024;
  const maxEventBytes = opts.maxEventBytes ?? 512 * 1024;
  const maxEvents = opts.maxEvents ?? 100_000;
  for (const value of [maxBufferedBytes, maxEventBytes, maxEvents]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError("SSE parser limits must be positive integers");
    }
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const byteEncoder = new TextEncoder();
  let lineBuffer = new Uint8Array(Math.min(4096, maxBufferedBytes));
  let lineBytes = 0;
  let eventBytes = 0;
  let eventCount = 0;
  let streamCompleted = false;

  // Multi-line `data:` accumulator — flushed on event boundary (blank line)
  // or at EOF. Each `data:` line within an event is appended; flush joins
  // them with "\n" before JSON.parse.
  let dataAccumulator: string[] = [];

  const emitMalformed = (raw: string): void => {
    if (opts.onMalformed) {
      try {
        opts.onMalformed(raw);
      } catch (cbErr) {
        // Reporter callback failures must not propagate — the parser contract
        // is "malformed JSON is skipped and never thrown." Log a secondary
        // warning so the failure is visible to the operator.
        console.warn(
          "[ag-ui-parse] onMalformed callback threw; suppressing:",
          cbErr,
        );
      }
    } else {
      console.warn("[ag-ui-parse] malformed event:", raw);
    }
  };

  function* flushAccumulator(): Generator<AGUIEvent> {
    if (dataAccumulator.length === 0) return;
    eventCount++;
    if (eventCount > maxEvents) throw new SSEParseLimitError();
    const json = dataAccumulator.join("\n");
    dataAccumulator = [];
    eventBytes = 0;
    if (json === "[DONE]") return;
    let parsed: AGUIEvent;
    try {
      parsed = JSON.parse(json) as AGUIEvent;
    } catch {
      emitMalformed(json);
      return;
    }
    yield parsed;
  }

  const appendLineBytes = (bytes: Uint8Array): void => {
    const required = lineBytes + bytes.byteLength;
    if (required > maxBufferedBytes) throw new SSEParseLimitError();
    if (required > lineBuffer.byteLength) {
      const capacity = Math.min(
        maxBufferedBytes,
        Math.max(required, Math.max(1, lineBuffer.byteLength * 2)),
      );
      const grown = new Uint8Array(capacity);
      grown.set(lineBuffer.subarray(0, lineBytes));
      lineBuffer = grown;
    }
    lineBuffer.set(bytes, lineBytes);
    lineBytes = required;
  };

  function* processLine(raw: string): Generator<AGUIEvent> {
    const line = raw.trim(); // absorbs trailing \r on CRLF inputs
    if (!line) {
      yield* flushAccumulator();
      // A consumer may abort in response to the just-yielded event.
      if (opts.signal?.aborted) {
        const error = new Error("Aborted");
        error.name = "AbortError";
        throw error;
      }
      return;
    }
    if (line.startsWith(":")) return;
    if (!line.startsWith("data:")) return;
    const data = line.slice("data:".length).trim();
    eventBytes += byteEncoder.encode(data).byteLength + (dataAccumulator.length > 0 ? 1 : 0);
    if (eventBytes > maxEventBytes) throw new SSEParseLimitError();
    dataAccumulator.push(data);
  }

  const onAbort = (): void => {
    reader.cancel().catch(() => {
      /* already closed */
    });
  };
  if (opts.signal) {
    opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        streamCompleted = true;
        break;
      }

      let offset = 0;
      while (offset < value.byteLength) {
        const newline = value.indexOf(0x0a, offset);
        if (newline < 0) {
          appendLineBytes(value.subarray(offset));
          break;
        }
        appendLineBytes(value.subarray(offset, newline));
        const raw = decoder.decode(lineBuffer.subarray(0, lineBytes));
        lineBytes = 0;
        yield* processLine(raw);
        offset = newline + 1;
      }
    }

    // EOF — process a final unterminated line before flushing the event.
    if (lineBytes > 0) {
      yield* processLine(decoder.decode(lineBuffer.subarray(0, lineBytes)));
    }
    yield* flushAccumulator();
  } finally {
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    if (!streamCompleted) {
      await reader.cancel().catch(() => {
        /* already closed */
      });
    }
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}
