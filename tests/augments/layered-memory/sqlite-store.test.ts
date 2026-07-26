import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  createSqliteStore,
  deleteSqliteMemoryForPeer,
  reassignSqliteMemoryPeerId,
} from "@/augments/layeredMemory/storage/sqlite-store";
import { createTempDir } from "@tests/fixtures/temp-dir";
import type { MemoryStore } from "@/augments/layeredMemory/storage/types";

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

  it("rejects an unrelated SQLite database without adding memory tables", async () => {
    const unrelatedPath = `${dbPath}.unrelated`;
    const unrelated = new Database(unrelatedPath);
    unrelated.run("CREATE TABLE foreign_owner (secret TEXT NOT NULL)");
    unrelated.close();

    expect(() => createSqliteStore({ dbPath: unrelatedPath, retentionDays: 90 })).toThrow(
      /recognized legacy schema/,
    );

    const probe = new Database(unrelatedPath, { readonly: true });
    try {
      const names = probe
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      expect(names).toEqual(["foreign_owner"]);
    } finally {
      probe.close();
    }
  });

  it("rejects a nullable lookalike schema without stamping ownership", async () => {
    const lookalikePath = `${dbPath}.lookalike`;
    const valid = createSqliteStore({ dbPath: lookalikePath, retentionDays: 90 });
    await valid.close();
    const tamper = new Database(lookalikePath);
    tamper.run("PRAGMA application_id = 0");
    tamper.run("PRAGMA user_version = 0");
    const originalSql = tamper
      .query<{ sql: string }, []>("SELECT sql FROM sqlite_schema WHERE name = 'entries'")
      .get()!.sql;
    tamper.run("ALTER TABLE entries RENAME TO entries_valid");
    tamper.run(originalSql.replace("label           TEXT NOT NULL", "label           TEXT"));
    tamper.run("DROP TABLE entries_valid");
    tamper.run("CREATE INDEX idx_entries_peer ON entries(peer_id)");
    tamper.run("CREATE INDEX idx_entries_label ON entries(label)");
    tamper.run("CREATE INDEX idx_entries_created ON entries(created_at DESC)");
    tamper.run(
      "CREATE INDEX idx_entries_expires ON entries(expires_at) WHERE expires_at IS NOT NULL",
    );
    tamper.close();

    expect(() => createSqliteStore({ dbPath: lookalikePath, retentionDays: 90 })).toThrow(
      /recognized legacy schema/,
    );

    const probe = new Database(lookalikePath, { readonly: true });
    try {
      expect(probe.query("PRAGMA application_id").get()).toEqual({ application_id: 0 });
      expect(probe.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    } finally {
      probe.close();
    }
  });

  it("writes and reads back an entry", async () => {
    const written = await store.write({
      label: "ep:vis_a:topic1",
      content: "visitor liked espresso",
      peerId: "vis_a",
      trustLevel: "public",
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
    expect(fetched?.trustLevel).toBe("public");
  });

  it("search returns entries matching content (LIKE)", async () => {
    const now = Date.now();
    await store.write({
      label: "ep:vis_a:1",
      content: "loves espresso",
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
      content: "asked about weather",
      peerId: "vis_a",
      trustLevel: "public",
      createdAt: now,
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });

    const results = await store.search("espresso");
    expect(results.length).toBe(1);
    expect(results[0]!.content).toBe("loves espresso");
  });

  it("peer-scoped search only returns entries for that peer", async () => {
    const now = Date.now();
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
    await store.write({
      label: "ep:vis_b:1",
      content: "espresso hater",
      peerId: "vis_b",
      trustLevel: "public",
      createdAt: now,
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
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
      label: "ep:vis_b:1",
      content: "y",
      peerId: "vis_b",
      trustLevel: "public",
      createdAt: now,
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });

    const aLabels = await store.list("vis_a");
    expect(aLabels).toEqual(["ep:vis_a:1"]);
  });

  it("forget deletes all entries for a peer and returns count", async () => {
    const now = Date.now();
    await store.write({
      label: "ep:vis_a:1",
      content: "a1",
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
      content: "a2",
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
      content: "b1",
      peerId: "vis_b",
      trustLevel: "public",
      createdAt: now,
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
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
    const fresh = await store.write({
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
    await store.supersede(old.id, fresh.id);

    const results = await store.search("fact", "vis_a");
    expect(results.length).toBe(1);
    expect(results[0]!.content).toBe("fresh fact");
  });

  it("cleanup deletes entries past expires_at", async () => {
    const now = Date.now();
    await store.write({
      label: "ep:vis_a:soon",
      content: "expires soon",
      peerId: "vis_a",
      trustLevel: "public",
      createdAt: now,
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: now + 1_000,
    });
    await store.write({
      label: "ep:vis_a:fresh",
      content: "stays",
      peerId: "vis_a",
      trustLevel: "public",
      createdAt: now,
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: now + 1_000_000,
    });

    // Backdate the first entry's expiry via a parallel WAL-safe handle so
    // the main store's write-time sweep doesn't pre-empt cleanup().
    const { Database } = await import("bun:sqlite");
    const db2 = new Database(dbPath, { readwrite: true });
    db2.run("UPDATE entries SET expires_at = ? WHERE label = ?", [now - 1, "ep:vis_a:soon"]);
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
      label: "ep:vis_a:1",
      content: "lesson learned",
      peerId: "vis_a",
      trustLevel: "agent",
      createdAt: now,
      supersededBy: null,
      retentionClass: "lesson",
      isVerbatim: true,
      expiresAt: null,
    });
    const fetched = await store.read("ep:vis_a:1");
    expect(fetched?.trustLevel).toBe("agent");
    expect(fetched?.retentionClass).toBe("lesson");
    expect(fetched?.isVerbatim).toBe(true);
  });

  it("retentionDays sets a default expires_at when not provided", async () => {
    const now = Date.now();
    const written = await store.write({
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
      label: "ep:vis_a:1",
      content: "tracked",
      peerId: "vis_a",
      trustLevel: "public",
      createdAt: now,
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });

    const { Database } = await import("bun:sqlite");
    const db2 = new Database(dbPath, { readwrite: true });
    const events = db2
      .prepare<{ count: number }, []>(
        "SELECT COUNT(*) as count FROM event_log WHERE action = 'write'",
      )
      .get();
    const entries = db2
      .prepare<{ count: number }, []>("SELECT COUNT(*) as count FROM entries")
      .get();
    db2.close();

    // Both rows committed together — exactly one entry, exactly one
    // matching write event.
    expect(entries?.count).toBe(1);
    expect(events?.count).toBe(1);
  });

  it("rolls back the entry when its audit insert is aborted", async () => {
    const db2 = new Database(dbPath);
    db2.run(`CREATE TRIGGER reject_write_audit
      BEFORE INSERT ON event_log
      WHEN NEW.action = 'write'
      BEGIN
        SELECT RAISE(ABORT, 'audit blocked');
      END`);
    db2.close();

    await expect(
      store.write({
        label: "ep:vis_a:blocked",
        content: "must roll back",
        peerId: "vis_a",
        trustLevel: "public",
        createdAt: Date.now(),
        supersededBy: null,
        retentionClass: "operational",
        isVerbatim: false,
        expiresAt: null,
      }),
    ).rejects.toThrow(/audit blocked/);

    const probe = new Database(dbPath);
    try {
      const row = probe.prepare("SELECT 1 FROM entries WHERE label = 'ep:vis_a:blocked'").get();
      expect(row).toBeNull();
    } finally {
      probe.close();
    }
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
        trustLevel: "public",
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
      label: "ep:vis_a:1",
      content: "literal % match",
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
      content: "should not match",
      peerId: "vis_a",
      trustLevel: "public",
      createdAt: now,
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });

    // Query with literal % should only match the entry containing %
    const results = await store.search("%");
    expect(results.length).toBe(1);
    expect(results[0]!.content).toContain("%");
  });

  it("isolates agents sharing a database before reads, limits, and mutations", async () => {
    const sharedPath = `${dbPath}.shared`;
    const agentA = createSqliteStore({
      dbPath: sharedPath,
      retentionDays: 90,
      namespace: "aug1_a",
    });
    const agentB = createSqliteStore({
      dbPath: sharedPath,
      retentionDays: 90,
      namespace: "aug1_b",
    });
    const now = Date.now();

    try {
      await agentA.write({
        id: "a-entry",
        label: "aug1_a:creator:preference",
        content: "shared search term from A",
        peerId: "creator",
        trustLevel: "creator",
        createdAt: now,
        supersededBy: null,
        retentionClass: "operational",
        isVerbatim: false,
        expiresAt: null,
      });
      await agentB.write({
        id: "b-entry",
        label: "aug1_b:creator:preference",
        content: "shared search term from B",
        peerId: "creator",
        trustLevel: "creator",
        createdAt: now + 1,
        supersededBy: null,
        retentionClass: "operational",
        isVerbatim: false,
        expiresAt: null,
      });

      expect(
        (await agentA.search("shared search term", "creator", 1)).map((entry) => entry.id),
      ).toEqual(["a-entry"]);
      expect(await agentA.read("aug1_b:creator:preference")).toBeNull();
      expect(
        (await agentA.listEntriesByPeer?.({ peerId: "creator" }))?.map((entry) => entry.id),
      ).toEqual(["a-entry"]);
      expect((await agentA.listEntriesByPeer?.())?.map((entry) => entry.id)).toEqual(["a-entry"]);
      expect(await agentA.countByRetentionClass?.()).toEqual({
        operational: 1,
        lesson: 0,
        total: 1,
      });

      await agentA.supersede("b-entry", "attacker-controlled");
      expect((await agentB.read("aug1_b:creator:preference"))?.supersededBy).toBeNull();

      const probe = new Database(sharedPath);
      probe.run("UPDATE entries SET expires_at = ? WHERE id = ?", [Date.now() - 1, "b-entry"]);
      probe.close();
      const originalRandom = Math.random;
      Math.random = () => 0;
      try {
        await agentA.write({
          id: "a-sweep-trigger",
          label: "aug1_a:creator:sweep-trigger",
          content: "trigger a sampled cleanup",
          peerId: "creator",
          trustLevel: "creator",
          createdAt: now + 2,
          supersededBy: null,
          retentionClass: "lesson",
          isVerbatim: false,
          expiresAt: null,
        });
      } finally {
        Math.random = originalRandom;
      }
      const afterSweep = new Database(sharedPath);
      expect(
        afterSweep
          .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM entries WHERE id = ?")
          .get("b-entry")?.n,
      ).toBe(1);
      afterSweep.run("UPDATE entries SET expires_at = NULL WHERE id = ?", ["b-entry"]);
      afterSweep.close();

      expect(await agentA.forget("creator")).toBe(2);
      expect(await agentB.read("aug1_b:creator:preference")).not.toBeNull();
    } finally {
      await agentA.close();
      await agentB.close();
    }
  });

  it("treats differently-cased namespaces as distinct security principals", async () => {
    const sharedPath = `${dbPath}.case-sensitive`;
    const upper = createSqliteStore({ dbPath: sharedPath, retentionDays: 90, namespace: "Foo" });
    const lower = createSqliteStore({ dbPath: sharedPath, retentionDays: 90, namespace: "foo" });
    const now = Date.now();
    try {
      await upper.write({
        id: "upper",
        label: "Foo:peer:fact",
        content: "case sentinel",
        peerId: "peer",
        trustLevel: "public",
        createdAt: now,
        supersededBy: null,
        retentionClass: "operational",
        isVerbatim: false,
        expiresAt: null,
      });
      await lower.write({
        id: "lower",
        label: "foo:peer:fact",
        content: "case sentinel",
        peerId: "peer",
        trustLevel: "public",
        createdAt: now + 1,
        supersededBy: null,
        retentionClass: "operational",
        isVerbatim: false,
        expiresAt: null,
      });

      expect((await upper.search("case sentinel", "peer")).map((row) => row.id)).toEqual(["upper"]);
      expect((await lower.listEntriesByPeer?.({ peerId: "peer" }))?.map((row) => row.id)).toEqual([
        "lower",
      ]);
      await lower.supersede("upper", "cross-case");
      expect((await upper.read("Foo:peer:fact"))?.supersededBy).toBeNull();
      expect(await lower.forget("peer")).toBe(1);
      expect(await upper.read("Foo:peer:fact")).not.toBeNull();
    } finally {
      await upper.close();
      await lower.close();
    }
  });

  it("uses exact owner keys for nested namespaces and destructive operations", async () => {
    const sharedPath = `${dbPath}.nested`;
    const parent = createSqliteStore({ dbPath: sharedPath, retentionDays: 90, namespace: "Foo" });
    const child = createSqliteStore({
      dbPath: sharedPath,
      retentionDays: 90,
      namespace: "Foo:bar",
    });
    const common = {
      label: "Foo:bar:peer:fact",
      peerId: "peer",
      trustLevel: "public" as const,
      createdAt: Date.now(),
      supersededBy: null,
      retentionClass: "operational" as const,
      isVerbatim: false,
      expiresAt: null,
    };
    try {
      await parent.write({ ...common, id: "parent", content: "parent-owned" });
      await child.write({ ...common, id: "child", content: "child-owned" });

      expect((await parent.search("owned", "peer")).map((row) => row.id)).toEqual(["parent"]);
      expect((await child.search("owned", "peer")).map((row) => row.id)).toEqual(["child"]);
      expect((await parent.listEntriesByPeer({ peerId: "peer" })).map((row) => row.id)).toEqual([
        "parent",
      ]);
      expect(await parent.countByRetentionClass()).toEqual({
        operational: 1,
        lesson: 0,
        total: 1,
      });

      await parent.supersede("child", "forged");
      expect((await child.read(common.label))?.supersededBy).toBeNull();

      const probe = new Database(sharedPath);
      probe.run("UPDATE entries SET expires_at = ? WHERE id = ?", [Date.now() - 1, "child"]);
      probe.close();
      expect(await parent.cleanup()).toBe(0);
      const afterCleanup = new Database(sharedPath);
      expect(
        afterCleanup
          .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM entries WHERE id = ?")
          .get("child")?.n,
      ).toBe(1);
      afterCleanup.run("UPDATE entries SET expires_at = NULL WHERE id = ?", ["child"]);
      afterCleanup.close();

      expect(await parent.forget("peer")).toBe(1);
      expect((await child.read(common.label))?.id).toBe("child");
    } finally {
      await parent.close();
      await child.close();
    }
  });

  it("rejects a supplied blank namespace instead of opening an unscoped store", () => {
    expect(() =>
      createSqliteStore({ dbPath: `${dbPath}.blank`, retentionDays: 90, namespace: "   " }),
    ).toThrow(/namespace.*1 to 256/i);
  });

  it("atomically tombstones a revoked peer against concurrent and future writes", async () => {
    const sharedPath = `${dbPath}.tombstone`;
    const first = createSqliteStore({ dbPath: sharedPath, retentionDays: 90, namespace: "ep" });
    const second = createSqliteStore({ dbPath: sharedPath, retentionDays: 90, namespace: "ep" });
    const writes = Array.from({ length: 20 }, (_, index) =>
      first.write({
        id: `racy-${index}`,
        label: `ep:revoked:${index}`,
        content: "must not survive revocation",
        peerId: "revoked",
        trustLevel: "public",
        createdAt: Date.now(),
        supersededBy: null,
        retentionClass: "operational",
        isVerbatim: false,
        expiresAt: null,
      }),
    );
    const deletion = Promise.resolve().then(() =>
      deleteSqliteMemoryForPeer(sharedPath, "ep", "revoked"),
    );
    await Promise.allSettled([...writes, deletion]);

    expect(await second.search("must not survive", "revoked")).toEqual([]);
    await expect(
      second.write({
        label: "ep:revoked:late",
        content: "late write",
        peerId: "revoked",
        trustLevel: "public",
        createdAt: Date.now(),
        supersededBy: null,
        retentionClass: "operational",
        isVerbatim: false,
        expiresAt: null,
      }),
    ).rejects.toThrow(/tombstoned/i);
    await first.close();
    await second.close();
  });

  it("retires anonymous memory when the migration destination is already revoked", async () => {
    const sharedPath = `${dbPath}.revoked-migration`;
    const namespaced = createSqliteStore({
      dbPath: sharedPath,
      retentionDays: 90,
      namespace: "ep",
    });
    await namespaced.write({
      label: "ep:anonymous:before-revoke",
      content: "must be erased",
      peerId: "anon-source",
      trustLevel: "public",
      createdAt: Date.now(),
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });

    deleteSqliteMemoryForPeer(sharedPath, "ep", "vis-revoked");
    expect(reassignSqliteMemoryPeerId(sharedPath, "ep", "anon-source", "vis-revoked")).toBe(0);
    expect(await namespaced.search("must be erased", "anon-source")).toEqual([]);
    await expect(
      namespaced.write({
        label: "ep:anonymous:after-revoke",
        content: "must fail",
        peerId: "anon-source",
        trustLevel: "public",
        createdAt: Date.now(),
        supersededBy: null,
        retentionClass: "operational",
        isVerbatim: false,
        expiresAt: null,
      }),
    ).rejects.toThrow(/tombstoned/i);
    await namespaced.close();
  });

  it("treats a same-peer migration as a mutation-free no-op", async () => {
    const sharedPath = `${dbPath}.same-peer-migration`;
    const namespaced = createSqliteStore({
      dbPath: sharedPath,
      retentionDays: 90,
      namespace: "ep",
    });
    await namespaced.write({
      label: "ep:recognized:before-reverify",
      content: "must survive same-peer reverification",
      peerId: "vis-same",
      trustLevel: "public",
      createdAt: Date.now(),
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });

    expect(reassignSqliteMemoryPeerId(sharedPath, "ep", "vis-same", "vis-same")).toBe(0);
    expect(await namespaced.search("survive", "vis-same")).toHaveLength(1);
    await expect(
      namespaced.write({
        label: "ep:recognized:after-reverify",
        content: "writes remain enabled",
        peerId: "vis-same",
        trustLevel: "public",
        createdAt: Date.now(),
        supersededBy: null,
        retentionClass: "operational",
        isVerbatim: false,
        expiresAt: null,
      }),
    ).resolves.toBeDefined();
    await namespaced.close();
  });
});
