import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { createSqliteStore } from "@/augments/layered-memory/sqlite-store";
import { createTempDir } from "@tests/fixtures/temp-dir";
import type { MemoryStore } from "@/augments/layered-memory/types";

describe("SqliteStore", () => {
  let store: MemoryStore;
  let cleanup: () => Promise<void>;
  let dbPath: string;

  beforeEach(async () => {
    const dir = await createTempDir();
    cleanup = dir.cleanup;
    dbPath = join(dir.path, "memory.db");
    store = createSqliteStore({
      dbPath,
      retentionDays: 90,
    });
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
    await cleanup();
  });

  it("writes and reads back an entry", async () => {
    const written = await store.write({
      label: "ep:vis_a:topic1",
      content: "visitor liked espresso",
      peerId: "vis_a",
      trustLevel: "untrusted",
      createdAt: Date.now(),
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });
    expect(written.id).toBeTruthy();

    const fetched = await store.read("ep:vis_a:topic1");
    expect(fetched?.content).toBe("visitor liked espresso");
    expect(fetched?.peerId).toBe("vis_a");
    expect(fetched?.trustLevel).toBe("untrusted");
  });

  it("search returns entries matching content (LIKE)", async () => {
    const now = Date.now();
    await store.write({
      label: "ep:vis_a:1", content: "loves espresso", peerId: "vis_a",
      trustLevel: "untrusted", createdAt: now, supersededBy: null,
      retentionClass: "operational", isVerbatim: false, expiresAt: null,
    });
    await store.write({
      label: "ep:vis_a:2", content: "asked about weather", peerId: "vis_a",
      trustLevel: "untrusted", createdAt: now, supersededBy: null,
      retentionClass: "operational", isVerbatim: false, expiresAt: null,
    });

    const results = await store.search("espresso");
    expect(results.length).toBe(1);
    expect(results[0]!.content).toBe("loves espresso");
  });

  it("peer-scoped search only returns entries for that peer", async () => {
    const now = Date.now();
    await store.write({
      label: "ep:vis_a:1", content: "espresso fan", peerId: "vis_a",
      trustLevel: "untrusted", createdAt: now, supersededBy: null,
      retentionClass: "operational", isVerbatim: false, expiresAt: null,
    });
    await store.write({
      label: "ep:vis_b:1", content: "espresso hater", peerId: "vis_b",
      trustLevel: "untrusted", createdAt: now, supersededBy: null,
      retentionClass: "operational", isVerbatim: false, expiresAt: null,
    });

    const aResults = await store.search("espresso", "vis_a");
    expect(aResults.length).toBe(1);
    expect(aResults[0]!.peerId).toBe("vis_a");

    const bResults = await store.search("espresso", "vis_b");
    expect(bResults.length).toBe(1);
    expect(bResults[0]!.peerId).toBe("vis_b");
  });

  it("list returns labels for a peer when peerId provided", async () => {
    const now = Date.now();
    await store.write({
      label: "ep:vis_a:1", content: "x", peerId: "vis_a",
      trustLevel: "untrusted", createdAt: now, supersededBy: null,
      retentionClass: "operational", isVerbatim: false, expiresAt: null,
    });
    await store.write({
      label: "ep:vis_b:1", content: "y", peerId: "vis_b",
      trustLevel: "untrusted", createdAt: now, supersededBy: null,
      retentionClass: "operational", isVerbatim: false, expiresAt: null,
    });

    const aLabels = await store.list("vis_a");
    expect(aLabels).toEqual(["ep:vis_a:1"]);
  });

  it("forget deletes all entries for a peer and returns count", async () => {
    const now = Date.now();
    await store.write({
      label: "ep:vis_a:1", content: "a1", peerId: "vis_a",
      trustLevel: "untrusted", createdAt: now, supersededBy: null,
      retentionClass: "operational", isVerbatim: false, expiresAt: null,
    });
    await store.write({
      label: "ep:vis_a:2", content: "a2", peerId: "vis_a",
      trustLevel: "untrusted", createdAt: now, supersededBy: null,
      retentionClass: "operational", isVerbatim: false, expiresAt: null,
    });
    await store.write({
      label: "ep:vis_b:1", content: "b1", peerId: "vis_b",
      trustLevel: "untrusted", createdAt: now, supersededBy: null,
      retentionClass: "operational", isVerbatim: false, expiresAt: null,
    });

    const deleted = await store.forget("vis_a");
    expect(deleted).toBe(2);

    const remaining = await store.search("");
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.peerId).toBe("vis_b");
  });

  it("supersede excludes the old entry from search results", async () => {
    const now = Date.now();
    const old = await store.write({
      label: "ep:vis_a:1", content: "old fact", peerId: "vis_a",
      trustLevel: "untrusted", createdAt: now, supersededBy: null,
      retentionClass: "operational", isVerbatim: false, expiresAt: null,
    });
    const fresh = await store.write({
      label: "ep:vis_a:1b", content: "fresh fact", peerId: "vis_a",
      trustLevel: "untrusted", createdAt: now + 1, supersededBy: null,
      retentionClass: "operational", isVerbatim: false, expiresAt: null,
    });
    await store.supersede(old.id, fresh.id);

    const results = await store.search("fact", "vis_a");
    expect(results.length).toBe(1);
    expect(results[0]!.content).toBe("fresh fact");
  });

  it("cleanup deletes entries past expires_at", async () => {
    const now = Date.now();
    await store.write({
      label: "ep:vis_a:soon", content: "expires soon", peerId: "vis_a",
      trustLevel: "untrusted", createdAt: now, supersededBy: null,
      retentionClass: "operational", isVerbatim: false, expiresAt: now + 1_000,
    });
    await store.write({
      label: "ep:vis_a:fresh", content: "stays", peerId: "vis_a",
      trustLevel: "untrusted", createdAt: now, supersededBy: null,
      retentionClass: "operational", isVerbatim: false, expiresAt: now + 1_000_000,
    });

    // Backdate the first entry's expiry via a parallel WAL-safe handle so
    // the main store's write-time sweep doesn't pre-empt cleanup().
    const { Database } = await import("bun:sqlite");
    const db2 = new Database(dbPath, { readwrite: true });
    db2.run("UPDATE entries SET expires_at = ? WHERE label = ?", [
      now - 1,
      "ep:vis_a:soon",
    ]);
    db2.close();

    const removed = await store.cleanup();
    expect(removed).toBe(1);

    const remaining = await store.search("", "vis_a");
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.label).toBe("ep:vis_a:fresh");
  });

  it("provenance fields round-trip through write/read", async () => {
    const now = Date.now();
    await store.write({
      label: "ep:vis_a:1", content: "lesson learned", peerId: "vis_a",
      trustLevel: "facility", createdAt: now, supersededBy: null,
      retentionClass: "lesson", isVerbatim: true, expiresAt: null,
    });
    const fetched = await store.read("ep:vis_a:1");
    expect(fetched?.trustLevel).toBe("facility");
    expect(fetched?.retentionClass).toBe("lesson");
    expect(fetched?.isVerbatim).toBe(true);
  });

  it("retentionDays sets a default expires_at when not provided", async () => {
    const now = Date.now();
    const written = await store.write({
      label: "ep:vis_a:1", content: "x", peerId: "vis_a",
      trustLevel: "untrusted", createdAt: now, supersededBy: null,
      retentionClass: "operational", isVerbatim: false, expiresAt: null,
    });
    expect(written.expiresAt).not.toBeNull();
    expect(written.expiresAt!).toBeGreaterThan(now);
  });

  it("read returns null for missing label", async () => {
    const fetched = await store.read("ep:nonexistent");
    expect(fetched).toBeNull();
  });

  it("entry insert + event_log insert are atomic (no partial write)", async () => {
    const now = Date.now();
    await store.write({
      label: "ep:vis_a:1", content: "tracked", peerId: "vis_a",
      trustLevel: "untrusted", createdAt: now, supersededBy: null,
      retentionClass: "operational", isVerbatim: false, expiresAt: null,
    });

    const { Database } = await import("bun:sqlite");
    const db2 = new Database(dbPath, { readwrite: true });
    const events = db2
      .prepare<{ count: number }, []>(
        "SELECT COUNT(*) as count FROM event_log WHERE action = 'write'",
      )
      .get();
    const entries = db2
      .prepare<{ count: number }, []>(
        "SELECT COUNT(*) as count FROM entries",
      )
      .get();
    db2.close();

    // Both rows committed together — exactly one entry, exactly one
    // matching write event.
    expect(entries?.count).toBe(1);
    expect(events?.count).toBe(1);
  });

  it("expiry sweep is decoupled from write — does not retroactively fail successful writes", async () => {
    // Write 200 entries; with sample rate 1/50 cleanup runs ~4 times.
    // Even if cleanup hit a constraint, the writes must remain.
    const now = Date.now();
    for (let i = 0; i < 200; i++) {
      await store.write({
        label: `ep:vis_a:${i}`,
        content: `entry ${i}`,
        peerId: "vis_a",
        trustLevel: "untrusted",
        createdAt: now + i,
        supersededBy: null,
        retentionClass: "operational",
        isVerbatim: false,
        expiresAt: null,
      });
    }

    const { Database } = await import("bun:sqlite");
    const db2 = new Database(dbPath, { readwrite: true });
    const result = db2
      .prepare<{ count: number }, []>("SELECT COUNT(*) as count FROM entries")
      .get();
    db2.close();
    expect(result?.count).toBe(200);
  });

  it("LIKE wildcards in query are escaped", async () => {
    const now = Date.now();
    await store.write({
      label: "ep:vis_a:1", content: "literal % match", peerId: "vis_a",
      trustLevel: "untrusted", createdAt: now, supersededBy: null,
      retentionClass: "operational", isVerbatim: false, expiresAt: null,
    });
    await store.write({
      label: "ep:vis_a:2", content: "should not match", peerId: "vis_a",
      trustLevel: "untrusted", createdAt: now, supersededBy: null,
      retentionClass: "operational", isVerbatim: false, expiresAt: null,
    });

    // Query with literal % should only match the entry containing %
    const results = await store.search("%");
    expect(results.length).toBe(1);
    expect(results[0]!.content).toContain("%");
  });
});
