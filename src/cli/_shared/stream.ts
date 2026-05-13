/**
 * Byte-stream utilities shared across CLI subprocess wrappers
 * (`bun-install.ts`, `deploy/railway-cli.ts`).
 *
 * Two related operations both consume a `ReadableStream<Uint8Array>`:
 *   - drain the whole stream into a string (`readAllText`) — used when the
 *     caller wants the buffered output as a single value.
 *   - drain while echoing each chunk to a side channel (`readAllTextTeed`)
 *     — used when the caller wants live output AND a captured buffer.
 *
 * Both share the same chunk-merge primitive (`concatChunks`).
 */

/** Concatenate a list of Uint8Array chunks into a single buffer. */
export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
}

/** Drain a byte stream into a UTF-8 string. */
export async function readAllText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new TextDecoder().decode(concatChunks(chunks));
}

/**
 * Drain a byte stream into a UTF-8 string AND tee each chunk to `onChunk`
 * as it arrives. Used when the caller wants to forward live output (e.g.
 * to `process.stderr.write`) while still capturing the buffered text for
 * a final error message or test assertion.
 */
export async function readAllTextTeed(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      onChunk(value);
    }
  }
  return new TextDecoder().decode(concatChunks(chunks));
}
