import { describe, it, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  notify as createNotify,
  type NotifyAugmentInternalOptions,
} from "../../src/augments/notify";
import type {
  NotifyAdapter,
  NotifyAugmentOptions,
  NotifyDestination,
  NotifyPayload,
  PeerIdentity,
  ToolExecuteContext,
} from "../../src/types";
import { asStringTool } from "../fixtures/tool-helpers";

function makePeer(id: string, trustLevel: PeerIdentity["trustLevel"] = "public"): PeerIdentity {
  return {
    id,
    kind: "human",
    trustLevel,
    sourceAugment: "web",
    ...(trustLevel === "public" ? { publicSubstate: "anonymous" as const } : {}),
  };
}

function makeContext(peer: PeerIdentity | null = null): ToolExecuteContext {
  return { turnId: `turn-${crypto.randomUUID()}`, peer, threadId: "thread-1" };
}

function mockAdapter(
  deliveries: Array<{ destination: string; result: "sent" | "failed" }> = [],
): NotifyAdapter {
  return {
    deliver: async (destination: NotifyDestination, _payload: NotifyPayload) => {
      deliveries.push({ destination: destination.name, result: "sent" });
      return { status: "sent" as const };
    },
  };
}

const ALL_TRUST_LEVELS: PeerIdentity["trustLevel"][] = ["creator", "agent", "public"];

const baseOpts: NotifyAugmentOptions = {
  destinations: [
    {
      name: "creator",
      transport: "webhook",
      url: "https://example.com/notify",
      allowedTrustLevels: ALL_TRUST_LEVELS,
    },
    {
      name: "ops",
      transport: "webhook",
      url: "https://example.com/ops",
      allowedTrustLevels: ALL_TRUST_LEVELS,
    },
  ],
  rateLimit: { cooldownMs: 60_000, dedupThreshold: 0, globalMaxPerHour: 100 },
};

/** Unit tests opt into volatile state explicitly; runtime callers may not do so accidentally. */
function notify(opts: NotifyAugmentInternalOptions) {
  return createNotify({ dbPath: ":memory:", _allowVolatileStore: true, ...opts });
}

/** Return the notify tool with execute typed as string-returning for test convenience. */
function getNotifyTool(aug: ReturnType<typeof notify>) {
  const tool = aug.tools!.find((t) => t.name === "notify");
  if (!tool) throw new Error("notify tool not found");
  return asStringTool(tool);
}

describe("notify augment", () => {
  it("rejects direct construction without durable state", () => {
    expect(() =>
      createNotify({
        destinations: [],
      }),
    ).toThrow(/dbPath is required.*durable delivery state/i);
  });
  it("delivers to named destination", async () => {
    const deliveries: Array<{ destination: string; result: "sent" | "failed" }> = [];
    const aug = notify({
      ...baseOpts,
      adapters: { webhook: mockAdapter(deliveries), telegram: mockAdapter([]) },
    });
    const tool = getNotifyTool(aug);
    const ctx = makeContext(makePeer("v1"));
    const result = JSON.parse(await tool.execute({ to: "creator", summary: "test" }, ctx));
    expect(result.status).toBe("sent");
    expect(deliveries).toEqual([{ destination: "creator", result: "sent" }]);
  });

  it("returns error when destination name not configured", async () => {
    const aug = notify({
      ...baseOpts,
      adapters: { webhook: mockAdapter(), telegram: mockAdapter() },
    });
    const tool = getNotifyTool(aug);
    const ctx = makeContext(makePeer("v1"));
    const result = JSON.parse(await tool.execute({ to: "nope", summary: "x" }, ctx));
    expect(result.status).toBe("failed");
    expect(result.message).toContain("nope");
  });

  it("defaults destinations to creator and agent trust only", async () => {
    const deliveries: Array<{ destination: string; result: "sent" | "failed" }> = [];
    const aug = notify({
      destinations: [{ name: "creator", transport: "webhook", url: "https://example.com/notify" }],
      adapters: { webhook: mockAdapter(deliveries), telegram: mockAdapter() },
    });
    const tool = getNotifyTool(aug);

    const denied = JSON.parse(
      await tool.execute(
        { to: "creator", summary: "public should not send by default" },
        makeContext(makePeer("v1")),
      ),
    );
    const allowed = JSON.parse(
      await tool.execute(
        { to: "creator", summary: "agent can send by default" },
        makeContext(makePeer("agent-1", "agent")),
      ),
    );

    expect(denied.status).toBe("failed");
    expect(denied.message).toContain("not available to public peers");
    expect(allowed.status).toBe("sent");
    expect(deliveries).toEqual([{ destination: "creator", result: "sent" }]);
  });

  it("blocks peers whose trust level is not allowed for the destination", async () => {
    const deliveries: Array<{ destination: string; result: "sent" | "failed" }> = [];
    const aug = notify({
      destinations: [
        {
          name: "staff-only",
          transport: "webhook",
          url: "https://example.com/staff",
          allowedTrustLevels: ["creator", "agent"],
        },
      ],
      adapters: { webhook: mockAdapter(deliveries), telegram: mockAdapter() },
    });
    const tool = getNotifyTool(aug);

    const result = JSON.parse(
      await tool.execute(
        { to: "staff-only", summary: "public should not send" },
        makeContext(makePeer("v1")),
      ),
    );

    expect(result.status).toBe("failed");
    expect(result.message).toContain("not available to public peers");
    expect(deliveries).toEqual([]);
  });

  it("allows agent peers for destinations that include agent trust", async () => {
    const deliveries: Array<{ destination: string; result: "sent" | "failed" }> = [];
    const aug = notify({
      destinations: [
        {
          name: "staff-only",
          transport: "webhook",
          url: "https://example.com/staff",
          allowedTrustLevels: ["creator", "agent"],
        },
      ],
      adapters: { webhook: mockAdapter(deliveries), telegram: mockAdapter() },
    });
    const tool = getNotifyTool(aug);

    const result = JSON.parse(
      await tool.execute(
        { to: "staff-only", summary: "agent can send" },
        makeContext(makePeer("agent-1", "agent")),
      ),
    );

    expect(result.status).toBe("sent");
    expect(deliveries).toEqual([{ destination: "staff-only", result: "sent" }]);
  });

  it("requires a reason for public peers when destination is escalation-only", async () => {
    const deliveries: Array<{ destination: string; result: "sent" | "failed" }> = [];
    const aug = notify({
      destinations: [
        {
          name: "escalations",
          transport: "webhook",
          url: "https://example.com/escalations",
          allowedTrustLevels: ALL_TRUST_LEVELS,
          publicPolicy: "escalation-only",
        },
      ],
      rateLimit: { cooldownMs: 0, dedupThreshold: 0 },
      adapters: { webhook: mockAdapter(deliveries), telegram: mockAdapter() },
    });
    const tool = getNotifyTool(aug);
    const ctx = makeContext(makePeer("v1"));

    const denied = JSON.parse(await tool.execute({ to: "escalations", summary: "help" }, ctx));
    const allowed = JSON.parse(
      await tool.execute(
        { to: "escalations", summary: "help", reason: "Visitor needs operator approval." },
        ctx,
      ),
    );

    expect(denied.status).toBe("failed");
    expect(denied.message).toContain("escalation");
    expect(allowed.status).toBe("sent");
    expect(deliveries).toEqual([{ destination: "escalations", result: "sent" }]);
  });

  it("blocks second call from same peer within per-peer cooldown", async () => {
    const aug = notify({
      ...baseOpts,
      rateLimit: { cooldownMs: 60_000, dedupThreshold: 0, perPeerCooldownMs: 30_000 },
      adapters: { webhook: mockAdapter(), telegram: mockAdapter() },
    });
    const tool = getNotifyTool(aug);
    const ctx = makeContext(makePeer("v1"));
    await tool.execute({ to: "creator", summary: "first" }, ctx);
    const result = JSON.parse(await tool.execute({ to: "creator", summary: "second" }, ctx));
    expect(result.status).toBe("rate_limited");
    expect(result.message).toContain("cooldown");
  });

  it("allows different peer during cooldown", async () => {
    const aug = notify({
      ...baseOpts,
      rateLimit: { cooldownMs: 60_000, dedupThreshold: 0, perPeerCooldownMs: 30_000 },
      adapters: { webhook: mockAdapter(), telegram: mockAdapter() },
    });
    const tool = getNotifyTool(aug);
    await tool.execute({ to: "creator", summary: "first" }, makeContext(makePeer("v1")));
    const result = JSON.parse(
      await tool.execute({ to: "creator", summary: "second" }, makeContext(makePeer("v2"))),
    );
    expect(result.status).toBe("sent");
  });

  it("blocks similar-summary call within dedup window", async () => {
    const aug = notify({
      ...baseOpts,
      rateLimit: { cooldownMs: 0, dedupWindowMs: 60_000, dedupThreshold: 0.6 },
      adapters: { webhook: mockAdapter(), telegram: mockAdapter() },
    });
    const tool = getNotifyTool(aug);
    await tool.execute(
      { to: "creator", summary: "visitor wants partnership opportunity" },
      makeContext(makePeer("v1")),
    );
    const result = JSON.parse(
      await tool.execute(
        { to: "creator", summary: "visitor wants partnership opportunity discussion" },
        makeContext(makePeer("v2")),
      ),
    );
    expect(result.status).toBe("rate_limited");
  });

  it("applies dedup when a destination has an explicit quota policy", async () => {
    const deliveries: Array<{ destination: string; result: "sent" | "failed" }> = [];
    const aug = notify({
      destinations: [
        {
          name: "verify-out",
          transport: "webhook",
          url: "https://example.com/verify",
          allowedTrustLevels: ALL_TRUST_LEVELS,
          rateLimit: { maxPerHour: 50, cooldownMs: 0 },
        },
      ],
      rateLimit: { cooldownMs: 0, dedupWindowMs: 60_000, dedupThreshold: 0.9 },
      adapters: { webhook: mockAdapter(deliveries) },
    });
    const tool = getNotifyTool(aug);

    const first = JSON.parse(
      await tool.execute(
        { to: "verify-out", summary: "same verification alert" },
        makeContext(makePeer("peer-one")),
      ),
    );
    const second = JSON.parse(
      await tool.execute(
        { to: "verify-out", summary: "same verification alert" },
        makeContext(makePeer("peer-two")),
      ),
    );

    expect(first.status).toBe("sent");
    expect(second.status).toBe("rate_limited");
    expect(deliveries).toHaveLength(1);
  });

  it("atomically reserves explicit-policy dedup before concurrent delivery", async () => {
    let releaseDelivery!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    let deliveryAttempts = 0;
    const adapter: NotifyAdapter = {
      async deliver() {
        deliveryAttempts++;
        await release;
        return { status: "sent" };
      },
    };
    const aug = notify({
      destinations: [
        {
          name: "verify-out",
          transport: "webhook",
          url: "https://example.com/verify",
          allowedTrustLevels: ALL_TRUST_LEVELS,
          rateLimit: { maxPerHour: 50, cooldownMs: 0 },
        },
      ],
      rateLimit: { cooldownMs: 0, dedupWindowMs: 60_000, dedupThreshold: 0.9 },
      adapters: { webhook: adapter },
    });
    const tool = getNotifyTool(aug);

    const first = tool.execute(
      { to: "verify-out", summary: "same concurrent alert" },
      makeContext(makePeer("peer-one")),
    );
    const second = tool.execute(
      { to: "verify-out", summary: "same concurrent alert" },
      makeContext(makePeer("peer-two")),
    );
    releaseDelivery();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(JSON.parse(firstResult).status).toBe("sent");
    expect(JSON.parse(secondResult).status).toBe("rate_limited");
    expect(deliveryAttempts).toBe(1);
  });

  it("blocks after global hourly cap reached", async () => {
    const aug = notify({
      ...baseOpts,
      rateLimit: { cooldownMs: 0, globalMaxPerHour: 2, dedupThreshold: 0 },
      adapters: { webhook: mockAdapter(), telegram: mockAdapter() },
    });
    const tool = getNotifyTool(aug);
    await tool.execute({ to: "creator", summary: "1" }, makeContext(makePeer("v1")));
    await tool.execute({ to: "creator", summary: "2" }, makeContext(makePeer("v2")));
    const result = JSON.parse(
      await tool.execute({ to: "creator", summary: "3" }, makeContext(makePeer("v3"))),
    );
    expect(result.status).toBe("rate_limited");
    expect(result.message).toContain("global");
  });

  it("creator-class peer bypasses all rate limits", async () => {
    const aug = notify({
      ...baseOpts,
      rateLimit: {
        cooldownMs: 60_000,
        globalMaxPerHour: 1,
        dedupThreshold: 0.9,
        perPeerCooldownMs: 30_000,
      },
      adapters: { webhook: mockAdapter(), telegram: mockAdapter() },
    });
    const tool = getNotifyTool(aug);
    await tool.execute({ to: "creator", summary: "first" }, makeContext(makePeer("v1")));
    const result = JSON.parse(
      await tool.execute(
        { to: "creator", summary: "first" },
        makeContext(makePeer("op", "creator")),
      ),
    );
    expect(result.status).toBe("sent");
  });

  it("returns error when ToolExecuteContext is missing", async () => {
    const aug = notify({
      ...baseOpts,
      adapters: { webhook: mockAdapter(), telegram: mockAdapter() },
    });
    const tool = getNotifyTool(aug);
    const result = JSON.parse(await tool.execute({ to: "creator", summary: "x" }));
    expect(result.status).toBe("failed");
    expect(result.message).toContain("context");
  });

  it("disabled rate limiting allows unlimited calls", async () => {
    const aug = notify({
      ...baseOpts,
      rateLimit: { enabled: false },
      adapters: { webhook: mockAdapter(), telegram: mockAdapter() },
    });
    const tool = getNotifyTool(aug);
    const ctx = makeContext(makePeer("v1"));
    await tool.execute({ to: "creator", summary: "1" }, ctx);
    const result = JSON.parse(await tool.execute({ to: "creator", summary: "1" }, ctx));
    expect(result.status).toBe("sent");
  });

  it("dispatches to agentmail adapter for agentmail destinations", async () => {
    const captured: Array<{ destination: NotifyDestination; payload: NotifyPayload }> = [];
    const agentmailMock: NotifyAdapter = {
      deliver: async (destination, payload) => {
        captured.push({ destination, payload });
        return { status: "sent" };
      },
    };
    const aug = notify({
      destinations: [
        {
          name: "creator-mail",
          transport: "agentmail",
          apiKey: "am_x",
          inboxId: "inb_x",
          to: "creator@example.com",
        },
      ],
      adapters: { agentmail: agentmailMock },
    });
    const tool = getNotifyTool(aug);
    const ctx = makeContext(makePeer("creator-1", "creator"));
    const result = JSON.parse(
      await tool.execute({ to: "creator-mail", summary: "Mail test", reason: "test reason" }, ctx),
    );
    expect(result.status).toBe("sent");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.destination.transport).toBe("agentmail");
    expect(captured[0]!.destination.name).toBe("creator-mail");
    expect(captured[0]!.payload.summary).toBe("Mail test");
    expect(captured[0]!.payload.reason).toBe("test reason");
  });

  test("per-destination cap allows verify-out 50/hr while creator stays at global default", async () => {
    const aug = notify({
      destinations: [
        {
          name: "creator",
          transport: "webhook",
          url: "https://example.com/c",
          allowedTrustLevels: ALL_TRUST_LEVELS,
        },
        {
          name: "verify-out",
          transport: "webhook",
          url: "https://example.com/v",
          allowedTrustLevels: ALL_TRUST_LEVELS,
          rateLimit: { maxPerHour: 50, cooldownMs: 0 },
        },
      ],
      rateLimit: { globalMaxPerHour: 5, dedupThreshold: 0, cooldownMs: 0 },
      adapters: { webhook: mockAdapter(), telegram: mockAdapter() },
    });
    const tool = getNotifyTool(aug);
    const ctx = makeContext(makePeer("v1"));
    // Fire 10 to verify-out — all should succeed (under 50)
    for (let i = 0; i < 10; i++) {
      const r = JSON.parse(await tool.execute({ to: "verify-out", summary: `msg ${i}` }, ctx));
      expect(r.status).toBe("sent");
    }
    // Fire 6 to creator — 6th should be rate-limited (over 5)
    for (let i = 0; i < 5; i++) {
      const r = JSON.parse(await tool.execute({ to: "creator", summary: `alert ${i}` }, ctx));
      expect(r.status).toBe("sent");
    }
    const sixth = JSON.parse(await tool.execute({ to: "creator", summary: "alert 6" }, ctx));
    expect(sixth.status).toBe("rate_limited");
  });

  test("per-destination cap surface in rate_limited message names the destination", async () => {
    const aug = notify({
      destinations: [
        {
          name: "verify-out",
          transport: "webhook",
          url: "https://x",
          allowedTrustLevels: ALL_TRUST_LEVELS,
          rateLimit: { maxPerHour: 1, cooldownMs: 0 },
        },
      ],
      rateLimit: { dedupThreshold: 0, cooldownMs: 0 },
      adapters: { webhook: mockAdapter(), telegram: mockAdapter() },
    });
    const tool = getNotifyTool(aug);
    const ctx = makeContext(makePeer("v1"));
    await tool.execute({ to: "verify-out", summary: "1" }, ctx);
    const r = JSON.parse(await tool.execute({ to: "verify-out", summary: "2" }, ctx));
    expect(r.status).toBe("rate_limited");
    expect(r.message).toContain("verify-out");
  });

  test("destination without explicit rateLimit falls back to global cap", async () => {
    const aug = notify({
      destinations: [
        {
          name: "creator",
          transport: "webhook",
          url: "https://x",
          allowedTrustLevels: ALL_TRUST_LEVELS,
        },
      ],
      rateLimit: { globalMaxPerHour: 2, dedupThreshold: 0, cooldownMs: 0 },
      adapters: { webhook: mockAdapter(), telegram: mockAdapter() },
    });
    const tool = getNotifyTool(aug);
    const ctx = makeContext(makePeer("v1"));
    await tool.execute({ to: "creator", summary: "1" }, ctx);
    await tool.execute({ to: "creator", summary: "2" }, ctx);
    const third = JSON.parse(await tool.execute({ to: "creator", summary: "3" }, ctx));
    expect(third.status).toBe("rate_limited");
  });

  test("atomically reserves global quota before concurrent delivery", async () => {
    let releaseDelivery!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    let deliveryAttempts = 0;
    const adapter: NotifyAdapter = {
      async deliver() {
        deliveryAttempts++;
        await release;
        return { status: "sent" };
      },
    };
    const aug = notify({
      destinations: [
        {
          name: "creator",
          transport: "webhook",
          url: "https://example.com/notify",
          allowedTrustLevels: ALL_TRUST_LEVELS,
        },
      ],
      rateLimit: { globalMaxPerHour: 1, cooldownMs: 0, dedupThreshold: 0 },
      adapters: { webhook: adapter },
    });
    const tool = getNotifyTool(aug);

    const first = tool.execute(
      { to: "creator", summary: "first" },
      makeContext(makePeer("peer-one")),
    );
    const second = tool.execute(
      { to: "creator", summary: "second" },
      makeContext(makePeer("peer-two")),
    );
    releaseDelivery();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(JSON.parse(firstResult).status).toBe("sent");
    expect(JSON.parse(secondResult).status).toBe("rate_limited");
    expect(deliveryAttempts).toBe(1);
  });

  test("a failed delivery attempt still consumes its reserved quota", async () => {
    let deliveryAttempts = 0;
    const adapter: NotifyAdapter = {
      async deliver() {
        deliveryAttempts++;
        return { status: "failed", detail: "delivery outcome unknown" };
      },
    };
    const aug = notify({
      destinations: [
        {
          name: "creator",
          transport: "webhook",
          url: "https://example.com/notify",
          allowedTrustLevels: ALL_TRUST_LEVELS,
        },
      ],
      rateLimit: { globalMaxPerHour: 1, cooldownMs: 0, dedupThreshold: 0 },
      adapters: { webhook: adapter },
    });
    const tool = getNotifyTool(aug);

    const first = JSON.parse(
      await tool.execute({ to: "creator", summary: "first" }, makeContext(makePeer("peer-one"))),
    );
    const second = JSON.parse(
      await tool.execute({ to: "creator", summary: "second" }, makeContext(makePeer("peer-two"))),
    );

    expect(first.status).toBe("failed");
    expect(second.status).toBe("rate_limited");
    expect(deliveryAttempts).toBe(1);
  });

  test("a thrown adapter attempt is terminal outcome unknown", async () => {
    const aug = notify({
      destinations: [
        {
          name: "creator",
          transport: "webhook",
          url: "https://example.com/notify",
          allowedTrustLevels: ALL_TRUST_LEVELS,
        },
      ],
      rateLimit: { cooldownMs: 0, dedupThreshold: 0 },
      adapters: {
        webhook: {
          async deliver() {
            throw new Error("connection reset after dispatch");
          },
        },
      },
    });
    const tool = aug.tools!.find((candidate) => candidate.name === "notify")!;

    const result = await tool.execute(
      { to: "creator", summary: "ambiguous" },
      makeContext(makePeer("peer-one")),
    );

    expect(result).toMatchObject({ isError: true, outcomeUnknown: true });
    if (typeof result === "string") throw new Error("expected structured result");
    expect(result.content).not.toContain("connection reset");
  });

  test("blocks ambiguous replay across restart until exact operator recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notify-durable-test-"));
    const dbPath = join(dir, "notify.sqlite");
    const destination: NotifyDestination = {
      name: "creator",
      transport: "webhook",
      url: "https://example.com/notify",
      allowedTrustLevels: ALL_TRUST_LEVELS,
    };
    const context = makeContext(makePeer("peer-one", "creator"));
    let firstAttempts = 0;
    let first = notify({
      destinations: [destination],
      dbPath,
      _attemptId: () => "attempt_restart",
      _incidentId: () => "incident_restart",
      adapters: {
        webhook: {
          async deliver() {
            firstAttempts++;
            throw new Error("sentinel provider detail");
          },
        },
      },
    });
    try {
      const firstTool = first.tools!.find((candidate) => candidate.name === "notify")!;
      const ambiguous = await firstTool.execute(
        { to: "creator", summary: "restart-sensitive" },
        context,
      );
      expect(ambiguous).toMatchObject({ isError: true, outcomeUnknown: true });
      expect(firstAttempts).toBe(1);
      await first.onShutdown!();

      let replayAttempts = 0;
      const restarted = notify({
        destinations: [destination],
        dbPath,
        adapters: {
          webhook: {
            async deliver() {
              replayAttempts++;
              return { status: "sent" };
            },
          },
        },
      });
      first = restarted;
      const restartedTool = restarted.tools!.find((candidate) => candidate.name === "notify")!;
      const blocked = await restartedTool.execute(
        { to: "creator", summary: "restart-sensitive" },
        context,
      );
      expect(blocked).toMatchObject({ isError: true, outcomeUnknown: true });
      expect(replayAttempts).toBe(0);

      expect(
        await restarted.adminActions!["notify-delivery-reconcile-no-effect"]!({
          incidentId: "incident_restart",
          version: "1",
          evidence: "provider confirms no request was accepted",
        }),
      ).toMatchObject({ ok: true, recoverThreadId: context.threadId });
      expect(
        JSON.parse(
          (await restartedTool.execute(
            { to: "creator", summary: "restart-sensitive" },
            context,
          )) as string,
        ).status,
      ).toBe("sent");
      expect(replayAttempts).toBe(1);
    } finally {
      await first.onShutdown?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
