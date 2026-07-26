import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDurableJobStore } from "../../src/jobs/sqlite-store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "auggy-jobs-test-"));
  dirs.push(dir);
  return join(dir, "jobs.sqlite");
}

function request(key = "checkout-1") {
  return {
    idempotencyKey: key,
    binding: { agent: "support", thread: "order-42" },
    payload: { version: 1 as const, value: { prompt: "Where is my order?" } },
  };
}

describe("SQLite durable job store", () => {
  test("mints IDs and makes an idempotency binding immutable", () => {
    const store = createSqliteDurableJobStore({ dbPath: dbPath(), jobId: () => "job_1" });
    try {
      expect(store.submit(request())).toMatchObject({ status: "created", job: { id: "job_1" } });
      expect(store.submit(request())).toMatchObject({ status: "joined", job: { id: "job_1" } });
      expect(() => store.submit({ ...request(), binding: { agent: "other" } })).toThrow(
        "idempotency binding conflicts",
      );
      expect(store.list()).toEqual([
        expect.objectContaining({ id: "job_1", state: "queued", attempt: 0, version: 1 }),
      ]);
    } finally {
      store.close();
    }
  });

  test("grants one fenced lease across handles and rejects a stale worker", () => {
    const path = dbPath();
    const first = createSqliteDurableJobStore({
      dbPath: path,
      now: () => 1_000,
      jobId: () => "job_1",
      leaseToken: () => "lease_first",
    });
    const second = createSqliteDurableJobStore({
      dbPath: path,
      now: () => 1_000,
      leaseToken: () => "lease_second",
    });
    try {
      first.submit(request());
      const lease = first.claim({ workerId: "worker-a", leaseMs: 100 });
      expect(lease).toMatchObject({ job: { id: "job_1", state: "leased" }, token: "lease_first" });
      expect(second.claim({ workerId: "worker-b", leaseMs: 100 })).toBeNull();
      expect(first.markExecutionStarted({ jobId: "job_1", token: "lease_first" })).toMatchObject({
        state: "running",
      });
      expect(() =>
        second.complete({ jobId: "job_1", token: "lease_second", result: { ok: true } }),
      ).toThrow("lease is no longer active");
      expect(first.heartbeat({ jobId: "job_1", token: "lease_first", leaseMs: 100 })).toMatchObject(
        {
          state: "running",
        },
      );
    } finally {
      first.close();
      second.close();
    }
  });

  test("releases a definite pre-start failure and requires CAS cancellation", () => {
    const store = createSqliteDurableJobStore({
      dbPath: dbPath(),
      now: () => 1_000,
      jobId: () => "job_1",
      leaseToken: () => "lease_1",
    });
    try {
      const submitted = store.submit(request());
      const lease = store.claim({ workerId: "worker-a", leaseMs: 100 })!;
      expect(
        store.releaseUnstarted({
          jobId: lease.job.id,
          token: lease.token,
          errorCode: "runtime-admission-failed",
        }),
      ).toMatchObject({ state: "queued", attempt: 1 });
      expect(store.cancel({ jobId: submitted.job.id } as never)).toEqual({
        status: "version_conflict",
      });
      const queued = store.get(submitted.job.id)!;
      expect(store.cancel({ jobId: queued.id, expectedVersion: queued.version })).toMatchObject({
        status: "canceled",
      });
      const terminal = store.get(queued.id)!;
      expect(store.cancel({ jobId: terminal.id, expectedVersion: terminal.version })).toMatchObject(
        {
          status: "unchanged",
          job: { state: "canceled" },
        },
      );
    } finally {
      store.close();
    }
  });

  test("recovers unstarted work and quarantines started work on restart", () => {
    const path = dbPath();
    let store = createSqliteDurableJobStore({
      dbPath: path,
      now: () => 2_000,
      jobId: (() => {
        let count = 0;
        return () => `job_${++count}`;
      })(),
      leaseToken: (() => {
        let count = 0;
        return () => `lease_${++count}`;
      })(),
      incidentId: () => "incident_1",
    });
    store.submit(request("queued"));
    store.submit(request("started"));
    const queued = store.claim({ workerId: "a", leaseMs: 100 })!;
    const started = store.claim({ workerId: "a", leaseMs: 100 })!;
    store.markExecutionStarted({ jobId: started.job.id, token: started.token });
    store.close();

    store = createSqliteDurableJobStore({
      dbPath: path,
      now: () => 2_100,
      incidentId: () => "incident_1",
    });
    try {
      expect(store.recoverInterrupted()).toEqual({ requeued: 1, quarantined: 1 });
      expect(store.get(queued.job.id)).toMatchObject({ state: "queued" });
      expect(store.get(started.job.id)).toMatchObject({
        state: "outcome_unknown",
        incident: { id: "incident_1", version: 1 },
      });
      expect(
        store.reconcile({
          jobId: started.job.id,
          expectedVersion: store.get(started.job.id)!.version,
          disposition: "retry",
          evidence: "operator verified that no external effect occurred",
        }),
      ).toMatchObject({ reconciled: true, job: { state: "queued" } });
    } finally {
      store.close();
    }
  });

  test("persists cancellation, bounds private payloads, and rejects foreign schemas", () => {
    const path = dbPath();
    const store = createSqliteDurableJobStore({ dbPath: path, jobId: () => "job_1" });
    try {
      const submitted = store.submit(request());
      expect(
        store.cancel({ jobId: submitted.job.id, expectedVersion: submitted.job.version }),
      ).toMatchObject({
        status: "canceled",
      });
      expect(() =>
        store.submit({ ...request("large"), payload: { version: 1, value: "x".repeat(70_000) } }),
      ).toThrow("payload exceeds");
      expect(JSON.stringify(store.list())).not.toContain("Where is my order?");
    } finally {
      store.close();
    }

    const foreign = new Database(`${path}.foreign`);
    foreign.run("CREATE TABLE foreign_data (secret TEXT)");
    foreign.close();
    expect(() => createSqliteDurableJobStore({ dbPath: `${path}.foreign` })).toThrow(
      "recognized legacy schema",
    );
  });
});
