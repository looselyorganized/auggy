import { describe, test, expect } from "bun:test";
import { createBuffer } from "@/augments/layered-memory/extractor/buffer";
import type { Transcript } from "@/types";

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
});
