import { describe, expect, it } from "bun:test";

import {
  AuggyRunError,
  createAuggyRunClient,
  MAX_BEARER_TOKEN_BYTES,
  MAX_SSE_BYTES,
  MAX_SSE_EVENTS,
  type AuggyRunClientConfig,
  type FetchImplementation,
} from "../src/auggy-client.ts";

const runId = "run_123";
const threadId = "temporal-order-42";

function fakeAuggy(handler: () => Response | Promise<Response>): {
  target: string;
  requests: Request[];
  fetchImplementation: FetchImplementation;
} {
  const requests: Request[] = [];
  return {
    target: "http://127.0.0.1:8080",
    requests,
    async fetchImplementation(input, init) {
      const request = new Request(input, init);
      requests.push(request);
      return handler();
    },
  };
}

function client(
  target: string,
  fetchImplementation: FetchImplementation,
  overrides: Partial<AuggyRunClientConfig> = {},
) {
  return createAuggyRunClient({
    target,
    bearerToken: "test-only-secret",
    maxSseBytes: 2_048,
    maxSseEvents: 8,
    allowInsecureLocalhost: true,
    fetchImplementation,
    ...overrides,
  });
}

function sse(...events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function started(overrides: Record<string, unknown> = {}) {
  return { type: "RUN_STARTED", runId, threadId, ...overrides };
}

function finished(status: unknown = "completed", overrides: Record<string, unknown> = {}) {
  return { type: "RUN_FINISHED", runId, threadId, result: { status }, ...overrides };
}

const request = {
  idempotencyKey: "refund-order-42",
  threadId: "temporal-order-42",
  message: "Review order 42",
};

describe("Auggy Temporal Activity HTTP client", () => {
  it("sends one non-redirecting authenticated request and accepts only a completed execution", async () => {
    const fake = fakeAuggy(() =>
      sse(
        started(),
        { type: "TEXT_MESSAGE_CONTENT", delta: "approved" },
        finished("completed"),
      ),
    );

    const result = await client(fake.target, fake.fetchImplementation).run(request);

    expect(result).toEqual({ runId, threadId, text: "approved" });
    expect(fake.requests).toHaveLength(1);
    const sent = fake.requests[0]!;
    expect(sent.url).toBe(`${fake.target}/agent/run`);
    expect(sent.redirect).toBe("error");
    expect(sent.headers.get("authorization")).toBe("Bearer test-only-secret");
    expect(sent.headers.get("idempotency-key")).toBe("refund-order-42");
    expect(await sent.json()).toEqual({
      messages: [{ role: "user", content: "Review order 42" }],
      threadId: "temporal-order-42",
    });
  });

  it.each([
    [409, "idempotency_key_conflict", "binding-conflict", false],
    [409, "idempotency_outcome_unknown", "outcome-unknown", false],
    [503, "unavailable", "admission-failed", true],
    [401, "unauthorized", "rejected", false],
    [302, "redirect", "invalid-response", false],
  ])("maps HTTP %i %s conservatively", async (status, body, kind, retryable) => {
    const fake = fakeAuggy(() => new Response(JSON.stringify({ error: body }), { status }));

    await expect(client(fake.target, fake.fetchImplementation).run(request)).rejects.toMatchObject({
      kind,
      retryable,
    });
  });

  it.each([
    ["working", "task-working"],
    ["input-required", "input-required"],
    ["auth-required", "auth-required"],
    ["failed", "task-failed"],
    ["canceled", "remote-canceled"],
    ["rejected", "rejected"],
    ["future-state", "task-status-unknown"],
  ])("never treats RUN_FINISHED status %s as completion", async (status, kind) => {
    const fake = fakeAuggy(() => sse(started(), finished(status)));
    await expect(client(fake.target, fake.fetchImplementation).run(request)).rejects.toMatchObject({
      kind,
      retryable: false,
    });
  });

  it.each([
    ["missing result", { type: "RUN_FINISHED", runId, threadId }],
    ["missing status", { type: "RUN_FINISHED", runId, threadId, result: {} }],
    ["non-string status", { type: "RUN_FINISHED", runId, threadId, result: { status: 7 } }],
  ])("rejects RUN_FINISHED with %s", async (_label, terminal) => {
    const fake = fakeAuggy(() => sse(started(), terminal));
    await expect(client(fake.target, fake.fetchImplementation).run(request)).rejects.toMatchObject({
      kind: "invalid-response",
      retryable: false,
    });
  });

  it.each([
    ["terminal before start", [finished()]],
    ["event before start", [{ type: "TEXT_MESSAGE_CONTENT", delta: "bad" }, started(), finished()]],
    [
      "RUN_ERROR before start",
      [{ type: "RUN_ERROR", code: "SCHEDULER_UNAVAILABLE" }, finished("rejected")],
    ],
    ["duplicate start", [started(), started(), finished()]],
    ["duplicate terminal", [started(), finished(), finished()]],
    ["event after terminal", [started(), finished(), { type: "TEXT_MESSAGE_CONTENT", delta: "bad" }]],
  ])("rejects invalid execution order: %s", async (_label, events) => {
    const fake = fakeAuggy(() => sse(...events));
    await expect(client(fake.target, fake.fetchImplementation).run(request)).rejects.toMatchObject({
      kind: "invalid-response",
      retryable: false,
    });
  });

  it.each([
    ["run", finished("completed", { runId: "different-run" })],
    ["thread", finished("completed", { threadId: "different-thread" })],
    ["missing run", { type: "RUN_FINISHED", threadId, result: { status: "completed" } }],
    ["missing thread", { type: "RUN_FINISHED", runId, result: { status: "completed" } }],
  ])("rejects a terminal with a %s identity mismatch", async (_label, terminal) => {
    const fake = fakeAuggy(() => sse(started(), terminal));
    await expect(client(fake.target, fake.fetchImplementation).run(request)).rejects.toMatchObject({
      kind: "invalid-response",
      retryable: false,
    });
  });

  it.each([
    ["run", { type: "TEXT_MESSAGE_CONTENT", runId: "different-run", delta: "bad" }],
    ["thread", { type: "TEXT_MESSAGE_CONTENT", threadId: "different-thread", delta: "bad" }],
  ])("rejects an intermediate event with a %s identity mismatch", async (_label, event) => {
    const fake = fakeAuggy(() => sse(started(), event, finished()));
    await expect(client(fake.target, fake.fetchImplementation).run(request)).rejects.toMatchObject({
      kind: "invalid-response",
      retryable: false,
    });
  });

  it.each([
    ["missing run", started({ runId: undefined })],
    ["empty thread", started({ threadId: "" })],
    ["oversized run", started({ runId: "r".repeat(257) })],
    ["oversized thread", started({ threadId: "t".repeat(257) })],
  ])("rejects a RUN_STARTED with %s", async (_label, first) => {
    const fake = fakeAuggy(() => sse(first, finished()));
    await expect(client(fake.target, fake.fetchImplementation).run(request)).rejects.toMatchObject({
      kind: "invalid-response",
      retryable: false,
    });
  });

  it("rejects a consistently wrong thread even when the execution otherwise completes", async () => {
    const wrongThread = "different-thread";
    const fake = fakeAuggy(() =>
      sse(
        started({ threadId: wrongThread }),
        finished("completed", { threadId: wrongThread }),
      ),
    );
    await expect(client(fake.target, fake.fetchImplementation).run(request)).rejects.toMatchObject({
      kind: "invalid-response",
      retryable: false,
    });
  });

  it("distinguishes remote RUN_ERROR cancellation from local Temporal cancellation", async () => {
    const remote = fakeAuggy(() =>
      sse(started(), { type: "RUN_ERROR", code: "CANCELED" }, finished("canceled")),
    );
    await expect(client(remote.target, remote.fetchImplementation).run(request)).rejects.toMatchObject({
      kind: "remote-canceled",
      retryable: false,
    });

    const controller = new AbortController();
    controller.abort();
    const local = fakeAuggy(() => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(
      client(local.target, local.fetchImplementation).run(request, controller.signal),
    ).rejects.toMatchObject({ kind: "local-canceled", retryable: false });
  });

  it("never lets a completed terminal erase a preceding RUN_ERROR", async () => {
    const fake = fakeAuggy(() =>
      sse(started(), { type: "RUN_ERROR", code: "INTERNAL" }, finished("completed")),
    );
    await expect(client(fake.target, fake.fetchImplementation).run(request)).rejects.toMatchObject({
      kind: "run-error",
      retryable: false,
    });
  });

  it.each(["ADMISSION_FAILED", "SCHEDULER_RATE_LIMITED", "SCHEDULER_UNAVAILABLE"])(
    "preserves retryable admission RUN_ERROR code %s",
    async (code) => {
      const admission = fakeAuggy(() =>
        sse(started(), { type: "RUN_ERROR", code }, finished("rejected")),
      );
      await expect(client(admission.target, admission.fetchImplementation).run(request)).rejects.toMatchObject({
        kind: "admission-failed",
        retryable: true,
      });
    },
  );

  it.each([
    ["CAP_DENIED", "rejected"],
    ["REJECTED", "rejected"],
    ["THREAD_QUARANTINED", "outcome-unknown"],
    ["INTERNAL", "run-error"],
  ])("maps RUN_ERROR code %s conservatively", async (code, kind) => {
    const fake = fakeAuggy(() =>
      sse(started(), { type: "RUN_ERROR", code }, finished("rejected")),
    );
    await expect(client(fake.target, fake.fetchImplementation).run(request)).rejects.toMatchObject({
      kind,
      retryable: false,
    });
  });

  it("rejects an incomplete stream", async () => {
    const incomplete = fakeAuggy(() => sse(started()));
    await expect(client(incomplete.target, incomplete.fetchImplementation).run(request)).rejects.toBeInstanceOf(
      AuggyRunError,
    );
    await expect(client(incomplete.target, incomplete.fetchImplementation).run(request)).rejects.toMatchObject({
      kind: "incomplete-stream",
      retryable: true,
    });
  });

  it("bounds both SSE events and bytes before retaining response data", async () => {
    const tooManyEvents = fakeAuggy(() =>
      sse(
        started(),
        ...Array.from({ length: 7 }, (_, index) => ({
          type: "TEXT_MESSAGE_CONTENT",
          delta: String(index),
        })),
        finished(),
      ),
    );
    await expect(client(tooManyEvents.target, tooManyEvents.fetchImplementation).run(request)).rejects.toMatchObject({
      kind: "sse-limit",
      retryable: false,
    });

    const oversized = fakeAuggy(() =>
      new Response("x".repeat(2_049), { headers: { "content-type": "text/event-stream" } }),
    );
    await expect(client(oversized.target, oversized.fetchImplementation).run(request)).rejects.toMatchObject({
      kind: "sse-limit",
      retryable: false,
    });
  });

  it("enforces immutable client bounds for SSE and bearer credentials", () => {
    const fake = fakeAuggy(() => sse(started(), finished()));
    expect(() => client(fake.target, fake.fetchImplementation, { maxSseBytes: MAX_SSE_BYTES + 1 })).toThrow();
    expect(() => client(fake.target, fake.fetchImplementation, { maxSseEvents: MAX_SSE_EVENTS + 1 })).toThrow();
    expect(() =>
      client(fake.target, fake.fetchImplementation, {
        bearerToken: "x".repeat(MAX_BEARER_TOKEN_BYTES + 1),
      }),
    ).toThrow();
  });
});
