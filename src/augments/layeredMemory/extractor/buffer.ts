import type { Transcript } from "../../../types";
import { measureJsonValue } from "../../../engines/_shared/response-limits";

export interface ExtractionBufferLimits {
  maxTurnsPerThread: number;
  maxBytesPerThread: number;
  maxBytesPerPeer: number;
  maxTotalBytes: number;
  maxPeers: number;
  idleTtlMs: number;
}

export const DEFAULT_EXTRACTION_BUFFER_LIMITS: Readonly<ExtractionBufferLimits> = {
  maxTurnsPerThread: 32,
  maxBytesPerThread: 256 * 1024,
  maxBytesPerPeer: 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxPeers: 1024,
  idleTtlMs: 30 * 60 * 1000,
};

export interface ExtractionBuffer {
  /** Returns false when the single transcript cannot fit safely. */
  append(peerId: string, transcript: Transcript): boolean;
  flush(peerId: string): Transcript[];
  peek(peerId: string): readonly Transcript[];
  sweep(): void;
  clear(): void;
}

interface BufferedTranscript {
  transcript: Transcript;
  bytes: number;
  sequence: number;
}

interface ThreadBuffer {
  items: BufferedTranscript[];
  bytes: number;
}

interface PeerBuffer {
  threads: Map<string, ThreadBuffer>;
  bytes: number;
  lastAccess: number;
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`layeredMemory autoSave buffer ${name} must be a positive integer`);
  }
}

function resolveLimits(configured?: Partial<ExtractionBufferLimits>): ExtractionBufferLimits {
  const limits = { ...DEFAULT_EXTRACTION_BUFFER_LIMITS, ...configured };
  for (const [name, value] of Object.entries(limits)) positiveInteger(name, value);
  if (limits.maxBytesPerThread > limits.maxBytesPerPeer) {
    throw new TypeError("layeredMemory autoSave maxBytesPerThread cannot exceed maxBytesPerPeer");
  }
  if (limits.maxBytesPerPeer > limits.maxTotalBytes) {
    throw new TypeError("layeredMemory autoSave maxBytesPerPeer cannot exceed maxTotalBytes");
  }
  return limits;
}

export function createBuffer(
  configured?: Partial<ExtractionBufferLimits>,
  now: () => number = Date.now,
): ExtractionBuffer {
  const limits = resolveLimits(configured);
  const peers = new Map<string, PeerBuffer>();
  let totalBytes = 0;
  let sequence = 0;

  function deletePeer(peerId: string): void {
    const peer = peers.get(peerId);
    if (!peer) return;
    totalBytes -= peer.bytes;
    peers.delete(peerId);
  }

  function removeOldestFromPeer(peerId: string, peer: PeerBuffer): boolean {
    let oldestThreadId: string | null = null;
    let oldestSequence = Number.POSITIVE_INFINITY;
    for (const [threadId, thread] of peer.threads) {
      const head = thread.items[0];
      if (head && head.sequence < oldestSequence) {
        oldestSequence = head.sequence;
        oldestThreadId = threadId;
      }
    }
    if (oldestThreadId === null) return false;
    const thread = peer.threads.get(oldestThreadId)!;
    const removed = thread.items.shift()!;
    thread.bytes -= removed.bytes;
    peer.bytes -= removed.bytes;
    totalBytes -= removed.bytes;
    if (thread.items.length === 0) peer.threads.delete(oldestThreadId);
    if (peer.threads.size === 0) peers.delete(peerId);
    return true;
  }

  function oldestPeerId(): string | null {
    let selected: string | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [peerId, peer] of peers) {
      if (peer.lastAccess < oldest) {
        selected = peerId;
        oldest = peer.lastAccess;
      }
    }
    return selected;
  }

  function sweep(): void {
    const cutoff = now() - limits.idleTtlMs;
    for (const [peerId, peer] of peers) {
      if (peer.lastAccess <= cutoff) deletePeer(peerId);
    }
  }

  return {
    append(peerId, transcript) {
      sweep();
      let bytes: number;
      try {
        bytes = measureJsonValue(transcript, {
          maxBytes: Math.min(limits.maxBytesPerThread, limits.maxBytesPerPeer),
          maxDepth: 64,
          maxNodes: 100_000,
        }).bytes;
      } catch {
        return false;
      }
      if (
        bytes > limits.maxBytesPerThread ||
        bytes > limits.maxBytesPerPeer ||
        bytes > limits.maxTotalBytes
      ) {
        return false;
      }
      let snapshot: Transcript;
      try {
        snapshot = structuredClone(transcript);
      } catch {
        return false;
      }

      const peer = peers.get(peerId) ?? {
        threads: new Map<string, ThreadBuffer>(),
        bytes: 0,
        lastAccess: now(),
      };
      peer.lastAccess = now();
      const thread = peer.threads.get(snapshot.threadId) ?? { items: [], bytes: 0 };
      const item = { transcript: snapshot, bytes, sequence: sequence++ };
      thread.items.push(item);
      thread.bytes += bytes;
      peer.threads.set(snapshot.threadId, thread);
      peer.bytes += bytes;
      peers.set(peerId, peer);
      totalBytes += bytes;

      while (
        thread.items.length > limits.maxTurnsPerThread ||
        thread.bytes > limits.maxBytesPerThread
      ) {
        const removed = thread.items.shift()!;
        thread.bytes -= removed.bytes;
        peer.bytes -= removed.bytes;
        totalBytes -= removed.bytes;
      }
      while (peer.bytes > limits.maxBytesPerPeer) {
        if (!removeOldestFromPeer(peerId, peer)) break;
      }
      while (peers.size > limits.maxPeers) {
        const evicted = oldestPeerId();
        if (evicted === null) break;
        deletePeer(evicted);
      }
      while (totalBytes > limits.maxTotalBytes) {
        let selectedPeerId: string | null = null;
        let oldestSequence = Number.POSITIVE_INFINITY;
        for (const [candidatePeerId, candidate] of peers) {
          for (const threadBuffer of candidate.threads.values()) {
            const head = threadBuffer.items[0];
            if (head && head.sequence < oldestSequence) {
              oldestSequence = head.sequence;
              selectedPeerId = candidatePeerId;
            }
          }
        }
        if (selectedPeerId === null) break;
        const selectedPeer = peers.get(selectedPeerId);
        if (!selectedPeer || !removeOldestFromPeer(selectedPeerId, selectedPeer)) break;
      }
      return peers.get(peerId)?.threads.get(snapshot.threadId)?.items.includes(item) ?? false;
    },
    flush(peerId) {
      sweep();
      const peer = peers.get(peerId);
      if (!peer) return [];
      const items = Array.from(peer.threads.values())
        .flatMap((thread) => thread.items)
        .sort((a, b) => a.sequence - b.sequence)
        .map((item) => item.transcript);
      deletePeer(peerId);
      return items;
    },
    peek(peerId) {
      sweep();
      const peer = peers.get(peerId);
      if (!peer) return [];
      return Array.from(peer.threads.values())
        .flatMap((thread) => thread.items)
        .sort((a, b) => a.sequence - b.sequence)
        .map((item) => item.transcript);
    },
    sweep,
    clear() {
      peers.clear();
      totalBytes = 0;
    },
  };
}
