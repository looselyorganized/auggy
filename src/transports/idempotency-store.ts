import { createHash, randomUUID } from "node:crypto";
import {
  admitOwnedSqliteSchema,
  canonicalSqliteSchemaSql,
  openHardenedSqlite,
  type SqliteSchemaObject,
} from "../lib/sqlite";

const APPLICATION_ID = 0x41554944; // "AUID"
const SCHEMA_VERSION = 1;
const DEFAULT_MAX_RECORDS = 50_000;
const DEFAULT_MAX_REPLAY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_STORED_BYTES = 256 * 1024 * 1024;
const DEFAULT_STALE_AFTER_MS = 30_000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS web_idempotency (
    key_hash       TEXT PRIMARY KEY,
    binding_hash   TEXT NOT NULL,
    capacity_class TEXT NOT NULL CHECK (capacity_class IN ('public', 'agent', 'creator')),
    partition_hash TEXT NOT NULL,
    turn_id        TEXT NOT NULL,
    owner_token    TEXT NOT NULL,
    state          TEXT NOT NULL CHECK (state IN ('running', 'complete', 'unknown')),
    response_body  TEXT,
    response_bytes INTEGER,
    created_at     INTEGER NOT NULL,
    heartbeat_at   INTEGER NOT NULL,
    completed_at   INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_web_idempotency_state
     ON web_idempotency(state, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_web_idempotency_capacity
     ON web_idempotency(capacity_class, partition_hash)`,
];

const EXPECTED_SCHEMA = new Map(
  SCHEMA_STATEMENTS.map((sql) => {
    const match = sql.match(/(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+([^\s(]+)/i);
    if (!match?.[1]) throw new Error("web idempotency store: invalid schema declaration");
    return [match[1], canonicalSqliteSchemaSql(sql)] as const;
  }),
);

function hasExactSchema(objects: readonly SqliteSchemaObject[]): boolean {
  return (
    objects.length === EXPECTED_SCHEMA.size &&
    objects.every(
      (object) => EXPECTED_SCHEMA.get(object.name) === canonicalSqliteSchemaSql(object.sql),
    )
  );
}

function validateSchema(objects: readonly SqliteSchemaObject[]): void {
  if (!hasExactSchema(objects)) {
    throw new Error(
      "web idempotency store: database schema contains missing, incompatible, or unexpected objects",
    );
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`web idempotency store: ${label} must be a positive integer`);
  }
  return resolved;
}

export type IdempotencyClaim =
  | { status: "leader"; turnId: string; ownerToken: string }
  | { status: "running"; turnId: string }
  | { status: "replay"; turnId: string; responseBody: string }
  | { status: "conflict" }
  | { status: "unknown" }
  | { status: "capacity" };

export interface WebIdempotencyStore {
  claim(
    keyHash: string,
    bindingHash: string,
    capacity?: { class: "public" | "agent" | "creator"; partitionHash: string },
  ): IdempotencyClaim;
  read(keyHash: string, bindingHash: string): IdempotencyClaim;
  heartbeat(keyHash: string, ownerToken: string): boolean;
  complete(keyHash: string, ownerToken: string, responseBody: string): "complete" | "unknown";
  markUnknown(keyHash: string, ownerToken: string): void;
  close(): void;
}

interface StoredRow {
  binding_hash: string;
  turn_id: string;
  state: "running" | "complete" | "unknown";
  response_body: string | null;
  heartbeat_at: number;
}

export function hashIdempotencyKey(audience: string, key: string): string {
  return createHash("sha256")
    .update("auggy-web-idempotency-key-v1\0")
    .update(audience)
    .update("\0")
    .update(key)
    .digest("hex");
}

export function hashIdempotencyBinding(value: unknown): string {
  return createHash("sha256")
    .update("auggy-web-idempotency-binding-v1\0")
    .update(stableJson(value))
    .digest("hex");
}

function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("web idempotency binding contains an unsupported value");
}

export function createWebIdempotencyStore(config: {
  dbPath: string;
  maxRecords?: number;
  maxReplayBytes?: number;
  maxStoredBytes?: number;
  maxRecordsPerPartition?: number;
  maxPublicRecords?: number;
  maxAgentRecords?: number;
  maxCreatorRecords?: number;
  staleAfterMs?: number;
  retentionMs?: number;
  now?: () => number;
}): WebIdempotencyStore {
  const maxRecords = positiveInteger(config.maxRecords, DEFAULT_MAX_RECORDS, "maxRecords");
  if (maxRecords < 3) {
    throw new Error(
      "web idempotency store: maxRecords must be at least 3 to reserve capacity for every trust class",
    );
  }
  const maxReplayBytes = positiveInteger(
    config.maxReplayBytes,
    DEFAULT_MAX_REPLAY_BYTES,
    "maxReplayBytes",
  );
  const staleAfterMs = positiveInteger(config.staleAfterMs, DEFAULT_STALE_AFTER_MS, "staleAfterMs");
  const maxStoredBytes = positiveInteger(
    config.maxStoredBytes,
    DEFAULT_MAX_STORED_BYTES,
    "maxStoredBytes",
  );
  if (maxStoredBytes < maxReplayBytes) {
    throw new Error(
      "web idempotency store: maxStoredBytes must be greater than or equal to maxReplayBytes",
    );
  }
  const retentionMs = positiveInteger(config.retentionMs, DEFAULT_RETENTION_MS, "retentionMs");
  const maxRecordsPerPartition = positiveInteger(
    config.maxRecordsPerPartition,
    Math.min(maxRecords, 10_000),
    "maxRecordsPerPartition",
  );
  const defaultPublicRecords = Math.max(1, Math.floor(maxRecords * 0.5));
  const defaultAgentRecords = Math.max(1, Math.floor(maxRecords * 0.3));
  const defaultCreatorRecords = maxRecords - defaultPublicRecords - defaultAgentRecords;
  const classLimits = {
    public: positiveInteger(config.maxPublicRecords, defaultPublicRecords, "maxPublicRecords"),
    agent: positiveInteger(config.maxAgentRecords, defaultAgentRecords, "maxAgentRecords"),
    creator: positiveInteger(config.maxCreatorRecords, defaultCreatorRecords, "maxCreatorRecords"),
  };
  if (classLimits.public + classLimits.agent + classLimits.creator > maxRecords) {
    throw new Error(
      "web idempotency store: trust-class record limits must sum to no more than maxRecords",
    );
  }
  const now = config.now ?? Date.now;
  const database = openHardenedSqlite({
    path: config.dbPath,
    label: "web idempotency store",
    prepare(db) {
      admitOwnedSqliteSchema(db, {
        label: "web idempotency store",
        applicationId: APPLICATION_ID,
        schemaVersion: SCHEMA_VERSION,
        initialize(target) {
          for (const statement of SCHEMA_STATEMENTS) target.run(statement);
        },
        isLegacy(_target, objects) {
          return hasExactSchema(objects);
        },
        validate(_target, objects) {
          validateSchema(objects);
        },
      });
    },
  });
  const db = database.db;
  const select = db.prepare<StoredRow, [string]>(
    `SELECT binding_hash, turn_id, state, response_body, heartbeat_at
       FROM web_idempotency WHERE key_hash = ?`,
  );
  const count = db.prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM web_idempotency");
  const countClass = db.prepare<{ count: number }, [string]>(
    "SELECT COUNT(*) AS count FROM web_idempotency WHERE capacity_class = ?",
  );
  const countPartition = db.prepare<{ count: number }, [string, string]>(
    `SELECT COUNT(*) AS count FROM web_idempotency
     WHERE capacity_class = ? AND partition_hash = ?`,
  );
  const storedBytes = db.prepare<{ total: number }, []>(
    "SELECT COALESCE(SUM(response_bytes), 0) AS total FROM web_idempotency",
  );
  const insert = db.prepare(
    `INSERT INTO web_idempotency
       (key_hash, binding_hash, capacity_class, partition_hash,
        turn_id, owner_token, state, created_at, heartbeat_at)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
  );
  const heartbeat = db.prepare(
    `UPDATE web_idempotency SET heartbeat_at = ?
     WHERE key_hash = ? AND owner_token = ? AND state = 'running'`,
  );
  const complete = db.prepare(
    `UPDATE web_idempotency
       SET state = 'complete', response_body = ?, response_bytes = ?,
           completed_at = ?
     WHERE key_hash = ? AND owner_token = ? AND state = 'running'`,
  );
  const unknown = db.prepare(
    `UPDATE web_idempotency
       SET state = 'unknown', response_body = NULL, response_bytes = NULL,
           completed_at = ?
     WHERE key_hash = ? AND owner_token = ? AND state = 'running'`,
  );
  const staleUnknown = db.prepare(
    `UPDATE web_idempotency
       SET state = 'unknown', response_body = NULL, response_bytes = NULL,
           completed_at = ?
     WHERE key_hash = ? AND state = 'running' AND heartbeat_at < ?`,
  );
  const expireReplayBodies = db.prepare(
    `UPDATE web_idempotency
     SET state = 'unknown', response_body = NULL, response_bytes = NULL
     WHERE state = 'complete' AND completed_at IS NOT NULL AND completed_at < ?`,
  );

  function fromStored(
    keyHash: string,
    row: StoredRow | null,
    bindingHash: string,
  ): IdempotencyClaim | null {
    if (!row) return null;
    if (row.binding_hash !== bindingHash) return { status: "conflict" };
    if (row.state === "running") {
      const cutoff = now() - staleAfterMs;
      if (row.heartbeat_at < cutoff) {
        const result = staleUnknown.run(now(), keyHash, cutoff);
        if (result.changes === 1) return { status: "unknown" };
        return fromStored(keyHash, select.get(keyHash), bindingHash);
      }
      return { status: "running", turnId: row.turn_id };
    }
    if (row.state === "unknown") return { status: "unknown" };
    if (typeof row.response_body !== "string") return { status: "unknown" };
    return { status: "replay", turnId: row.turn_id, responseBody: row.response_body };
  }

  return {
    claim(keyHash, bindingHash, capacity) {
      const resolvedCapacity = capacity ?? {
        class: "creator",
        partitionHash: createHash("sha256")
          .update("auggy-web-idempotency-default-partition-v1")
          .digest("hex"),
      };
      if (!/^[0-9a-f]{64}$/.test(resolvedCapacity.partitionHash)) {
        throw new Error("web idempotency store: partitionHash must be a SHA-256 hex digest");
      }
      db.run("BEGIN IMMEDIATE");
      try {
        expireReplayBodies.run(now() - retentionMs);
        const existing = fromStored(keyHash, select.get(keyHash), bindingHash);
        if (existing) {
          db.run("COMMIT");
          return existing;
        }
        const rowCount = count.get()?.count;
        const classCount = countClass.get(resolvedCapacity.class)?.count;
        const partitionCount = countPartition.get(
          resolvedCapacity.class,
          resolvedCapacity.partitionHash,
        )?.count;
        if (
          !Number.isSafeInteger(rowCount) ||
          !Number.isSafeInteger(classCount) ||
          !Number.isSafeInteger(partitionCount) ||
          (rowCount ?? maxRecords) >= maxRecords ||
          (classCount ?? classLimits[resolvedCapacity.class]) >=
            classLimits[resolvedCapacity.class] ||
          (partitionCount ?? maxRecordsPerPartition) >= maxRecordsPerPartition
        ) {
          db.run("COMMIT");
          return { status: "capacity" };
        }
        const turnId = randomUUID();
        const ownerToken = randomUUID();
        const claimedAt = now();
        insert.run(
          keyHash,
          bindingHash,
          resolvedCapacity.class,
          resolvedCapacity.partitionHash,
          turnId,
          ownerToken,
          claimedAt,
          claimedAt,
        );
        db.run("COMMIT");
        return { status: "leader", turnId, ownerToken };
      } catch (error) {
        if (db.inTransaction) db.run("ROLLBACK");
        throw error;
      }
    },

    read(keyHash, bindingHash) {
      return fromStored(keyHash, select.get(keyHash), bindingHash) ?? { status: "unknown" };
    },

    heartbeat(keyHash, ownerToken) {
      return heartbeat.run(now(), keyHash, ownerToken).changes === 1;
    },

    complete(keyHash, ownerToken, responseBody) {
      const responseBytes = Buffer.byteLength(responseBody, "utf8");
      if (responseBytes > maxReplayBytes) {
        unknown.run(now(), keyHash, ownerToken);
        return "unknown";
      }
      db.run("BEGIN IMMEDIATE");
      try {
        expireReplayBodies.run(now() - retentionMs);
        const aggregateBytes = storedBytes.get()?.total;
        if (
          !Number.isSafeInteger(aggregateBytes) ||
          (aggregateBytes ?? maxStoredBytes) + responseBytes > maxStoredBytes
        ) {
          unknown.run(now(), keyHash, ownerToken);
          db.run("COMMIT");
          return "unknown";
        }
        const result = complete.run(responseBody, responseBytes, now(), keyHash, ownerToken);
        db.run("COMMIT");
        return result.changes === 1 ? "complete" : "unknown";
      } catch (error) {
        if (db.inTransaction) db.run("ROLLBACK");
        throw error;
      }
    },

    markUnknown(keyHash, ownerToken) {
      unknown.run(now(), keyHash, ownerToken);
    },

    close() {
      database.close();
    },
  };
}
