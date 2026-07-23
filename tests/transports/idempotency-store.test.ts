import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  createWebIdempotencyStore,
  hashIdempotencyBinding,
  hashIdempotencyKey,
} from "@/transports/idempotency-store";
import { createTempDir } from "@tests/fixtures/temp-dir";

describe("web idempotency store", () => {
  let tmp: { path: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await createTempDir();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it("admits one leader across store instances and replays its terminal body", () => {
    const dbPath = join(tmp.path, "idempotency.db");
    const first = createWebIdempotencyStore({ dbPath });
    const second = createWebIdempotencyStore({ dbPath });
    const keyHash = hashIdempotencyKey("agent-a", "request-1");
    const bindingHash = hashIdempotencyBinding({ peer: "visitor-1", body: { text: "hello" } });

    try {
      const leader = first.claim(keyHash, bindingHash);
      expect(leader.status).toBe("leader");
      if (leader.status !== "leader") throw new Error("expected leader");

      expect(second.claim(keyHash, bindingHash)).toEqual({
        status: "running",
        turnId: leader.turnId,
      });
      expect(first.complete(keyHash, leader.ownerToken, "data: terminal\n\n")).toBe("complete");
      expect(second.read(keyHash, bindingHash)).toEqual({
        status: "replay",
        turnId: leader.turnId,
        responseBody: "data: terminal\n\n",
      });
    } finally {
      second.close();
      first.close();
    }
  });

  it("rejects changed bindings without storing raw keys or request content", () => {
    const dbPath = join(tmp.path, "idempotency.db");
    const store = createWebIdempotencyStore({ dbPath });
    const sentinelKey = "sentinel-secret-key";
    const sentinelBody = "sentinel-secret-request-body";
    const keyHash = hashIdempotencyKey("agent-a", sentinelKey);
    const bindingHash = hashIdempotencyBinding({ text: sentinelBody });

    try {
      expect(store.claim(keyHash, bindingHash).status).toBe("leader");
      expect(store.claim(keyHash, hashIdempotencyBinding({ text: "changed" }))).toEqual({
        status: "conflict",
      });
      const leader = store.read(keyHash, bindingHash);
      expect(leader.status).toBe("running");
    } finally {
      store.close();
    }

    const probe = new Database(dbPath, { readonly: true });
    try {
      const row = probe.query<Record<string, unknown>, []>("SELECT * FROM web_idempotency").get();
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(sentinelKey);
      expect(serialized).not.toContain(sentinelBody);
    } finally {
      probe.close();
    }
  });

  it("creates an unreplayable tombstone instead of rerunning oversized output", () => {
    const store = createWebIdempotencyStore({
      dbPath: join(tmp.path, "idempotency.db"),
      maxReplayBytes: 8,
    });
    const keyHash = hashIdempotencyKey("agent-a", "request-1");
    const bindingHash = hashIdempotencyBinding({ text: "hello" });

    try {
      const leader = store.claim(keyHash, bindingHash);
      if (leader.status !== "leader") throw new Error("expected leader");
      expect(store.complete(keyHash, leader.ownerToken, "more than eight bytes")).toBe("unknown");
      expect(store.claim(keyHash, bindingHash)).toEqual({ status: "unknown" });
    } finally {
      store.close();
    }
  });

  it("fails closed when the bounded ledger reaches capacity", () => {
    const store = createWebIdempotencyStore({
      dbPath: join(tmp.path, "idempotency.db"),
      maxRecords: 3,
    });
    try {
      expect(
        store.claim(
          hashIdempotencyKey("agent-a", "request-1"),
          hashIdempotencyBinding({ text: "one" }),
        ).status,
      ).toBe("leader");
      expect(
        store.claim(
          hashIdempotencyKey("agent-a", "request-2"),
          hashIdempotencyBinding({ text: "two" }),
        ),
      ).toEqual({ status: "capacity" });
    } finally {
      store.close();
    }
  });

  it("reserves ledger capacity across trust classes", () => {
    const store = createWebIdempotencyStore({
      dbPath: join(tmp.path, "idempotency.db"),
      maxRecords: 3,
      maxPublicRecords: 1,
      maxAgentRecords: 1,
      maxCreatorRecords: 1,
    });
    const publicCapacity = {
      class: "public" as const,
      partitionHash: hashIdempotencyBinding({ partition: "anonymous" }),
    };
    const creatorCapacity = {
      class: "creator" as const,
      partitionHash: hashIdempotencyBinding({ partition: "creator" }),
    };
    try {
      expect(
        store.claim(
          hashIdempotencyKey("agent-a", "public-1"),
          hashIdempotencyBinding({ text: "one" }),
          publicCapacity,
        ).status,
      ).toBe("leader");
      expect(
        store.claim(
          hashIdempotencyKey("agent-a", "public-2"),
          hashIdempotencyBinding({ text: "two" }),
          publicCapacity,
        ),
      ).toEqual({ status: "capacity" });
      expect(
        store.claim(
          hashIdempotencyKey("agent-a", "creator-1"),
          hashIdempotencyBinding({ text: "three" }),
          creatorCapacity,
        ).status,
      ).toBe("leader");
    } finally {
      store.close();
    }
  });

  it("preserves trust-class reservations when maxRecords is lowered", () => {
    const store = createWebIdempotencyStore({
      dbPath: join(tmp.path, "idempotency.db"),
      maxRecords: 10,
    });
    const capacities = {
      public: {
        class: "public" as const,
        partitionHash: hashIdempotencyBinding({ partition: "public" }),
      },
      agent: {
        class: "agent" as const,
        partitionHash: hashIdempotencyBinding({ partition: "agent" }),
      },
      creator: {
        class: "creator" as const,
        partitionHash: hashIdempotencyBinding({ partition: "creator" }),
      },
    };
    try {
      for (let index = 0; index < 5; index += 1) {
        expect(
          store.claim(
            hashIdempotencyKey("agent-a", `public-${index}`),
            hashIdempotencyBinding({ index }),
            capacities.public,
          ).status,
        ).toBe("leader");
      }
      expect(
        store.claim(
          hashIdempotencyKey("agent-a", "public-over-cap"),
          hashIdempotencyBinding({ index: 5 }),
          capacities.public,
        ),
      ).toEqual({ status: "capacity" });
      expect(
        store.claim(
          hashIdempotencyKey("agent-a", "agent-reserved"),
          hashIdempotencyBinding({ text: "agent" }),
          capacities.agent,
        ).status,
      ).toBe("leader");
      expect(
        store.claim(
          hashIdempotencyKey("agent-a", "creator-reserved"),
          hashIdempotencyBinding({ text: "creator" }),
          capacities.creator,
        ).status,
      ).toBe("leader");
    } finally {
      store.close();
    }
  });

  it("rejects configurations that cannot reserve every trust class", () => {
    expect(() =>
      createWebIdempotencyStore({
        dbPath: join(tmp.path, "too-small.db"),
        maxRecords: 2,
      }),
    ).toThrow("maxRecords must be at least 3");
    expect(() =>
      createWebIdempotencyStore({
        dbPath: join(tmp.path, "overcommitted.db"),
        maxRecords: 10,
        maxPublicRecords: 8,
        maxAgentRecords: 2,
        maxCreatorRecords: 1,
      }),
    ).toThrow("trust-class record limits must sum to no more than maxRecords");
  });

  it("turns a crashed leader's stale claim into outcome-unknown", () => {
    let now = 1_000;
    const store = createWebIdempotencyStore({
      dbPath: join(tmp.path, "idempotency.db"),
      staleAfterMs: 100,
      now: () => now,
    });
    const keyHash = hashIdempotencyKey("agent-a", "request-1");
    const bindingHash = hashIdempotencyBinding({ text: "one" });

    try {
      const leader = store.claim(keyHash, bindingHash);
      if (leader.status !== "leader") throw new Error("expected leader");
      now += 101;
      expect(store.claim(keyHash, bindingHash)).toEqual({ status: "unknown" });
      expect(store.heartbeat(keyHash, leader.ownerToken)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("keeps an actively heartbeating leader running across store instances", () => {
    let now = 1_000;
    const dbPath = join(tmp.path, "idempotency.db");
    const first = createWebIdempotencyStore({ dbPath, staleAfterMs: 100, now: () => now });
    const second = createWebIdempotencyStore({ dbPath, staleAfterMs: 100, now: () => now });
    const keyHash = hashIdempotencyKey("agent-a", "request-1");
    const bindingHash = hashIdempotencyBinding({ text: "one" });

    try {
      const leader = first.claim(keyHash, bindingHash);
      if (leader.status !== "leader") throw new Error("expected leader");
      now += 75;
      expect(first.heartbeat(keyHash, leader.ownerToken)).toBe(true);
      now += 75;
      expect(second.claim(keyHash, bindingHash)).toEqual({
        status: "running",
        turnId: leader.turnId,
      });
    } finally {
      second.close();
      first.close();
    }
  });

  it("fails closed when aggregate replay storage reaches its byte budget", () => {
    const store = createWebIdempotencyStore({
      dbPath: join(tmp.path, "idempotency.db"),
      maxReplayBytes: 8,
      maxStoredBytes: 8,
    });
    try {
      const first = store.claim(
        hashIdempotencyKey("agent-a", "request-1"),
        hashIdempotencyBinding({ text: "one" }),
      );
      const second = store.claim(
        hashIdempotencyKey("agent-a", "request-2"),
        hashIdempotencyBinding({ text: "two" }),
      );
      if (first.status !== "leader" || second.status !== "leader") {
        throw new Error("expected leaders");
      }
      expect(
        store.complete(hashIdempotencyKey("agent-a", "request-1"), first.ownerToken, "12345"),
      ).toBe("complete");
      expect(
        store.complete(hashIdempotencyKey("agent-a", "request-2"), second.ownerToken, "67890"),
      ).toBe("unknown");
    } finally {
      store.close();
    }
  });

  it("expires replay bodies but retains fail-closed execution tombstones", () => {
    let now = 1_000;
    const store = createWebIdempotencyStore({
      dbPath: join(tmp.path, "idempotency.db"),
      maxRecords: 3,
      retentionMs: 100,
      now: () => now,
    });
    try {
      const firstKey = hashIdempotencyKey("agent-a", "request-1");
      const first = store.claim(firstKey, hashIdempotencyBinding({ text: "one" }));
      if (first.status !== "leader") throw new Error("expected leader");
      expect(store.complete(firstKey, first.ownerToken, "done")).toBe("complete");

      now += 101;
      expect(store.claim(firstKey, hashIdempotencyBinding({ text: "one" }))).toEqual({
        status: "unknown",
      });
      expect(
        store.claim(
          hashIdempotencyKey("agent-a", "request-2"),
          hashIdempotencyBinding({ text: "two" }),
        ),
      ).toEqual({ status: "capacity" });
    } finally {
      store.close();
    }
  });
});
