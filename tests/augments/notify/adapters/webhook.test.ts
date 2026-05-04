import { describe, it, expect } from "bun:test";
import { createWebhookAdapter } from "../../../../src/augments/notify/adapters/webhook";
import type { WebhookNotifyDestination } from "../../../../src/types";
import type { HttpResponse, HttpRequestInit } from "../../../../src/http";

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
  it("POSTs JSON payload to configured URL", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;
    const adapter = createWebhookAdapter({
      client: mockHttp((url, body) => {
        capturedUrl = url;
        capturedBody = body;
        return { status: 200, body: JSON.stringify({ status: "sent" }) };
      }),
    });
    const result = await adapter.deliver(dest, { summary: "test alert", reason: "test" });
    expect(capturedUrl).toBe("https://example.com/notify");
    expect(capturedBody).toEqual({ summary: "test alert", reason: "test", channel: "notify" });
    expect(result.status).toBe("sent");
  });

  it("includes optional visitor field when provided", async () => {
    let body: any;
    const adapter = createWebhookAdapter({
      client: mockHttp((_u, b) => {
        body = b;
        return { status: 200, body: "{}" };
      }),
    });
    await adapter.deliver(dest, { summary: "x", visitor: "v1" });
    expect(body.visitor).toBe("v1");
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

  it("4xx surfaces as failed result", async () => {
    const adapter = createWebhookAdapter({
      client: mockHttp(() => ({ status: 400, body: JSON.stringify({ error: "bad" }) })),
    });
    const result = await adapter.deliver(dest, { summary: "x" });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("400");
  });

  it("5xx surfaces as failed result", async () => {
    const adapter = createWebhookAdapter({
      client: mockHttp(() => ({ status: 503, body: "unavailable" })),
    });
    const result = await adapter.deliver(dest, { summary: "x" });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("503");
  });
});
