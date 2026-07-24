import { describe, it, expect } from "bun:test";
import { resolveTelegramIdentity } from "../../src/augments/telegramTransport";
import type {
  AgentCard,
  OutboundMessage,
  PeerIdentity,
  TelegramAuthOptions,
  TransportKernel,
  TurnResult,
  TurnTrigger,
} from "../../src/types";

const baseAuth: TelegramAuthOptions = {
  creatorUserIds: [12345678],
  admittedAgents: [{ id: "scheduler-bot", telegramUserId: 555444333 }],
  recognizedUserIds: [987654321],
  anonymousIdentityMode: "ephemeral",
};

describe("resolveTelegramIdentity", () => {
  it("creator user_id in a private chat → creator trust level + canonical peer.id", () => {
    const peer = resolveTelegramIdentity({ userId: 12345678, threadId: "thread-1" }, baseAuth);
    expect(peer.trustLevel).toBe("creator");
    expect(peer.id).toBe("creator");
    expect(peer.publicSubstate).toBeUndefined();
  });

  it("creator displayName is attached after creator verification", () => {
    const peer = resolveTelegramIdentity(
      { userId: 12345678, threadId: "thread-1", displayName: "Mutable TG Name" },
      baseAuth,
      { displayName: "Michael" },
    );
    expect(peer.trustLevel).toBe("creator");
    expect(peer.id).toBe("creator");
    expect(peer.displayName).toBe("Michael");
  });

  it("creator user_id in a group chat is not promoted to creator trust by default", () => {
    const peer = resolveTelegramIdentity(
      { userId: 12345678, threadId: "thread-1", chatType: "group" },
      baseAuth,
    );
    expect(peer.trustLevel).toBe("public");
    expect(peer.publicSubstate).toBe("anonymous");
    expect(peer.id).toBe("tg_anon_thread-1");
  });

  it("creator user IDs can come from a comma-separated env var", () => {
    const previous = process.env.TELEGRAM_CREATOR_USER_IDS_TEST;
    process.env.TELEGRAM_CREATOR_USER_IDS_TEST = "222, 333";
    try {
      const peer = resolveTelegramIdentity(
        { userId: 333, threadId: "thread-1" },
        { creatorUserIdsEnv: "TELEGRAM_CREATOR_USER_IDS_TEST" },
      );
      expect(peer.trustLevel).toBe("creator");
      expect(peer.id).toBe("creator");
    } finally {
      if (previous === undefined) delete process.env.TELEGRAM_CREATOR_USER_IDS_TEST;
      else process.env.TELEGRAM_CREATOR_USER_IDS_TEST = previous;
    }
  });

  it("throws clearly when creator user ID env var is not numeric", () => {
    const previous = process.env.TELEGRAM_CREATOR_USER_IDS_TEST;
    process.env.TELEGRAM_CREATOR_USER_IDS_TEST = "222,not-a-number";
    try {
      expect(() =>
        resolveTelegramIdentity(
          { userId: 222, threadId: "thread-1" },
          { creatorUserIdsEnv: "TELEGRAM_CREATOR_USER_IDS_TEST" },
        ),
      ).toThrow("comma-separated list of numeric Telegram user IDs");
    } finally {
      if (previous === undefined) delete process.env.TELEGRAM_CREATOR_USER_IDS_TEST;
      else process.env.TELEGRAM_CREATOR_USER_IDS_TEST = previous;
    }
  });

  it("admittedAgents user_id → agent trust level + configured agent id", () => {
    const peer = resolveTelegramIdentity({ userId: 555444333, threadId: "thread-1" }, baseAuth);
    expect(peer.trustLevel).toBe("agent");
    expect(peer.id).toBe("scheduler-bot");
  });

  it("recognized user_id → public/recognized + tg_user_ peer.id", () => {
    const peer = resolveTelegramIdentity({ userId: 987654321, threadId: "thread-1" }, baseAuth);
    expect(peer.trustLevel).toBe("public");
    expect(peer.publicSubstate).toBe("recognized");
    expect(peer.id).toBe("tg_user_987654321");
  });

  it("unknown user with ephemeral mode → public/anonymous + tg_anon_<threadId>", () => {
    const peer = resolveTelegramIdentity({ userId: 99, threadId: "thread-1" }, baseAuth);
    expect(peer.trustLevel).toBe("public");
    expect(peer.publicSubstate).toBe("anonymous");
    expect(peer.id).toBe("tg_anon_thread-1");
  });

  it("unknown user with durable mode → public/anonymous + tg_user_<userId>", () => {
    const peer = resolveTelegramIdentity(
      { userId: 99, threadId: "thread-1" },
      { ...baseAuth, anonymousIdentityMode: "durable" },
    );
    expect(peer.trustLevel).toBe("public");
    expect(peer.publicSubstate).toBe("anonymous");
    expect(peer.id).toBe("tg_user_99");
  });

  it("anonymousIdentityMode defaults to ephemeral when omitted", () => {
    const peer = resolveTelegramIdentity(
      { userId: 99, threadId: "thread-1" },
      { ...baseAuth, anonymousIdentityMode: undefined },
    );
    expect(peer.id).toBe("tg_anon_thread-1");
  });

  it("two anonymous DMs from same user with ephemeral → distinct peer.ids per thread", () => {
    const a = resolveTelegramIdentity({ userId: 99, threadId: "thread-A" }, baseAuth);
    const b = resolveTelegramIdentity({ userId: 99, threadId: "thread-B" }, baseAuth);
    expect(a.id).not.toBe(b.id);
  });

  it("two anonymous DMs from same user with durable → same peer.id across threads", () => {
    const opts: TelegramAuthOptions = { ...baseAuth, anonymousIdentityMode: "durable" };
    const a = resolveTelegramIdentity({ userId: 99, threadId: "thread-A" }, opts);
    const b = resolveTelegramIdentity({ userId: 99, threadId: "thread-B" }, opts);
    expect(a.id).toBe(b.id);
  });

  it("creator match takes precedence over admittedAgents if both match", () => {
    const opts: TelegramAuthOptions = {
      creatorUserIds: [555],
      admittedAgents: [{ id: "agent-bot", telegramUserId: 555 }],
    };
    const peer = resolveTelegramIdentity({ userId: 555, threadId: "t" }, opts);
    expect(peer.trustLevel).toBe("creator");
    expect(peer.id).toBe("creator");
    // Creator path wins by spec ordering.
  });
});

import { validateAdmittedAgents, telegramTransport } from "../../src/augments/telegramTransport";
import type { TelegramBotClient } from "../../src/telegram-client";
import type { TelegramUpdate } from "../../src/telegram-client";

function mockClient(behavior: Record<number, "ok" | "fail">): TelegramBotClient {
  return {
    sendMessage: async (cId) => ({ messageId: 1, chatId: cId }),
    getUpdates: async () => [],
    setWebhook: async () => {},
    deleteWebhook: async () => {},
    getChat: async (chatId) => {
      const id = Number(chatId);
      if (behavior[id] === "ok") return { id, type: "private", first_name: "Agent" };
      throw new Error("user not found");
    },
  };
}

describe("validateAdmittedAgents", () => {
  it("logs info for each admittedAgent that resolves successfully", async () => {
    const logs: string[] = [];
    const log = {
      info: (msg: string) => logs.push(`info: ${msg}`),
      warn: (msg: string) => logs.push(`warn: ${msg}`),
    };
    await validateAdmittedAgents(
      [
        { id: "scheduler", telegramUserId: 100 },
        { id: "billing", telegramUserId: 200 },
      ],
      mockClient({ 100: "ok", 200: "ok" }),
      log,
    );
    expect(logs.filter((l) => l.startsWith("info"))).toHaveLength(2);
  });

  it("logs warning for each admittedAgent that fails to resolve, naming id and telegramUserId", async () => {
    const logs: string[] = [];
    const log = { info: () => {}, warn: (msg: string) => logs.push(msg) };
    await validateAdmittedAgents(
      [
        { id: "scheduler", telegramUserId: 100 },
        { id: "typo-bot", telegramUserId: 999 },
      ],
      mockClient({ 100: "ok", 999: "fail" }),
      log,
    );
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("typo-bot");
    expect(logs[0]).toContain("999");
  });

  it("does nothing if admittedAgents is empty or undefined", async () => {
    const logs: string[] = [];
    const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };
    await validateAdmittedAgents(undefined, mockClient({}), log);
    await validateAdmittedAgents([], mockClient({}), log);
    expect(logs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T14: telegramTransport lifecycle — polling mode
// ---------------------------------------------------------------------------

function makeMockClient(updates: TelegramUpdate[][]) {
  const sent: Array<{ chatId: number | string; text: string }> = [];
  const client: TelegramBotClient = {
    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text });
      return { messageId: 1, chatId };
    },
    getUpdates: async () => {
      const batch = updates.shift() ?? [];
      return batch as TelegramUpdate[];
    },
    setWebhook: async () => {},
    deleteWebhook: async () => {},
    getChat: async (chatId) => ({ id: Number(chatId), type: "private" }),
  };
  return { client, sent };
}

/**
 * Mock TransportKernel for testing. Records every handleInbound call and
 * captures the registered onOutbound callback so tests can simulate the
 * kernel emitting an outbound reply.
 */
function makeMockKernel(opts: { handleInbound?: TransportKernel["handleInbound"] } = {}) {
  const handleInboundCalls: Array<{ trigger: TurnTrigger }> = [];
  const outboundCallbacks: Array<(peer: PeerIdentity, msg: OutboundMessage) => Promise<void>> = [];
  const kernel: TransportKernel = {
    handleInbound: async (trigger, options) => {
      handleInboundCalls.push({ trigger });
      if (opts.handleInbound) return opts.handleInbound(trigger, options);
      return {
        turnId: trigger.turnId,
        success: true,
        status: "completed",
        toolCalls: [],
        trace: {} as TurnResult["trace"],
      };
    },
    onOutbound: (cb) => {
      outboundCallbacks.push(cb);
    },
    getAgentCard: () => ({}) as AgentCard,
    getAugmentRoutes: () => [],
    getAugments: () => [],
  };
  return { kernel, handleInboundCalls, outboundCallbacks };
}

describe("telegramTransport — polling lifecycle", () => {
  it("rejects readiness before registration and is idempotent after registration", async () => {
    const { client } = makeMockClient([[]]);
    const { kernel } = makeMockKernel();
    const aug = telegramTransport({
      botToken: "T",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: {},
      _clientFactory: () => client,
    } as unknown as Parameters<typeof telegramTransport>[0]);

    await aug.onBoot?.();
    await expect(aug.transport!.ready!()).rejects.toThrow("before kernel registration");
    await aug.transport!.register(kernel, "telegram-transport");
    await aug.transport!.ready!();
    await aug.transport!.ready!();
    await aug.onShutdown?.();
  });

  it("starts polling at readiness; dispatches turn for each text update via kernel.handleInbound", async () => {
    const updates: TelegramUpdate[] = [
      {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 100, type: "private" },
          from: { id: 100, is_bot: false },
          date: 0,
          text: "hello",
        },
      },
    ];
    const { client } = makeMockClient([updates, []]);
    const { kernel, handleInboundCalls } = makeMockKernel();
    const aug = telegramTransport({
      botToken: "T",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: { creatorUserIds: [100] },
      _clientFactory: () => client,
    } as unknown as Parameters<typeof telegramTransport>[0]);
    // Wire the kernel into the transport before booting receivers.
    await aug.transport!.register(kernel, "telegram-transport");
    await aug.onBoot?.();
    await aug.transport!.ready?.();
    await new Promise((r) => setTimeout(r, 30));
    await aug.onShutdown?.();
    expect(handleInboundCalls).toHaveLength(1);
    expect(handleInboundCalls[0]?.trigger.peer?.trustLevel).toBe("creator");
    expect(handleInboundCalls[0]?.trigger.threadId).toBe("tg-chat-100");
    expect(handleInboundCalls[0]?.trigger.type).toBe("message");
  });

  it("claims duplicate update ids before kernel dispatch", async () => {
    const update: TelegramUpdate = {
      update_id: 91,
      message: {
        message_id: 1,
        chat: { id: 100, type: "private" },
        from: { id: 100, is_bot: false },
        date: 0,
        text: "one execution",
      },
    };
    const { client } = makeMockClient([[update, update], []]);
    const { kernel, handleInboundCalls } = makeMockKernel();
    const aug = telegramTransport({
      botToken: "T",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: {},
      _clientFactory: () => client,
    } as unknown as Parameters<typeof telegramTransport>[0]);
    await aug.transport!.register(kernel, "telegram-transport");
    await aug.onBoot?.();
    await aug.transport!.ready?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await aug.onShutdown?.();
    expect(handleInboundCalls).toHaveLength(1);
  });

  it("inbound text → registered outbound callback → sendMessage to original chat_id", async () => {
    const updates: TelegramUpdate[] = [
      {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 555, type: "private" },
          from: { id: 555, is_bot: false },
          date: 0,
          text: "hi",
        },
      },
    ];
    const { client, sent } = makeMockClient([updates, []]);
    let outboundCallbacks: Array<(peer: PeerIdentity, msg: OutboundMessage) => Promise<void>> = [];
    const setup = makeMockKernel({
      handleInbound: async (trigger) => {
        await outboundCallbacks[0]!(trigger.peer!, {
          parts: [{ kind: "text", text: "response text" }],
          contextId: trigger.threadId,
        });
        return {
          turnId: trigger.turnId,
          success: true,
          status: "completed",
          toolCalls: [],
          trace: {} as TurnResult["trace"],
        };
      },
    });
    outboundCallbacks = setup.outboundCallbacks;
    const { kernel, handleInboundCalls } = setup;
    const aug = telegramTransport({
      botToken: "T",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: { anonymousIdentityMode: "ephemeral" },
      _clientFactory: () => client,
    } as unknown as Parameters<typeof telegramTransport>[0]);
    await aug.transport!.register(kernel, "telegram-transport");
    await aug.onBoot?.();
    await aug.transport!.ready?.();
    await new Promise((r) => setTimeout(r, 30));
    expect(handleInboundCalls).toHaveLength(1);
    expect(outboundCallbacks).toHaveLength(1);
    // Routing state is released after handleInbound settles.
    await outboundCallbacks[0]!(handleInboundCalls[0]!.trigger.peer!, {
      parts: [{ kind: "text", text: "late response must be dropped" }],
      contextId: "tg-chat-555",
    });
    await aug.onShutdown?.();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe(555);
    expect(sent[0]?.text).toBe("response text");
  });

  it("sends generic failure reply when a failed turn contains provider auth details", async () => {
    const updates: TelegramUpdate[] = [
      {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 555, type: "private" },
          from: { id: 555, is_bot: false },
          date: 0,
          text: "who are you?",
        },
      },
    ];
    const { client, sent } = makeMockClient([updates, []]);
    const { kernel } = makeMockKernel({
      handleInbound: async (trigger) => ({
        turnId: trigger.turnId,
        success: false,
        status: "failed",
        errorResponse: "HTTP 401: authentication_error: invalid x-api-key",
        error: { message: "HTTP 401: authentication_error: invalid x-api-key", source: "engine" },
        toolCalls: [],
        trace: {} as TurnResult["trace"],
      }),
    });
    const aug = telegramTransport({
      botToken: "T",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: { creatorUserIds: [555] },
      _clientFactory: () => client,
    } as unknown as Parameters<typeof telegramTransport>[0]);

    await aug.transport!.register(kernel, "telegram-transport");
    await aug.onBoot?.();
    await aug.transport!.ready?.();
    await new Promise((r) => setTimeout(r, 30));
    await aug.onShutdown?.();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe(
      "I hit a runtime error while handling that message. The operator has the details.",
    );
    expect(sent[0]?.text).not.toContain("x-api-key");
    expect(sent[0]?.text).not.toContain("401");
  });

  it("preserves allowlisted user-safe failed turn messages", async () => {
    const updates: TelegramUpdate[] = [
      {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 555, type: "private" },
          from: { id: 555, is_bot: false },
          date: 0,
          text: "again",
        },
      },
    ];
    const { client, sent } = makeMockClient([updates, []]);
    const safeMessage = "Rate limit exceeded. Please wait before sending more messages.";
    const { kernel } = makeMockKernel({
      handleInbound: async (trigger) => ({
        turnId: trigger.turnId,
        success: false,
        status: "rejected",
        errorResponse: safeMessage,
        toolCalls: [],
        trace: {} as TurnResult["trace"],
      }),
    });
    const aug = telegramTransport({
      botToken: "T",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: { creatorUserIds: [555] },
      _clientFactory: () => client,
    } as unknown as Parameters<typeof telegramTransport>[0]);

    await aug.transport!.register(kernel, "telegram-transport");
    await aug.onBoot?.();
    await aug.transport!.ready?.();
    await new Promise((r) => setTimeout(r, 30));
    await aug.onShutdown?.();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe(safeMessage);
  });

  it("sends generic failure reply when kernel.handleInbound throws", async () => {
    const updates: TelegramUpdate[] = [
      {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 555, type: "private" },
          from: { id: 555, is_bot: false },
          date: 0,
          text: "who are you?",
        },
      },
    ];
    const { client, sent } = makeMockClient([updates, []]);
    const { kernel } = makeMockKernel({
      handleInbound: async () => {
        throw new Error("HTTP 401: authentication_error: invalid x-api-key");
      },
    });
    const aug = telegramTransport({
      botToken: "T",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: { creatorUserIds: [555] },
      _clientFactory: () => client,
    } as unknown as Parameters<typeof telegramTransport>[0]);

    await aug.transport!.register(kernel, "telegram-transport");
    await aug.onBoot?.();
    await aug.transport!.ready?.();
    await new Promise((r) => setTimeout(r, 30));
    await aug.onShutdown?.();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe(
      "I hit a runtime error while handling that message. The operator has the details.",
    );
  });

  it("ignores updates with no text (no kernel.handleInbound call)", async () => {
    const updates: TelegramUpdate[] = [
      { update_id: 1, message: { message_id: 1, chat: { id: 1, type: "private" }, date: 0 } },
    ];
    const { client } = makeMockClient([updates, []]);
    const { kernel, handleInboundCalls } = makeMockKernel();
    const aug = telegramTransport({
      botToken: "T",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: {},
      _clientFactory: () => client,
    } as unknown as Parameters<typeof telegramTransport>[0]);
    await aug.transport!.register(kernel, "telegram-transport");
    await aug.onBoot?.();
    await aug.transport!.ready?.();
    await new Promise((r) => setTimeout(r, 30));
    await aug.onShutdown?.();
    expect(handleInboundCalls).toHaveLength(0);
  });

  it("transport.identify() resolves PeerIdentity from raw {userId,threadId}", () => {
    const { client } = makeMockClient([[]]);
    const aug = telegramTransport({
      botToken: "T",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: { creatorUserIds: [42] },
      _clientFactory: () => client,
    } as unknown as Parameters<typeof telegramTransport>[0]);
    const peer = aug.transport!.identify({ userId: 42, threadId: "tg-chat-42" });
    expect(peer?.trustLevel).toBe("creator");
    expect(peer?.id).toBe("creator");
  });

  it("transport.identify() returns null for malformed raw input", () => {
    const { client } = makeMockClient([[]]);
    const aug = telegramTransport({
      botToken: "T",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: {},
      _clientFactory: () => client,
    } as unknown as Parameters<typeof telegramTransport>[0]);
    expect(aug.transport!.identify({})).toBeNull();
    expect(aug.transport!.identify(null)).toBeNull();
  });

  it("keeps concurrent same-chat reply routing until both turns settle", async () => {
    const port = 31_000 + Math.floor(Math.random() * 5_000);
    const { client, sent } = makeMockClient([]);
    let outboundCallbacks: Array<(peer: PeerIdentity, msg: OutboundMessage) => Promise<void>> = [];
    let started = 0;
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const setup = makeMockKernel({
      handleInbound: async (trigger) => {
        started++;
        if (started === 2) releaseBoth();
        await bothStarted;
        await outboundCallbacks[0]!(trigger.peer!, {
          parts: [{ kind: "text", text: `reply-${trigger.turnId}` }],
          contextId: trigger.threadId,
        });
        return {
          turnId: trigger.turnId,
          success: true,
          status: "completed",
          toolCalls: [],
          trace: {} as TurnResult["trace"],
        };
      },
    });
    outboundCallbacks = setup.outboundCallbacks;
    const aug = telegramTransport({
      botToken: "T",
      inbound: {
        mode: "webhook",
        webhook: {
          publicUrl: "https://example.test/telegram",
          port,
          secretToken: "secret",
        },
      },
      auth: {},
      _clientFactory: () => client,
    } as unknown as Parameters<typeof telegramTransport>[0]);
    await aug.transport!.register(setup.kernel, "telegram-transport");
    await aug.onBoot?.();
    await aug.transport!.ready?.();
    try {
      const update = (update_id: number) => ({
        update_id,
        message: {
          message_id: update_id,
          chat: { id: 777, type: "private" },
          from: { id: 777, is_bot: false },
          date: 0,
          text: "hi",
        },
      });
      const responses = await Promise.all(
        [update(1), update(2)].map((body) =>
          fetch(`http://127.0.0.1:${port}/`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-telegram-bot-api-secret-token": "secret",
            },
            body: JSON.stringify(body),
          }),
        ),
      );
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(sent).toHaveLength(2);
      await outboundCallbacks[0]!(
        {
          id: "late",
          kind: "human",
          trustLevel: "public",
          sourceAugment: "test",
        },
        {
          parts: [{ kind: "text", text: "late" }],
          contextId: "tg-chat-777",
        },
      );
      expect(sent).toHaveLength(2);
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("rolls back the local webhook listener when Telegram webhook setup fails", async () => {
    const port = 31_000 + Math.floor(Math.random() * 5_000);
    let deleteCalls = 0;
    const client: TelegramBotClient = {
      async sendMessage(chatId) {
        return { messageId: 1, chatId };
      },
      async getUpdates() {
        return [];
      },
      async setWebhook() {
        throw new Error("telegram unavailable");
      },
      async deleteWebhook() {
        deleteCalls += 1;
      },
      async getChat(chatId) {
        return { id: Number(chatId), type: "private" };
      },
    };
    const { kernel } = makeMockKernel();
    const aug = telegramTransport({
      botToken: "T",
      inbound: {
        mode: "webhook",
        webhook: {
          publicUrl: "https://example.test/telegram",
          port,
          secretToken: "secret",
        },
      },
      auth: {},
      _clientFactory: () => client,
    } as unknown as Parameters<typeof telegramTransport>[0]);

    await aug.onBoot?.();
    await aug.transport!.register(kernel, "telegram-transport");
    await expect(aug.transport!.ready?.()).rejects.toThrow("telegram unavailable");
    expect(deleteCalls).toBe(1);

    const replacement = Bun.serve({ port, fetch: () => new Response("ok") });
    replacement.stop(true);
    await aug.onShutdown?.();
  });
});
