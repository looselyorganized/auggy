import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { resolve } from "node:path";
import { PostgresDistributedTurnCoordinator } from "../../src/coordination";
import type { DistributedCoordinatorCompatibility } from "../../src/coordination/types";
import type { PostgresCoordinatorOptions } from "../../src/coordination/postgres";
import {
  migratePostgresCoordinator,
  POSTGRES_COORDINATION_MIGRATIONS,
  type PostgresMigrationExecutor,
} from "../../src/coordination/migrations";
import { createJsonLineBarrier, spawnJsonLineWorker } from "../helpers/multiprocess";

const url = process.env.AUGGY_TEST_POSTGRES_URL;
const postgresTest = url ? test : test.skip;
const hash = "S7l_qm3W92Yd4JbKzV1LQYdKebJ4Q-4C3m3VnuDhxQY";
const source = { id: "web", maxConcurrent: 2, maxQueued: 4 };
const coordinatorPolicy = {
  buildFingerprint: "c".repeat(64),
  sources: [source],
  retention: {
    terminalRequestRetentionMs: 604_800_000,
    maxTerminalRequests: 10_000,
    eventRetentionMs: 2_592_000_000,
    maxEvents: 50_000,
  },
  result: { maxReplayBytes: 65_536 },
  compatibility: {
    protocolVersion: 4,
    protocolFingerprint: "a".repeat(64),
    configurationFingerprint: "b".repeat(64),
  },
};
const namespaces = new Set<string>();
const workers = new Set<ReturnType<typeof spawnJsonLineWorker>>();

function namespace(): string {
  const value = `coordination-it-${crypto.randomUUID().replaceAll("-", "")}`;
  namespaces.add(value);
  return value;
}

function request(requestId: string, threadId = "thread-1", bindingHash = hash) {
  return { requestId, threadId, source, bindingHash };
}

function replay(value: unknown = { ok: true }) {
  return {
    body: new TextEncoder().encode(JSON.stringify(value)),
    contentType: "application/json" as const,
  };
}

function coordinator(
  namespace: string,
  instanceId: string,
  leaseMs = 5_000,
  maxConcurrent = 2,
  maxQueued = 4,
  compatibility: Partial<DistributedCoordinatorCompatibility> = {},
  retention: (typeof coordinatorPolicy)["retention"] = coordinatorPolicy.retention,
) {
  return new PostgresDistributedTurnCoordinator({
    url: url!,
    namespace,
    instanceId,
    maxConcurrent,
    maxQueued,
    maxQueuedPerThread: Math.min(2, maxQueued),
    leaseMs,
    ...coordinatorPolicy,
    retention,
    compatibility: { ...coordinatorPolicy.compatibility, ...compatibility },
  });
}

function isolatedMigrationSchema(sql: SQL) {
  const schema = `coordination_migration_${crypto.randomUUID().replaceAll("-", "")}`;
  if (!/^coordination_migration_[a-f0-9]{32}$/.test(schema)) {
    throw new Error("generated an unsafe PostgreSQL test schema");
  }
  const executor: PostgresMigrationExecutor = {
    async begin<T>(callback: (transaction: PostgresMigrationExecutor) => Promise<T>): Promise<T> {
      return sql.begin(async (transaction) => {
        return callback({
          begin: (nested) => nested(executor),
          unsafe: (query, values) => transaction.unsafe(query, values),
        });
      });
    },
    unsafe: (query, values) => sql.unsafe(query, values),
  };
  return { schema, executor };
}

async function removeNamespace(value: string): Promise<void> {
  const sql = new SQL(url!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("DELETE FROM auggy_coordination_events WHERE namespace = $1", [value]);
      await tx.unsafe("DELETE FROM auggy_coordination_requests WHERE namespace = $1", [value]);
      await tx.unsafe("DELETE FROM auggy_coordination_threads WHERE namespace = $1", [value]);
      await tx.unsafe("DELETE FROM auggy_coordination_sources WHERE namespace = $1", [value]);
      await tx.unsafe("DELETE FROM auggy_coordination_instances WHERE namespace = $1", [value]);
      await tx.unsafe("DELETE FROM auggy_coordination_namespaces WHERE namespace = $1", [value]);
    });
  } finally {
    await sql.close();
  }
}

/** Test-only seam: expire a lease using PostgreSQL time, never a test sleep. */
async function expireActiveLease(namespace: string, requestId: string): Promise<void> {
  const sql = new SQL(url!);
  try {
    const rows = await sql.unsafe<Array<{ request_id: string }>>(
      "UPDATE auggy_coordination_requests SET lease_expires_at = clock_timestamp() - interval '1 millisecond' WHERE namespace = $1 AND request_id = $2 AND state = 'active' RETURNING request_id",
      [namespace, requestId],
    );
    if (rows.length !== 1) throw new Error("expected one active lease to expire");
  } finally {
    await sql.close();
  }
}

/** Test-only seam: expire process-attached queue ownership using PostgreSQL time. */
async function expireQueuedLease(namespace: string, requestId: string): Promise<void> {
  const sql = new SQL(url!);
  try {
    const rows = await sql.unsafe<Array<{ request_id: string }>>(
      "UPDATE auggy_coordination_requests SET queue_expires_at = clock_timestamp() - interval '1 millisecond' WHERE namespace = $1 AND request_id = $2 AND state = 'queued' RETURNING request_id",
      [namespace, requestId],
    );
    if (rows.length !== 1) throw new Error("expected one queued lease to expire");
  } finally {
    await sql.close();
  }
}

async function expireInstanceLeases(namespace: string): Promise<void> {
  const sql = new SQL(url!);
  try {
    await sql.unsafe(
      "UPDATE auggy_coordination_instances SET lease_expires_at = clock_timestamp() - interval '1 millisecond' WHERE namespace = $1",
      [namespace],
    );
  } finally {
    await sql.close();
  }
}

afterEach(async () => {
  for (const worker of workers) await worker.terminate();
  workers.clear();
  for (const value of namespaces) await removeNamespace(value);
  namespaces.clear();
});

describe("PostgreSQL distributed turn coordinator", () => {
  postgresTest(
    "rejects a same-named incompatible schema without recording migration success",
    async () => {
      const sql = new SQL(url!);
      const { schema, executor } = isolatedMigrationSchema(sql);
      try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        await sql.unsafe(
          `CREATE TABLE ${schema}.auggy_coordination_namespaces (namespace TEXT PRIMARY KEY)`,
        );

        await expect(migratePostgresCoordinator(executor, { schema })).rejects.toThrow(
          "coordination schema is incompatible",
        );
        const ledger = await sql.unsafe<Array<{ relation: string | null }>>(
          "SELECT to_regclass($1)::text AS relation",
          [`${schema}.auggy_coordination_migrations`],
        );
        expect(ledger).toEqual([{ relation: null }]);
      } finally {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await sql.close();
      }
    },
  );

  postgresTest("revalidates an applied migration before accepting it", async () => {
    const sql = new SQL(url!);
    const { schema, executor } = isolatedMigrationSchema(sql);
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await migratePostgresCoordinator(executor, { schema });
      await sql.unsafe(
        `ALTER TABLE ${schema}.auggy_coordination_namespaces DROP COLUMN max_queued`,
      );

      await expect(migratePostgresCoordinator(executor, { schema })).rejects.toThrow(
        "coordination schema is incompatible",
      );
      const ledger = await sql.unsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::integer AS count FROM ${schema}.auggy_coordination_migrations WHERE id = $1`,
        [POSTGRES_COORDINATION_MIGRATIONS[0].id],
      );
      expect(ledger).toEqual([{ count: 1 }]);
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.close();
    }
  });

  postgresTest("rejects catalog objects that weaken migration invariants", async () => {
    const sql = new SQL(url!);
    const { schema, executor } = isolatedMigrationSchema(sql);
    const alternateSchema = `coordination_sequence_${crypto.randomUUID().replaceAll("-", "")}`;
    if (!/^coordination_sequence_[a-f0-9]{32}$/.test(alternateSchema)) {
      throw new Error("generated an unsafe PostgreSQL sequence schema");
    }
    const migrate = () => migratePostgresCoordinator(executor, { schema });
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`CREATE SCHEMA ${alternateSchema}`);
      const [version] = await sql.unsafe<Array<{ server_version_num: number }>>(
        "SELECT current_setting('server_version_num')::integer AS server_version_num",
      );
      const supportsConstraintEnforcement = (version?.server_version_num ?? 0) >= 180000;
      await migrate();
      await migrate();

      await sql.unsafe(
        `ALTER TABLE ${schema}.auggy_coordination_threads ALTER COLUMN quarantined SET DEFAULT TRUE`,
      );
      await expect(migrate()).rejects.toThrow("coordination schema is incompatible");
      await sql.unsafe(
        `ALTER TABLE ${schema}.auggy_coordination_threads ALTER COLUMN quarantined SET DEFAULT FALSE`,
      );
      await migrate();

      await sql.unsafe(
        `ALTER TABLE ${schema}.auggy_coordination_requests ALTER COLUMN binding_hash DROP NOT NULL`,
      );
      await expect(migrate()).rejects.toThrow("coordination schema is incompatible");
      await sql.unsafe(
        `ALTER TABLE ${schema}.auggy_coordination_requests ALTER COLUMN binding_hash SET NOT NULL`,
      );
      await migrate();

      if (supportsConstraintEnforcement) {
        await sql.unsafe(
          `ALTER TABLE ${schema}.auggy_coordination_requests ALTER COLUMN binding_hash DROP NOT NULL`,
        );
        await sql.unsafe(
          `ALTER TABLE ${schema}.auggy_coordination_requests ADD CONSTRAINT auggy_coordination_requests_binding_hash_not_null NOT NULL binding_hash NOT VALID`,
        );
        await expect(migrate()).rejects.toThrow("coordination schema is incompatible");
        await sql.unsafe(
          `ALTER TABLE ${schema}.auggy_coordination_requests VALIDATE CONSTRAINT auggy_coordination_requests_binding_hash_not_null`,
        );
        await migrate();
      }

      await sql.unsafe(
        `ALTER TABLE ${schema}.auggy_coordination_requests ALTER COLUMN request_id TYPE text COLLATE "C"`,
      );
      await expect(migrate()).rejects.toThrow("coordination schema is incompatible");
      await sql.unsafe(
        `ALTER TABLE ${schema}.auggy_coordination_requests ALTER COLUMN request_id TYPE text COLLATE "default"`,
      );
      await migrate();

      await sql.unsafe(`DROP INDEX ${schema}.auggy_coordination_request_queue_idx`);
      await sql.unsafe(
        `CREATE INDEX auggy_coordination_request_queue_idx ON ${schema}.auggy_coordination_requests (namespace, state, queued_at, request_id) WHERE state = 'queued'`,
      );
      await expect(migrate()).rejects.toThrow("coordination schema is incompatible");
      await sql.unsafe(`DROP INDEX ${schema}.auggy_coordination_request_queue_idx`);
      await sql.unsafe(
        `CREATE INDEX auggy_coordination_request_queue_idx ON ${schema}.auggy_coordination_requests (namespace DESC, state, queued_at, request_id)`,
      );
      await expect(migrate()).rejects.toThrow("coordination schema is incompatible");
      await sql.unsafe(`DROP INDEX ${schema}.auggy_coordination_request_queue_idx`);
      await sql.unsafe(
        `CREATE INDEX auggy_coordination_request_queue_idx ON ${schema}.auggy_coordination_requests (namespace, state, queued_at, request_id)`,
      );
      await migrate();

      await sql.unsafe(
        `ALTER TABLE ${schema}.auggy_coordination_namespaces DROP CONSTRAINT auggy_coordination_namespaces_pkey`,
      );
      await sql.unsafe(
        `ALTER TABLE ${schema}.auggy_coordination_namespaces ADD CONSTRAINT auggy_coordination_namespaces_pkey PRIMARY KEY (namespace) DEFERRABLE INITIALLY DEFERRED`,
      );
      await expect(migrate()).rejects.toThrow("coordination schema is incompatible");
      await sql.unsafe(
        `ALTER TABLE ${schema}.auggy_coordination_namespaces DROP CONSTRAINT auggy_coordination_namespaces_pkey`,
      );
      await sql.unsafe(
        `ALTER TABLE ${schema}.auggy_coordination_namespaces ADD CONSTRAINT auggy_coordination_namespaces_pkey PRIMARY KEY (namespace)`,
      );
      await migrate();

      await sql.unsafe(
        `ALTER TABLE ${schema}.auggy_coordination_requests DROP CONSTRAINT auggy_coordination_requests_state_check`,
      );
      await sql.unsafe(
        `ALTER TABLE ${schema}.auggy_coordination_requests ADD CONSTRAINT auggy_coordination_requests_state_check CHECK (state IN ('queued', 'active', 'completed', 'failed', 'canceled', 'outcome_unknown')) NOT VALID`,
      );
      await expect(migrate()).rejects.toThrow("coordination schema is incompatible");
      await sql.unsafe(
        `ALTER TABLE ${schema}.auggy_coordination_requests VALIDATE CONSTRAINT auggy_coordination_requests_state_check`,
      );
      await migrate();

      if (supportsConstraintEnforcement) {
        await sql.unsafe(
          `ALTER TABLE ${schema}.auggy_coordination_requests DROP CONSTRAINT auggy_coordination_requests_state_check`,
        );
        await sql.unsafe(
          `ALTER TABLE ${schema}.auggy_coordination_requests ADD CONSTRAINT auggy_coordination_requests_state_check CHECK (state IN ('queued', 'active', 'completed', 'failed', 'canceled', 'outcome_unknown')) NOT ENFORCED`,
        );
        await expect(migrate()).rejects.toThrow("coordination schema is incompatible");
        await sql.unsafe(
          `ALTER TABLE ${schema}.auggy_coordination_requests DROP CONSTRAINT auggy_coordination_requests_state_check`,
        );
        await sql.unsafe(
          `ALTER TABLE ${schema}.auggy_coordination_requests ADD CONSTRAINT auggy_coordination_requests_state_check CHECK (state IN ('queued', 'active', 'completed', 'failed', 'canceled', 'outcome_unknown'))`,
        );
        await migrate();
      }

      await sql.unsafe(
        `ALTER TABLE ${schema}.auggy_coordination_requests ENABLE ROW LEVEL SECURITY`,
      );
      await expect(migrate()).rejects.toThrow("coordination schema is incompatible");
      await sql.unsafe(
        `ALTER TABLE ${schema}.auggy_coordination_requests DISABLE ROW LEVEL SECURITY`,
      );
      await migrate();

      await sql.unsafe(`ALTER SEQUENCE ${schema}.auggy_coordination_events_event_id_seq CYCLE`);
      await expect(migrate()).rejects.toThrow("coordination schema is incompatible");
      await sql.unsafe(`ALTER SEQUENCE ${schema}.auggy_coordination_events_event_id_seq NO CYCLE`);
      await migrate();

      await sql.unsafe(
        `CREATE SEQUENCE ${alternateSchema}.auggy_coordination_events_event_id_seq AS BIGINT`,
      );
      await sql.unsafe(
        `ALTER TABLE ${schema}.auggy_coordination_events ALTER COLUMN event_id SET DEFAULT nextval('${alternateSchema}.auggy_coordination_events_event_id_seq'::regclass)`,
      );
      await expect(migrate()).rejects.toThrow("coordination schema is incompatible");
      await sql.unsafe(
        `ALTER TABLE ${schema}.auggy_coordination_events ALTER COLUMN event_id SET DEFAULT nextval('${schema}.auggy_coordination_events_event_id_seq'::regclass)`,
      );
      await migrate();

      await sql.unsafe(
        `ALTER SEQUENCE ${schema}.auggy_coordination_events_event_id_seq OWNED BY NONE`,
      );
      await expect(migrate()).rejects.toThrow("coordination schema is incompatible");
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${alternateSchema} CASCADE`);
      await sql.close();
    }
  });

  test("rejects unsafe explicit coordination schema identifiers before opening a transaction", async () => {
    let began = false;
    const executor: PostgresMigrationExecutor = {
      async begin<T>(): Promise<T> {
        began = true;
        throw new Error("unexpected transaction");
      },
      async unsafe<T extends object>(): Promise<T[]> {
        throw new Error("unexpected query");
      },
    };

    await expect(
      migratePostgresCoordinator(executor, { schema: 'public", attacker' }),
    ).rejects.toThrow("lowercase PostgreSQL identifier");
    expect(began).toBeFalse();
  });

  postgresTest("pins runtime operations away from a role-controlled shadow schema", async () => {
    const sql = new SQL(url!);
    const shadow = `coordination_shadow_${crypto.randomUUID().replaceAll("-", "")}`;
    const value = namespace();
    if (!/^coordination_shadow_[a-f0-9]{32}$/.test(shadow)) {
      throw new Error("generated an unsafe PostgreSQL shadow schema");
    }
    const shadowedExecutor: PostgresMigrationExecutor = {
      async begin<T>(callback: (transaction: PostgresMigrationExecutor) => Promise<T>): Promise<T> {
        return sql.begin(async (transaction) => {
          await transaction.unsafe(`SET LOCAL search_path TO ${shadow}, public, pg_catalog`);
          const scoped: PostgresMigrationExecutor = {
            begin: (nested) => nested(scoped),
            unsafe: (query, values) => transaction.unsafe(query, values),
          };
          return callback(scoped);
        });
      },
      async unsafe<T extends object>(): Promise<T[]> {
        throw new Error("runtime attempted unscoped direct SQL");
      },
    };
    const instance = new PostgresDistributedTurnCoordinator({
      namespace: value,
      instanceId: "shadow-proof",
      maxConcurrent: 1,
      maxQueued: 2,
      maxQueuedPerThread: 1,
      leaseMs: 1_000,
      ...coordinatorPolicy,
      sql: shadowedExecutor,
    });
    try {
      await sql.unsafe(`CREATE SCHEMA ${shadow}`);
      await sql.unsafe(
        `CREATE TABLE ${shadow}.auggy_coordination_namespaces (namespace TEXT PRIMARY KEY)`,
      );
      await instance.migrate();
      expect(await instance.register()).toEqual({ status: "registered" });
      expect(await instance.admit(request("shadow-request"))).toEqual({
        status: "admitted",
        attempt: 1,
      });
      expect(await instance.abandon(request("shadow-request"))).toEqual({ status: "ok" });

      const publicRows = await sql.unsafe<Array<{ count: number }>>(
        "SELECT count(*)::integer AS count FROM public.auggy_coordination_requests WHERE namespace = $1",
        [value],
      );
      const shadowRows = await sql.unsafe<Array<{ count: number }>>(
        `SELECT count(*)::integer AS count FROM ${shadow}.auggy_coordination_namespaces`,
      );
      expect(publicRows).toEqual([{ count: 1 }]);
      expect(shadowRows).toEqual([{ count: 0 }]);
    } finally {
      await instance.close();
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${shadow} CASCADE`);
      await sql.close();
    }
  });

  postgresTest("does not let a temporary catalog shadow hide a real trigger", async () => {
    const sql = new SQL(url!);
    const { schema, executor } = isolatedMigrationSchema(sql);
    const shadowingExecutor: PostgresMigrationExecutor = {
      async begin<T>(callback: (transaction: PostgresMigrationExecutor) => Promise<T>): Promise<T> {
        return sql.begin(async (transaction) => {
          await transaction.unsafe("CREATE TEMP TABLE pg_trigger (tgrelid oid) ON COMMIT DROP");
          const scoped: PostgresMigrationExecutor = {
            begin: (nested) => nested(scoped),
            unsafe: (query, values) => transaction.unsafe(query, values),
          };
          return callback(scoped);
        });
      },
      async unsafe<T extends object>(): Promise<T[]> {
        throw new Error("migration attempted unscoped direct SQL");
      },
    };
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await migratePostgresCoordinator(executor, { schema });
      await sql.unsafe(
        `CREATE FUNCTION ${schema}.auggy_coordination_trigger_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
      );
      await sql.unsafe(
        `CREATE TRIGGER auggy_coordination_trigger_probe BEFORE INSERT ON ${schema}.auggy_coordination_requests FOR EACH ROW EXECUTE FUNCTION ${schema}.auggy_coordination_trigger_probe()`,
      );

      await expect(migratePostgresCoordinator(shadowingExecutor, { schema })).rejects.toThrow(
        "coordination schema is incompatible",
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.close();
    }
  });

  postgresTest("rejects inherited tables that bypass parent coordination constraints", async () => {
    const sql = new SQL(url!);
    const { schema, executor } = isolatedMigrationSchema(sql);
    try {
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await migratePostgresCoordinator(executor, { schema });
      await sql.unsafe(
        `CREATE TABLE ${schema}.auggy_coordination_requests_child () INHERITS (${schema}.auggy_coordination_requests)`,
      );
      const duplicate = [
        "inheritance",
        "duplicate",
        "thread",
        "source",
        hash,
        "queued",
        "owner",
        "d".repeat(64),
      ];
      await sql.unsafe(
        `INSERT INTO ${schema}.auggy_coordination_requests (namespace, request_id, thread_id, source_id, binding_hash, state, queue_owner_instance, queue_owner_session, queue_generation, queue_expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, clock_timestamp() + interval '1 minute')`,
        duplicate,
      );
      await sql.unsafe(
        `INSERT INTO ${schema}.auggy_coordination_requests_child (namespace, request_id, thread_id, source_id, binding_hash, state, queue_owner_instance, queue_owner_session, queue_generation, queue_expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, clock_timestamp() + interval '1 minute')`,
        duplicate,
      );
      const visible = await sql.unsafe<Array<{ count: number }>>(
        `SELECT count(*)::integer AS count FROM ${schema}.auggy_coordination_requests WHERE namespace = $1 AND request_id = $2`,
        duplicate.slice(0, 2),
      );
      expect(visible).toEqual([{ count: 2 }]);

      await expect(migratePostgresCoordinator(executor, { schema })).rejects.toThrow(
        "coordination schema is incompatible",
      );
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await sql.close();
    }
  });

  postgresTest("runs checked migration repeatedly without creating duplicate state", async () => {
    const first = coordinator(namespace(), "migration-a");
    const second = coordinator(namespace(), "migration-b");
    try {
      await Promise.all([first.migrate(), second.migrate()]);
      expect(await first.register()).toEqual({ status: "registered" });
      const sql = new SQL(url!);
      try {
        const migrations = await sql.unsafe<Array<{ id: string; checksum: string }>>(
          "SELECT id, checksum FROM auggy_coordination_migrations WHERE id = $1",
          [POSTGRES_COORDINATION_MIGRATIONS[0].id],
        );
        expect(migrations).toEqual([
          {
            id: POSTGRES_COORDINATION_MIGRATIONS[0].id,
            checksum: POSTGRES_COORDINATION_MIGRATIONS[0].checksum,
          },
        ]);
      } finally {
        await sql.close();
      }
      expect(await first.health()).toEqual({
        status: "healthy",
        active: 0,
        queued: 0,
        quarantined: 0,
      });
    } finally {
      await first.close();
      await second.close();
    }
  });

  postgresTest("rejects pre-v3 ownerless queue and active row shapes after migration", async () => {
    const value = namespace();
    if (!/^coordination-it-[a-f0-9]{32}$/.test(value)) {
      throw new Error("generated an unsafe coordination test namespace");
    }
    const instance = coordinator(value, "migration-shape");
    const sql = new SQL(url!);
    try {
      await instance.migrate();
      await sql.unsafe(`
        DO $guard$
        BEGIN
          BEGIN
            INSERT INTO auggy_coordination_requests
              (namespace, request_id, thread_id, source_id, binding_hash, state)
            VALUES
              ('${value}', 'legacy-queued', 'thread', 'web', '${hash}', 'queued');
            RAISE EXCEPTION 'legacy queued row was accepted';
          EXCEPTION WHEN check_violation THEN
            NULL;
          END;
          BEGIN
            INSERT INTO auggy_coordination_requests
              (namespace, request_id, thread_id, source_id, binding_hash, state,
               fence, owner_instance, lease_expires_at)
            VALUES
              ('${value}', 'legacy-active', 'thread', 'web', '${hash}', 'active',
               1, 'old-client', clock_timestamp() + interval '1 minute');
            RAISE EXCEPTION 'legacy active row was accepted';
          EXCEPTION WHEN check_violation THEN
            NULL;
          END;
        END
        $guard$
      `);
    } finally {
      await sql.close();
      await instance.close();
    }
  });

  postgresTest("allows exactly one independently started process to claim one thread", async () => {
    const value = namespace();
    const setup = coordinator(value, "setup");
    try {
      await setup.migrate();
    } finally {
      await setup.close();
    }

    const env = { AUGGY_TEST_POSTGRES_URL: url };
    const script = resolve("tests/coordination/fixtures/postgres-coordinator-worker.ts");
    const first = spawnJsonLineWorker({ script, args: [value, "process-a"], env });
    const second = spawnJsonLineWorker({ script, args: [value, "process-b"], env });
    workers.add(first);
    workers.add(second);
    const barrier = createJsonLineBarrier([first, second]);
    await barrier.waitUntilReady();
    barrier.release({ event: "GO" });
    const results = await Promise.all([first.next(), second.next()]);
    barrier.close();
    expect(await Promise.all([first.process.exited, second.process.exited])).toEqual([0, 0]);
    workers.delete(first);
    workers.delete(second);

    expect(results.filter((result) => result.claimed === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.claimed === "waiting")).toHaveLength(1);
  });

  postgresTest(
    "registers one private instance incarnation and fences same-id collisions",
    async () => {
      const value = namespace();
      const first = coordinator(value, "shared-instance", 500);
      const collision = coordinator(value, "shared-instance", 500);
      const sql = new SQL(url!);
      try {
        expect(await first.admit(request("before-registration"))).toEqual({
          status: "unavailable",
        });
        await first.migrate();
        expect(await first.register()).toEqual({ status: "registered" });
        expect(await collision.register()).toEqual({ status: "conflict" });
        expect(await collision.admit(request("collision-request"))).toEqual({
          status: "unavailable",
        });
        expect(await collision.heartbeatInstance()).toEqual({ status: "stale" });

        const rows = await sql.unsafe<Array<{ count: number }>>(
          "SELECT count(*)::integer AS count FROM auggy_coordination_instances WHERE namespace = $1 AND instance_id = $2",
          [value, "shared-instance"],
        );
        expect(rows).toEqual([{ count: 1 }]);
      } finally {
        await sql.close();
        await collision.close();
        await first.close();
      }
    },
  );

  postgresTest(
    "keeps live queues local and permits only exact retry adoption after expiry",
    async () => {
      const value = namespace();
      const first = coordinator(value, "queue-owner", 500);
      const second = coordinator(value, "retry-owner", 500);
      const sql = new SQL(url!);
      try {
        await first.migrate();
        expect(await first.register()).toEqual({ status: "registered" });
        expect(await second.register()).toEqual({ status: "registered" });
        const owned = request("owned-request", "owned-thread");
        expect(await first.admit(owned)).toEqual({ status: "admitted", attempt: 1 });
        expect(await second.claim(owned)).toEqual({ status: "waiting" });
        expect(await first.heartbeatQueued(owned)).toEqual({ status: "ok" });

        await expireQueuedLease(value, owned.requestId);
        expect(await first.heartbeatInstance()).toEqual({ status: "ok" });
        expect(await second.admit(owned)).toEqual({ status: "adopted", attempt: 2 });
        expect(await first.heartbeatQueued(owned)).toEqual({ status: "stale" });
        expect(await first.abandon(owned)).toEqual({ status: "stale" });
        expect(await second.admit({ ...owned, threadId: "changed-thread" })).toEqual({
          status: "conflict",
        });
        expect(
          await second.admit({
            ...owned,
            source: { id: "untrusted-source", maxConcurrent: 999, maxQueued: 999 },
          }),
        ).toEqual({ status: "conflict" });
        expect((await second.claim(owned, 2)).status).toBe("acquired");

        const sameSession = request("same-session-adoption", "same-session-thread");
        expect(await second.admit(sameSession)).toEqual({ status: "admitted", attempt: 1 });
        await expireQueuedLease(value, sameSession.requestId);
        expect(await second.admit(sameSession)).toEqual({ status: "adopted", attempt: 2 });
        const currentSignal = second.ownedSignal(sameSession);
        expect(await second.heartbeatQueued(sameSession, 1)).toEqual({ status: "stale" });
        expect(await second.abandon(sameSession, 1)).toEqual({ status: "stale" });
        expect(currentSignal.aborted).toBeFalse();
        const sameSessionLease = await second.claim(sameSession, 2);
        if (sameSessionLease.status !== "acquired") {
          throw new Error("expected same-session adopted lease");
        }
        expect(await second.complete(sameSessionLease.lease, replay())).toEqual({ status: "ok" });

        const sources = await sql.unsafe<Array<{ source_id: string }>>(
          "SELECT source_id FROM auggy_coordination_sources WHERE namespace = $1 ORDER BY source_id",
          [value],
        );
        expect(sources).toEqual([{ source_id: "web" }]);
      } finally {
        await sql.close();
        await second.close();
        await first.close();
      }
    },
  );

  postgresTest("abandons only an owned active attempt before execution starts", async () => {
    const value = namespace();
    const instance = coordinator(value, "pre-start-owner", 500);
    try {
      await instance.migrate();
      expect(await instance.register()).toEqual({ status: "registered" });

      const canceled = request("pre-start-cancel", "pre-start-thread");
      expect(await instance.admit(canceled)).toEqual({ status: "admitted", attempt: 1 });
      expect((await instance.claim(canceled, 1)).status).toBe("acquired");
      const canceledSignal = instance.ownedSignal(canceled);
      expect(await instance.abandon(canceled, 1)).toEqual({ status: "ok" });
      expect(canceledSignal.aborted).toBeTrue();
      expect(await instance.status(canceled)).toEqual({
        status: "terminal",
        state: "canceled",
      });

      const started = request("started-cancel", "started-thread");
      expect(await instance.admit(started)).toEqual({ status: "admitted", attempt: 1 });
      const lease = await instance.claim(started, 1);
      if (lease.status !== "acquired") throw new Error("expected active lease");
      expect(await instance.markExecutionStarted(lease.lease)).toEqual({ status: "ok" });
      expect(await instance.abandon(started, 1)).toEqual({ status: "stale" });
      expect(await instance.status(started)).toMatchObject({ status: "pending", state: "active" });
    } finally {
      await instance.close();
    }
  });

  postgresTest("commits and replays byte-bounded results only for an exact binding", async () => {
    const value = namespace();
    const first = coordinator(value, "result-owner", 500);
    const second = coordinator(value, "result-reader", 500);
    try {
      await first.migrate();
      expect(await first.register()).toEqual({ status: "registered" });
      expect(await second.register()).toEqual({ status: "registered" });
      const completed = request("result-request", "result-thread");
      expect(await first.admit(completed)).toEqual({ status: "admitted", attempt: 1 });
      const claimed = await first.claim(completed);
      if (claimed.status !== "acquired") throw new Error("expected result lease");
      const exact = replay("a".repeat(coordinatorPolicy.result.maxReplayBytes - 2));
      expect(exact.body.byteLength).toBe(coordinatorPolicy.result.maxReplayBytes);
      expect(await first.complete(claimed.lease, exact)).toEqual({ status: "ok" });
      expect(await second.status(completed)).toEqual({ status: "completed", result: exact });
      expect(await second.status({ ...completed, bindingHash: "x".repeat(32) })).toEqual({
        status: "conflict",
      });
      expect(await second.wait(completed, { timeoutMs: 0, pollMs: 10 })).toEqual({
        status: "completed",
        result: exact,
      });

      const oversized = request("oversized-result", "oversized-thread");
      expect(await first.admit(oversized)).toEqual({ status: "admitted", attempt: 1 });
      const oversizedLease = await first.claim(oversized);
      if (oversizedLease.status !== "acquired") throw new Error("expected oversized lease");
      expect(
        await first.complete(
          oversizedLease.lease,
          replay("é".repeat(coordinatorPolicy.result.maxReplayBytes / 2)),
        ),
      ).toEqual({ status: "rejected", reason: "result-too-large" });
      expect(await second.status(oversized)).toEqual({ status: "pending", state: "active" });
      expect(await first.complete(oversizedLease.lease, replay({ smaller: true }))).toEqual({
        status: "ok",
      });

      const pending = request("pending-wait", "pending-thread");
      expect(await first.admit(pending)).toEqual({ status: "admitted", attempt: 1 });
      const abort = new AbortController();
      abort.abort();
      expect(
        await second.wait(pending, { timeoutMs: 1_000, pollMs: 10, signal: abort.signal }),
      ).toEqual({ status: "wait-aborted" });
    } finally {
      await second.close();
      await first.close();
    }
  });

  postgresTest(
    "prunes bounded replay state without deleting incidents or reusing thread fences",
    async () => {
      const value = namespace();
      const retention = {
        terminalRequestRetentionMs: 60_000,
        maxTerminalRequests: 2,
        eventRetentionMs: 60_000,
        maxEvents: 1,
      };
      const instance = coordinator(value, "retention-owner", 60_000, 2, 4, {}, retention);
      const expired = coordinator(value, "expired-instance", 60_000, 2, 4, {}, retention);
      const sql = new SQL(url!);
      try {
        await instance.migrate();
        expect(await instance.register()).toEqual({ status: "registered" });
        expect(await expired.register()).toEqual({ status: "registered" });

        let firstFence = 0;
        for (const [index, [requestId, threadId]] of (
          [
            ["retained-a", "reused-thread"],
            ["retained-b", "retained-thread-b"],
            ["retained-c", "retained-thread-c"],
          ] as const
        ).entries()) {
          const item = request(requestId, threadId);
          expect(await instance.admit(item)).toEqual({ status: "admitted", attempt: 1 });
          const claimed = await instance.claim(item);
          if (claimed.status !== "acquired") throw new Error("expected retained lease");
          if (index === 0) firstFence = claimed.lease.fence;
          expect(await instance.complete(claimed.lease, replay({ requestId }))).toEqual({
            status: "ok",
          });
        }

        const unknown = request("retained-unknown", "retained-unknown-thread");
        expect(await instance.admit(unknown)).toEqual({ status: "admitted", attempt: 1 });
        const incident = await instance.claim(unknown);
        if (incident.status !== "acquired") throw new Error("expected incident lease");
        expect(await instance.markExecutionStarted(incident.lease)).toEqual({ status: "ok" });
        expect(await instance.fail(incident.lease)).toEqual({ status: "outcome-unknown" });

        await sql.unsafe(
          "UPDATE auggy_coordination_requests SET terminal_at = clock_timestamp() - interval '2 minutes' WHERE namespace = $1 AND state IN ('completed', 'failed', 'canceled')",
          [value],
        );
        await sql.unsafe(
          "UPDATE auggy_coordination_events SET created_at = clock_timestamp() - interval '2 minutes' WHERE namespace = $1",
          [value],
        );
        await sql.unsafe(
          "UPDATE auggy_coordination_instances SET lease_expires_at = clock_timestamp() - interval '1 millisecond' WHERE namespace = $1 AND instance_id = 'expired-instance'",
          [value],
        );

        expect(await instance.prune(1)).toEqual({
          status: "ok",
          events: 0,
          instances: 1,
          requests: 1,
          threads: 1,
        });
        expect(await instance.status(request("retained-a", "reused-thread"))).toEqual({
          status: "missing",
        });
        expect(await instance.status(unknown)).toEqual({ status: "quarantined" });
        expect(await instance.events({ limit: 1 })).toMatchObject({
          status: "ok",
          events: [{ eventType: "outcome_unknown", requestId: unknown.requestId }],
        });

        const reused = request("retained-reused", "reused-thread");
        expect(await instance.admit(reused)).toEqual({ status: "admitted", attempt: 1 });
        const reusedLease = await instance.claim(reused);
        if (reusedLease.status !== "acquired") throw new Error("expected reused thread lease");
        expect(reusedLease.lease.fence).toBeGreaterThan(firstFence);
        expect(await instance.complete(reusedLease.lease, replay())).toEqual({ status: "ok" });

        expect(
          await instance.recover(unknown.threadId, incident.lease.fence, "operator-reconciled"),
        ).toEqual({ status: "ok" });
        expect(await instance.status(unknown)).toEqual({ status: "terminal", state: "failed" });
        const firstPage = await instance.events({ limit: 1 });
        if (firstPage.status !== "ok") throw new Error("expected PostgreSQL event page");
        expect(firstPage.events[0]?.eventType).toBe("outcome_unknown");
        if (!firstPage.nextEventId) throw new Error("expected PostgreSQL event cursor");
        expect(
          await instance.events({ afterEventId: firstPage.nextEventId, limit: 1 }),
        ).toMatchObject({
          status: "ok",
          events: [{ eventType: "operator_recovery", requestId: unknown.requestId }],
        });
        expect(await instance.events({ afterEventId: "01", limit: 1 })).toEqual({
          status: "unavailable",
        });
        expect(await instance.prune(1)).toMatchObject({
          status: "ok",
          events: 1,
          requests: 1,
        });
      } finally {
        await sql.close();
        await expired.close();
        await instance.close();
      }
    },
  );

  postgresTest("enforces fleet capacity, binding integrity, and namespace isolation", async () => {
    const one = namespace();
    const two = namespace();
    const first = coordinator(one, "replica-a", 5_000, 1);
    const second = coordinator(one, "replica-b", 5_000, 1);
    const isolated = coordinator(two, "replica-c");
    try {
      await first.migrate();
      expect(await first.register()).toEqual({ status: "registered" });
      expect(await second.register()).toEqual({ status: "registered" });
      expect(await isolated.register()).toEqual({ status: "registered" });
      await first.admit(request("one", "thread-one"));
      await second.admit(request("two", "thread-two"));
      const claimed = await first.claim(request("one", "thread-one"));
      expect(claimed.status).toBe("acquired");
      expect(await second.claim(request("two", "thread-two"))).toEqual({ status: "waiting" });
      expect(await second.admit(request("one", "thread-other"))).toEqual({ status: "conflict" });
      expect(await second.admit(request("thread-wait-1", "thread-one"))).toEqual({
        status: "admitted",
        attempt: 1,
      });
      expect(await second.admit(request("thread-wait-2", "thread-one"))).toEqual({
        status: "admitted",
        attempt: 1,
      });
      expect(await second.admit(request("thread-wait-3", "thread-one"))).toEqual({
        status: "rejected",
        reason: "thread-capacity",
      });

      expect(await isolated.admit(request("one", "thread-one"))).toEqual({
        status: "admitted",
        attempt: 1,
      });
      expect((await isolated.claim(request("one", "thread-one"))).status).toBe("acquired");
    } finally {
      await first.close();
      await second.close();
      await isolated.close();
    }
  });

  postgresTest("rejects mixed compatibility before mutating namespace state", async () => {
    const value = namespace();
    const first = coordinator(value, "compatible-instance");
    const changedProtocol = coordinator(value, "protocol-drift", 5_000, 2, 4, {
      protocolVersion: 5,
    });
    const changedConfiguration = coordinator(value, "configuration-drift", 5_000, 2, 4, {
      configurationFingerprint: "c".repeat(64),
    });
    const changedLease = coordinator(value, "lease-drift", 4_000);
    const sql = new SQL(url!);
    try {
      await first.migrate();
      expect(await first.register()).toEqual({ status: "registered" });
      expect(await first.admit(request("compatibility-first"))).toEqual({
        status: "admitted",
        attempt: 1,
      });

      expect(await changedProtocol.register()).toEqual({ status: "unavailable" });
      expect(await changedProtocol.admit(request("protocol-request"))).toEqual({
        status: "unavailable",
      });
      expect(await changedConfiguration.admit(request("configuration-request"))).toEqual({
        status: "unavailable",
      });
      expect(await changedLease.register()).toEqual({ status: "unavailable" });
      expect(await changedLease.admit(request("lease-request"))).toEqual({
        status: "unavailable",
      });

      const rows = await sql.unsafe<
        Array<{
          configuration_fingerprint: string;
          protocol_version: number;
          request_count: number;
          incompatible_instance_count: number;
        }>
      >(
        "SELECT namespace.configuration_fingerprint, namespace.protocol_version, (SELECT count(*)::integer FROM auggy_coordination_requests request WHERE request.namespace = namespace.namespace AND request.request_id IN ('protocol-request', 'configuration-request', 'lease-request')) AS request_count, (SELECT count(*)::integer FROM auggy_coordination_instances instance WHERE instance.namespace = namespace.namespace AND instance.instance_id IN ('protocol-drift', 'configuration-drift', 'lease-drift')) AS incompatible_instance_count FROM auggy_coordination_namespaces namespace WHERE namespace.namespace = $1",
        [value],
      );
      expect(rows).toEqual([
        {
          configuration_fingerprint: coordinatorPolicy.compatibility.configurationFingerprint,
          protocol_version: coordinatorPolicy.compatibility.protocolVersion,
          request_count: 0,
          incompatible_instance_count: 0,
        },
      ]);
      expect(await first.admit(request("compatible-second"))).toEqual({
        status: "admitted",
        attempt: 1,
      });
    } finally {
      await sql.close();
      await changedLease.close();
      await changedConfiguration.close();
      await changedProtocol.close();
      await first.close();
    }
  });

  postgresTest("atomically upgrades an exact quiescent predecessor protocol", async () => {
    const value = namespace();
    const predecessor = {
      protocolVersion: 3,
      protocolFingerprint: "c".repeat(64),
      configurationFingerprint: "d".repeat(64),
    };
    const old = coordinator(value, "old-protocol", 5_000, 2, 4, predecessor);
    const current = coordinator(value, "current-protocol", 5_000, 2, 4, {
      upgradeFrom: predecessor,
    });
    const sql = new SQL(url!);
    try {
      await old.migrate();
      expect(await old.register()).toEqual({ status: "registered" });
      const terminal = request("upgrade-terminal", "upgrade-thread");
      expect(await old.admit(terminal)).toEqual({ status: "admitted", attempt: 1 });
      expect(await old.abandon(terminal, 1)).toEqual({ status: "ok" });
      expect(await current.register()).toEqual({ status: "unavailable" });

      await expireInstanceLeases(value);
      expect(await current.register()).toEqual({ status: "registered" });
      expect(await old.register()).toEqual({ status: "unavailable" });
      expect(await current.status(terminal)).toEqual({
        status: "terminal",
        state: "canceled",
      });
      const rows = await sql.unsafe<
        Array<{ protocol_version: number; protocol_fingerprint: string }>
      >(
        "SELECT protocol_version, protocol_fingerprint FROM auggy_coordination_namespaces WHERE namespace = $1",
        [value],
      );
      expect(rows).toEqual([
        {
          protocol_version: coordinatorPolicy.compatibility.protocolVersion,
          protocol_fingerprint: coordinatorPolicy.compatibility.protocolFingerprint,
        },
      ]);
    } finally {
      await sql.close();
      await current.close();
      await old.close();
    }
  });

  postgresTest("refuses a predecessor upgrade while queued work remains", async () => {
    const value = namespace();
    const predecessor = {
      protocolVersion: 3,
      protocolFingerprint: "c".repeat(64),
      configurationFingerprint: "d".repeat(64),
    };
    const old = coordinator(value, "old-protocol", 5_000, 2, 4, predecessor);
    const current = coordinator(value, "current-protocol", 5_000, 2, 4, {
      upgradeFrom: predecessor,
    });
    try {
      await old.migrate();
      expect(await old.register()).toEqual({ status: "registered" });
      expect(await old.admit(request("upgrade-pending", "pending-thread"))).toEqual({
        status: "admitted",
        attempt: 1,
      });
      await expireInstanceLeases(value);
      expect(await current.register()).toEqual({ status: "unavailable" });
    } finally {
      await current.close();
      await old.close();
    }
  });

  postgresTest(
    "atomically establishes one compatibility tuple during first-registration race",
    async () => {
      const value = namespace();
      const first = coordinator(value, "registration-a");
      const second = coordinator(value, "registration-b", 5_000, 2, 4, {
        configurationFingerprint: "c".repeat(64),
      });
      const sql = new SQL(url!);
      try {
        await first.migrate();
        const outcomes = await Promise.all([first.register(), second.register()]);
        expect(outcomes.filter((outcome) => outcome.status === "registered")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === "unavailable")).toHaveLength(1);

        const winner = outcomes[0]?.status === "registered" ? first : second;
        const winnerRequest =
          outcomes[0]?.status === "registered"
            ? "registration-request-a"
            : "registration-request-b";
        expect(await winner.admit(request(winnerRequest))).toEqual({
          status: "admitted",
          attempt: 1,
        });

        const rows = await sql.unsafe<
          Array<{ configuration_fingerprint: string; request_id: string }>
        >(
          "SELECT namespace.configuration_fingerprint, request.request_id FROM auggy_coordination_namespaces namespace JOIN auggy_coordination_requests request ON request.namespace = namespace.namespace WHERE namespace.namespace = $1",
          [value],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.request_id).toBe(
          rows[0]?.configuration_fingerprint ===
            coordinatorPolicy.compatibility.configurationFingerprint
            ? "registration-request-a"
            : "registration-request-b",
        );
      } finally {
        await sql.close();
        await second.close();
        await first.close();
      }
    },
  );

  postgresTest(
    "uses forced database lease expiry to quarantine started work and reject stale fences",
    async () => {
      const value = namespace();
      const first = coordinator(value, "replica-a", 500);
      const second = coordinator(value, "replica-b", 500);
      try {
        await first.migrate();
        expect(await first.register()).toEqual({ status: "registered" });
        expect(await second.register()).toEqual({ status: "registered" });
        await first.admit(request("unstarted", "reclaimable-thread"));
        const old = await first.claim(request("unstarted", "reclaimable-thread"));
        if (old.status !== "acquired") throw new Error("expected initial lease");
        await expireActiveLease(value, "unstarted");
        expect(
          await first.abandon(request("unstarted", "reclaimable-thread"), old.lease.attempt),
        ).toEqual({ status: "stale" });
        expect(await second.claim(request("unstarted", "reclaimable-thread"), 2)).toEqual({
          status: "stale",
        });
        expect(await second.admit(request("unstarted", "reclaimable-thread"))).toEqual({
          status: "adopted",
          attempt: 3,
        });
        const fresh = await second.claim(request("unstarted", "reclaimable-thread"), 3);
        if (fresh.status !== "acquired") throw new Error("expected reclaimed lease");
        expect(fresh.lease.attempt).toBe(3);
        expect(fresh.lease.fence).toBeGreaterThan(old.lease.fence);
        expect(await first.markExecutionStarted(old.lease)).toEqual({ status: "stale" });
        expect(await first.heartbeat(old.lease)).toEqual({ status: "stale" });
        expect(await first.complete(old.lease, replay())).toEqual({ status: "stale" });
        expect(await first.fail(old.lease)).toEqual({ status: "stale" });
        expect(await first.markOutcomeUnknown(old.lease, "lease-lost")).toEqual({
          status: "stale",
        });
        expect(await second.complete(fresh.lease, replay())).toEqual({ status: "ok" });

        await first.admit(request("started", "quarantined-thread"));
        const started = await first.claim(request("started", "quarantined-thread"));
        if (started.status !== "acquired") throw new Error("expected started lease");
        expect(await first.markExecutionStarted(started.lease)).toEqual({ status: "ok" });
        await expireActiveLease(value, "started");
        expect(await second.claim(request("started", "quarantined-thread"))).toEqual({
          status: "quarantined",
        });
        expect(
          await second.recover(
            "quarantined-thread",
            started.lease.fence,
            "replica-terminated-after-lease-loss",
          ),
        ).toEqual({ status: "ok" });

        const sql = new SQL(url!);
        try {
          const events = await sql.unsafe<Array<{ reason: string }>>(
            "SELECT reason FROM auggy_coordination_events WHERE namespace = $1 AND thread_id = $2 AND event_type = 'operator_recovery'",
            [value, "quarantined-thread"],
          );
          expect(events).toEqual([{ reason: "replica-terminated-after-lease-loss" }]);
        } finally {
          await sql.close();
        }
      } finally {
        await first.close();
        await second.close();
      }
    },
  );

  postgresTest("atomically quarantines an ordinary failure after execution starts", async () => {
    const value = namespace();
    const first = coordinator(value, "effect-owner", 500);
    const second = coordinator(value, "effect-observer", 500);
    try {
      await first.migrate();
      expect(await first.register()).toEqual({ status: "registered" });
      expect(await second.register()).toEqual({ status: "registered" });
      const effecting = request("failed-effect", "failed-effect-thread");
      expect(await first.admit(effecting)).toEqual({ status: "admitted", attempt: 1 });
      const claimed = await first.claim(effecting);
      if (claimed.status !== "acquired") throw new Error("expected effect lease");
      expect(await first.markExecutionStarted(claimed.lease)).toEqual({ status: "ok" });
      expect(await first.fail(claimed.lease)).toEqual({ status: "outcome-unknown" });
      expect(await second.claim(effecting)).toEqual({ status: "quarantined" });
      expect(await second.admit(request("later-effect", "failed-effect-thread"))).toEqual({
        status: "rejected",
        reason: "thread-quarantined",
      });
    } finally {
      await second.close();
      await first.close();
    }
  });

  postgresTest(
    "quarantines a child killed after an effect begins until explicit recovery",
    async () => {
      const value = namespace();
      const setup = coordinator(value, "setup");
      try {
        await setup.migrate();
      } finally {
        await setup.close();
      }

      const env = { AUGGY_TEST_POSTGRES_URL: url };
      const script = resolve("tests/coordination/fixtures/postgres-coordinator-worker.ts");
      const owner = spawnJsonLineWorker({ script, args: [value, "crashed-owner", "effect"], env });
      workers.add(owner);
      const barrier = createJsonLineBarrier([owner]);
      await barrier.waitUntilReady();
      barrier.release({ event: "GO" });
      const effect = await owner.next();
      expect(effect.event).toBe("EFFECT_BEGUN");
      expect(effect.claimed).toBe("acquired");
      expect(effect.fence).toBe(1);

      // The child is deliberately held after the effect boundary. Killing it
      // prevents a terminal coordinator update; expiry must quarantine rather
      // than permit a second owner to replay the ambiguous effect.
      await owner.kill();
      workers.delete(owner);
      await expireActiveLease(value, "multiprocess-request");

      const recovery = coordinator(value, "recovery-replica", 500);
      try {
        expect(await recovery.register()).toEqual({ status: "registered" });
        expect(
          await recovery.claim(request("multiprocess-request", "multiprocess-thread")),
        ).toEqual({ status: "quarantined" });
        expect(
          await recovery.recover("multiprocess-thread", 1, "terminated-child-reconciled"),
        ).toEqual({ status: "ok" });
        const resumed = request("after-recovery", "multiprocess-thread");
        expect(await recovery.admit(resumed)).toEqual({ status: "admitted", attempt: 1 });
        const fresh = await recovery.claim(resumed);
        expect(fresh.status).toBe("acquired");
        if (fresh.status !== "acquired") throw new Error("expected recovery lease");
        expect(fresh.lease.fence).toBeGreaterThan(1);
        expect(await recovery.complete(fresh.lease, replay())).toEqual({ status: "ok" });
      } finally {
        await recovery.close();
      }
    },
  );

  postgresTest("rejects fresh admission while a replica drains", async () => {
    const value = namespace();
    const draining = coordinator(value, "draining-replica");
    try {
      await draining.migrate();
      expect(await draining.register()).toEqual({ status: "registered" });
      const queued = request("draining-queued", "draining-queued-thread");
      expect(await draining.admit(queued)).toEqual({ status: "admitted", attempt: 1 });
      const signal = draining.ownedSignal(queued);
      expect(signal.aborted).toBeFalse();
      expect(await draining.beginDrain()).toEqual({ status: "ok" });
      expect(signal.aborted).toBeTrue();
      expect(signal.reason).toBe("draining");
      expect(await draining.admit(request("draining", "draining-thread"))).toEqual({
        status: "rejected",
        reason: "draining",
      });
    } finally {
      await draining.close();
    }
  });

  postgresTest("cancels an active local ownership signal when the coordinator closes", async () => {
    const value = namespace();
    const instance = coordinator(value, "closing-replica", 500);
    try {
      await instance.migrate();
      expect(await instance.register()).toEqual({ status: "registered" });
      const active = request("closing-active", "closing-active-thread");
      expect(await instance.admit(active)).toEqual({ status: "admitted", attempt: 1 });
      const claimed = await instance.claim(active);
      if (claimed.status !== "acquired") throw new Error("expected closing lease");
      const signal = instance.ownedSignal(active);
      expect(signal.aborted).toBeFalse();
      await instance.close();
      expect(signal.aborted).toBeTrue();
      expect(signal.reason).toBe("coordinator-closed");
    } finally {
      await instance.close();
    }
  });

  postgresTest(
    "invalidates local authority synchronously and fails later mutations closed",
    async () => {
      const value = namespace();
      const instance = coordinator(value, "invalidated-replica", 500);
      try {
        await instance.migrate();
        expect(await instance.register()).toEqual({ status: "registered" });
        const queued = request("invalidated-queued", "invalidated-thread");
        expect(await instance.admit(queued)).toEqual({ status: "admitted", attempt: 1 });
        const signal = instance.ownedSignal(queued);
        expect(signal.aborted).toBeFalse();

        instance.invalidateLocalAuthority();

        expect(signal.aborted).toBeTrue();
        expect(signal.reason).toBe("coordinator-authority-lost");
        expect(await instance.heartbeatQueued(queued, 1)).toEqual({ status: "unavailable" });
        expect(await instance.claim(queued, 1)).toEqual({ status: "unavailable" });
        expect(await instance.admit(request("after-invalidation", "other-thread"))).toEqual({
          status: "unavailable",
        });
      } finally {
        await instance.close();
      }
    },
  );

  postgresTest(
    "reports the committed result of an operation started before invalidation",
    async () => {
      const value = namespace();
      const sql = new SQL(url!);
      let pauseNextTransaction = false;
      let entered!: () => void;
      const transactionEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const transactionRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      const delayedSql = {
        async begin<T>(
          callback: (transaction: PostgresMigrationExecutor) => Promise<T>,
        ): Promise<T> {
          if (pauseNextTransaction) {
            pauseNextTransaction = false;
            entered();
            await transactionRelease;
          }
          return sql.begin(async (transaction) => {
            const wrapped: PostgresMigrationExecutor = {
              begin: (nested) => nested(wrapped),
              unsafe: (query, values) => transaction.unsafe(query, values),
            };
            return callback(wrapped);
          });
        },
        unsafe: <T extends object = Record<string, unknown>>(query: string, values?: unknown[]) =>
          sql.unsafe<T>(query, values),
      } as NonNullable<PostgresCoordinatorOptions["sql"]>;
      const instance = new PostgresDistributedTurnCoordinator({
        sql: delayedSql,
        namespace: value,
        instanceId: "invalidation-race",
        maxConcurrent: 2,
        maxQueued: 4,
        maxQueuedPerThread: 2,
        leaseMs: 500,
        ...coordinatorPolicy,
      });
      try {
        await instance.migrate();
        expect(await instance.register()).toEqual({ status: "registered" });
        const active = request("invalidation-active", "invalidation-active-thread");
        expect(await instance.admit(active)).toEqual({ status: "admitted", attempt: 1 });
        const activeLease = await instance.claim(active);
        if (activeLease.status !== "acquired") throw new Error("expected active cleanup lease");
        const queued = request("invalidation-race", "invalidation-race-thread");
        expect(await instance.admit(queued)).toEqual({ status: "admitted", attempt: 1 });

        pauseNextTransaction = true;
        const heartbeat = instance.heartbeatQueued(queued, 1);
        await transactionEntered;
        instance.invalidateLocalAuthority();
        release();

        expect(await heartbeat).toEqual({ status: "ok" });
        expect(await instance.heartbeatQueued(queued, 1)).toEqual({ status: "unavailable" });
        expect(await instance.abandon(queued, 1)).toEqual({ status: "ok" });
        expect(await instance.abandon(active, activeLease.lease.attempt)).toEqual({ status: "ok" });
      } finally {
        await instance.close();
        await sql.close();
      }
    },
  );

  postgresTest("health sweeps expired started work and frees zero-queue capacity", async () => {
    const value = namespace();
    const instance = coordinator(value, "health-sweeper", 500, 1, 0);
    try {
      await instance.migrate();
      expect(await instance.register()).toEqual({ status: "registered" });
      const startedRequest = request("health-started", "quarantined-thread");
      await instance.admit(startedRequest);
      const lease = await instance.claim(startedRequest);
      if (lease.status !== "acquired") throw new Error("expected started lease");
      expect(await instance.markExecutionStarted(lease.lease)).toEqual({ status: "ok" });
      await expireActiveLease(value, "health-started");
      expect(await instance.health()).toMatchObject({ quarantined: 1, active: 0 });
      expect(await instance.admit(request("same-thread", "quarantined-thread"))).toEqual({
        status: "rejected",
        reason: "thread-quarantined",
      });
      expect(await instance.admit(request("other-thread", "other-thread"))).toEqual({
        status: "admitted",
        attempt: 1,
      });
    } finally {
      await instance.close();
    }
  });
});
