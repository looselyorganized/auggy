import { describe, it, expect } from "bun:test";
import { createAgentMailAdapter } from "../../../../src/augments/notify/adapters/agentmail";
import type { AgentMailNotifyDestination } from "../../../../src/types";
import type { SendMessageInput, SendMessageResult, SendMessageError } from "../../../../src/agentmail-client";

function mockClient(
  handler: (input: SendMessageInput) => SendMessageResult | SendMessageError,
) {
  return (_apiKey: string, _baseUrl?: string) => ({
    send: async (input: SendMessageInput) => handler(input),
  });
}

const dest: AgentMailNotifyDestination = {
  name: "creator-mail",
  transport: "agentmail",
  apiKey: "am_test_key",
  inboxId: "inb_test123",
  to: "operator@example.com",
};

describe("agentMailAdapter", () => {
  it("delegates to AgentMail client and returns sent on success", async () => {
    let captured: SendMessageInput | null = null;
    let capturedApiKey = "";
    const adapter = createAgentMailAdapter({
      clientFactory: (apiKey, _baseUrl) => {
        capturedApiKey = apiKey;
        return {
          send: async (input) => {
            captured = input;
            return { status: "sent", messageId: "msg_1", threadId: "thd_1" };
          },
        };
      },
    });
    const result = await adapter.deliver(dest, {
      summary: "Visitor wants to talk",
      reason: "Outside scope",
      visitor: "Sarah",
    });
    expect(capturedApiKey).toBe("am_test_key");
    expect(captured!.inboxId).toBe("inb_test123");
    expect(captured!.to).toEqual(["operator@example.com"]);
    expect(captured!.subject).toBe("Visitor wants to talk");
    expect(typeof captured!.text).toBe("string");
    expect(captured!.text).toContain("Visitor wants to talk");
    expect(captured!.text).toContain("Outside scope");
    expect(captured!.text).toContain("Sarah");
    expect(result.status).toBe("sent");
  });

  it("applies subjectPrefix when configured", async () => {
    let captured: SendMessageInput | null = null;
    const adapter = createAgentMailAdapter({
      clientFactory: mockClient((input) => {
        captured = input;
        return { status: "sent", messageId: "m1", threadId: "t1" };
      }),
    });
    await adapter.deliver(
      { ...dest, subjectPrefix: "[Auggy] " },
      { summary: "Daily digest" },
    );
    expect(captured!.subject).toBe("[Auggy] Daily digest");
  });

  it("normalizes string `to` to single-element array; passes array through", async () => {
    let captured: SendMessageInput | null = null;
    const adapter = createAgentMailAdapter({
      clientFactory: mockClient((input) => {
        captured = input;
        return { status: "sent", messageId: "m1", threadId: "t1" };
      }),
    });
    await adapter.deliver(dest, { summary: "x" });
    expect(captured!.to).toEqual(["operator@example.com"]);

    await adapter.deliver(
      { ...dest, to: ["a@example.com", "b@example.com"] },
      { summary: "x" },
    );
    expect(captured!.to).toEqual(["a@example.com", "b@example.com"]);
  });

  it("returns failed with detail on 4xx", async () => {
    const adapter = createAgentMailAdapter({
      clientFactory: mockClient(() => ({
        status: "failed",
        detail: "agentmail returned 401: {\"error\":\"invalid api key\"}",
        httpStatus: 401,
      })),
    });
    const result = await adapter.deliver(dest, { summary: "x" });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("401");
    expect(result.detail).toContain("invalid api key");
  });

  it("returns failed with detail on 5xx", async () => {
    const adapter = createAgentMailAdapter({
      clientFactory: mockClient(() => ({
        status: "failed",
        detail: "agentmail returned 503: Service Unavailable",
        httpStatus: 503,
      })),
    });
    const result = await adapter.deliver(dest, { summary: "x" });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("503");
  });

  it("returns failed when the client throws (network error)", async () => {
    const adapter = createAgentMailAdapter({
      clientFactory: (_apiKey, _baseUrl) => ({
        send: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    });
    const result = await adapter.deliver(dest, { summary: "x" });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("ECONNREFUSED");
  });

  it("rejects non-agentmail destinations without calling client", async () => {
    let called = false;
    const adapter = createAgentMailAdapter({
      clientFactory: (_apiKey, _baseUrl) => ({
        send: async () => {
          called = true;
          throw new Error("should not be called");
        },
      }),
    });
    const result = await adapter.deliver(
      { name: "wrong", transport: "webhook", url: "https://x" },
      { summary: "x" },
    );
    expect(called).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("non-agentmail destination");
  });
});
