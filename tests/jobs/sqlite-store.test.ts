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
      expect(lease).toMatchObject({
        job: { id: "job_1", state: "leased" },
        payload: request().payload,
        token: "lease_first",
      });
      expect(JSON.stringify(first.list())).not.toContain("Where is my order?");
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

  test("uses one timestamp per transition and fences exactly at lease expiry", () => {
    const path = dbPath();
    let at = 1_000;
    let clockCalls = 0;
    const clock = () => {
      clockCalls++;
      return at;
    };
    const first = createSqliteDurableJobStore({
      dbPath: path,
      now: clock,
      jobId: () => "job_1",
      leaseToken: () => "lease_old",
    });
    const second = createSqliteDurableJobStore({
      dbPath: path,
      now: clock,
      leaseToken: () => "lease_new",
    });
    try {
      first.submit(request());
      const old = first.claim({ workerId: "old", leaseMs: 10 })!;
      at = 1_005;
      clockCalls = 0;
      expect(first.markExecutionStarted({ jobId: old.job.id, token: old.token })).toMatchObject({
        state: "running",
        updatedAt: at,
      });
      expect(clockCalls).toBe(1);
      at = old.expiresAt;
      clockCalls = 0;
      expect(second.claim({ workerId: "new", leaseMs: 10 })).toBeNull();
      expect(clockCalls).toBe(1);
      expect(second.get(old.job.id)).toMatchObject({
        state: "outcome_unknown",
        incident: { reasonCode: "lease-expired" },
      });
      expect(() => first.complete({ jobId: old.job.id, token: old.token, result: {} })).toThrow(
        "lease is no longer active",
      );
    } finally {
      first.close();
      second.close();
    }
  });

  test("atomically recovers expired unstarted leases before claim but leaves live leases alone", () => {
    const path = dbPath();
    let at = 2_000;
    let token = 0;
    const first = createSqliteDurableJobStore({
      dbPath: path,
      now: () => at,
      jobId: () => "job_1",
      leaseToken: () => `lease_${++token}`,
    });
    const second = createSqliteDurableJobStore({
      dbPath: path,
      now: () => at,
      leaseToken: () => `lease_${++token}`,
    });
    try {
      first.submit(request());
      const old = first.claim({ workerId: "old", leaseMs: 10 })!;
      expect(second.recoverExpiredLeases()).toEqual({ requeued: 0, quarantined: 0 });
      expect(second.get(old.job.id)).toMatchObject({ state: "leased" });
      at = old.expiresAt;
      const replacement = second.claim({ workerId: "new", leaseMs: 10 })!;
      expect(replacement).toMatchObject({ job: { id: old.job.id, state: "leased", attempt: 2 } });
      expect(replacement.token).not.toBe(old.token);
      expect(() =>
        first.releaseUnstarted({
          jobId: old.job.id,
          token: old.token,
          errorCode: "admission-failed",
        }),
      ).toThrow("lease is no longer active");
    } finally {
      first.close();
      second.close();
    }
  });

  test("rejects every fenced worker transition at the deterministic expiry boundary", () => {
    const actions = [
      "markExecutionStarted",
      "heartbeat",
      "releaseUnstarted",
      "rejectUnstarted",
      "complete",
      "failDefinite",
      "markOutcomeUnknown",
    ] as const;
    for (const action of actions) {
      let at = 5_000;
      const store = createSqliteDurableJobStore({
        dbPath: dbPath(),
        now: () => at,
        jobId: () => `job_${action}`,
        leaseToken: () => `lease_${action}`,
      });
      try {
        store.submit(request(action));
        const lease = store.claim({ workerId: "worker", leaseMs: 10 })!;
        if (["complete", "failDefinite", "markOutcomeUnknown"].includes(action)) {
          at += 1;
          store.markExecutionStarted({ jobId: lease.job.id, token: lease.token });
        }
        at = lease.expiresAt;
        const transition = () => {
          if (action === "markExecutionStarted") {
            store.markExecutionStarted({ jobId: lease.job.id, token: lease.token });
          } else if (action === "heartbeat") {
            store.heartbeat({ jobId: lease.job.id, token: lease.token, leaseMs: 10 });
          } else if (action === "releaseUnstarted") {
            store.releaseUnstarted({
              jobId: lease.job.id,
              token: lease.token,
              errorCode: "admission-failed",
            });
          } else if (action === "rejectUnstarted") {
            store.rejectUnstarted({
              jobId: lease.job.id,
              token: lease.token,
              errorCode: "admission-rejected",
            });
          } else if (action === "complete") {
            store.complete({ jobId: lease.job.id, token: lease.token, result: {} });
          } else if (action === "failDefinite") {
            store.failDefinite({
              jobId: lease.job.id,
              token: lease.token,
              errorCode: "execution-failed",
            });
          } else {
            store.markOutcomeUnknown({
              jobId: lease.job.id,
              token: lease.token,
              reasonCode: "execution-outcome-unknown",
            });
          }
        };
        expect(transition).toThrow("lease is no longer active");
      } finally {
        store.close();
      }
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
          errorCode: "admission-failed",
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

  test("terminally rejects unstarted work and exposes a redacted point lookup", () => {
    const store = createSqliteDurableJobStore({
      dbPath: dbPath(),
      now: () => 1_000,
      jobId: () => "job_rejected",
      leaseToken: () => "lease_rejected",
    });
    try {
      const submitted = store.submit(request("reject"));
      expect(JSON.stringify(store.getSummary(submitted.job.id))).not.toContain(
        "Where is my order?",
      );
      const lease = store.claim({ workerId: "worker", leaseMs: 100 })!;
      const sentinel = "sk-live-secret-rejection";
      expect(() =>
        store.rejectUnstarted({
          jobId: lease.job.id,
          token: lease.token,
          errorCode: sentinel as never,
        }),
      ).toThrow("errorCode is not allowed");
      expect(JSON.stringify(store.getSummary(lease.job.id))).not.toContain(sentinel);
      expect(
        store.rejectUnstarted({
          jobId: lease.job.id,
          token: lease.token,
          errorCode: "admission-failed",
        }),
      ).toMatchObject({ state: "failed" });
      expect(store.getSummary(lease.job.id)).toMatchObject({ state: "failed" });
      expect(JSON.stringify(store.getSummary(lease.job.id))).not.toContain("Where is my order?");
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
      expect(store.recoverExpiredLeases()).toEqual({ requeued: 1, quarantined: 1 });
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
      ).toThrow("private JSON exceeds");
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

  test("reserves queue capacity across claims and enforces total and private-byte capacities", () => {
    const store = createSqliteDurableJobStore({
      dbPath: dbPath(),
      maxTotalRecords: 2,
      maxQueuedRecords: 1,
      maxPrivateBytes: 1_000,
      jobId: (() => {
        let id = 0;
        return () => `job_${++id}`;
      })(),
      leaseToken: () => "lease_1",
    });
    try {
      const first = store.submit(request("one"));
      expect(() => store.submit(request("queued-overflow"))).toThrow(
        "outstanding job capacity exhausted",
      );
      const lease = store.claim({ workerId: "worker", leaseMs: 100 })!;
      // A claim keeps its queue reservation. This is the former bypass: a new
      // submission could fill the vacated queue slot, then a release produced
      // two queued jobs despite maxQueuedRecords: 1.
      expect(() => store.submit(request("claimed-overflow"))).toThrow(
        "outstanding job capacity exhausted",
      );
      store.releaseUnstarted({
        jobId: first.job.id,
        token: lease.token,
        errorCode: "admission-failed",
      });
      expect(store.list({ state: "queued" })).toHaveLength(1);
      expect(() => store.submit(request("released-overflow"))).toThrow(
        "outstanding job capacity exhausted",
      );
    } finally {
      store.close();
    }

    const total = createSqliteDurableJobStore({
      dbPath: dbPath(),
      maxTotalRecords: 2,
      maxQueuedRecords: 2,
      jobId: (() => {
        let id = 0;
        return () => `job_total_${++id}`;
      })(),
      leaseToken: () => "lease_total",
    });
    try {
      total.submit(request("total-one"));
      total.claim({ workerId: "worker", leaseMs: 100 });
      total.submit(request("total-two"));
      expect(() => total.submit(request("total-overflow"))).toThrow(
        "total record capacity exhausted",
      );
    } finally {
      total.close();
    }

    const bytes = createSqliteDurableJobStore({
      dbPath: dbPath(),
      maxPrivateBytes: 80,
      jobId: () => "job_bytes",
    });
    try {
      expect(() => bytes.submit(request("bytes"))).toThrow("private byte capacity exhausted");
      expect(bytes.list()).toEqual([]);
    } finally {
      bytes.close();
    }

    const path = dbPath();
    const first = createSqliteDurableJobStore({
      dbPath: path,
      maxTotalRecords: 1,
      maxQueuedRecords: 1,
      jobId: () => "job_first",
    });
    const second = createSqliteDurableJobStore({
      dbPath: path,
      maxTotalRecords: 1,
      maxQueuedRecords: 1,
      jobId: () => "job_second",
    });
    try {
      first.submit(request("first-handle"));
      expect(() => second.submit(request("second-handle"))).toThrow(
        "total record capacity exhausted",
      );
      expect(second.list()).toHaveLength(1);
    } finally {
      first.close();
      second.close();
    }
  });

  test("preflights large strings, safe timestamp addition, and secret-like reason codes", () => {
    const path = dbPath();
    let at = Number.MAX_SAFE_INTEGER - 5;
    const store = createSqliteDurableJobStore({
      dbPath: path,
      now: () => at,
      jobId: () => "job_1",
      leaseToken: () => "lease_1",
    });
    try {
      expect(() =>
        store.submit({
          ...request("huge"),
          payload: { version: 1, value: "x".repeat(1024 * 1024) },
        }),
      ).toThrow("private JSON exceeds");
      store.submit(request());
      expect(() => store.claim({ workerId: "worker", leaseMs: 10 })).toThrow(
        "timestamp addition exceeds",
      );
    } finally {
      store.close();
    }

    at = 3_000;
    const reasons = createSqliteDurableJobStore({
      dbPath: dbPath(),
      now: () => at,
      jobId: () => "job_2",
      leaseToken: () => "lease_2",
    });
    const sentinel = "secret-api-key";
    try {
      const job = reasons.submit(request("reason"));
      const lease = reasons.claim({ workerId: "worker", leaseMs: 100 })!;
      reasons.markExecutionStarted({ jobId: job.job.id, token: lease.token });
      expect(() =>
        reasons.markOutcomeUnknown({
          jobId: job.job.id,
          token: lease.token,
          reasonCode: sentinel,
        }),
      ).toThrow("reasonCode is not allowed");
      expect(JSON.stringify(reasons.list())).not.toContain(sentinel);
    } finally {
      reasons.close();
    }
  });

  test("bounds per-job attempts and global reconciliation audit history", () => {
    expect(() =>
      createSqliteDurableJobStore({ dbPath: dbPath(), maxAttemptsPerJob: 1_001 }),
    ).toThrow("maxAttemptsPerJob must be an integer from 1 to 1000");
    expect(() =>
      createSqliteDurableJobStore({ dbPath: dbPath(), maxAuditRecords: 1_000_001 }),
    ).toThrow("maxAuditRecords must be an integer from 1 to 1000000");

    const path = dbPath();
    let token = 0;
    let incident = 0;
    const store = createSqliteDurableJobStore({
      dbPath: path,
      now: () => 10_000,
      maxAttemptsPerJob: 2,
      maxAuditRecords: 2,
      jobId: () => "job_1",
      leaseToken: () => `lease_${++token}`,
      incidentId: () => `incident_${++incident}`,
    });
    try {
      const submitted = store.submit(request("bounded-history"));
      for (let attempt = 0; attempt < 2; attempt++) {
        const lease = store.claim({ workerId: "worker", leaseMs: 100 })!;
        store.markExecutionStarted({ jobId: lease.job.id, token: lease.token });
        const unknown = store.markOutcomeUnknown({
          jobId: lease.job.id,
          token: lease.token,
          reasonCode: "execution-outcome-unknown",
        });
        expect(
          store.reconcile({
            jobId: lease.job.id,
            expectedVersion: unknown.version,
            disposition: "retry",
            evidence: `operator-evidence-${attempt}`,
          }),
        ).toMatchObject({ reconciled: true, job: { state: "queued" } });
      }
      // A third claim would previously create a third attempt after the
      // operator had repeatedly reconciled the same durable job.
      expect(store.claim({ workerId: "worker", leaseMs: 100 })).toBeNull();
      expect(store.get(submitted.job.id)).toMatchObject({
        state: "failed",
        attempt: 2,
        errorCode: "attempt-limit-exceeded",
      });
      const probe = new Database(path, { readonly: true });
      expect(
        probe
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM durable_job_attempts")
          .get()?.count,
      ).toBe(2);
      expect(
        probe
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM durable_job_reconciliations")
          .get()?.count,
      ).toBe(2);
      probe.close();
    } finally {
      store.close();
    }

    const auditPath = dbPath();
    let auditToken = 0;
    let auditIncident = 0;
    const audit = createSqliteDurableJobStore({
      dbPath: auditPath,
      now: () => 20_000,
      maxAuditRecords: 1,
      jobId: (() => {
        let id = 0;
        return () => `job_audit_${++id}`;
      })(),
      leaseToken: () => `lease_audit_${++auditToken}`,
      incidentId: () => `incident_audit_${++auditIncident}`,
    });
    try {
      const first = audit.submit(request("first-audit"));
      const second = audit.submit(request("second-audit"));
      for (const job of [first.job, second.job]) {
        const lease = audit.claim({ workerId: "worker", leaseMs: 100 })!;
        expect(lease.job.id).toBe(job.id);
        audit.markExecutionStarted({ jobId: job.id, token: lease.token });
        const unknown = audit.markOutcomeUnknown({
          jobId: job.id,
          token: lease.token,
          reasonCode: "execution-outcome-unknown",
        });
        if (job.id === first.job.id) {
          expect(
            audit.reconcile({
              jobId: job.id,
              expectedVersion: unknown.version,
              disposition: "cancel",
              evidence: "first operator decision",
            }),
          ).toMatchObject({ reconciled: true });
        } else {
          expect(() =>
            audit.reconcile({
              jobId: job.id,
              expectedVersion: unknown.version,
              disposition: "cancel",
              evidence: "second operator decision",
            }),
          ).toThrow("reconciliation audit capacity exhausted");
          expect(audit.get(job.id)).toMatchObject({ state: "outcome_unknown" });
        }
      }
    } finally {
      audit.close();
    }
  });

  test("rejects oversized object key sets before canonical JSON serialization", () => {
    const value: Record<string, number> = {};
    for (let index = 0; index < 10_000; index++) value[`key_${index}`] = index;
    const store = createSqliteDurableJobStore({ dbPath: dbPath() });
    try {
      expect(() =>
        store.submit({ ...request("many-keys"), payload: { version: 1, value } }),
      ).toThrow("private JSON exceeds maximum nodes");
      expect(store.list()).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("ordinary pruning preserves reconciliation audits and explicit audit pruning honors retention", () => {
    const path = dbPath();
    let at = 100_000_000;
    const options = {
      dbPath: path,
      now: () => at,
      terminalRetentionMs: 1,
      auditRetentionMs: 86_400_000,
      jobId: () => "job_1",
      leaseToken: () => "lease_1",
      incidentId: () => "incident_1",
    };
    let store = createSqliteDurableJobStore(options);
    try {
      store.submit(request());
      const lease = store.claim({ workerId: "worker", leaseMs: 100 })!;
      store.markExecutionStarted({ jobId: lease.job.id, token: lease.token });
      const unknown = store.markOutcomeUnknown({
        jobId: lease.job.id,
        token: lease.token,
        reasonCode: "execution-outcome-unknown",
      });
      const reconciled = store.reconcile({
        jobId: unknown.id,
        expectedVersion: unknown.version,
        disposition: "cancel",
        evidence: "operator evidence",
      });
      expect(reconciled.reconciled).toBe(true);
      store.close();
      store = createSqliteDurableJobStore(options);
      expect(store.get(unknown.id)).toMatchObject({ state: "canceled" });
      at += 2;
      expect(store.prune()).toBe(1);
      const probe = new Database(path, { readonly: true });
      expect(
        probe
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM durable_job_reconciliations")
          .get()?.count,
      ).toBe(1);
      probe.close();
      expect(() => store.pruneAudit({ before: at, limit: 10 })).toThrow(
        "audit retention cutoff is too recent",
      );
      at += 86_400_000;
      expect(store.pruneAudit({ before: at - 86_400_000, limit: 10 })).toBe(1);
    } finally {
      store.close();
    }
  });

  test("fails closed on non-integer persisted timestamps", () => {
    const path = dbPath();
    const store = createSqliteDurableJobStore({ dbPath: path, jobId: () => "job_1" });
    store.submit(request());
    store.close();
    const raw = new Database(path);
    raw.run("UPDATE durable_jobs SET available_at = 1.5");
    raw.close();
    expect(() => createSqliteDurableJobStore({ dbPath: path })).toThrow(
      "stored job state is inconsistent",
    );
  });

  test("fails closed on non-contiguous or mismatched attempt history", () => {
    const missingPath = dbPath();
    let store = createSqliteDurableJobStore({
      dbPath: missingPath,
      jobId: () => "job_missing",
      leaseToken: () => "lease_missing",
    });
    store.submit(request("missing"));
    store.claim({ workerId: "worker", leaseMs: 100 });
    store.close();
    let raw = new Database(missingPath);
    raw.run("PRAGMA foreign_keys = OFF");
    raw.run("DELETE FROM durable_job_attempts");
    raw.close();
    expect(() => createSqliteDurableJobStore({ dbPath: missingPath })).toThrow(
      "stored attempt history is inconsistent",
    );

    const mismatchPath = dbPath();
    store = createSqliteDurableJobStore({
      dbPath: mismatchPath,
      jobId: () => "job_mismatch",
      leaseToken: () => "lease_mismatch",
    });
    store.submit(request("mismatch"));
    store.claim({ workerId: "worker", leaseMs: 100 });
    store.close();
    raw = new Database(mismatchPath);
    raw.run("UPDATE durable_job_attempts SET lease_token = 'lease_tampered'");
    raw.close();
    expect(() => createSqliteDurableJobStore({ dbPath: mismatchPath })).toThrow(
      "stored job attempt is inconsistent",
    );
  });
});
