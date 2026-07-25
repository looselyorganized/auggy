import { describe, it, expect } from "bun:test";
import {
  runPollLoop,
  type PollLoopHandle,
  type PollLoopSnapshot,
} from "../../../src/augments/telegramTransport/polling";
import {
  TelegramBotApiError,
  type TelegramBotClient,
  type TelegramUpdate,
} from "../../../src/telegram-client";
import { TelegramReplayConflictError } from "../../../src/augments/telegramTransport/replay-store";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

  it("quarantines Telegram polling ownership conflicts until exact recovery", async () => {
    const quarantined = deferred<PollLoopSnapshot>();
    const secondPoll = deferred<void>();
    const calls: Array<number | undefined> = [];
    const client: TelegramBotClient = {
      sendMessage: async (c) => ({ messageId: 1, chatId: c }),
      async getUpdates(opts) {
        calls.push(opts.offset);
        if (calls.length === 1) {
          throw new TelegramBotApiError("getUpdates", 409, 409);
        }
        secondPoll.resolve();
        return await new Promise<TelegramUpdate[]>((_, reject) => {
          opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
        });
      },
      setWebhook: async () => {},
      deleteWebhook: async () => {},
      getChat: async (chatId) => ({ id: Number(chatId), type: "private" }),
    };
    const handle = runPollLoop({
      client,
      timeoutSec: 0,
      onUpdate: () => {},
      randomUUID: () => "poll-owner-incident",
      onStateChange(snapshot) {
        if (snapshot.state === "conflict-quarantined") quarantined.resolve(snapshot);
      },
    });

    const state = await quarantined.promise;
    expect(state.conflict).toEqual({
      id: "poll-owner-incident",
      kind: "polling-ownership",
      detectedAt: expect.any(Number),
    });
    expect(calls).toEqual([undefined]);
    expect(handle.recoverConflict("stale-incident")).toBe(false);
    expect(handle.recoverConflict("poll-owner-incident")).toBe(true);
    await secondPoll.promise;
    expect(calls).toEqual([undefined, undefined]);
    handle.stop();
    await handle.done;
  });

  it("pauses at a replay conflict before later batch entries and retries the same offset", async () => {
    const quarantined = deferred<PollLoopSnapshot>();
    const secondPoll = deferred<void>();
    const attempted: number[] = [];
    const offsets: Array<number | undefined> = [];
    const conflict = {
      id: "replay-incident",
      updateId: 10,
      detectedAt: 123,
    };
    const batch = [{ update_id: 10 }, { update_id: 11 }] as TelegramUpdate[];
    const client: TelegramBotClient = {
      sendMessage: async (c) => ({ messageId: 1, chatId: c }),
      async getUpdates(opts) {
        offsets.push(opts.offset);
        if (offsets.length === 1) return batch;
        secondPoll.resolve();
        return await new Promise<TelegramUpdate[]>((_, reject) => {
          opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
        });
      },
      setWebhook: async () => {},
      deleteWebhook: async () => {},
      getChat: async (chatId) => ({ id: Number(chatId), type: "private" }),
    };
    const handle = runPollLoop({
      client,
      timeoutSec: 0,
      onUpdate(update) {
        attempted.push(update.update_id);
        throw new TelegramReplayConflictError(conflict);
      },
      onStateChange(snapshot) {
        if (snapshot.state === "conflict-quarantined") quarantined.resolve(snapshot);
      },
    });

    expect((await quarantined.promise).conflict).toEqual({
      ...conflict,
      kind: "replay-payload",
    });
    expect(attempted).toEqual([10]);
    expect(offsets).toEqual([undefined]);
    expect(handle.recoverConflict(conflict.id)).toBe(true);
    await secondPoll.promise;
    expect(offsets).toEqual([undefined, undefined]);
    handle.stop();
    await handle.done;
  });

  it("does not poll when initialized from durable replay quarantine", async () => {
    const quarantined = deferred<PollLoopSnapshot>();
    const pollStarted = deferred<void>();
    let calls = 0;
    const client: TelegramBotClient = {
      sendMessage: async (c) => ({ messageId: 1, chatId: c }),
      async getUpdates(opts) {
        calls++;
        pollStarted.resolve();
        return await new Promise<TelegramUpdate[]>((_, reject) => {
          opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
        });
      },
      setWebhook: async () => {},
      deleteWebhook: async () => {},
      getChat: async (chatId) => ({ id: Number(chatId), type: "private" }),
    };
    const conflict = {
      id: "persisted-incident",
      kind: "replay-payload" as const,
      updateId: 8,
      detectedAt: 123,
    };
    const handle = runPollLoop({
      client,
      onUpdate: () => {},
      initialConflict: conflict,
      onStateChange(snapshot) {
        if (snapshot.state === "conflict-quarantined") quarantined.resolve(snapshot);
      },
    });

    expect((await quarantined.promise).conflict).toEqual(conflict);
    expect(calls).toBe(0);
    expect(handle.recoverConflict(conflict.id)).toBe(true);
    await pollStarted.promise;
    expect(calls).toBe(1);
    handle.stop();
    await handle.done;
  });

  it("resumes when another replica resolves durable replay quarantine", async () => {
    const quarantined = deferred<PollLoopSnapshot>();
    const remoteRecovery = deferred<void>();
    const secondPoll = deferred<void>();
    let calls = 0;
    const conflict = {
      id: "shared-incident",
      updateId: 10,
      detectedAt: 123,
    };
    const client: TelegramBotClient = {
      sendMessage: async (c) => ({ messageId: 1, chatId: c }),
      async getUpdates(opts) {
        calls++;
        if (calls === 1) return [{ update_id: 10 }] as TelegramUpdate[];
        secondPoll.resolve();
        return await new Promise<TelegramUpdate[]>((_, reject) => {
          opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
        });
      },
      setWebhook: async () => {},
      deleteWebhook: async () => {},
      getChat: async (chatId) => ({ id: Number(chatId), type: "private" }),
    };
    const handle = runPollLoop({
      client,
      onUpdate() {
        throw new TelegramReplayConflictError(conflict);
      },
      waitForReplayRecovery: () => remoteRecovery.promise,
      onStateChange(snapshot) {
        if (snapshot.state === "conflict-quarantined") quarantined.resolve(snapshot);
      },
    });

    await quarantined.promise;
    expect(calls).toBe(1);
    remoteRecovery.resolve();
    await secondPoll.promise;
    expect(calls).toBe(2);
    expect(handle.snapshot().conflict).toBeNull();
    handle.stop();
    await handle.done;
  });

  it("quarantines an invalid batch before partial dispatch and stops cleanly while paused", async () => {
    const quarantined = deferred<PollLoopSnapshot>();
    let updatesHandled = 0;
    const client = mockClient([[{ update_id: 2 }, { update_id: 1 }] as TelegramUpdate[]]).client;
    const handle = runPollLoop({
      client,
      timeoutSec: 0,
      onUpdate() {
        updatesHandled++;
      },
      randomUUID: () => "invalid-sequence-incident",
      onStateChange(snapshot) {
        if (snapshot.state === "conflict-quarantined") quarantined.resolve(snapshot);
      },
    });

    expect((await quarantined.promise).conflict).toMatchObject({
      id: "invalid-sequence-incident",
      kind: "invalid-update-sequence",
    });
    expect(updatesHandled).toBe(0);
    handle.stop();
    await handle.done;
    expect(handle.snapshot().state).toBe("stopped");
    expect(handle.recoverConflict("invalid-sequence-incident")).toBe(false);
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
