import { describe, expect, it } from "bun:test";
import {
  createBoundedModelFetch,
  ModelResponseLimitError,
  normalizeModelResponseAccounting,
  StreamingResponseLimitTracker,
  measureJsonValue,
  resolveModelResponseLimits,
  utf8ByteLength,
  validateModelResponse,
} from "../../src/engines/_shared/response-limits";

const base = {
  content: "",
  inputTokens: 1,
  outputTokens: 1,
  finishReason: "end_turn" as const,
};

describe("model response limits", () => {
  it("matches UTF-8 encoding without retaining an encoded copy", () => {
    for (const value of ["ascii", "é", "😀", "\ud800", "\udc00", "a😀éz"]) {
      expect(utf8ByteLength(value)).toBe(new TextEncoder().encode(value).byteLength);
    }
    expect(utf8ByteLength("😀".repeat(100), 8)).toBeGreaterThan(8);
  });

  it("counts UTF-8 text bytes at the exact boundary", () => {
    expect(validateModelResponse({ ...base, content: "😀" }, { maxTextBytes: 4 })).toBeTruthy();
    expect(() => validateModelResponse({ ...base, content: "😀x" }, { maxTextBytes: 4 })).toThrow(
      ModelResponseLimitError,
    );
  });

  it("rejects malformed provider accounting and normalizes it to unpriced", () => {
    for (const invalid of [
      { ...base, inputTokens: -1, costUsd: -0.1 },
      { ...base, outputTokens: Number.POSITIVE_INFINITY, costUsd: Number.POSITIVE_INFINITY },
      { ...base, cacheReadTokens: Number.NaN },
    ]) {
      expect(() => validateModelResponse(invalid)).toThrow(ModelResponseLimitError);
    }
    expect(
      normalizeModelResponseAccounting({
        inputTokens: -1,
        outputTokens: Number.POSITIVE_INFINITY,
        costUsd: -0.1,
      }),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      unpricedReason: "Provider returned invalid accounting metadata.",
    });
  });

  it("rejects malformed runtime response and tool-call shapes", () => {
    for (const malformed of [
      { ...base, content: { nested: "not text" } },
      { ...base, finishReason: { nested: "not a discriminator" } },
      { ...base, toolCalls: { name: "not-an-array" } },
      { ...base, toolCalls: [{ name: { nested: "not text" }, arguments: {} }] },
      { ...base, toolCalls: [{ name: "tool", arguments: [] }] },
    ]) {
      expect(() => validateModelResponse(malformed as unknown as typeof base)).toThrow(
        ModelResponseLimitError,
      );
    }
  });

  it("rejects excessive tool count before dispatch", () => {
    expect(() =>
      validateModelResponse(
        {
          ...base,
          toolCalls: [
            { name: "a", arguments: {} },
            { name: "b", arguments: {} },
          ],
        },
        { maxToolCalls: 1 },
      ),
    ).toThrow(ModelResponseLimitError);
  });

  it("rejects deep, wide, cyclic, and accessor argument objects boundedly", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 40; i++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(() =>
      measureJsonValue(deep, { maxBytes: 1_000_000, maxDepth: 32, maxNodes: 1000 }),
    ).toThrow(ModelResponseLimitError);
    expect(() =>
      measureJsonValue(
        Array.from({ length: 100 }, () => null),
        {
          maxBytes: 1_000_000,
          maxDepth: 32,
          maxNodes: 20,
        },
      ),
    ).toThrow(ModelResponseLimitError);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      measureJsonValue(cyclic, { maxBytes: 1_000_000, maxDepth: 32, maxNodes: 1000 }),
    ).toThrow(ModelResponseLimitError);

    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        throw new Error("sentinel");
      },
    });
    expect(() =>
      measureJsonValue(accessor, { maxBytes: 1_000_000, maxDepth: 32, maxNodes: 1000 }),
    ).toThrow(ModelResponseLimitError);
  });

  it("bounds cumulative stream bytes and event count before emission", () => {
    const limits = resolveModelResponseLimits({ maxTextBytes: 4, maxStreamEvents: 2 });
    const tracker = new StreamingResponseLimitTracker(limits);
    tracker.pushText("ab");
    tracker.pushText("cd");
    expect(() => tracker.pushText("")).toThrow(ModelResponseLimitError);
  });

  it("cancels decompressed provider bodies before SDK materialization", async () => {
    let canceled = false;
    const base = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x".repeat(20)));
            controller.enqueue(new TextEncoder().encode("y".repeat(20)));
          },
          cancel() {
            canceled = true;
          },
        }),
      )) as unknown as typeof fetch;
    const bounded = createBoundedModelFetch(base, {
      maxTextBytes: 8,
      maxResponseBytes: 8,
    });
    const response = await bounded("https://provider.example/");
    await expect(response.text()).rejects.toBeInstanceOf(ModelResponseLimitError);
    expect(canceled).toBe(true);
  });

  it("caps individual provider SSE and NDJSON messages across chunks", async () => {
    for (const contentType of ["text/event-stream", "application/x-ndjson"]) {
      let canceled = false;
      const base = (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("12345"));
              controller.enqueue(new TextEncoder().encode("6789"));
            },
            cancel() {
              canceled = true;
            },
          }),
          { headers: { "content-type": contentType } },
        )) as unknown as typeof fetch;
      const response = await createBoundedModelFetch(base, {
        maxTextBytes: 8,
        maxResponseBytes: 8,
      })("https://provider.example/");
      await expect(response.text()).rejects.toBeInstanceOf(ModelResponseLimitError);
      expect(canceled).toBe(true);
    }
  });
});
