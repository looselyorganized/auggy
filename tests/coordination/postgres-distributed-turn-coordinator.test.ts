import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { resolve } from "node:path";
import { PostgresDistributedTurnCoordinator } from "../../src/coordination";
import { POSTGRES_COORDINATION_MIGRATIONS } from "../../src/coordination/migrations";
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
