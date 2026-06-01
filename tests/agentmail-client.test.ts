import { describe, test, expect } from "bun:test";
import { createAgentMailClient } from "../src/agentmail-client";
import type { HttpResponse, HttpRequestInit } from "../src/http";

function mockHttp(
  handler: (
    url: string,
    body: unknown,
    headers?: Record<string, string>,
  ) => { status: number; body: string; headers?: Record<string, string> },
) {
  function makeResponse(
    url: string,
    status: number,
    body: string,
    extraHeaders?: Record<string, string>,
  ): HttpResponse {
    const respHeaders = new Headers({
      "content-type": "application/json",
      ...(extraHeaders ?? {}),
    });
    return {
      finalUrl: url,
      status,
      statusText: status >= 200 && status < 300 ? "OK" : "Error",
      contentType: "application/json",
      headers: respHeaders,
      body,
    };
  }
  return {
    post: async (url: string, opts?: Omit<HttpRequestInit, "method">): Promise<HttpResponse> => {
      const body = typeof opts?.body === "string" ? JSON.parse(opts.body) : undefined;
      const result = handler(url, body, opts?.headers);
      return makeResponse(url, result.status, result.body, result.headers);
    },
    get: async (url: string, opts?: Omit<HttpRequestInit, "method">): Promise<HttpResponse> => {
      const result = handler(url, undefined, opts?.headers as Record<string, string> | undefined);
      return makeResponse(url, result.status, result.body, result.headers);
    },
  };
}

describe("createAgentMailClient", () => {
  test("posts to /inboxes/{id}/messages with bearer auth", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    let capturedAuth = "";
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: mockHttp((url, body, headers) => {
        captured = { url, body: body as Record<string, unknown> };
        capturedAuth = headers?.authorization ?? "";
        return { status: 200, body: JSON.stringify({ message_id: "msg_1", thread_id: "thd_1" }) };
      }),
    });
    const r = await client.send({ inboxId: "inb_x", to: ["a@b.com"], subject: "s", text: "t" });
    const sent = captured as unknown as { url: string; body: Record<string, unknown> };
    expect(sent.url).toBe("https://api.agentmail.to/v0/inboxes/inb_x/messages");
    expect(capturedAuth).toBe("Bearer am_test");
    expect(sent.body.subject).toBe("s");
    expect(r.status).toBe("sent");
    if (r.status === "sent") {
      expect(r.messageId).toBe("msg_1");
      expect(r.threadId).toBe("thd_1");
    }
  });

  test("surfaces 429 with retry-after seconds", async () => {
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: mockHttp(() => ({
        status: 429,
        body: JSON.stringify({ error: "rate limited" }),
        headers: { "retry-after": "60" },
      })),
    });
    const r = await client.send({ inboxId: "inb_x", to: ["a@b.com"], subject: "s", text: "t" });
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.httpStatus).toBe(429);
      expect(r.retryAfterSec).toBe(60);
    }
  });

  test("returns failed on network throw", async () => {
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: {
        post: async () => {
          throw new Error("ECONNREFUSED");
        },
        get: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
    });
    const r = await client.send({ inboxId: "inb_x", to: ["a@b.com"], subject: "s", text: "t" });
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.detail).toContain("ECONNREFUSED");
  });
});

describe("createAgentMailClient.getInbox", () => {
  test("returns ok when inbox exists (2xx)", async () => {
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: mockHttp((url, _body, headers) => {
        expect(url).toBe("https://api.agentmail.to/v0/inboxes/inb_x");
        expect(headers?.authorization).toBe("Bearer am_test");
        return { status: 200, body: JSON.stringify({ inbox_id: "inb_x" }) };
      }),
    });
    const r = await client.getInbox("inb_x");
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.inboxId).toBe("inb_x");
  });

  test("returns failed with httpStatus on non-2xx", async () => {
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: mockHttp(() => ({ status: 404, body: JSON.stringify({ error: "not found" }) })),
    });
    const r = await client.getInbox("inb_missing");
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.httpStatus).toBe(404);
      expect(r.detail).toContain("404");
    }
  });

  test("returns failed on network throw", async () => {
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: {
        post: async () => {
          throw new Error("ECONNREFUSED");
        },
        get: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
    });
    const r = await client.getInbox("inb_x");
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.detail).toContain("ECONNREFUSED");
  });
});
