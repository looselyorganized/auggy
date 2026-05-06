import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createSqliteStore } from "@/augments/layered-memory/storage/sqlite-store";

describe("SQLite migration — fact-fields", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "migration-test-"));
    dbPath = join(tmpDir, "migration.db");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("first init creates new fact columns", async () => {
    const store = createSqliteStore({ dbPath, retentionDays: 90 });
    await store.initialize();
    await store.close();

    const db = new Database(dbPath);
    const cols = db.prepare("PRAGMA table_info(entries)").all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    db.close();

    expect(colNames).toContain("subject");
    expect(colNames).toContain("predicate");
    expect(colNames).toContain("object");
    expect(colNames).toContain("source_turn_id");
    expect(colNames).toContain("origin");
    expect(colNames).toContain("is_verbatim");
    expect(colNames).toContain("retention_class");
  });

  test("migration is idempotent — running twice is a no-op, existing rows preserved", async () => {
    // First init — create table + columns
    const store1 = createSqliteStore({ dbPath, retentionDays: 90 });
    await store1.initialize();
    // Write a row
    await store1.write({
      label: "test-label",
      content: "hello",
      peerId: "p1",
      trustLevel: "public",
      createdAt: Date.now(),
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });
    await store1.close();

    // Second init — should not throw, not drop table, not delete rows
    const store2 = createSqliteStore({ dbPath, retentionDays: 90 });
    await store2.initialize();
    await store2.close();

    const db = new Database(dbPath);
    const rows = db.prepare("SELECT COUNT(*) as n FROM entries").all() as { n: number }[];
    db.close();

    expect(rows[0]!.n).toBe(1);
  });

  test("existing rows survive migration with NULLs in new columns", async () => {
    // Simulate a pre-Phase-2 database: create the table without fact columns
    const db = new Database(dbPath, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run(`
      CREATE TABLE IF NOT EXISTS entries (
        id              TEXT PRIMARY KEY,
        label           TEXT NOT NULL,
        content         TEXT NOT NULL,
        peer_id         TEXT,
        trust_level     TEXT,
        created_at      INTEGER NOT NULL,
        superseded_by   TEXT,
        retention_class TEXT NOT NULL DEFAULT 'operational',
        is_verbatim     INTEGER NOT NULL DEFAULT 0,
        provenance_model TEXT,
        confidence      REAL,
        embedding_model TEXT,
        scope           TEXT NOT NULL DEFAULT 'peer',
        expires_at      INTEGER
      )
    `);
    db.run(`CREATE TABLE IF NOT EXISTS event_log (
      id        TEXT PRIMARY KEY,
      entry_id  TEXT NOT NULL,
      action    TEXT NOT NULL,
      peer_id   TEXT,
      timestamp INTEGER NOT NULL,
      detail    TEXT
    )`);
    // Insert a legacy row without the new columns
    db.run(
      "INSERT INTO entries (id, label, content, peer_id, created_at, retention_class, is_verbatim) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["legacy-id", "legacy", "old data", "p1", 1000, "operational", 0],
    );
    db.close();

    // Now boot the store — should run migrations without breaking the existing row
    const store = createSqliteStore({ dbPath, retentionDays: 90 });
    await store.initialize();
    await store.close();

    const db2 = new Database(dbPath);
    const row = db2
      .prepare("SELECT * FROM entries WHERE label = ?")
      .get("legacy") as Record<string, unknown> | null;
    db2.close();

    expect(row).not.toBeNull();
    expect(row!.content).toBe("old data");
    expect(row!.subject).toBeNull();
    expect(row!.origin).toBeNull();
    expect(row!.source_turn_id).toBeNull();
  });
});
