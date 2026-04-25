import { describe, it, expect } from "bun:test";
import { orgContext } from "../../src/augments/org-context";
import type { PeerIdentity, ToolExecuteContext } from "../../src/types";

function mockClient(responses: Record<string, { status: number; body: string }>) {
  return {
    get: async (url: string) => {
      const path = new URL(url).pathname;
      return responses[path] ?? { status: 404, body: "not found" };
    },
    post: async (_url: string, _opts?: unknown) => {
      return { status: 200, body: JSON.stringify({ status: "sent" }) };
    },
  };
}

const MANIFEST_RESPONSE = {
  "/manifest": {
    status: 200,
    body: JSON.stringify({
      org: "TestOrg",
      purpose: "Testing",
      endpoints: [],
    }),
  },
};

function makePeer(id: string, trustLevel: PeerIdentity["trustLevel"] = "untrusted"): PeerIdentity {
  return { id, kind: "human", trustLevel, sourceAugment: "web" };
}

function makeContext(peer: PeerIdentity | null = null): ToolExecuteContext {
  return { turnId: `turn-${crypto.randomUUID()}`, peer, threadId: "thread-1" };
}

describe("org_escalate rate limiting", () => {
  describe("per-peer cooldown", () => {
    it("allows the first escalation from a peer", async () => {
      const aug = orgContext({
        baseUrl: "http://localhost:9999",
        client: mockClient(MANIFEST_RESPONSE) as any,
        escalation: { cooldownMs: 60_000, dedupThreshold: 0 },
      });
      const tool = aug.tools!.find((t) => t.name === "org_escalate")!;
      const ctx = makeContext(makePeer("visitor-1"));
      const result = JSON.parse(await tool.execute({ summary: "needs help" }, ctx));
      expect(result.status).toBe("sent");
    });

    it("blocks a second escalation from the same peer within cooldown", async () => {
      const aug = orgContext({
        baseUrl: "http://localhost:9999",
        client: mockClient(MANIFEST_RESPONSE) as any,
        escalation: { cooldownMs: 60_000, dedupThreshold: 0 },
      });
      const tool = aug.tools!.find((t) => t.name === "org_escalate")!;
      const ctx = makeContext(makePeer("visitor-1"));
      await tool.execute({ summary: "first escalation" }, ctx);
      const result = JSON.parse(await tool.execute({ summary: "second escalation" }, ctx));
      expect(result.status).toBe("rate_limited");
      expect(result.hint).toBeDefined();
    });

    it("allows escalation from a different peer during cooldown", async () => {
      const aug = orgContext({
        baseUrl: "http://localhost:9999",
        client: mockClient(MANIFEST_RESPONSE) as any,
        escalation: { cooldownMs: 60_000, dedupThreshold: 0 },
      });
      const tool = aug.tools!.find((t) => t.name === "org_escalate")!;
      await tool.execute({ summary: "from visitor 1" }, makeContext(makePeer("visitor-1")));
      const result = JSON.parse(await tool.execute({ summary: "from visitor 2" }, makeContext(makePeer("visitor-2"))));
      expect(result.status).toBe("sent");
    });
  });

  describe("dedup window", () => {
    it("suppresses escalation with a similar summary", async () => {
      const aug = orgContext({
        baseUrl: "http://localhost:9999",
        client: mockClient(MANIFEST_RESPONSE) as any,
        escalation: { cooldownMs: 0, dedupWindowMs: 60_000, dedupThreshold: 0.6 },
      });
      const tool = aug.tools!.find((t) => t.name === "org_escalate")!;
      await tool.execute({ summary: "visitor wants to discuss partnership opportunity" }, makeContext(makePeer("v1")));
      const result = JSON.parse(await tool.execute(
        { summary: "visitor wants to discuss partnership opportunity with the facility" },
        makeContext(makePeer("v2")),
      ));
      expect(result.status).toBe("rate_limited");
      expect(result.message).toContain("similar");
    });

    it("allows escalation with a different summary", async () => {
      const aug = orgContext({
        baseUrl: "http://localhost:9999",
        client: mockClient(MANIFEST_RESPONSE) as any,
        escalation: { cooldownMs: 0, dedupWindowMs: 60_000, dedupThreshold: 0.6 },
      });
      const tool = aug.tools!.find((t) => t.name === "org_escalate")!;
      await tool.execute({ summary: "visitor wants to discuss partnership" }, makeContext(makePeer("v1")));
      const result = JSON.parse(await tool.execute(
        { summary: "security incident detected in the logs" },
        makeContext(makePeer("v2")),
      ));
      expect(result.status).toBe("sent");
    });
  });

  describe("global circuit breaker", () => {
    it("blocks after globalMaxPerHour is reached", async () => {
      const aug = orgContext({
        baseUrl: "http://localhost:9999",
        client: mockClient(MANIFEST_RESPONSE) as any,
        escalation: { cooldownMs: 0, globalMaxPerHour: 2, dedupThreshold: 0 },
      });
      const tool = aug.tools!.find((t) => t.name === "org_escalate")!;
      await tool.execute({ summary: "escalation 1" }, makeContext(makePeer("v1")));
      await tool.execute({ summary: "escalation 2" }, makeContext(makePeer("v2")));
      const result = JSON.parse(await tool.execute({ summary: "escalation 3" }, makeContext(makePeer("v3"))));
      expect(result.status).toBe("rate_limited");
      expect(result.message).toContain("global limit");
    });
  });

  describe("trust-aware bypass", () => {
    it("operator bypasses all rate limits", async () => {
      const aug = orgContext({
        baseUrl: "http://localhost:9999",
        client: mockClient(MANIFEST_RESPONSE) as any,
        escalation: { cooldownMs: 60_000, globalMaxPerHour: 1, dedupThreshold: 0.9 },
      });
      const tool = aug.tools!.find((t) => t.name === "org_escalate")!;
      await tool.execute({ summary: "first" }, makeContext(makePeer("v1")));
      const result = JSON.parse(await tool.execute({ summary: "first" }, makeContext(makePeer("op", "operator"))));
      expect(result.status).toBe("sent");
    });
  });

  describe("cooldown expiry", () => {
    it("allows escalation after cooldown expires", async () => {
      const aug = orgContext({
        baseUrl: "http://localhost:9999",
        client: mockClient(MANIFEST_RESPONSE) as any,
        escalation: { cooldownMs: 50, dedupThreshold: 0 },
      });
      const tool = aug.tools!.find((t) => t.name === "org_escalate")!;
      const ctx = makeContext(makePeer("visitor-1"));
      await tool.execute({ summary: "first" }, ctx);
      const blocked = JSON.parse(await tool.execute({ summary: "second" }, ctx));
      expect(blocked.status).toBe("rate_limited");
      await new Promise((r) => setTimeout(r, 60));
      const allowed = JSON.parse(await tool.execute({ summary: "third" }, ctx));
      expect(allowed.status).toBe("sent");
    });
  });

  describe("null peer bypass", () => {
    it("null peer (internal trigger) bypasses rate limiting", async () => {
      const aug = orgContext({
        baseUrl: "http://localhost:9999",
        client: mockClient(MANIFEST_RESPONSE) as any,
        escalation: { cooldownMs: 60_000, globalMaxPerHour: 1 },
      });
      const tool = aug.tools!.find((t) => t.name === "org_escalate")!;
      const ctx = makeContext(null);
      await tool.execute({ summary: "first" }, ctx);
      const result = JSON.parse(await tool.execute({ summary: "second" }, ctx));
      expect(result.status).toBe("sent");
    });
  });

  describe("context requirement", () => {
    it("denies escalation when context is not provided", async () => {
      const aug = orgContext({
        baseUrl: "http://localhost:9999",
        client: mockClient(MANIFEST_RESPONSE) as any,
      });
      const tool = aug.tools!.find((t) => t.name === "org_escalate")!;
      const result = JSON.parse(await tool.execute({ summary: "no context" }));
      expect(result.error).toContain("context");
    });
  });

  describe("configuration", () => {
    it("disabling rate limiting allows unlimited escalations", async () => {
      const aug = orgContext({
        baseUrl: "http://localhost:9999",
        client: mockClient(MANIFEST_RESPONSE) as any,
        escalation: { enabled: false },
      });
      const tool = aug.tools!.find((t) => t.name === "org_escalate")!;
      const ctx = makeContext(makePeer("visitor-1"));
      await tool.execute({ summary: "first" }, ctx);
      const result = JSON.parse(await tool.execute({ summary: "first" }, ctx));
      expect(result.status).toBe("sent");
    });
  });
});
