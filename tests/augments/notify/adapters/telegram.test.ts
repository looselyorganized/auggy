import { describe, it, expect } from "bun:test";
import { createTelegramAdapter } from "../../../../src/augments/notify/adapters/telegram";
import type { TelegramNotifyDestination } from "../../../../src/types";
import type { TelegramBotClient as Tbc } from "../../../../src/telegram-client";

function mockClient(handler: (chatId: number | string, text: string) => Promise<{ messageId: number; chatId: number | string }>) {
  const c: Tbc = {
    sendMessage: async (chatId, text) => handler(chatId, text),
    getUpdates: async () => [],
    setWebhook: async () => {},
    deleteWebhook: async () => {},
    getChat: async (chatId) => ({ id: Number(chatId), type: "private" }),
  };
  return c;
}

const dest: TelegramNotifyDestination = {
  name: "creator",
  transport: "telegram",
  botToken: "T",
  chatId: 555,
};

describe("telegramAdapter", () => {
  it("calls sendMessage with chatId and formatted text", async () => {
    let captured: { chatId?: number | string; text?: string } = {};
    const client = mockClient(async (chatId, text) => {
      captured = { chatId, text };
      return { messageId: 1, chatId };
    });
    const adapter = createTelegramAdapter({ clientFactory: () => client });
    const result = await adapter.deliver(dest, { summary: "Important alert", reason: "test reason" });
    expect(captured.chatId).toBe(555);
    expect(captured.text).toContain("Important alert");
    expect(captured.text).toContain("test reason");
    expect(result.status).toBe("sent");
  });

  it("includes visitor in formatted text when provided", async () => {
    let text = "";
    const client = mockClient(async (c, t) => { text = t; return { messageId: 1, chatId: c }; });
    const adapter = createTelegramAdapter({ clientFactory: () => client });
    await adapter.deliver(dest, { summary: "x", visitor: "alice" });
    expect(text).toContain("alice");
  });

  it("returns failed when sendMessage throws", async () => {
    const client = mockClient(async () => { throw new Error("API error: chat not found"); });
    const adapter = createTelegramAdapter({ clientFactory: () => client });
    const result = await adapter.deliver(dest, { summary: "x" });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("chat not found");
  });

  it("caches client per botToken", async () => {
    let factoryCalls = 0;
    const adapter = createTelegramAdapter({
      clientFactory: () => {
        factoryCalls++;
        return mockClient(async (c) => ({ messageId: 1, chatId: c }));
      },
    });
    await adapter.deliver(dest, { summary: "1" });
    await adapter.deliver(dest, { summary: "2" });
    expect(factoryCalls).toBe(1);
  });

  it("creates separate clients for different botTokens", async () => {
    let tokens: string[] = [];
    const adapter = createTelegramAdapter({
      clientFactory: (token: string) => {
        tokens.push(token);
        return mockClient(async (c) => ({ messageId: 1, chatId: c }));
      },
    });
    await adapter.deliver(dest, { summary: "1" });
    await adapter.deliver({ ...dest, botToken: "OTHER" }, { summary: "2" });
    expect(tokens).toEqual(["T", "OTHER"]);
  });
});
