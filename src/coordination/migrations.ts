/**
 * These statements are deliberately not run by the runtime. Operators invoke
 * migratePostgresCoordinator during provisioning or a controlled deployment.
 */
const INITIAL_COORDINATION_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS auggy_coordination_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS auggy_coordination_namespaces (
  namespace TEXT PRIMARY KEY,
  max_concurrent INTEGER NOT NULL CHECK (max_concurrent > 0),
  max_queued INTEGER NOT NULL CHECK (max_queued >= 0),
  max_queued_per_thread INTEGER NOT NULL CHECK (max_queued_per_thread >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS auggy_coordination_instances (
  namespace TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  draining BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, instance_id)
);

CREATE TABLE IF NOT EXISTS auggy_coordination_threads (
  namespace TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  next_fence BIGINT NOT NULL DEFAULT 0,
  quarantined BOOLEAN NOT NULL DEFAULT FALSE,
  quarantine_fence BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, thread_id)
);

CREATE TABLE IF NOT EXISTS auggy_coordination_sources (
  namespace TEXT NOT NULL,
  source_id TEXT NOT NULL,
  max_concurrent INTEGER NOT NULL CHECK (max_concurrent > 0),
  max_queued INTEGER NOT NULL CHECK (max_queued >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, source_id)
);

CREATE TABLE IF NOT EXISTS auggy_coordination_requests (
  namespace TEXT NOT NULL,
  request_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'active', 'completed', 'failed', 'canceled', 'outcome_unknown')),
  fence BIGINT,
  owner_instance TEXT,
  lease_expires_at TIMESTAMPTZ,
  execution_started_at TIMESTAMPTZ,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  terminal_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, request_id)
);

CREATE INDEX IF NOT EXISTS auggy_coordination_request_queue_idx
  ON auggy_coordination_requests (namespace, state, queued_at, request_id);
CREATE INDEX IF NOT EXISTS auggy_coordination_request_thread_idx
  ON auggy_coordination_requests (namespace, thread_id, state);
CREATE INDEX IF NOT EXISTS auggy_coordination_request_source_idx
  ON auggy_coordination_requests (namespace, source_id, state);

CREATE TABLE IF NOT EXISTS auggy_coordination_events (
  event_id BIGSERIAL PRIMARY KEY,
  namespace TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  request_id TEXT,
  fence BIGINT,
  event_type TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
`;

/** Recomputed from immutable migration SQL; migration rejects any mismatch. */
export const postgresCoordinationMigrationChecksum = new Bun.CryptoHasher("sha256")
  .update(INITIAL_COORDINATION_MIGRATION_SQL)
  .digest("hex");

export const POSTGRES_COORDINATION_MIGRATIONS = [
  {
    id: "20260724_01_distributed_turn_coordination",
    checksum: postgresCoordinationMigrationChecksum,
    sql: INITIAL_COORDINATION_MIGRATION_SQL,
  },
] as const;

export interface PostgresMigrationExecutor {
  begin<T>(callback: (transaction: PostgresMigrationExecutor) => Promise<T>): Promise<T>;
  unsafe<T extends object = Record<string, unknown>>(
    query: string,
    values?: unknown[],
  ): Promise<T[]>;
}

/** Apply checked, idempotent migrations. It intentionally performs no DDL until called. */
export async function migratePostgresCoordinator(sql: PostgresMigrationExecutor): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended('auggy_coordination_migrations', 0))",
    );
    await tx.unsafe(
      "CREATE TABLE IF NOT EXISTS auggy_coordination_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())",
    );
    for (const migration of POSTGRES_COORDINATION_MIGRATIONS) {
      const applied = await tx.unsafe<{ id: string; checksum: string }>(
        "SELECT id, checksum FROM auggy_coordination_migrations WHERE id = $1 FOR UPDATE",
        [migration.id],
      );
      if (applied.length > 0) {
        if (typeof applied[0]?.checksum !== "string" || applied[0]?.checksum !== migration.checksum)
          throw new Error(`coordination migration checksum mismatch: ${migration.id}`);
        continue;
      }
      await tx.unsafe(migration.sql);
      await tx.unsafe("INSERT INTO auggy_coordination_migrations (id, checksum) VALUES ($1, $2)", [
        migration.id,
        migration.checksum,
      ]);
    }
  });
}
