import type { AGUIEvent } from "./types";

export interface ParseOptions {
  signal?: AbortSignal;
}

/**
 * Parses an SSE response body into an async iterable of AG-UI events.
 *
 * Tolerant of:
 *  - UTF-8 split across chunks (TextDecoder stream mode)
 *  - SSE comment lines (":...")
 *  - Blank lines between events
 *  - "[DONE]" sentinel
 *  - Malformed JSON (skipped with console.warn, never thrown)
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  opts: ParseOptions = {},
): AsyncIterable<AGUIEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const onAbort = () => { reader.cancel().catch(() => {}); };
  if (opts.signal) {
    if (opts.signal.aborted) {
      const e = new Error("Aborted"); e.name = "AbortError"; throw e;
    }
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
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;

        const json = line.slice("data:".length).trim();
        if (json === "[DONE]") continue;

        let parsed: AGUIEvent;
        try { parsed = JSON.parse(json) as AGUIEvent; }
        catch { console.warn("[ag-ui-parse] malformed event:", json); continue; }
        yield parsed;

        if (opts.signal?.aborted) {
          const e = new Error("Aborted"); e.name = "AbortError"; throw e;
        }
      }
    }

    // Flush trailing buffered line
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const json = tail.slice("data:".length).trim();
      if (json && json !== "[DONE]") {
        try { yield JSON.parse(json) as AGUIEvent; }
        catch { console.warn("[ag-ui-parse] malformed trailing event:", json); }
      }
    }
  } finally {
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}
