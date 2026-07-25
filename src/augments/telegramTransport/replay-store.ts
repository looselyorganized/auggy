import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  admitOwnedSqliteSchema,
  canonicalSqliteSchemaSql,
  openHardenedSqlite,
  type SqliteSchemaObject,
} from "../../lib/sqlite";
import type { TelegramReplayClaim, TelegramReplayConflict } from "../../types";

export type { TelegramReplayClaim, TelegramReplayConflict } from "../../types";

export class InvalidTelegramUpdateError extends Error {
  constructor() {
    super("Invalid Telegram update.");
    this.name = "InvalidTelegramUpdateError";
  }
}

export class TelegramReplayConflictError extends Error {
  readonly conflict: TelegramReplayConflict;

  constructor(conflict: TelegramReplayConflict) {
    super("Telegram update replay conflict.");
    this.name = "TelegramReplayConflictError";
    this.conflict = Object.freeze({ ...conflict });
  }
}

export interface TelegramReplayStore {
  claim(namespace: string, updateId: number, payloadHash: string): TelegramReplayClaim;
  getConflict(namespace: string): TelegramReplayConflict | null;
  resolveConflict(namespace: string, conflictId: string): boolean;
  close?(): void;
}

export interface SqliteTelegramReplayStoreOptions {
  dbPath: string;
  retentionMs?: number;
  maxEntries?: number;
  now?: () => number;
  randomUUID?: () => string;
}

const CLAIM_SCHEMA = [
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
const CONFLICT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS telegram_replay_conflicts (
    namespace TEXT NOT NULL PRIMARY KEY,
    conflict_id TEXT NOT NULL UNIQUE,
    update_id INTEGER NOT NULL,
    canonical_hash TEXT NOT NULL,
    conflicting_hash TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    FOREIGN KEY (namespace, update_id)
      REFERENCES telegram_update_claims(namespace, update_id)
      ON DELETE RESTRICT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_telegram_conflicts_time
     ON telegram_replay_conflicts(detected_at)`,
  `CREATE TABLE IF NOT EXISTS telegram_replay_discards (
    namespace TEXT NOT NULL,
    update_id INTEGER NOT NULL,
    payload_hash TEXT NOT NULL,
    resolved_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, update_id, payload_hash),
    FOREIGN KEY (namespace, update_id)
      REFERENCES telegram_update_claims(namespace, update_id)
      ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_telegram_discards_time
     ON telegram_replay_discards(resolved_at)`,
];
const SCHEMA = [...CLAIM_SCHEMA, ...CONFLICT_SCHEMA];
const APPLICATION_ID = 0x54475250;
const SCHEMA_VERSION = 2;

function expectedSchema(statements: readonly string[]): Map<string, string> {
  return new Map(
    statements.map((sql) => {
      const match = sql.match(/(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+([^\s(]+)/i);
      if (!match?.[1]) throw new Error("telegram replay store: invalid schema declaration");
      return [match[1], canonicalSqliteSchemaSql(sql)] as const;
    }),
  );
}

const EXPECTED_SCHEMA = expectedSchema(SCHEMA);
const V1_EXPECTED_SCHEMA = expectedSchema(CLAIM_SCHEMA);

function hasExactSchema(
  objects: readonly SqliteSchemaObject[],
  expected: ReadonlyMap<string, string>,
): boolean {
  return (
    objects.length === expected.size &&
    objects.every((object) => expected.get(object.name) === canonicalSqliteSchemaSql(object.sql))
  );
}

function validateSchema(objects: readonly SqliteSchemaObject[]): void {
  if (!hasExactSchema(objects, EXPECTED_SCHEMA)) {
    throw new Error("telegram replay store: incompatible or unexpected database schema");
  }
}

function addConflictSchema(db: import("bun:sqlite").Database): void {
  for (const sql of CONFLICT_SCHEMA) db.run(sql);
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
  const mintConflictId = options.randomUUID ?? randomUUID;

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
          return hasExactSchema(objects, V1_EXPECTED_SCHEMA);
        },
        migrateLegacy(target) {
          addConflictSchema(target);
        },
        migrateOwned(target, fromVersion, objects) {
          if (fromVersion !== 1 || !hasExactSchema(objects, V1_EXPECTED_SCHEMA)) {
            throw new Error(
              `telegram replay store: unsupported schema migration from version ${fromVersion}`,
            );
          }
          addConflictSchema(target);
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
  const selectConflict = db.query<
    {
      conflict_id: string;
      update_id: number;
      canonical_hash: string;
      conflicting_hash: string;
      detected_at: number;
    },
    [string]
  >(
    `SELECT conflict_id, update_id, canonical_hash, conflicting_hash, detected_at
       FROM telegram_replay_conflicts WHERE namespace = ?`,
  );
  const insertConflict = db.query(
    `INSERT INTO telegram_replay_conflicts
       (namespace, conflict_id, update_id, canonical_hash, conflicting_hash, detected_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const selectDiscard = db.query<{ present: number }, [string, number, string]>(
    `SELECT 1 AS present FROM telegram_replay_discards
      WHERE namespace = ? AND update_id = ? AND payload_hash = ?`,
  );
  const insertDiscard = db.query(
    `INSERT OR IGNORE INTO telegram_replay_discards
       (namespace, update_id, payload_hash, resolved_at)
     VALUES (?, ?, ?, ?)`,
  );
  const deleteConflict = db.query(
    `DELETE FROM telegram_replay_conflicts
      WHERE namespace = ? AND conflict_id = ?`,
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
      if (!Number.isSafeInteger(claimedAt) || claimedAt < 0) {
        throw new Error("telegram replay store clock returned an invalid timestamp");
      }
      if (selectConflict.get(namespace)) return "quarantined";
      purgeTime.run(namespace, claimedAt - retentionMs);
      if (selectDiscard.get(namespace, updateId, payloadHash)) return "discarded";
      const inserted = insert.run(namespace, updateId, payloadHash, claimedAt);
      if (inserted.changes === 0) {
        const existing = select.get(namespace, updateId);
        if (existing?.payload_hash === payloadHash) return "duplicate";
        if (!existing) {
          throw new Error("telegram replay store lost a canonical claim during conflict detection");
        }
        const conflictId = mintConflictId();
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(conflictId)) {
          throw new Error("telegram replay store generated an invalid conflict id");
        }
        insertConflict.run(
          namespace,
          conflictId,
          updateId,
          existing.payload_hash,
          payloadHash,
          claimedAt,
        );
        return "conflict";
      }
      const rows = count.get(namespace)?.count ?? 0;
      if (rows > maxEntries) purgeExcess.run(namespace, updateId, rows - maxEntries);
      return "claimed";
    },
  );
  const resolveTransaction = db.transaction((namespace: string, conflictId: string): boolean => {
    const conflict = selectConflict.get(namespace);
    if (!conflict || conflict.conflict_id !== conflictId) return false;
    const resolvedAt = now();
    if (!Number.isSafeInteger(resolvedAt) || resolvedAt < 0) {
      throw new Error("telegram replay store clock returned an invalid timestamp");
    }
    insertDiscard.run(namespace, conflict.update_id, conflict.conflicting_hash, resolvedAt);
    return deleteConflict.run(namespace, conflictId).changes === 1;
  });

  return {
    claim(namespace, updateId, payloadHash) {
      validateClaim(namespace, updateId, payloadHash);
      return claimTransaction.immediate(namespace, updateId, payloadHash);
    },
    getConflict(namespace) {
      validateNamespace(namespace);
      const row = selectConflict.get(namespace);
      if (!row) return null;
      return Object.freeze({
        id: row.conflict_id,
        updateId: row.update_id,
        detectedAt: row.detected_at,
      });
    },
    resolveConflict(namespace, conflictId) {
      validateNamespace(namespace);
      validateConflictId(conflictId);
      return resolveTransaction.immediate(namespace, conflictId);
    },
    close() {
      database.close();
    },
  };
}

export function createInMemoryTelegramReplayStore(): TelegramReplayStore {
  const claims = new Map<string, string>();
  const conflicts = new Map<
    string,
    TelegramReplayConflict & { canonicalHash: string; conflictingHash: string }
  >();
  const discards = new Set<string>();
  return {
    claim(namespace, updateId, payloadHash) {
      validateClaim(namespace, updateId, payloadHash);
      const key = `${namespace}\0${updateId}`;
      if (conflicts.has(namespace)) return "quarantined";
      if (discards.has(`${key}\0${payloadHash}`)) return "discarded";
      const existing = claims.get(key);
      if (existing === undefined) {
        claims.set(key, payloadHash);
        return "claimed";
      }
      if (existing === payloadHash) return "duplicate";
      conflicts.set(namespace, {
        id: randomUUID(),
        updateId,
        detectedAt: Date.now(),
        canonicalHash: existing,
        conflictingHash: payloadHash,
      });
      return "conflict";
    },
    getConflict(namespace) {
      validateNamespace(namespace);
      const conflict = conflicts.get(namespace);
      if (!conflict) return null;
      return Object.freeze({
        id: conflict.id,
        updateId: conflict.updateId,
        detectedAt: conflict.detectedAt,
      });
    },
    resolveConflict(namespace, conflictId) {
      validateNamespace(namespace);
      validateConflictId(conflictId);
      const conflict = conflicts.get(namespace);
      if (!conflict || conflict.id !== conflictId) return false;
      discards.add(`${namespace}\0${conflict.updateId}\0${conflict.conflictingHash}`);
      conflicts.delete(namespace);
      return true;
    },
    close() {
      claims.clear();
      conflicts.clear();
      discards.clear();
    },
  };
}

function validateNamespace(namespace: string): void {
  if (!namespace || namespace.length > 256) {
    throw new TypeError("telegram replay namespace must contain 1 to 256 characters");
  }
}

function validateConflictId(conflictId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(conflictId)) {
    throw new TypeError("telegram replay conflict id must contain 1 to 128 safe characters");
  }
}

function validateClaim(namespace: string, updateId: number, payloadHash: string): void {
  validateNamespace(namespace);
  if (!Number.isSafeInteger(updateId) || updateId < 0) {
    throw new TypeError("telegram update_id must be a non-negative safe integer");
  }
  if (!/^[a-f0-9]{64}$/.test(payloadHash)) {
    throw new TypeError("telegram replay payload hash must be lowercase SHA-256");
  }
}
