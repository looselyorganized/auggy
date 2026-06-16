import { describe, it, expect } from "bun:test";
import { runPollLoop, type PollLoopHandle } from "../../../src/augments/telegramTransport/polling";
import type { TelegramBotClient, TelegramUpdate } from "../../../src/telegram-client";

function mockClient(updateBatches: TelegramUpdate[][]): {
  client: TelegramBotClient;
  getCalls: Array<{ offset?: number }>;
} {
  const calls: Array<{ offset?: number }> = [];
  let batchIndex = 0;
  const client: TelegramBotClient = {
    sendMessage: async (cId) => ({ messageId: 1, chatId: cId }),
    getUpdates: async (opts) => {
      calls.push({ offset: opts.offset });
      const batch = updateBatches[batchIndex] ?? [];
      batchIndex++;
      return batch;
    },
    setWebhook: async () => {},
    deleteWebhook: async () => {},
    getChat: async (chatId) => ({ id: Number(chatId), type: "private" }),
  };
  return { client, getCalls: calls };
}

describe("runPollLoop", () => {
  it("calls onUpdate for each update returned", async () => {
    const updates: TelegramUpdate[] = [
      {
        update_id: 1,
        message: { message_id: 1, chat: { id: 100, type: "private" }, date: 0, text: "hi" },
      },
      {
        update_id: 2,
        message: { message_id: 2, chat: { id: 200, type: "private" }, date: 0, text: "hello" },
      },
    ];
    const { client } = mockClient([updates, []]);
    const received: TelegramUpdate[] = [];
    let handle: PollLoopHandle | null = null;
    handle = runPollLoop({
      client,
      timeoutSec: 1,
      onUpdate: (u) => {
        received.push(u);
        if (received.length === 2) handle!.stop();
      },
    });
    await handle.done;
    expect(received).toEqual(updates);
  });

  it("uses returned update_id+1 as next offset", async () => {
    const updates: TelegramUpdate[] = [
      {
        update_id: 42,
        message: { message_id: 1, chat: { id: 100, type: "private" }, date: 0, text: "hi" },
      },
    ];
    const { client, getCalls } = mockClient([updates, []]);
    const handle = runPollLoop({
      client,
      timeoutSec: 1,
      onUpdate: () => {},
    });
    while (getCalls.length < 2) await new Promise((r) => setTimeout(r, 0));
    handle.stop();
    await handle.done;
    expect(getCalls[0]?.offset).toBeUndefined(); // first call has no offset
    expect(getCalls[1]?.offset).toBe(43); // second call uses 42+1
  });

  it("handles error and continues with backoff", async () => {
    let throwOnce = true;
    const client: TelegramBotClient = {
      sendMessage: async (c) => ({ messageId: 1, chatId: c }),
      getUpdates: async () => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("net");
        }
        return [];
      },
      setWebhook: async () => {},
      deleteWebhook: async () => {},
      getChat: async (chatId) => ({ id: Number(chatId), type: "private" }),
    };
    const handle = runPollLoop({ client, timeoutSec: 0, onUpdate: () => {}, errorBackoffMs: 10 });
    await new Promise((r) => setTimeout(r, 50));
    handle.stop();
    await handle.done;
    expect(throwOnce).toBe(false); // proves we got past the throw
  });

  it("aborts the active long poll when stopped", async () => {
    let signal: AbortSignal | undefined;
    let resolveSignalReady: (() => void) | undefined;
    const signalReady = new Promise<void>((resolve) => {
      resolveSignalReady = resolve;
    });
    const warnings: string[] = [];
    const client: TelegramBotClient = {
      sendMessage: async (c) => ({ messageId: 1, chatId: c }),
      getUpdates: async (opts) => {
        signal = opts.signal;
        resolveSignalReady?.();
        return await new Promise<TelegramUpdate[]>((_, reject) => {
          opts.signal?.addEventListener(
            "abort",
            () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            },
            { once: true },
          );
        });
      },
      setWebhook: async () => {},
      deleteWebhook: async () => {},
      getChat: async (chatId) => ({ id: Number(chatId), type: "private" }),
    };
    const handle = runPollLoop({
      client,
      timeoutSec: 30,
      onUpdate: () => {},
      log: { warn: (msg) => warnings.push(msg) },
    });

    await signalReady;
    handle.stop();
    await handle.done;

    expect(signal?.aborted).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("wakes retry backoff when stopped", async () => {
    const warnings: string[] = [];
    let resolveWarned: (() => void) | undefined;
    const warned = new Promise<void>((resolve) => {
      resolveWarned = resolve;
    });
    const client: TelegramBotClient = {
      sendMessage: async (c) => ({ messageId: 1, chatId: c }),
      getUpdates: async () => {
        throw new Error("net");
      },
      setWebhook: async () => {},
      deleteWebhook: async () => {},
      getChat: async (chatId) => ({ id: Number(chatId), type: "private" }),
    };
    const handle = runPollLoop({
      client,
      timeoutSec: 0,
      onUpdate: () => {},
      errorBackoffMs: 60_000,
      log: {
        warn: (msg) => {
          warnings.push(msg);
          resolveWarned?.();
        },
      },
    });

    await warned;
    handle.stop();
    await Promise.race([
      handle.done,
      new Promise((_, reject) => setTimeout(() => reject(new Error("stop timed out")), 250)),
    ]);

    expect(warnings).toHaveLength(1);
  });

  it("stops cleanly when handle.stop() called", async () => {
    const { client } = mockClient([[], [], []]);
    const handle = runPollLoop({ client, timeoutSec: 0, onUpdate: () => {} });
    handle.stop();
    await handle.done;
    // No assertion error — stop() resolves done.
  });
});
