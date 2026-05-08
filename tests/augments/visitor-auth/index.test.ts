import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visitorAuth } from "../../../src/augments/visitor-auth";
import { createSqliteVisitorAuthStore } from "../../../src/augments/visitor-auth/storage/sqlite-store";
import type { AgentMailClient } from "../../../src/agentmail-client";
import type { TurnState, ToolExecuteContext, ContextBlock } from "../../../src/types";

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "visitor-auth-aug-"));
  dbPath = join(tmp, "visitor-auth.db");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function fakeAgentMail(overrides: Partial<AgentMailClient> = {}): AgentMailClient {
  return {
    send: async () => ({ status: "sent", messageId: "m", threadId: "t" }),
    getInbox: async () => ({ inboxId: "i", status: "ok" }),
    ...overrides,
  } as AgentMailClient;
}

describe("visitorAuth (skeleton)", () => {
  test("factory returns an Augment with name + capabilities + httpRoutes", () => {
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    expect(aug.name).toBe("visitor-auth");
    expect(aug.capabilities).toContain("tools");
    expect(aug.capabilities).toContain("context");
    expect(aug.httpRoutes).toHaveLength(2);
    // GET route: confirm page (does not consume token — survives mail-scanner prefetch).
    expect(aug.httpRoutes?.[0]?.path).toBe("/visitor-auth/verify");
    expect(aug.httpRoutes?.[0]?.auth).toBe("none");
    expect(aug.httpRoutes?.[0]?.method).toBe("GET");
    // POST route: consumes the token and mints the vis_ visitor token.
    expect(aug.httpRoutes?.[1]?.path).toBe("/visitor-auth/verify");
    expect(aug.httpRoutes?.[1]?.auth).toBe("none");
    expect(aug.httpRoutes?.[1]?.method).toBe("POST");
  });

  test("factory throws for missing publicUrl", () => {
    expect(() =>
      visitorAuth({
        publicUrl: "",
        dbPath,
        agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
        signingKey: "sig",
        _agentMailClient: fakeAgentMail(),
      }),
    ).toThrow(/publicUrl/);
  });

  test("factory throws for malformed publicUrl", () => {
    expect(() =>
      visitorAuth({
        publicUrl: "not-a-url",
        dbPath,
        agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
        signingKey: "sig",
        _agentMailClient: fakeAgentMail(),
      }),
    ).toThrow(/is not a valid URL/);
  });

  test("factory throws with protocol-specific error for non-http(s) publicUrl", () => {
    expect(() =>
      visitorAuth({
        publicUrl: "ftp://example.com",
        dbPath,
        agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
        signingKey: "sig",
        _agentMailClient: fakeAgentMail(),
      }),
    ).toThrow(/must use http:\/\/ or https:\/\//);
  });

  test("factory throws for missing AgentMail config", () => {
    expect(() =>
      visitorAuth({
        publicUrl: "https://example.com",
        dbPath,
        agentMail: { apiKey: "", inboxId: "" },
        signingKey: "sig",
        _agentMailClient: fakeAgentMail(),
      }),
    ).toThrow(/agentMail/);
  });

  test("factory throws for missing signingKey", () => {
    expect(() =>
      visitorAuth({
        publicUrl: "https://example.com",
        dbPath,
        agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
        signingKey: "",
        _agentMailClient: fakeAgentMail(),
      }),
    ).toThrow(/signingKey/);
  });

  test("onBoot calls AgentMail.getInbox; warns on failure but does not throw", async () => {
    let getInboxCalls = 0;
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail({
        getInbox: async () => {
          getInboxCalls++;
          return { status: "failed", detail: "503 unavailable", httpStatus: 503 };
        },
      }),
    });
    await aug.onBoot?.();
    expect(getInboxCalls).toBe(1);
    await aug.onShutdown?.();
  });

  test("onBoot succeeds when AgentMail.getInbox returns ok", async () => {
    let calls = 0;
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail({
        getInbox: async () => {
          calls++;
          return { inboxId: "ibx_x", status: "ok" };
        },
      }),
    });
    await aug.onBoot?.();
    expect(calls).toBe(1);
    await aug.onShutdown?.();
  });

  test("onBoot throws when AgentMail config env-vars are blatantly placeholder", async () => {
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "${AGENTMAIL_API_KEY}", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    await expect(aug.onBoot?.()).rejects.toThrow(/AGENTMAIL_API_KEY/);
  });

  test("context() returns an empty array when no peer is set", async () => {
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    const turn = {
      turnId: "t1",
      threadId: "th1",
      trigger: { type: "message", turnId: "t1", timestamp: 0, payload: {} },
      peer: null,
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never;
    const result = await aug.context?.(turn);
    expect(result).toEqual([]);
    await aug.onShutdown?.();
  });
});

describe("request_auth tool", () => {
  function buildAug(overrides?: {
    sendImpl?: AgentMailClient["send"];
    rateLimit?: { perHour: number; perDay: number };
    nowFn?: () => number;
  }) {
    const sendCalls: Array<Parameters<AgentMailClient["send"]>[0]> = [];
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      rateLimit: overrides?.rateLimit ?? { perHour: 1, perDay: 3 },
      _now: overrides?.nowFn,
      _agentMailClient: fakeAgentMail({
        send: async (input) => {
          sendCalls.push(input);
          if (overrides?.sendImpl) return overrides.sendImpl(input);
          return { status: "sent", messageId: "m1", threadId: "t1" };
        },
      }),
    });
    return { aug, sendCalls };
  }

  function turnWithVisitor(text: string, peerId = "anon-thread1") {
    return {
      turnId: "tu",
      threadId: "thread1",
      trigger: {
        type: "message",
        turnId: "tu",
        timestamp: 0,
        peer: {
          id: peerId,
          kind: "anonymous",
          trustLevel: "public",
          publicSubstate: "anonymous",
          sourceAugment: "web",
        },
        payload: {
          parts: [{ kind: "text", text }],
          sourceAugment: "web",
          peer: {
            id: peerId,
            kind: "anonymous",
            trustLevel: "public",
            publicSubstate: "anonymous",
            sourceAugment: "web",
          },
          timestamp: 0,
        },
      },
      peer: {
        id: peerId,
        kind: "anonymous",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      },
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never;
  }

  test("rejects non-email methods", async () => {
    const { aug } = buildAug();
    await aug.onBoot?.();
    const tool = aug.tools![0]!;
    const raw = await tool.execute(
      { method: "sms" as never, email: "alice@example.com" },
      {
        turnId: "t1",
        threadId: "th1",
        peer: {
          id: "anon-th1",
          kind: "anonymous",
          trustLevel: "public",
          publicSubstate: "anonymous",
          sourceAugment: "web",
        },
      },
    );
    const result = JSON.parse(raw as string);
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/method/);
    await aug.onShutdown?.();
  });

  test("rejects malformed email", async () => {
    const { aug } = buildAug();
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("hi"));
    const raw = await aug.tools![0]!.execute(
      { method: "email", email: "not-an-email" },
      {
        turnId: "t1",
        threadId: "thread1",
        peer: {
          id: "anon-thread1",
          kind: "anonymous",
          trustLevel: "public",
          publicSubstate: "anonymous",
          sourceAugment: "web",
        },
      },
    );
    expect(JSON.parse(raw as string).status).toBe("rejected");
    await aug.onShutdown?.();
  });

  test("rejects when email did not appear in recent messages (fix #4)", async () => {
    const { aug } = buildAug();
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("hi I'm here"));
    const raw = await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      {
        turnId: "t1",
        threadId: "thread1",
        peer: {
          id: "anon-thread1",
          kind: "anonymous",
          trustLevel: "public",
          publicSubstate: "anonymous",
          sourceAugment: "web",
        },
      },
    );
    const result = JSON.parse(raw as string);
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/recent|message/i);
    await aug.onShutdown?.();
  });

  test("happy path: returns status 'sent', calls AgentMail with verify URL", async () => {
    const { aug, sendCalls } = buildAug();
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("my email is alice@example.com"));
    const raw = await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      {
        turnId: "t1",
        threadId: "thread1",
        peer: {
          id: "anon-thread1",
          kind: "anonymous",
          trustLevel: "public",
          publicSubstate: "anonymous",
          sourceAugment: "web",
        },
      },
    );
    const result = JSON.parse(raw as string);
    expect(result.status).toBe("sent");
    expect(result.expiresInSec).toBeGreaterThan(0);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.to).toEqual(["alice@example.com"]);
    expect(sendCalls[0]?.text).toMatch(/https:\/\/zip\.test\/visitor-auth\/verify\?token=/);
    expect(sendCalls[0]?.subject).toMatch(/verify/i);
    await aug.onShutdown?.();
  });

  test("rate-limit blocks 2nd send within the hour (keyed to email, not peer.id)", async () => {
    // Fix H1: the rate limit is now keyed to the EMAIL address, not the peer.id.
    // This test proves threadId rotation no longer bypasses the limit:
    // the second call uses a DIFFERENT peer.id but the SAME email — and is rejected.
    const { aug } = buildAug({ rateLimit: { perHour: 1, perDay: 3 } });
    await aug.onBoot?.();

    // First call from peer anon-thread1.
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com", "anon-thread1"));
    const ctx1: ToolExecuteContext = {
      turnId: "t",
      threadId: "thread1",
      peer: {
        id: "anon-thread1",
        kind: "anonymous",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      },
    };
    const first = JSON.parse(
      (await aug.tools![0]!.execute(
        { method: "email", email: "alice@example.com" },
        ctx1,
      )) as string,
    );
    expect(first.status).toBe("sent");

    // Second call from a DIFFERENT peer (rotated threadId) — same email → rejected.
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com", "anon-thread-ROTATED"));
    const ctx2: ToolExecuteContext = {
      turnId: "t2",
      threadId: "thread-ROTATED",
      peer: {
        id: "anon-thread-ROTATED",
        kind: "anonymous",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      },
    };
    const second = JSON.parse(
      (await aug.tools![0]!.execute(
        { method: "email", email: "alice@example.com" },
        ctx2,
      )) as string,
    );
    expect(second.status).toBe("rejected");
    expect(second.message).toMatch(/limit|wait/i);
    await aug.onShutdown?.();
  });

  test("different emails from the same peer don't share rate-limit quota", async () => {
    // Fix H1: per-email keying means alice and bob each get their own quota.
    // The same peer can send to two different emails without hitting the limit
    // (as long as each email is within its own per-email budget).
    const { aug, sendCalls } = buildAug({ rateLimit: { perHour: 1, perDay: 3 } });
    await aug.onBoot?.();
    const ctx: ToolExecuteContext = {
      turnId: "t",
      threadId: "thread1",
      peer: {
        id: "anon-thread1",
        kind: "anonymous",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      },
    };

    // First email: alice. Include both addresses in the recent messages.
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com bob@example.com"));
    const r1 = JSON.parse(
      (await aug.tools![0]!.execute({ method: "email", email: "alice@example.com" }, ctx)) as string,
    );
    expect(r1.status).toBe("sent");

    // Second email: bob (different address, same peer). Also within bob's own hourly quota.
    const r2 = JSON.parse(
      (await aug.tools![0]!.execute({ method: "email", email: "bob@example.com" }, ctx)) as string,
    );
    expect(r2.status).toBe("sent");
    expect(sendCalls).toHaveLength(2);
    await aug.onShutdown?.();
  });

  test("AgentMail send failure returns status 'failed' with detail (fix #7)", async () => {
    const { aug } = buildAug({
      sendImpl: async () => ({ status: "failed", detail: "smtp blew up", httpStatus: 500 }),
    });
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com"));
    const raw = await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      {
        turnId: "t",
        threadId: "thread1",
        peer: {
          id: "anon-thread1",
          kind: "anonymous" as const,
          trustLevel: "public" as const,
          publicSubstate: "anonymous" as const,
          sourceAugment: "web",
        },
      },
    );
    const result = JSON.parse(raw as string);
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/smtp blew up/);
    await aug.onShutdown?.();
  });

  test("issuing a new token invalidates a prior open token for the same peer", async () => {
    const { aug, sendCalls } = buildAug({ rateLimit: { perHour: 5, perDay: 10 } });
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com"));
    const ctx: ToolExecuteContext = {
      turnId: "t",
      threadId: "thread1",
      peer: {
        id: "anon-thread1",
        kind: "anonymous",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      },
    };
    await aug.tools![0]!.execute({ method: "email", email: "alice@example.com" }, ctx);
    await aug.tools![0]!.execute({ method: "email", email: "alice@example.com" }, ctx);
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0]?.text).not.toEqual(sendCalls[1]?.text); // tokens differ
    await aug.onShutdown?.();
  });

  test("requires a peer in tool context (defense)", async () => {
    const { aug } = buildAug();
    await aug.onBoot?.();
    await aug.onTurnStart?.(turnWithVisitor("alice@example.com"));
    const raw = await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      { turnId: "t", threadId: "thread1", peer: null },
    );
    const result = JSON.parse(raw as string);
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/peer/i);
    await aug.onShutdown?.();
  });
});

describe("context() block", () => {
  test("emits no block for an unknown peer with no token + no verified row", async () => {
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    const peer = {
      id: "anon-x",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    const result = await aug.context?.({ peer } as never);
    expect(result).toEqual([]);
    await aug.onShutdown?.();
  });

  test("emits 'awaiting click' block while token is open", async () => {
    let clock = 1_700_000_000_000;
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      tokenTtlMinutes: 15,
      _now: () => clock,
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    const peer = {
      id: "anon-c1",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    await aug.onTurnStart?.({
      turnId: "t",
      threadId: "th",
      trigger: {
        type: "message",
        turnId: "t",
        timestamp: 0,
        payload: {
          parts: [{ kind: "text", text: "alice@example.com" }],
          sourceAugment: "web",
          peer,
          timestamp: 0,
        },
      },
      peer,
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never);
    await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      { turnId: "t", threadId: "th", peer },
    );
    clock += 3 * 60_000;
    const result = (await aug.context?.({ peer } as never)) as ContextBlock[];
    expect(result).toHaveLength(1);
    expect(result![0]?.content).toMatch(/alice@example\.com/);
    expect(result![0]?.content.toLowerCase()).toMatch(/awaiting|sent|expires/);
    await aug.onShutdown?.();
  });

  test("emits 'expired' block when token TTL has passed", async () => {
    let clock = 1_700_000_000_000;
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      tokenTtlMinutes: 1,
      _now: () => clock,
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    const peer = {
      id: "anon-c2",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    await aug.onTurnStart?.({
      turnId: "t",
      threadId: "th",
      trigger: {
        type: "message",
        turnId: "t",
        timestamp: 0,
        payload: {
          parts: [{ kind: "text", text: "alice@example.com" }],
          sourceAugment: "web",
          peer,
          timestamp: 0,
        },
      },
      peer,
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never);
    await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      { turnId: "t", threadId: "th", peer },
    );
    clock += 5 * 60_000;
    const result = (await aug.context?.({ peer } as never)) as ContextBlock[];
    expect(result).toHaveLength(1);
    expect(result![0]?.content.toLowerCase()).toContain("expired");
    await aug.onShutdown?.();
  });

  test("emits 'verified' block when peer matches a verified-visitor row", async () => {
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    const peerId = "vis_aaaa";
    const { createSqliteVisitorAuthStore } = await import(
      "../../../src/augments/visitor-auth/storage/sqlite-store"
    );
    const seedStore = createSqliteVisitorAuthStore({ dbPath });
    seedStore.initialize();
    const t = Date.now();
    seedStore.recordVerifiedVisitor({
      visitorId: peerId,
      email: "alice@example.com",
      verifiedAt: t - 60_000,
      lastSeenAt: t - 60_000,
      reverifyDueAt: t + 90 * 86_400_000,
      revoked: false,
      revokedAt: null,
      revokedReason: null,
    });
    seedStore.close();
    const peer = {
      id: peerId,
      kind: "human" as const,
      trustLevel: "public" as const,
      publicSubstate: "recognized" as const,
      sourceAugment: "web",
    };
    const result = (await aug.context?.({ peer } as never)) as ContextBlock[];
    expect(result).toHaveLength(1);
    expect(result![0]?.content).toMatch(/alice@example\.com/);
    expect(result![0]?.content.toLowerCase()).toContain("verified");
    await aug.onShutdown?.();
  });

  test("emits 'reverify due' block when reverify_due_at is in the past", async () => {
    const clock = 1_700_000_000_000;
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _now: () => clock,
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    const { createSqliteVisitorAuthStore } = await import(
      "../../../src/augments/visitor-auth/storage/sqlite-store"
    );
    const seedStore = createSqliteVisitorAuthStore({ dbPath });
    seedStore.initialize();
    seedStore.recordVerifiedVisitor({
      visitorId: "vis_old",
      email: "stale@x",
      verifiedAt: clock - 100 * 86_400_000,
      lastSeenAt: null,
      reverifyDueAt: clock - 86_400_000,
      revoked: false,
      revokedAt: null,
      revokedReason: null,
    });
    seedStore.close();
    const peer = {
      id: "vis_old",
      kind: "human" as const,
      trustLevel: "public" as const,
      publicSubstate: "recognized" as const,
      sourceAugment: "web",
    };
    const result = (await aug.context?.({ peer } as never)) as ContextBlock[];
    expect(result![0]?.content.toLowerCase()).toContain("reverif");
    await aug.onShutdown?.();
  });

  test("emits no block when verified row is revoked", async () => {
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    const { createSqliteVisitorAuthStore } = await import(
      "../../../src/augments/visitor-auth/storage/sqlite-store"
    );
    const seedStore = createSqliteVisitorAuthStore({ dbPath });
    seedStore.initialize();
    seedStore.recordVerifiedVisitor({
      visitorId: "vis_rev",
      email: "revoked@x",
      verifiedAt: Date.now(),
      lastSeenAt: null,
      reverifyDueAt: Date.now() + 86_400_000,
      revoked: false,
      revokedAt: null,
      revokedReason: null,
    });
    seedStore.revokeByEmail("revoked@x", "operator", Date.now());
    seedStore.close();
    const peer = {
      id: "vis_rev",
      kind: "human" as const,
      trustLevel: "public" as const,
      publicSubstate: "recognized" as const,
      sourceAugment: "web",
    };
    const result = await aug.context?.({ peer } as never);
    expect(result).toEqual([]);
    await aug.onShutdown?.();
  });
});

function makeAugWithFirstVerify(dbPath: string) {
  const sends: { to: string[]; subject: string; text: string; inboxId: string }[] = [];
  const aug = visitorAuth({
    publicUrl: "https://zip.test",
    dbPath,
    agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
    signingKey: "sig",
    // Open rate limit so two verifications of the same email (from different
    // peers / threadIds) can proceed in the same test. Fix H1 keys the
    // rate-limiter to the EMAIL, so both sends count against the same email
    // quota — bump the cap to 5/10 to allow the multi-verify scenario.
    rateLimit: { perHour: 5, perDay: 10 },
    notifyOnFirstVerify: { to: "ops@x.com", subjectPrefix: "[New verified] " },
    _agentMailClient: {
      send: async (i: { to: string[]; subject: string; text: string; inboxId: string }) => {
        sends.push({ to: i.to, subject: i.subject, text: i.text, inboxId: i.inboxId });
        return { status: "sent" as const, messageId: "m", threadId: "t" };
      },
      getInbox: async () => ({ inboxId: "ibx_x", status: "ok" as const }),
    } as never,
  });
  return { aug, sends };
}

async function flowThroughVerify(
  aug: ReturnType<typeof visitorAuth>,
  email: string,
  threadId: string,
  sends: { text: string }[],
) {
  const peer = {
    id: `anon-${threadId}`,
    kind: "anonymous" as const,
    trustLevel: "public" as const,
    publicSubstate: "anonymous" as const,
    sourceAugment: "web",
  };
  await aug.onTurnStart?.({
    turnId: "t",
    threadId,
    trigger: {
      type: "message",
      turnId: "t",
      timestamp: 0,
      payload: { parts: [{ kind: "text", text: email }], sourceAugment: "web", peer, timestamp: 0 },
    },
    peer,
    toolCallsSoFar: 0,
    turnStartedAt: 0,
    metadata: {},
  } as never);
  await aug.tools![0]!.execute({ method: "email", email }, {
    turnId: "t",
    threadId,
    peer,
  } as ToolExecuteContext);
  // sends[0] is the visitor's magic-link mail; pull the token out of the URL.
  const verifyUrl = sends[0]!.text.match(/(https:\/\/[^\s]+)/)![1]!;
  const tokenParam = new URL(verifyUrl).searchParams.get("token")!;
  // POST route (index 1) consumes the token and mints the vis_ visitor token.
  return aug.httpRoutes![1]!.handler(
    new Request(verifyUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(tokenParam)}`,
    }),
    { signal: new AbortController().signal },
  );
}

describe("notifyOnFirstVerify", () => {
  test("fires AgentMail to operator on first verify per email", async () => {
    const { aug, sends } = makeAugWithFirstVerify(dbPath);
    await aug.onBoot?.();
    const res = await flowThroughVerify(aug, "alice@example.com", "th-fv", sends);
    expect(res.status).toBe(200);
    // Two sends: visitor's magic link FIRST, then operator notification SECOND.
    expect(sends).toHaveLength(2);
    expect(sends[0]?.to).toEqual(["alice@example.com"]);
    expect(sends[1]?.to).toEqual(["ops@x.com"]);
    expect(sends[1]?.subject).toContain("[New verified]");
    expect(sends[1]?.text).toContain("alice@example.com");
    await aug.onShutdown?.();
  });

  test("does not fire on subsequent verifications of the same email", async () => {
    const { aug, sends } = makeAugWithFirstVerify(dbPath);
    await aug.onBoot?.();
    await flowThroughVerify(aug, "bob@example.com", "th-b1", sends);
    sends.length = 0;
    await flowThroughVerify(aug, "bob@example.com", "th-b2", sends);
    // Second flow contains ONLY the visitor's magic-link mail; no operator note.
    expect(sends).toHaveLength(1);
    expect(sends[0]?.to).toEqual(["bob@example.com"]);
    await aug.onShutdown?.();
  });
});

describe("isVisitorRevoked (fix C1)", () => {
  test("returns false before onBoot completes (fail-open)", () => {
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: {
        send: async () => ({ status: "sent" as const, messageId: "m", threadId: "t" }),
        getInbox: async () => ({ inboxId: "i", status: "ok" as const }),
      } as AgentMailClient,
    });
    // isVisitorRevoked is accessible via the VisitorAuthAugmentExtras surface.
    const augWithExtras = aug as typeof aug & { isVisitorRevoked: (id: string) => boolean };
    // Not yet booted — fail-open: returns false rather than erroring.
    expect(augWithExtras.isVisitorRevoked("vis_anything")).toBe(false);
  });

  test("returns false for an unknown visitorId after boot", async () => {
    const sends: { text: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: {
        send: async (i: { text: string }) => { sends.push({ text: i.text }); return { status: "sent" as const, messageId: "m", threadId: "t" }; },
        getInbox: async () => ({ inboxId: "i", status: "ok" as const }),
      } as AgentMailClient,
    });
    await aug.onBoot?.();
    const augWithExtras = aug as typeof aug & { isVisitorRevoked: (id: string) => boolean };
    expect(augWithExtras.isVisitorRevoked("vis_no_such_id")).toBe(false);
    await aug.onShutdown?.();
  });

  test("returns false for an active (non-revoked) visitor", async () => {
    const sends: { text: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: {
        send: async (i: { text: string }) => { sends.push({ text: i.text }); return { status: "sent" as const, messageId: "m", threadId: "t" }; },
        getInbox: async () => ({ inboxId: "i", status: "ok" as const }),
      } as AgentMailClient,
    });
    await aug.onBoot?.();
    // Go through verify flow to get a vis_<uuid> visitor id.
    const resp = await flowThroughVerify(aug, "active@example.com", "th-active", sends);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    const tokenJsonMatch = html.match(/var token = ("(?:\\.|[^"\\])*");/);
    const visToken = JSON.parse(tokenJsonMatch![1]!) as string;
    const visitorId = JSON.parse(atob(visToken.split(".")[0]!)).visitorId as string;

    const augWithExtras = aug as typeof aug & { isVisitorRevoked: (id: string) => boolean };
    // Active visitor: not revoked.
    expect(augWithExtras.isVisitorRevoked(visitorId)).toBe(false);
    await aug.onShutdown?.();
  });

  test("returns true after revokeByEmail is called on the visitor's email", async () => {
    const sends: { text: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: {
        send: async (i: { text: string }) => { sends.push({ text: i.text }); return { status: "sent" as const, messageId: "m", threadId: "t" }; },
        getInbox: async () => ({ inboxId: "i", status: "ok" as const }),
      } as AgentMailClient,
    });
    await aug.onBoot?.();
    const resp = await flowThroughVerify(aug, "revoke@example.com", "th-revoke", sends);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    const tokenJsonMatch = html.match(/var token = ("(?:\\.|[^"\\])*");/);
    const visToken = JSON.parse(tokenJsonMatch![1]!) as string;
    const visitorId = JSON.parse(atob(visToken.split(".")[0]!)).visitorId as string;

    const augWithExtras = aug as typeof aug & { isVisitorRevoked: (id: string) => boolean };
    // Not yet revoked.
    expect(augWithExtras.isVisitorRevoked(visitorId)).toBe(false);

    // Revoke directly via the store (simulating `auggy visitors --revoke`).
    const seedStore = createSqliteVisitorAuthStore({ dbPath });
    seedStore.initialize();
    seedStore.revokeByEmail("revoke@example.com", "operator", Date.now());
    seedStore.close();

    // isVisitorRevoked reads from the live DB — must now return true.
    expect(augWithExtras.isVisitorRevoked(visitorId)).toBe(true);
    await aug.onShutdown?.();
  });

  test("returns true for OLD visitorId after unrevoke-and-rotate (denylist check, fix H1)", async () => {
    // Regression guard: after unrevokeAndRotate, the old vis_id no longer exists
    // as a row in verified_visitors. Without the denylist, isVisitorRevoked would
    // return false for the old id (row not found → row?.revoked is undefined → false).
    // The denylist must catch it.
    const sends: { text: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      // Open rate limit so both verifications (pre- and post-revoke) can proceed.
      rateLimit: { perHour: 5, perDay: 10 },
      _agentMailClient: {
        send: async (i: { text: string }) => {
          sends.push({ text: i.text });
          return { status: "sent" as const, messageId: "m", threadId: "t" };
        },
        getInbox: async () => ({ inboxId: "i", status: "ok" as const }),
      } as AgentMailClient,
    });
    await aug.onBoot?.();

    // First verify: get vis_OLD.
    const resp1 = await flowThroughVerify(aug, "rotate@example.com", "th-rot1", sends);
    expect(resp1.status).toBe(200);
    const html1 = await resp1.text();
    const tokenJsonMatch1 = html1.match(/var token = ("(?:\\.|[^"\\])*");/);
    const visToken1 = JSON.parse(tokenJsonMatch1![1]!) as string;
    const visOld = JSON.parse(atob(visToken1.split(".")[0]!)).visitorId as string;
    expect(visOld).toMatch(/^vis_/);

    // Revoke vis_OLD.
    const seedStore = createSqliteVisitorAuthStore({ dbPath });
    seedStore.initialize();
    seedStore.revokeByEmail("rotate@example.com", "operator", Date.now());
    seedStore.close();

    // Re-verify: unrevokeAndRotate fires, minting vis_NEW. OLD row is gone.
    sends.length = 0;
    const resp2 = await flowThroughVerify(aug, "rotate@example.com", "th-rot2", sends);
    expect(resp2.status).toBe(200);
    const html2 = await resp2.text();
    const tokenJsonMatch2 = html2.match(/var token = ("(?:\\.|[^"\\])*");/);
    const visToken2 = JSON.parse(tokenJsonMatch2![1]!) as string;
    const visNew = JSON.parse(atob(visToken2.split(".")[0]!)).visitorId as string;
    expect(visNew).toMatch(/^vis_/);
    expect(visNew).not.toBe(visOld);

    const augWithExtras = aug as typeof aug & { isVisitorRevoked: (id: string) => boolean };
    // vis_OLD must still be rejected via the denylist.
    expect(augWithExtras.isVisitorRevoked(visOld)).toBe(true);
    // vis_NEW must be admitted.
    expect(augWithExtras.isVisitorRevoked(visNew)).toBe(false);

    await aug.onShutdown?.();
  });
});
