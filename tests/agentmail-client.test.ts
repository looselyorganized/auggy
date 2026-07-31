import { describe, test, expect } from "bun:test";
import { createAgentMailClient } from "../src/agentmail-client";
import type { HttpResponse, HttpRequestInit } from "../src/http";
import { OutcomeUnknownError } from "../src/outcome-unknown";

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
  test("rejects credentials over non-loopback plaintext HTTP before dispatch", () => {
    for (const apiBaseUrl of [
      "http://provider.example.test/v0",
      "http://127.evil.example.com/v0",
    ]) {
      expect(() =>
        createAgentMailClient({
          apiKey: "GROUP9_AGENTMAIL_SENTINEL",
          apiBaseUrl,
          http: mockHttp(() => ({ status: 200, body: "{}" })),
        }),
      ).toThrow(/plaintext HTTP/);
    }
  });

  test("rejects non-string credentials before dispatch", () => {
    expect(() =>
      createAgentMailClient({
        apiKey: 123 as unknown as string,
        apiBaseUrl: "https://provider.example.test/v0",
        http: mockHttp(() => ({ status: 200, body: "{}" })),
      }),
    ).toThrow("AgentMail credential must be a string");
  });

  test("passes the send cancellation signal to the HTTP client", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: {
        post: async (url, opts) => {
          capturedSignal = opts?.signal;
          return {
            finalUrl: url,
            status: 200,
            statusText: "OK",
            contentType: "application/json",
            headers: new Headers(),
            body: JSON.stringify({ message_id: "msg_1", thread_id: "thd_1" }),
          };
        },
        get: async () => {
          throw new Error("unused");
        },
      },
    });

    await client.send({
      inboxId: "inb_x",
      to: ["a@b.com"],
      subject: "s",
      text: "t",
      signal: controller.signal,
    });
    expect(capturedSignal).toBe(controller.signal);
  });

  test("posts to /inboxes/{id}/messages/send with bearer auth", async () => {
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
    const r = await client.send({
      inboxId: "inb_x",
      to: ["a@b.com"],
      subject: "s",
      text: "t",
      html: "<p>t</p>",
    });
    const sent = captured as unknown as { url: string; body: Record<string, unknown> };
    expect(sent.url).toBe("https://api.agentmail.to/v0/inboxes/inb_x/messages/send");
    expect(capturedAuth).toBe("Bearer am_test");
    expect(sent.body.subject).toBe("s");
    expect(sent.body.html).toBe("<p>t</p>");
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

  test("never exposes a definitive provider error body", async () => {
    const sentinel = "GROUP9_AGENTMAIL_PROVIDER_BODY_SENTINEL";
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: mockHttp(() => ({ status: 400, body: `rejected ${sentinel}` })),
    });
    const result = await client.send({
      inboxId: "inb_x",
      to: ["a@b.com"],
      subject: "s",
      text: "t",
    });
    expect(result).toEqual({
      status: "failed",
      detail: "agentmail returned HTTP 400",
      httpStatus: 400,
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  test("classifies a network throw after send dispatch as outcome unknown", async () => {
    const sentinel = "GROUP9_AGENTMAIL_SEND_THROW_SENTINEL";
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: {
        post: async () => {
          throw new Error(sentinel);
        },
        get: async () => {
          throw new Error(sentinel);
        },
      },
    });
    try {
      await client.send({ inboxId: "inb_x", to: ["a@b.com"], subject: "s", text: "t" });
      throw new Error("expected send to fail");
    } catch (error) {
      expect(error).toMatchObject({ outcomeUnknown: true });
      expect(Bun.inspect(error)).not.toContain(sentinel);
    }
  });

  test("classifies an unreadable successful send response as outcome unknown", async () => {
    const sentinel = "GROUP9_AGENTMAIL_MALFORMED_BODY_SENTINEL";
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: mockHttp(() => ({ status: 200, body: `{${sentinel}` })),
    });

    try {
      await client.send({ inboxId: "inb_x", to: ["a@b.com"], subject: "s", text: "t" });
      throw new Error("expected send to fail");
    } catch (error) {
      expect(error).toMatchObject({ outcomeUnknown: true });
      expect(Bun.inspect(error)).not.toContain(sentinel);
    }
  });

  test("accepts provider message and thread IDs at the 256-character boundary", async () => {
    const messageId = "m".repeat(256);
    const threadId = "t".repeat(256);
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: mockHttp(() => ({
        status: 200,
        body: JSON.stringify({ message_id: messageId, thread_id: threadId }),
      })),
    });

    await expect(
      client.send({ inboxId: "inb_x", to: ["a@b.com"], subject: "s", text: "t" }),
    ).resolves.toEqual({ status: "sent", messageId, threadId });
  });

  test("classifies empty or oversized provider IDs after a successful send as outcome unknown", async () => {
    const invalidIdentities = [
      { message_id: "", thread_id: "thread_1" },
      { message_id: "message_1", thread_id: "" },
      { message_id: "m".repeat(257), thread_id: "thread_1" },
      { message_id: "message_1", thread_id: "t".repeat(257) },
    ];

    for (const identity of invalidIdentities) {
      const client = createAgentMailClient({
        apiKey: "am_test",
        http: mockHttp(() => ({ status: 200, body: JSON.stringify(identity) })),
      });

      await expect(
        client.send({ inboxId: "inb_x", to: ["a@b.com"], subject: "s", text: "t" }),
      ).rejects.toMatchObject({ outcomeUnknown: true });
    }
  });

  test("preserves an outcome-unknown HTTP failure", async () => {
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: {
        post: async () => {
          throw new OutcomeUnknownError("request deadline elapsed after dispatch");
        },
        get: async () => {
          throw new Error("unused");
        },
      },
    });

    await expect(
      client.send({ inboxId: "inb_x", to: ["a@b.com"], subject: "s", text: "t" }),
    ).rejects.toMatchObject({ outcomeUnknown: true });
  });

  test("classifies a provider 5xx after send dispatch as outcome unknown", async () => {
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: mockHttp(() => ({ status: 503, body: "unavailable" })),
    });

    await expect(
      client.send({ inboxId: "inb_x", to: ["a@b.com"], subject: "s", text: "t" }),
    ).rejects.toMatchObject({ outcomeUnknown: true });
  });

  test("rejects send requests with no recipients before hitting AgentMail", async () => {
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: {
        post: async () => {
          throw new Error("should not post");
        },
        get: async () => {
          throw new Error("should not get");
        },
      },
    });
    const r = await client.send({ inboxId: "inb_x", to: [], subject: "s", text: "t" });
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.detail).toMatch(/at least one recipient/);
  });

  test("rejects send requests over AgentMail's 50-recipient cap before hitting AgentMail", async () => {
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: {
        post: async () => {
          throw new Error("should not post");
        },
        get: async () => {
          throw new Error("should not get");
        },
      },
    });
    const r = await client.send({
      inboxId: "inb_x",
      to: Array.from({ length: 51 }, (_, i) => `user${i}@example.com`),
      subject: "s",
      text: "t",
    });
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.detail).toMatch(/50 recipients/);
  });
});

describe("createAgentMailClient.getInbox", () => {
  test("returns canonical inbox identity when inbox exists (2xx)", async () => {
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: mockHttp((url, _body, headers) => {
        expect(url).toBe("https://api.agentmail.to/v0/inboxes/inb_x");
        expect(headers?.authorization).toBe("Bearer am_test");
        return {
          status: 200,
          body: JSON.stringify({
            inbox_id: "inb_x",
            email: "support@example.com",
            display_name: "Support",
          }),
        };
      }),
    });
    const r = await client.getInbox("inb_x");
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.inboxId).toBe("inb_x");
      expect(r.email).toBe("support@example.com");
      expect(r.displayName).toBe("Support");
    }
  });

  test("accepts an omitted display name", async () => {
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: mockHttp(() => ({
        status: 200,
        body: JSON.stringify({ inbox_id: "inb_x", email: "support@example.com" }),
      })),
    });
    const r = await client.getInbox("inb_x");
    expect(r).toEqual({
      status: "ok",
      inboxId: "inb_x",
      email: "support@example.com",
    });
  });

  test("fails closed when the provider returns a different inbox identity", async () => {
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: mockHttp(() => ({
        status: 200,
        body: JSON.stringify({ inbox_id: "inb_other", email: "other@example.com" }),
      })),
    });
    await expect(client.getInbox("inb_x")).resolves.toEqual({
      status: "failed",
      detail: "agentmail returned an invalid inbox response",
      httpStatus: 200,
      failureKind: "invalid-response",
    });
  });

  test("fails closed on malformed successful inbox responses", async () => {
    const responses = [
      "not-json",
      JSON.stringify({ inbox_id: "inb_x" }),
      JSON.stringify({ inbox_id: "inb_x", email: "not-an-email" }),
      JSON.stringify({ inbox_id: "inb_x", email: "support@example.com", display_name: 42 }),
    ];
    for (const body of responses) {
      const client = createAgentMailClient({
        apiKey: "am_test",
        http: mockHttp(() => ({ status: 200, body })),
      });
      await expect(client.getInbox("inb_x")).resolves.toEqual({
        status: "failed",
        detail: "agentmail returned an invalid inbox response",
        httpStatus: 200,
        failureKind: "invalid-response",
      });
    }
  });

  test("returns failed with httpStatus on non-2xx", async () => {
    const sentinel = "GROUP9_AGENTMAIL_INBOX_BODY_SENTINEL";
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: mockHttp(() => ({ status: 404, body: JSON.stringify({ error: sentinel }) })),
    });
    const r = await client.getInbox("inb_missing");
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.httpStatus).toBe(404);
      expect(r.failureKind).toBe("provider");
      expect(r.detail).toContain("404");
      expect(r.detail).not.toContain(sentinel);
    }
  });

  test("returns failed on network throw", async () => {
    const sentinel = "GROUP9_AGENTMAIL_NETWORK_SENTINEL";
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: {
        post: async () => {
          throw new Error(sentinel);
        },
        get: async () => {
          throw new Error(sentinel);
        },
      },
    });
    const r = await client.getInbox("inb_x");
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.detail).toBe("agentmail request failed");
      expect(r.failureKind).toBe("network");
      expect(r.detail).not.toContain(sentinel);
    }
  });
});
