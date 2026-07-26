import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  admitOwnedSqliteSchema,
  canonicalSqliteSchemaSql,
  openHardenedSqlite,
  type SqliteSchemaObject,
} from "../../../lib/sqlite";
import type {
  MemoryStore,
  RetentionClass,
  SqliteStoreConfig,
  StoreEntry,
  WriteAutoSavedArgs,
} from "./types";
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
    expires_at      INTEGER,
    subject         TEXT,
    predicate       TEXT,
    object          TEXT,
    source_turn_id  TEXT,
    origin          TEXT
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

export const LAYERED_MEMORY_APPLICATION_ID = 0x4c4d454d; // "LMEM"
export const LAYERED_MEMORY_SCHEMA_VERSION = 1;
const EXPECTED_OBJECT_SQL = new Map(
  SCHEMA_STATEMENTS.slice(1).map((sql) => {
    const match = sql.match(/(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+([^\s(]+)/i);
    if (!match?.[1]) throw new Error("layeredMemory store: invalid schema declaration");
    return [match[1], canonicalSqliteSchemaSql(sql)] as const;
  }),
);
const ENTRY_COLUMN_NAMES = new Set([
  "id",
  "label",
  "content",
  "peer_id",
  "trust_level",
  "created_at",
  "superseded_by",
  "retention_class",
  "is_verbatim",
  "provenance_model",
  "confidence",
  "embedding_model",
  "scope",
  "expires_at",
  "subject",
  "predicate",
  "object",
  "source_turn_id",
  "origin",
]);
const LEGACY_OPTIONAL_COLUMNS = new Set([
  "retention_class",
  "is_verbatim",
  "subject",
  "predicate",
  "object",
  "source_turn_id",
  "origin",
]);

interface TableColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const ENTRY_COLUMN_CONTRACT = new Map<
  string,
  { type: "TEXT" | "INTEGER" | "REAL"; notnull: number; defaultValue: string | null; pk: number }
>([
  ["id", { type: "TEXT", notnull: 0, defaultValue: null, pk: 1 }],
  ["label", { type: "TEXT", notnull: 1, defaultValue: null, pk: 0 }],
  ["content", { type: "TEXT", notnull: 1, defaultValue: null, pk: 0 }],
  ["peer_id", { type: "TEXT", notnull: 0, defaultValue: null, pk: 0 }],
  ["trust_level", { type: "TEXT", notnull: 0, defaultValue: null, pk: 0 }],
  ["created_at", { type: "INTEGER", notnull: 1, defaultValue: null, pk: 0 }],
  ["superseded_by", { type: "TEXT", notnull: 0, defaultValue: null, pk: 0 }],
  ["retention_class", { type: "TEXT", notnull: 1, defaultValue: "'operational'", pk: 0 }],
  ["is_verbatim", { type: "INTEGER", notnull: 1, defaultValue: "0", pk: 0 }],
  ["provenance_model", { type: "TEXT", notnull: 0, defaultValue: null, pk: 0 }],
  ["confidence", { type: "REAL", notnull: 0, defaultValue: null, pk: 0 }],
  ["embedding_model", { type: "TEXT", notnull: 0, defaultValue: null, pk: 0 }],
  ["scope", { type: "TEXT", notnull: 1, defaultValue: "'peer'", pk: 0 }],
  ["expires_at", { type: "INTEGER", notnull: 0, defaultValue: null, pk: 0 }],
  ["subject", { type: "TEXT", notnull: 0, defaultValue: null, pk: 0 }],
  ["predicate", { type: "TEXT", notnull: 0, defaultValue: null, pk: 0 }],
  ["object", { type: "TEXT", notnull: 0, defaultValue: null, pk: 0 }],
  ["source_turn_id", { type: "TEXT", notnull: 0, defaultValue: null, pk: 0 }],
  ["origin", { type: "TEXT", notnull: 0, defaultValue: null, pk: 0 }],
]);

function entryColumns(db: Database): TableColumn[] {
  return db.query<TableColumn, []>("PRAGMA table_info(entries)").all();
}

function hasExpectedNonEntryObjects(
  objects: readonly SqliteSchemaObject[],
  legacy: boolean,
): boolean {
  if (!legacy && objects.length !== EXPECTED_OBJECT_SQL.size + 1) return false;
  if (!objects.some((object) => object.name === "entries" && object.type === "table")) {
    return false;
  }
  if (!objects.some((object) => object.name === "event_log" && object.type === "table")) {
    return false;
  }
  return objects.every((object) => {
    if (object.name === "entries") return object.type === "table";
    return EXPECTED_OBJECT_SQL.get(object.name) === canonicalSqliteSchemaSql(object.sql);
  });
}

function columnsHaveExpectedShape(columns: readonly TableColumn[], legacy: boolean): boolean {
  const names = new Set(columns.map((column) => column.name));
  if (names.size !== columns.length) return false;
  if ([...names].some((name) => !ENTRY_COLUMN_NAMES.has(name))) return false;
  if (
    [...ENTRY_COLUMN_NAMES].some(
      (name) => !names.has(name) && (!legacy || !LEGACY_OPTIONAL_COLUMNS.has(name)),
    )
  ) {
    return false;
  }
  return columns.every((column) => {
    const expected = ENTRY_COLUMN_CONTRACT.get(column.name);
    if (!expected || column.type.toUpperCase() !== expected.type || column.pk !== expected.pk) {
      return false;
    }
    if (
      (column.name === "retention_class" || column.name === "is_verbatim") &&
      column.notnull === 0 &&
      column.dflt_value === null
    ) {
      return true;
    }
    return column.notnull === expected.notnull && column.dflt_value === expected.defaultValue;
  });
}

function isRecognizedLayeredMemorySchema(
  db: Database,
  objects: readonly SqliteSchemaObject[],
  legacy: boolean,
): boolean {
  return (
    hasExpectedNonEntryObjects(objects, legacy) &&
    columnsHaveExpectedShape(entryColumns(db), legacy)
  );
}

function migrateLayeredMemorySchema(db: Database): void {
  for (const statement of SCHEMA_STATEMENTS) db.run(statement);
  const colNames = new Set(entryColumns(db).map((column) => column.name));
  const additions: Array<{ name: string; ddl: string }> = [
    { name: "subject", ddl: "ALTER TABLE entries ADD COLUMN subject TEXT" },
    { name: "predicate", ddl: "ALTER TABLE entries ADD COLUMN predicate TEXT" },
    { name: "object", ddl: "ALTER TABLE entries ADD COLUMN object TEXT" },
    { name: "source_turn_id", ddl: "ALTER TABLE entries ADD COLUMN source_turn_id TEXT" },
    { name: "origin", ddl: "ALTER TABLE entries ADD COLUMN origin TEXT" },
    {
      name: "is_verbatim",
      ddl: "ALTER TABLE entries ADD COLUMN is_verbatim INTEGER NOT NULL DEFAULT 0",
    },
    {
      name: "retention_class",
      ddl: "ALTER TABLE entries ADD COLUMN retention_class TEXT NOT NULL DEFAULT 'operational'",
    },
  ];
  for (const { name, ddl } of additions) {
    if (!colNames.has(name)) db.run(ddl);
  }
}

function openLayeredMemoryDatabase(dbPath: string, create = true) {
  return openHardenedSqlite({
    path: dbPath,
    label: "layeredMemory store",
    create,
    prepare(db) {
      admitOwnedSqliteSchema(db, {
        label: "layeredMemory store",
        applicationId: LAYERED_MEMORY_APPLICATION_ID,
        schemaVersion: LAYERED_MEMORY_SCHEMA_VERSION,
        initialize(db) {
          for (const statement of SCHEMA_STATEMENTS) db.run(statement);
        },
        isLegacy(db, objects) {
          return isRecognizedLayeredMemorySchema(db, objects, true);
        },
        migrateLegacy: migrateLayeredMemorySchema,
        validate(db, objects) {
          if (!isRecognizedLayeredMemorySchema(db, objects, false)) {
            throw new Error(
              "layeredMemory store: database schema contains missing, incompatible, or unexpected objects",
            );
          }
        },
      });
    },
  });
}

export function reassignSqliteMemoryPeerId(
  dbPath: string,
  oldPeerId: string,
  newPeerId: string,
): number {
  const database = openLayeredMemoryDatabase(dbPath, false);
  try {
    return database.db
      .prepare("UPDATE entries SET peer_id = ? WHERE peer_id = ?")
      .run(newPeerId, oldPeerId).changes;
  } finally {
    database.close();
  }
}

export function deleteSqliteMemoryForPeer(dbPath: string, peerId: string): number {
  const database = openLayeredMemoryDatabase(dbPath, false);
  try {
    return database.db.prepare("DELETE FROM entries WHERE peer_id = ?").run(peerId).changes;
  } finally {
    database.close();
  }
}

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
  // Phase 2 fact-fields (nullable; populated by writeAutoSavedEntry)
  subject: string | null;
  predicate: string | null;
  object: string | null;
  source_turn_id: string | null;
  origin: string | null;
}

function rowToEntry(row: Row): StoreEntry {
  const entry: StoreEntry = {
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
  // Read path: populate fact-fields only when present in storage. Legacy
  // rows (pre-Phase-2) carry NULLs and stay clean on the way out.
  if (row.subject != null) entry.subject = row.subject;
  if (row.predicate != null) entry.predicate = row.predicate;
  if (row.object != null) entry.object = row.object;
  if (row.source_turn_id != null) entry.sourceTurnId = row.source_turn_id;
  if (row.origin != null) entry.origin = row.origin as StoreEntry["origin"];
  return entry;
}

// Sampled cleanup: every ~Nth write triggers a bounded DELETE so write
// latency doesn't depend on stale-data backlog. Capped via LIMIT so even
// a huge backlog drains in roughly constant time per write.
const CLEANUP_SAMPLE_RATE = 50;
const CLEANUP_BATCH_SIZE = 100;

export function createSqliteStore(config: SqliteStoreConfig): MemoryStore {
  const database = openLayeredMemoryDatabase(config.dbPath);
  const db = database.db;
  const namespace = config.namespace?.trim();
  const prefix = namespace ? (namespace.endsWith(":") ? namespace : `${namespace}:`) : null;
  const prefixPattern = prefix ? `${prefix.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;

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
    if (prefix && !input.label.startsWith(prefix)) {
      throw new Error(`layeredMemory: label must start with namespace prefix "${prefix}"`);
    }
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
      db.transaction(() => {
        const result = cleanupStmt.run(Date.now(), CLEANUP_BATCH_SIZE);
        if (result.changes > 0) {
          logEvent("(batch)", "expire-sweep", null, { swept: result.changes });
        }
      })();
    }

    return { ...input, id, expiresAt };
  }

  async function search(query: string, peerId?: string, limit = 10): Promise<StoreEntry[]> {
    const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
    const pattern = `%${escaped}%`;
    const now = Date.now();

    if (peerId && prefixPattern) {
      const rows = db
        .prepare<Row, [string, string, string, number, number]>(
          `SELECT * FROM entries
           WHERE peer_id = ?
             AND label LIKE ? ESCAPE '\\'
             AND content LIKE ? ESCAPE '\\'
             AND superseded_by IS NULL
             AND (expires_at IS NULL OR expires_at >= ?)
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(peerId, prefixPattern, pattern, now, limit);
      return rows.map(rowToEntry);
    }

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

    if (prefixPattern) {
      const rows = db
        .prepare<Row, [string, string, number, number]>(
          `SELECT * FROM entries
           WHERE label LIKE ? ESCAPE '\\'
             AND content LIKE ? ESCAPE '\\'
             AND superseded_by IS NULL
             AND (expires_at IS NULL OR expires_at >= ?)
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(prefixPattern, pattern, now, limit);
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
    if (prefix && !label.startsWith(prefix)) return null;
    const row = db
      .prepare<Row, [string]>(
        "SELECT * FROM entries WHERE label = ? AND superseded_by IS NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get(label);
    return row ? rowToEntry(row) : null;
  }

  async function list(peerId?: string): Promise<string[]> {
    if (peerId && prefixPattern) {
      const rows = db
        .prepare<{ label: string }, [string, string]>(
          "SELECT DISTINCT label FROM entries WHERE peer_id = ? AND label LIKE ? ESCAPE '\\' AND superseded_by IS NULL ORDER BY label",
        )
        .all(peerId, prefixPattern);
      return rows.map((r) => r.label);
    }
    if (peerId) {
      const rows = db
        .prepare<{ label: string }, [string]>(
          "SELECT DISTINCT label FROM entries WHERE peer_id = ? AND superseded_by IS NULL ORDER BY label",
        )
        .all(peerId);
      return rows.map((r) => r.label);
    }
    if (prefixPattern) {
      const rows = db
        .prepare<{ label: string }, [string]>(
          "SELECT DISTINCT label FROM entries WHERE label LIKE ? ESCAPE '\\' AND superseded_by IS NULL ORDER BY label",
        )
        .all(prefixPattern);
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
    return db.transaction(() => {
      const result = prefixPattern
        ? db
            .prepare("DELETE FROM entries WHERE peer_id = ? AND label LIKE ? ESCAPE '\\'")
            .run(peerId, prefixPattern)
        : db.prepare("DELETE FROM entries WHERE peer_id = ?").run(peerId);
      logEvent("(batch)", "forget", peerId, { deleted: result.changes });
      return result.changes;
    })();
  }

  async function supersede(entryId: string, newEntryId: string): Promise<void> {
    db.transaction(() => {
      if (prefixPattern) {
        db.prepare(
          "UPDATE entries SET superseded_by = ? WHERE id = ? AND label LIKE ? ESCAPE '\\'",
        ).run(newEntryId, entryId, prefixPattern);
      } else {
        db.prepare("UPDATE entries SET superseded_by = ? WHERE id = ?").run(newEntryId, entryId);
      }
      logEvent(entryId, "supersede", null, { supersededBy: newEntryId });
    })();
  }

  async function cleanup(): Promise<number> {
    const result = prefixPattern
      ? db
          .prepare(
            "DELETE FROM entries WHERE expires_at IS NOT NULL AND expires_at < ? AND label LIKE ? ESCAPE '\\'",
          )
          .run(Date.now(), prefixPattern)
      : db
          .prepare("DELETE FROM entries WHERE expires_at IS NOT NULL AND expires_at < ?")
          .run(Date.now());
    return result.changes;
  }

  // Internal-to-layered-memory write path used by the extractor. NOT
  // exposed on any augment-public surface — Phase 2 of ADR-018,
  // Decision 4 of the memorist design. `origin` is hardcoded to
  // `"agent-derived"` here rather than accepted as an argument so a
  // misbehaving extraction prompt cannot forge `operator` or
  // `peer-derived`. Namespace prefix is enforced when configured;
  // when absent, this function refuses entirely (the augment factory
  // must always pass a namespace).
  async function writeAutoSavedEntry(args: WriteAutoSavedArgs): Promise<void> {
    if (!prefix) {
      throw new Error(
        "writeAutoSavedEntry: store has no namespace configured; auto-save requires namespace-prefix discipline",
      );
    }
    if (!args.label.startsWith(prefix)) {
      throw new Error(
        `writeAutoSavedEntry: label "${args.label}" does not start with namespace prefix "${prefix}"`,
      );
    }
    const id = randomUUID();
    const createdAt = Date.now();
    const expiresAt = createdAt + retentionMs;
    db.transaction(() => {
      db.prepare(
        `INSERT INTO entries
        (id, label, content, peer_id, trust_level, created_at, superseded_by,
         retention_class, is_verbatim, expires_at,
         subject, predicate, object, source_turn_id, origin,
         provenance_model, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent-derived', ?, ?)`,
      ).run(
        id,
        args.label,
        args.content,
        args.peerId,
        null,
        createdAt,
        null,
        args.retentionClass,
        args.isVerbatim ? 1 : 0,
        expiresAt,
        args.subject ?? null,
        args.predicate ?? null,
        args.object ?? null,
        args.sourceTurnId,
        args.model,
        args.confidence,
      );
      logEvent(id, "auto-save", args.peerId, {
        sourceTurnId: args.sourceTurnId,
        model: args.model,
        confidence: args.confidence,
      });
    })();
  }

  async function listEntriesByPeer(
    opts: { peerId?: string; limit?: number } = {},
  ): Promise<StoreEntry[]> {
    const limit = opts.limit ?? 50;
    const now = Date.now();
    if (opts.peerId) {
      const rows = db
        .prepare<Row, [string, number, number]>(
          `SELECT * FROM entries
           WHERE peer_id = ?
             AND superseded_by IS NULL
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(opts.peerId, now, limit);
      return rows.map(rowToEntry);
    }
    const rows = db
      .prepare<Row, [number, number]>(
        `SELECT * FROM entries
         WHERE superseded_by IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(now, limit);
    return rows.map(rowToEntry);
  }

  async function countByRetentionClass(): Promise<{
    operational: number;
    lesson: number;
    total: number;
  }> {
    const rows = db
      .prepare<{ retention_class: string; n: number }, [number]>(
        `SELECT retention_class, COUNT(*) AS n
         FROM entries
         WHERE superseded_by IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
         GROUP BY retention_class`,
      )
      .all(Date.now());
    let operational = 0;
    let lesson = 0;
    for (const r of rows) {
      if (r.retention_class === "operational") operational = r.n;
      if (r.retention_class === "lesson") lesson = r.n;
    }
    return { operational, lesson, total: operational + lesson };
  }

  async function close(): Promise<void> {
    database.close();
  }

  return {
    initialize,
    write,
    writeAutoSavedEntry,
    search,
    read,
    list,
    forget,
    supersede,
    cleanup,
    listEntriesByPeer,
    countByRetentionClass,
    close,
  };
}
