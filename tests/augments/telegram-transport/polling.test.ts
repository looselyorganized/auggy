import { describe, it, expect } from "bun:test";
import { runPollLoop, type PollLoopHandle } from "../../../src/augments/telegram-transport/polling";
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
    let handle: PollLoopHandle | null = null;
    let count = 0;
    handle = runPollLoop({
      client,
      timeoutSec: 1,
      onUpdate: () => {
        count++;
        if (count === 1) handle!.stop();
      },
    });
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

  it("stops cleanly when handle.stop() called", async () => {
    const { client } = mockClient([[], [], []]);
    const handle = runPollLoop({ client, timeoutSec: 0, onUpdate: () => {} });
    handle.stop();
    await handle.done;
    // No assertion error — stop() resolves done.
  });
});
