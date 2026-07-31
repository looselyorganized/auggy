import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentMail } from "../../../src/augments/agentMail";
import { createAgentMailInboundLedger } from "../../../src/augments/agentMail/inbound-ledger";
import { normalizeAgentMailReceivedEvent } from "../../../src/augments/agentMail/provider";
import { createAgentMailReviewQueue } from "../../../src/augments/agentMail/review-queue";
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
  ToolResult,
  Tool,
  TransportKernel,
  TurnResult,
  TurnState,
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
      return { inboxId: id, email: "agent@example.com", status: "ok" as const };
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

async function executeParsed(
  target: Tool<unknown>,
  input: unknown,
  context?: ToolExecuteContext,
): Promise<Record<string, unknown>> {
  const result: string | ToolResult = await target.execute(input, context);
  return JSON.parse(typeof result === "string" ? result : result.content) as Record<
    string,
    unknown
  >;
}

const baseOpts = { apiKey: "am_test_key", inboxId: "inb_test" };

function turnState(peerIdentity: PeerIdentity | null): TurnState {
  const turnId = `turn-${crypto.randomUUID()}`;
  const timestamp = Date.now();
  return {
    turnId,
    threadId: "thread-context",
    trigger: {
      type: "message",
      turnId,
      threadId: "thread-context",
      timestamp,
      payload: {
        parts: [],
        sourceAugment: "web",
        peer: peerIdentity,
        timestamp,
      },
    },
    peer: peerIdentity,
    toolCallsSoFar: 0,
    turnStartedAt: timestamp,
    metadata: {},
  };
}

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

  test("namespaces tools for multi-instance routing without lossy instance normalization", () => {
    const support = agentMail({
      ...baseOpts,
      instanceId: "support-mail",
      namespaceTools: true,
      _client: fakeClient().client,
    });
    const billing = agentMail({
      ...baseOpts,
      inboxId: "inb_billing",
      instanceId: "billing_mail",
      namespaceTools: true,
      _client: fakeClient().client,
    });
    expect(support.tools?.map((candidate) => candidate.name).sort()).toEqual([
      "forward_message__support-mail",
      "reply_to_message__support-mail",
      "send_message__support-mail",
    ]);
    expect(billing.tools?.map((candidate) => candidate.name).sort()).toEqual([
      "forward_message__billing_mail",
      "reply_to_message__billing_mail",
      "send_message__billing_mail",
    ]);
    expect(
      new Set(
        [...(support.tools ?? []), ...(billing.tools ?? [])].map((candidate) => candidate.name),
      ).size,
    ).toBe(6);
  });

  test("keeps every namespaced tool name within the provider's 64-character limit", () => {
    const longestSafeId = "a".repeat(46);
    const safe = agentMail({
      ...baseOpts,
      instanceId: longestSafeId,
      namespaceTools: true,
      _client: fakeClient().client,
    });
    expect(safe.tools?.map((candidate) => candidate.name.length).sort((a, b) => a - b)).toEqual([
      60, 63, 64,
    ]);
    expect(() =>
      agentMail({
        ...baseOpts,
        instanceId: "a".repeat(47),
        namespaceTools: true,
        _client: fakeClient().client,
      }),
    ).toThrow(/at most 46 characters.*tool name.*at most 64/i);
  });

  test("publishes provider-compatible structural bounds in every tool input schema", () => {
    const aug = agentMail({ ...baseOpts, _client: fakeClient().client });
    const send = tool(aug, "send_message").input;
    const reply = tool(aug, "reply_to_message").input;
    const forward = tool(aug, "forward_message").input;
    const recipients = Array.from({ length: 50 }, (_, index) => `user${index}@example.com`);
    const labels = Array.from({ length: 100 }, (_, index) => `label-${index}`);
    const maxBody = "x".repeat(1024 * 1024);

    expect(
      send.safeParse({
        to: recipients,
        subject: "s".repeat(1_000),
        text: maxBody,
        html: "",
        labels,
      }).success,
    ).toBe(true);
    expect(
      send.safeParse({ to: [...recipients, "overflow@example.com"], subject: "s", text: "" })
        .success,
    ).toBe(false);
    expect(
      send.safeParse({ to: [`${"a".repeat(309)}@example.com`], subject: "s", text: "" }).success,
    ).toBe(false);
    expect(
      send.safeParse({ to: ["a@example.com"], subject: "s".repeat(1_001), text: "" }).success,
    ).toBe(false);
    expect(
      send.safeParse({ to: ["a@example.com"], subject: "s", text: `${maxBody}x` }).success,
    ).toBe(false);
    expect(
      send.safeParse({
        to: ["a@example.com"],
        subject: "s",
        text: "",
        labels: [...labels, "overflow"],
      }).success,
    ).toBe(false);
    expect(
      reply.safeParse({
        messageId: "m".repeat(257),
        text: "",
      }).success,
    ).toBe(false);
    expect(
      forward.safeParse({
        messageId: "m",
        to: ["a@example.com"],
        labels: ["l".repeat(201)],
      }).success,
    ).toBe(false);
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

  test("bounds the configured outbound body cap at the direct factory boundary", () => {
    expect(() =>
      agentMail({
        ...baseOpts,
        _client: fakeClient().client,
        outbound: { bodyMaxBytes: 1024 * 1024 + 1 },
      }),
    ).toThrow(/bodyMaxBytes.*between 1 and 1048576/);
  });

  test("rejects malformed canonical inbox identity options", () => {
    expect(() => agentMail({ ...baseOpts, emailAddress: "not-an-email" })).toThrow(/emailAddress/);
    expect(() => agentMail({ ...baseOpts, addressVisibility: "everyone" as never })).toThrow(
      /addressVisibility/,
    );
  });

  test("requires an explicit sender policy when inbound is enabled", () => {
    expect(() => agentMail({ ...baseOpts, inbound: { mode: "websocket" } })).toThrow(
      /allowedSenders/,
    );
  });

  test("accepts explicit bounded public inbound at the direct factory boundary", () => {
    const aug = agentMail({
      ...baseOpts,
      _reviewQueue: createAgentMailReviewQueue(),
      inbound: {
        mode: "polling",
        allowAnySender: true,
        rateLimit: { globalMaxPerHour: 100, perSenderMaxPerHour: 5 },
      },
    });
    expect(aug.transport).toBeDefined();
  });

  test("enforces inbound policy at the direct factory boundary", () => {
    for (const inbound of [
      { mode: "polling", allowedSenders: ["*"] },
      { mode: "polling", allowedSenders: ["sender@example.com"], pollIntervalMs: 999 },
      { mode: "polling", allowedSenders: ["sender@example.com"], maxPromptBytes: 511 },
      { mode: "polling", allowedSenders: ["sender@example.com"], maxAttempts: 21 },
      {
        mode: "polling",
        allowedSenders: ["sender@example.com"],
        classifications: {
          received: "discard",
          spam: "discard",
          blocked: "discard",
          unauthenticated: "discard",
        },
      },
      { mode: "none", classifications: { typo: "process" } },
    ]) {
      expect(() => agentMail({ ...baseOpts, inbound: inbound as never })).toThrow();
    }
  });

  test("allows a dormant, valid all-discard inbound policy", () => {
    expect(() =>
      agentMail({
        ...baseOpts,
        inbound: {
          mode: "none",
          classifications: {
            received: "discard",
            spam: "discard",
            blocked: "discard",
            unauthenticated: "discard",
          },
        },
      }),
    ).not.toThrow();
  });

  test("exposes inbound behavior through a concrete transport field", () => {
    const aug = agentMail({
      ...baseOpts,
      _reviewQueue: createAgentMailReviewQueue(),
      inbound: { mode: "polling", allowedSenders: ["*@example.com"] },
    });
    expect(aug.transport).toBeDefined();
    expect("capabilities" in aug).toBe(false);
    expect("supports" in aug).toBe(false);
  });

  test("requires durable review storage whenever enabled inbound can propose a reply", () => {
    expect(() =>
      agentMail({
        ...baseOpts,
        inbound: { mode: "polling", allowedSenders: ["*@example.com"] },
      }),
    ).toThrow(/durable review storage/);
    expect(() =>
      agentMail({
        ...baseOpts,
        inbound: {
          mode: "polling",
          allowedSenders: ["*@example.com"],
          replies: { mode: "disabled" },
        },
      }),
    ).not.toThrow();
  });

  test("fails boot before provider or ledger effects when an enabled digest is unattached", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      agentDir: makeTmpDir(),
      inbound: {
        mode: "polling",
        allowedSenders: ["*@example.com"],
        replies: { mode: "disabled" },
        creatorDigest: {
          enabled: true,
          destination: "creator",
        },
      },
    });

    await expect(aug.onBoot?.()).rejects.toThrow(/no Notify bridge is mounted/);
    expect(log.inbox).toHaveLength(0);
  });

  test("requires webhook configuration for webhook mode", () => {
    expect(() =>
      agentMail({
        ...baseOpts,
        inbound: { mode: "webhook", allowedSenders: ["customer@example.com"] },
      }),
    ).toThrow(/inbound.webhook/);
  });

  test("fails closed a persisted pending reply review without explicit recipients", async () => {
    const stateDir = makeTmpDir();
    const legacy = createAgentMailReviewQueue({
      stateDir,
      now: () => 1_000,
      id: () => "review_legacy_unbound",
    });
    const queued = legacy.enqueue({
      trustLevel: "creator",
      recipients: ["customer@example.com"],
      subject: "(reply)",
      rateKey: "reply:legacy",
      fingerprint: "legacy-fingerprint",
      request: {
        kind: "reply",
        messageId: "message_legacy",
        text: "Legacy provider-derived reply",
      },
      expiresAt: 60_000,
    }).record;
    const { client, log } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      stateDir,
      _now: () => 1_000,
      _client: client,
    });

    const persisted = createAgentMailReviewQueue({ stateDir, now: () => 1_000 });
    expect(persisted.get(queued.id)).toMatchObject({
      state: "failed",
      detail: expect.stringContaining("no explicit recipient binding"),
    });
    expect(
      await aug.adminActions!["agentmail-review-approve"]!({
        reviewId: queued.id,
        fingerprint: queued.fingerprint,
      }),
    ).toMatchObject({ ok: false, message: expect.stringContaining("not pending") });
    expect(log.reply).toHaveLength(0);
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
// Reviewed-send crash safety
// ---------------------------------------------------------------------------

describe("reviewed send delivery outcomes", () => {
  const request = { to: ["customer@example.com"], subject: "Hi", text: "Body" };
  const outbound = { allowedTrustLevels: ["public" as const] };

  async function queueAndApprove(
    stateDir: string,
    client: AgentMailClient,
  ): Promise<{ reviewId: string; approval: AdminActionResult }> {
    const queue = createAgentMailReviewQueue({ stateDir });
    const aug = agentMail({
      ...baseOpts,
      stateDir,
      _client: client,
      _reviewQueue: queue,
      outbound,
    });
    const proposed = JSON.parse(
      await asStr(tool(aug, "send_message")).execute(request, ctx(peer("public"))),
    ) as { status: string; reviewId: string };
    expect(proposed.status).toBe("pending_review");
    const fingerprint = queue.get(proposed.reviewId)?.fingerprint;
    if (!fingerprint) throw new Error("queued review missing fingerprint");
    const approval = await aug.adminActions!["agentmail-review-approve"]!({
      reviewId: proposed.reviewId,
      fingerprint,
    });
    return { reviewId: proposed.reviewId, approval };
  }

  async function expectRestartReplayBlocked(stateDir: string): Promise<void> {
    const { client: restartedClient, log } = fakeClient();
    const restarted = agentMail({ ...baseOpts, stateDir, _client: restartedClient, outbound });
    const replay = JSON.parse(
      await asStr(tool(restarted, "send_message")).execute(request, ctx(peer("public"))),
    );
    expect(["failed", "rate_limited"]).toContain(replay.status);
    expect(log.send).toHaveLength(0);
  }

  test("a thrown reviewed send remains sending across restart and blocks replay", async () => {
    const stateDir = makeTmpDir();
    const { client } = fakeClient({
      async send() {
        throw new Error("socket reset after request write");
      },
    });
    const { reviewId, approval } = await queueAndApprove(stateDir, client);

    expect(approval).toEqual({
      ok: false,
      message: `Review ${reviewId} has an ambiguous delivery outcome; operator reconciliation is required`,
    });
    expect(createAgentMailReviewQueue({ stateDir }).get(reviewId)?.state).toBe("sending");
    await expectRestartReplayBlocked(stateDir);
  });

  test("a status-less reviewed failure remains sending across restart and blocks replay", async () => {
    const stateDir = makeTmpDir();
    const { client } = fakeClient({
      async send() {
        return { status: "failed" as const, detail: "request timed out" };
      },
    });
    const { reviewId, approval } = await queueAndApprove(stateDir, client);

    expect(approval.ok).toBe(false);
    expect(approval.message).toMatch(/ambiguous delivery outcome/);
    expect(createAgentMailReviewQueue({ stateDir }).get(reviewId)?.state).toBe("sending");
    await expectRestartReplayBlocked(stateDir);
  });

  test("a reviewed 5xx remains sending across restart and blocks replay", async () => {
    const stateDir = makeTmpDir();
    const { client } = fakeClient({
      async send() {
        return {
          status: "failed" as const,
          detail: "agentmail returned 503",
          httpStatus: 503,
        };
      },
    });
    const { reviewId, approval } = await queueAndApprove(stateDir, client);

    expect(approval.ok).toBe(false);
    expect(approval.message).toMatch(/ambiguous delivery outcome/);
    expect(createAgentMailReviewQueue({ stateDir }).get(reviewId)?.state).toBe("sending");
    await expectRestartReplayBlocked(stateDir);
  });

  test("a definitive 4xx HTTP rejection becomes retryable as a new review", async () => {
    const stateDir = makeTmpDir();
    const { client } = fakeClient({
      async send() {
        return {
          status: "failed" as const,
          detail: "agentmail returned 400: rejected",
          httpStatus: 400,
        };
      },
    });
    const { reviewId, approval } = await queueAndApprove(stateDir, client);

    expect(approval).toEqual({ ok: false, message: `Review ${reviewId} failed (HTTP 400)` });
    expect(createAgentMailReviewQueue({ stateDir }).get(reviewId)?.state).toBe("failed");

    const { client: restartedClient, log } = fakeClient();
    const restarted = agentMail({ ...baseOpts, stateDir, _client: restartedClient, outbound });
    const retried = JSON.parse(
      await asStr(tool(restarted, "send_message")).execute(request, ctx(peer("public"))),
    ) as { status: string; reviewId: string };
    expect(retried.status).toBe("pending_review");
    expect(retried.reviewId).not.toBe(reviewId);
    expect(log.send).toHaveLength(0);
  });
});

describe("direct send durability journal", () => {
  test("a durable reservation prevents concurrent sends from exceeding cap one", async () => {
    const stateDir = makeTmpDir();
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerCalls = 0;
    const { client } = fakeClient({
      async send() {
        providerCalls++;
        await providerGate;
        return { status: "sent", messageId: "first", threadId: "thread" };
      },
    });
    const aug = agentMail({
      ...baseOpts,
      stateDir,
      _client: client,
      outbound: {
        allowedTrustLevels: ["creator", "agent"],
        rateLimit: { globalMaxPerHour: 1, perRecipientCooldownMs: 0, dedupWindowMs: 0 },
      },
    });
    const send = asStr(tool(aug, "send_message"));
    const first = send.execute(
      { to: ["a@x.com"], subject: "First", text: "Body" },
      ctx(peer("agent")),
    );
    await Promise.resolve();
    const second = JSON.parse(
      await send.execute({ to: ["b@x.com"], subject: "Second", text: "Body" }, ctx(peer("agent"))),
    );
    expect(second.status).toBe("rate_limited");
    expect(providerCalls).toBe(1);
    releaseProvider();
    expect(JSON.parse(await first).status).toBe("sent");
  });

  test("an ambiguous attempt reserves capacity for different mail across restart", async () => {
    const stateDir = makeTmpDir();
    const options = {
      ...baseOpts,
      stateDir,
      outbound: {
        allowedTrustLevels: ["creator", "agent"] as PeerIdentity["trustLevel"][],
        rateLimit: { globalMaxPerHour: 1, perRecipientCooldownMs: 0, dedupWindowMs: 0 },
      },
    };
    const first = fakeClient({
      async send() {
        throw new Error("connection reset after provider acceptance");
      },
    });
    await asStr(tool(agentMail({ ...options, _client: first.client }), "send_message")).execute(
      { to: ["a@x.com"], subject: "Ambiguous", text: "Body" },
      ctx(peer("agent")),
    );
    const restartedClient = fakeClient();
    const restarted = agentMail({ ...options, _client: restartedClient.client });
    const different = JSON.parse(
      await asStr(tool(restarted, "send_message")).execute(
        { to: ["b@x.com"], subject: "Different", text: "Body" },
        ctx(peer("agent")),
      ),
    );
    expect(different.status).toBe("rate_limited");
    expect(restartedClient.log.send).toHaveLength(0);
  });

  test("an ambiguous direct send remains sending across restart and blocks provider replay", async () => {
    const stateDir = makeTmpDir();
    let firstCalls = 0;
    const first = fakeClient({
      async send() {
        firstCalls++;
        throw new Error("connection reset after provider acceptance");
      },
    });
    const options = {
      ...baseOpts,
      stateDir,
      outbound: {
        allowedTrustLevels: ["creator", "agent"] as PeerIdentity["trustLevel"][],
        rateLimit: { globalMaxPerHour: 100, perRecipientCooldownMs: 0, dedupWindowMs: 0 },
      },
    };
    const input = { to: ["a@x.com"], subject: "Crash window", text: "Body" };
    const initial = await executeParsed(
      tool(agentMail({ ...options, _client: first.client }), "send_message"),
      input,
      ctx(peer("agent")),
    );
    expect(initial).toMatchObject({ status: "failed" });
    expect(initial.message).toMatch(/ambiguous.*Do not retry/i);
    expect(firstCalls).toBe(1);

    let replayCalls = 0;
    const restarted = fakeClient({
      async send() {
        replayCalls++;
        return { status: "sent", messageId: "duplicate", threadId: "duplicate-thread" };
      },
    });
    const replay = JSON.parse(
      await asStr(
        tool(agentMail({ ...options, _client: restarted.client }), "send_message"),
      ).execute(input, ctx(peer("agent"))),
    );
    expect(replay).toMatchObject({ status: "failed" });
    expect(replay.message).toMatch(/ambiguous sending state|operator reconciliation/i);
    expect(replayCalls).toBe(0);
  });

  test("an operator can reconcile a provider-confirmed send without replaying it", async () => {
    const stateDir = makeTmpDir();
    const options = {
      ...baseOpts,
      stateDir,
      outbound: {
        allowedTrustLevels: ["creator", "agent"] as PeerIdentity["trustLevel"][],
        rateLimit: { globalMaxPerHour: 1, perRecipientCooldownMs: 0, dedupWindowMs: 0 },
      },
    };
    const first = fakeClient({
      async send() {
        throw new Error("connection reset after provider acceptance");
      },
    });
    await asStr(tool(agentMail({ ...options, _client: first.client }), "send_message")).execute(
      { to: ["a@x.com"], subject: "Crash window", text: "Body" },
      ctx(peer("agent")),
    );
    const ambiguous = createAgentMailReviewQueue({ stateDir }).list()[0]!;
    expect(ambiguous.state).toBe("sending");

    let replayCalls = 0;
    const restartedClient = fakeClient({
      async send(input) {
        replayCalls++;
        return { status: "sent", messageId: input.subject, threadId: "unexpected" };
      },
    });
    const restarted = agentMail({ ...options, _client: restartedClient.client });
    const reviewRoute = restarted.httpRoutes!.find(
      (route) => route.path === "/agentmail/reviews/:reviewId",
    )!;
    const inspection = await reviewRoute.handler(
      new Request(`https://example.test/agentmail/reviews/${ambiguous.id}`),
      { signal: AbortSignal.timeout(1_000), params: { reviewId: ambiguous.id } },
    );
    expect(inspection.status).toBe(200);
    expect(await inspection.json()).toMatchObject({ state: "sending" });

    const reconciled = await restarted.adminActions!["agentmail-review-reconcile-sent"]!({
      reviewId: ambiguous.id,
      fingerprint: ambiguous.fingerprint,
      messageId: "provider-confirmed-id",
      threadId: "provider-confirmed-thread",
      evidence: "matched the recipient, subject, and provider timestamp",
    });
    expect(reconciled).toEqual({
      ok: true,
      message: `Review ${ambiguous.id} reconciled as sent`,
    });
    expect(createAgentMailReviewQueue({ stateDir }).get(ambiguous.id)).toMatchObject({
      state: "approved",
      providerMessageId: "provider-confirmed-id",
      providerThreadId: "provider-confirmed-thread",
      detail: expect.stringContaining("matched the recipient, subject, and provider timestamp"),
    });
    const later = JSON.parse(
      await asStr(tool(restarted, "send_message")).execute(
        { to: ["b@x.com"], subject: "Other mail", text: "Body" },
        ctx(peer("agent")),
      ),
    );
    expect(later.status).toBe("rate_limited");
    expect(replayCalls).toBe(0);
  });

  test("only fingerprint-bound evidence can release an ambiguous send for retry", async () => {
    const stateDir = makeTmpDir();
    const options = {
      ...baseOpts,
      stateDir,
      outbound: {
        allowedTrustLevels: ["creator", "agent"] as PeerIdentity["trustLevel"][],
        rateLimit: { globalMaxPerHour: 100, perRecipientCooldownMs: 0, dedupWindowMs: 0 },
      },
    };
    const first = fakeClient({
      async send() {
        throw new Error("connection reset after provider acceptance");
      },
    });
    const input = { to: ["a@x.com"], subject: "Crash window", text: "Body" };
    await asStr(tool(agentMail({ ...options, _client: first.client }), "send_message")).execute(
      input,
      ctx(peer("agent")),
    );
    const ambiguous = createAgentMailReviewQueue({ stateDir }).list()[0]!;
    const restarted = agentMail({ ...options, _client: fakeClient().client });

    expect(
      await restarted.adminActions!["agentmail-review-reconcile-failed"]!({
        reviewId: ambiguous.id,
        fingerprint: "wrong-fingerprint",
        reason: "provider search returned no matching message",
      }),
    ).toMatchObject({ ok: false, message: expect.stringContaining("fingerprint mismatch") });
    expect(createAgentMailReviewQueue({ stateDir }).get(ambiguous.id)?.state).toBe("sending");

    expect(
      await restarted.adminActions!["agentmail-review-reconcile-failed"]!({
        reviewId: ambiguous.id,
        fingerprint: ambiguous.fingerprint,
        reason: "provider search returned no matching message",
      }),
    ).toEqual({ ok: true, message: `Review ${ambiguous.id} reconciled as not sent` });
    expect(createAgentMailReviewQueue({ stateDir }).get(ambiguous.id)).toMatchObject({
      state: "failed",
      detail: expect.stringContaining("provider search returned no matching message"),
    });
  });

  test("reconciling after a queue commit crash charges one attempt exactly once", async () => {
    const stateDir = makeTmpDir();
    const durableQueue = createAgentMailReviewQueue({ stateDir });
    const crashingQueue = {
      ...durableQueue,
      approve() {
        throw new Error("simulated crash before queue approval commit");
      },
    };
    const options = {
      ...baseOpts,
      stateDir,
      outbound: {
        allowedTrustLevels: ["creator", "agent"] as PeerIdentity["trustLevel"][],
        rateLimit: { globalMaxPerHour: 10, perRecipientCooldownMs: 0, dedupWindowMs: 0 },
      },
    };
    const first = fakeClient();
    await expect(
      asStr(
        tool(
          agentMail({ ...options, _client: first.client, _reviewQueue: crashingQueue }),
          "send_message",
        ),
      ).execute({ to: ["a@x.com"], subject: "Commit crash", text: "Body" }, ctx(peer("agent"))),
    ).rejects.toThrow(/simulated crash/);
    const ambiguous = createAgentMailReviewQueue({ stateDir }).list()[0]!;
    expect(ambiguous.state).toBe("sending");

    const restarted = agentMail({ ...options, _client: fakeClient().client });
    expect(
      await restarted.adminActions!["agentmail-review-reconcile-sent"]!({
        reviewId: ambiguous.id,
        fingerprint: ambiguous.fingerprint,
        messageId: "provider-confirmed-id",
        evidence: "matched provider delivery log",
      }),
    ).toMatchObject({ ok: true });
    const persisted = JSON.parse(readFileSync(join(stateDir, "agent-mail-state.json"), "utf8"));
    expect(persisted.globalTimestamps).toHaveLength(1);
    expect(Object.keys(persisted.accountedAttemptIds)).toEqual([ambiguous.id]);
  });

  for (const [label, executeContext] of [
    ["creator", () => ctx(peer("creator"))],
    ["system", () => ctx(null)],
  ] as const) {
    test(`${label} sends retain a durable ambiguous marker across restart`, async () => {
      const stateDir = makeTmpDir();
      const input = { to: ["a@x.com"], subject: `${label} crash`, text: "Body" };
      let firstCalls = 0;
      const first = fakeClient({
        async send() {
          firstCalls++;
          throw new Error("connection reset after provider acceptance");
        },
      });
      const firstAugment = agentMail({ ...baseOpts, stateDir, _client: first.client });
      const initial = await executeParsed(
        tool(firstAugment, "send_message"),
        input,
        executeContext(),
      );
      expect(initial.message).toMatch(/ambiguous/i);
      expect(firstCalls).toBe(1);

      let replayCalls = 0;
      const restartedClient = fakeClient({
        async send() {
          replayCalls++;
          return { status: "sent", messageId: "duplicate", threadId: "duplicate" };
        },
      });
      const restarted = agentMail({ ...baseOpts, stateDir, _client: restartedClient.client });
      const replay = JSON.parse(
        await asStr(tool(restarted, "send_message")).execute(input, executeContext()),
      );
      expect(replay.message).toMatch(/ambiguous sending state|operator reconciliation/i);
      expect(replayCalls).toBe(0);
    });
  }

  test("admin test sends retain a durable ambiguous marker across restart", async () => {
    const stateDir = makeTmpDir();
    let firstCalls = 0;
    const first = fakeClient({
      async send() {
        firstCalls++;
        throw new Error("connection reset after provider acceptance");
      },
    });
    const params = { to: "operator@x.com", subject: "Admin crash", text: "Body" };
    const initial = await agentMail({
      ...baseOpts,
      stateDir,
      _client: first.client,
    }).adminActions!["agentmail-test-send"]!(params);
    expect(initial).toMatchObject({ ok: false, message: expect.stringContaining("ambiguous") });
    expect(firstCalls).toBe(1);

    let replayCalls = 0;
    const restartedClient = fakeClient({
      async send() {
        replayCalls++;
        return { status: "sent", messageId: "duplicate", threadId: "duplicate" };
      },
    });
    const replay = await agentMail({
      ...baseOpts,
      stateDir,
      _client: restartedClient.client,
    }).adminActions!["agentmail-test-send"]!(params);
    expect(replay).toMatchObject({
      ok: false,
      message: expect.stringMatching(/ambiguous sending state|operator reconciliation/i),
    });
    expect(replayCalls).toBe(0);
  });

  test("creator reply and forward attempts cannot replay after ambiguous acceptance", async () => {
    for (const kind of ["reply", "forward"] as const) {
      const stateDir = makeTmpDir();
      let firstCalls = 0;
      const first = fakeClient({
        async reply() {
          firstCalls++;
          throw new Error("connection reset after provider acceptance");
        },
        async forward() {
          firstCalls++;
          throw new Error("connection reset after provider acceptance");
        },
      });
      const firstAugment = agentMail({
        ...baseOpts,
        stateDir,
        _client: first.client,
      }) as ReturnType<typeof agentMail> & {
        _markSeenForTest: (id: string, meta: { from: string }) => void;
      };
      firstAugment._markSeenForTest("inbound_1", { from: "customer@example.com" });
      const toolName = kind === "reply" ? "reply_to_message" : "forward_message";
      const input =
        kind === "reply"
          ? { messageId: "inbound_1", text: "Reply body" }
          : { messageId: "inbound_1", to: ["ops@example.com"], text: "Forward body" };
      expect(
        (await executeParsed(tool(firstAugment, toolName), input, ctx(peer("creator")))).message,
      ).toMatch(/ambiguous/i);
      expect(firstCalls).toBe(1);

      let replayCalls = 0;
      const restartedClient = fakeClient({
        async reply() {
          replayCalls++;
          return { status: "sent", messageId: "duplicate", threadId: "duplicate" };
        },
        async forward() {
          replayCalls++;
          return { status: "sent", messageId: "duplicate", threadId: "duplicate" };
        },
      });
      const restarted = agentMail({
        ...baseOpts,
        stateDir,
        _client: restartedClient.client,
      }) as ReturnType<typeof agentMail> & {
        _markSeenForTest: (id: string, meta: { from: string }) => void;
      };
      restarted._markSeenForTest("inbound_1", { from: "customer@example.com" });
      expect(
        JSON.parse(await asStr(tool(restarted, toolName)).execute(input, ctx(peer("creator"))))
          .message,
      ).toMatch(/ambiguous sending state|operator reconciliation/i);
      expect(replayCalls).toBe(0);
    }
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

  test("5xx is outcome unknown and retains the durable reservation", async () => {
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
    const result = await tool(aug, "send_message").execute(
      { to: ["a@x.com"], subject: "S", text: "B" },
      ctx(peer("creator")),
    );
    expect(result).toMatchObject({ isError: true, outcomeUnknown: true });
  });

  test("ambiguous 5xx send consumes rate-limit quota and is not retried", async () => {
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
    // First attempt is ambiguous and must retain the only quota slot.
    const first = await tool(aug, "send_message").execute(
      { to: ["a@x.com"], subject: "S1", text: "B" },
      ctx(peer("agent")),
    );
    expect(first).toMatchObject({ isError: true, outcomeUnknown: true });
    nowMs += 1_000;
    const second = await executeParsed(
      tool(aug, "send_message"),
      { to: ["b@x.com"], subject: "S2", text: "B" },
      ctx(peer("agent")),
    );
    expect(second.status).toBe("rate_limited");
    expect(calls).toBe(1);
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
    expect(log.reply[0]!.to).toEqual(["carlos@vendor.com"]);
    expect(log.reply[0]!.replyAll).toBeUndefined();
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
  test("routes rate and review state to stateDir while leaving agentDir immutable", async () => {
    const agentDir = makeTmpDir();
    const stateDir = makeTmpDir();
    const { client } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      agentDir,
      stateDir,
      outbound: {
        allowedTrustLevels: ["creator", "agent", "public"],
        rateLimit: { globalMaxPerHour: 100, perRecipientCooldownMs: 0, dedupWindowMs: 60_000 },
      },
    });
    const send = asStr(tool(aug, "send_message"));

    await send.execute(
      { to: ["a@x.com"], subject: "Durable rate state", text: "B" },
      ctx(peer("agent")),
    );
    await send.execute(
      { to: ["b@x.com"], subject: "Durable review state", text: "B" },
      ctx(peer("public")),
    );

    expect(existsSync(join(stateDir, "agent-mail-state.json"))).toBe(true);
    expect(existsSync(join(stateDir, "agent-mail-reviews.json"))).toBe(true);
    expect(existsSync(join(agentDir, "agent-mail-state.json"))).toBe(false);
    expect(existsSync(join(agentDir, "agent-mail-reviews.json"))).toBe(false);

    const restarted = agentMail({
      ...baseOpts,
      _client: fakeClient().client,
      agentDir: makeTmpDir(),
      stateDir,
      outbound: {
        allowedTrustLevels: ["creator", "agent", "public"],
        rateLimit: { globalMaxPerHour: 100, perRecipientCooldownMs: 0, dedupWindowMs: 60_000 },
      },
    });
    const afterRestart = JSON.parse(
      await asStr(tool(restarted, "send_message")).execute(
        { to: ["c@x.com"], subject: "Durable rate state", text: "B" },
        ctx(peer("agent")),
      ),
    );
    expect(afterRestart.status).toBe("rate_limited");
  });

  test("latches durable write failures and blocks subsequent non-creator sends", async () => {
    const stateDir = makeTmpDir();
    const { client, log } = fakeClient();
    client.send = async (input) => {
      log.send.push(input);
      rmSync(join(stateDir, "agent-mail-state.json"));
      mkdirSync(join(stateDir, "agent-mail-state.json"));
      return { status: "sent", messageId: "msg_1", threadId: "thd_1" };
    };
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      stateDir,
      outbound: {
        allowedTrustLevels: ["creator", "agent"],
        rateLimit: { globalMaxPerHour: 100, perRecipientCooldownMs: 0, dedupWindowMs: 0 },
      },
    });
    const send = asStr(tool(aug, "send_message"));

    const accepted = JSON.parse(
      await send.execute({ to: ["a@x.com"], subject: "First", text: "B" }, ctx(peer("agent"))),
    );
    const blocked = JSON.parse(
      await send.execute({ to: ["b@x.com"], subject: "Second", text: "B" }, ctx(peer("agent"))),
    );
    expect(accepted.status).toBe("sent");
    expect(blocked.status).toBe("rate_limited");
    expect(blocked.message).toContain("durable rate-limit state is unavailable");
    expect(log.send).toHaveLength(1);
  });

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

  test("discovers the canonical address and exposes it to creator context", async () => {
    const { client } = fakeClient({
      async getInbox(inboxId) {
        return {
          inboxId,
          email: "Canonical@Example.com",
          displayName: "Canonical Agent",
          status: "ok" as const,
        };
      },
    });
    const aug = agentMail({ ...baseOpts, _client: client });
    await aug.onBoot?.();

    const creatorBlocks = await aug.context!(turnState(peer("creator")));
    expect(creatorBlocks).toHaveLength(1);
    expect(JSON.stringify(creatorBlocks)).toContain("canonical@example.com");
    expect(JSON.stringify(creatorBlocks)).toContain("Inbound monitoring is disabled");
    expect(await aug.context!(turnState(peer("public")))).toEqual([]);
  });

  test("shares a public address contextually and describes degraded monitoring", async () => {
    const failingClient = fakeClient({
      async getInbox() {
        return { status: "failed" as const, detail: "temporary outage", httpStatus: 503 };
      },
    });
    const aug = agentMail({
      ...baseOpts,
      emailAddress: "public@example.com",
      addressVisibility: "public",
      _client: failingClient.client,
    });
    await aug.onBoot?.();

    const blocks = await aug.context!(turnState(peer("public")));
    expect(JSON.stringify(blocks)).toContain("public@example.com");
    expect(JSON.stringify(blocks)).toContain("Inbound monitoring is disabled");
  });

  test("fails closed when configured and provider inbox addresses disagree", async () => {
    const { client } = fakeClient({
      async getInbox(inboxId) {
        return { status: "ok" as const, inboxId, email: "provider@example.com" };
      },
    });
    const aug = agentMail({
      ...baseOpts,
      emailAddress: "configured@example.com",
      _client: client,
    });
    await expect(aug.onBoot?.()).rejects.toThrow(/does not match AgentMail inbox/);
  });

  test("fails closed on a malformed successful provider identity", async () => {
    const failingClient = fakeClient({
      async getInbox() {
        return {
          status: "failed" as const,
          detail: "agentmail returned an invalid inbox response",
          httpStatus: 200,
          failureKind: "invalid-response" as const,
        };
      },
    });
    const aug = agentMail({
      ...baseOpts,
      emailAddress: "configured@example.com",
      addressVisibility: "public",
      _client: failingClient.client,
    });

    await expect(aug.onBoot?.()).rejects.toThrow(/invalid identity/);
  });

  const transientHealthFailures = [
    {
      label: "network",
      detail: "AgentMail network unavailable",
      httpStatus: undefined,
      failureKind: "network",
    },
    { label: "HTTP 408", detail: "AgentMail 408", httpStatus: 408, failureKind: "provider" },
    { label: "HTTP 425", detail: "AgentMail 425", httpStatus: 425, failureKind: "provider" },
    { label: "HTTP 429", detail: "AgentMail 429", httpStatus: 429, failureKind: "provider" },
    { label: "HTTP 503", detail: "AgentMail 503", httpStatus: 503, failureKind: "provider" },
  ] as const;

  for (const failure of transientHealthFailures) {
    test(`warn-and-continues on transient ${failure.label} without publishing an unverified address`, async () => {
      const failingClient = fakeClient({
        async getInbox() {
          return {
            status: "failed" as const,
            detail: failure.detail,
            failureKind: failure.failureKind,
            ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
          };
        },
      });
      const aug = agentMail({
        ...baseOpts,
        addressVisibility: "public",
        _client: failingClient.client,
      });

      await expect(aug.onBoot?.()).resolves.toBeUndefined();
      expect(await aug.context!(turnState(peer("public")))).toEqual([]);
      const info = await aug.adminInfo!();
      expect(info.sections.find((section) => section.kind === "status")).toMatchObject({
        kind: "status",
        level: "warn",
        message: expect.stringContaining(failure.detail),
      });
      const keyValue = info.sections.find((section) => section.kind === "keyValue");
      expect(keyValue?.kind).toBe("keyValue");
      if (keyValue?.kind === "keyValue") {
        expect(keyValue.rows.find((row) => row.label === "Inbox email")).toMatchObject({
          value: "(unavailable — run AgentMail setup)",
          source: "unavailable",
        });
      }
    });

    test(`warn-and-continues on transient ${failure.label} with the setup-verified address`, async () => {
      const failingClient = fakeClient({
        async getInbox() {
          return {
            status: "failed" as const,
            detail: failure.detail,
            failureKind: failure.failureKind,
            ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
          };
        },
      });
      const aug = agentMail({
        ...baseOpts,
        emailAddress: "Setup-Verified@Example.com",
        addressVisibility: "public",
        _client: failingClient.client,
      });

      await expect(aug.onBoot?.()).resolves.toBeUndefined();
      expect(JSON.stringify(await aug.context!(turnState(peer("public"))))).toContain(
        "setup-verified@example.com",
      );
      const info = await aug.adminInfo!();
      const keyValue = info.sections.find((section) => section.kind === "keyValue");
      expect(keyValue?.kind).toBe("keyValue");
      if (keyValue?.kind === "keyValue") {
        expect(keyValue.rows.find((row) => row.label === "Inbox email")).toMatchObject({
          value: "setup-verified@example.com",
          source: "configured",
        });
      }
    });
  }

  for (const httpStatus of [400, 401, 403, 404, 422] as const) {
    for (const emailAddress of [undefined, "setup-verified@example.com"] as const) {
      test(`fails closed on deterministic HTTP ${httpStatus} healthcheck failure ${emailAddress ? "with" : "without"} a configured address`, async () => {
        const failingClient = fakeClient({
          async getInbox() {
            return {
              status: "failed" as const,
              detail: `AgentMail ${httpStatus}`,
              httpStatus,
              failureKind: "provider" as const,
            };
          },
        });
        const aug = agentMail({
          ...baseOpts,
          ...(emailAddress ? { emailAddress } : {}),
          _client: failingClient.client,
        });
        await expect(aug.onBoot?.()).rejects.toThrow(new RegExp(String(httpStatus)));
      });
    }
  }

  test("keeps inbox identity and health status isolated between instances", async () => {
    const support = agentMail({
      ...baseOpts,
      instanceId: "support",
      inboxId: "inb_support",
      emailAddress: "support@example.com",
      addressVisibility: "public",
      _client: fakeClient({
        async getInbox() {
          return {
            status: "failed" as const,
            detail: "support inbox rate limited",
            httpStatus: 429,
            failureKind: "provider" as const,
          };
        },
      }).client,
    });
    const billing = agentMail({
      ...baseOpts,
      instanceId: "billing",
      inboxId: "inb_billing",
      addressVisibility: "public",
      _client: fakeClient({
        async getInbox(inboxId) {
          return { status: "ok" as const, inboxId, email: "billing@example.com" };
        },
      }).client,
    });

    try {
      await expect(Promise.all([support.onBoot?.(), billing.onBoot?.()])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect(JSON.stringify(await support.context!(turnState(peer("public"))))).toContain(
        "support@example.com",
      );
      expect(JSON.stringify(await billing.context!(turnState(peer("public"))))).toContain(
        "billing@example.com",
      );
      expect((await support.adminInfo!()).sections[0]).toMatchObject({
        kind: "status",
        level: "warn",
        message: expect.stringContaining("support inbox rate limited"),
      });
      expect((await billing.adminInfo!()).sections[0]).toMatchObject({
        kind: "status",
        level: "ok",
      });
    } finally {
      await Promise.all([support.onShutdown?.(), billing.onShutdown?.()]);
    }
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

  test("throws when AGENTMAIL_INBOX_EMAIL is unresolved (placeholder)", async () => {
    const { client } = fakeClient();
    const aug = agentMail({
      apiKey: "am_test_key",
      inboxId: "inb_test",
      emailAddress: "${AGENTMAIL_INBOX_EMAIL}",
      _client: client,
    });
    await expect(aug.onBoot?.()).rejects.toThrow(/AGENTMAIL_INBOX_EMAIL is unresolved/);
  });
});

describe("inbound lifecycle", () => {
  test("restores durable thread quarantines before accepting inbound traffic", async () => {
    const dbPath = join(makeTmpDir(), "restart-quarantine.sqlite");
    let ledger = createAgentMailInboundLedger({
      dbPath,
      now: () => 1_000,
      leaseToken: () => "interrupted_lease",
    });
    ledger.enqueue(
      normalizeAgentMailReceivedEvent(receivedWebhookEvent(), "webhook", baseOpts.inboxId),
    );
    expect(ledger.claimNext({ workerId: "old-process", leaseMs: 10_000 })).not.toBeNull();
    ledger.close();

    ledger = createAgentMailInboundLedger({
      dbPath,
      now: () => 1_001,
      incidentId: () => "restart_incident",
    });
    const { client } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      _reviewQueue: createAgentMailReviewQueue(),
      _inboundLedger: ledger,
      _sdkAdapters: emptySdkAdapters(),
      inbound: {
        mode: "webhook",
        allowedSenders: ["*@example.com"],
        webhook: {},
      },
    });
    const restored: string[] = [];
    const kernel = fakeInboundKernel([]);
    kernel.quarantineThread = (threadId) => {
      restored.push(threadId);
      return true;
    };

    try {
      await aug.onBoot!();
      await aug.transport!.register(kernel, aug.name);
      await aug.transport!.ready!();
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatch(/^am-thread-/);

      const nextEvent = receivedWebhookEvent();
      const message = nextEvent.message as Record<string, unknown>;
      message.message_id = "message_same_thread_after_restart";
      nextEvent.event_id = "event_same_thread_after_restart";
      ledger.enqueue(normalizeAgentMailReceivedEvent(nextEvent, "webhook", baseOpts.inboxId));
      expect(ledger.claimNext({ workerId: "new-process", leaseMs: 1_000 })).toBeNull();

      expect(
        await aug.adminActions!["agentmail-inbound-reconcile-handled"]!({
          incidentId: "restart_incident",
          version: "1",
          evidence: "provider confirms the original operation completed",
        }),
      ).toEqual({
        ok: true,
        message: "Inbound incident reconciled as already handled",
        recoverThreadId: restored[0],
      });
      expect(
        ledger.claimNext({ workerId: "new-process", leaseMs: 1_000 })?.envelope.message.messageId,
      ).toBe("message_same_thread_after_restart");
    } finally {
      await aug.onShutdown!();
      ledger.close();
    }
  });

  test("enabled inbound defaults to review without granting general public outbound", async () => {
    const { client, log } = fakeClient();
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:" });
    const triggers: TurnTrigger[] = [];
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      _reviewQueue: createAgentMailReviewQueue(),
      _inboundLedger: ledger,
      _sdkAdapters: emptySdkAdapters(),
      inbound: {
        mode: "webhook",
        allowedSenders: ["customer@example.com"],
        webhook: {},
      },
      outbound: {
        allowedRecipients: ["customer@example.com"],
      },
    });

    try {
      expect(aug.httpRoutes).toHaveLength(2);
      const reviewRoute = aug.httpRoutes!.find(
        (route) => route.path === "/agentmail/reviews/:reviewId",
      );
      expect(reviewRoute).toMatchObject({ method: "GET", auth: "creator" });
      await aug.onBoot!();
      expect(aug.httpRoutes).toHaveLength(3);
      const webhookRoute = aug.httpRoutes!.find((route) => route.path === "/webhooks/agentmail");
      expect(webhookRoute?.policy).toMatchObject({
        kind: "webhook.signature",
        provider: "svix",
      });

      let inTurnReply: Record<string, unknown> | undefined;
      let replyAllResult: Record<string, unknown> | undefined;
      let publicSend: Record<string, unknown> | undefined;
      let publicForward: Record<string, unknown> | undefined;
      let wrongSourceReply: Record<string, unknown> | undefined;
      await aug.transport!.register(
        fakeInboundKernel(triggers, async (trigger) => {
          const reply = asStr(tool(aug, "reply_to_message"));
          const exactContext = {
            turnId: trigger.turnId,
            threadId: trigger.threadId!,
            peer: trigger.peer ?? null,
          };
          replyAllResult = JSON.parse(
            await reply.execute(
              { messageId: "message_inbound", text: "Everyone", replyAll: true },
              exactContext,
            ),
          );
          publicSend = await executeParsed(
            tool(aug, "send_message"),
            { to: ["customer@example.com"], subject: "Not authorized", text: "No" },
            exactContext,
          );
          publicForward = await executeParsed(
            tool(aug, "forward_message"),
            {
              messageId: "message_inbound",
              to: ["customer@example.com"],
              text: "Not authorized",
            },
            exactContext,
          );
          wrongSourceReply = JSON.parse(
            await reply.execute(
              { messageId: "message_inbound", text: "Wrong source" },
              {
                ...exactContext,
                peer: { ...trigger.peer!, sourceAugment: "web" },
              },
            ),
          );
          inTurnReply = JSON.parse(
            await reply.execute({ messageId: "message_inbound", text: "Thanks" }, exactContext),
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
      expect(replyAllResult?.status).toBe("failed");
      expect(String(replyAllResult?.message)).toContain("replyAll is disabled");
      expect(publicSend?.status).toBe("failed");
      expect(publicForward?.status).toBe("failed");
      expect(wrongSourceReply?.status).toBe("failed");
      expect(inTurnReply?.status).toBe("pending_review");
      expect(log.reply).toHaveLength(0);

      const reviewId = String(inTurnReply?.reviewId);
      expect(ledger.creatorAttention.get(baseOpts.inboxId, "message_inbound")).toMatchObject({
        state: "pending_review",
        reviewId,
        version: 2,
      });
      const redactedAdmin = JSON.stringify(await aug.adminInfo!());
      expect(redactedAdmin).not.toContain("Thanks");
      expect(redactedAdmin).toContain("customer@example.com");
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
      expect(ledger.creatorAttention.get(baseOpts.inboxId, "message_inbound")).toMatchObject({
        state: "sent",
        reviewId,
        version: 3,
      });
      const terminalInspection = await reviewRoute!.handler(
        new Request(`https://example.test/agentmail/reviews/${reviewId}`),
        { signal: AbortSignal.timeout(1_000), params: { reviewId } },
      );
      expect(terminalInspection.status).toBe(410);
      expect(terminalInspection.headers.get("cache-control")).toBe("no-store");
      expect(terminalInspection.headers.get("x-content-type-options")).toBe("nosniff");

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

  test("explicit automatic mode sends the exact reply but grants no reusable public authority", async () => {
    const { client, log } = fakeClient();
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:" });
    const triggers: TurnTrigger[] = [];
    let replyResult: Record<string, unknown> | undefined;
    let sensitiveResult: Record<string, unknown> | undefined;
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      _reviewQueue: createAgentMailReviewQueue(),
      _inboundLedger: ledger,
      _sdkAdapters: emptySdkAdapters(),
      inbound: {
        mode: "webhook",
        allowedSenders: ["*@example.com"],
        replies: { mode: "automatic" },
        webhook: {},
      },
      outbound: {
        allowedRecipients: ["*@example.com"],
        rateLimit: { enabled: true, globalMaxPerHour: 10 },
      },
    });

    try {
      await aug.onBoot!();
      await aug.transport!.register(
        fakeInboundKernel(triggers, async (trigger) => {
          const first = triggers.length === 1;
          const result = await executeParsed(
            tool(aug, "reply_to_message"),
            {
              messageId: first ? "message_inbound" : "message_sensitive",
              text: first
                ? "Automatic reply"
                : "A token-shaped value: sk-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890",
            },
            {
              turnId: trigger.turnId,
              threadId: trigger.threadId!,
              peer: trigger.peer ?? null,
            },
          );
          if (first) replyResult = result;
          else sensitiveResult = result;
        }),
        aug.name,
      );
      await aug.transport!.ready!();
      const webhookRoute = aug.httpRoutes!.find((route) => route.path === "/webhooks/agentmail")!;
      await webhookRoute.handler(
        new Request("https://example.test/webhooks/agentmail", { method: "POST" }),
        {
          signal: AbortSignal.timeout(1_000),
          webhook: verifiedWebhook(receivedWebhookEvent()),
        },
      );

      await eventually(
        () => ledger.get(baseOpts.inboxId, "message_inbound")?.state === "processed",
      );
      expect(replyResult?.status).toBe("sent");
      expect(log.reply).toHaveLength(1);
      expect(ledger.creatorAttention.get(baseOpts.inboxId, "message_inbound")).toMatchObject({
        state: "sent",
      });

      const genericPublic = await executeParsed(
        tool(aug, "reply_to_message"),
        { messageId: "message_inbound", text: "Not in the admitted turn" },
        { turnId: "other-turn", threadId: "other-thread", peer: peer("public") },
      );
      expect(genericPublic.status).toBe("failed");
      expect(log.reply).toHaveLength(1);
      let runtime = (await aug.adminInfo!()).sections.find(
        (section) => section.kind === "keyValue",
      );
      if (runtime?.kind !== "keyValue") throw new Error("missing AgentMail runtime rows");
      expect(runtime.rows.find((row) => row.label === "Pending human reviews")?.value).toBe("0");

      const sensitiveEvent = receivedWebhookEvent();
      sensitiveEvent.event_id = "event_sensitive";
      (sensitiveEvent.message as Record<string, unknown>).message_id = "message_sensitive";
      (sensitiveEvent.message as Record<string, unknown>).from = "other@example.com";
      await webhookRoute.handler(
        new Request("https://example.test/webhooks/agentmail", { method: "POST" }),
        {
          signal: AbortSignal.timeout(1_000),
          webhook: {
            ...verifiedWebhook(sensitiveEvent),
            deliveryId: "delivery_sensitive",
          },
        },
      );
      await eventually(
        () => ledger.get(baseOpts.inboxId, "message_sensitive")?.state === "processed",
      );
      expect(sensitiveResult?.status).toBe("pending_review");
      expect(log.reply).toHaveLength(1);
      expect(ledger.creatorAttention.get(baseOpts.inboxId, "message_sensitive")).toMatchObject({
        state: "pending_review",
      });
      runtime = (await aug.adminInfo!()).sections.find((section) => section.kind === "keyValue");
      if (runtime?.kind !== "keyValue") throw new Error("missing AgentMail runtime rows");
      expect(runtime.rows.find((row) => row.label === "Pending human reviews")?.value).toBe("1");
    } finally {
      await aug.onShutdown!();
      ledger.close();
    }
  });

  test("pins Reply-To recipients, removes the canonical inbox, and reviews mismatches", async () => {
    const { client, log } = fakeClient();
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:" });
    const queue = createAgentMailReviewQueue();
    const triggers: TurnTrigger[] = [];
    let replyResult: Record<string, unknown> | undefined;
    let mismatchedScopeResult: Record<string, unknown> | undefined;
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      _reviewQueue: queue,
      _inboundLedger: ledger,
      _sdkAdapters: emptySdkAdapters(),
      inbound: {
        mode: "webhook",
        allowedSenders: ["*@example.com"],
        replies: { mode: "automatic", allowReplyAll: true },
        webhook: {},
      },
      outbound: {
        allowedRecipients: ["*@example.com"],
        allowedTrustLevels: ["public"],
        humanReview: { requiredForTrustLevels: [] },
        rateLimit: { enabled: true, globalMaxPerHour: 10 },
      },
    });

    try {
      await aug.onBoot!();
      await aug.transport!.register(
        fakeInboundKernel(triggers, async (trigger) => {
          mismatchedScopeResult = await executeParsed(
            tool(aug, "reply_to_message"),
            { messageId: "message_inbound", text: "Spoofed scope response" },
            {
              turnId: trigger.turnId,
              threadId: trigger.threadId!,
              peer: peer("public"),
            },
          );
          replyResult = await executeParsed(
            tool(aug, "reply_to_message"),
            { messageId: "message_inbound", text: "Pinned response", replyAll: true },
            {
              turnId: trigger.turnId,
              threadId: trigger.threadId!,
              peer: trigger.peer ?? null,
            },
          );
        }),
        aug.name,
      );
      await aug.transport!.ready!();
      const event = receivedWebhookEvent();
      const message = event.message as Record<string, unknown>;
      message.reply_to = ["delegate@example.com"];
      message.to = ["agent@example.com", "colleague@example.com", "COLLEAGUE@example.com"];
      message.cc = ["manager@example.com", "agent@example.com"];
      const route = aug.httpRoutes!.find((candidate) => candidate.path === "/webhooks/agentmail")!;
      await route.handler(
        new Request("https://example.test/webhooks/agentmail", { method: "POST" }),
        {
          signal: AbortSignal.timeout(1_000),
          webhook: verifiedWebhook(event),
        },
      );

      await eventually(
        () => ledger.get(baseOpts.inboxId, "message_inbound")?.state === "processed",
      );
      expect(replyResult?.status).toBe("pending_review");
      expect(mismatchedScopeResult).toMatchObject({
        status: "failed",
        message: expect.stringContaining("identity does not match"),
      });
      expect(log.reply).toHaveLength(0);
      const review = queue.get(String(replyResult?.reviewId));
      expect(review?.request).toMatchObject({
        kind: "reply",
        messageId: "message_inbound",
        to: [
          "delegate@example.com",
          "customer@example.com",
          "colleague@example.com",
          "manager@example.com",
        ],
      });
      expect((review!.request as { replyAll?: boolean }).replyAll).toBe(true);

      const approved = await aug.adminActions!["agentmail-review-approve"]!({
        reviewId: review!.id,
        fingerprint: review!.fingerprint,
      });
      expect(approved.ok).toBe(true);
      expect(log.reply[0]?.to).toEqual((review!.request as { to: string[] }).to);
      expect(log.reply[0]?.replyAll).toBeUndefined();
    } finally {
      await aug.onShutdown!();
      ledger.close();
    }
  });

  test("backpressures at attention capacity without loss and resumes the exact message", async () => {
    let nowMs = 1_000;
    const ledger = createAgentMailInboundLedger({
      dbPath: ":memory:",
      now: () => nowMs,
      attentionMaxRecords: 1,
    });
    ledger.enqueue(receivedEnvelope("message_capacity_blocker"));
    const blockerClaim = ledger.claimNext({ workerId: "setup", leaseMs: 5_000 })!;
    expect(ledger.complete(blockerClaim)).toBe(true);
    const blocker = ledger.creatorAttention.reserve({
      inboxId: baseOpts.inboxId,
      messageId: "message_capacity_blocker",
      allowReopen: false,
    }).record;
    const triggers: TurnTrigger[] = [];
    const aug = agentMail({
      ...baseOpts,
      _now: () => nowMs,
      _client: fakeClient().client,
      _reviewQueue: createAgentMailReviewQueue({ now: () => nowMs }),
      _inboundLedger: ledger,
      _sdkAdapters: emptySdkAdapters(),
      inbound: {
        mode: "webhook",
        allowedSenders: ["customer@example.com"],
        webhook: {},
      },
      outbound: { allowedRecipients: ["customer@example.com"] },
    });

    try {
      await aug.onBoot!();
      await aug.transport!.register(fakeInboundKernel(triggers), aug.name);
      await aug.transport!.ready!();
      const route = aug.httpRoutes!.find((candidate) => candidate.path === "/webhooks/agentmail")!;
      await route.handler(
        new Request("https://example.test/webhooks/agentmail", { method: "POST" }),
        {
          signal: AbortSignal.timeout(1_000),
          webhook: verifiedWebhook(receivedWebhookEvent()),
        },
      );

      await eventuallyWithin(
        () =>
          ledger.get(baseOpts.inboxId, "message_inbound")?.lastError ===
          "creator-attention-capacity",
        1_500,
      );
      expect(ledger.get(baseOpts.inboxId, "message_inbound")).toMatchObject({
        state: "pending",
        attemptCount: 0,
        availableAt: 6_000,
      });
      expect(triggers).toHaveLength(0);

      nowMs = 6_000;
      expect(
        await aug.adminActions!["agentmail-attention-dismiss"]!({
          messageId: blocker.messageId,
          expectedVersion: String(blocker.version),
        }),
      ).toMatchObject({ ok: true });

      await eventuallyWithin(
        () => ledger.get(baseOpts.inboxId, "message_inbound")?.state === "processed",
        1_500,
      );
      expect(triggers).toHaveLength(1);
      expect(ledger.get(baseOpts.inboxId, "message_inbound")).toMatchObject({
        state: "processed",
        attemptCount: 1,
      });
      expect(ledger.creatorAttention.get(baseOpts.inboxId, "message_capacity_blocker")).toBeNull();
      expect(ledger.creatorAttention.get(baseOpts.inboxId, "message_inbound")).toMatchObject({
        state: "open",
      });
    } finally {
      await aug.onShutdown!();
      ledger.close();
    }
  });

  test("cancels pending review before no-effect recovery and safely reopens attention", async () => {
    const baseLedger = createAgentMailInboundLedger({
      dbPath: ":memory:",
      incidentId: () => "incident_completion",
    });
    let rejectCompletion = true;
    const ledger = new Proxy(baseLedger, {
      get(target, property, receiver) {
        if (property === "complete") {
          return (claim: Parameters<typeof baseLedger.complete>[0]) => {
            if (rejectCompletion) {
              rejectCompletion = false;
              return false;
            }
            return baseLedger.complete(claim);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const queue = createAgentMailReviewQueue();
    const { client, log } = fakeClient();
    const triggers: TurnTrigger[] = [];
    let firstReply: Record<string, unknown> | undefined;
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      _reviewQueue: queue,
      _inboundLedger: ledger,
      _sdkAdapters: emptySdkAdapters(),
      inbound: {
        mode: "webhook",
        allowedSenders: ["customer@example.com"],
        webhook: {},
      },
      outbound: { allowedRecipients: ["customer@example.com"] },
    });

    try {
      await aug.onBoot!();
      await aug.transport!.register(
        fakeInboundKernel(triggers, async (trigger) => {
          if (triggers.length !== 1) return;
          firstReply = await executeParsed(
            tool(aug, "reply_to_message"),
            { messageId: "message_inbound", text: "Draft before completion failure" },
            {
              turnId: trigger.turnId,
              threadId: trigger.threadId!,
              peer: trigger.peer ?? null,
            },
          );
        }),
        aug.name,
      );
      await aug.transport!.ready!();
      const route = aug.httpRoutes!.find((candidate) => candidate.path === "/webhooks/agentmail")!;
      await route.handler(
        new Request("https://example.test/webhooks/agentmail", { method: "POST" }),
        {
          signal: AbortSignal.timeout(1_000),
          webhook: verifiedWebhook(receivedWebhookEvent()),
        },
      );

      await eventually(() => baseLedger.listIncidents().length === 1);
      expect(firstReply?.status).toBe("pending_review");
      const linkedReview = queue.get(String(firstReply?.reviewId))!;
      expect(linkedReview.state).toBe("pending");
      expect(baseLedger.creatorAttention.get(baseOpts.inboxId, "message_inbound")?.state).toBe(
        "pending_review",
      );

      const recovery = await aug.adminActions!["agentmail-inbound-reconcile-no-effect"]!({
        incidentId: "incident_completion",
        version: "1",
        evidence: "verified that no provider reply was sent",
      });
      expect(recovery.ok).toBe(true);
      expect(queue.get(linkedReview.id)?.state).toBe("failed");
      expect(baseLedger.creatorAttention.get(baseOpts.inboxId, "message_inbound")?.state).toBe(
        "failed",
      );

      await eventuallyWithin(
        () => baseLedger.get(baseOpts.inboxId, "message_inbound")?.state === "processed",
        1_500,
      );
      expect(triggers).toHaveLength(2);
      expect(log.reply).toHaveLength(0);
      const reopenedAttention = baseLedger.creatorAttention.get(
        baseOpts.inboxId,
        "message_inbound",
      );
      expect(reopenedAttention).toMatchObject({ state: "open" });
      expect(reopenedAttention).not.toHaveProperty("reviewId");
    } finally {
      await aug.onShutdown!();
      baseLedger.close();
    }
  });

  test("blocks no-effect retry from durable reply evidence even when attention is absent", async () => {
    for (const reviewState of ["sending", "approved", "rejected"] as const) {
      const incidentId = `incident_review_${reviewState}`;
      const ledger = createAgentMailInboundLedger({
        dbPath: ":memory:",
        now: () => 1_000,
        incidentId: () => incidentId,
        attentionMaxRecords: 1,
      });
      ledger.enqueue(receivedEnvelope(`message_old_${reviewState}`));
      const oldClaim = ledger.claimNext({ workerId: "setup-old", leaseMs: 5_000 })!;
      expect(ledger.complete(oldClaim)).toBe(true);
      const old = ledger.creatorAttention.reserve({
        inboxId: baseOpts.inboxId,
        messageId: `message_old_${reviewState}`,
        allowReopen: false,
      }).record;
      ledger.creatorAttention.transition({
        inboxId: old.inboxId,
        messageId: old.messageId,
        expectedVersion: old.version,
        state: "dismissed",
      });
      ledger.enqueue(receivedEnvelope(`message_surrounding_${reviewState}`));
      const surroundingClaim = ledger.claimNext({
        workerId: "setup-surrounding",
        leaseMs: 5_000,
      })!;
      expect(ledger.complete(surroundingClaim)).toBe(true);
      ledger.creatorAttention.reserve({
        inboxId: baseOpts.inboxId,
        messageId: `message_surrounding_${reviewState}`,
        allowReopen: false,
      });
      expect(ledger.creatorAttention.get(old.inboxId, old.messageId)).toBeNull();

      ledger.enqueue(
        normalizeAgentMailReceivedEvent(receivedWebhookEvent(), "webhook", baseOpts.inboxId),
      );
      const claim = ledger.claimNext({ workerId: "worker", leaseMs: 5_000 })!;
      expect(ledger.quarantine(claim, "turn-completion-not-recorded")?.id).toBe(incidentId);
      const queue = createAgentMailReviewQueue({
        now: () => 1_000,
        id: () => `review_${reviewState}`,
      });
      const review = queue.enqueue({
        trustLevel: "creator",
        recipients: ["customer@example.com"],
        subject: "(reply)",
        rateKey: "reply:message_inbound",
        fingerprint: `fingerprint_${reviewState}`,
        request: {
          kind: "reply",
          messageId: "message_inbound",
          to: ["customer@example.com"],
          text: "Durable reply evidence",
        },
        expiresAt: 60_000,
      }).record;
      if (reviewState === "sending" || reviewState === "approved") {
        queue.beginApproval(review.id);
      }
      if (reviewState === "approved") {
        queue.approve(review.id, { messageId: "provider_message" });
      } else if (reviewState === "rejected") {
        queue.reject(review.id, "operator rejected");
      }
      const aug = agentMail({
        ...baseOpts,
        _now: () => 1_000,
        _client: fakeClient().client,
        _reviewQueue: queue,
        _inboundLedger: ledger,
        _sdkAdapters: emptySdkAdapters(),
        inbound: {
          mode: "webhook",
          allowedSenders: ["customer@example.com"],
          webhook: {},
        },
        outbound: { allowedRecipients: ["customer@example.com"] },
      });

      try {
        await aug.onBoot!();
        expect(ledger.creatorAttention.get(baseOpts.inboxId, "message_inbound")).toBeNull();
        const recovery = await aug.adminActions!["agentmail-inbound-reconcile-no-effect"]!({
          incidentId,
          version: "1",
          evidence: "operator found no other effects",
        });
        expect(recovery).toMatchObject({
          ok: false,
          message: expect.stringContaining(`review_${reviewState}`),
        });
        expect(ledger.get(baseOpts.inboxId, "message_inbound")?.state).toBe("outcome_unknown");
      } finally {
        await aug.onShutdown!();
        ledger.close();
      }
    }
  });

  test("cancels an unlinked pending reply review before no-effect retry", async () => {
    const ledger = createAgentMailInboundLedger({
      dbPath: ":memory:",
      now: () => 1_000,
      incidentId: () => "incident_unlinked_pending",
    });
    ledger.enqueue(
      normalizeAgentMailReceivedEvent(receivedWebhookEvent(), "webhook", baseOpts.inboxId),
    );
    const claim = ledger.claimNext({ workerId: "worker", leaseMs: 5_000 })!;
    ledger.quarantine(claim, "turn-completion-not-recorded");
    const queue = createAgentMailReviewQueue({
      now: () => 1_000,
      id: () => "review_unlinked_pending",
    });
    const review = queue.enqueue({
      trustLevel: "creator",
      recipients: ["customer@example.com"],
      subject: "(reply)",
      rateKey: "reply:message_inbound",
      fingerprint: "fingerprint_unlinked_pending",
      request: {
        kind: "reply",
        messageId: "message_inbound",
        to: ["customer@example.com"],
        text: "Pending reply",
      },
      expiresAt: 60_000,
    }).record;
    const aug = agentMail({
      ...baseOpts,
      _now: () => 1_000,
      _client: fakeClient().client,
      _reviewQueue: queue,
      _inboundLedger: ledger,
      _sdkAdapters: emptySdkAdapters(),
      inbound: {
        mode: "webhook",
        allowedSenders: ["customer@example.com"],
        webhook: {},
      },
      outbound: { allowedRecipients: ["customer@example.com"] },
    });

    try {
      await aug.onBoot!();
      const recovery = await aug.adminActions!["agentmail-inbound-reconcile-no-effect"]!({
        incidentId: "incident_unlinked_pending",
        version: "1",
        evidence: "verified no provider action",
      });
      expect(recovery.ok).toBe(true);
      expect(queue.get(review.id)).toMatchObject({ state: "failed" });
      expect(ledger.get(baseOpts.inboxId, "message_inbound")).toMatchObject({
        state: "pending",
        lastError: "operator confirmed no external effect",
      });
    } finally {
      await aug.onShutdown!();
      ledger.close();
    }
  });

  test("reconciles an expired linked review into creator attention after restart", async () => {
    const root = makeTmpDir();
    const dbPath = join(root, "attention-restart.sqlite");
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    let nowMs = 1_800_000_000_000;
    let ledger = createAgentMailInboundLedger({ dbPath, now: () => nowMs });
    const firstClient = fakeClient();
    let replyResult: Record<string, unknown> | undefined;
    const first = agentMail({
      ...baseOpts,
      stateDir,
      _now: () => nowMs,
      _client: firstClient.client,
      _inboundLedger: ledger,
      _sdkAdapters: emptySdkAdapters(),
      inbound: {
        mode: "webhook",
        allowedSenders: ["customer@example.com"],
        webhook: {},
      },
      outbound: { allowedRecipients: ["customer@example.com"] },
    });
    try {
      await first.onBoot!();
      await first.transport!.register(
        fakeInboundKernel([], async (trigger) => {
          replyResult = await executeParsed(
            tool(first, "reply_to_message"),
            { messageId: "message_inbound", text: "Review expires during restart" },
            {
              turnId: trigger.turnId,
              threadId: trigger.threadId!,
              peer: trigger.peer ?? null,
            },
          );
        }),
        first.name,
      );
      await first.transport!.ready!();
      const route = first.httpRoutes!.find(
        (candidate) => candidate.path === "/webhooks/agentmail",
      )!;
      await route.handler(
        new Request("https://example.test/webhooks/agentmail", { method: "POST" }),
        {
          signal: AbortSignal.timeout(1_000),
          webhook: verifiedWebhook(receivedWebhookEvent()),
        },
      );
      await eventually(
        () => ledger.get(baseOpts.inboxId, "message_inbound")?.state === "processed",
      );
      expect(replyResult?.status).toBe("pending_review");
      expect(ledger.creatorAttention.get(baseOpts.inboxId, "message_inbound")?.state).toBe(
        "pending_review",
      );
    } finally {
      await first.onShutdown!();
      ledger.close();
    }

    nowMs += 24 * 60 * 60_000 + 1;
    ledger = createAgentMailInboundLedger({ dbPath, now: () => nowMs });
    const second = agentMail({
      ...baseOpts,
      stateDir,
      _now: () => nowMs,
      _client: fakeClient().client,
      _inboundLedger: ledger,
      _sdkAdapters: emptySdkAdapters(),
      inbound: {
        mode: "webhook",
        allowedSenders: ["customer@example.com"],
        webhook: {},
      },
    });
    try {
      await second.onBoot!();
      expect(ledger.creatorAttention.get(baseOpts.inboxId, "message_inbound")).toMatchObject({
        state: "failed",
        reviewId: String(replyResult?.reviewId),
      });
    } finally {
      await second.onShutdown!();
      ledger.close();
    }
  });

  test("repairs a crash between durable review enqueue and attention linking", async () => {
    const root = makeTmpDir();
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const nowMs = 1_800_000_000_000;
    const ledger = createAgentMailInboundLedger({
      dbPath: join(root, "review-link.sqlite"),
      now: () => nowMs,
    });
    ledger.enqueue(
      normalizeAgentMailReceivedEvent(receivedWebhookEvent(), "webhook", baseOpts.inboxId),
    );
    const reserved = ledger.creatorAttention.reserve({
      inboxId: baseOpts.inboxId,
      messageId: "message_inbound",
      allowReopen: false,
    });
    const queue = createAgentMailReviewQueue({
      stateDir,
      now: () => nowMs,
      id: () => "review_crash",
    });
    queue.enqueue({
      trustLevel: "public",
      recipients: ["customer@example.com"],
      subject: "(reply)",
      rateKey: "reply:message_inbound",
      fingerprint: "crash-window-fingerprint",
      request: {
        kind: "reply",
        messageId: "message_inbound",
        to: ["customer@example.com"],
        attentionVersion: reserved.record.version,
        text: "Durably queued before crash",
      },
      expiresAt: nowMs + 60_000,
    });
    expect(reserved.record.state).toBe("open");

    const aug = agentMail({
      ...baseOpts,
      stateDir,
      _now: () => nowMs,
      _client: fakeClient().client,
      _inboundLedger: ledger,
      _sdkAdapters: emptySdkAdapters(),
      inbound: {
        mode: "webhook",
        allowedSenders: ["customer@example.com"],
        webhook: {},
      },
    });
    try {
      await aug.onBoot!();
      expect(ledger.creatorAttention.get(baseOpts.inboxId, "message_inbound")).toMatchObject({
        state: "pending_review",
        reviewId: "review_crash",
      });
    } finally {
      await aug.onShutdown!();
      ledger.close();
    }
  });

  test("repairs only the exact reopened attention generation when review timestamps tie", async () => {
    const root = makeTmpDir();
    const stateDir = join(root, "state");
    const dbPath = join(root, "generation-link.sqlite");
    mkdirSync(stateDir, { recursive: true });
    const nowMs = 1_800_000_000_000;
    let ledger = createAgentMailInboundLedger({
      dbPath,
      now: () => nowMs,
    });
    ledger.enqueue(
      normalizeAgentMailReceivedEvent(receivedWebhookEvent(), "webhook", baseOpts.inboxId),
    );
    const firstGeneration = ledger.creatorAttention.reserve({
      inboxId: baseOpts.inboxId,
      messageId: "message_inbound",
      allowReopen: false,
    }).record;
    const ids = ["review_generation_1", "review_generation_legacy", "review_generation_2"];
    const queue = createAgentMailReviewQueue({
      stateDir,
      now: () => nowMs,
      id: () => ids.shift()!,
    });
    const firstReview = queue.enqueue({
      trustLevel: "public",
      recipients: ["customer@example.com"],
      subject: "(reply)",
      rateKey: "reply:message_inbound",
      fingerprint: "generation-1-fingerprint",
      request: {
        kind: "reply",
        messageId: "message_inbound",
        to: ["customer@example.com"],
        attentionVersion: firstGeneration.version,
        text: "First generation",
      },
      expiresAt: nowMs + 60_000,
    }).record;
    const linkedFirst = ledger.creatorAttention.transition({
      inboxId: firstGeneration.inboxId,
      messageId: firstGeneration.messageId,
      expectedVersion: firstGeneration.version,
      state: "pending_review",
      reviewId: firstReview.id,
    }).record!;
    queue.cancel(firstReview.id, "operator confirmed no provider effect");
    const failedFirst = ledger.creatorAttention.transition({
      inboxId: linkedFirst.inboxId,
      messageId: linkedFirst.messageId,
      expectedVersion: linkedFirst.version,
      state: "failed",
    }).record!;
    const reopened = ledger.creatorAttention.reserve({
      inboxId: failedFirst.inboxId,
      messageId: failedFirst.messageId,
      allowReopen: true,
    }).record;
    ledger.enqueue(receivedEnvelope("message_legacy_generation"));
    const legacyAttention = ledger.creatorAttention.reserve({
      inboxId: baseOpts.inboxId,
      messageId: "message_legacy_generation",
      allowReopen: false,
    }).record;
    const legacyReview = queue.enqueue({
      trustLevel: "creator",
      recipients: ["customer@example.com"],
      subject: "(reply)",
      rateKey: "reply:message_legacy_generation",
      fingerprint: "legacy-generation-fingerprint",
      request: {
        kind: "reply",
        messageId: "message_legacy_generation",
        to: ["customer@example.com"],
        text: "Legacy non-inbound review without an attention generation",
      },
      expiresAt: nowMs + 60_000,
    }).record;
    const secondReview = queue.enqueue({
      trustLevel: "public",
      recipients: ["customer@example.com"],
      subject: "(reply)",
      rateKey: "reply:message_inbound",
      fingerprint: "generation-2-fingerprint",
      request: {
        kind: "reply",
        messageId: "message_inbound",
        to: ["customer@example.com"],
        attentionVersion: reopened.version,
        text: "Second generation",
      },
      expiresAt: nowMs + 60_000,
    }).record;
    expect(firstReview.createdAt).toBe(secondReview.createdAt);
    expect(reopened).toMatchObject({ state: "open" });
    expect(reopened).not.toHaveProperty("reviewId");
    ledger.close();

    ledger = createAgentMailInboundLedger({ dbPath, now: () => nowMs });
    const restarted = agentMail({
      ...baseOpts,
      stateDir,
      _now: () => nowMs,
      _client: fakeClient().client,
      _inboundLedger: ledger,
      _sdkAdapters: emptySdkAdapters(),
      inbound: {
        mode: "webhook",
        allowedSenders: ["customer@example.com"],
        webhook: {},
      },
      outbound: { allowedRecipients: ["customer@example.com"] },
    });
    try {
      await restarted.onBoot!();
      expect(ledger.creatorAttention.get(baseOpts.inboxId, "message_inbound")).toMatchObject({
        state: "pending_review",
        reviewId: secondReview.id,
      });
      expect(
        ledger.creatorAttention.get(baseOpts.inboxId, legacyAttention.messageId),
      ).toMatchObject({
        state: "open",
        version: legacyAttention.version,
      });
      const reloadedQueue = createAgentMailReviewQueue({
        stateDir,
        now: () => nowMs,
      });
      expect(reloadedQueue.get(firstReview.id)).toMatchObject({ state: "failed" });
      expect(reloadedQueue.get(legacyReview.id)).toMatchObject({ state: "pending" });
      expect(reloadedQueue.get(secondReview.id)).toMatchObject({ state: "pending" });
    } finally {
      await restarted.onShutdown!();
      ledger.close();
    }
  });

  test("never replays a failed turn after its automatic reply was already sent", async () => {
    const ledger = createAgentMailInboundLedger({
      dbPath: ":memory:",
      incidentId: () => "incident_effect_observed",
    });
    const { client, log } = fakeClient();
    const triggers: TurnTrigger[] = [];
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      _reviewQueue: createAgentMailReviewQueue(),
      _inboundLedger: ledger,
      _sdkAdapters: emptySdkAdapters(),
      inbound: {
        mode: "webhook",
        allowedSenders: ["customer@example.com"],
        replies: { mode: "automatic" },
        webhook: {},
      },
      outbound: {
        allowedRecipients: ["customer@example.com"],
        rateLimit: { enabled: true, globalMaxPerHour: 10 },
      },
    });
    const kernel = fakeInboundKernel(triggers);
    kernel.handleInbound = async (trigger) => {
      triggers.push(trigger);
      const reply = await executeParsed(
        tool(aug, "reply_to_message"),
        { messageId: "message_inbound", text: "Provider accepted before turn failure" },
        {
          turnId: trigger.turnId,
          threadId: trigger.threadId!,
          peer: trigger.peer ?? null,
        },
      );
      expect(reply.status).toBe("sent");
      return { success: false, status: "failed", turnId: trigger.turnId } as TurnResult;
    };

    try {
      await aug.onBoot!();
      await aug.transport!.register(kernel, aug.name);
      await aug.transport!.ready!();
      const route = aug.httpRoutes!.find((candidate) => candidate.path === "/webhooks/agentmail")!;
      await route.handler(
        new Request("https://example.test/webhooks/agentmail", { method: "POST" }),
        {
          signal: AbortSignal.timeout(1_000),
          webhook: verifiedWebhook(receivedWebhookEvent()),
        },
      );

      await eventually(() => ledger.listIncidents().length === 1);
      expect(log.reply).toHaveLength(1);
      expect(triggers).toHaveLength(1);
      expect(ledger.listIncidents()[0]?.reasonCode).toBe("turn-effects-observed-before-failure");
      expect(ledger.creatorAttention.get(baseOpts.inboxId, "message_inbound")?.state).toBe("sent");
      expect(
        (
          await aug.adminActions!["agentmail-inbound-reconcile-no-effect"]!({
            incidentId: "incident_effect_observed",
            version: "1",
            evidence: "attempted unsafe retry",
          })
        ).ok,
      ).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(log.reply).toHaveLength(1);
    } finally {
      await aug.onShutdown!();
      ledger.close();
    }
  });

  test("marks reserved attention failed when definitive turn retries are exhausted", async () => {
    const baseLedger = createAgentMailInboundLedger({ dbPath: ":memory:" });
    let finalizedBeforeDiscard = false;
    const ledger = new Proxy(baseLedger, {
      get(target, property, receiver) {
        if (property === "discard") {
          return (claim: Parameters<typeof baseLedger.discard>[0], reason: string) => {
            finalizedBeforeDiscard =
              baseLedger.creatorAttention.get(baseOpts.inboxId, "message_inbound")?.state ===
              "failed";
            return baseLedger.discard(claim, reason);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const { client } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      _reviewQueue: createAgentMailReviewQueue(),
      _inboundLedger: ledger,
      _sdkAdapters: emptySdkAdapters(),
      inbound: {
        mode: "webhook",
        allowedSenders: ["customer@example.com"],
        replies: { mode: "disabled" },
        maxAttempts: 1,
        webhook: {},
      },
    });
    const kernel = fakeInboundKernel([]);
    kernel.handleInbound = async (trigger) =>
      ({ success: false, status: "rejected", turnId: trigger.turnId }) as TurnResult;
    try {
      await aug.onBoot!();
      await aug.transport!.register(kernel, aug.name);
      await aug.transport!.ready!();
      const route = aug.httpRoutes!.find((candidate) => candidate.path === "/webhooks/agentmail")!;
      await route.handler(
        new Request("https://example.test/webhooks/agentmail", { method: "POST" }),
        {
          signal: AbortSignal.timeout(1_000),
          webhook: verifiedWebhook(receivedWebhookEvent()),
        },
      );
      await eventually(
        () => ledger.get(baseOpts.inboxId, "message_inbound")?.state === "discarded",
      );
      expect(ledger.creatorAttention.get(baseOpts.inboxId, "message_inbound")?.state).toBe(
        "failed",
      );
      expect(finalizedBeforeDiscard).toBe(true);
    } finally {
      await aug.onShutdown!();
      baseLedger.close();
    }
  });

  test("quarantines instead of discarding when terminal attention finalization fails", async () => {
    const baseLedger = createAgentMailInboundLedger({
      dbPath: ":memory:",
      incidentId: () => "incident_terminal_attention",
    });
    const attention = new Proxy(baseLedger.creatorAttention, {
      get(target, property, receiver) {
        if (property === "transition") {
          return (input: Parameters<typeof baseLedger.creatorAttention.transition>[0]) => {
            if (input.state === "failed") throw new Error("simulated attention write failure");
            return baseLedger.creatorAttention.transition(input);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const ledger = new Proxy(baseLedger, {
      get(target, property, receiver) {
        if (property === "creatorAttention") return attention;
        return Reflect.get(target, property, receiver);
      },
    });
    const triggers: TurnTrigger[] = [];
    const aug = agentMail({
      ...baseOpts,
      _client: fakeClient().client,
      _reviewQueue: createAgentMailReviewQueue(),
      _inboundLedger: ledger,
      _sdkAdapters: emptySdkAdapters(),
      inbound: {
        mode: "webhook",
        allowedSenders: ["customer@example.com"],
        replies: { mode: "disabled" },
        maxAttempts: 1,
        webhook: {},
      },
    });
    const kernel = fakeInboundKernel(triggers);
    kernel.handleInbound = async (trigger) => {
      triggers.push(trigger);
      return { success: false, status: "rejected", turnId: trigger.turnId } as TurnResult;
    };
    try {
      await aug.onBoot!();
      await aug.transport!.register(kernel, aug.name);
      await aug.transport!.ready!();
      const route = aug.httpRoutes!.find((candidate) => candidate.path === "/webhooks/agentmail")!;
      await route.handler(
        new Request("https://example.test/webhooks/agentmail", { method: "POST" }),
        {
          signal: AbortSignal.timeout(1_000),
          webhook: verifiedWebhook(receivedWebhookEvent()),
        },
      );

      await eventually(() => baseLedger.listIncidents().length === 1);
      expect(baseLedger.listIncidents()[0]).toMatchObject({
        id: "incident_terminal_attention",
        reasonCode: "terminal-attention-not-recorded",
      });
      expect(baseLedger.get(baseOpts.inboxId, "message_inbound")).toMatchObject({
        state: "outcome_unknown",
        discardReason: undefined,
      });
      expect(baseLedger.creatorAttention.get(baseOpts.inboxId, "message_inbound")).toMatchObject({
        state: "open",
      });
      expect(triggers).toHaveLength(1);
    } finally {
      await aug.onShutdown!();
      baseLedger.close();
    }
  });

  test("disabled replies block delivery and creator attention dismissal uses version CAS", async () => {
    const { client, log } = fakeClient();
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:" });
    const triggers: TurnTrigger[] = [];
    let replyResult: Record<string, unknown> | undefined;
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      _reviewQueue: createAgentMailReviewQueue(),
      _inboundLedger: ledger,
      _sdkAdapters: emptySdkAdapters(),
      inbound: {
        mode: "webhook",
        allowedSenders: ["customer@example.com"],
        replies: { mode: "disabled" },
        webhook: {},
      },
    });

    try {
      await aug.onBoot!();
      await aug.transport!.register(
        fakeInboundKernel(triggers, async (trigger) => {
          replyResult = await executeParsed(
            tool(aug, "reply_to_message"),
            { messageId: "message_inbound", text: "Must not send" },
            {
              turnId: trigger.turnId,
              threadId: trigger.threadId!,
              peer: trigger.peer ?? null,
            },
          );
        }),
        aug.name,
      );
      await aug.transport!.ready!();
      const webhookRoute = aug.httpRoutes!.find((route) => route.path === "/webhooks/agentmail")!;
      await webhookRoute.handler(
        new Request("https://example.test/webhooks/agentmail", { method: "POST" }),
        {
          signal: AbortSignal.timeout(1_000),
          webhook: verifiedWebhook(receivedWebhookEvent()),
        },
      );

      await eventually(
        () => ledger.get(baseOpts.inboxId, "message_inbound")?.state === "processed",
      );
      expect(replyResult?.status).toBe("failed");
      expect(String(replyResult?.message)).toContain(
        "replies from inbound email turns are disabled",
      );
      expect(log.reply).toHaveLength(0);
      expect(ledger.creatorAttention.get(baseOpts.inboxId, "message_inbound")).toMatchObject({
        state: "open",
        version: 1,
      });
      expect(
        await aug.adminActions!["agentmail-attention-dismiss"]!({
          messageId: "message_inbound",
          expectedVersion: "2",
        }),
      ).toEqual({
        ok: false,
        message: "Creator attention changed; current state is open at version 1",
      });
      expect(
        await aug.adminActions!["agentmail-attention-dismiss"]!({
          messageId: "message_inbound",
          expectedVersion: "1",
        }),
      ).toEqual({
        ok: true,
        message: "Creator attention for message_inbound dismissed",
      });
      expect(ledger.creatorAttention.get(baseOpts.inboxId, "message_inbound")).toMatchObject({
        state: "dismissed",
        version: 2,
      });
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
      _reviewQueue: createAgentMailReviewQueue(),
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

  test("continues REST reconciliation after a permanent WebSocket close", async () => {
    const { client } = fakeClient();
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:" });
    const triggers: TurnTrigger[] = [];
    const envelope = normalizeAgentMailReceivedEvent(
      receivedWebhookEvent(),
      "webhook",
      baseOpts.inboxId,
    );
    let closedUnexpectedly = false;
    let listCalls = 0;
    let subscribedEventTypes: readonly string[] = [];
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const sdk: AgentMailSdkAdapters = {
      catchUp: {
        async listMessages(input) {
          listCalls++;
          expect(input.processedEventTypes).toEqual(["message.received"]);
          return {
            messages: closedUnexpectedly
              ? [
                  {
                    inboxId: envelope.message.inboxId,
                    threadId: envelope.message.threadId,
                    messageId: envelope.message.messageId,
                    labels: envelope.message.labels,
                    timestamp: envelope.message.timestamp,
                  },
                ]
              : [],
            nextPageToken: undefined,
          };
        },
        async getMessage() {
          return envelope.message;
        },
      },
      live: {
        subscribe: async (input) => {
          subscribedEventTypes = input.eventTypes;
          await input.onSubscribed?.({ reconnected: false });
          return { closed, close: async () => resolveClosed() };
        },
      },
    };
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      _reviewQueue: createAgentMailReviewQueue(),
      _inboundLedger: ledger,
      _sdkAdapters: sdk,
      inbound: {
        mode: "websocket",
        allowedSenders: ["customer@example.com"],
        pollIntervalMs: 1_000,
      },
    });

    try {
      await aug.onBoot!();
      await aug.transport!.register(fakeInboundKernel(triggers), aug.name);
      await aug.transport!.ready!();
      expect(subscribedEventTypes).toEqual(["message.received"]);
      expect(listCalls).toBe(1);

      closedUnexpectedly = true;
      resolveClosed();
      await eventuallyWithin(() => triggers.length === 1, 1_500);

      expect(listCalls).toBeGreaterThanOrEqual(2);
      const runtime = (await aug.adminInfo!()).sections.find(
        (section) => section.kind === "keyValue",
      );
      if (runtime?.kind !== "keyValue") throw new Error("missing AgentMail runtime rows");
      expect(runtime.rows.find((row) => row.label === "Inbound runtime")?.value).toBe("degraded");
      expect(ledger.get(baseOpts.inboxId, envelope.message.messageId)?.state).toBe("processed");
    } finally {
      await aug.onShutdown!();
      ledger.close();
    }
  });

  test("periodically reconciles webhook delivery gaps", async () => {
    const { client } = fakeClient();
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:" });
    const triggers: TurnTrigger[] = [];
    const envelope = normalizeAgentMailReceivedEvent(
      receivedWebhookEvent(),
      "webhook",
      baseOpts.inboxId,
    );
    let missedDeliveryAvailable = false;
    let listCalls = 0;
    const sdk: AgentMailSdkAdapters = {
      catchUp: {
        async listMessages() {
          listCalls++;
          return {
            messages: missedDeliveryAvailable
              ? [
                  {
                    inboxId: envelope.message.inboxId,
                    threadId: envelope.message.threadId,
                    messageId: envelope.message.messageId,
                    labels: envelope.message.labels,
                    timestamp: envelope.message.timestamp,
                  },
                ]
              : [],
            nextPageToken: undefined,
          };
        },
        async getMessage() {
          return envelope.message;
        },
      },
      live: emptySdkAdapters().live,
    };
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      _reviewQueue: createAgentMailReviewQueue(),
      _inboundLedger: ledger,
      _sdkAdapters: sdk,
      inbound: {
        mode: "webhook",
        allowedSenders: ["customer@example.com"],
        pollIntervalMs: 1_000,
        webhook: {},
      },
    });

    try {
      await aug.onBoot!();
      await aug.transport!.register(fakeInboundKernel(triggers), aug.name);
      await aug.transport!.ready!();
      expect(listCalls).toBe(1);

      missedDeliveryAvailable = true;
      await eventuallyWithin(() => triggers.length === 1, 1_500);

      expect(listCalls).toBeGreaterThanOrEqual(2);
      expect(ledger.get(baseOpts.inboxId, envelope.message.messageId)?.state).toBe("processed");
    } finally {
      await aug.onShutdown!();
      ledger.close();
    }
  });

  test("coalesces overlapping scheduled catch-up runs", async () => {
    const { client } = fakeClient();
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:" });
    let listCalls = 0;
    let releaseSlowCatchUp!: () => void;
    const slowCatchUp = new Promise<void>((resolve) => {
      releaseSlowCatchUp = resolve;
    });
    const sdk: AgentMailSdkAdapters = {
      catchUp: {
        async listMessages() {
          listCalls++;
          if (listCalls === 2) await slowCatchUp;
          return { messages: [], nextPageToken: undefined };
        },
        async getMessage() {
          throw new Error("unexpected getMessage");
        },
      },
      live: emptySdkAdapters().live,
    };
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      _reviewQueue: createAgentMailReviewQueue(),
      _inboundLedger: ledger,
      _sdkAdapters: sdk,
      inbound: {
        mode: "polling",
        allowedSenders: ["customer@example.com"],
        pollIntervalMs: 1_000,
      },
    });

    try {
      await aug.onBoot!();
      await aug.transport!.register(fakeInboundKernel([]), aug.name);
      await aug.transport!.ready!();
      await eventuallyWithin(() => listCalls === 2, 1_500);

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(listCalls).toBe(2);
      releaseSlowCatchUp();
      await eventuallyWithin(() => listCalls >= 3, 1_500);
    } finally {
      releaseSlowCatchUp();
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

  test("releases an owned ledger even when subscription close fails", async () => {
    const { client } = fakeClient();
    const dbPath = join(makeTmpDir(), "shutdown.sqlite");
    let closeCalls = 0;
    const sdk: AgentMailSdkAdapters = {
      catchUp: emptySdkAdapters().catchUp,
      live: {
        subscribe: async (input) => {
          await input.onSubscribed?.({ reconnected: false });
          return {
            closed: new Promise<void>(() => {}),
            async close() {
              closeCalls++;
              throw new Error("subscription close failed");
            },
          };
        },
      },
    };
    const aug = agentMail({
      ...baseOpts,
      dbPath,
      _client: client,
      _reviewQueue: createAgentMailReviewQueue(),
      _sdkAdapters: sdk,
      inbound: { mode: "websocket", allowedSenders: ["*@example.com"] },
    });
    await aug.onBoot!();
    await aug.transport!.register(fakeInboundKernel([]), aug.name);
    await aug.transport!.ready!();

    const first = aug.onShutdown!();
    const concurrent = aug.onShutdown!();
    await expect(Promise.all([first, concurrent])).rejects.toThrow("subscription close failed");
    expect(closeCalls).toBe(1);

    const reopened = createAgentMailInboundLedger({ dbPath });
    expect(reopened.counts()).toEqual({
      pending: 0,
      processing: 0,
      processed: 0,
      discarded: 0,
      outcomeUnknown: 0,
    });
    reopened.close();
    await expect(aug.onShutdown!()).resolves.toBeUndefined();
    expect(closeCalls).toBe(1);
  });

  test("reuses a webhook route with the current owned ledger after restart", async () => {
    const { client } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      dbPath: join(makeTmpDir(), "webhook-restart.sqlite"),
      _client: client,
      _reviewQueue: createAgentMailReviewQueue(),
      _sdkAdapters: emptySdkAdapters(),
      inbound: { mode: "webhook", allowedSenders: ["customer@example.com"], webhook: {} },
    });
    await aug.onBoot!();
    const route = aug.httpRoutes!.find((candidate) => candidate.path === "/webhooks/agentmail")!;
    await aug.onShutdown!();
    await aug.onBoot!();

    const response = await route.handler(
      new Request("https://example.test/webhooks/agentmail", { method: "POST" }),
      {
        signal: AbortSignal.timeout(1_000),
        webhook: verifiedWebhook(receivedWebhookEvent()),
      },
    );
    expect(response.status).toBe(200);
    await aug.onShutdown!();
  });

  test("retains queued WebSocket delivery until listener shutdown quiesces", async () => {
    const { client } = fakeClient();
    const dbPath = join(makeTmpDir(), "queued-shutdown.sqlite");
    const sdk: AgentMailSdkAdapters = {
      catchUp: emptySdkAdapters().catchUp,
      live: {
        subscribe: async (input) => {
          await input.onSubscribed?.({ reconnected: false });
          return {
            closed: new Promise<void>(() => {}),
            async close() {
              await input.onEvent(
                normalizeAgentMailReceivedEvent(
                  receivedWebhookEvent(),
                  "websocket",
                  baseOpts.inboxId,
                ),
              );
            },
          };
        },
      },
    };
    const aug = agentMail({
      ...baseOpts,
      dbPath,
      _client: client,
      _reviewQueue: createAgentMailReviewQueue(),
      _sdkAdapters: sdk,
      inbound: { mode: "websocket", allowedSenders: ["*@example.com"] },
    });
    await aug.onBoot!();
    await aug.transport!.register(fakeInboundKernel([]), aug.name);
    await aug.transport!.ready!();
    await aug.onShutdown!();

    const reopened = createAgentMailInboundLedger({ dbPath });
    expect(reopened.counts().pending).toBe(1);
    reopened.close();
  });

  test("defers owned-ledger close until a turn that exceeded shutdown deadline settles", async () => {
    const { client } = fakeClient();
    const dbPath = join(makeTmpDir(), "slow-drain-shutdown.sqlite");
    let releaseTurn!: () => void;
    const turnBlocked = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let turnStarted = false;
    const aug = agentMail({
      ...baseOpts,
      dbPath,
      _client: client,
      _reviewQueue: createAgentMailReviewQueue(),
      _sdkAdapters: emptySdkAdapters(),
      _shutdownTimeoutMs: 20,
      inbound: {
        mode: "webhook",
        allowedSenders: ["customer@example.com"],
        replies: { mode: "disabled" },
        webhook: {},
      },
    });
    const kernel = fakeInboundKernel([]);
    kernel.handleInbound = async (trigger) => {
      turnStarted = true;
      await turnBlocked;
      return { success: true, status: "completed", turnId: trigger.turnId } as TurnResult;
    };
    await aug.onBoot!();
    await aug.transport!.register(kernel, aug.name);
    await aug.transport!.ready!();
    const route = aug.httpRoutes!.find((candidate) => candidate.path === "/webhooks/agentmail")!;
    await route.handler(
      new Request("https://example.test/webhooks/agentmail", { method: "POST" }),
      {
        signal: AbortSignal.timeout(1_000),
        webhook: verifiedWebhook(receivedWebhookEvent()),
      },
    );
    await eventually(() => turnStarted);

    await expect(aug.onShutdown!()).rejects.toThrow(/inbound drain shutdown timed out/i);
    releaseTurn();
    await eventuallyWithin(() => {
      const probe = createAgentMailInboundLedger({ dbPath });
      try {
        return probe.counts().processed === 1;
      } finally {
        probe.close();
      }
    }, 1_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(aug.onShutdown!()).resolves.toBeUndefined();
  });

  test("bounds a hung subscription and still releases its owned ledger", async () => {
    const { client } = fakeClient();
    const dbPath = join(makeTmpDir(), "hung-shutdown.sqlite");
    const sdk: AgentMailSdkAdapters = {
      catchUp: emptySdkAdapters().catchUp,
      live: {
        subscribe: async (input) => {
          await input.onSubscribed?.({ reconnected: false });
          return {
            closed: new Promise<void>(() => {}),
            close: () => new Promise<void>(() => {}),
          };
        },
      },
    };
    const aug = agentMail({
      ...baseOpts,
      dbPath,
      _client: client,
      _reviewQueue: createAgentMailReviewQueue(),
      _sdkAdapters: sdk,
      _shutdownTimeoutMs: 20,
      inbound: { mode: "websocket", allowedSenders: ["*@example.com"] },
    });
    await aug.onBoot!();
    await aug.transport!.register(fakeInboundKernel([]), aug.name);
    await aug.transport!.ready!();

    await expect(aug.onShutdown!()).rejects.toThrow(/subscription shutdown timed out/i);
    const reopened = createAgentMailInboundLedger({ dbPath });
    expect(reopened.counts()).toEqual({
      pending: 0,
      processing: 0,
      processed: 0,
      discarded: 0,
      outcomeUnknown: 0,
    });
    reopened.close();
  });

  test("waits for active reconciliation before closing its owned ledger", async () => {
    const { client } = fakeClient();
    const dbPath = join(makeTmpDir(), "catch-up-shutdown.sqlite");
    let listCalls = 0;
    let releaseCatchUp!: () => void;
    const catchUpBlocked = new Promise<void>((resolve) => {
      releaseCatchUp = resolve;
    });
    const sdk: AgentMailSdkAdapters = {
      catchUp: {
        async listMessages() {
          listCalls++;
          if (listCalls === 2) await catchUpBlocked;
          return { messages: [], nextPageToken: undefined };
        },
        async getMessage() {
          throw new Error("unexpected getMessage");
        },
      },
      live: emptySdkAdapters().live,
    };
    const aug = agentMail({
      ...baseOpts,
      dbPath,
      _client: client,
      _reviewQueue: createAgentMailReviewQueue(),
      _sdkAdapters: sdk,
      inbound: {
        mode: "polling",
        allowedSenders: ["customer@example.com"],
        pollIntervalMs: 1_000,
      },
    });
    await aug.onBoot!();
    await aug.transport!.register(fakeInboundKernel([]), aug.name);
    await aug.transport!.ready!();
    await eventuallyWithin(() => listCalls === 2, 1_500);

    let stopped = false;
    const shutdown = aug.onShutdown!().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);

    releaseCatchUp();
    await shutdown;
    const callsAtShutdown = listCalls;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(listCalls).toBe(callsAtShutdown);

    const reopened = createAgentMailInboundLedger({ dbPath });
    expect(reopened.counts().pending).toBe(0);
    reopened.close();
  });

  test("treats an abort-aware active reconciliation as a clean shutdown", async () => {
    const { client } = fakeClient();
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:" });
    const envelope = normalizeAgentMailReceivedEvent(
      receivedWebhookEvent(),
      "webhook",
      baseOpts.inboxId,
    );
    let listCalls = 0;
    let releaseCatchUp!: () => void;
    const catchUpBlocked = new Promise<void>((resolve) => {
      releaseCatchUp = resolve;
    });
    const sdk: AgentMailSdkAdapters = {
      catchUp: {
        async listMessages() {
          listCalls++;
          if (listCalls === 1) return { messages: [], nextPageToken: undefined };
          await catchUpBlocked;
          return {
            messages: [
              {
                inboxId: envelope.message.inboxId,
                threadId: envelope.message.threadId,
                messageId: envelope.message.messageId,
                labels: envelope.message.labels,
                timestamp: envelope.message.timestamp,
              },
            ],
            nextPageToken: undefined,
          };
        },
        async getMessage() {
          throw new Error("aborted catch-up must not fetch a message body");
        },
      },
      live: emptySdkAdapters().live,
    };
    const aug = agentMail({
      ...baseOpts,
      _client: client,
      _reviewQueue: createAgentMailReviewQueue(),
      _inboundLedger: ledger,
      _sdkAdapters: sdk,
      inbound: {
        mode: "polling",
        allowedSenders: ["customer@example.com"],
        pollIntervalMs: 1_000,
      },
    });
    try {
      await aug.onBoot!();
      await aug.transport!.register(fakeInboundKernel([]), aug.name);
      await aug.transport!.ready!();
      await eventuallyWithin(() => listCalls === 2, 1_500);

      const shutdown = aug.onShutdown!();
      releaseCatchUp();
      await expect(shutdown).resolves.toBeUndefined();
    } finally {
      releaseCatchUp();
      ledger.close();
    }
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
      expect(kv.rows.find((r) => r.label === "Inbox email")?.value).toBe(
        "(unavailable — run AgentMail setup)",
      );
      expect(kv.rows.find((r) => r.label === "Inbox email")?.source).toBe("unavailable");
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

  test("automatic inbound rejects oversized runtime and persisted cap overrides", async () => {
    const automatic = agentMail({
      ...baseOpts,
      _client: fakeClient().client,
      _reviewQueue: createAgentMailReviewQueue(),
      inbound: {
        mode: "polling",
        allowedSenders: ["customer@example.com"],
        replies: { mode: "automatic" },
      },
      outbound: { rateLimit: { enabled: true, globalMaxPerHour: 10 } },
    });
    expect(await automatic.adminActions!["agentmail-cap-adjust"]!({ value: "101" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("between 1 and 100"),
    });

    const dir = makeTmpDir();
    const writer = agentMail({
      ...baseOpts,
      agentDir: dir,
      _client: fakeClient().client,
    });
    expect(await writer.adminActions!["agentmail-cap-adjust"]!({ value: "101" })).toMatchObject({
      ok: true,
    });
    await writer.onShutdown!();
    expect(() =>
      agentMail({
        ...baseOpts,
        agentDir: dir,
        _client: fakeClient().client,
        inbound: {
          mode: "polling",
          allowedSenders: ["customer@example.com"],
          replies: { mode: "automatic" },
        },
        outbound: { rateLimit: { enabled: true, globalMaxPerHour: 10 } },
      }),
    ).toThrow(/admin override globalMaxPerHour between 1 and 100/);
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

  test("uses stable instance identity for admin metadata and namespaced routes", async () => {
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:" });
    const aug = agentMail({
      ...baseOpts,
      instanceId: "support-mail",
      _client: fakeClient().client,
      _reviewQueue: createAgentMailReviewQueue(),
      _inboundLedger: ledger,
      _sdkAdapters: emptySdkAdapters(),
      inbound: {
        mode: "webhook",
        allowedSenders: ["customer@example.com"],
        webhook: {},
      },
    });
    expect(aug.name).toBe("support-mail");
    expect(aug.type).toBe("agentMail");
    expect((await aug.adminInfo!()).augmentName).toBe("support-mail");
    expect(aug.httpRoutes?.map((route) => route.path)).toEqual([
      "/agentmail/support-mail/reviews/:reviewId",
      "/agentmail/support-mail/messages/:messageId",
    ]);
    try {
      await aug.onBoot!();
      expect(aug.httpRoutes?.map((route) => route.path)).toContain(
        "/webhooks/agentmail/support-mail",
      );
    } finally {
      await aug.onShutdown!();
      ledger.close();
    }

    const compatibleSingle = agentMail({
      ...baseOpts,
      instanceId: "configured-support",
      legacySingletonCompatibility: true,
      _client: fakeClient().client,
    });
    expect(compatibleSingle.httpRoutes?.map((route) => route.path)).toEqual([
      "/agentmail/reviews/:reviewId",
      "/agentmail/messages/:messageId",
    ]);
  });

  test("projects metadata-only public inbound quota diagnostics", async () => {
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:", now: () => 1_000 });
    const firstEnvelope = receivedEnvelope("message_quota_admitted");
    firstEnvelope.message.from = "customer@example.com";
    ledger.enqueue(firstEnvelope);
    const first = ledger.claimNext({ workerId: "quota-test", leaseMs: 10_000 })!;
    expect(
      ledger.reserveInboundQuota(first, {
        canonicalSender: "customer@example.com",
        globalMaxPerHour: 1,
        perSenderMaxPerHour: 1,
      }).status,
    ).toBe("admitted");
    expect(ledger.complete(first)).toBeTrue();

    const secondEnvelope = receivedEnvelope("message_quota_rejected");
    secondEnvelope.message.from = "other@example.com";
    ledger.enqueue(secondEnvelope);
    const second = ledger.claimNext({ workerId: "quota-test", leaseMs: 10_000 })!;
    expect(
      ledger.reserveInboundQuota(second, {
        canonicalSender: "other@example.com",
        globalMaxPerHour: 1,
        perSenderMaxPerHour: 1,
      }),
    ).toEqual({ status: "discarded", reason: "policy-rate-limit-global" });

    const aug = agentMail({
      ...baseOpts,
      _client: fakeClient().client,
      _reviewQueue: createAgentMailReviewQueue(),
      _inboundLedger: ledger,
      _sdkAdapters: emptySdkAdapters(),
      inbound: {
        mode: "polling",
        allowAnySender: true,
        rateLimit: { globalMaxPerHour: 1, perSenderMaxPerHour: 1 },
      },
    });
    try {
      const info = await aug.adminInfo!();
      const keyValue = info.sections.find((section) => section.kind === "keyValue");
      expect(keyValue).toMatchObject({
        kind: "keyValue",
        rows: expect.arrayContaining([
          expect.objectContaining({
            label: "Inbound sender policy",
            value: "any well-formed sender",
          }),
          expect.objectContaining({ label: "Inbound rolling-hour usage", value: "1" }),
          expect.objectContaining({ label: "Inbound global quota rejections", value: "1" }),
        ]),
      });
      expect(info.projection).toMatchObject({
        kind: "mail",
        inbound: {
          senderPolicy: "any",
          allowedSenderCount: 0,
          rateLimit: {
            globalMaxPerHour: 1,
            perSenderMaxPerHour: 1,
            rollingGlobalUsage: 1,
            globalRejections: 1,
            perSenderRejections: 0,
            lastRejectedAt: "1970-01-01T00:00:01.000Z",
          },
        },
      });
      const serialized = JSON.stringify(info);
      expect(serialized).not.toContain("customer@example.com");
      expect(serialized).not.toContain("other@example.com");
      expect(ledger.creatorAttention.counts(baseOpts.inboxId).open).toBe(0);
    } finally {
      await aug.onShutdown!();
      ledger.close();
    }
  });

  test("projects only mail metadata and serves inbound bodies on demand", async () => {
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:" });
    ledger.enqueue(receivedEnvelope("message_metadata_projection"));
    ledger.creatorAttention.reserve({
      inboxId: baseOpts.inboxId,
      messageId: "message_metadata_projection",
      allowReopen: false,
    });
    const aug = agentMail({
      ...baseOpts,
      instanceId: "support",
      _client: fakeClient().client,
      _inboundLedger: ledger,
    });
    const info = await aug.adminInfo!();
    expect(info.projection).toMatchObject({
      kind: "mail",
      schemaVersion: 1,
      augmentName: "support",
      inboxId: baseOpts.inboxId,
      attention: [
        {
          rowKey: "message_metadata_projection",
          messageId: "message_metadata_projection",
          status: "open",
          version: 1,
          sender: "customer@example.com",
          subject: "Need help",
          detailPath: "/agentmail/support/messages/message_metadata_projection",
        },
      ],
    });
    expect(JSON.stringify(info)).not.toContain("Can you help?");

    const route = aug.httpRoutes!.find(
      (candidate) => candidate.path === "/agentmail/support/messages/:messageId",
    )!;
    const response = await route.handler(
      new Request("https://example.test/agentmail/support/messages/message_metadata_projection"),
      {
        signal: AbortSignal.timeout(1_000),
        params: { messageId: "message_metadata_projection" },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toMatchObject({
      instanceId: "support",
      inboxId: baseOpts.inboxId,
      messageId: "message_metadata_projection",
      from: "customer@example.com",
      subject: "Need help",
      text: "Can you help?",
    });
    expect(
      await aug.adminActions!["agentmail-attention-dismiss"]!({
        rowKey: "message_metadata_projection",
        expectedVersion: "1",
      }),
    ).toMatchObject({ ok: true });
    const staleDetail = await route.handler(
      new Request("https://example.test/agentmail/support/messages/message_metadata_projection"),
      {
        signal: AbortSignal.timeout(1_000),
        params: { messageId: "message_metadata_projection" },
      },
    );
    expect(staleDetail.status).toBe(410);
    expect(staleDetail.headers.get("cache-control")).toBe("no-store");
    expect(staleDetail.headers.get("x-content-type-options")).toBe("nosniff");
    ledger.close();
  });

  test("projects creator reconciliation actions with the registered optimistic inputs", async () => {
    const ledger = createAgentMailInboundLedger({
      dbPath: ":memory:",
      now: () => 1_000,
      incidentId: () => "incident_projection",
    });
    ledger.enqueue(receivedEnvelope("message_incident_projection"));
    expect(
      ledger.claimNext({
        workerId: "interrupted-worker",
        leaseMs: 5_000,
        inboxId: baseOpts.inboxId,
      }),
    ).not.toBeNull();
    expect(ledger.fenceInterruptedClaims({ inboxId: baseOpts.inboxId })).toHaveLength(1);

    const queue = createAgentMailReviewQueue();
    const aug = agentMail({
      ...baseOpts,
      instanceId: "support",
      _client: fakeClient({
        async send() {
          throw new Error("provider outcome unknown");
        },
      }).client,
      _reviewQueue: queue,
      _inboundLedger: ledger,
      outbound: {
        allowedTrustLevels: ["agent"],
        rateLimit: { globalMaxPerHour: 100, perRecipientCooldownMs: 0, dedupWindowMs: 0 },
      },
    });
    await executeParsed(
      tool(aug, "send_message"),
      {
        to: ["customer@example.com"],
        subject: "Ambiguous",
        text: "Exact sensitive queued body",
      },
      ctx(peer("agent")),
    );
    const sending = queue.list().find((review) => review.state === "sending")!;
    const info = await aug.adminInfo!();
    expect(info.projection?.reviews).toContainEqual(
      expect.objectContaining({
        rowKey: sending.id,
        reviewId: sending.id,
        status: "sending",
        actions: {
          reconcileSent: { actionId: "agentmail-review-reconcile-sent" },
          reconcileFailed: { actionId: "agentmail-review-reconcile-failed" },
        },
      }),
    );
    expect(
      info.projection?.attention.filter((item) => item.messageId === "message_incident_projection"),
    ).toEqual([
      expect.objectContaining({
        rowKey: "incident_projection",
        messageId: "message_incident_projection",
        status: "ambiguous",
        version: 1,
        actions: {
          reconcileProcessed: { actionId: "agentmail-inbound-reconcile-handled" },
          reconcilePending: { actionId: "agentmail-inbound-reconcile-no-effect" },
        },
      }),
    ]);
    expect(JSON.stringify(info)).not.toContain(sending.fingerprint);
    expect(JSON.stringify(info)).not.toContain("Exact sensitive queued body");
    const incidentDetailRoute = aug.httpRoutes!.find(
      (candidate) => candidate.path === "/agentmail/support/messages/:messageId",
    )!;
    const incidentDetail = await incidentDetailRoute.handler(
      new Request("https://example.test/agentmail/support/messages/message_incident_projection"),
      {
        signal: AbortSignal.timeout(1_000),
        params: { messageId: "message_incident_projection" },
      },
    );
    expect(incidentDetail.status).toBe(200);

    const rowActions = info.sections.flatMap((section) =>
      section.kind === "table" ? (section.rowActions ?? []) : [],
    );
    const inputContract = (actionId: string) =>
      rowActions
        .find((action) => action.id === actionId)
        ?.inputs?.map(({ name, type, required }) => ({ name, type, required }));
    expect(inputContract("agentmail-review-reconcile-sent")).toEqual([
      { name: "fingerprint", type: "text", required: true },
      { name: "messageId", type: "text", required: true },
      { name: "threadId", type: "text", required: false },
      { name: "evidence", type: "text", required: true },
    ]);
    expect(inputContract("agentmail-review-reconcile-failed")).toEqual([
      { name: "fingerprint", type: "text", required: true },
      { name: "reason", type: "text", required: true },
    ]);
    expect(inputContract("agentmail-inbound-reconcile-handled")).toEqual([
      { name: "version", type: "number", required: true },
      { name: "evidence", type: "text", required: true },
    ]);
    expect(inputContract("agentmail-inbound-reconcile-no-effect")).toEqual([
      { name: "version", type: "number", required: true },
      { name: "evidence", type: "text", required: true },
    ]);

    expect(
      await aug.adminActions!["agentmail-review-reconcile-failed"]!({
        rowKey: sending.id,
        fingerprint: sending.fingerprint,
        reason: "provider search found no matching message",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await aug.adminActions!["agentmail-inbound-reconcile-handled"]!({
        rowKey: "incident_projection",
        version: "1",
        evidence: "verified the interrupted turn completed",
      }),
    ).toMatchObject({ ok: true });
    ledger.close();
  });

  test("serves a bounded exact review DTO without internal queue bindings", async () => {
    const queue = createAgentMailReviewQueue();
    const aug = agentMail({
      ...baseOpts,
      instanceId: "support",
      emailAddress: "agent@example.com",
      _client: fakeClient().client,
      _reviewQueue: queue,
      outbound: {
        allowedTrustLevels: ["public"],
        allowedRecipients: ["customer@example.com", "teammate@example.com"],
        allowHtml: true,
      },
    }) as ReturnType<typeof agentMail> & {
      _markSeenForTest: (id: string, meta: { from: string; replyAllTo?: string[] }) => void;
    };
    aug._markSeenForTest("message_exact_review", {
      from: "customer@example.com",
      replyAllTo: ["teammate@example.com"],
    });
    const proposal = await executeParsed(
      tool(aug, "reply_to_message"),
      {
        messageId: "message_exact_review",
        text: "Queued reply",
        html: "<p>Queued reply</p>",
        replyAll: true,
        labels: ["customer-support"],
      },
      ctx(peer("public")),
    );
    expect(proposal.status).toBe("pending_review");
    expect(typeof proposal.reviewId).toBe("string");
    const reviewId = String(proposal.reviewId);
    expect(queue.get(reviewId)?.state).toBe("pending");
    const route = aug.httpRoutes!.find(
      (candidate) => candidate.path === "/agentmail/support/reviews/:reviewId",
    )!;
    const response = await route.handler(
      new Request(`https://example.test/agentmail/support/reviews/${reviewId}`),
      { signal: AbortSignal.timeout(1_000), params: { reviewId } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: "review",
      reviewId,
      recipients: ["customer@example.com", "teammate@example.com"],
      subject: "(reply)",
      request: {
        kind: "reply",
        messageId: "message_exact_review",
        text: "Queued reply",
        html: "<p>Queued reply</p>",
        replyAll: true,
        labels: ["customer-support"],
      },
    });
    const detail = await route.handler(
      new Request(`https://example.test/agentmail/support/reviews/${reviewId}`),
      { signal: AbortSignal.timeout(1_000), params: { reviewId } },
    );
    const exact = (await detail.json()) as { request: Record<string, unknown> };
    expect(exact.request).not.toHaveProperty("to");
    expect(exact.request).not.toHaveProperty("subject");
    expect(exact.request).not.toHaveProperty("attentionVersion");
  });

  test("revises and sends a pending review with row-bound fingerprint CAS", async () => {
    const { client, log } = fakeClient();
    const aug = agentMail({
      ...baseOpts,
      instanceId: "support",
      _client: client,
      outbound: { allowedTrustLevels: ["public"] },
    });
    const proposal = await executeParsed(
      tool(aug, "send_message"),
      { to: ["customer@example.com"], subject: "Draft", text: "Original body" },
      ctx(peer("public")),
    );
    const reviewId = String(proposal.reviewId);
    const detailRoute = aug.httpRoutes!.find(
      (candidate) => candidate.path === "/agentmail/support/reviews/:reviewId",
    )!;
    const detail = await detailRoute.handler(
      new Request(`https://example.test/agentmail/support/reviews/${reviewId}`),
      { signal: AbortSignal.timeout(1_000), params: { reviewId } },
    );
    const inspected = (await detail.json()) as { fingerprint: string };

    expect(
      await aug.adminActions!["agentmail-review-revise"]!({
        rowKey: reviewId,
        reviewId: "different-review",
        fingerprint: inspected.fingerprint,
        text: "Revised body",
      }),
    ).toMatchObject({ ok: false, message: expect.stringContaining("authorized row") });
    expect(log.send).toHaveLength(0);

    expect(
      await aug.adminActions!["agentmail-review-revise"]!({
        rowKey: reviewId,
        fingerprint: inspected.fingerprint,
        text: "Revised body",
      }),
    ).toEqual({ ok: true, message: `Review ${reviewId} approved and sent` });
    expect(log.send).toHaveLength(1);
    expect(log.send[0]).toMatchObject({
      inboxId: baseOpts.inboxId,
      to: ["customer@example.com"],
      text: "Revised body",
    });
    expect(log.send[0]).not.toHaveProperty("html");
    expect(
      await aug.adminActions!["agentmail-review-revise"]!({
        rowKey: reviewId,
        fingerprint: inspected.fingerprint,
        text: "Stale replay",
      }),
    ).toMatchObject({ ok: false, message: expect.stringContaining("not pending") });
    expect(log.send).toHaveLength(1);
  });

  test("isolates named cap overrides and migrates a single legacy override to v2", async () => {
    const overrideDir = makeTmpDir();
    const legacy = {
      version: 1,
      lastModified: new Date().toISOString(),
      lastModifiedBy: "creator",
      overrides: { agentMail: { globalMaxPerHour: 23 } },
    };
    writeFileSync(join(overrideDir, "admin-overrides.json"), JSON.stringify(legacy));

    const support = agentMail({
      ...baseOpts,
      instanceId: "support",
      legacySingletonCompatibility: true,
      overrideDir,
      _client: fakeClient().client,
      outbound: { rateLimit: { globalMaxPerHour: 10 } },
    });
    const supportInfo = await support.adminInfo!();
    const supportRows = supportInfo.sections.find((section) => section.kind === "keyValue");
    expect(
      supportRows?.kind === "keyValue"
        ? supportRows.rows.find((row) => row.label === "Global cap (per hour)")?.value
        : undefined,
    ).toBe("23");
    expect(await support.adminActions!["agentmail-cap-adjust"]!({ value: "31" })).toMatchObject({
      ok: true,
    });
    const migrated = JSON.parse(readFileSync(join(overrideDir, "admin-overrides.json"), "utf8"));
    expect(migrated).toMatchObject({
      version: 2,
      overrides: { agentMail: { instances: { support: { globalMaxPerHour: 31 } } } },
    });
    expect(migrated.overrides.agentMail).not.toHaveProperty("globalMaxPerHour");

    const billing = agentMail({
      ...baseOpts,
      inboxId: "inb_billing",
      instanceId: "billing",
      legacySingletonCompatibility: false,
      overrideDir,
      _client: fakeClient().client,
      outbound: { rateLimit: { globalMaxPerHour: 7 } },
    });
    let billingInfo = await billing.adminInfo!();
    let billingRows = billingInfo.sections.find((section) => section.kind === "keyValue");
    expect(
      billingRows?.kind === "keyValue"
        ? billingRows.rows.find((row) => row.label === "Global cap (per hour)")?.value
        : undefined,
    ).toBe("7");
    await billing.adminActions!["agentmail-cap-adjust"]!({ value: "11" });
    const restartedSupport = agentMail({
      ...baseOpts,
      instanceId: "support",
      legacySingletonCompatibility: false,
      overrideDir,
      _client: fakeClient().client,
      outbound: { rateLimit: { globalMaxPerHour: 10 } },
    });
    const restartedRows = (await restartedSupport.adminInfo!()).sections.find(
      (section) => section.kind === "keyValue",
    );
    expect(
      restartedRows?.kind === "keyValue"
        ? restartedRows.rows.find((row) => row.label === "Global cap (per hour)")?.value
        : undefined,
    ).toBe("31");
    billingInfo = await billing.adminInfo!();
    billingRows = billingInfo.sections.find((section) => section.kind === "keyValue");
    expect(
      billingRows?.kind === "keyValue"
        ? billingRows.rows.find((row) => row.label === "Global cap (per hour)")?.value
        : undefined,
    ).toBe("11");
    await Promise.all([
      support.onShutdown!(),
      billing.onShutdown!(),
      restartedSupport.onShutdown!(),
    ]);
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
    quarantineThread: () => true,
    recoverThread: () => false,
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

function receivedEnvelope(messageId: string) {
  const event = receivedWebhookEvent();
  event.event_id = `event_${messageId}`;
  const message = event.message as Record<string, unknown>;
  message.message_id = messageId;
  message.thread_id = `thread_${messageId}`;
  const thread = event.thread as Record<string, unknown>;
  thread.thread_id = `thread_${messageId}`;
  return normalizeAgentMailReceivedEvent(event, "webhook", baseOpts.inboxId);
}

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition was not met");
}

async function eventuallyWithin(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}
