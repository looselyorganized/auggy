import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createNotifyDeliveryStore } from "../../src/augments/notify/delivery-store";

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
});
