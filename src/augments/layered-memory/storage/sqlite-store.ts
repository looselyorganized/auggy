import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { MemoryStore, RetentionClass, SqliteStoreConfig, StoreEntry } from "./types";
import type { TrustLevel } from "../../../types";

// Each statement run individually to keep the SQL surface explicit.
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS entries (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entries_peer ON entries(peer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_label ON entries(label)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_expires ON entries(expires_at) WHERE expires_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS event_log (
    id        TEXT PRIMARY KEY,
    entry_id  TEXT NOT NULL,
    action    TEXT NOT NULL,
    peer_id   TEXT,
    timestamp INTEGER NOT NULL,
    detail    TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_entry ON event_log(entry_id)`,
];

interface Row {
  id: string;
  label: string;
  content: string;
  peer_id: string | null;
  trust_level: string | null;
  created_at: number;
  superseded_by: string | null;
  retention_class: string;
  is_verbatim: number;
  expires_at: number | null;
}

function rowToEntry(row: Row): StoreEntry {
  return {
    id: row.id,
    label: row.label,
    content: row.content,
    peerId: row.peer_id,
    trustLevel: row.trust_level as TrustLevel | null,
    createdAt: row.created_at,
    supersededBy: row.superseded_by,
    retentionClass: row.retention_class as RetentionClass,
    isVerbatim: row.is_verbatim === 1,
    expiresAt: row.expires_at,
  };
}

// Sampled cleanup: every ~Nth write triggers a bounded DELETE so write
// latency doesn't depend on stale-data backlog. Capped via LIMIT so even
// a huge backlog drains in roughly constant time per write.
const CLEANUP_SAMPLE_RATE = 50;
const CLEANUP_BATCH_SIZE = 100;

export function createSqliteStore(config: SqliteStoreConfig): MemoryStore {
  const db = new Database(config.dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  // Schema must exist before we prepare statements that reference it.
  for (const stmt of SCHEMA_STATEMENTS) {
    db.run(stmt);
  }

  // Phase 2 migration: add structured-fact + provenance columns idempotently.
  // PRAGMA table_info detects which columns already exist; ALTER TABLE adds
  // only the absent ones. Existing rows survive with NULLs in the new columns.
  // is_verbatim + retention_class are already in SCHEMA_STATEMENTS above;
  // they appear in the list so the migration is self-documenting and safe to
  // re-run if applied to a DB that predates them (legacy schema path).
  function ensureMigrations(): void {
    const cols = db.prepare("PRAGMA table_info(entries)").all() as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));

    const additions: Array<{ name: string; ddl: string }> = [
      { name: "subject", ddl: "ALTER TABLE entries ADD COLUMN subject TEXT" },
      { name: "predicate", ddl: "ALTER TABLE entries ADD COLUMN predicate TEXT" },
      { name: "object", ddl: "ALTER TABLE entries ADD COLUMN object TEXT" },
      { name: "source_turn_id", ddl: "ALTER TABLE entries ADD COLUMN source_turn_id TEXT" },
      { name: "origin", ddl: "ALTER TABLE entries ADD COLUMN origin TEXT" },
      { name: "is_verbatim", ddl: "ALTER TABLE entries ADD COLUMN is_verbatim INTEGER" },
      { name: "retention_class", ddl: "ALTER TABLE entries ADD COLUMN retention_class TEXT" },
    ];

    for (const { name, ddl } of additions) {
      if (!colNames.has(name)) db.run(ddl);
    }
  }

  ensureMigrations();

  const retentionMs = config.retentionDays * 24 * 60 * 60 * 1000;

  // Pre-compiled statements live as long as the connection.
  const insertEntryStmt = db.prepare(
    `INSERT INTO entries (id, label, content, peer_id, trust_level, created_at, superseded_by, retention_class, is_verbatim, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEventStmt = db.prepare(
    "INSERT INTO event_log (id, entry_id, action, peer_id, timestamp, detail) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const cleanupStmt = db.prepare(
    "DELETE FROM entries WHERE id IN (SELECT id FROM entries WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT ?)",
  );

  type SqlBinding = string | number | bigint | boolean | null | Uint8Array;

  // writeAndLog runs the entry insert and audit insert atomically. If
  // either fails, both roll back — callers either see a successful
  // write that's fully recorded, or an error and zero side effects.
  const writeAndLog = db.transaction((entryParams: SqlBinding[], eventParams: SqlBinding[]) => {
    insertEntryStmt.run(...entryParams);
    insertEventStmt.run(...eventParams);
  });

  async function initialize(): Promise<void> {
    // Schema is now created at construction time. Kept as a no-op for
    // contract symmetry with SupabaseStore (whose schema lives in
    // migrations).
  }

  function logEvent(entryId: string, action: string, peerId: string | null, detail?: object) {
    insertEventStmt.run(
      randomUUID(),
      entryId,
      action,
      peerId,
      Date.now(),
      detail ? JSON.stringify(detail) : null,
    );
  }

  async function write(input: Omit<StoreEntry, "id"> & { id?: string }): Promise<StoreEntry> {
    const id = input.id ?? randomUUID();
    const expiresAt = input.expiresAt ?? input.createdAt + retentionMs;

    writeAndLog(
      [
        id,
        input.label,
        input.content,
        input.peerId,
        input.trustLevel,
        input.createdAt,
        input.supersededBy,
        input.retentionClass,
        input.isVerbatim ? 1 : 0,
        expiresAt,
      ],
      [randomUUID(), id, "write", input.peerId, Date.now(), null],
    );

    // Sampled, bounded cleanup. Outside the transaction so a partial
    // sweep can never roll back the user's write. ~1-in-50 writes pay
    // the small constant DELETE cost; 49-in-50 writes pay nothing.
    if (Math.random() * CLEANUP_SAMPLE_RATE < 1) {
      const result = cleanupStmt.run(Date.now(), CLEANUP_BATCH_SIZE);
      if (result.changes > 0) {
        logEvent("(batch)", "expire-sweep", null, { swept: result.changes });
      }
    }

    return { ...input, id, expiresAt };
  }

  async function search(query: string, peerId?: string, limit = 10): Promise<StoreEntry[]> {
    const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
    const pattern = `%${escaped}%`;
    const now = Date.now();

    if (peerId) {
      const rows = db
        .prepare<Row, [string, string, number, number]>(
          `SELECT * FROM entries
           WHERE peer_id = ?
             AND content LIKE ? ESCAPE '\\'
             AND superseded_by IS NULL
             AND (expires_at IS NULL OR expires_at >= ?)
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(peerId, pattern, now, limit);
      return rows.map(rowToEntry);
    }

    const rows = db
      .prepare<Row, [string, number, number]>(
        `SELECT * FROM entries
         WHERE content LIKE ? ESCAPE '\\'
           AND superseded_by IS NULL
           AND (expires_at IS NULL OR expires_at >= ?)
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(pattern, now, limit);
    return rows.map(rowToEntry);
  }

  async function read(label: string): Promise<StoreEntry | null> {
    const row = db
      .prepare<Row, [string]>(
        "SELECT * FROM entries WHERE label = ? AND superseded_by IS NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get(label);
    return row ? rowToEntry(row) : null;
  }

  async function list(peerId?: string): Promise<string[]> {
    if (peerId) {
      const rows = db
        .prepare<{ label: string }, [string]>(
          "SELECT DISTINCT label FROM entries WHERE peer_id = ? AND superseded_by IS NULL ORDER BY label",
        )
        .all(peerId);
      return rows.map((r) => r.label);
    }
    const rows = db
      .prepare<{ label: string }, []>(
        "SELECT DISTINCT label FROM entries WHERE superseded_by IS NULL ORDER BY label",
      )
      .all();
    return rows.map((r) => r.label);
  }

  async function forget(peerId: string): Promise<number> {
    const result = db.prepare("DELETE FROM entries WHERE peer_id = ?").run(peerId);
    logEvent("(batch)", "forget", peerId, { deleted: result.changes });
    return result.changes;
  }

  async function supersede(entryId: string, newEntryId: string): Promise<void> {
    db.prepare("UPDATE entries SET superseded_by = ? WHERE id = ?").run(newEntryId, entryId);
    logEvent(entryId, "supersede", null, { supersededBy: newEntryId });
  }

  async function cleanup(): Promise<number> {
    const result = db
      .prepare("DELETE FROM entries WHERE expires_at IS NOT NULL AND expires_at < ?")
      .run(Date.now());
    return result.changes;
  }

  async function close(): Promise<void> {
    db.close();
  }

  return {
    initialize,
    write,
    search,
    read,
    list,
    forget,
    supersede,
    cleanup,
    close,
  };
}
