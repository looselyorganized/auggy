import { describe, expect, it } from "bun:test";
import { createRingBuffer } from "@/lib/ring-buffer";

describe("ring-buffer", () => {
  it("starts empty", () => {
    const rb = createRingBuffer<number>(3);
    expect(rb.snapshot()).toEqual([]);
  });

  it("push then snapshot returns items in insertion order", () => {
    const rb = createRingBuffer<number>(5);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    expect(rb.snapshot()).toEqual([1, 2, 3]);
  });

  it("evicts oldest when capacity exceeded", () => {
    const rb = createRingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4);
    expect(rb.snapshot()).toEqual([2, 3, 4]);
  });

  it("evicts multiple oldest when pushing many over capacity", () => {
    const rb = createRingBuffer<number>(2);
    [1, 2, 3, 4, 5, 6].forEach((n) => {
      rb.push(n);
    });
    expect(rb.snapshot()).toEqual([5, 6]);
  });

  it("snapshot returns a copy — mutations to the returned array don't affect the buffer", () => {
    const rb = createRingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    const snap = rb.snapshot();
    snap.push(99);
    expect(rb.snapshot()).toEqual([1, 2]);
  });

  it("clear empties the buffer", () => {
    const rb = createRingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.clear();
    expect(rb.snapshot()).toEqual([]);
    rb.push(3);
    expect(rb.snapshot()).toEqual([3]);
  });

  it("works with object types", () => {
    const rb = createRingBuffer<{ id: string }>(2);
    rb.push({ id: "a" });
    rb.push({ id: "b" });
    rb.push({ id: "c" });
    expect(rb.snapshot().map((x) => x.id)).toEqual(["b", "c"]);
  });

  it("throws on non-positive maxSize", () => {
    expect(() => createRingBuffer<number>(0)).toThrow();
    expect(() => createRingBuffer<number>(-1)).toThrow();
  });
});
