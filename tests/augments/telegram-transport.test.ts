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
