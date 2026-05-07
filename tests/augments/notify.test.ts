import { describe, it, expect } from "bun:test";
import { notify } from "../../src/augments/notify";
import type {
  NotifyAdapter,
  NotifyAugmentOptions,
  NotifyDestination,
  NotifyPayload,
  PeerIdentity,
  ToolExecuteContext,
} from "../../src/types";

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

const baseOpts: NotifyAugmentOptions = {
  destinations: [
    { name: "creator", transport: "webhook", url: "https://example.com/notify" },
    { name: "ops", transport: "webhook", url: "https://example.com/ops" },
  ],
  rateLimit: { cooldownMs: 60_000, dedupThreshold: 0, globalMaxPerHour: 100 },
};

describe("notify augment", () => {
  it("delivers to named destination", async () => {
    const deliveries: Array<{ destination: string; result: any }> = [];
    const aug = notify({
      ...baseOpts,
      adapters: { webhook: mockAdapter(deliveries), telegram: mockAdapter([]) },
    });
    const tool = aug.tools!.find((t) => t.name === "notify")!;
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
    const tool = aug.tools!.find((t) => t.name === "notify")!;
    const ctx = makeContext(makePeer("v1"));
    const result = JSON.parse(await tool.execute({ to: "nope", summary: "x" }, ctx));
    expect(result.status).toBe("failed");
    expect(result.message).toContain("nope");
  });

  it("blocks second call from same peer within per-peer cooldown", async () => {
    const aug = notify({
      ...baseOpts,
      rateLimit: { cooldownMs: 60_000, dedupThreshold: 0, perPeerCooldownMs: 30_000 },
      adapters: { webhook: mockAdapter(), telegram: mockAdapter() },
    });
    const tool = aug.tools!.find((t) => t.name === "notify")!;
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
    const tool = aug.tools!.find((t) => t.name === "notify")!;
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
    const tool = aug.tools!.find((t) => t.name === "notify")!;
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

  it("blocks after global hourly cap reached", async () => {
    const aug = notify({
      ...baseOpts,
      rateLimit: { cooldownMs: 0, globalMaxPerHour: 2, dedupThreshold: 0 },
      adapters: { webhook: mockAdapter(), telegram: mockAdapter() },
    });
    const tool = aug.tools!.find((t) => t.name === "notify")!;
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
    const tool = aug.tools!.find((t) => t.name === "notify")!;
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
    const tool = aug.tools!.find((t) => t.name === "notify")!;
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
    const tool = aug.tools!.find((t) => t.name === "notify")!;
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
    const tool = aug.tools!.find((t) => t.name === "notify")!;
    const ctx = makeContext(makePeer("creator-1", "creator"));
    const result = JSON.parse(
      await tool.execute(
        { to: "creator-mail", summary: "Mail test", reason: "test reason" },
        ctx,
      ),
    );
    expect(result.status).toBe("sent");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.destination.transport).toBe("agentmail");
    expect(captured[0]!.destination.name).toBe("creator-mail");
    expect(captured[0]!.payload.summary).toBe("Mail test");
    expect(captured[0]!.payload.reason).toBe("test reason");
  });
});
