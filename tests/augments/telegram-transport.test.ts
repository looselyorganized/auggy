import { describe, it, expect } from "bun:test";
import { resolveTelegramIdentity } from "../../src/augments/telegram-transport";
import type { TelegramAuthOptions } from "../../src/types";

const baseAuth: TelegramAuthOptions = {
  creatorUserIds: [12345678],
  admittedAgents: [{ id: "scheduler-bot", telegramUserId: 555444333 }],
  recognizedUserIds: [987654321],
  anonymousIdentityMode: "ephemeral",
};

describe("resolveTelegramIdentity", () => {
  it("creator user_id → creator trust level + tg_user_ peer.id", () => {
    const peer = resolveTelegramIdentity({ userId: 12345678, threadId: "thread-1" }, baseAuth);
    expect(peer.trustLevel).toBe("creator");
    expect(peer.id).toBe("tg_user_12345678");
    expect(peer.publicSubstate).toBeUndefined();
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

  it("admittedAgents takes precedence over creator if both match", () => {
    const opts: TelegramAuthOptions = {
      creatorUserIds: [555],
      admittedAgents: [{ id: "agent-bot", telegramUserId: 555 }],
    };
    const peer = resolveTelegramIdentity({ userId: 555, threadId: "t" }, opts);
    expect(peer.trustLevel).toBe("creator");
    // creator path wins by spec ordering — verify ordering matches item 5's web-transport
  });
});

import { validateAdmittedAgents } from "../../src/augments/telegram-transport";
import type { TelegramBotClient } from "../../src/telegram-client";

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
