import { describe, it, expect } from "bun:test";
import type { HttpClient, HttpResponse } from "../src/http";
import { createTelegramBotClient } from "../src/telegram-client";

function mockHttp(
  handler: (method: string, url: string, body?: unknown) => { status: number; body: string },
): Pick<HttpClient, "post"> {
  return {
    post: async (url, opts) => {
      const result = handler("POST", url, opts?.body ? JSON.parse(opts.body as string) : undefined);
      const response: HttpResponse = {
        finalUrl: url,
        status: result.status,
        statusText: "OK",
        contentType: "application/json",
        headers: new Headers(),
        body: result.body,
      };
      return response;
    },
  };
}

describe("createTelegramBotClient", () => {
  it("posts sendMessage with chat_id and text", async () => {
    let captured: { url?: string; body?: any } = {};
    const client = createTelegramBotClient({
      botToken: "TESTTOKEN",
      client: mockHttp((method, url, body) => {
        captured = { url, body };
        return { status: 200, body: JSON.stringify({ ok: true, result: { message_id: 99, chat: { id: 42 } } }) };
      }),
    });
    const result = await client.sendMessage(42, "hello");
    expect(captured.url).toBe("https://api.telegram.org/botTESTTOKEN/sendMessage");
    expect(captured.body).toEqual({ chat_id: 42, text: "hello" });
    expect(result.messageId).toBe(99);
    expect(result.chatId).toBe(42);
  });

  it("getUpdates posts offset and timeout", async () => {
    let captured: any = {};
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp((m, u, b) => {
        captured = { url: u, body: b };
        return { status: 200, body: JSON.stringify({ ok: true, result: [] }) };
      }),
    });
    await client.getUpdates({ offset: 100, timeoutSec: 30 });
    expect(captured.url).toBe("https://api.telegram.org/botT/getUpdates");
    expect(captured.body).toEqual({ offset: 100, timeout: 30 });
  });

  it("setWebhook posts url and secret_token", async () => {
    let captured: any = {};
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp((m, u, b) => {
        captured = { url: u, body: b };
        return { status: 200, body: JSON.stringify({ ok: true, result: true }) };
      }),
    });
    await client.setWebhook("https://example.com/hook", "SECRET");
    expect(captured.url).toBe("https://api.telegram.org/botT/setWebhook");
    expect(captured.body).toEqual({ url: "https://example.com/hook", secret_token: "SECRET" });
  });

  it("deleteWebhook posts to deleteWebhook endpoint", async () => {
    let url = "";
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp((m, u) => { url = u; return { status: 200, body: JSON.stringify({ ok: true, result: true }) }; }),
    });
    await client.deleteWebhook();
    expect(url).toBe("https://api.telegram.org/botT/deleteWebhook");
  });

  it("getChat returns chat info on success", async () => {
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp(() => ({ status: 200, body: JSON.stringify({ ok: true, result: { id: 555, type: "private", first_name: "Op" } }) })),
    });
    const chat = await client.getChat(555);
    expect(chat.id).toBe(555);
    expect(chat.type).toBe("private");
  });

  it("sendMessage 4xx surfaces structured error", async () => {
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp(() => ({ status: 400, body: JSON.stringify({ ok: false, description: "chat not found" }) })),
    });
    await expect(client.sendMessage(0, "x")).rejects.toThrow(/chat not found/);
  });

  it("getChat throws on bot-API error", async () => {
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp(() => ({ status: 400, body: JSON.stringify({ ok: false, description: "user not found" }) })),
    });
    await expect(client.getChat(999)).rejects.toThrow(/user not found/);
  });
});
