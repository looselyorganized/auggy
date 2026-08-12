import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  createNotifyDeliveryStore,
  NOTIFY_DELIVERY_APPLICATION_ID,
  NOTIFY_DELIVERY_SCHEMA_VERSION,
} from "../../src/augments/notify/delivery-store";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "notify-delivery-store-test-"));
  tempDirs.push(dir);
  return join(dir, "notify.sqlite");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function reservation(
  operation: string,
  overrides: Partial<Parameters<ReturnType<typeof createNotifyDeliveryStore>["reserve"]>[0]> = {},
) {
  return {
    operationHash: hash(operation),
    threadId: "thread_1",
    peerHash: hash("peer_1"),
    destination: "ops",
    summaryHash: hash(operation),
    policy: {
      enforce: true,
      globalMaxPerHour: 10,
      perPeerCooldownMs: 0,
      dedupWindowMs: 60_000,
      destinationExplicit: false,
    },
    ...overrides,
  };
}

function internalReservation(
  operation: string,
  overrides: Partial<
    Parameters<ReturnType<typeof createNotifyDeliveryStore>["reserveInternal"]>[0]
  > = {},
) {
  return {
    operationHash: hash(`operation:${operation}`),
    payloadHash: hash(`payload:${operation}`),
    maxAttempts: 2,
    threadId: "internal_thread",
    peerHash: hash("agentmail.draft-ready"),
    destination: "creator",
    summaryHash: hash(`summary:${operation}`),
    policy: {
      globalMaxPerHour: 100,
      perPeerCooldownMs: 0,
      dedupWindowMs: 0,
      destinationExplicit: false,
    },
    ...overrides,
  };
}

function seedV1Database(dbPath: string): void {
  const db = new Database(dbPath, { create: true });
  const statements = [
    `CREATE TABLE notify_delivery_attempts (
      attempt_id TEXT PRIMARY KEY,
      operation_hash TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      destination TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed', 'outcome_unknown')),
      incident_id TEXT UNIQUE,
      incident_version INTEGER NOT NULL DEFAULT 1,
      reason_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX idx_notify_attempt_operation
       ON notify_delivery_attempts(operation_hash, created_at)`,
    `CREATE INDEX idx_notify_attempt_incident
       ON notify_delivery_attempts(state, updated_at, incident_id)`,
    `CREATE TABLE notify_quota_events (
      attempt_id TEXT PRIMARY KEY,
      peer_hash TEXT NOT NULL,
      destination TEXT NOT NULL,
      summary_hash TEXT NOT NULL,
      reserved_at INTEGER NOT NULL,
      destination_explicit INTEGER NOT NULL CHECK (destination_explicit IN (0, 1)),
      charge_state TEXT NOT NULL CHECK (charge_state IN ('reserved', 'charged', 'released')),
      FOREIGN KEY (attempt_id) REFERENCES notify_delivery_attempts(attempt_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX idx_notify_quota_time
       ON notify_quota_events(charge_state, reserved_at)`,
    `CREATE INDEX idx_notify_quota_destination
       ON notify_quota_events(destination, charge_state, reserved_at)`,
    `CREATE INDEX idx_notify_quota_peer
       ON notify_quota_events(peer_hash, destination, charge_state, reserved_at)`,
    `CREATE INDEX idx_notify_quota_summary
       ON notify_quota_events(summary_hash, charge_state, reserved_at)`,
    `CREATE TABLE notify_delivery_recoveries (
      incident_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL UNIQUE,
      incident_version INTEGER NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN ('confirmed-delivered', 'confirmed-no-effect')),
      evidence_sha256 TEXT NOT NULL,
      resolved_at INTEGER NOT NULL
    )`,
  ];
  for (const statement of statements) db.run(statement);
  const operationHash = hash("legacy-operation");
  db.run(
    `INSERT INTO notify_delivery_attempts (
       attempt_id, operation_hash, thread_id, destination, state, created_at, updated_at
     ) VALUES ('legacy_attempt', ?, 'legacy_thread', 'creator', 'sent', 1, 1)`,
    [operationHash],
  );
  db.run(`PRAGMA application_id = ${NOTIFY_DELIVERY_APPLICATION_ID}`);
  db.run("PRAGMA user_version = 1");
  db.close();
}

describe("notify delivery store", () => {
  test("atomically reserves quota across two handles", () => {
    const dbPath = tempDb();
    let attempt = 0;
    const first = createNotifyDeliveryStore({
      dbPath,
      now: () => 1_000,
      attemptId: () => `attempt_${++attempt}`,
    });
    const second = createNotifyDeliveryStore({
      dbPath,
      now: () => 1_000,
      attemptId: () => `attempt_${++attempt}`,
    });
    try {
      expect(
        first.reserve(
          reservation("first", {
            policy: {
              ...reservation("first").policy,
              globalMaxPerHour: 1,
            },
          }),
        ),
      ).toEqual({ status: "reserved", attemptId: "attempt_1" });
      expect(
        second.reserve(
          reservation("second", {
            peerHash: hash("peer_2"),
            policy: {
              ...reservation("second").policy,
              globalMaxPerHour: 1,
            },
          }),
        ),
      ).toMatchObject({ status: "rate_limited" });
    } finally {
      first.close();
      second.close();
    }
  });

  test("persists ambiguity across restart and resolves it once with hashed evidence", () => {
    const dbPath = tempDb();
    const sentinel = "RAW-NOTIFY-EVIDENCE-DO-NOT-PERSIST";
    let store = createNotifyDeliveryStore({
      dbPath,
      now: () => 2_000,
      attemptId: () => "attempt_unknown",
      incidentId: () => "incident_unknown",
    });
    const reserved = store.reserve(reservation("ambiguous payload"));
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    expect(store.settle(reserved.attemptId, "outcome_unknown", "adapter-threw")).toMatchObject({
      id: "incident_unknown",
      version: 1,
      threadId: "thread_1",
    });
    store.close();

    store = createNotifyDeliveryStore({ dbPath, now: () => 2_001 });
    expect(store.reserve(reservation("ambiguous payload"))).toEqual({
      status: "outcome_unknown",
      incidentId: "incident_unknown",
      incidentVersion: 1,
    });
    expect(
      store.reconcile({
        incidentId: "incident_unknown",
        expectedVersion: 2,
        disposition: "confirmed-no-effect",
        evidence: sentinel,
      }),
    ).toEqual({ resolved: false });
    expect(
      store.reconcile({
        incidentId: "incident_unknown",
        expectedVersion: 1,
        disposition: "confirmed-no-effect",
        evidence: sentinel,
      }),
    ).toEqual({ resolved: true, threadId: "thread_1", releaseThread: true });
    expect(
      store.reconcile({
        incidentId: "incident_unknown",
        expectedVersion: 1,
        disposition: "confirmed-no-effect",
        evidence: sentinel,
      }),
    ).toEqual({ resolved: false });
    store.close();

    for (const suffix of ["", "-wal", "-shm"]) {
      const path = `${dbPath}${suffix}`;
      if (existsSync(path)) expect(readFileSync(path).includes(Buffer.from(sentinel))).toBe(false);
    }
  });

  test("promotes an interrupted reservation on restart", () => {
    const dbPath = tempDb();
    let store = createNotifyDeliveryStore({
      dbPath,
      now: () => 3_000,
      attemptId: () => "attempt_interrupted",
    });
    expect(store.reserve(reservation("interrupted"))).toMatchObject({ status: "reserved" });
    store.close();

    store = createNotifyDeliveryStore({
      dbPath,
      now: () => 3_001,
      incidentId: () => "incident_restart",
    });
    expect(store.listIncidents()).toEqual([]);
    store.prepareForRuntime();
    expect(store.listIncidents()).toEqual([
      expect.objectContaining({
        id: "incident_restart",
        reasonCode: "process-restarted",
        attemptId: "attempt_interrupted",
      }),
    ]);
    expect(store.reserve(reservation("interrupted"))).toMatchObject({
      status: "outcome_unknown",
      incidentId: "incident_restart",
    });
    store.close();
  });

  test("opening a second handle does not promote a live reservation", () => {
    const dbPath = tempDb();
    const first = createNotifyDeliveryStore({
      dbPath,
      now: () => 3_500,
      attemptId: () => "attempt_live",
    });
    const reserved = first.reserve(reservation("live"));
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const second = createNotifyDeliveryStore({
      dbPath,
      now: () => 3_501,
      incidentId: () => "must_not_be_used",
    });
    try {
      expect(second.listIncidents()).toEqual([]);
      expect(first.settle(reserved.attemptId, "sent")).toBeNull();
      expect(second.prepareForRuntime()).toEqual([]);
      expect(second.listIncidents()).toEqual([]);
    } finally {
      first.close();
      second.close();
    }
  });

  test("rejects policy windows that outlive retained quota evidence", () => {
    const store = createNotifyDeliveryStore({ dbPath: ":memory:", now: () => 3_600 });
    try {
      expect(() =>
        store.reserve(
          reservation("too-long", {
            policy: {
              ...reservation("too-long").policy,
              dedupWindowMs: 30 * 24 * 60 * 60_000 + 1,
            },
          }),
        ),
      ).toThrow(/cannot exceed 30 days/i);
    } finally {
      store.close();
    }
  });

  test("a provider-reached failure retains its quota reservation", () => {
    const store = createNotifyDeliveryStore({
      dbPath: ":memory:",
      now: () => 4_000,
      attemptId: (() => {
        let id = 0;
        return () => `attempt_${++id}`;
      })(),
    });
    try {
      const first = store.reserve(
        reservation("first", {
          policy: { ...reservation("first").policy, globalMaxPerHour: 1 },
        }),
      );
      if (first.status !== "reserved") throw new Error("expected reservation");
      store.settle(first.attemptId, "failed");
      expect(
        store.reserve(
          reservation("second", {
            peerHash: hash("peer_2"),
            policy: { ...reservation("second").policy, globalMaxPerHour: 1 },
          }),
        ),
      ).toMatchObject({ status: "rate_limited" });
    } finally {
      store.close();
    }
  });

  test("creator quota bypass does not bypass unresolved operation safety", () => {
    const store = createNotifyDeliveryStore({
      dbPath: ":memory:",
      now: () => 5_000,
      attemptId: () => "creator_attempt",
      incidentId: () => "creator_incident",
    });
    try {
      const input = reservation("creator", {
        policy: { ...reservation("creator").policy, enforce: false },
      });
      const first = store.reserve(input);
      if (first.status !== "reserved") throw new Error("expected reservation");
      store.settle(first.attemptId, "outcome_unknown", "adapter-threw");
      expect(store.reserve(input)).toMatchObject({
        status: "outcome_unknown",
        incidentId: "creator_incident",
      });
    } finally {
      store.close();
    }
  });

  test("migrates an exact branded v1 ledger and preserves terminal attempts", () => {
    const dbPath = tempDb();
    seedV1Database(dbPath);

    const store = createNotifyDeliveryStore({ dbPath, now: () => 6_000 });
    store.close();

    const inspect = new Database(dbPath);
    try {
      expect(
        inspect.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
      ).toBe(NOTIFY_DELIVERY_SCHEMA_VERSION);
      expect(
        inspect
          .query<
            {
              operation_hash: string;
              payload_hash: string;
              replay_protected: number;
              max_attempts: number;
            },
            []
          >(
            `SELECT operation_hash, payload_hash, replay_protected, max_attempts
               FROM notify_delivery_attempts WHERE attempt_id = 'legacy_attempt'`,
          )
          .get(),
      ).toEqual({
        operation_hash: hash("legacy-operation"),
        payload_hash: hash("legacy-operation"),
        replay_protected: 0,
        max_attempts: 1,
      });
    } finally {
      inspect.close();
    }
  });

  test("internal operations replay sent, fence active states, and bind immutable payload", () => {
    let attempt = 0;
    const store = createNotifyDeliveryStore({
      dbPath: ":memory:",
      now: () => 7_000,
      attemptId: () => `internal_${++attempt}`,
      incidentId: () => "internal_incident",
    });
    try {
      const input = internalReservation("replay");
      const first = store.reserveInternal(input);
      expect(first).toEqual({
        status: "reserved",
        attemptId: "internal_1",
        attemptCount: 1,
      });
      expect(store.reserveInternal(input)).toEqual({ status: "in_flight", attemptCount: 1 });
      if (first.status !== "reserved") throw new Error("expected reservation");
      store.settle(first.attemptId, "failed");

      expect(store.reserveInternal({ ...input, payloadHash: hash("changed-payload") })).toEqual({
        status: "operation_conflict",
        attemptCount: 1,
      });
      const second = store.reserveInternal(input);
      expect(second).toEqual({
        status: "reserved",
        attemptId: "internal_2",
        attemptCount: 2,
      });
      if (second.status !== "reserved") throw new Error("expected retry reservation");
      store.settle(second.attemptId, "sent");
      expect(store.reserveInternal(input)).toEqual({
        status: "already_sent",
        attemptCount: 2,
      });

      const unknownInput = internalReservation("unknown");
      const unknown = store.reserveInternal(unknownInput);
      if (unknown.status !== "reserved") throw new Error("expected unknown reservation");
      store.settle(unknown.attemptId, "outcome_unknown", "adapter-threw");
      expect(store.reserveInternal(unknownInput)).toEqual({
        status: "outcome_unknown",
        incidentId: "internal_incident",
        incidentVersion: 1,
        attemptCount: 1,
      });
    } finally {
      store.close();
    }
  });

  test("internal reservations always consume quota and rate limits do not consume attempts", () => {
    let timestamp = 8_000;
    let attempt = 0;
    const store = createNotifyDeliveryStore({
      dbPath: ":memory:",
      now: () => timestamp,
      attemptId: () => `quota_${++attempt}`,
    });
    try {
      const policy = {
        globalMaxPerHour: 1,
        perPeerCooldownMs: 0,
        dedupWindowMs: 0,
        destinationExplicit: false,
      };
      const first = store.reserveInternal(internalReservation("quota-first", { policy }));
      if (first.status !== "reserved") throw new Error("expected reservation");
      store.settle(first.attemptId, "failed");

      const blockedInput = internalReservation("quota-second", {
        peerHash: hash("another-internal-producer"),
        policy,
      });
      expect(store.reserveInternal(blockedInput)).toMatchObject({
        status: "rate_limited",
        attemptCount: 0,
      });
      timestamp += 3_600_001;
      expect(store.reserveInternal(blockedInput)).toMatchObject({
        status: "reserved",
        attemptCount: 1,
      });
    } finally {
      store.close();
    }
  });

  test("exhausted internal operations require exact one-shot authorization with hashed evidence", () => {
    const dbPath = tempDb();
    const sentinel = "RAW-INTERNAL-RETRY-EVIDENCE-DO-NOT-PERSIST";
    let attempt = 0;
    let store = createNotifyDeliveryStore({
      dbPath,
      now: () => 9_000,
      attemptId: () => `recovery_${++attempt}`,
      incidentId: () => "recovery_incident",
    });
    try {
      const input = internalReservation("recovery", { maxAttempts: 1 });
      const first = store.reserveInternal(input);
      if (first.status !== "reserved") throw new Error("expected reservation");
      store.settle(first.attemptId, "failed");
      expect(store.reserveInternal(input)).toEqual({
        status: "attempts_exhausted",
        attemptCount: 1,
      });
      expect(
        store.authorizeInternalRetry({
          operationHash: input.operationHash,
          expectedAttemptCount: 2,
          evidence: sentinel,
        }),
      ).toEqual({ status: "operation_conflict", attemptCount: 1 });
      expect(
        store.authorizeInternalRetry({
          operationHash: input.operationHash,
          expectedAttemptCount: 1,
          evidence: sentinel,
        }),
      ).toEqual({ status: "authorized", attemptCount: 1, authorizedAttempt: 2 });
      expect(
        store.authorizeInternalRetry({
          operationHash: input.operationHash,
          expectedAttemptCount: 1,
          evidence: sentinel,
        }),
      ).toEqual({ status: "operation_conflict", attemptCount: 1 });

      const second = store.reserveInternal(input);
      if (second.status !== "reserved") throw new Error("expected authorized reservation");
      store.settle(second.attemptId, "outcome_unknown", "adapter-threw");
      expect(
        store.authorizeInternalRetry({
          operationHash: input.operationHash,
          expectedAttemptCount: 2,
          evidence: sentinel,
        }),
      ).toEqual({ status: "not_definitively_failed", attemptCount: 2 });
      expect(
        store.reconcile({
          incidentId: "recovery_incident",
          expectedVersion: 1,
          disposition: "confirmed-no-effect",
          evidence: "provider confirmed no effect",
        }),
      ).toMatchObject({ resolved: true });
      expect(
        store.authorizeInternalRetry({
          operationHash: input.operationHash,
          expectedAttemptCount: 2,
          evidence: sentinel,
        }),
      ).toEqual({ status: "authorized", attemptCount: 2, authorizedAttempt: 3 });
      store.close();
      store = createNotifyDeliveryStore({
        dbPath,
        now: () => 9_001,
        attemptId: () => "recovery_3",
      });
      expect(store.reserveInternal(input)).toEqual({
        status: "reserved",
        attemptId: "recovery_3",
        attemptCount: 3,
      });
    } finally {
      store.close();
    }

    for (const suffix of ["", "-wal", "-shm"]) {
      const path = `${dbPath}${suffix}`;
      if (existsSync(path)) expect(readFileSync(path).includes(Buffer.from(sentinel))).toBe(false);
    }
  });

  test("capacity pressure deletes ordinary terminals but never protected replay evidence", () => {
    let attempt = 0;
    const store = createNotifyDeliveryStore({
      dbPath: ":memory:",
      now: () => 10_000,
      attemptId: () => `capacity_${++attempt}`,
      terminalAttemptCapacity: 2,
    });
    try {
      const protectedInput = internalReservation("protected", { maxAttempts: 1 });
      const protectedAttempt = store.reserveInternal(protectedInput);
      if (protectedAttempt.status !== "reserved") throw new Error("expected reservation");
      store.settle(protectedAttempt.attemptId, "sent");

      const ordinary = store.reserve(reservation("ordinary"));
      if (ordinary.status !== "reserved") throw new Error("expected ordinary reservation");
      store.settle(ordinary.attemptId, "sent");

      expect(store.reserve(reservation("replacement"))).toMatchObject({ status: "reserved" });
      expect(store.reserveInternal(protectedInput)).toEqual({
        status: "already_sent",
        attemptCount: 1,
      });
    } finally {
      store.close();
    }
  });

  test("inspects protected replay state without reserving a provider attempt", () => {
    const store = createNotifyDeliveryStore({
      dbPath: ":memory:",
      now: () => 10_500,
      attemptId: () => "inspect_1",
    });
    try {
      const input = internalReservation("inspect", { maxAttempts: 1 });
      const inspection = {
        operationHash: input.operationHash,
        payloadHash: input.payloadHash,
        maxAttempts: input.maxAttempts,
        threadId: input.threadId,
        destination: input.destination,
      };
      expect(store.inspectInternal(inspection)).toEqual({
        status: "not_found",
        attemptCount: 0,
      });
      const reserved = store.reserveInternal(input);
      if (reserved.status !== "reserved") throw new Error("expected reservation");
      expect(store.inspectInternal(inspection)).toEqual({
        status: "in_flight",
        attemptCount: 1,
      });
      store.settle(reserved.attemptId, "sent");
      expect(store.inspectInternal(inspection)).toEqual({
        status: "already_sent",
        attemptCount: 1,
      });
    } finally {
      store.close();
    }
  });

  test("capacity fails closed rather than pruning protected replay evidence", () => {
    let attempt = 0;
    const store = createNotifyDeliveryStore({
      dbPath: ":memory:",
      now: () => 11_000,
      attemptId: () => `protected_${++attempt}`,
      terminalAttemptCapacity: 2,
    });
    try {
      for (const operation of ["one", "two"]) {
        const reserved = store.reserveInternal(internalReservation(operation, { maxAttempts: 1 }));
        if (reserved.status !== "reserved") throw new Error("expected reservation");
        store.settle(reserved.attemptId, "sent");
      }
      expect(() => store.reserve(reservation("cannot-evict-protected"))).toThrow(
        /terminal record capacity requires operator maintenance/,
      );
      expect(store.reserveInternal(internalReservation("one", { maxAttempts: 1 }))).toEqual({
        status: "already_sent",
        attemptCount: 1,
      });
    } finally {
      store.close();
    }
  });

  test("durable source acknowledgement releases capacity without weakening replay safety", () => {
    const dbPath = tempDb();
    let attempt = 0;
    let store = createNotifyDeliveryStore({
      dbPath,
      now: () => 11_500,
      attemptId: () => `ack_${++attempt}`,
      terminalAttemptCapacity: 1,
    });
    const firstInput = internalReservation("acknowledged", { maxAttempts: 1 });
    const secondInput = internalReservation("after-acknowledgement", { maxAttempts: 1 });
    try {
      const first = store.reserveInternal(firstInput);
      if (first.status !== "reserved") throw new Error("expected reservation");
      store.settle(first.attemptId, "sent");
      const settlementSha256 = hash("durable-source-settlement");
      expect(
        store.acknowledgeInternal({
          operationHash: firstInput.operationHash,
          settlementSha256,
        }),
      ).toBe("acknowledged");
      expect(
        store.acknowledgeInternal({
          operationHash: firstInput.operationHash,
          settlementSha256,
        }),
      ).toBe("already_acknowledged");
      expect(
        store.acknowledgeInternal({
          operationHash: firstInput.operationHash,
          settlementSha256: hash("different-settlement"),
        }),
      ).toBe("conflict");

      const second = store.reserveInternal(secondInput);
      expect(second).toMatchObject({ status: "reserved", attemptCount: 1 });
      expect(store.reserveInternal(firstInput)).toEqual({
        status: "already_sent",
        attemptCount: 1,
      });
      store.close();

      store = createNotifyDeliveryStore({
        dbPath,
        now: () => 11_501,
        attemptId: () => `ack_${++attempt}`,
        terminalAttemptCapacity: 1,
      });
      expect(store.reserveInternal(firstInput)).toEqual({
        status: "already_sent",
        attemptCount: 1,
      });
    } finally {
      store.close();
    }
  });

  test("acknowledgement rejects active operations and seals definitively failed operations", () => {
    let attempt = 0;
    const store = createNotifyDeliveryStore({
      dbPath: ":memory:",
      now: () => 11_750,
      attemptId: () => `ack_failed_${++attempt}`,
    });
    try {
      const input = internalReservation("ack-failed", { maxAttempts: 2 });
      const first = store.reserveInternal(input);
      if (first.status !== "reserved") throw new Error("expected reservation");
      expect(
        store.acknowledgeInternal({
          operationHash: input.operationHash,
          settlementSha256: hash("source-settlement"),
        }),
      ).toBe("not_terminal");
      store.settle(first.attemptId, "failed");
      expect(
        store.acknowledgeInternal({
          operationHash: input.operationHash,
          settlementSha256: hash("source-settlement"),
        }),
      ).toBe("acknowledged");
      expect(store.reserveInternal(input)).toEqual({
        status: "attempts_exhausted",
        attemptCount: 1,
      });
      expect(
        store.authorizeInternalRetry({
          operationHash: input.operationHash,
          expectedAttemptCount: 1,
          evidence: "must remain sealed",
        }),
      ).toEqual({ status: "operation_conflict", attemptCount: 1 });
    } finally {
      store.close();
    }
  });

  test("clamps delivery transitions when the wall clock moves backwards", () => {
    const dbPath = tempDb();
    let timestamp = 20_000;
    let attempt = 0;
    let store = createNotifyDeliveryStore({
      dbPath,
      now: () => timestamp,
      attemptId: () => `rollback_${++attempt}`,
      incidentId: () => "rollback_incident",
    });
    const sentInput = internalReservation("clock-sent", { maxAttempts: 1 });
    const unknownInput = internalReservation("clock-unknown", { maxAttempts: 1 });
    try {
      const sent = store.reserveInternal(sentInput);
      if (sent.status !== "reserved") throw new Error("expected sent reservation");
      timestamp = 10_000;
      store.settle(sent.attemptId, "sent");

      const unknown = store.reserveInternal(unknownInput);
      if (unknown.status !== "reserved") throw new Error("expected unknown reservation");
      timestamp = 5_000;
      store.settle(unknown.attemptId, "outcome_unknown", "clock-rollback");
      timestamp = 1_000;
      expect(
        store.reconcile({
          incidentId: "rollback_incident",
          expectedVersion: 1,
          disposition: "confirmed-no-effect",
          evidence: "provider confirmed no effect",
        }),
      ).toMatchObject({ resolved: true });
      store.close();

      store = createNotifyDeliveryStore({
        dbPath,
        now: () => 500,
        attemptId: () => `rollback_${++attempt}`,
      });
      expect(store.reserveInternal(sentInput)).toEqual({
        status: "already_sent",
        attemptCount: 1,
      });
    } finally {
      store.close();
    }
  });

  test("protected history remains replay-safe beyond ordinary terminal retention", () => {
    let timestamp = 12_000;
    let attempt = 0;
    const store = createNotifyDeliveryStore({
      dbPath: ":memory:",
      now: () => timestamp,
      attemptId: () => `retention_${++attempt}`,
    });
    try {
      const input = internalReservation("retention", { maxAttempts: 2 });
      const first = store.reserveInternal(input);
      if (first.status !== "reserved") throw new Error("expected reservation");
      store.settle(first.attemptId, "failed");

      timestamp += 30 * 24 * 60 * 60_000 + 1;
      expect(store.reserveInternal(input)).toEqual({
        status: "reserved",
        attemptId: "retention_2",
        attemptCount: 2,
      });
    } finally {
      store.close();
    }
  });

  test("sent protected history never expires into a duplicate provider attempt", () => {
    let timestamp = 12_500;
    const store = createNotifyDeliveryStore({
      dbPath: ":memory:",
      now: () => timestamp,
      attemptId: () => "sent_retention_1",
    });
    try {
      const input = internalReservation("sent-retention", { maxAttempts: 1 });
      const first = store.reserveInternal(input);
      if (first.status !== "reserved") throw new Error("expected reservation");
      store.settle(first.attemptId, "sent");

      timestamp += 365 * 24 * 60 * 60_000;
      expect(store.reserveInternal(input)).toEqual({
        status: "already_sent",
        attemptCount: 1,
      });
    } finally {
      store.close();
    }
  });

  test("protected attempt history is retained for the full operation activity window", () => {
    const retentionMs = 30 * 24 * 60 * 60_000;
    let timestamp = 13_000;
    let attempt = 0;
    const store = createNotifyDeliveryStore({
      dbPath: ":memory:",
      now: () => timestamp,
      attemptId: () => `active_retention_${++attempt}`,
    });
    try {
      const input = internalReservation("active-retention", { maxAttempts: 2 });
      const first = store.reserveInternal(input);
      if (first.status !== "reserved") throw new Error("expected reservation");
      store.settle(first.attemptId, "failed");

      timestamp += retentionMs - 1;
      const second = store.reserveInternal(input);
      if (second.status !== "reserved") throw new Error("expected retry reservation");
      store.settle(second.attemptId, "failed");

      timestamp += 2;
      expect(store.reserveInternal(input)).toEqual({
        status: "attempts_exhausted",
        attemptCount: 2,
      });
    } finally {
      store.close();
    }
  });
});
