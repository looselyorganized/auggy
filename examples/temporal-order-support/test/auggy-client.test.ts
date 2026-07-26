import { describe, expect, it } from "bun:test";

import { AuggyRunError, createAuggyRunClient, type FetchImplementation } from "../src/auggy-client.ts";

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

function client(target: string, fetchImplementation: FetchImplementation) {
  return createAuggyRunClient({
    target,
    bearerToken: "test-only-secret",
    maxSseBytes: 256,
    maxSseEvents: 4,
    allowInsecureLocalhost: true,
    fetchImplementation,
  });
}

describe("Auggy Temporal Activity HTTP client", () => {
  it("sends authenticated requests with the caller's stable idempotency key and accepts RUN_FINISHED", async () => {
    const fake = fakeAuggy(() =>
      new Response(
        [
          'data: {"type":"RUN_STARTED","runId":"run_123"}\n\n',
          'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"approved"}\n\n',
          'data: {"type":"RUN_FINISHED"}\n\n',
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );

    const result = await client(fake.target, fake.fetchImplementation).run({
      idempotencyKey: "refund-order-42",
      threadId: "temporal-order-42",
      message: "Review order 42",
    });

    expect(result).toEqual({ runId: "run_123", text: "approved" });
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0]!;
    expect(request.url).toBe(`${fake.target}/agent/run`);
    expect(request.headers.get("authorization")).toBe("Bearer test-only-secret");
    expect(request.headers.get("idempotency-key")).toBe("refund-order-42");
    expect(await request.json()).toEqual({
      messages: [{ role: "user", content: "Review order 42" }],
      threadId: "temporal-order-42",
    });
  });

  it.each([
    [409, "idempotency_key_conflict", "binding-conflict", false],
    [409, "idempotency_outcome_unknown", "outcome-unknown", false],
    [503, "unavailable", "admission-failed", true],
    [401, "unauthorized", "rejected", false],
  ])("maps HTTP %i %s conservatively", async (status, body, kind, retryable) => {
    const fake = fakeAuggy(() => new Response(JSON.stringify({ error: body }), { status }));

    await expect(
      client(fake.target, fake.fetchImplementation).run({
        idempotencyKey: "same-key",
        threadId: "thread",
        message: "message",
      }),
    ).rejects.toMatchObject({ kind, retryable });
  });

  it("maps RUN_ERROR admission failures as retryable and rejects a stream without a terminal event", async () => {
    const admission = fakeAuggy(
      () =>
        new Response('data: {"type":"RUN_ERROR","code":"ADMISSION_FAILED"}\n\ndata: {"type":"RUN_FINISHED"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    await expect(
      client(admission.target, admission.fetchImplementation).run({ idempotencyKey: "same-key", threadId: "thread", message: "message" }),
    ).rejects.toMatchObject({ kind: "admission-failed", retryable: true });

    const incomplete = fakeAuggy(
      () => new Response('data: {"type":"RUN_STARTED","runId":"run_123"}\n\n', { headers: { "content-type": "text/event-stream" } }),
    );
    await expect(
      client(incomplete.target, incomplete.fetchImplementation).run({ idempotencyKey: "same-key", threadId: "thread", message: "message" }),
    ).rejects.toBeInstanceOf(AuggyRunError);
    await expect(
      client(incomplete.target, incomplete.fetchImplementation).run({ idempotencyKey: "same-key", threadId: "thread", message: "message" }),
    ).rejects.toMatchObject({ kind: "incomplete-stream", retryable: true });
  });

  it("bounds both SSE events and bytes before retaining response data", async () => {
    const tooManyEvents = fakeAuggy(
      () =>
        new Response(
          'data: {"type":"RUN_STARTED"}\n\ndata: {"type":"TEXT_MESSAGE_CONTENT","delta":"a"}\n\ndata: {"type":"TEXT_MESSAGE_CONTENT","delta":"b"}\n\ndata: {"type":"TEXT_MESSAGE_CONTENT","delta":"c"}\n\ndata: {"type":"RUN_FINISHED"}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    await expect(
      client(tooManyEvents.target, tooManyEvents.fetchImplementation).run({ idempotencyKey: "same-key", threadId: "thread", message: "message" }),
    ).rejects.toMatchObject({ kind: "sse-limit", retryable: false });

    const oversized = fakeAuggy(
      () => new Response("x".repeat(257), { headers: { "content-type": "text/event-stream" } }),
    );
    await expect(
      client(oversized.target, oversized.fetchImplementation).run({ idempotencyKey: "same-key", threadId: "thread", message: "message" }),
    ).rejects.toMatchObject({ kind: "sse-limit", retryable: false });
  });
});
