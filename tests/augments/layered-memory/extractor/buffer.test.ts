import { describe, test, expect } from "bun:test";
import { createBuffer } from "@/augments/layeredMemory/extractor/buffer";
import type { Transcript } from "@/types";

function transcript(turnId: string, threadId = "thread", text = ""): Transcript {
  return {
    turnId,
    threadId,
    peer: null,
    parts: [{ kind: "text", text }],
    toolCalls: [],
    startedAt: 1,
    endedAt: 2,
  };
}

describe("extraction buffer", () => {
  test("accumulates transcripts across turns for the same peer", () => {
    const buf = createBuffer();
    buf.append("p1", { turnId: "t1", parts: [] } as unknown as Transcript);
    buf.append("p1", { turnId: "t2", parts: [] } as unknown as Transcript);
    expect(buf.peek("p1").length).toBe(2);
  });

  test("flush returns and clears the peer's buffer", () => {
    const buf = createBuffer();
    buf.append("p1", { turnId: "t1" } as unknown as Transcript);
    const flushed = buf.flush("p1");
    expect(flushed.length).toBe(1);
    expect(buf.peek("p1").length).toBe(0);
  });

  test("flush on a peer with no buffered entries returns empty array", () => {
    const buf = createBuffer();
    expect(buf.flush("nobody").length).toBe(0);
  });

  test("buffers for different peers are independent", () => {
    const buf = createBuffer();
    buf.append("p1", { turnId: "t1" } as unknown as Transcript);
    buf.append("p2", { turnId: "t2" } as unknown as Transcript);
    expect(buf.peek("p1").length).toBe(1);
    expect(buf.peek("p2").length).toBe(1);
  });

  test("enforces per-thread turn limits before retaining more data", () => {
    const buf = createBuffer({ maxTurnsPerThread: 2 });
    expect(buf.append("p1", transcript("t1"))).toBe(true);
    expect(buf.append("p1", transcript("t2"))).toBe(true);
    expect(buf.append("p1", transcript("t3"))).toBe(true);
    expect(buf.peek("p1").map((item) => item.turnId)).toEqual(["t2", "t3"]);
  });

  test("counts encoded bytes and rejects an oversized single transcript", () => {
    const small = transcript("small", "thread", "");
    const baseline = new TextEncoder().encode(JSON.stringify(small)).byteLength;
    const buf = createBuffer({
      maxBytesPerThread: baseline + 4,
      maxBytesPerPeer: baseline + 4,
      maxTotalBytes: baseline + 4,
    });
    expect(buf.append("p1", transcript("small", "thread", "😀"))).toBe(true);
    buf.clear();
    expect(buf.append("p1", transcript("large", "thread", "😀x"))).toBe(false);
    expect(buf.peek("p1")).toHaveLength(0);
  });

  test("evicts idle peers with an injected clock", () => {
    let now = 0;
    const buf = createBuffer({ idleTtlMs: 10 }, () => now);
    buf.append("p1", transcript("t1"));
    now = 11;
    buf.sweep();
    expect(buf.peek("p1")).toHaveLength(0);
  });

  test("does not flush transcripts after their idle TTL", () => {
    let now = 0;
    const buf = createBuffer({ idleTtlMs: 10 }, () => now);
    expect(buf.append("p1", transcript("t1"))).toBe(true);
    now = 11;
    expect(buf.flush("p1")).toHaveLength(0);
  });

  test("retains an isolated snapshot so caller mutation cannot bypass accounting", () => {
    const original = transcript("t1", "thread", "safe");
    const buf = createBuffer();
    expect(buf.append("p1", original)).toBe(true);
    (original.parts[0] as { kind: "text"; text: string }).text = "x".repeat(1_000_000);
    const retained = buf.peek("p1");
    expect(retained).toHaveLength(1);
    expect((retained[0]!.parts[0] as { kind: "text"; text: string }).text).toBe("safe");
  });

  test("enforces a global peer cap", () => {
    let now = 0;
    const buf = createBuffer({ maxPeers: 2 }, () => now++);
    buf.append("p1", transcript("t1"));
    buf.append("p2", transcript("t2"));
    buf.append("p3", transcript("t3"));
    expect(buf.peek("p1")).toHaveLength(0);
    expect(buf.peek("p2")).toHaveLength(1);
    expect(buf.peek("p3")).toHaveLength(1);
  });

  test("fails closed for cyclic transcript data without a stack overflow", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    const t = transcript("cyclic");
    t.parts.push({ kind: "data", data: value });
    const buf = createBuffer();
    expect(buf.append("p1", t)).toBe(false);
    expect(buf.peek("p1")).toHaveLength(0);
  });
});
