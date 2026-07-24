import { resolve } from "node:path";
import {
  admitOwnedSqliteSchema,
  canonicalSqliteSchemaSql,
  openHardenedSqlite,
  type SqliteSchemaObject,
} from "../../lib/sqlite";

export type TelegramReplayClaim = "claimed" | "duplicate" | "conflict";

export class InvalidTelegramUpdateError extends Error {
  constructor() {
    super("Invalid Telegram update.");
    this.name = "InvalidTelegramUpdateError";
  }
}

export class TelegramReplayConflictError extends Error {
  constructor() {
    super("Telegram update replay conflict.");
    this.name = "TelegramReplayConflictError";
  }
}

export interface TelegramReplayStore {
  claim(namespace: string, updateId: number, payloadHash: string): TelegramReplayClaim;
  close?(): void;
}

export interface SqliteTelegramReplayStoreOptions {
  dbPath: string;
  retentionMs?: number;
  maxEntries?: number;
  now?: () => number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS telegram_update_claims (
    namespace TEXT NOT NULL,
    update_id INTEGER NOT NULL,
    payload_hash TEXT NOT NULL,
    claimed_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, update_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_telegram_claims_time
     ON telegram_update_claims(claimed_at)`,
];
const APPLICATION_ID = 0x54475250;
const SCHEMA_VERSION = 1;
const EXPECTED_SCHEMA = new Map(
  SCHEMA.map((sql) => {
    const match = sql.match(/(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+([^\s(]+)/i);
    if (!match?.[1]) throw new Error("telegram replay store: invalid schema declaration");
    return [match[1], canonicalSqliteSchemaSql(sql)] as const;
  }),
);

function validateSchema(objects: readonly SqliteSchemaObject[]): void {
  if (
    objects.length !== EXPECTED_SCHEMA.size ||
    objects.some(
      (object) => EXPECTED_SCHEMA.get(object.name) !== canonicalSqliteSchemaSql(object.sql),
    )
  ) {
    throw new Error("telegram replay store: incompatible or unexpected database schema");
  }
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`telegram replay ${name} must be a positive integer`);
  }
}

export function createSqliteTelegramReplayStore(
  options: SqliteTelegramReplayStoreOptions,
): TelegramReplayStore {
  const retentionMs = options.retentionMs ?? 30 * 24 * 60 * 60 * 1000;
  const maxEntries = options.maxEntries ?? 1_000_000;
  positiveInteger("retentionMs", retentionMs);
  positiveInteger("maxEntries", maxEntries);
  const now = options.now ?? Date.now;

  const database = openHardenedSqlite({
    path: options.dbPath === ":memory:" ? ":memory:" : resolve(options.dbPath),
    label: "telegram replay store",
    synchronous: "FULL",
    prepare(db) {
      admitOwnedSqliteSchema(db, {
        label: "telegram replay store",
        applicationId: APPLICATION_ID,
        schemaVersion: SCHEMA_VERSION,
        initialize(database) {
          for (const sql of SCHEMA) database.run(sql);
        },
        validate(_database, objects) {
          validateSchema(objects);
        },
        isLegacy(_database, objects) {
          return (
            objects.length === EXPECTED_SCHEMA.size &&
            objects.every(
              (object) => EXPECTED_SCHEMA.get(object.name) === canonicalSqliteSchemaSql(object.sql),
            )
          );
        },
      });
    },
  });
  const db = database.db;
  const insert = db.query(
    `INSERT OR IGNORE INTO telegram_update_claims
       (namespace, update_id, payload_hash, claimed_at)
     VALUES (?, ?, ?, ?)`,
  );
  const select = db.query<{ payload_hash: string }, [string, number]>(
    `SELECT payload_hash FROM telegram_update_claims
     WHERE namespace = ? AND update_id = ?`,
  );
  const purgeTime = db.query(
    `DELETE FROM telegram_update_claims
     WHERE rowid IN (
       SELECT rowid FROM telegram_update_claims
       WHERE namespace = ? AND claimed_at < ?
       ORDER BY claimed_at ASC
       LIMIT 1000
     )`,
  );
  const count = db.query<{ count: number }, [string]>(
    `SELECT COUNT(*) AS count FROM telegram_update_claims WHERE namespace = ?`,
  );
  const purgeExcess = db.query(
    `DELETE FROM telegram_update_claims
     WHERE rowid IN (
       SELECT rowid FROM telegram_update_claims
       WHERE namespace = ? AND update_id <> ?
       ORDER BY claimed_at ASC, namespace ASC, update_id ASC
       LIMIT ?
     )`,
  );
  const claimTransaction = db.transaction(
    (namespace: string, updateId: number, payloadHash: string): TelegramReplayClaim => {
      const claimedAt = now();
      purgeTime.run(namespace, claimedAt - retentionMs);
      const inserted = insert.run(namespace, updateId, payloadHash, claimedAt);
      if (inserted.changes === 0) {
        const existing = select.get(namespace, updateId);
        return existing?.payload_hash === payloadHash ? "duplicate" : "conflict";
      }
      const rows = count.get(namespace)?.count ?? 0;
      if (rows > maxEntries) purgeExcess.run(namespace, updateId, rows - maxEntries);
      return "claimed";
    },
  );

  return {
    claim(namespace, updateId, payloadHash) {
      if (!namespace || namespace.length > 256) {
        throw new TypeError("telegram replay namespace must contain 1 to 256 characters");
      }
      if (!Number.isSafeInteger(updateId) || updateId < 0) {
        throw new TypeError("telegram update_id must be a non-negative safe integer");
      }
      if (!/^[a-f0-9]{64}$/.test(payloadHash)) {
        throw new TypeError("telegram replay payload hash must be lowercase SHA-256");
      }
      return claimTransaction.immediate(namespace, updateId, payloadHash);
    },
    close() {
      database.close();
    },
  };
}

export function createInMemoryTelegramReplayStore(): TelegramReplayStore {
  const claims = new Map<string, string>();
  return {
    claim(namespace, updateId, payloadHash) {
      const key = `${namespace}\0${updateId}`;
      const existing = claims.get(key);
      if (existing === undefined) {
        claims.set(key, payloadHash);
        return "claimed";
      }
      return existing === payloadHash ? "duplicate" : "conflict";
    },
    close() {
      claims.clear();
    },
  };
}
