import { expect, test } from "bun:test";
import { createAgentOperation, runAgentOperation, type RunUpdate } from "../src/client/agent-run";

const encode = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
function fakeFetch(
  handler: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => handler(input, init),
    { preconnect: () => {} },
  ) as typeof fetch;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("content arrives before completion and credentials stay on their intended origins", async () => {
  const contentSeen = deferred();
  const finish = deferred();
  const operation = createAgentOperation("Read my order", "thread-one");
  const updates: RunUpdate[] = [];
  const calls: { input: string; init?: RequestInit }[] = [];
  const fetchImpl = fakeFetch(async (input, init) => {
    calls.push({ input: String(input), init });
    if (String(input).startsWith("/api/")) return Response.json({ assertion: "fresh-assertion" });
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(encode({ type: "TEXT_MESSAGE_CONTENT", delta: "Your order " }));
          await finish.promise;
          controller.enqueue(encode({ type: "TEXT_MESSAGE_CONTENT", delta: "has shipped." }));
          controller.enqueue(encode({ type: "RUN_FINISHED", result: { status: "completed" } }));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const running = runAgentOperation({
    agentOrigin: "https://agent.example",
    operation,
    fetch: fetchImpl,
    onUpdate(value) {
      updates.push(value);
      if (value.state === "streaming") contentSeen.resolve();
    },
  });
  await contentSeen.promise;
  expect(updates.at(-1)?.text).toBe("Your order ");
  expect(updates.some((value) => value.state === "completed")).toBe(false);
  finish.resolve();
  expect((await running).text).toBe("Your order has shipped.");
  expect(calls[0]!.input).toBe("/api/auggy-auth-assertion");
  expect(calls[0]!.init?.credentials).toBe("same-origin");
  expect(calls[1]!.input).toBe("https://agent.example/agent/run");
  expect(calls[1]!.init?.credentials).toBe("omit");
  expect(calls[1]!.init?.redirect).toBe("error");
  const headers = new Headers(calls[1]!.init?.headers);
  expect(headers.get("x-auggy-auth-assertion")).toBe("fresh-assertion");
  expect(headers.get("idempotency-key")).toBe(operation.key);
  expect(headers.get("cookie")).toBeNull();
  expect(headers.get("authorization")).toBeNull();
  expect(calls[1]!.input).not.toContain("assertion");
});

test("delivery retry gets a fresh assertion but preserves exact operation key and request body", async () => {
  const operation = createAgentOperation("Simulate my permitted refund", "thread-one");
  let assertions = 0;
  const requests: { headers: Headers; body: unknown }[] = [];
  const fetchImpl = fakeFetch((input, init) => {
    if (String(input).startsWith("/api/"))
      return Response.json({ assertion: `fresh-${++assertions}` });
    requests.push({ headers: new Headers(init?.headers), body: init?.body });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encode({
              type: requests.length === 1 ? "TEXT_MESSAGE_CONTENT" : "RUN_FINISHED",
              delta: "partial",
            }),
          );
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const options = {
    agentOrigin: "https://agent.example",
    operation,
    fetch: fetchImpl,
    onUpdate() {},
  };
  expect((await runAgentOperation(options)).state).toBe("interrupted");
  expect((await runAgentOperation(options)).state).toBe("completed");
  expect(requests[0]!.headers.get("idempotency-key")).toBe(
    requests[1]!.headers.get("idempotency-key"),
  );
  expect(requests[0]!.headers.get("x-auggy-auth-assertion")).not.toBe(
    requests[1]!.headers.get("x-auggy-auth-assertion"),
  );
  expect(requests[0]!.body).toBe(requests[1]!.body);
});

test("unknown effects require reconciliation and assertion failure never contacts the agent", async () => {
  for (const issueFailure of [false, true]) {
    let agentCalls = 0;
    const result = await runAgentOperation({
      agentOrigin: "https://agent.example",
      operation: createAgentOperation("hello", "thread"),
      onUpdate() {},
      fetch: fakeFetch((input) => {
        if (String(input).startsWith("/api/"))
          return issueFailure
            ? Response.json({ error: "unconfigured" }, { status: 503 })
            : Response.json({ assertion: "fresh" });
        agentCalls++;
        return Response.json({ error: "idempotency_outcome_unknown" }, { status: 409 });
      }),
    });
    expect(result.state).toBe("failed");
    expect(result.retryable).toBe(false);
    expect(agentCalls).toBe(issueFailure ? 0 : 1);
    if (!issueFailure) expect(result.code).toBe("outcome-unknown");
  }
});

test("component abort cancels the reader without claiming cancellation of the operation", async () => {
  const started = deferred();
  let canceled = false;
  const controller = new AbortController();
  const running = runAgentOperation({
    agentOrigin: "https://agent.example",
    operation: createAgentOperation("hello", "thread"),
    signal: controller.signal,
    onUpdate(value) {
      if (value.state === "streaming") started.resolve();
    },
    fetch: fakeFetch((input) =>
      String(input).startsWith("/api/")
        ? Response.json({ assertion: "fresh" })
        : new Response(
            new ReadableStream({
              start(stream) {
                stream.enqueue(encode({ type: "TEXT_MESSAGE_CONTENT", delta: "partial" }));
              },
              cancel() {
                canceled = true;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
    ),
  });
  await started.promise;
  controller.abort();
  const result = await running;
  expect(result.state).toBe("interrupted");
  expect(result.retryable).toBe(true);
  expect(canceled).toBe(true);
});

test("streamed failure and malformed events never appear completed or create automatic retries", async () => {
  for (const event of [
    { type: "RUN_ERROR", message: "private-diagnostic" },
    null,
    { type: "TEXT_MESSAGE_CONTENT", delta: 42 },
  ]) {
    let calls = 0;
    let canceled = false;
    const result = await runAgentOperation({
      agentOrigin: "https://agent.example",
      operation: createAgentOperation("hello", "thread"),
      onUpdate() {},
      fetch: fakeFetch((input) => {
        if (String(input).startsWith("/api/")) return Response.json({ assertion: "fresh" });
        calls++;
        return new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(encode(event));
            },
            cancel() {
              canceled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    });
    expect(result.state).toBe("failed");
    expect(result.retryable).toBe(false);
    expect(result.message).not.toContain("private-diagnostic");
    expect(calls).toBe(1);
    expect(canceled).toBe(true);
  }
});

test("HTTP authorization and oversized responses stop before consuming unbounded streams", async () => {
  for (const status of [401, 403, 500]) {
    const result = await runAgentOperation({
      agentOrigin: "https://agent.example",
      operation: createAgentOperation("hello", "thread"),
      onUpdate() {},
      fetch: fakeFetch((input) =>
        String(input).startsWith("/api/")
          ? Response.json({ assertion: "fresh" })
          : Response.json({ error: "private-server-message" }, { status }),
      ),
    });
    expect(result.state).toBe("failed");
    expect(result.retryable).toBe(status === 500);
    expect(result.message).not.toContain("private-server-message");
  }
  let canceled = false;
  const result = await runAgentOperation({
    agentOrigin: "https://agent.example",
    operation: createAgentOperation("hello", "thread"),
    onUpdate() {},
    fetch: fakeFetch((input) =>
      String(input).startsWith("/api/")
        ? Response.json({ assertion: "fresh" })
        : new Response(
            new ReadableStream({
              start(stream) {
                stream.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
              },
              cancel() {
                canceled = true;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
    ),
  });
  expect(result.code).toBe("invalid-stream");
  expect(canceled).toBe(true);
});
