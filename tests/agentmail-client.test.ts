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
  return {
    post: async (url: string, opts?: Omit<HttpRequestInit, "method">): Promise<HttpResponse> => {
      const body = typeof opts?.body === "string" ? JSON.parse(opts.body) : undefined;
      const result = handler(url, body, opts?.headers);
      const respHeaders = new Headers({
        "content-type": "application/json",
        ...(result.headers ?? {}),
      });
      return {
        finalUrl: url,
        status: result.status,
        statusText: result.status >= 200 && result.status < 300 ? "OK" : "Error",
        contentType: "application/json",
        headers: respHeaders,
        body: result.body,
      };
    },
  };
}

describe("createAgentMailClient", () => {
  test("posts to /inboxes/{id}/messages with bearer auth", async () => {
    let captured: any = null;
    let capturedAuth = "";
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: mockHttp((url, body, headers) => {
        captured = { url, body };
        capturedAuth = headers?.["authorization"] ?? "";
        return { status: 200, body: JSON.stringify({ message_id: "msg_1", thread_id: "thd_1" }) };
      }),
    });
    const r = await client.send({ inboxId: "inb_x", to: ["a@b.com"], subject: "s", text: "t" });
    expect(captured.url).toBe("https://api.agentmail.to/v0/inboxes/inb_x/messages");
    expect(capturedAuth).toBe("Bearer am_test");
    expect(captured.body.subject).toBe("s");
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
      },
    });
    const r = await client.send({ inboxId: "inb_x", to: ["a@b.com"], subject: "s", text: "t" });
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.detail).toContain("ECONNREFUSED");
  });
});
