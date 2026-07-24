import { describe, it, expect } from "bun:test";
import { createTelegramAdapter } from "../../../../src/augments/notify/adapters/telegram";
import type { TelegramNotifyDestination } from "../../../../src/types";
import type { TelegramBotClient as Tbc } from "../../../../src/telegram-client";
import { OutcomeUnknownError } from "../../../../src/outcome-unknown";

function mockClient(handler: Tbc["sendMessage"]) {
  const c: Tbc = {
    sendMessage: async (chatId, text, opts) => handler(chatId, text, opts),
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
    const result = await adapter.deliver(dest, {
      summary: "Important alert",
      reason: "test reason",
    });
    expect(captured.chatId).toBe(555);
    expect(captured.text).toContain("Important alert");
    expect(captured.text).toContain("test reason");
    expect(result.status).toBe("sent");
  });

  it("includes visitor in formatted text when provided", async () => {
    let text = "";
    const client = mockClient(async (c, t) => {
      text = t;
      return { messageId: 1, chatId: c };
    });
    const adapter = createTelegramAdapter({ clientFactory: () => client });
    await adapter.deliver(dest, { summary: "x", visitor: "alice" });
    expect(text).toContain("alice");
  });

  it("passes the delivery cancellation signal to Telegram", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const client = mockClient(async (chatId, _text, opts) => {
      capturedSignal = opts?.signal;
      return { messageId: 1, chatId };
    });
    const adapter = createTelegramAdapter({ clientFactory: () => client });

    await adapter.deliver(dest, { summary: "x" }, { signal: controller.signal });
    expect(capturedSignal).toBe(controller.signal);
  });

  it("classifies a generic sendMessage throw after dispatch as outcome unknown", async () => {
    const client = mockClient(async () => {
      throw new Error("API error echoed telegram-secret-sentinel");
    });
    const adapter = createTelegramAdapter({ clientFactory: () => client });
    const error = await adapter.deliver(dest, { summary: "x" }).catch((caught) => caught);
    expect(error).toMatchObject({ outcomeUnknown: true });
    expect(Bun.inspect(error)).not.toContain("telegram-secret-sentinel");
    expect((error as Error).cause).toBeUndefined();
  });

  it("preserves an outcome-unknown Telegram failure for the kernel", async () => {
    const client = mockClient(async () => {
      throw new OutcomeUnknownError("request deadline elapsed after dispatch");
    });
    const adapter = createTelegramAdapter({ clientFactory: () => client });

    expect(adapter.deliver(dest, { summary: "x" })).rejects.toMatchObject({
      outcomeUnknown: true,
    });
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
    const tokens: string[] = [];
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
