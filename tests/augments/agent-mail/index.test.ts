import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentMail } from "../../../src/augments/agentMail";
import { createAgentMailInboundLedger } from "../../../src/augments/agentMail/inbound-ledger";
import type { AgentMailSdkAdapters } from "../../../src/augments/agentMail/sdk-provider";
import type {
  AgentMailClient,
  ReplyMessageInput,
  ForwardMessageInput,
  SendMessageError,
  SendMessageInput,
} from "../../../src/agentmail-client";
import type {
  AdminActionResult,
  AdminInfoBlock,
  PeerIdentity,
  RouteWebhookContext,
  ToolExecuteContext,
  Tool,
  TransportKernel,
  TurnResult,
  TurnTrigger,
} from "../../../src/types";
import { asStringTool } from "../../fixtures/tool-helpers";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

interface FakeClientLog {
  send: SendMessageInput[];
  reply: ReplyMessageInput[];
  forward: ForwardMessageInput[];
  inbox: string[];
}

function fakeClient(overrides: Partial<AgentMailClient> = {}): {
  client: AgentMailClient;
  log: FakeClientLog;
} {
  const log: FakeClientLog = { send: [], reply: [], forward: [], inbox: [] };
  const client: AgentMailClient = {
    async send(input) {
      log.send.push(input);
      return { status: "sent" as const, messageId: "msg_1", threadId: "thd_1" };
    },
    async reply(input) {
      log.reply.push(input);
      return { status: "sent" as const, messageId: "msg_r", threadId: "thd_1" };
    },
    async forward(input) {
      log.forward.push(input);
      return { status: "sent" as const, messageId: "msg_f", threadId: "thd_f" };
    },
    async getInbox(id) {
      log.inbox.push(id);
      return { inboxId: id, status: "ok" as const };
    },
    ...overrides,
  };
  return { client, log };
}

function peer(trustLevel: PeerIdentity["trustLevel"]): PeerIdentity {
  return {
    id: `peer-${trustLevel}-${crypto.randomUUID()}`,
    kind: "human",
    trustLevel,
    sourceAugment: "web",
    ...(trustLevel === "public" ? { publicSubstate: "anonymous" as const } : {}),
  };
}

function ctx(p: PeerIdentity | null = null): ToolExecuteContext {
  return { turnId: `turn-${crypto.randomUUID()}`, peer: p, threadId: "t-1" };
}

function tool(aug: ReturnType<typeof agentMail>, name: string): Tool<unknown> {
  const t = aug.tools!.find((x) => x.name === name) as Tool<unknown> | undefined;
  if (!t) throw new Error(`tool ${name} not found on agentMail augment`);
  return t;
}

function asStr(t: Tool<unknown>) {
  return asStringTool(t);
}

const baseOpts = { apiKey: "am_test_key", inboxId: "inb_test" };

// Track temp dirs for cleanup.
const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-mail-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe("agentMail factory", () => {
  test("exposes the three MCP-aligned tools", () => {
    const { client } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client });
    const names = (aug.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(["forward_message", "reply_to_message", "send_message"]);
  });

  test("throws on missing apiKey", () => {
    expect(() => agentMail({ apiKey: "", inboxId: "inb" } as never)).toThrow(/apiKey/);
  });

  test("throws on missing inboxId", () => {
    expect(() => agentMail({ apiKey: "am_x", inboxId: "" } as never)).toThrow(/inboxId/);
  });

  test("throws on empty subjectPrefix", () => {
    expect(() =>
      agentMail({
        ...baseOpts,
        outbound: { subjectPrefix: "" },
      }),
    ).toThrow(/subjectPrefix/);
  });

  test("requires an explicit sender allowlist when inbound is enabled", () => {
    expect(() => agentMail({ ...baseOpts, inbound: { mode: "websocket" } })).toThrow(
      /allowedSenders/,
    );
  });

  test("exposes inbound behavior through a concrete transport field", () => {
    const aug = agentMail({
      ...baseOpts,
      inbound: { mode: "polling", allowedSenders: ["*@example.com"] },
    });
    expect(aug.transport).toBeDefined();
    expect("capabilities" in aug).toBe(false);
    expect("supports" in aug).toBe(false);
  });

  test("requires webhook configuration for webhook mode", () => {
    expect(() =>
      agentMail({
        ...baseOpts,
        inbound: { mode: "webhook", allowedSenders: ["customer@example.com"] },
      }),
    ).toThrow(/inbound.webhook/);
  });
});

// ---------------------------------------------------------------------------
// Trust-level gate
// ---------------------------------------------------------------------------

describe("send_message trust-level gate", () => {
  test("creator peer is allowed (default)", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client });
    const t = asStr(tool(aug, "send_message"));
    const res = JSON.parse(
      await t.execute({ to: ["a@x.com"], subject: "Hi", text: "Body" }, ctx(peer("creator"))),
    );
    expect(res.status).toBe("sent");
    expect(log.send).toHaveLength(1);
  });

  test("null peer (system trigger) is allowed", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client });
    const t = asStr(tool(aug, "send_message"));
    const res = JSON.parse(
      await t.execute({ to: ["a@x.com"], subject: "Hi", text: "Body" }, ctx(null)),
    );
    expect(res.status).toBe("sent");
    expect(log.send).toHaveLength(1);
  });

  test("public peer is rejected with default allowlist", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client });
    const t = asStr(tool(aug, "send_message"));
    const res = JSON.parse(
      await t.execute({ to: ["a@x.com"], subject: "Hi", text: "Body" }, ctx(peer("public"))),
    );
    expect(res.status).toBe("failed");
    expect(res.message).toMatch(/trust level "public"/);
    expect(log.send).toHaveLength(0);
  });

  test("operator can opt agent peers in via allowedTrustLevels", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      outbound: { allowedTrustLevels: ["creator", "agent"] },
    });
    const t = asStr(tool(aug, "send_message"));
    const res = JSON.parse(
      await t.execute({ to: ["a@x.com"], subject: "Hi", text: "Body" }, ctx(peer("agent"))),
    );
    expect(res.status).toBe("sent");
    expect(log.send).toHaveLength(1);
  });

  test("public outbound is queued for review by default after trust opt-in", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      outbound: { allowedTrustLevels: ["public"] },
    });
    const result = JSON.parse(
      await asStr(tool(aug, "send_message")).execute(
        { to: ["customer@example.com"], subject: "Hi", text: "Body" },
        ctx(peer("public")),
      ),
    );
    expect(result).toMatchObject({ status: "pending_review" });
    expect(log.send).toHaveLength(0);

    const rejected = await aug.adminActions!["agentmail-review-reject"]!({
      reviewId: result.reviewId,
      reason: "operator declined",
    });
    expect(rejected.ok).toBe(true);
    expect(log.send).toHaveLength(0);
  });

  test("autonomous public outbound requires an explicit empty review list", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      outbound: {
        allowedTrustLevels: ["public"],
        humanReview: { requiredForTrustLevels: [] },
      },
    });
    const result = JSON.parse(
      await asStr(tool(aug, "send_message")).execute(
        { to: ["customer@example.com"], subject: "Hi", text: "Body" },
        ctx(peer("public")),
      ),
    );
    expect(result.status).toBe("sent");
    expect(log.send).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Validation guards (covered in units.test.ts; smoke-test through the factory)
// ---------------------------------------------------------------------------

describe("send_message validation flows through to the tool envelope", () => {
  test("malformed email is rejected before HTTP call", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client });
    const t = asStr(tool(aug, "send_message"));
    const res = JSON.parse(
      await t.execute({ to: ["not-an-email"], subject: "Hi", text: "Body" }, ctx(peer("creator"))),
    );
    expect(res.status).toBe("failed");
    expect(log.send).toHaveLength(0);
  });

  test("HTML body is rejected when allowHtml=false (default)", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client });
    const t = asStr(tool(aug, "send_message"));
    const res = JSON.parse(
      await t.execute(
        { to: ["a@x.com"], subject: "Hi", text: "Body", html: "<p>x</p>" },
        ctx(peer("creator")),
      ),
    );
    expect(res.status).toBe("failed");
    expect(log.send).toHaveLength(0);
  });

  test("recipient allowlist is enforced", async () => {
    const { client } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      outbound: { allowedRecipients: ["alice@good.com"] },
    });
    const t = asStr(tool(aug, "send_message"));
    const res = JSON.parse(
      await t.execute({ to: ["eve@evil.com"], subject: "Hi", text: "Body" }, ctx(peer("creator"))),
    );
    expect(res.status).toBe("failed");
    expect(res.message).toMatch(/allowlist/);
  });

  test("subject prefix is applied on send", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      outbound: { subjectPrefix: "[Test] " },
    });
    const t = asStr(tool(aug, "send_message"));
    await t.execute({ to: ["a@x.com"], subject: "Hello", text: "Body" }, ctx(peer("creator")));
    expect(log.send[0]!.subject).toBe("[Test] Hello");
  });
});

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

describe("send_message rate limits", () => {
  test("creator bypasses global cap", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      outbound: { rateLimit: { globalMaxPerHour: 1 } },
    });
    const t = asStr(tool(aug, "send_message"));
    for (let i = 0; i < 5; i++) {
      const res = JSON.parse(
        await t.execute({ to: [`r${i}@x.com`], subject: `S${i}`, text: "B" }, ctx(peer("creator"))),
      );
      expect(res.status).toBe("sent");
    }
    expect(log.send).toHaveLength(5);
  });

  test("non-creator hits global cap and gets rate_limited envelope", async () => {
    let nowMs = 1_000_000_000_000;
    const { client, log } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      _now: () => nowMs,
      outbound: {
        allowedTrustLevels: ["creator", "agent"],
        rateLimit: { globalMaxPerHour: 2, perRecipientCooldownMs: 0, dedupWindowMs: 0 },
      },
    });
    const t = asStr(tool(aug, "send_message"));

    expect(
      JSON.parse(await t.execute({ to: ["a@x.com"], subject: "S1", text: "B" }, ctx(peer("agent"))))
        .status,
    ).toBe("sent");
    nowMs += 1_000;
    expect(
      JSON.parse(await t.execute({ to: ["b@x.com"], subject: "S2", text: "B" }, ctx(peer("agent"))))
        .status,
    ).toBe("sent");
    nowMs += 1_000;
    const blocked = JSON.parse(
      await t.execute({ to: ["c@x.com"], subject: "S3", text: "B" }, ctx(peer("agent"))),
    );
    expect(blocked.status).toBe("rate_limited");
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(log.send).toHaveLength(2);
  });

  test("non-creator dedup blocks identical subject in window", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      outbound: {
        allowedTrustLevels: ["creator", "agent"],
        rateLimit: { dedupWindowMs: 60_000, perRecipientCooldownMs: 0, globalMaxPerHour: 100 },
      },
    });
    const t = asStr(tool(aug, "send_message"));
    expect(
      JSON.parse(
        await t.execute({ to: ["a@x.com"], subject: "Same", text: "B" }, ctx(peer("agent"))),
      ).status,
    ).toBe("sent");
    const dedup = JSON.parse(
      await t.execute({ to: ["b@x.com"], subject: "Same", text: "B" }, ctx(peer("agent"))),
    );
    expect(dedup.status).toBe("rate_limited");
    expect(log.send).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AgentMail errors surfaced to the model
// ---------------------------------------------------------------------------

describe("AgentMail HTTP errors surface to the model envelope", () => {
  test("429 surfaces retryAfterSec", async () => {
    const failingClient = fakeClient({
      async send() {
        return {
          status: "failed",
          detail: "agentmail returned 429: rate limit",
          httpStatus: 429,
          retryAfterSec: 17,
        } satisfies SendMessageError;
      },
    });
    const aug = agentMail({ ...baseOpts, _client: failingClient.client });
    const t = asStr(tool(aug, "send_message"));
    const res = JSON.parse(
      await t.execute({ to: ["a@x.com"], subject: "S", text: "B" }, ctx(peer("creator"))),
    );
    expect(res.status).toBe("failed");
    expect(res.httpStatus).toBe(429);
    expect(res.retryAfterSec).toBe(17);
  });

  test("5xx is preserved", async () => {
    const failingClient = fakeClient({
      async send() {
        return {
          status: "failed",
          detail: "agentmail returned 503: Service Unavailable",
          httpStatus: 503,
        } satisfies SendMessageError;
      },
    });
    const aug = agentMail({ ...baseOpts, _client: failingClient.client });
    const t = asStr(tool(aug, "send_message"));
    const res = JSON.parse(
      await t.execute({ to: ["a@x.com"], subject: "S", text: "B" }, ctx(peer("creator"))),
    );
    expect(res.status).toBe("failed");
    expect(res.httpStatus).toBe(503);
  });

  test("failed send does NOT burn rate-limit quota", async () => {
    let nowMs = 1_000_000_000_000;
    let calls = 0;
    const failingClient = fakeClient({
      async send() {
        calls++;
        return {
          status: "failed",
          detail: "agentmail returned 500",
          httpStatus: 500,
        } satisfies SendMessageError;
      },
    });
    const aug = agentMail({
      ...baseOpts,
      _client: failingClient.client,
      _now: () => nowMs,
      outbound: {
        allowedTrustLevels: ["creator", "agent"],
        rateLimit: { globalMaxPerHour: 1, perRecipientCooldownMs: 0, dedupWindowMs: 0 },
      },
    });
    const t = asStr(tool(aug, "send_message"));
    // First attempt fails (5xx); should NOT consume the only quota slot.
    expect(
      JSON.parse(await t.execute({ to: ["a@x.com"], subject: "S1", text: "B" }, ctx(peer("agent"))))
        .status,
    ).toBe("failed");
    nowMs += 1_000;
    // Second attempt should be allowed to try.
    expect(
      JSON.parse(await t.execute({ to: ["b@x.com"], subject: "S2", text: "B" }, ctx(peer("agent"))))
        .status,
    ).toBe("failed");
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// reply_to_message + forward_message
// ---------------------------------------------------------------------------

describe("reply_to_message", () => {
  test("rejects unseen messageId", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client });
    const t = asStr(tool(aug, "reply_to_message"));
    const res = JSON.parse(
      await t.execute({ messageId: "msg_unknown", text: "hello" }, ctx(peer("creator"))),
    );
    expect(res.status).toBe("failed");
    expect(res.message).toMatch(/not delivered/);
    expect(log.reply).toHaveLength(0);
  });

  test("accepts a seen messageId and delegates to client.reply", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client }) as ReturnType<typeof agentMail> & {
      _markSeenForTest: (id: string, meta: { from: string; replyAllTo?: string[] }) => void;
    };
    aug._markSeenForTest("msg_abc", { from: "carlos@vendor.com" });
    const t = asStr(tool(aug, "reply_to_message"));
    const res = JSON.parse(
      await t.execute(
        { messageId: "msg_abc", text: "Thanks!", replyAll: true },
        ctx(peer("creator")),
      ),
    );
    expect(res.status).toBe("sent");
    expect(log.reply).toHaveLength(1);
    expect(log.reply[0]!.messageId).toBe("msg_abc");
    expect(log.reply[0]!.replyAll).toBe(true);
  });
});

describe("forward_message", () => {
  test("rejects unseen messageId before validation", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client });
    const t = asStr(tool(aug, "forward_message"));
    const res = JSON.parse(
      await t.execute({ messageId: "msg_unknown", to: ["a@x.com"] }, ctx(peer("creator"))),
    );
    expect(res.status).toBe("failed");
    expect(log.forward).toHaveLength(0);
  });

  test("delegates to client.forward with recipients + optional commentary", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client }) as ReturnType<typeof agentMail> & {
      _markSeenForTest: (id: string, meta: { from: string; replyAllTo?: string[] }) => void;
    };
    aug._markSeenForTest("msg_fwd", { from: "carlos@vendor.com" });
    const t = asStr(tool(aug, "forward_message"));
    const res = JSON.parse(
      await t.execute(
        { messageId: "msg_fwd", to: ["ops@x.com"], text: "FYI" },
        ctx(peer("creator")),
      ),
    );
    expect(res.status).toBe("sent");
    expect(log.forward).toHaveLength(1);
    expect(log.forward[0]!.to).toEqual(["ops@x.com"]);
    expect(log.forward[0]!.text).toBe("FYI");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
// Codex regression: reply applies full outbound policy
// ---------------------------------------------------------------------------

describe("reply_to_message — Codex #1 policy enforcement", () => {
  test("rejects when inbound sender is NOT on the recipient allowlist", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      outbound: { allowedRecipients: ["trusted@good.com"] },
    }) as ReturnType<typeof agentMail> & {
      _markSeenForTest: (id: string, meta: { from: string; replyAllTo?: string[] }) => void;
    };
    aug._markSeenForTest("msg_evil", { from: "eve@evil.com" });
    const t = asStr(tool(aug, "reply_to_message"));
    const res = JSON.parse(
      await t.execute({ messageId: "msg_evil", text: "reply body" }, ctx(peer("creator"))),
    );
    expect(res.status).toBe("failed");
    expect(res.message).toMatch(/allowlist/);
    expect(log.reply).toHaveLength(0);
  });

  test("permits when inbound sender IS on the allowlist", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      outbound: { allowedRecipients: ["alice@good.com"] },
    }) as ReturnType<typeof agentMail> & {
      _markSeenForTest: (id: string, meta: { from: string; replyAllTo?: string[] }) => void;
    };
    aug._markSeenForTest("msg_good", { from: "alice@good.com" });
    const t = asStr(tool(aug, "reply_to_message"));
    const res = JSON.parse(
      await t.execute({ messageId: "msg_good", text: "thanks" }, ctx(peer("creator"))),
    );
    expect(res.status).toBe("sent");
    expect(log.reply).toHaveLength(1);
  });

  test("replyAll: each original recipient must pass the allowlist", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      outbound: { allowedRecipients: ["alice@good.com"] }, // bob@evil.com NOT on list
    }) as ReturnType<typeof agentMail> & {
      _markSeenForTest: (id: string, meta: { from: string; replyAllTo?: string[] }) => void;
    };
    aug._markSeenForTest("msg_thread", {
      from: "alice@good.com",
      replyAllTo: ["bob@evil.com"],
    });
    const t = asStr(tool(aug, "reply_to_message"));
    const res = JSON.parse(
      await t.execute(
        { messageId: "msg_thread", text: "everyone", replyAll: true },
        ctx(peer("creator")),
      ),
    );
    expect(res.status).toBe("failed");
    expect(res.message).toMatch(/allowlist/);
    expect(log.reply).toHaveLength(0);
  });

  test("non-creator: reply respects per-recipient cooldown", async () => {
    let nowMs = 1_000_000_000_000;
    const { client, log } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      _now: () => nowMs,
      outbound: {
        allowedTrustLevels: ["creator", "agent"],
        rateLimit: { globalMaxPerHour: 100, perRecipientCooldownMs: 300_000, dedupWindowMs: 0 },
      },
    }) as ReturnType<typeof agentMail> & {
      _markSeenForTest: (id: string, meta: { from: string; replyAllTo?: string[] }) => void;
    };
    aug._markSeenForTest("msg_1", { from: "alice@x.com" });
    aug._markSeenForTest("msg_2", { from: "alice@x.com" });
    const t = asStr(tool(aug, "reply_to_message"));
    // First reply lands.
    expect(
      JSON.parse(await t.execute({ messageId: "msg_1", text: "1" }, ctx(peer("agent")))).status,
    ).toBe("sent");
    nowMs += 1_000;
    // Second reply to the SAME recipient via a different inbound message
    // must be cooldown-blocked — replies were previously unrestricted.
    const blocked = JSON.parse(
      await t.execute({ messageId: "msg_2", text: "2" }, ctx(peer("agent"))),
    );
    expect(blocked.status).toBe("rate_limited");
    expect(log.reply).toHaveLength(1);
  });

  test("creator bypasses reply rate limits", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      outbound: { rateLimit: { globalMaxPerHour: 1, perRecipientCooldownMs: 300_000 } },
    }) as ReturnType<typeof agentMail> & {
      _markSeenForTest: (id: string, meta: { from: string; replyAllTo?: string[] }) => void;
    };
    aug._markSeenForTest("m1", { from: "alice@x.com" });
    aug._markSeenForTest("m2", { from: "alice@x.com" });
    const t = asStr(tool(aug, "reply_to_message"));
    expect(
      JSON.parse(await t.execute({ messageId: "m1", text: "1" }, ctx(peer("creator")))).status,
    ).toBe("sent");
    expect(
      JSON.parse(await t.execute({ messageId: "m2", text: "2" }, ctx(peer("creator")))).status,
    ).toBe("sent");
    expect(log.reply).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Codex regression: subject LF stripped (header injection)
// ---------------------------------------------------------------------------

describe("subject sanitization — Codex #2 header injection", () => {
  test("strips bare LF from subject (prevents Bcc/Cc header smuggling)", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client });
    const t = asStr(tool(aug, "send_message"));
    await t.execute(
      {
        to: ["alice@x.com"],
        subject: "Hello\nBcc: victim@evil.com",
        text: "body",
      },
      ctx(peer("creator")),
    );
    expect(log.send).toHaveLength(1);
    const subject = log.send[0]!.subject;
    // The LF is stripped, which collapses the smuggled "Bcc:" string into
    // the visible subject as plain text — no longer interpretable as a header.
    expect(subject).not.toContain("\n");
    expect(subject).toBe("[Auggy] HelloBcc: victim@evil.com");
  });

  test("strips Cc-header injection attempt", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client });
    const t = asStr(tool(aug, "send_message"));
    await t.execute(
      { to: ["alice@x.com"], subject: "OK\nCc: spy@evil.com", text: "body" },
      ctx(peer("creator")),
    );
    expect(log.send[0]!.subject).not.toContain("\n");
  });
});

// ---------------------------------------------------------------------------
// Codex regression: body cap covers text + html
// ---------------------------------------------------------------------------

describe("body cap — Codex #4 HTML must count", () => {
  test("oversized HTML body is rejected even when text is small", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      outbound: { allowHtml: true, bodyMaxBytes: 100 },
    });
    const t = asStr(tool(aug, "send_message"));
    const res = JSON.parse(
      await t.execute(
        {
          to: ["a@x.com"],
          subject: "Big",
          text: "tiny",
          html: "x".repeat(200),
        },
        ctx(peer("creator")),
      ),
    );
    expect(res.status).toBe("failed");
    expect(res.message).toMatch(/bytes/);
    expect(log.send).toHaveLength(0);
  });

  test("text + html under cap is accepted", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      outbound: { allowHtml: true, bodyMaxBytes: 500 },
    });
    const t = asStr(tool(aug, "send_message"));
    const res = JSON.parse(
      await t.execute(
        { to: ["a@x.com"], subject: "OK", text: "tiny", html: "x".repeat(200) },
        ctx(peer("creator")),
      ),
    );
    expect(res.status).toBe("sent");
    expect(log.send).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Codex regression: rate-limit state persists across restarts
// ---------------------------------------------------------------------------

describe("rate-limit persistence — Codex #3", () => {
  test("a fresh factory instance with the same agentDir inherits prior dedup state", async () => {
    const dir = makeTmpDir();
    let nowMs = 1_000_000_000_000;
    const { client: c1, log: log1 } = fakeClient();
    const aug1 = agentMail({
      ...baseOpts,
      _client: c1,
      _now: () => nowMs,
      agentDir: dir,
      outbound: {
        allowedTrustLevels: ["creator", "agent"],
        rateLimit: { globalMaxPerHour: 100, perRecipientCooldownMs: 0, dedupWindowMs: 60_000 },
      },
    });
    const t1 = asStr(tool(aug1, "send_message"));
    // Non-creator send burns one dedup slot for subject "Daily Digest".
    expect(
      JSON.parse(
        await t1.execute(
          { to: ["a@x.com"], subject: "Daily Digest", text: "B" },
          ctx(peer("agent")),
        ),
      ).status,
    ).toBe("sent");
    expect(log1.send).toHaveLength(1);

    // Simulate restart: brand-new factory pointing at the same agentDir.
    nowMs += 1_000;
    const { client: c2, log: log2 } = fakeClient();
    const aug2 = agentMail({
      ...baseOpts,
      _client: c2,
      _now: () => nowMs,
      agentDir: dir,
      outbound: {
        allowedTrustLevels: ["creator", "agent"],
        rateLimit: { globalMaxPerHour: 100, perRecipientCooldownMs: 0, dedupWindowMs: 60_000 },
      },
    });
    const t2 = asStr(tool(aug2, "send_message"));
    // Same subject hash must now be dedup-blocked because the prior state
    // was loaded from disk.
    const blocked = JSON.parse(
      await t2.execute({ to: ["b@x.com"], subject: "Daily Digest", text: "B" }, ctx(peer("agent"))),
    );
    expect(blocked.status).toBe("rate_limited");
    expect(log2.send).toHaveLength(0);
  });

  test("creator sends do NOT persist (rate-limit state stays empty)", async () => {
    const dir = makeTmpDir();
    const { client } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client, agentDir: dir });
    const t = asStr(tool(aug, "send_message"));
    await t.execute({ to: ["a@x.com"], subject: "Creator-Send", text: "B" }, ctx(peer("creator")));
    // No state file written (creator bypasses rate-limit AND persistence).
    const path = join(dir, "agent-mail-state.json");
    expect(existsSync(path)).toBe(false);
  });

  test("entries older than 1h are pruned at load", async () => {
    const dir = makeTmpDir();
    const oldMs = 1_000_000_000_000;
    const { client: c1 } = fakeClient();
    const aug1 = agentMail({
      ...baseOpts,
      _client: c1,
      _now: () => oldMs,
      agentDir: dir,
      outbound: {
        allowedTrustLevels: ["creator", "agent"],
        rateLimit: { globalMaxPerHour: 100, perRecipientCooldownMs: 0, dedupWindowMs: 60_000 },
      },
    });
    const t1 = asStr(tool(aug1, "send_message"));
    await t1.execute({ to: ["a@x.com"], subject: "Old subject", text: "B" }, ctx(peer("agent")));

    // Restart 2 hours later — dedup window long expired, subject hash should NOT block.
    const laterMs = oldMs + 2 * 3_600_000;
    const { client: c2, log: log2 } = fakeClient();
    const aug2 = agentMail({
      ...baseOpts,
      _client: c2,
      _now: () => laterMs,
      agentDir: dir,
      outbound: {
        allowedTrustLevels: ["creator", "agent"],
        rateLimit: { globalMaxPerHour: 100, perRecipientCooldownMs: 0, dedupWindowMs: 60_000 },
      },
    });
    const t2 = asStr(tool(aug2, "send_message"));
    expect(
      JSON.parse(
        await t2.execute(
          { to: ["b@x.com"], subject: "Old subject", text: "B" },
          ctx(peer("agent")),
        ),
      ).status,
    ).toBe("sent");
    expect(log2.send).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("onBoot", () => {
  test("calls getInbox once and resolves on healthy inbox", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client });
    await aug.onBoot?.();
    expect(log.inbox).toEqual(["inb_test"]);
  });

  test("warn-and-continues on 5xx healthcheck failure", async () => {
    const failingClient = fakeClient({
      async getInbox() {
        return {
          status: "failed" as const,
          detail: "AgentMail 503",
          httpStatus: 503,
        };
      },
    });
    const aug = agentMail({ ...baseOpts, _client: failingClient.client });
    // Should NOT throw — transient outage shouldn't block boot.
    await expect(aug.onBoot?.()).resolves.toBeUndefined();
    const info = await aug.adminInfo!();
    expect(info.sections.find((section) => section.kind === "status")).toMatchObject({
      kind: "status",
      level: "warn",
      message: expect.stringContaining("AgentMail 503"),
    });
  });

  test("throws on 4xx healthcheck failure (config error)", async () => {
    const failingClient = fakeClient({
      async getInbox() {
        return {
          status: "failed" as const,
          detail: "AgentMail 401: invalid api key",
          httpStatus: 401,
        };
      },
    });
    const aug = agentMail({ ...baseOpts, _client: failingClient.client });
    await expect(aug.onBoot?.()).rejects.toThrow(/401/);
  });

  test("throws when AGENTMAIL_API_KEY is unresolved (placeholder)", async () => {
    const { client } = fakeClient();
    const aug = agentMail({
      apiKey: "${AGENTMAIL_API_KEY}",
      inboxId: "inb_test",
      _client: client,
    });
    await expect(aug.onBoot?.()).rejects.toThrow(/AGENTMAIL_API_KEY is unresolved/);
  });

  test("throws when AGENTMAIL_INBOX_ID is unresolved (placeholder)", async () => {
    const { client } = fakeClient();
    const aug = agentMail({
      apiKey: "am_test_key",
      inboxId: "${AGENTMAIL_INBOX_ID}",
      _client: client,
    });
    await expect(aug.onBoot?.()).rejects.toThrow(/AGENTMAIL_INBOX_ID is unresolved/);
  });
});

describe("inbound lifecycle", () => {
  test("boot-populates a verified webhook route and dispatches admitted ledger work", async () => {
    const { client, log } = fakeClient();
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:" });
    const triggers: TurnTrigger[] = [];
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      _inboundLedger: ledger,
      _sdkAdapters: emptySdkAdapters(),
      inbound: {
        mode: "webhook",
        allowedSenders: ["customer@example.com"],
        webhook: {},
      },
      outbound: {
        allowedTrustLevels: ["public"],
        allowedRecipients: ["customer@example.com"],
      },
    });

    try {
      expect(aug.httpRoutes).toHaveLength(1);
      const reviewRoute = aug.httpRoutes!.find(
        (route) => route.path === "/agentmail/reviews/:reviewId",
      );
      expect(reviewRoute).toMatchObject({ method: "GET", auth: "creator" });
      await aug.onBoot!();
      expect(aug.httpRoutes).toHaveLength(2);
      const webhookRoute = aug.httpRoutes!.find((route) => route.path === "/webhooks/agentmail");
      expect(webhookRoute?.policy).toMatchObject({
        kind: "webhook.signature",
        provider: "svix",
      });

      let inTurnReply: Record<string, unknown> | undefined;
      await aug.transport!.register(
        fakeInboundKernel(triggers, async (trigger) => {
          const reply = asStr(tool(aug, "reply_to_message"));
          inTurnReply = JSON.parse(
            await reply.execute(
              { messageId: "message_inbound", text: "Thanks" },
              {
                turnId: trigger.turnId,
                threadId: trigger.threadId!,
                peer: trigger.peer ?? null,
              },
            ),
          );
        }),
        aug.name,
      );
      await aug.transport!.ready!();
      const response = await webhookRoute!.handler(
        new Request("https://example.test/webhooks/agentmail", { method: "POST" }),
        {
          signal: AbortSignal.timeout(1_000),
          webhook: verifiedWebhook(receivedWebhookEvent()),
        },
      );
      expect(response.status).toBe(200);

      await eventually(() => triggers.length === 1);
      expect(triggers[0]?.peer).toMatchObject({
        trustLevel: "public",
        publicSubstate: "anonymous",
      });
      expect(ledger.get(baseOpts.inboxId, "message_inbound")?.state).toBe("processed");
      expect(inTurnReply?.status).toBe("pending_review");
      expect(log.reply).toHaveLength(0);

      const reviewId = String(inTurnReply?.reviewId);
      const redactedAdmin = JSON.stringify(await aug.adminInfo!());
      expect(redactedAdmin).not.toContain("Thanks");
      expect(redactedAdmin).not.toContain("customer@example.com");
      expect(redactedAdmin).toContain(`/agentmail/reviews/${reviewId}`);
      const rejectedFingerprint = await aug.adminActions!["agentmail-review-approve"]!({
        reviewId,
        fingerprint: "not-the-inspected-action",
      });
      expect(rejectedFingerprint.ok).toBe(false);
      expect(log.reply).toHaveLength(0);

      expect(aug.adminActions!["agentmail-review-inspect"]).toBeUndefined();
      const inspection = await reviewRoute!.handler(
        new Request(`https://example.test/agentmail/reviews/${reviewId}`),
        { signal: AbortSignal.timeout(1_000), params: { reviewId } },
      );
      expect(inspection.status).toBe(200);
      expect(inspection.headers.get("cache-control")).toBe("no-store");
      const inspected = (await inspection.json()) as {
        reviewId: string;
        fingerprint: string;
        recipients: string[];
        request: { kind: string; messageId: string; text: string };
      };
      expect(inspected).toMatchObject({
        reviewId,
        recipients: ["customer@example.com"],
        request: { kind: "reply", messageId: "message_inbound", text: "Thanks" },
      });
      const approval = await aug.adminActions!["agentmail-review-approve"]!({
        reviewId,
        fingerprint: inspected.fingerprint,
      });
      expect(approval).toEqual({ ok: true, message: `Review ${reviewId} approved and sent` });
      expect(log.reply).toHaveLength(1);
      const terminalInspection = await reviewRoute!.handler(
        new Request(`https://example.test/agentmail/reviews/${reviewId}`),
        { signal: AbortSignal.timeout(1_000), params: { reviewId } },
      );
      expect(terminalInspection.status).toBe(410);

      const outOfTurn = JSON.parse(
        await asStr(tool(aug, "reply_to_message")).execute(
          { messageId: "message_inbound", text: "Replay" },
          { turnId: "other-turn", threadId: "other-thread", peer: peer("public") },
        ),
      );
      expect(outOfTurn.status).toBe("failed");
      expect(log.reply).toHaveLength(1);

      const operations = await aug.adminInfo!();
      expect(operations.sections.find((section) => section.kind === "status")).toMatchObject({
        kind: "status",
        level: "ok",
        message: "Inbound webhook ready",
      });
      const runtime = operations.sections.find((section) => section.kind === "keyValue");
      if (runtime?.kind !== "keyValue") throw new Error("missing AgentMail runtime rows");
      expect(runtime.rows.find((row) => row.label === "Inbound processed")?.value).toBe("1");
      expect(runtime.rows.find((row) => row.label === "Inbound pending")?.value).toBe("0");
      expect(runtime.rows.find((row) => row.label === "Inbound runtime")?.value).toBe("ready");
      expect(runtime.rows.find((row) => row.label === "Last catch-up result")?.value).toContain(
        "1 page(s)",
      );
      expect(runtime.rows.find((row) => row.label === "Last inbound event")?.value).not.toContain(
        "none",
      );
    } finally {
      await aug.onShutdown!();
      ledger.close();
    }
  });

  test("reports an unexpected WebSocket subscription close as degraded", async () => {
    const { client } = fakeClient();
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const sdk: AgentMailSdkAdapters = {
      catchUp: emptySdkAdapters().catchUp,
      live: {
        subscribe: async (input) => {
          await input.onSubscribed?.({ reconnected: false });
          return { closed, close: async () => resolveClosed() };
        },
      },
    };
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:" });
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      _inboundLedger: ledger,
      _sdkAdapters: sdk,
      inbound: { mode: "websocket", allowedSenders: ["*@example.com"] },
    });

    try {
      await aug.onBoot!();
      await aug.transport!.register(fakeInboundKernel([]), aug.name);
      await aug.transport!.ready!();
      expect((await aug.adminInfo!()).sections[0]).toMatchObject({ level: "ok" });

      resolveClosed();
      await eventually(async () => {
        const status = (await aug.adminInfo!()).sections[0];
        return status?.kind === "status" && status.level === "warn";
      });
      expect((await aug.adminInfo!()).sections[0]).toMatchObject({
        kind: "status",
        level: "warn",
        message: expect.stringContaining("closed unexpectedly"),
      });
    } finally {
      await aug.onShutdown!();
      ledger.close();
    }
  });
});

describe("onShutdown", () => {
  test("resolves cleanly with no resources to release (Phase A)", async () => {
    const { client } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client });
    await expect(aug.onShutdown?.()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Admin info / actions
// ---------------------------------------------------------------------------

describe("adminInfo", () => {
  test("returns the expected shape with masked apiKey", async () => {
    const { client } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client });
    const info = (await aug.adminInfo!()) as AdminInfoBlock;
    expect(info.augmentName).toBe("agent-mail");
    expect(info.title).toBe("AgentMail");
    const kv = info.sections.find((s) => s.kind === "keyValue")!;
    expect(kv.kind).toBe("keyValue");
    if (kv.kind === "keyValue") {
      const apiKeyRow = kv.rows.find((r) => r.label === "API key");
      expect(apiKeyRow).toBeDefined();
      expect(apiKeyRow!.value).not.toContain("test_key"); // masked
      expect(apiKeyRow!.value).toMatch(/^am_t…ey$/);
    }
  });

  test("dispatches appear in the recent-table after a send", async () => {
    const { client } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client });
    const t = asStr(tool(aug, "send_message"));
    await t.execute({ to: ["alice@x.com"], subject: "Hello", text: "Body" }, ctx(peer("creator")));
    const info = (await aug.adminInfo!()) as AdminInfoBlock;
    const table = info.sections.find((s) => s.kind === "table");
    expect(table?.kind).toBe("table");
    if (table?.kind === "table") {
      expect(table.rows.length).toBe(1);
      // recipients column is redacted
      const recipients = table.rows[0]![3];
      expect(recipients).not.toContain("alice@x.com");
      expect(recipients).toContain("al***");
    }
  });

  test("admin-test-send action sends mail via the client", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client });
    const action = aug.adminActions!["agentmail-test-send"]!;
    const result = (await action({
      to: "operator@x.com",
      subject: "Test",
      text: "Body",
    })) as AdminActionResult;
    expect(result.ok).toBe(true);
    expect(log.send).toHaveLength(1);
    expect(log.send[0]!.subject).toBe("[Auggy] Test");
  });

  test("admin-test-send requires recipient", async () => {
    const { client } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client });
    const result = (await aug.adminActions!["agentmail-test-send"]!({
      to: "",
    })) as AdminActionResult;
    expect(result.ok).toBe(false);
  });

  test("admin-test-send does not echo provider response bodies into action results", async () => {
    const { client } = fakeClient({
      async send() {
        return {
          status: "failed" as const,
          detail: "provider echoed recipient@example.com and sensitive message content",
          httpStatus: 400,
        };
      },
    });
    const aug = agentMail({ ...baseOpts, _client: client });
    const result = await aug.adminActions!["agentmail-test-send"]!({
      to: "recipient@example.com",
      subject: "Test",
      text: "sensitive message content",
    });
    expect(result).toEqual({ ok: false, message: "Send failed (HTTP 400)" });
  });

  test("admin-cap-adjust persists override and updates state", async () => {
    const dir = makeTmpDir();
    const { client } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client, agentDir: dir });
    const result = (await aug.adminActions!["agentmail-cap-adjust"]!({
      value: "42",
    })) as AdminActionResult;
    expect(result.ok).toBe(true);

    const overridePath = join(dir, "admin-overrides.json");
    expect(existsSync(overridePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(overridePath, "utf8"));
    expect(persisted.overrides.agentMail.globalMaxPerHour).toBe(42);

    // Reading back into a fresh augment must surface the override as the
    // effective ceiling.
    const aug2 = agentMail({ ...baseOpts, _client: client, agentDir: dir });
    const info2 = (await aug2.adminInfo!()) as AdminInfoBlock;
    const kv = info2.sections.find((s) => s.kind === "keyValue");
    if (kv?.kind === "keyValue") {
      const capRow = kv.rows.find((r) => r.label === "Global cap (per hour)");
      expect(capRow!.value).toBe("42");
      expect(capRow!.source).toBe("/admin override");
    }
  });

  test("admin-cap-adjust rejects non-positive integers", async () => {
    const dir = makeTmpDir();
    const { client } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client, agentDir: dir });
    const result = (await aug.adminActions!["agentmail-cap-adjust"]!({
      value: "-3",
    })) as AdminActionResult;
    expect(result.ok).toBe(false);
  });

  test("admin-cap-reset clears the override", async () => {
    const dir = makeTmpDir();
    const { client } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client, agentDir: dir });
    await aug.adminActions!["agentmail-cap-adjust"]!({ value: "50" });
    const result = (await aug.adminActions!["agentmail-cap-reset"]!({})) as AdminActionResult;
    expect(result.ok).toBe(true);
    const info = (await aug.adminInfo!()) as AdminInfoBlock;
    const kv = info.sections.find((s) => s.kind === "keyValue");
    if (kv?.kind === "keyValue") {
      const capRow = kv.rows.find((r) => r.label === "Global cap (per hour)");
      expect(capRow!.source).toBe("yaml");
    }
  });
});

// ---------------------------------------------------------------------------
// Sensitive-content scan (informational, does not block)
// ---------------------------------------------------------------------------

describe("sensitive-content scan", () => {
  test("send proceeds but dispatch is flagged when body contains a token shape", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({ ...baseOpts, _client: client });
    const t = asStr(tool(aug, "send_message"));
    await t.execute(
      {
        to: ["a@x.com"],
        subject: "Heads up",
        text: "Here is my key: sk-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890",
      },
      ctx(peer("creator")),
    );
    expect(log.send).toHaveLength(1);
    const info = (await aug.adminInfo!()) as AdminInfoBlock;
    const table = info.sections.find((s) => s.kind === "table");
    if (table?.kind === "table") {
      // status column carries the warning marker
      expect(table.rows[0]![2]).toMatch(/⚠/);
    }
  });
});

function emptySdkAdapters(): AgentMailSdkAdapters {
  return {
    catchUp: {
      listMessages: async () => ({ messages: [], nextPageToken: undefined }),
      getMessage: async () => {
        throw new Error("unexpected getMessage");
      },
    },
    live: {
      subscribe: async () => {
        throw new Error("unexpected WebSocket subscription");
      },
    },
  };
}

function fakeInboundKernel(
  triggers: TurnTrigger[],
  onInbound?: (trigger: TurnTrigger) => void | Promise<void>,
): TransportKernel {
  return {
    handleInbound: async (trigger) => {
      triggers.push(trigger);
      await onInbound?.(trigger);
      return { success: true, status: "completed", turnId: trigger.turnId } as TurnResult;
    },
    onOutbound: () => {},
    getAgentCard: () => ({
      provider: { name: "test" },
      capabilities: { streaming: false, pushNotifications: false, memory: false, transport: true },
      skills: [],
      interfaces: [],
      extensions: {},
    }),
    getAugmentRoutes: () => [],
    getAugments: () => [],
  };
}

function verifiedWebhook(event: unknown): RouteWebhookContext {
  return {
    kind: "webhook.signature",
    provider: "svix",
    event,
    deliveryId: "delivery_inbound",
    timestamp: 1,
    receivedAt: 1_000,
  };
}

function receivedWebhookEvent(): Record<string, unknown> {
  return {
    type: "event",
    event_type: "message.received",
    event_id: "event_inbound",
    message: {
      inbox_id: baseOpts.inboxId,
      thread_id: "thread_inbound",
      message_id: "message_inbound",
      labels: ["received"],
      timestamp: "2026-07-14T10:20:30.000Z",
      from: "customer@example.com",
      to: [baseOpts.inboxId],
      subject: "Need help",
      preview: "Can you help?",
      text: "Can you help?",
      size: 512,
    },
    thread: {
      inbox_id: baseOpts.inboxId,
      thread_id: "thread_inbound",
      message_count: 1,
    },
  };
}

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition was not met");
}
