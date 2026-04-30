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
 *  - "[DONE]" sentinel
 *  - CRLF line endings — `.trim()` on each line + `data:` prefix strip absorbs
 *    a trailing `\r`. Documented invariant.
 *  - Malformed JSON (skipped; reported via opts.onMalformed if provided,
 *    otherwise via console.warn; never thrown)
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

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Multi-line `data:` accumulator — flushed on event boundary (blank line)
  // or at EOF. Each `data:` line within an event is appended; flush joins
  // them with "\n" before JSON.parse.
  let dataAccumulator: string[] = [];

  const emitMalformed = (raw: string): void => {
    if (opts.onMalformed) opts.onMalformed(raw);
    else console.warn("[ag-ui-parse] malformed event:", raw);
  };

  function* flushAccumulator(): Generator<AGUIEvent> {
    if (dataAccumulator.length === 0) return;
    const json = dataAccumulator.join("\n");
    dataAccumulator = [];
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
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const raw of lines) {
        const line = raw.trim(); // absorbs trailing \r on CRLF inputs
        if (!line) {
          // Blank line — event boundary. Flush any accumulated data.
          yield* flushAccumulator();
          // After yielding, check abort: a consumer may have aborted in
          // response to the just-yielded event, and we want to surface that
          // as AbortError rather than silently draining via reader.cancel().
          if (opts.signal?.aborted) {
            const e = new Error("Aborted");
            e.name = "AbortError";
            throw e;
          }
          continue;
        }
        if (line.startsWith(":")) continue; // comment
        if (!line.startsWith("data:")) continue; // ignore other SSE field types (event:, id:, retry:)
        dataAccumulator.push(line.slice("data:".length).trim());
      }
    }

    // EOF — finalize the decoder (flush any pending UTF-8 bytes) and process
    // any remaining buffer content as a final line before flushing the
    // accumulator. Without this, a stream ending mid-line (e.g. `data: {...}`
    // with no trailing newline) silently drops its final event.
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      if (tail.startsWith("data:")) {
        dataAccumulator.push(tail.slice("data:".length).trim());
      }
      // Other field types (`event:`, `id:`, `retry:`, `:`-comments) are
      // intentionally dropped — same as in the main loop.
    }
    yield* flushAccumulator();
  } finally {
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}
