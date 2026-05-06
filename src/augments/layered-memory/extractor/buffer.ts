import type { Transcript } from "../../../types";

/**
 * Per-peer in-memory buffer used by the `session-end-only` extraction
 * mode (Decision 3 of the memorist design). When the frequency
 * dispatcher returns "buffer" for a turn, the auto-save handler
 * appends that turn's `Transcript` here. At a configured boundary —
 * session end, idle threshold, or operator-triggered flush — the
 * augment calls `flush(peerId)` and runs extraction on the accumulated
 * snapshot.
 *
 * Process-local: a restart drops all buffered transcripts. That's the
 * intended trade-off — buffered visitor traffic is operationally
 * low-stakes (anonymous public peers), and persistence would require
 * its own retention/compaction story disproportionate to the value.
 */
export interface ExtractionBuffer {
  /** Append a completed turn's transcript to the peer's buffer. */
  append(peerId: string, transcript: Transcript): void;
  /**
   * Drain and return the peer's buffered transcripts. Subsequent
   * `peek` returns an empty array until the next `append`.
   */
  flush(peerId: string): Transcript[];
  /** Read-only view of currently buffered transcripts for a peer. */
  peek(peerId: string): readonly Transcript[];
  /** Drop the peer's buffer without returning it (e.g. on `forget`). */
  clear(peerId: string): void;
  /** Number of distinct peers with at least one buffered transcript. */
  size(): number;
}

export function createBuffer(): ExtractionBuffer {
  const store = new Map<string, Transcript[]>();
  return {
    append(peerId, transcript) {
      const list = store.get(peerId) ?? [];
      list.push(transcript);
      store.set(peerId, list);
    },
    flush(peerId) {
      const list = store.get(peerId) ?? [];
      store.delete(peerId);
      return list;
    },
    peek(peerId) {
      return store.get(peerId) ?? [];
    },
    clear(peerId) {
      store.delete(peerId);
    },
    size() {
      return store.size;
    },
  };
}
