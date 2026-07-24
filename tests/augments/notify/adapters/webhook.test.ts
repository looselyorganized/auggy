import { describe, it, expect } from "bun:test";
import { createWebhookAdapter } from "../../../../src/augments/notify/adapters/webhook";
import type { WebhookNotifyDestination } from "../../../../src/types";
import type { HttpResponse, HttpRequestInit } from "../../../../src/http";
import { OutcomeUnknownError } from "../../../../src/outcome-unknown";

function mockHttp(
  handler: (
    url: string,
    body: unknown,
    headers?: Record<string, string>,
  ) => { status: number; body: string },
) {
  return {
    post: async (url: string, opts?: Omit<HttpRequestInit, "method">): Promise<HttpResponse> => {
      const body = typeof opts?.body === "string" ? JSON.parse(opts.body) : undefined;
      const result = handler(url, body, opts?.headers);
      return {
        finalUrl: url,
        status: result.status,
        statusText: result.status === 200 ? "OK" : "Error",
        contentType: "application/json",
        headers: new Headers({ "content-type": "application/json" }),
        body: result.body,
      };
    },
  };
}

const dest: WebhookNotifyDestination = {
  name: "test",
  transport: "webhook",
  url: "https://example.com/notify",
};

describe("webhookAdapter", () => {
  it("never follows redirects with the webhook body", async () => {
    let targetReceived = false;
    const target = Bun.serve({
      port: 0,
      fetch() {
        targetReceived = true;
        return new Response("unexpected");
      },
    });
    const redirector = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, {
          status: 307,
          headers: { location: `http://127.0.0.1:${target.port}/collect` },
        });
      },
    });
    try {
      const adapter = createWebhookAdapter();
      await expect(
        adapter.deliver(
          {
            ...dest,
            url: `http://127.0.0.1:${redirector.port}/notify`,
            headers: { authorization: "Bearer GROUP9_WEBHOOK_REDIRECT_SENTINEL" },
          },
          { summary: "GROUP9_WEBHOOK_BODY_SENTINEL" },
        ),
      ).rejects.toMatchObject({ outcomeUnknown: true });
      expect(targetReceived).toBe(false);
    } finally {
      redirector.stop(true);
      target.stop(true);
    }
  });

  it("POSTs JSON payload to configured URL", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | null = null;
    const adapter = createWebhookAdapter({
      client: mockHttp((url, body) => {
        capturedUrl = url;
        capturedBody = body as Record<string, unknown>;
        return { status: 200, body: JSON.stringify({ status: "sent" }) };
      }),
    });
    const result = await adapter.deliver(dest, { summary: "test alert", reason: "test" });
    expect(capturedUrl).toBe("https://example.com/notify");
    expect(capturedBody as unknown).toEqual({
      summary: "test alert",
      reason: "test",
      channel: "notify",
    });
    expect(result.status).toBe("sent");
  });

  it("includes optional visitor field when provided", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = createWebhookAdapter({
      client: mockHttp((_u, b) => {
        body = b as Record<string, unknown>;
        return { status: 200, body: "{}" };
      }),
    });
    await adapter.deliver(dest, { summary: "x", visitor: "v1" });
    expect((body as Record<string, unknown>).visitor).toBe("v1");
  });

  it("forwards configured headers", async () => {
    const destWithHeaders: WebhookNotifyDestination = {
      ...dest,
      headers: { authorization: "Bearer T" },
    };
    let capturedHeaders: Record<string, string> | undefined;
    const adapter = createWebhookAdapter({
      client: mockHttp((_u, _b, h) => {
        capturedHeaders = h;
        return { status: 200, body: "{}" };
      }),
    });
    await adapter.deliver(destWithHeaders, { summary: "x" });
    expect(capturedHeaders?.authorization).toBe("Bearer T");
  });

  it("rejects non-loopback plaintext webhook delivery before dispatch", async () => {
    let dispatched = false;
    const adapter = createWebhookAdapter({
      client: mockHttp(() => {
        dispatched = true;
        return { status: 200, body: "{}" };
      }),
    });
    const result = await adapter.deliver(
      {
        ...dest,
        url: "http://127.evil.example.com/notify?token=GROUP9_WEBHOOK_SENTINEL",
        headers: { authorization: "Bearer GROUP9_HEADER_SENTINEL" },
      },
      { summary: "x" },
    );
    expect(dispatched).toBe(false);
    expect(result).toEqual({
      status: "failed",
      detail: "webhook destination failed secure transport validation",
    });
    expect(JSON.stringify(result)).not.toContain("GROUP9");
  });

  it("passes the delivery cancellation signal to HTTP", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const adapter = createWebhookAdapter({
      client: {
        post: async (url, opts) => {
          capturedSignal = opts?.signal;
          return {
            finalUrl: url,
            status: 200,
            statusText: "OK",
            contentType: "application/json",
            headers: new Headers(),
            body: "{}",
          };
        },
      },
    });

    await adapter.deliver(dest, { summary: "x" }, { signal: controller.signal });
    expect(capturedSignal).toBe(controller.signal);
  });

  it("4xx surfaces as failed result", async () => {
    const adapter = createWebhookAdapter({
      client: mockHttp(() => ({ status: 400, body: JSON.stringify({ error: "bad" }) })),
    });
    const result = await adapter.deliver(dest, { summary: "x" });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("400");
    expect(result.detail).not.toContain("example.com");
  });

  it("redacts URL credentials and internal errors from failures", async () => {
    const sentinelUrl = "https://example.com/GROUP9_PATH?token=GROUP9_QUERY";
    const adapter = createWebhookAdapter({
      client: {
        post: async () => {
          throw new Error(`failed to reach ${sentinelUrl}`);
        },
      },
    });
    const result = await adapter.deliver({ ...dest, url: sentinelUrl }, { summary: "x" });
    expect(result).toEqual({ status: "failed", detail: "webhook delivery failed" });
    expect(JSON.stringify(result)).not.toContain("GROUP9");
  });

  it("classifies 5xx after webhook dispatch as outcome unknown", async () => {
    const adapter = createWebhookAdapter({
      client: mockHttp(() => ({ status: 503, body: "unavailable" })),
    });
    await expect(adapter.deliver(dest, { summary: "x" })).rejects.toMatchObject({
      outcomeUnknown: true,
    });
  });

  it("preserves an outcome-unknown HTTP failure for the kernel", async () => {
    const adapter = createWebhookAdapter({
      client: {
        post: async () => {
          throw new OutcomeUnknownError("request deadline elapsed after dispatch");
        },
      },
    });

    expect(adapter.deliver(dest, { summary: "x" })).rejects.toMatchObject({
      outcomeUnknown: true,
    });
  });
});
