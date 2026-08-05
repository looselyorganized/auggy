import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTelegramIdentity } from "../../src/augments/telegramTransport";
import type {
  AgentCard,
  OutboundMessage,
  PeerIdentity,
  TelegramAsyncReplayStore,
  TelegramAuthOptions,
  TelegramReplayClaimOptions,
  TelegramReplayStore,
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
import {
  createInMemoryTelegramReplayStore,
  createSqliteTelegramReplayStore,
} from "../../src/augments/telegramTransport/replay-store";
import type { TelegramBotClient } from "../../src/telegram-client";
import type { TelegramUpdate } from "../../src/telegram-client";
import { buildAdminActionRegistry } from "../../src/transports/admin";

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
    const validated = await validateAdmittedAgents(
      [
        { id: "scheduler", telegramUserId: 100 },
        { id: "billing", telegramUserId: 200 },
      ],
      mockClient({ 100: "ok", 200: "ok" }),
      log,
    );
    expect(logs.filter((l) => l.startsWith("info"))).toHaveLength(2);
    expect(validated.map((agent) => agent.id)).toEqual(["scheduler", "billing"]);
  });

  it("removes every admittedAgent that fails validation from the active mapping", async () => {
    const logs: string[] = [];
    const log = { info: () => {}, warn: (msg: string) => logs.push(msg) };
    const validated = await validateAdmittedAgents(
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
    expect(validated).toEqual([{ id: "scheduler", telegramUserId: 100 }]);
  });

  it("does nothing if admittedAgents is empty or undefined", async () => {
    const logs: string[] = [];
    const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };
    await validateAdmittedAgents(undefined, mockClient({}), log);
    await validateAdmittedAgents([], mockClient({}), log);
    expect(logs).toHaveLength(0);
  });

  it("demotes a configured agent whose identity fails boot validation", async () => {
    const aug = telegramTransport({
      botToken: "123:test-token",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: {
        admittedAgents: [{ id: "typo-bot", telegramUserId: 999 }],
      },
      _clientFactory: () => mockClient({ 999: "fail" }),
    } as unknown as Parameters<typeof telegramTransport>[0]);

    await aug.onBoot?.();
    const peer = aug.transport!.identify({
      userId: 999,
      threadId: "tg-chat-999",
      chatType: "private",
    });
    expect(peer).toMatchObject({
      trustLevel: "public",
      publicSubstate: "anonymous",
    });
    expect(peer?.id).not.toBe("typo-bot");
    await aug.onShutdown?.();
  });

  it("revalidates configured admitted agents after a transport restart", async () => {
    let attempts = 0;
    const client = mockClient({});
    client.getChat = async (chatId) => {
      attempts++;
      if (attempts === 1) throw new Error("temporarily unavailable");
      return { id: Number(chatId), type: "private" };
    };
    const aug = telegramTransport({
      botToken: "123:test-token",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: {
        admittedAgents: [{ id: "recovering-agent", telegramUserId: 999 }],
      },
      _clientFactory: () => client,
    } as unknown as Parameters<typeof telegramTransport>[0]);

    await aug.onBoot?.();
    expect(
      aug.transport!.identify({
        userId: 999,
        threadId: "tg-bot-123-chat-999",
        chatType: "private",
      })?.trustLevel,
    ).toBe("public");
    await aug.onShutdown?.();

    await aug.onBoot?.();
    expect(
      aug.transport!.identify({
        userId: 999,
        threadId: "tg-bot-123-chat-999",
        chatType: "private",
      })?.trustLevel,
    ).toBe("agent");
    expect(attempts).toBe(2);
    await aug.onShutdown?.();
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
    quarantineThread: () => true,
    recoverThread: () => false,
    getAgentCard: () => ({}) as AgentCard,
    getAugmentRoutes: () => [],
    getAugments: () => [],
  };
  return { kernel, handleInboundCalls, outboundCallbacks };
}

function isAddressInUse(error: unknown): boolean {
  return (
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EADDRINUSE") ||
    (error instanceof Error && /address already in use|port .* in use/i.test(error.message))
  );
}

async function withAvailableWebhookPort<T>(run: (port: number) => Promise<T>): Promise<T> {
  let collision: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const reservation = createServer();
      await new Promise<void>((resolve, reject) => {
        reservation.once("error", reject);
        reservation.listen(0, "127.0.0.1", resolve);
      });
      const address = reservation.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve())),
      );
      if (port === undefined) throw new Error("Telegram webhook port reservation did not bind");
      return await run(port);
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
      collision = error;
    }
  }
  throw collision ?? new Error("could not allocate a Telegram webhook test port");
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
      botToken: "123:test-token",
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
    expect(handleInboundCalls[0]?.trigger.threadId).toBe("tg-bot-123-chat-100");
    expect(handleInboundCalls[0]?.trigger.type).toBe("message");
  });

  it("isolates the same Telegram chat across distinct bot identities", async () => {
    const update: TelegramUpdate = {
      update_id: 90,
      message: {
        message_id: 1,
        chat: { id: 100, type: "private" },
        from: { id: 100, is_bot: false },
        date: 0,
        text: "bot-scoped history",
      },
    };
    let dispatchCount = 0;
    let resolveBothDispatches!: () => void;
    const bothDispatched = new Promise<void>((resolve) => {
      resolveBothDispatches = resolve;
    });
    const instances = [
      { botToken: "111:first-token", name: "telegram-primary" },
      { botToken: "222:second-token", name: "telegram-secondary" },
    ].map(({ botToken, name }) => {
      const { client } = makeMockClient([[update], []]);
      const setup = makeMockKernel({
        handleInbound: async (trigger) => {
          dispatchCount++;
          if (dispatchCount === 2) resolveBothDispatches();
          return {
            turnId: trigger.turnId,
            success: true,
            status: "completed",
            toolCalls: [],
            trace: {} as TurnResult["trace"],
          };
        },
      });
      const aug = telegramTransport({
        botToken,
        inbound: { mode: "polling", polling: { timeoutSec: 0 } },
        auth: {},
        _clientFactory: () => client,
      } as unknown as Parameters<typeof telegramTransport>[0]);
      return { aug, name, setup };
    });

    try {
      for (const { aug, name, setup } of instances) {
        await aug.transport!.register(setup.kernel, name);
        await aug.onBoot?.();
        await aug.transport!.ready?.();
      }
      await bothDispatched;

      const first = instances[0]!.setup.handleInboundCalls[0]!.trigger;
      const second = instances[1]!.setup.handleInboundCalls[0]!.trigger;
      expect(first.threadId).toBe("tg-bot-111-chat-100");
      expect(second.threadId).toBe("tg-bot-222-chat-100");
      expect(first.threadId).not.toBe(second.threadId);
      expect(first.peer?.sourceAugment).toBe("telegram-primary");
      expect(second.peer?.sourceAugment).toBe("telegram-secondary");
      expect(first.payload.sourceAugment).toBe("telegram-primary");
      expect(second.payload.sourceAugment).toBe("telegram-secondary");
    } finally {
      for (const { aug } of instances) await aug.onShutdown?.();
    }
  });

  it("quarantines a non-monotonic polling batch without partial dispatch", async () => {
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
    let info = await aug.adminInfo!();
    for (let attempts = 0; attempts < 20; attempts++) {
      const status = info.sections.at(-1);
      if (status?.kind === "status" && status.level === "error") break;
      await Promise.resolve();
      info = await aug.adminInfo!();
    }
    await aug.onShutdown?.();
    expect(handleInboundCalls).toHaveLength(0);
    expect(info.sections.at(-1)).toMatchObject({ kind: "status", level: "error" });
  });

  it("awaits one shared atomic claim across concurrent transport instances", async () => {
    let claimCalls = 0;
    const claimNamespaces: string[] = [];
    let releaseClaims!: () => void;
    const bothClaimsStarted = new Promise<void>((resolve) => {
      releaseClaims = resolve;
    });
    let settledClaims = 0;
    let releaseSettledClaims!: () => void;
    const bothClaimsSettled = new Promise<void>((resolve) => {
      releaseSettledClaims = resolve;
    });
    let observeDispatch!: () => void;
    const dispatchObserved = new Promise<void>((resolve) => {
      observeDispatch = resolve;
    });
    const claims = new Map<string, string>();
    const sharedStore: TelegramAsyncReplayStore = {
      async claimAsync(namespace, updateId, payloadHash, { signal }) {
        expect(signal.aborted).toBe(false);
        claimCalls++;
        claimNamespaces.push(namespace);
        if (claimCalls === 2) releaseClaims();
        await bothClaimsStarted;
        const key = `${namespace}\0${updateId}`;
        const existing = claims.get(key);
        settledClaims++;
        if (settledClaims === 2) releaseSettledClaims();
        if (existing === undefined) {
          claims.set(key, payloadHash);
          return "claimed";
        }
        return existing === payloadHash ? "duplicate" : "conflict";
      },
      async getConflictAsync() {
        return null;
      },
      async resolveConflictAsync() {
        return false;
      },
    };
    const update = {
      update_id: 92,
      delivery_metadata: [{ sequence: 1, source: "telegram" }, ["nested", null]],
      message: {
        message_id: 1,
        chat: { id: 100, type: "private" },
        from: { id: 100, is_bot: false },
        date: 0,
        text: "one distributed execution",
      },
    } as TelegramUpdate;
    const reorderedUpdate = {
      message: {
        text: "one distributed execution",
        date: 0,
        from: { is_bot: false, id: 100 },
        chat: { type: "private", id: 100 },
        message_id: 1,
      },
      delivery_metadata: [{ source: "telegram", sequence: 1 }, ["nested", null]],
      update_id: 92,
    } as TelegramUpdate;
    const instances = ["telegram-primary", "telegram-secondary"].map((name, index) => {
      const { client } = makeMockClient([[index === 0 ? update : reorderedUpdate], []]);
      const setup = makeMockKernel({
        handleInbound: async (trigger) => {
          observeDispatch();
          return {
            turnId: trigger.turnId,
            success: true,
            status: "completed",
            toolCalls: [],
            trace: {} as TurnResult["trace"],
          };
        },
      });
      const aug = telegramTransport({
        botToken: "333:shared-token",
        inbound: { mode: "polling", polling: { timeoutSec: 0 } },
        auth: {},
        replay: { store: sharedStore },
        _clientFactory: () => client,
      } as unknown as Parameters<typeof telegramTransport>[0]);
      return { aug, name, setup };
    });

    try {
      for (const { aug, name, setup } of instances) {
        await aug.transport!.register(setup.kernel, name);
        await aug.onBoot?.();
        await aug.transport!.ready?.();
      }
      await Promise.all([bothClaimsSettled, dispatchObserved]);

      expect(instances.reduce((sum, { setup }) => sum + setup.handleInboundCalls.length, 0)).toBe(
        1,
      );
      expect(claimCalls).toBe(2);
      expect(new Set(claimNamespaces)).toEqual(new Set(["telegram:bot-333"]));
    } finally {
      for (const { aug } of instances) await aug.onShutdown?.();
    }
  });

  it("resumes a quarantined replica after another replica performs exact recovery", async () => {
    const baseStore = createInMemoryTelegramReplayStore();
    let conflictObserved!: () => void;
    const conflictReady = new Promise<void>((resolve) => {
      conflictObserved = resolve;
    });
    const sharedStore: TelegramReplayStore = {
      claim(namespace, updateId, payloadHash) {
        const result = baseStore.claim(namespace, updateId, payloadHash);
        if (result === "conflict") conflictObserved();
        return result;
      },
      getConflict: (namespace) => baseStore.getConflict(namespace),
      resolveConflict: (namespace, conflictId) => baseStore.resolveConflict(namespace, conflictId),
    };
    const canonical: TelegramUpdate = {
      update_id: 10,
      message: {
        message_id: 1,
        chat: { id: 100, type: "private" },
        from: { id: 100, is_bot: false },
        date: 0,
        text: "canonical",
      },
    };
    const conflicting: TelegramUpdate = {
      ...canonical,
      message: { ...canonical.message!, text: "conflicting" },
    };
    const later: TelegramUpdate = {
      ...canonical,
      update_id: 11,
      message: { ...canonical.message!, message_id: 2, text: "later" },
    };

    let firstCalls = 0;
    const firstClient = makeMockClient([[canonical], []]).client;
    const firstSetup = makeMockKernel();
    const first = telegramTransport({
      botToken: "777:shared-token",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: {},
      replay: { store: sharedStore },
      _clientFactory: () => firstClient,
    } as unknown as Parameters<typeof telegramTransport>[0]);
    firstSetup.kernel.handleInbound = async (trigger) => {
      firstCalls++;
      return {
        turnId: trigger.turnId,
        success: true,
        status: "completed",
        toolCalls: [],
        trace: {} as TurnResult["trace"],
      };
    };
    await first.transport!.register(firstSetup.kernel, "telegram-primary");
    await first.onBoot?.();
    await first.transport!.ready?.();
    while (firstCalls < 1) await Promise.resolve();
    await first.onShutdown?.();

    let batchCalls = 0;
    let laterDispatched!: () => void;
    const laterReady = new Promise<void>((resolve) => {
      laterDispatched = resolve;
    });
    const secondClient: TelegramBotClient = {
      ...makeMockClient([]).client,
      async getUpdates(options) {
        batchCalls++;
        if (batchCalls <= 2) return [conflicting, later];
        return await new Promise<TelegramUpdate[]>((_, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        });
      },
    };
    const secondSetup = makeMockKernel({
      handleInbound: async (trigger) => {
        laterDispatched();
        return {
          turnId: trigger.turnId,
          success: true,
          status: "completed",
          toolCalls: [],
          trace: {} as TurnResult["trace"],
        };
      },
    });
    const second = telegramTransport({
      botToken: "777:shared-token",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: {},
      replay: { store: sharedStore },
      _clientFactory: () => secondClient,
      _replayConflictCheckMs: 1,
    } as unknown as Parameters<typeof telegramTransport>[0]);
    const recoveryReplica = telegramTransport({
      botToken: "777:shared-token",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: {},
      replay: { store: sharedStore },
      _clientFactory: () => makeMockClient([[]]).client,
      _replayConflictCheckMs: 1,
    } as unknown as Parameters<typeof telegramTransport>[0]);

    try {
      await second.transport!.register(secondSetup.kernel, "telegram-secondary");
      await second.onBoot?.();
      await second.transport!.ready?.();
      await conflictReady;
      await recoveryReplica.onBoot?.();

      const conflict = sharedStore.getConflict("telegram:bot-777");
      expect(conflict).not.toBeNull();
      expect(batchCalls).toBe(1);
      expect(secondSetup.handleInboundCalls).toHaveLength(0);
      const info = await recoveryReplica.adminInfo!();
      expect(info.sections.at(-1)).toMatchObject({ kind: "status", level: "error" });
      const action = info.actions![0]!;
      const stale = await recoveryReplica.adminActions![action.id]!({ incident: "stale-id" });
      expect(stale.ok).toBe(false);

      const recovered = await recoveryReplica.adminActions![action.id]!({
        incident: conflict!.id,
      });
      expect(recovered.ok).toBe(true);
      await laterReady;
      expect(batchCalls).toBe(2);
      expect(secondSetup.handleInboundCalls).toHaveLength(1);
      expect(secondSetup.handleInboundCalls[0]!.trigger.payload.parts).toEqual([
        { kind: "text", text: "later" },
      ]);
    } finally {
      await second.onShutdown?.();
      await recoveryReplica.onShutdown?.();
      baseStore.close?.();
    }
  });

  it("scopes recovery action ids per replay namespace", async () => {
    const augments = ["801:first", "802:second"].map((botToken, index) => ({
      ...telegramTransport({
        botToken,
        inbound: { mode: "polling", polling: { timeoutSec: 0 } },
        auth: {},
        _clientFactory: () => makeMockClient([[]]).client,
      } as unknown as Parameters<typeof telegramTransport>[0]),
      // Resolver-mounted augments always carry their configured unique name.
      name: `telegram-${index + 1}`,
    }));

    try {
      for (const augment of augments) await augment.onBoot?.();
      const registry = await buildAdminActionRegistry(augments);
      expect(registry.size).toBe(2);
      expect(
        [...registry.values()].every((entry) =>
          entry.actionId.startsWith("telegram-conflict-recover-"),
        ),
      ).toBe(true);
    } finally {
      for (const augment of augments) await augment.onShutdown?.();
    }
  });

  it("does not poll after restart until persisted replay quarantine is recovered", async () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-quarantine-restart-"));
    const dbPath = join(root, "replay.db");
    const seed = createSqliteTelegramReplayStore({
      dbPath,
      randomUUID: () => "persisted-restart-incident",
    });
    seed.claim("telegram:bot-804", 50, "a".repeat(64));
    seed.claim("telegram:bot-804", 50, "b".repeat(64));
    seed.close?.();

    const reopened = createSqliteTelegramReplayStore({ dbPath });
    let pollCalls = 0;
    let pollStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      pollStarted = resolve;
    });
    const client: TelegramBotClient = {
      ...makeMockClient([]).client,
      async getUpdates(options) {
        pollCalls++;
        pollStarted();
        return await new Promise<TelegramUpdate[]>((_, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        });
      },
    };
    const setup = makeMockKernel();
    const aug = telegramTransport({
      botToken: "804:test",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: {},
      replay: { store: reopened },
      _clientFactory: () => client,
      _replayConflictCheckMs: 1,
    } as unknown as Parameters<typeof telegramTransport>[0]);

    try {
      await aug.transport!.register(setup.kernel, "telegram-restarted");
      await aug.onBoot?.();
      await aug.transport!.ready?.();
      const info = await aug.adminInfo!();
      expect(info.sections.at(-1)).toMatchObject({ kind: "status", level: "error" });
      expect(pollCalls).toBe(0);

      const action = info.actions![0]!;
      expect(
        await aug.adminActions![action.id]!({ incident: "persisted-restart-incident" }),
      ).toMatchObject({ ok: true });
      await started;
      expect(pollCalls).toBe(1);
    } finally {
      await aug.onShutdown?.();
      reopened.close?.();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails boot for an async shared store without conflict recovery capability", async () => {
    const { client } = makeMockClient([[]]);
    const aug = telegramTransport({
      botToken: "778:test",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: {},
      replay: {
        store: {
          async claimAsync() {
            return "claimed";
          },
        } as unknown as TelegramAsyncReplayStore,
      },
      _clientFactory: () => client,
    } as unknown as Parameters<typeof telegramTransport>[0]);

    await expect(aug.onBoot?.()).rejects.toThrow("conflict-capable");
  });

  it("sanitizes async replay-store inspection and recovery failures", async () => {
    const sentinel = "postgres://user:secret@store.example/replay";
    const inspectionFailure = telegramTransport({
      botToken: "805:test",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: {},
      replay: {
        store: {
          async claimAsync() {
            return "claimed";
          },
          async getConflictAsync() {
            throw new Error(sentinel);
          },
          async resolveConflictAsync() {
            return false;
          },
        },
      },
      _clientFactory: () => makeMockClient([[]]).client,
    } as unknown as Parameters<typeof telegramTransport>[0]);
    try {
      await inspectionFailure.onBoot?.();
      throw new Error("expected inspection failure");
    } catch (error) {
      expect((error as Error).message).toBe("Telegram replay conflict inspection failed.");
      expect(Bun.inspect(error)).not.toContain(sentinel);
    } finally {
      await inspectionFailure.onShutdown?.();
    }

    const conflict = { id: "safe-incident", updateId: 1, detectedAt: 1 };
    const recoveryFailure = telegramTransport({
      botToken: "806:test",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: {},
      replay: {
        store: {
          async claimAsync() {
            return "quarantined";
          },
          async getConflictAsync() {
            return conflict;
          },
          async resolveConflictAsync() {
            throw new Error(sentinel);
          },
        },
      },
      _clientFactory: () => makeMockClient([[]]).client,
    } as unknown as Parameters<typeof telegramTransport>[0]);
    try {
      await recoveryFailure.onBoot?.();
      const info = await recoveryFailure.adminInfo!();
      const action = info.actions![0]!;
      await recoveryFailure.adminActions![action.id]!({ incident: conflict.id });
      throw new Error("expected recovery failure");
    } catch (error) {
      expect((error as Error).message).toBe("Telegram replay conflict recovery failed.");
      expect(Bun.inspect(error)).not.toContain(sentinel);
    } finally {
      await recoveryFailure.onShutdown?.();
    }
  });

  it("fails closed when an async replay store returns an invalid claim", async () => {
    const update: TelegramUpdate = {
      update_id: 93,
      message: {
        message_id: 1,
        chat: { id: 100, type: "private" },
        from: { id: 100, is_bot: false },
        date: 0,
        text: "must not dispatch",
      },
    };
    let observeClaim!: () => void;
    const claimObserved = new Promise<void>((resolve) => {
      observeClaim = resolve;
    });
    const { client } = makeMockClient([[update], []]);
    const setup = makeMockKernel();
    const aug = telegramTransport({
      botToken: "T",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: {},
      replay: {
        namespace: "invalid-store-test",
        store: {
          async claimAsync() {
            observeClaim();
            return "unexpected" as "claimed";
          },
          async getConflictAsync() {
            return null;
          },
          async resolveConflictAsync() {
            return false;
          },
        },
      },
      _clientFactory: () => client,
    } as unknown as Parameters<typeof telegramTransport>[0]);
    await aug.transport!.register(setup.kernel, "telegram-transport");
    await aug.onBoot?.();
    await aug.transport!.ready?.();
    await claimObserved;
    await aug.onShutdown?.();

    expect(setup.handleInboundCalls).toHaveLength(0);
  });

  it("aborts a stalled async replay claim during shutdown without dispatch", async () => {
    const update: TelegramUpdate = {
      update_id: 94,
      message: {
        message_id: 1,
        chat: { id: 100, type: "private" },
        from: { id: 100, is_bot: false },
        date: 0,
        text: "must not outlive shutdown",
      },
    };
    let observeClaim!: (signal: AbortSignal) => void;
    const claimObserved = new Promise<AbortSignal>((resolve) => {
      observeClaim = resolve;
    });
    const { client } = makeMockClient([[update], []]);
    const setup = makeMockKernel();
    const aug = telegramTransport({
      botToken: "T",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: {},
      replay: {
        namespace: "stalled-store-test",
        store: {
          async claimAsync(
            _namespace: string,
            _updateId: number,
            _payloadHash: string,
            options: TelegramReplayClaimOptions,
          ) {
            observeClaim(options.signal);
            return new Promise<"claimed">(() => {});
          },
          async getConflictAsync() {
            return null;
          },
          async resolveConflictAsync() {
            return false;
          },
        },
      },
      _clientFactory: () => client,
    } as unknown as Parameters<typeof telegramTransport>[0]);
    await aug.transport!.register(setup.kernel, "telegram-transport");
    await aug.onBoot?.();
    await aug.transport!.ready?.();
    const signal = await claimObserved;
    await aug.onShutdown?.();

    expect(signal.aborted).toBe(true);
    expect(setup.handleInboundCalls).toHaveLength(0);
  });

  it("propagates shutdown cancellation to an in-flight kernel turn", async () => {
    const update: TelegramUpdate = {
      update_id: 95,
      message: {
        message_id: 1,
        chat: { id: 100, type: "private" },
        from: { id: 100, is_bot: false },
        date: 0,
        text: "cancel on shutdown",
      },
    };
    let observeTurn!: (signal: AbortSignal) => void;
    const turnObserved = new Promise<AbortSignal>((resolve) => {
      observeTurn = resolve;
    });
    const { client } = makeMockClient([[update], []]);
    const setup = makeMockKernel({
      handleInbound: async (trigger, options) => {
        const signal = options?.signal;
        if (!signal) throw new Error("expected lifecycle signal");
        observeTurn(signal);
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          turnId: trigger.turnId,
          success: false,
          status: "canceled",
          toolCalls: [],
          trace: {} as TurnResult["trace"],
        };
      },
    });
    const aug = telegramTransport({
      botToken: "T",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: {},
      _clientFactory: () => client,
    } as unknown as Parameters<typeof telegramTransport>[0]);
    await aug.transport!.register(setup.kernel, "telegram-transport");
    await aug.onBoot?.();
    await aug.transport!.ready?.();
    const signal = await turnObserved;
    await aug.onShutdown?.();

    expect(signal.aborted).toBe(true);
    expect(setup.handleInboundCalls).toHaveLength(1);
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

  it("rejects an empty webhook secret before network validation or setup", async () => {
    let getChatCalls = 0;
    let setWebhookCalls = 0;
    const client: TelegramBotClient = {
      async sendMessage(chatId) {
        return { messageId: 1, chatId };
      },
      async getUpdates() {
        return [];
      },
      async setWebhook() {
        setWebhookCalls++;
      },
      async deleteWebhook() {},
      async getChat(chatId) {
        getChatCalls++;
        return { id: Number(chatId), type: "private" };
      },
    };
    const aug = telegramTransport({
      botToken: "123:test-token",
      inbound: {
        mode: "webhook",
        webhook: {
          publicUrl: "https://example.test/telegram",
          secretToken: "",
        },
      },
      auth: { admittedAgents: [{ id: "agent", telegramUserId: 1 }] },
      _clientFactory: () => client,
    } as unknown as Parameters<typeof telegramTransport>[0]);

    await expect(aug.onBoot?.()).rejects.toThrow("must contain 1 to 256");
    expect(getChatCalls).toBe(0);
    expect(setWebhookCalls).toBe(0);
    await aug.onShutdown?.();
  });

  it("quarantines webhook conflicts until exact operator recovery", async () => {
    const replayStore = createInMemoryTelegramReplayStore();
    const { client } = makeMockClient([]);
    const setup = makeMockKernel();
    const { aug, port } = await withAvailableWebhookPort(async (candidatePort) => {
      const candidate = telegramTransport({
        botToken: "803:test-token",
        inbound: {
          mode: "webhook",
          webhook: {
            publicUrl: "https://example.test/telegram",
            port: candidatePort,
            secretToken: "secret",
          },
        },
        auth: {},
        replay: { store: replayStore },
        _clientFactory: () => client,
      } as unknown as Parameters<typeof telegramTransport>[0]);
      try {
        await candidate.transport!.register(setup.kernel, "telegram-primary");
        await candidate.onBoot?.();
        await candidate.transport!.ready?.();
        return { aug: candidate, port: candidatePort };
      } catch (error) {
        await candidate.onShutdown?.();
        throw error;
      }
    });
    const canonical: TelegramUpdate = {
      update_id: 40,
      message: {
        message_id: 1,
        chat: { id: 803, type: "private" },
        from: { id: 803, is_bot: false },
        date: 0,
        text: "canonical",
      },
    };
    const conflicting: TelegramUpdate = {
      ...canonical,
      message: { ...canonical.message!, text: "conflicting" },
    };
    const later: TelegramUpdate = {
      ...canonical,
      update_id: 41,
      message: { ...canonical.message!, message_id: 2, text: "later" },
    };
    const deliver = (body: TelegramUpdate) =>
      fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "secret",
        },
        body: JSON.stringify(body),
      });

    try {
      expect((await deliver(canonical)).status).toBe(200);
      expect((await deliver(conflicting)).status).toBe(409);
      expect((await deliver(later)).status).toBe(409);
      expect(setup.handleInboundCalls).toHaveLength(1);

      const conflict = replayStore.getConflict("telegram:bot-803");
      const info = await aug.adminInfo!();
      expect(info.sections.at(-1)).toMatchObject({ kind: "status", level: "error" });
      const action = info.actions![0]!;
      expect(await aug.adminActions![action.id]!({ incident: conflict!.id })).toMatchObject({
        ok: true,
      });

      expect((await deliver(conflicting)).status).toBe(200);
      expect((await deliver(later)).status).toBe(200);
      expect(setup.handleInboundCalls).toHaveLength(2);
      expect(setup.handleInboundCalls[1]!.trigger.payload.parts).toEqual([
        { kind: "text", text: "later" },
      ]);
    } finally {
      await aug.onShutdown?.();
      replayStore.close?.();
    }
  });

  it("keeps concurrent same-chat reply routing until both turns settle", async () => {
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
    const { aug, port } = await withAvailableWebhookPort(async (candidatePort) => {
      const candidate = telegramTransport({
        botToken: "T",
        inbound: {
          mode: "webhook",
          webhook: {
            publicUrl: "https://example.test/telegram",
            port: candidatePort,
            secretToken: "secret",
          },
        },
        auth: {},
        _clientFactory: () => client,
      } as unknown as Parameters<typeof telegramTransport>[0]);
      try {
        await candidate.transport!.register(setup.kernel, "telegram-transport");
        await candidate.onBoot?.();
        await candidate.transport!.ready?.();
        return { aug: candidate, port: candidatePort };
      } catch (error) {
        await candidate.onShutdown?.();
        throw error;
      }
    });
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
    const { aug, port, readyError } = await withAvailableWebhookPort(async (candidatePort) => {
      const candidate = telegramTransport({
        botToken: "T",
        inbound: {
          mode: "webhook",
          webhook: {
            publicUrl: "https://example.test/telegram",
            port: candidatePort,
            secretToken: "secret",
          },
        },
        auth: {},
        _clientFactory: () => client,
      } as unknown as Parameters<typeof telegramTransport>[0]);
      await candidate.onBoot?.();
      await candidate.transport!.register(kernel, "telegram-transport");
      try {
        await candidate.transport!.ready?.();
        return { aug: candidate, port: candidatePort, readyError: undefined };
      } catch (error) {
        if (isAddressInUse(error)) {
          await candidate.onShutdown?.();
          throw error;
        }
        return { aug: candidate, port: candidatePort, readyError: error };
      }
    });

    expect(() => {
      throw readyError;
    }).toThrow("telegram unavailable");
    expect(deleteCalls).toBe(1);

    const replacement = Bun.serve({ port, fetch: () => new Response("ok") });
    replacement.stop(true);
    await aug.onShutdown?.();
  });
});
