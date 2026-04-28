import { describe, it, expect, beforeEach } from "bun:test";
import { createSupabaseStore } from "@/augments/layered-memory/supabase-store";
import { createMockSupabase } from "@tests/fixtures/mock-supabase";
import type { MemoryStore } from "@/augments/layered-memory/types";
import type { LayeredSupabaseClient } from "@/augments/layered-memory/supabase-store";

describe("SupabaseStore", () => {
  let store: MemoryStore;

  beforeEach(async () => {
    const client = createMockSupabase() as unknown as LayeredSupabaseClient;
    store = createSupabaseStore({
      client,
      table: "agent_memory",
      retentionDays: 90,
    });
    await store.initialize();
  });

  it("writes and reads back an entry", async () => {
    const now = Date.now();
    await store.write({
      label: "ep:vis_a:1",
      content: "test content",
      peerId: "vis_a",
      trustLevel: "public",
      createdAt: now,
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });

    const fetched = await store.read("ep:vis_a:1");
    expect(fetched?.content).toBe("test content");
    expect(fetched?.peerId).toBe("vis_a");
  });

  it("peer-scoped search filters by peer_id", async () => {
    const now = Date.now();
    await store.write({
      label: "ep:vis_a:1",
      content: "espresso",
      peerId: "vis_a",
      trustLevel: "public",
      createdAt: now,
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });
    await store.write({
      label: "ep:vis_b:1",
      content: "espresso",
      peerId: "vis_b",
      trustLevel: "public",
      createdAt: now,
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });

    const results = await store.search("espresso", "vis_a");
    expect(results.length).toBe(1);
    expect(results[0]!.peerId).toBe("vis_a");
  });

  it("forget deletes peer entries and returns count", async () => {
    const now = Date.now();
    await store.write({
      label: "ep:vis_a:1",
      content: "x",
      peerId: "vis_a",
      trustLevel: "public",
      createdAt: now,
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });
    await store.write({
      label: "ep:vis_a:2",
      content: "y",
      peerId: "vis_a",
      trustLevel: "public",
      createdAt: now,
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });

    const deleted = await store.forget("vis_a");
    expect(deleted).toBe(2);
  });

  it("peer scoping is not crowded out by a busy other-peer tenant", async () => {
    const now = Date.now();
    // Peer B writes a hundred entries, all newer than peer A's one entry.
    // The old (broken) impl fetched limit*4 newest matches across all
    // tenants, then filtered in app code — so peer A's lone hit would
    // never make it through. The fixed impl filters by peer_id in SQL
    // BEFORE LIMIT, so peer A always sees their own row.
    for (let i = 0; i < 100; i++) {
      await store.write({
        label: `ep:vis_b:${i}`,
        content: "espresso shot",
        peerId: "vis_b",
        trustLevel: "public",
        createdAt: now + i + 1, // strictly newer than peer A's
        supersededBy: null,
        retentionClass: "operational",
        isVerbatim: false,
        expiresAt: null,
      });
    }
    await store.write({
      label: "ep:vis_a:1",
      content: "espresso fan",
      peerId: "vis_a",
      trustLevel: "public",
      createdAt: now,
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });

    const results = await store.search("espresso", "vis_a");
    expect(results.length).toBe(1);
    expect(results[0]!.peerId).toBe("vis_a");
    expect(results[0]!.content).toBe("espresso fan");
  });

  it("expired entries are filtered out by SQL, not app code", async () => {
    const now = Date.now();
    await store.write({
      label: "ep:vis_a:expired",
      content: "stale match",
      peerId: "vis_a",
      trustLevel: "public",
      createdAt: now - 10_000,
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: now - 5_000, // already expired
    });
    await store.write({
      label: "ep:vis_a:fresh",
      content: "fresh match",
      peerId: "vis_a",
      trustLevel: "public",
      createdAt: now,
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: now + 1_000_000,
    });

    const results = await store.search("match", "vis_a");
    expect(results.length).toBe(1);
    expect(results[0]!.label).toBe("ep:vis_a:fresh");
  });

  it("supersede excludes superseded entries from search", async () => {
    const now = Date.now();
    await store.write({
      id: "old-id",
      label: "ep:vis_a:1",
      content: "old fact",
      peerId: "vis_a",
      trustLevel: "public",
      createdAt: now,
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });
    await store.write({
      id: "new-id",
      label: "ep:vis_a:1b",
      content: "fresh fact",
      peerId: "vis_a",
      trustLevel: "public",
      createdAt: now + 1,
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });
    await store.supersede("old-id", "new-id");

    const results = await store.search("fact", "vis_a");
    expect(results.length).toBe(1);
    expect(results[0]!.content).toBe("fresh fact");
  });
});
