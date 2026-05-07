import { describe, it, expect } from "bun:test";
import { createAgentMailAdapter } from "../../../../src/augments/notify/adapters/agentmail";
import type { AgentMailNotifyDestination } from "../../../../src/types";
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
        statusText: result.status >= 200 && result.status < 300 ? "OK" : "Error",
        contentType: "application/json",
        headers: new Headers({ "content-type": "application/json" }),
        body: result.body,
      };
    },
  };
}

const dest: AgentMailNotifyDestination = {
  name: "creator-mail",
  transport: "agentmail",
  apiKey: "am_test_key",
  inboxId: "inb_test123",
  to: "operator@example.com",
};

describe("agentMailAdapter", () => {
  it("POSTs to /inboxes/{inboxId}/messages with bearer auth and structured body", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;
    let capturedAuth = "";
    const adapter = createAgentMailAdapter({
      client: mockHttp((url, body, headers) => {
        capturedUrl = url;
        capturedBody = body;
        capturedAuth = headers?.["authorization"] ?? "";
        return { status: 200, body: JSON.stringify({ message_id: "msg_1", thread_id: "thd_1" }) };
      }),
    });
    const result = await adapter.deliver(dest, {
      summary: "Visitor wants to talk",
      reason: "Outside scope",
      visitor: "Sarah",
    });
    expect(capturedUrl).toBe("https://api.agentmail.to/v0/inboxes/inb_test123/messages");
    expect(capturedAuth).toBe("Bearer am_test_key");
    expect(capturedBody.to).toEqual(["operator@example.com"]);
    expect(capturedBody.subject).toBe("Visitor wants to talk");
    expect(typeof capturedBody.text).toBe("string");
    expect(capturedBody.text).toContain("Visitor wants to talk");
    expect(capturedBody.text).toContain("Outside scope");
    expect(capturedBody.text).toContain("Sarah");
    expect(result.status).toBe("sent");
  });
});
