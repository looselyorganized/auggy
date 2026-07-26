import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { resolve } from "node:path";
import { PostgresDistributedTurnCoordinator } from "../../src/coordination";
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

function coordinator(
  namespace: string,
  instanceId: string,
  leaseMs = 80,
  maxConcurrent = 2,
  maxQueued = 4,
) {
  return new PostgresDistributedTurnCoordinator({
    url: url!,
    namespace,
    instanceId,
    maxConcurrent,
    maxQueued,
    maxQueuedPerThread: Math.min(2, maxQueued),
    leaseMs,
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
      sql: shadowedExecutor,
    });
    try {
      await sql.unsafe(`CREATE SCHEMA ${shadow}`);
      await sql.unsafe(
        `CREATE TABLE ${shadow}.auggy_coordination_namespaces (namespace TEXT PRIMARY KEY)`,
      );
      await instance.migrate();
      expect(await instance.setDraining(false)).toEqual({ status: "ok" });
      expect(await instance.admit(request("shadow-request"))).toEqual({ status: "admitted" });
      expect(await instance.cancel({ requestId: "shadow-request", bindingHash: hash })).toEqual({
        status: "ok",
      });

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
      const duplicate = ["inheritance", "duplicate", "thread", "source", hash, "queued"];
      await sql.unsafe(
        `INSERT INTO ${schema}.auggy_coordination_requests (namespace, request_id, thread_id, source_id, binding_hash, state) VALUES ($1, $2, $3, $4, $5, $6)`,
        duplicate,
      );
      await sql.unsafe(
        `INSERT INTO ${schema}.auggy_coordination_requests_child (namespace, request_id, thread_id, source_id, binding_hash, state) VALUES ($1, $2, $3, $4, $5, $6)`,
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

  postgresTest("enforces fleet capacity, binding integrity, and namespace isolation", async () => {
    const one = namespace();
    const two = namespace();
    const first = coordinator(one, "replica-a", 80, 1);
    const second = coordinator(one, "replica-b", 80, 1);
    const isolated = coordinator(two, "replica-c");
    try {
      await first.migrate();
      await first.admit(request("one", "thread-one"));
      await second.admit(request("two", "thread-two"));
      const claimed = await first.claim(request("one", "thread-one"));
      expect(claimed.status).toBe("acquired");
      expect(await second.claim(request("two", "thread-two"))).toEqual({ status: "waiting" });
      expect(await second.admit(request("one", "thread-other"))).toEqual({ status: "conflict" });
      expect(await second.admit(request("thread-wait-1", "thread-one"))).toEqual({
        status: "admitted",
      });
      expect(await second.admit(request("thread-wait-2", "thread-one"))).toEqual({
        status: "admitted",
      });
      expect(await second.admit(request("thread-wait-3", "thread-one"))).toEqual({
        status: "rejected",
        reason: "thread-capacity",
      });

      expect(await isolated.admit(request("one", "thread-one"))).toEqual({ status: "admitted" });
      expect((await isolated.claim(request("one", "thread-one"))).status).toBe("acquired");
    } finally {
      await first.close();
      await second.close();
      await isolated.close();
    }
  });

  postgresTest(
    "uses forced database lease expiry to quarantine started work and reject stale fences",
    async () => {
      const value = namespace();
      const first = coordinator(value, "replica-a", 500);
      const second = coordinator(value, "replica-b", 500);
      try {
        await first.migrate();
        await first.admit(request("unstarted", "reclaimable-thread"));
        const old = await first.claim(request("unstarted", "reclaimable-thread"));
        if (old.status !== "acquired") throw new Error("expected initial lease");
        await expireActiveLease(value, "unstarted");
        const fresh = await second.claim(request("unstarted", "reclaimable-thread"));
        if (fresh.status !== "acquired") throw new Error("expected reclaimed lease");
        expect(fresh.lease.fence).toBeGreaterThan(old.lease.fence);
        expect(await first.complete(old.lease)).toEqual({ status: "stale" });
        expect(await second.complete(fresh.lease)).toEqual({ status: "ok" });

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
            "replica-a was terminated after lease loss",
          ),
        ).toEqual({ status: "ok" });

        const sql = new SQL(url!);
        try {
          const events = await sql.unsafe<Array<{ reason: string }>>(
            "SELECT reason FROM auggy_coordination_events WHERE namespace = $1 AND thread_id = $2 AND event_type = 'operator_recovery'",
            [value, "quarantined-thread"],
          );
          expect(events).toEqual([{ reason: "replica-a was terminated after lease loss" }]);
        } finally {
          await sql.close();
        }
      } finally {
        await first.close();
        await second.close();
      }
    },
  );

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
        expect(
          await recovery.claim(request("multiprocess-request", "multiprocess-thread")),
        ).toEqual({ status: "quarantined" });
        expect(
          await recovery.recover(
            "multiprocess-thread",
            1,
            "terminated child reconciled after an ambiguous effect",
          ),
        ).toEqual({ status: "ok" });
        const resumed = request("after-recovery", "multiprocess-thread");
        expect(await recovery.admit(resumed)).toEqual({ status: "admitted" });
        const fresh = await recovery.claim(resumed);
        expect(fresh.status).toBe("acquired");
        if (fresh.status !== "acquired") throw new Error("expected recovery lease");
        expect(fresh.lease.fence).toBeGreaterThan(1);
        expect(await recovery.complete(fresh.lease)).toEqual({ status: "ok" });
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
      expect(await draining.setDraining(true)).toEqual({ status: "ok" });
      expect(await draining.admit(request("draining", "draining-thread"))).toEqual({
        status: "rejected",
        reason: "draining",
      });
    } finally {
      await draining.close();
    }
  });

  postgresTest("health sweeps expired started work and frees zero-queue capacity", async () => {
    const value = namespace();
    const instance = coordinator(value, "health-sweeper", 500, 1, 0);
    try {
      await instance.migrate();
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
      });
    } finally {
      await instance.close();
    }
  });
});
