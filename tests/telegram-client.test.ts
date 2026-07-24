import { describe, it, expect } from "bun:test";
import type { HttpClient, HttpResponse } from "../src/http";
import { OutcomeUnknownError } from "../src/outcome-unknown";
import { createTelegramBotClient } from "../src/telegram-client";

type HttpPostInit = Parameters<HttpClient["post"]>[1];

function mockHttp(
  handler: (
    method: string,
    url: string,
    body?: unknown,
    opts?: HttpPostInit,
  ) => { status: number; body: string },
): Pick<HttpClient, "post"> {
  return {
    post: async (url, opts) => {
      const result = handler(
        "POST",
        url,
        opts?.body ? JSON.parse(opts.body as string) : undefined,
        opts,
      );
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
  it("rejects a bot token over non-loopback plaintext HTTP", () => {
    expect(() =>
      createTelegramBotClient({
        botToken: "GROUP9_TELEGRAM_SENTINEL",
        baseUrl: "http://provider.example.test",
        client: {
          post: async () => {
            throw new Error("must not dispatch");
          },
        },
      }),
    ).toThrow(/plaintext HTTP/);
  });

  it("posts sendMessage with chat_id and text", async () => {
    let captured: { url?: string; body?: unknown } = {};
    const client = createTelegramBotClient({
      botToken: "TESTTOKEN",
      client: mockHttp((_method, url, body) => {
        captured = { url, body };
        return {
          status: 200,
          body: JSON.stringify({ ok: true, result: { message_id: 99, chat: { id: 42 } } }),
        };
      }),
    });
    const result = await client.sendMessage(42, "hello");
    expect(captured.url).toBe("https://api.telegram.org/botTESTTOKEN/sendMessage");
    expect(captured.body).toEqual({ chat_id: 42, text: "hello" });
    expect(result.messageId).toBe(99);
    expect(result.chatId).toBe(42);
  });

  it("getUpdates posts offset and timeout", async () => {
    let captured: { url?: string; body?: unknown } = {};
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp((_m, u, b) => {
        captured = { url: u, body: b };
        return { status: 200, body: JSON.stringify({ ok: true, result: [] }) };
      }),
    });
    await client.getUpdates({ offset: 100, timeoutSec: 30 });
    expect(captured.url).toBe("https://api.telegram.org/botT/getUpdates");
    expect(captured.body).toEqual({ offset: 100, timeout: 30 });
  });

  it("getUpdates passes abort signal to HTTP client", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp((_m, _u, _b, opts) => {
        capturedSignal = opts?.signal;
        return { status: 200, body: JSON.stringify({ ok: true, result: [] }) };
      }),
    });
    await client.getUpdates({ timeoutSec: 30, signal: controller.signal });
    expect(capturedSignal).toBe(controller.signal);
  });

  it("sendMessage passes abort signal to HTTP client", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp((_m, _u, _b, opts) => {
        capturedSignal = opts?.signal;
        return {
          status: 200,
          body: JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 42 } } }),
        };
      }),
    });
    await client.sendMessage(42, "hello", { signal: controller.signal });
    expect(capturedSignal).toBe(controller.signal);
  });

  it("classifies an unreadable successful sendMessage response as outcome unknown", async () => {
    const sentinel = "GROUP9_TELEGRAM_MALFORMED_BODY_SENTINEL";
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp(() => ({ status: 200, body: `{${sentinel}` })),
    });

    try {
      await client.sendMessage(42, "hello");
      throw new Error("expected sendMessage to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OutcomeUnknownError);
      expect(Bun.inspect(error)).not.toContain(sentinel);
    }
  });

  it("does not retain token-bearing network errors", async () => {
    const sentinel = "GROUP9_TELEGRAM_BOT_TOKEN_SENTINEL";
    const client = createTelegramBotClient({
      botToken: sentinel,
      client: {
        post: async (url) => {
          throw new Error(`failed request path ${url}`);
        },
      },
    });

    try {
      await client.sendMessage(42, "hello");
      throw new Error("expected sendMessage to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OutcomeUnknownError);
      expect(Bun.inspect(error)).not.toContain(sentinel);
    }
  });

  for (const [name, body] of [
    ["null envelope", "null"],
    ["missing ok flag", "{}"],
    ["null result", JSON.stringify({ ok: true, result: null })],
    ["incomplete result", JSON.stringify({ ok: true, result: {} })],
  ] as const) {
    it(`classifies ${name} after sendMessage dispatch as outcome unknown`, async () => {
      const client = createTelegramBotClient({
        botToken: "T",
        client: mockHttp(() => ({ status: 200, body })),
      });

      await expect(client.sendMessage(42, "hello")).rejects.toBeInstanceOf(OutcomeUnknownError);
    });
  }

  it("setWebhook posts url and secret_token", async () => {
    let captured: { url?: string; body?: unknown } = {};
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp((_m, u, b) => {
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
      client: mockHttp((_m, u) => {
        url = u;
        return { status: 200, body: JSON.stringify({ ok: true, result: true }) };
      }),
    });
    await client.deleteWebhook();
    expect(url).toBe("https://api.telegram.org/botT/deleteWebhook");
  });

  it("getChat returns chat info on success", async () => {
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp(() => ({
        status: 200,
        body: JSON.stringify({ ok: true, result: { id: 555, type: "private", first_name: "Op" } }),
      })),
    });
    const chat = await client.getChat(555);
    expect(chat.id).toBe(555);
    expect(chat.type).toBe("private");
  });

  it("sendMessage 4xx exposes only a stable status", async () => {
    const sentinel = "GROUP9_TELEGRAM_REMOTE_ERROR_SENTINEL";
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp(() => ({
        status: 400,
        body: JSON.stringify({ ok: false, description: sentinel }),
      })),
    });
    try {
      await client.sendMessage(0, "x");
      throw new Error("expected sendMessage to fail");
    } catch (error) {
      expect((error as Error).message).toBe("Telegram bot API sendMessage returned HTTP 400");
      expect((error as Error).message).not.toContain(sentinel);
    }
  });

  it("getChat does not expose bot-API response text", async () => {
    const sentinel = "GROUP9_TELEGRAM_GET_CHAT_SENTINEL";
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp(() => ({
        status: 400,
        body: JSON.stringify({ ok: false, description: sentinel }),
      })),
    });
    try {
      await client.getChat(999);
      throw new Error("expected getChat to fail");
    } catch (error) {
      expect((error as Error).message).toBe("Telegram bot API getChat returned HTTP 400");
      expect((error as Error).message).not.toContain(sentinel);
    }
  });
});
