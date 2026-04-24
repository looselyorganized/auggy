import { describe, it, expect } from "bun:test";
import { orgContext } from "../../src/augments/org-context";
import type { TurnState, PeerIdentity } from "../../src/types";

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

function makeTurnState(peer: PeerIdentity): TurnState {
  return {
    turnId: "turn-1",
    threadId: "thread-1",
    trigger: { type: "message", turnId: "turn-1", timestamp: Date.now(), payload: { parts: [], sourceAugment: "web", peer, timestamp: Date.now() } },
    peer,
    toolCallsSoFar: 0,
    turnStartedAt: Date.now(),
    metadata: {},
  };
}

describe("org_escalate rate limiting", () => {
  describe("per-peer cooldown", () => {
    it("allows the first escalation from a peer", async () => {
      const aug = orgContext({
        baseUrl: "http://localhost:9999",
        client: mockClient(MANIFEST_RESPONSE) as any,
        escalation: { cooldownMs: 60_000, dedupThreshold: 0 },
      });

      const peer = makePeer("visitor-1");
      await aug.onTurnStart?.(makeTurnState(peer));

      const tool = aug.tools!.find((t) => t.name === "org_escalate")!;
      const result = JSON.parse(await tool.execute({ summary: "needs help" }));
      expect(result.status).toBe("sent");
    });

    it("blocks a second escalation from the same peer within cooldown", async () => {
      const aug = orgContext({
        baseUrl: "http://localhost:9999",
        client: mockClient(MANIFEST_RESPONSE) as any,
        escalation: { cooldownMs: 60_000, dedupThreshold: 0 },
      });

      const peer = makePeer("visitor-1");
      await aug.onTurnStart?.(makeTurnState(peer));

      const tool = aug.tools!.find((t) => t.name === "org_escalate")!;
      await tool.execute({ summary: "first escalation" });
      const result = JSON.parse(await tool.execute({ summary: "second escalation" }));
      expect(result.status).toBe("rate_limited");
      expect(result.hint).toBeDefined();
    });

    it("allows escalation from a different peer during cooldown", async () => {
      const aug = orgContext({
        baseUrl: "http://localhost:9999",
        client: mockClient(MANIFEST_RESPONSE) as any,
        escalation: { cooldownMs: 60_000, dedupThreshold: 0 },
      });

      const peer1 = makePeer("visitor-1");
      await aug.onTurnStart?.(makeTurnState(peer1));
      const tool = aug.tools!.find((t) => t.name === "org_escalate")!;
      await tool.execute({ summary: "from visitor 1" });

      const peer2 = makePeer("visitor-2");
      await aug.onTurnStart?.(makeTurnState(peer2));
      const result = JSON.parse(await tool.execute({ summary: "from visitor 2" }));
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

      const peer = makePeer("visitor-1");
      await aug.onTurnStart?.(makeTurnState(peer));

      const tool = aug.tools!.find((t) => t.name === "org_escalate")!;
      await tool.execute({ summary: "visitor wants to discuss partnership opportunity" });

      const peer2 = makePeer("visitor-2");
      await aug.onTurnStart?.(makeTurnState(peer2));
      const result = JSON.parse(await tool.execute({ summary: "visitor wants to discuss partnership opportunity with the facility" }));
      expect(result.status).toBe("rate_limited");
      expect(result.message).toContain("similar");
    });

    it("allows escalation with a different summary", async () => {
      const aug = orgContext({
        baseUrl: "http://localhost:9999",
        client: mockClient(MANIFEST_RESPONSE) as any,
        escalation: { cooldownMs: 0, dedupWindowMs: 60_000, dedupThreshold: 0.6 },
      });

      const peer = makePeer("visitor-1");
      await aug.onTurnStart?.(makeTurnState(peer));

      const tool = aug.tools!.find((t) => t.name === "org_escalate")!;
      await tool.execute({ summary: "visitor wants to discuss partnership" });

      const peer2 = makePeer("visitor-2");
      await aug.onTurnStart?.(makeTurnState(peer2));
      const result = JSON.parse(await tool.execute({ summary: "security incident detected in the logs" }));
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

      const peer1 = makePeer("v1");
      await aug.onTurnStart?.(makeTurnState(peer1));
      await tool.execute({ summary: "escalation 1" });

      const peer2 = makePeer("v2");
      await aug.onTurnStart?.(makeTurnState(peer2));
      await tool.execute({ summary: "escalation 2" });

      const peer3 = makePeer("v3");
      await aug.onTurnStart?.(makeTurnState(peer3));
      const result = JSON.parse(await tool.execute({ summary: "escalation 3" }));
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

      const peer = makePeer("v1");
      await aug.onTurnStart?.(makeTurnState(peer));
      await tool.execute({ summary: "first" });

      const operator = makePeer("operator-1", "operator");
      await aug.onTurnStart?.(makeTurnState(operator));
      const result = JSON.parse(await tool.execute({ summary: "first" }));
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

      const peer = makePeer("visitor-1");
      await aug.onTurnStart?.(makeTurnState(peer));

      const tool = aug.tools!.find((t) => t.name === "org_escalate")!;
      await tool.execute({ summary: "first" });

      const blocked = JSON.parse(await tool.execute({ summary: "second" }));
      expect(blocked.status).toBe("rate_limited");

      await new Promise((r) => setTimeout(r, 60));

      const allowed = JSON.parse(await tool.execute({ summary: "third" }));
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
      await tool.execute({ summary: "first" });
      const result = JSON.parse(await tool.execute({ summary: "second" }));
      expect(result.status).toBe("sent");
    });
  });

  describe("configuration", () => {
    it("disabling rate limiting allows unlimited escalations", async () => {
      const aug = orgContext({
        baseUrl: "http://localhost:9999",
        client: mockClient(MANIFEST_RESPONSE) as any,
        escalation: { enabled: false },
      });

      const peer = makePeer("visitor-1");
      await aug.onTurnStart?.(makeTurnState(peer));

      const tool = aug.tools!.find((t) => t.name === "org_escalate")!;
      await tool.execute({ summary: "first" });
      const result = JSON.parse(await tool.execute({ summary: "first" }));
      expect(result.status).toBe("sent");
    });
  });
});
