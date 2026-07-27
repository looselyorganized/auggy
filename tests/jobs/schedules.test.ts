import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSqliteDurableJobStore,
  DURABLE_JOBS_SCHEMA_VERSION,
} from "../../src/jobs/sqlite-store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "auggy-schedules-test-"));
  dirs.push(dir);
  return join(dir, "jobs.sqlite");
}

const minute = 60_000;
const start = Date.UTC(2026, 0, 1, 0, 0, 0);

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    id: "daily_support",
    cron: "* * * * *",
    binding: { agent: "support", peer: "trusted-operator" },
    payload: { version: 1 as const, value: { prompt: "secret scheduled prompt", threadId: "ops" } },
    enabled: true,
    ...overrides,
  };
}

function request(key = "manual") {
  return {
    idempotencyKey: key,
    binding: { agent: "support" },
    payload: { version: 1 as const, value: { prompt: "manual" } },
  };
}

function downgradeExactV1(path: string): void {
  const database = new Database(path);
  database.run("DROP TABLE durable_job_schedule_occurrences");
  database.run("DROP TABLE durable_job_schedules");
  database.run("PRAGMA user_version = 1");
  database.close();
}

describe("durable schedule persistence", () => {
  test("atomically upgrades only the exact branded v1 schema without losing durable state", () => {
    const path = dbPath();
    const now = start;
    const v1 = createSqliteDurableJobStore({
      dbPath: path,
      now: () => now,
      jobId: (() => {
        let number = 0;
        return () => `job_${++number}`;
      })(),
      leaseToken: (() => {
        let number = 0;
        return () => `lease_${++number}`;
      })(),
      incidentId: (() => {
        let number = 0;
        return () => `incident_${++number}`;
      })(),
    });
    const unknown = v1.submit(request("unknown")).job;
    const unknownLease = v1.claim({ workerId: "worker", leaseMs: minute })!;
    v1.markExecutionStarted({ jobId: unknownLease.job.id, token: unknownLease.token });
    v1.markOutcomeUnknown({
      jobId: unknownLease.job.id,
      token: unknownLease.token,
      reasonCode: "execution-outcome-unknown",
    });
    const reconciled = v1.submit(request("reconciled")).job;
    const reconciledLease = v1.claim({ workerId: "worker", leaseMs: minute })!;
    v1.markExecutionStarted({ jobId: reconciledLease.job.id, token: reconciledLease.token });
    const incident = v1.markOutcomeUnknown({
      jobId: reconciledLease.job.id,
      token: reconciledLease.token,
      reasonCode: "execution-outcome-unknown",
    });
    v1.reconcile({
      jobId: incident.id,
      expectedVersion: incident.version,
      disposition: "confirm_completed",
      evidence: "operator-ticket-42",
    });
    const queued = v1.submit(request("queued")).job;
    v1.close();
    downgradeExactV1(path);

    const migrated = createSqliteDurableJobStore({ dbPath: path, now: () => now });
    try {
      expect(migrated.getSummary(queued.id)).toMatchObject({ state: "queued" });
      expect(migrated.getSummary(unknown.id)).toMatchObject({
        state: "outcome_unknown",
        incident: { reasonCode: "execution-outcome-unknown" },
      });
      expect(migrated.getSummary(reconciled.id)).toMatchObject({ state: "completed" });
      expect(migrated.listSchedules()).toEqual([]);
    } finally {
      migrated.close();
    }
    const database = new Database(path);
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(DURABLE_JOBS_SCHEMA_VERSION).toBe(2);
    expect(
      database.query("SELECT COUNT(*) AS count FROM durable_job_reconciliations").get(),
    ).toEqual({
      count: 1,
    });
    database.close();
  });

  test("rejects a malformed branded v1 lookalike before mutating schema or version", () => {
    const path = dbPath();
    const store = createSqliteDurableJobStore({ dbPath: path, now: () => start });
    store.submit(request());
    store.close();
    downgradeExactV1(path);
    const database = new Database(path);
    database.run("CREATE TABLE durable_jobs_lookalike (value TEXT)");
    const before = database
      .query(
        "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all();
    database.close();
    expect(() => createSqliteDurableJobStore({ dbPath: path, now: () => start })).toThrow(
      "database schema is incompatible",
    );
    const after = new Database(path);
    expect(after.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(
      after
        .query(
          "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all(),
    ).toEqual(before);
    after.close();
  });

  test("can refuse an exact v1 migration without changing the database", () => {
    const path = dbPath();
    const store = createSqliteDurableJobStore({ dbPath: path, now: () => start });
    store.submit(request());
    store.close();
    downgradeExactV1(path);

    expect(() =>
      createSqliteDurableJobStore({ dbPath: path, now: () => start, allowMigrations: false }),
    ).toThrow("database schema migration is required");
    const unchanged = new Database(path, { readonly: true });
    expect(unchanged.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(
      unchanged.query("SELECT name FROM sqlite_schema WHERE name = 'durable_job_schedules'").get(),
    ).toBeNull();
    unchanged.close();
  });

  test("non-migrating clients cannot create or initialize a database", () => {
    const missing = dbPath();
    rmSync(missing, { force: true });
    expect(() => createSqliteDurableJobStore({ dbPath: missing, allowMigrations: false })).toThrow(
      "database does not exist",
    );
    // Exclusive creation is also the atomic proof that the refused open did
    // not create the database leaf.
    closeSync(openSync(missing, "wx", 0o600));
    expect(() => createSqliteDurableJobStore({ dbPath: missing, allowMigrations: false })).toThrow(
      "database schema initialization is disabled",
    );
    expect(Bun.file(missing).size).toBe(0);
  });
  test("materializes one deterministic, redacted occurrence and coalesces downtime", () => {
    const path = dbPath();
    let now = start;
    const first = createSqliteDurableJobStore({ dbPath: path, now: () => now });
    try {
      const synced = first.syncSchedules([schedule()]);
      expect(synced).toEqual([
        expect.objectContaining({
          id: "daily_support",
          revision: 1,
          configEnabled: true,
          operatorPaused: false,
          nextFireAt: start + minute,
        }),
      ]);
      expect(JSON.stringify(synced)).not.toContain("secret scheduled prompt");
      now = start + 5 * minute;
      expect(first.materializeDueSchedules()).toEqual({ materialized: 1, remaining: 0 });
      expect(first.list()).toHaveLength(1);
      expect(first.list()[0]).toMatchObject({ state: "queued", availableAt: start + minute });
      expect(first.listSchedules()[0]).toMatchObject({ nextFireAt: start + 6 * minute });
      expect(first.materializeDueSchedules()).toEqual({ materialized: 0, remaining: 0 });
      expect(first.list()).toHaveLength(1);
    } finally {
      first.close();
    }
  });

  test("two handles and restart races cannot create duplicate schedule jobs", () => {
    const path = dbPath();
    let now = start;
    const first = createSqliteDurableJobStore({ dbPath: path, now: () => now });
    first.syncSchedules([schedule()]);
    first.close();
    now += minute;
    const left = createSqliteDurableJobStore({ dbPath: path, now: () => now });
    const right = createSqliteDurableJobStore({ dbPath: path, now: () => now });
    try {
      expect(left.materializeDueSchedules()).toEqual({ materialized: 1, remaining: 0 });
      expect(right.materializeDueSchedules()).toEqual({ materialized: 0, remaining: 0 });
      expect(left.list()).toHaveLength(1);
      // Moving the wall clock backward cannot make the same persisted occurrence due again.
      now -= 30_000;
      expect(right.materializeDueSchedules()).toEqual({ materialized: 0, remaining: 0 });
      expect(right.list()).toHaveLength(1);
    } finally {
      left.close();
      right.close();
    }
  });

  test("commits the deterministic capacity prefix and leaves the remaining schedule due", () => {
    const path = dbPath();
    let now = start;
    const left = createSqliteDurableJobStore({
      dbPath: path,
      now: () => now,
      maxTotalRecords: 2,
      maxQueuedRecords: 1,
      jobId: () => "job_a",
    });
    const right = createSqliteDurableJobStore({
      dbPath: path,
      now: () => now,
      maxTotalRecords: 2,
      maxQueuedRecords: 1,
      jobId: () => "job_b",
    });
    try {
      left.syncSchedules([schedule({ id: "a" }), schedule({ id: "b" })]);
      now += minute;
      expect(left.materializeDueSchedules()).toEqual({ materialized: 1, remaining: 1 });
      expect(left.list()).toEqual([expect.objectContaining({ id: "job_a", state: "queued" })]);
      expect(right.materializeDueSchedules()).toEqual({ materialized: 0, remaining: 1 });
      const schedules = right.listSchedules();
      expect(schedules.find((entry) => entry.id === "a")).toMatchObject({
        nextFireAt: start + 2 * minute,
      });
      expect(schedules.find((entry) => entry.id === "b")).toMatchObject({
        nextFireAt: start + minute,
      });
      const lease = left.claim({ workerId: "worker", leaseMs: minute })!;
      left.markExecutionStarted({ jobId: lease.job.id, token: lease.token });
      left.complete({ jobId: lease.job.id, token: lease.token, result: { ok: true } });
      expect(right.materializeDueSchedules()).toEqual({ materialized: 1, remaining: 0 });
      expect(right.list()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "job_a", state: "completed" }),
          expect.objectContaining({ id: "job_b", state: "queued" }),
        ]),
      );
    } finally {
      left.close();
      right.close();
    }
  });

  test("revision, declarative disable, and operator pause remain separate", () => {
    let now = start;
    const store = createSqliteDurableJobStore({ dbPath: dbPath(), now: () => now });
    try {
      const initial = store.syncSchedules([schedule()])[0]!;
      const paused = store.pauseSchedule({
        scheduleId: initial.id,
        expectedVersion: initial.version,
      });
      expect(paused).toMatchObject({
        paused: true,
        schedule: { operatorPaused: true, enabled: false },
      });
      const changed = store.syncSchedules([
        schedule({ binding: { agent: "support", peer: "changed" } }),
      ])[0]!;
      expect(changed).toMatchObject({ revision: 2, operatorPaused: true, enabled: false });
      expect(
        store.syncSchedules([schedule({ binding: { agent: "support", peer: "changed" } })])[0],
      ).toMatchObject({ version: changed.version, revision: 2, operatorPaused: true });
      now += 10 * minute;
      expect(store.materializeDueSchedules()).toEqual({ materialized: 0, remaining: 0 });
      expect(
        store.resumeSchedule({ scheduleId: changed.id, expectedVersion: changed.version }),
      ).toMatchObject({
        resumed: true,
        schedule: { enabled: true },
      });
      expect(store.materializeDueSchedules()).toEqual({ materialized: 1, remaining: 0 });
      expect(store.syncSchedules([])[0]).toMatchObject({
        configEnabled: false,
        operatorPaused: false,
      });
      now += minute;
      expect(store.materializeDueSchedules()).toEqual({ materialized: 0, remaining: 0 });
    } finally {
      store.close();
    }
  });

  test("bounds definitions and rolls schedule progress back when job capacity is exhausted", () => {
    let now = start;
    const store = createSqliteDurableJobStore({
      dbPath: dbPath(),
      now: () => now,
      maxTotalRecords: 1,
      maxQueuedRecords: 1,
    });
    try {
      expect(() =>
        store.syncSchedules(
          Array.from({ length: 101 }, (_, index) => schedule({ id: `s${index}` })),
        ),
      ).toThrow("at most 100");
      store.syncSchedules([schedule()]);
      store.submit(request());
      now += minute;
      expect(store.materializeDueSchedules()).toEqual({ materialized: 0, remaining: 1 });
      expect(store.list()).toHaveLength(1);
      expect(store.listSchedules()[0]).toMatchObject({ nextFireAt: start + minute });
    } finally {
      store.close();
    }
  });

  test("enforces separate schedule-private and future materialized-job budgets at sync", () => {
    const aggregate = createSqliteDurableJobStore({
      dbPath: dbPath(),
      now: () => start,
      maxSchedulePrivateBytes: 1,
    });
    try {
      expect(() => aggregate.syncSchedules([schedule()])).toThrow(
        "schedule private byte capacity exhausted",
      );
    } finally {
      aggregate.close();
    }
    const materialized = createSqliteDurableJobStore({
      dbPath: dbPath(),
      now: () => start,
      maxPrivateBytes: 1,
    });
    try {
      expect(() => materialized.syncSchedules([schedule()])).toThrow(
        "schedule definition exceeds job private byte capacity",
      );
    } finally {
      materialized.close();
    }
  });

  test("does not invoke schedule-definition accessors", () => {
    const store = createSqliteDurableJobStore({ dbPath: dbPath(), now: () => start });
    try {
      for (const accessor of ["id", "cron", "binding", "payload", "enabled"] as const) {
        let getterCalls = 0;
        const definition: Record<string, unknown> = {
          id: "safe_id",
          cron: "* * * * *",
          binding: { agent: "support" },
          payload: { version: 1, value: { prompt: "secret" } },
          enabled: true,
        };
        Object.defineProperty(definition, accessor, {
          enumerable: true,
          get() {
            getterCalls++;
            return undefined;
          },
        });
        expect(() => store.syncSchedules([definition as never])).toThrow(
          "schedule definition is invalid",
        );
        expect(getterCalls).toBe(0);
      }
    } finally {
      store.close();
    }
  });

  test("keeps persisted schedule storage bounded even when configuration rotates IDs", () => {
    let now = start;
    const store = createSqliteDurableJobStore({ dbPath: dbPath(), now: () => now });
    try {
      store.syncSchedules(Array.from({ length: 100 }, (_, index) => schedule({ id: `s${index}` })));
      now += minute;
      expect(store.materializeDueSchedules({ limit: 100 })).toEqual({
        materialized: 100,
        remaining: 0,
      });
      expect(() => store.syncSchedules([schedule({ id: "s100" })])).toThrow(
        "schedule capacity exhausted",
      );
      expect(store.listSchedules()).toHaveLength(100);
    } finally {
      store.close();
    }
  });

  test("schedule state is validated on restart and occurrences are tied to job retention", () => {
    const path = dbPath();
    let now = start;
    const store = createSqliteDurableJobStore({ dbPath: path, now: () => now });
    store.syncSchedules([schedule()]);
    now += minute;
    store.materializeDueSchedules();
    const lease = store.claim({ workerId: "worker", leaseMs: minute })!;
    store.markExecutionStarted({ jobId: lease.job.id, token: lease.token });
    store.complete({ jobId: lease.job.id, token: lease.token, result: { ok: true } });
    now += minute;
    expect(store.prune({ before: now })).toBe(1);
    store.close();
    const database = new Database(path);
    expect(
      database.query("SELECT COUNT(*) AS count FROM durable_job_schedule_occurrences").get(),
    ).toEqual({ count: 0 });
    database.run("UPDATE durable_job_schedules SET cron = 'not-a-cron'");
    database.close();
    expect(() => createSqliteDurableJobStore({ dbPath: path, now: () => now })).toThrow(
      "schedule cron is invalid",
    );
  });

  test("retries only a definite failure with compare-and-set", () => {
    const now = start;
    const store = createSqliteDurableJobStore({ dbPath: dbPath(), now: () => now });
    try {
      const job = store.submit(request()).job;
      const lease = store.claim({ workerId: "worker", leaseMs: minute })!;
      store.markExecutionStarted({ jobId: lease.job.id, token: lease.token });
      const failed = store.failDefinite({
        jobId: lease.job.id,
        token: lease.token,
        errorCode: "execution-failed",
      });
      expect(store.retryFailed({ jobId: job.id, expectedVersion: failed.version - 1 })).toEqual({
        retried: false,
      });
      expect(store.retryFailed({ jobId: job.id, expectedVersion: failed.version })).toMatchObject({
        retried: true,
        job: { state: "queued" },
      });
      expect(store.retryFailed({ jobId: job.id, expectedVersion: failed.version + 1 })).toEqual({
        retried: false,
      });
    } finally {
      store.close();
    }
  });

  test("persists a retried definite failure with a coherent attempt history", () => {
    const path = dbPath();
    const now = start;
    const first = createSqliteDurableJobStore({ dbPath: path, now: () => now });
    const job = first.submit(request()).job;
    const lease = first.claim({ workerId: "worker", leaseMs: minute })!;
    first.markExecutionStarted({ jobId: lease.job.id, token: lease.token });
    const failed = first.failDefinite({
      jobId: lease.job.id,
      token: lease.token,
      errorCode: "execution-failed",
    });
    const retried = first.retryFailed({ jobId: job.id, expectedVersion: failed.version });
    expect(retried).toMatchObject({ retried: true, job: { state: "queued", attempt: 1 } });
    first.close();

    const reopened = createSqliteDurableJobStore({ dbPath: path, now: () => now });
    try {
      expect(reopened.getSummary(job.id)).toMatchObject({ state: "queued", attempt: 1 });
      expect(reopened.retryFailed({ jobId: job.id, expectedVersion: failed.version })).toEqual({
        retried: false,
      });
      expect(reopened.claim({ workerId: "worker", leaseMs: minute })).toMatchObject({
        job: { id: job.id, attempt: 2, state: "leased" },
      });
    } finally {
      reopened.close();
    }
  });

  test("does not let retrying a failed job exceed the outstanding capacity", () => {
    const now = start;
    const store = createSqliteDurableJobStore({
      dbPath: dbPath(),
      now: () => now,
      maxTotalRecords: 2,
      maxQueuedRecords: 1,
    });
    try {
      const first = store.submit(request("failed")).job;
      const lease = store.claim({ workerId: "worker", leaseMs: minute })!;
      store.markExecutionStarted({ jobId: lease.job.id, token: lease.token });
      const failed = store.failDefinite({
        jobId: lease.job.id,
        token: lease.token,
        errorCode: "execution-failed",
      });
      store.submit(request("active"));
      expect(store.retryFailed({ jobId: first.id, expectedVersion: failed.version })).toEqual({
        retried: false,
      });
      expect(store.getSummary(first.id)).toMatchObject({
        state: "failed",
        version: failed.version,
      });
    } finally {
      store.close();
    }
  });
});
