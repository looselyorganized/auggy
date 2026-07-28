import { afterEach, describe, expect, test } from "bun:test";
import {
  createInMemoryDistributedTurnCoordinator,
  resetInMemoryDistributedCoordination,
} from "../../src/coordination";
import { POSTGRES_COORDINATION_MIGRATIONS } from "../../src/coordination/migrations";
import { parseDistributedBudgetCostNanos } from "../../src/coordination/budget-policy";
import type {
  DistributedReplayResult,
  DistributedTurnCoordinator,
  DistributedTurnLease,
} from "../../src/coordination/types";

const hash = "S7l_qm3W92Yd4JbKzV1LQYdKebJ4Q-4C3m3VnuDhxQY";
const source = { id: "web", maxConcurrent: 1, maxQueued: 2 };
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
  turnState: {
    history: { maxSnapshotBytes: 65_536, maxMessages: 100, maxThreads: 1_000 },
    maxCostMarkersPerTurn: 32,
    outbox: { maxIntentsPerTurn: 32, maxIntentBytes: 65_536, maxPendingIntents: 1_000 },
  },
  compatibility: {
    protocolVersion: 5,
    protocolFingerprint: "a".repeat(64),
    configurationFingerprint: "b".repeat(64),
  },
};

function replica(
  instanceId: string,
  now: () => number,
  extra: Partial<{
    maxConcurrent: number;
    maxQueued: number;
    leaseMs: number;
    failClosed: () => boolean;
    protocolVersion: number;
    protocolFingerprint: string;
    configurationFingerprint: string;
    upgradeFrom: {
      protocolVersion: number;
      protocolFingerprint: string;
      configurationFingerprint: string;
    };
    sources: readonly (typeof source)[];
    historyMaxThreads: number;
  }> = {},
) {
  return createInMemoryDistributedTurnCoordinator(
    {
      namespace: "orders-prod",
      instanceId,
      maxConcurrent: extra.maxConcurrent ?? 1,
      maxQueued: extra.maxQueued ?? 2,
      maxQueuedPerThread: extra.maxQueued ?? 2,
      leaseMs: extra.leaseMs ?? 100,
      ...coordinatorPolicy,
      sources: extra.sources ?? coordinatorPolicy.sources,
      turnState: {
        ...coordinatorPolicy.turnState,
        history: {
          ...coordinatorPolicy.turnState.history,
          maxThreads: extra.historyMaxThreads ?? coordinatorPolicy.turnState.history.maxThreads,
        },
      },
      compatibility: {
        protocolVersion: extra.protocolVersion ?? 5,
        protocolFingerprint: extra.protocolFingerprint ?? "a".repeat(64),
        configurationFingerprint: extra.configurationFingerprint ?? "b".repeat(64),
        ...(extra.upgradeFrom ? { upgradeFrom: extra.upgradeFrom } : {}),
      },
    },
    { now, failClosed: extra.failClosed },
  );
}

function budgetReplica(
  instanceId: string,
  now: () => number,
  policy: Record<string, unknown> = {},
  maxTerminalRequests = coordinatorPolicy.retention.maxTerminalRequests,
) {
  const budgetSource = { id: "web", maxConcurrent: 2, maxQueued: 4 };
  return createInMemoryDistributedTurnCoordinator(
    {
      namespace: "orders-budget-prod",
      instanceId,
      maxConcurrent: 2,
      maxQueued: 4,
      maxQueuedPerThread: 2,
      leaseMs: 100,
      ...coordinatorPolicy,
      retention: { ...coordinatorPolicy.retention, maxTerminalRequests },
      sources: [budgetSource],
      budgets: {
        policies: [
          {
            id: "support",
            maxReservations: 10_100,
            reservationRetentionMs: 604_800_000,
            maxAnonymousEvents: 100,
            maxPeerDays: 100,
            maxThresholdIntents: 21,
            aggregateRetentionDays: 7,
            caps: { public: { recognized: { maxTurnsPerDay: 1 } } },
            ...policy,
          },
        ],
      },
    },
    { now },
  );
}

async function register(
  ...coordinators: ReturnType<typeof createInMemoryDistributedTurnCoordinator>[]
): Promise<void> {
  for (const coordinator of coordinators) {
    expect(await coordinator.register()).toEqual({ status: "registered" });
  }
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

function distributedReplay(threadId: string, text = "ok"): DistributedReplayResult {
  return replay({
    version: 1,
    turnId: "turn-1",
    threadId,
    status: "completed",
    response: { parts: [{ kind: "text", text }] },
  });
}

function distributedReplayAtBytes(threadId: string, maximum: number): DistributedReplayResult {
  const empty = distributedReplay(threadId, "");
  const textBytes = maximum - empty.body.byteLength;
  if (textBytes < 0) throw new Error("replay limit is smaller than the envelope");
  return distributedReplay(threadId, "a".repeat(textBytes));
}

const atomicPeerBinding = {
  version: 1 as const,
  bindingHash: "d".repeat(64),
  peerIdHash: null,
  promotionScopeHash: "e".repeat(64),
  trustLevel: "creator" as const,
};

async function atomicCheckpoint(
  coordinator: DistributedTurnCoordinator,
  lease: DistributedTurnLease,
  result: DistributedReplayResult = distributedReplay(lease.threadId),
) {
  const loaded = await coordinator.loadHistory(lease, atomicPeerBinding);
  if (loaded.status !== "ok") throw new Error(`expected history load, got ${loaded.status}`);
  const started = await coordinator.markExecutionStarted(lease);
  if (started.status !== "ok") throw new Error(`expected execution marker, got ${started.status}`);
  return {
    peerBinding: atomicPeerBinding,
    expectedHistoryRevision: loaded.revision,
    history: {
      version: 1 as const,
      body: loaded.body,
      messageCount: loaded.messageCount,
    },
    replay: result,
    costMarkers: [],
    outboxIntents: [],
  };
}

async function completeAtomic(
  coordinator: DistributedTurnCoordinator,
  lease: DistributedTurnLease,
  result: DistributedReplayResult = distributedReplay(lease.threadId),
) {
  return coordinator.commitTurn(lease, await atomicCheckpoint(coordinator, lease, result));
}

afterEach(resetInMemoryDistributedCoordination);

describe("distributed turn coordinator", () => {
  test("commits peer-isolated memory under one fenced root turn and rejects stale or conflicting replays", async () => {
    const now = () => Date.UTC(2026, 6, 27, 12);
    const memoryPolicy = {
      id: "committed-memory",
      namespacePrefix: "facts",
      maxEntries: 4,
      maxEntriesPerPeer: 2,
      maxBytes: 4096,
      maxBytesPerPeer: 2048,
      maxEntryBytes: 1024,
      maxQueryBytes: 1024,
      maxResultBytes: 1024,
      maxResults: 2,
      maxMutationsPerTurn: 2,
      maxOperations: 8,
      maxTombstones: 8,
      operationRetentionMs: 604_800_000,
      entryRetentionMs: 604_800_000,
    };
    const coordinator = createInMemoryDistributedTurnCoordinator(
      {
        namespace: "memory-coordination",
        instanceId: "memory-replica",
        maxConcurrent: 1,
        maxQueued: 2,
        maxQueuedPerThread: 2,
        leaseMs: 100,
        ...coordinatorPolicy,
        memory: { policies: [memoryPolicy] },
        compatibility: {
          protocolVersion: 10,
          protocolFingerprint: "9".repeat(64),
          configurationFingerprint: "8".repeat(64),
        },
      },
      { now },
    );
    await register(coordinator);
    const peer = {
      version: 1 as const,
      bindingHash: "1".repeat(64),
      peerIdHash: "2".repeat(64),
      promotionScopeHash: "3".repeat(64),
      trustLevel: "public" as const,
      publicSubstate: "recognized" as const,
    };
    const first = request("memory-write", "memory-thread");
    expect(await coordinator.admit(first)).toEqual({ status: "admitted", attempt: 1 });
    const claimed = await coordinator.claim(first);
    if (claimed.status !== "acquired") throw new Error("expected lease");
    const loaded = await coordinator.loadHistory(claimed.lease, peer);
    if (loaded.status !== "ok") throw new Error("expected history");
    expect(await coordinator.markExecutionStarted(claimed.lease)).toMatchObject({ status: "ok" });
    const epoch = await coordinator.loadMemoryPeerEpoch(claimed.lease, {
      policyId: memoryPolicy.id,
      peerBinding: peer,
    });
    if (epoch.status !== "ok") throw new Error("expected memory epoch");
    const document = new TextEncoder().encode(
      JSON.stringify({ version: 1, content: "order shipped" }),
    );
    const mutation = {
      version: 1 as const,
      operationId: `auggy-op-v1-${"a".repeat(64)}`,
      policyId: memoryPolicy.id,
      sourceTurnId: first.requestId,
      origin: "agent" as const,
      provenanceHash: "b".repeat(64),
      kind: "write" as const,
      entryId: "order-status",
      expectedPeerEraseEpoch: epoch.eraseEpoch,
      body: document,
    };
    expect(
      await coordinator.commitTurn(claimed.lease, {
        peerBinding: peer,
        expectedHistoryRevision: loaded.revision,
        history: { version: 1, body: loaded.body, messageCount: loaded.messageCount },
        replay: distributedReplay(first.threadId),
        costMarkers: [],
        outboxIntents: [],
        memoryMutations: [mutation],
      }),
    ).toEqual({ status: "ok" });

    const read = request("memory-read", "memory-thread");
    expect(await coordinator.admit(read)).toEqual({ status: "admitted", attempt: 1 });
    const next = await coordinator.claim(read);
    if (next.status !== "acquired") throw new Error("expected next lease");
    const loadedNext = await coordinator.loadHistory(next.lease, peer);
    expect(loadedNext.status).toBe("ok");
    if (loadedNext.status !== "ok") throw new Error("expected history");
    expect(await coordinator.markExecutionStarted(next.lease)).toMatchObject({ status: "ok" });
    expect(
      await coordinator.searchMemory(next.lease, {
        policyId: memoryPolicy.id,
        peerBinding: peer,
        query: new TextEncoder().encode(JSON.stringify({ version: 1, contains: "shipped" })),
        limit: 2,
      }),
    ).toMatchObject({ status: "ok", entries: [{ id: "order-status" }] });
    expect(
      await coordinator.readMemory(
        { ...next.lease, fence: next.lease.fence + 1 },
        {
          policyId: memoryPolicy.id,
          peerBinding: peer,
          entryId: "order-status",
        },
      ),
    ).toEqual({ status: "stale" });
    const conflict = {
      ...mutation,
      sourceTurnId: read.requestId,
      body: new TextEncoder().encode(JSON.stringify({ version: 1, content: "refunded" })),
    };
    expect(
      await coordinator.commitTurn(next.lease, {
        peerBinding: peer,
        expectedHistoryRevision: loadedNext.revision,
        history: { version: 1, body: loadedNext.body, messageCount: loadedNext.messageCount },
        replay: distributedReplay(read.threadId),
        costMarkers: [],
        outboxIntents: [],
        memoryMutations: [conflict],
      }),
    ).toEqual({ status: "rejected", reason: "memory-conflict" });
  });

  test("leases committed deliveries once and quarantines unsafe expiry until fenced recovery", async () => {
    let time = Date.UTC(2026, 6, 27, 12);
    const now = () => time;
    const first = replica("delivery-first", now);
    const second = replica("delivery-second", now);
    await register(first, second);
    const peer = {
      version: 1 as const,
      bindingHash: "1".repeat(64),
      peerIdHash: "2".repeat(64),
      promotionScopeHash: "3".repeat(64),
      trustLevel: "agent" as const,
    };
    const item = request("delivery-request", "delivery-thread");
    expect(await first.admit(item)).toEqual({ status: "admitted", attempt: 1 });
    const claimed = await first.claim(item);
    if (claimed.status !== "acquired") throw new Error("expected root lease");
    const loaded = await first.loadHistory(claimed.lease, peer);
    if (loaded.status !== "ok") throw new Error("expected history claim");
    expect(await first.markExecutionStarted(claimed.lease)).toMatchObject({ status: "ok" });
    expect(
      await first.commitTurn(claimed.lease, {
        peerBinding: peer,
        expectedHistoryRevision: loaded.revision,
        history: { version: 1, body: loaded.body, messageCount: loaded.messageCount },
        replay: distributedReplay(item.threadId),
        costMarkers: [],
        outboxIntents: [
          {
            version: 1,
            ordinal: 0,
            operationId: `auggy-op-v1-${"4".repeat(64)}`,
            contentType: "application/json",
            retryMode: "never",
            maxAttempts: 1,
            body: new TextEncoder().encode(JSON.stringify({ version: 1, text: "deliver" })),
          },
        ],
      }),
    ).toEqual({ status: "ok" });

    const [left, right] = await Promise.all([first.claimOutbox(), second.claimOutbox()]);
    const acquired = left.status === "acquired" ? left : right.status === "acquired" ? right : null;
    expect(acquired?.status).toBe("acquired");
    expect([left.status, right.status].sort()).toEqual(["acquired", "waiting"]);
    if (acquired?.status !== "acquired") throw new Error("expected delivery lease");
    const owner = left.status === "acquired" ? first : second;
    const nonOwner = owner === first ? second : first;
    expect(await nonOwner.settleOutbox(acquired.lease, { outcome: "delivered" })).toEqual({
      status: "stale",
    });

    time += 50;
    expect(await nonOwner.heartbeatInstance()).toMatchObject({ status: "ok" });
    time += 51;
    expect(await nonOwner.claimOutbox()).toEqual({ status: "waiting" });
    expect(
      await nonOwner.recoverOutbox(
        acquired.lease.operationId,
        acquired.lease.deliveryFence + 1,
        "delivered",
        "operator-confirmed-delivery",
      ),
    ).toEqual({ status: "conflict" });
    expect(
      await nonOwner.recoverOutbox(
        acquired.lease.operationId,
        acquired.lease.deliveryFence,
        "retry",
        "operator-requested-retry",
      ),
    ).toEqual({ status: "rejected", reason: "retry-unsafe" });
    expect(
      await nonOwner.recoverOutbox(
        acquired.lease.operationId,
        acquired.lease.deliveryFence,
        "delivered",
        "operator-confirmed-delivery",
      ),
    ).toEqual({ status: "ok" });
    expect(
      await nonOwner.recoverOutbox(
        acquired.lease.operationId,
        acquired.lease.deliveryFence,
        "delivered",
        "operator-confirmed-delivery",
      ),
    ).toEqual({ status: "stale" });
  });

  test("reclaims expired delivery leases only with immutable sink-idempotency evidence", async () => {
    let time = Date.UTC(2026, 6, 27, 12);
    const now = () => time;
    const first = replica("retry-delivery-first", now);
    const second = replica("retry-delivery-second", now);
    await register(first, second);
    const peer = {
      version: 1 as const,
      bindingHash: "5".repeat(64),
      peerIdHash: "6".repeat(64),
      promotionScopeHash: "7".repeat(64),
      trustLevel: "agent" as const,
    };
    const item = request("retry-delivery-request", "retry-delivery-thread");
    expect(await first.admit(item)).toEqual({ status: "admitted", attempt: 1 });
    const claimed = await first.claim(item);
    if (claimed.status !== "acquired") throw new Error("expected root lease");
    const loaded = await first.loadHistory(claimed.lease, peer);
    if (loaded.status !== "ok") throw new Error("expected history claim");
    expect(await first.markExecutionStarted(claimed.lease)).toMatchObject({ status: "ok" });
    expect(
      await first.commitTurn(claimed.lease, {
        peerBinding: peer,
        expectedHistoryRevision: loaded.revision,
        history: { version: 1, body: loaded.body, messageCount: loaded.messageCount },
        replay: distributedReplay(item.threadId),
        costMarkers: [],
        outboxIntents: [
          {
            version: 1,
            ordinal: 0,
            operationId: `auggy-op-v1-${"8".repeat(64)}`,
            contentType: "application/json",
            retryMode: "sink-idempotent",
            maxAttempts: 2,
            body: new TextEncoder().encode(JSON.stringify({ version: 1, text: "deliver" })),
          },
        ],
      }),
    ).toEqual({ status: "ok" });
    const initial = await first.claimOutbox();
    if (initial.status !== "acquired") throw new Error("expected initial delivery lease");
    time += 50;
    expect(await second.heartbeatInstance()).toMatchObject({ status: "ok" });
    time += 51;
    const retry = await second.claimOutbox();
    if (retry.status !== "acquired") throw new Error("expected retry delivery lease");
    expect(retry.lease.operationId).toBe(initial.lease.operationId);
    expect(retry.lease.attempt).toBe(2);
    expect(retry.lease.deliveryFence).toBeGreaterThan(initial.lease.deliveryFence);
    expect(await first.settleOutbox(initial.lease, { outcome: "delivered" })).toEqual({
      status: "stale",
    });
    expect(await second.settleOutbox(retry.lease, { outcome: "delivered" })).toEqual({
      status: "ok",
    });
    expect(await second.claimOutbox()).toEqual({ status: "waiting" });
  });

  test("derives every persisted migration checksum from its immutable SQL", () => {
    for (const migration of POSTGRES_COORDINATION_MIGRATIONS) {
      expect(new Bun.CryptoHasher("sha256").update(migration.sql).digest("hex")).toBe(
        migration.checksum,
      );
    }
  });

  test("parses persisted aggregates beyond the bounded per-turn cost", () => {
    expect(parseDistributedBudgetCostNanos("2000000.000000001000")).toBe(2_000_000_000_000_001n);
  });

  test("serializes shared budget admission and releases only before execution starts", async () => {
    const now = () => Date.UTC(2026, 6, 27, 12);
    const first = budgetReplica("budget-first", now);
    const second = budgetReplica("budget-second", now);
    await register(first, second);
    const budgetSource = { id: "web", maxConcurrent: 2, maxQueued: 4 };
    const firstRequest = {
      ...request("budget-first-request", "budget-first-thread"),
      source: budgetSource,
    };
    const secondRequest = {
      ...request("budget-second-request", "budget-second-thread"),
      source: budgetSource,
    };
    expect(await first.admit(firstRequest)).toEqual({ status: "admitted", attempt: 1 });
    expect(await second.admit(secondRequest)).toEqual({ status: "admitted", attempt: 1 });
    const firstClaim = await first.claim(firstRequest);
    const secondClaim = await second.claim(secondRequest);
    if (firstClaim.status !== "acquired" || secondClaim.status !== "acquired") {
      throw new Error("expected two active budget leases");
    }
    const input = {
      policyId: "support",
      peerId: "visitor:shared",
      trustLevel: "public" as const,
      publicSubstate: "recognized" as const,
    };
    const [firstResult, secondResult] = await Promise.all([
      first.reserveBudget(firstClaim.lease, {
        ...input,
        threadId: firstClaim.lease.threadId,
      }),
      second.reserveBudget(secondClaim.lease, {
        ...input,
        threadId: secondClaim.lease.threadId,
      }),
    ]);
    expect([firstResult.status, secondResult.status].sort()).toEqual(["rejected", "reserved"]);
    const winner = firstResult.status === "reserved" ? first : second;
    const winnerLease = firstResult.status === "reserved" ? firstClaim.lease : secondClaim.lease;
    const loser = firstResult.status === "reserved" ? second : first;
    const loserLease = firstResult.status === "reserved" ? secondClaim.lease : firstClaim.lease;
    expect(await winner.releaseBudget(winnerLease, "support")).toEqual({ status: "ok" });
    expect(
      await loser.reserveBudget(loserLease, { ...input, threadId: loserLease.threadId }),
    ).toMatchObject({ status: "reserved", admissionDay: "2026-07-27" });
    expect(await loser.markExecutionStarted(loserLease)).toEqual({ status: "ok" });
    expect(await loser.releaseBudget(loserLease, "support")).toEqual({ status: "stale" });
  });

  test("rejects threshold policies that collide at persisted ppm precision", () => {
    expect(() =>
      budgetReplica("budget-threshold-collision", () => Date.UTC(2026, 6, 27), {
        dailyBudgetUsd: 1,
        notifications: { destination: "operator", thresholds: [0.5, 0.5000001] },
      }),
    ).toThrow("at most six decimal places");
  });

  test("releases zero-valued peer-day capacity for a different peer", async () => {
    const now = () => Date.UTC(2026, 6, 27, 12);
    const owner = budgetReplica("budget-peer-capacity", now, {
      maxPeerDays: 1,
      caps: { public: { recognized: { maxTurnsPerDay: 10 } } },
    });
    await register(owner);
    const budgetSource = { id: "web", maxConcurrent: 2, maxQueued: 4 };
    const firstRequest = {
      ...request("peer-capacity-first", "peer-capacity-first"),
      source: budgetSource,
    };
    const secondRequest = {
      ...request("peer-capacity-second", "peer-capacity-second"),
      source: budgetSource,
    };
    expect(await owner.admit(firstRequest)).toEqual({ status: "admitted", attempt: 1 });
    expect(await owner.admit(secondRequest)).toEqual({ status: "admitted", attempt: 1 });
    const firstClaim = await owner.claim(firstRequest);
    const secondClaim = await owner.claim(secondRequest);
    if (firstClaim.status !== "acquired" || secondClaim.status !== "acquired") {
      throw new Error("expected peer capacity leases");
    }
    expect(
      await owner.reserveBudget(firstClaim.lease, {
        policyId: "support",
        peerId: "visitor:first",
        threadId: firstClaim.lease.threadId,
        trustLevel: "public",
        publicSubstate: "recognized",
      }),
    ).toMatchObject({ status: "reserved" });
    expect(await owner.releaseBudget(firstClaim.lease, "support")).toEqual({ status: "ok" });
    expect(
      await owner.reserveBudget(secondClaim.lease, {
        policyId: "support",
        peerId: "visitor:second",
        threadId: secondClaim.lease.threadId,
        trustLevel: "public",
        publicSubstate: "recognized",
      }),
    ).toMatchObject({ status: "reserved" });
  });

  test("retains prior-day aggregates and reserves threshold capacity across days", async () => {
    let clock = Date.UTC(2026, 6, 27, 23, 59, 59, 999);
    const owner = budgetReplica("budget-midnight", () => clock, {
      aggregateRetentionDays: 1,
      dailyBudgetUsd: 0.000000001,
      notifications: { destination: "operator", thresholds: [1] },
      maxThresholdIntents: 1,
      caps: { public: { recognized: { maxTurnsPerDay: 10 } } },
    });
    await register(owner);
    const budgetSource = { id: "web", maxConcurrent: 2, maxQueued: 4 };
    const firstRequest = { ...request("midnight-first", "midnight-first"), source: budgetSource };
    const secondRequest = {
      ...request("midnight-second", "midnight-second"),
      source: budgetSource,
    };
    expect(await owner.admit(firstRequest)).toEqual({ status: "admitted", attempt: 1 });
    expect(await owner.admit(secondRequest)).toEqual({ status: "admitted", attempt: 1 });
    const firstClaim = await owner.claim(firstRequest);
    const secondClaim = await owner.claim(secondRequest);
    if (firstClaim.status !== "acquired" || secondClaim.status !== "acquired") {
      throw new Error("expected midnight leases");
    }
    const reservation = (lease: DistributedTurnLease, peerId: string) =>
      owner.reserveBudget(lease, {
        policyId: "support",
        peerId,
        threadId: lease.threadId,
        trustLevel: "public",
        publicSubstate: "recognized",
      });
    expect(await reservation(firstClaim.lease, "visitor:before-midnight")).toMatchObject({
      status: "reserved",
      admissionDay: "2026-07-27",
    });
    clock += 2;
    expect(await reservation(secondClaim.lease, "visitor:after-midnight")).toEqual({
      status: "rejected",
      reason: "budget-capacity",
    });
    const terminal = {
      ...(await atomicCheckpoint(owner, firstClaim.lease)),
      costMarkers: [
        {
          version: 1 as const,
          operationId: `auggy-op-v1-${"9".repeat(64)}`,
          priced: true as const,
          costUsd: 0.000000001,
        },
      ],
    };
    expect(await owner.commitTurn(firstClaim.lease, terminal)).toEqual({ status: "ok" });
  });

  test("enforces exact nano-USD aggregate caps without floating-point drift", async () => {
    const now = () => Date.UTC(2026, 6, 27, 12);
    const owner = budgetReplica("budget-exact-nanos", now, {
      dailyBudgetUsd: 1,
      caps: { public: { recognized: { maxTurnsPerDay: 20 } } },
    });
    await register(owner);
    const budgetSource = { id: "web", maxConcurrent: 2, maxQueued: 4 };
    for (let index = 0; index < 10; index += 1) {
      const turn = {
        ...request(`nano-turn-${index}`, `nano-thread-${index}`),
        source: budgetSource,
      };
      expect(await owner.admit(turn)).toEqual({ status: "admitted", attempt: 1 });
      const claimed = await owner.claim(turn);
      if (claimed.status !== "acquired") throw new Error("expected exact cost lease");
      expect(
        await owner.reserveBudget(claimed.lease, {
          policyId: "support",
          peerId: "visitor:exact-nanos",
          threadId: claimed.lease.threadId,
          trustLevel: "public",
          publicSubstate: "recognized",
        }),
      ).toMatchObject({ status: "reserved" });
      expect(
        await owner.commitTurn(claimed.lease, {
          ...(await atomicCheckpoint(owner, claimed.lease)),
          costMarkers: [
            {
              version: 1,
              operationId: `auggy-op-v1-${index.toString(16).padStart(64, "0")}`,
              priced: true,
              costUsd: 0.1,
            },
          ],
        }),
      ).toEqual({ status: "ok" });
    }

    const denied = { ...request("nano-turn-denied", "nano-thread-denied"), source: budgetSource };
    expect(await owner.admit(denied)).toEqual({ status: "admitted", attempt: 1 });
    const deniedClaim = await owner.claim(denied);
    if (deniedClaim.status !== "acquired") throw new Error("expected denied cost lease");
    expect(
      await owner.reserveBudget(deniedClaim.lease, {
        policyId: "support",
        peerId: "visitor:exact-nanos",
        threadId: deniedClaim.lease.threadId,
        trustLevel: "public",
        publicSubstate: "recognized",
      }),
    ).toEqual({ status: "rejected", reason: "daily-global-usd-cap" });
  });

  test("reclaims recovered outcome-unknown budget evidence after retention", async () => {
    let clock = Date.UTC(2026, 6, 27, 12);
    const policy = {
      maxReservations: 7,
      reservationRetentionMs: 604_800_000,
      caps: { public: { recognized: { maxTurnsPerDay: 10 } } },
    };
    const owner = budgetReplica("budget-recovery-owner", () => clock, policy, 1);
    await register(owner);
    const budgetSource = { id: "web", maxConcurrent: 2, maxQueued: 4 };
    for (let index = 0; index < 7; index += 1) {
      const incident = {
        ...request(`budget-recovery-incident-${index}`, `budget-recovery-incident-${index}`),
        source: budgetSource,
      };
      expect(await owner.admit(incident)).toEqual({ status: "admitted", attempt: 1 });
      const claimed = await owner.claim(incident);
      if (claimed.status !== "acquired") throw new Error("expected recovery incident lease");
      expect(
        await owner.reserveBudget(claimed.lease, {
          policyId: "support",
          peerId: `visitor:incident-${index}`,
          threadId: claimed.lease.threadId,
          trustLevel: "public",
          publicSubstate: "recognized",
        }),
      ).toMatchObject({ status: "reserved" });
      expect(await owner.markExecutionStarted(claimed.lease)).toEqual({ status: "ok" });
      expect(await owner.fail(claimed.lease)).toEqual({ status: "outcome-unknown" });
      expect(
        await owner.recover(
          claimed.lease.threadId,
          claimed.lease.fence,
          "operator-reconciled-budget",
        ),
      ).toEqual({ status: "ok" });
    }

    const saturated = {
      ...request("budget-recovery-saturated", "budget-recovery-saturated"),
      source: budgetSource,
    };
    expect(await owner.admit(saturated)).toEqual({ status: "admitted", attempt: 1 });
    const saturatedClaim = await owner.claim(saturated);
    if (saturatedClaim.status !== "acquired") throw new Error("expected saturated budget lease");
    expect(
      await owner.reserveBudget(saturatedClaim.lease, {
        policyId: "support",
        peerId: "visitor:saturated",
        threadId: saturatedClaim.lease.threadId,
        trustLevel: "public",
        publicSubstate: "recognized",
      }),
    ).toEqual({ status: "rejected", reason: "budget-capacity" });
    expect(await owner.abandon(saturated, saturatedClaim.lease.attempt)).toEqual({ status: "ok" });
    await owner.close();

    clock += 604_800_001;
    const successor = budgetReplica("budget-recovery-successor", () => clock, policy, 1);
    await register(successor);
    const next = {
      ...request("budget-recovery-next", "budget-recovery-next"),
      source: budgetSource,
    };
    expect(await successor.admit(next)).toEqual({ status: "admitted", attempt: 1 });
    const nextClaim = await successor.claim(next);
    if (nextClaim.status !== "acquired") throw new Error("expected successor budget lease");
    expect(
      await successor.reserveBudget(nextClaim.lease, {
        policyId: "support",
        peerId: "visitor:successor",
        threadId: nextClaim.lease.threadId,
        trustLevel: "public",
        publicSubstate: "recognized",
      }),
    ).toMatchObject({ status: "reserved" });
  });

  test("requires one explicit live instance incarnation before any request mutation", async () => {
    let now = 0;
    const first = replica("shared-instance", () => now);
    const collision = replica("shared-instance", () => now);

    expect(await first.admit(request("before-registration"))).toEqual({ status: "unavailable" });
    expect(await first.register()).toEqual({ status: "registered" });
    expect(await collision.register()).toEqual({ status: "conflict" });
    expect(await collision.admit(request("collision-request"))).toEqual({
      status: "unavailable",
    });

    now = 101;
    expect(await first.heartbeatInstance()).toEqual({ status: "stale" });
    expect(await collision.register()).toEqual({ status: "conflict" });
  });

  test("keeps live queued work with its accepting replica and fences exact retry adoption", async () => {
    let now = 0;
    const first = replica("instance-a", () => now);
    const second = replica("instance-b", () => now);
    expect(await first.register()).toEqual({ status: "registered" });
    expect(await second.register()).toEqual({ status: "registered" });

    const live = request("live-owner", "live-thread");
    expect(await first.admit(live)).toEqual({ status: "admitted", attempt: 1 });
    expect(await second.claim(live)).toEqual({ status: "waiting" });
    expect((await first.claim(live)).status).toBe("acquired");

    const adoptable = request("adoptable", "adoptable-thread");
    expect(await first.admit(adoptable)).toEqual({ status: "admitted", attempt: 1 });
    now = 50;
    expect(await second.heartbeatInstance()).toEqual({ status: "ok" });
    now = 101;
    expect(await second.admit(adoptable)).toEqual({ status: "adopted", attempt: 2 });
    expect(await first.heartbeatQueued(adoptable)).toEqual({ status: "stale" });
    expect(await first.abandon(adoptable)).toEqual({ status: "stale" });
    expect((await second.claim(adoptable, 2)).status).toBe("acquired");

    expect(await second.admit(request("adoptable", "changed-thread"))).toEqual({
      status: "conflict",
    });
  });

  test("joins an exact duplicate but rejects a changed canonical binding", async () => {
    const coordinator = replica("instance-a", () => 1);
    await register(coordinator);
    expect(await coordinator.admit(request("request-1"))).toEqual({
      status: "admitted",
      attempt: 1,
    });
    expect(await coordinator.admit(request("request-1"))).toEqual({
      status: "joined",
      state: "queued",
    });
    expect(await coordinator.admit(request("request-1", "thread-2"))).toEqual({
      status: "conflict",
    });
    expect(await coordinator.admit(request("request-1", "thread-1", "a".repeat(32)))).toEqual({
      status: "conflict",
    });
  });

  test("fences delayed queued mutations after same-session adoption", async () => {
    let now = 0;
    const coordinator = replica("instance-a", () => now);
    await register(coordinator);
    const queued = request("same-session-adoption", "thread-adoption");
    expect(await coordinator.admit(queued)).toEqual({ status: "admitted", attempt: 1 });
    now = 50;
    expect(await coordinator.heartbeatInstance()).toEqual({ status: "ok" });
    now = 101;
    expect(await coordinator.admit(queued)).toEqual({ status: "adopted", attempt: 2 });

    expect(await coordinator.heartbeatQueued(queued, 1)).toEqual({ status: "stale" });
    expect(await coordinator.abandon(queued, 1)).toEqual({ status: "stale" });
    expect(await coordinator.heartbeatQueued(queued, 2)).toEqual({ status: "ok" });
    expect((await coordinator.claim(queued, 2)).status).toBe("acquired");
  });

  test("abandons only the matching owned attempt before execution starts", async () => {
    const coordinator = replica("instance-a", () => 1);
    await register(coordinator);

    const canceled = request("pre-start-cancel", "pre-start-thread");
    expect(await coordinator.admit(canceled)).toEqual({ status: "admitted", attempt: 1 });
    expect((await coordinator.claim(canceled, 1)).status).toBe("acquired");
    const canceledSignal = coordinator.ownedSignal(canceled);
    expect(await coordinator.abandon(canceled, 1)).toEqual({ status: "ok" });
    expect(canceledSignal.aborted).toBeTrue();
    expect(await coordinator.status(canceled)).toEqual({ status: "terminal", state: "canceled" });

    const started = request("started-cancel", "started-thread");
    expect(await coordinator.admit(started)).toEqual({ status: "admitted", attempt: 1 });
    const claimed = await coordinator.claim(started, 1);
    if (claimed.status !== "acquired") throw new Error("expected active lease");
    expect(await coordinator.markExecutionStarted(claimed.lease)).toEqual({ status: "ok" });
    expect(await coordinator.abandon(started, 1)).toEqual({ status: "stale" });
    expect(await coordinator.status(started)).toMatchObject({ status: "pending", state: "active" });
  });

  test("rejects mixed protocol or configuration before mutating namespace state", async () => {
    const first = replica("instance-a", () => 1);
    await register(first);
    const drainingRequest = request("request-1");
    expect(await first.admit(drainingRequest)).toEqual({ status: "admitted", attempt: 1 });

    const changedProtocol = replica("instance-b", () => 1, { protocolVersion: 6 });
    expect(await changedProtocol.register()).toEqual({ status: "unavailable" });

    const changedConfiguration = replica("instance-c", () => 1, {
      configurationFingerprint: "c".repeat(64),
    });
    expect(await changedConfiguration.register()).toEqual({
      status: "unavailable",
    });
    const changedLease = replica("instance-d", () => 1, { leaseMs: 200 });
    expect(await changedLease.register()).toEqual({ status: "unavailable" });

    expect(await first.admit(request("request-2"))).toEqual({ status: "admitted", attempt: 1 });
  });

  test("upgrades an exact predecessor only after every replica and request is quiescent", async () => {
    let now = 0;
    const predecessor = {
      protocolVersion: 4,
      protocolFingerprint: "c".repeat(64),
      configurationFingerprint: "d".repeat(64),
    };
    const old = replica("old-instance", () => now, predecessor);
    const current = replica("current-instance", () => now, { upgradeFrom: predecessor });
    expect(await old.register()).toEqual({ status: "registered" });
    const terminal = request("upgrade-terminal", "upgrade-thread");
    expect(await old.admit(terminal)).toEqual({ status: "admitted", attempt: 1 });
    expect(await old.abandon(terminal, 1)).toEqual({ status: "ok" });
    expect(await current.register()).toEqual({ status: "unavailable" });

    now = 101;
    expect(await current.register()).toEqual({ status: "registered" });
    expect(await old.register()).toEqual({ status: "unavailable" });
    expect(await current.status(terminal)).toEqual({ status: "terminal", state: "canceled" });
  });

  test("refuses a predecessor upgrade while queued or active work remains", async () => {
    let now = 0;
    const predecessor = {
      protocolVersion: 4,
      protocolFingerprint: "c".repeat(64),
      configurationFingerprint: "d".repeat(64),
    };
    const old = replica("old-instance", () => now, predecessor);
    const current = replica("current-instance", () => now, { upgradeFrom: predecessor });
    expect(await old.register()).toEqual({ status: "registered" });
    expect(await old.admit(request("upgrade-pending", "pending-thread"))).toEqual({
      status: "admitted",
      attempt: 1,
    });

    now = 101;
    expect(await current.register()).toEqual({ status: "unavailable" });
  });

  test("enforces one active turn per thread across replicas and fences later attempts", async () => {
    const now = 1;
    const first = replica("instance-a", () => now);
    const second = replica("instance-b", () => now);
    await register(first, second);
    await first.admit(request("request-1"));
    const claimed = await first.claim(request("request-1"));
    expect(claimed.status).toBe("acquired");
    expect(await second.claim(request("request-1"))).toEqual({ status: "waiting" });
    if (claimed.status !== "acquired") throw new Error("expected acquisition");
    expect(await completeAtomic(first, claimed.lease)).toEqual({ status: "ok" });
    await second.admit(request("request-2"));
    const later = await second.claim(request("request-2"));
    expect(later.status).toBe("acquired");
    if (later.status !== "acquired") throw new Error("expected acquisition");
    expect(later.lease.fence).toBeGreaterThan(claimed.lease.fence);
    expect(await first.heartbeat(claimed.lease)).toEqual({ status: "stale" });
  });

  test("never admits two active requests for one thread even with spare global capacity", async () => {
    const now = 1;
    const first = replica("instance-a", () => now, { maxConcurrent: 2, maxQueued: 2 });
    const second = replica("instance-b", () => now, { maxConcurrent: 2, maxQueued: 2 });
    await register(first, second);
    await first.admit(request("request-1"));
    const active = await first.claim(request("request-1"));
    if (active.status !== "acquired") throw new Error("expected acquisition");
    await second.admit(request("request-2"));
    expect(await second.claim(request("request-2"))).toEqual({ status: "waiting" });
  });

  test("bounds global and source queues without a process-local bypass", async () => {
    const coordinator = replica("instance-a", () => 1, { maxQueued: 1 });
    await register(coordinator);
    expect(await coordinator.admit(request("request-1"))).toEqual({
      status: "admitted",
      attempt: 1,
    });
    expect(await coordinator.admit(request("request-2", "thread-2"))).toEqual({
      status: "rejected",
      reason: "global-capacity",
    });
    const boundedSource = { ...source, maxQueued: 1 };
    const sourceBound = createInMemoryDistributedTurnCoordinator(
      {
        namespace: "source-prod",
        instanceId: "instance-b",
        maxConcurrent: 1,
        maxQueued: 4,
        maxQueuedPerThread: 2,
        leaseMs: 100,
        ...coordinatorPolicy,
        sources: [boundedSource],
      },
      { now: () => 1 },
    );
    await register(sourceBound);
    await sourceBound.admit({
      ...request("request-3", "thread-3"),
      source: boundedSource,
    });
    expect(
      await sourceBound.admit({
        ...request("request-4", "thread-4"),
        source: boundedSource,
      }),
    ).toEqual({ status: "rejected", reason: "source-capacity" });
  });

  test("allows one direct admission when waiting capacity is zero, then rejects a waiter", async () => {
    const coordinator = replica("instance-a", () => 1, { maxQueued: 0 });
    await register(coordinator);
    expect(await coordinator.admit(request("request-1"))).toEqual({
      status: "admitted",
      attempt: 1,
    });
    expect(await coordinator.admit(request("request-2", "thread-2"))).toEqual({
      status: "rejected",
      reason: "global-capacity",
    });
  });

  test("fails closed on namespace policy drift without mutating the established limits", async () => {
    const restrictive = replica("instance-a", () => 1, { maxConcurrent: 1, maxQueued: 1 });
    const permissive = replica("instance-b", () => 1, { maxConcurrent: 10, maxQueued: 10 });
    await register(restrictive);
    expect(await permissive.register()).toEqual({ status: "unavailable" });
    await restrictive.admit(request("request-1"));
    const active = await restrictive.claim(request("request-1"));
    if (active.status !== "acquired") throw new Error("expected acquisition");
    expect(await permissive.admit(request("request-2", "thread-2"))).toEqual({
      status: "unavailable",
    });
    expect(await restrictive.admit(request("request-3", "thread-3"))).toEqual({
      status: "admitted",
      attempt: 1,
    });
  });

  test("claims the earliest eligible thread head even when a newer replica polls first", async () => {
    let now = 1;
    const wideSource = { id: "web", maxConcurrent: 2, maxQueued: 3 };
    const first = replica("instance-a", () => now++, {
      maxConcurrent: 2,
      maxQueued: 3,
      sources: [wideSource],
    });
    const second = replica("instance-b", () => now++, {
      maxConcurrent: 2,
      maxQueued: 3,
      sources: [wideSource],
    });
    await register(first, second);
    const older = { ...request("older", "thread-older"), source: wideSource };
    const newer = { ...request("newer", "thread-newer"), source: wideSource };
    await first.admit(older);
    await second.admit(newer);
    expect(await second.claim(newer)).toEqual({ status: "waiting" });
    expect((await first.claim(older)).status).toBe("acquired");
  });

  test("does not let a source-saturated queue head block another runnable source", async () => {
    let now = 1;
    const sourceA = { id: "source-a", maxConcurrent: 1, maxQueued: 4 };
    const sourceB = { id: "source-b", maxConcurrent: 1, maxQueued: 4 };
    const coordinator = replica("instance-a", () => now++, {
      maxConcurrent: 2,
      maxQueued: 4,
      sources: [sourceA, sourceB],
    });
    await register(coordinator);
    const activeA = { ...request("a-active", "a-active-thread"), source: sourceA };
    const queuedA = { ...request("a-queued", "a-queued-thread"), source: sourceA };
    const queuedB = { ...request("b-queued", "b-queued-thread"), source: sourceB };
    await coordinator.admit(activeA);
    expect((await coordinator.claim(activeA)).status).toBe("acquired");
    await coordinator.admit(queuedA);
    await coordinator.admit(queuedB);

    expect((await coordinator.claim(queuedB)).status).toBe("acquired");
  });

  test("bounds pending work per thread without consuming another thread's queue budget", async () => {
    const coordinator = createInMemoryDistributedTurnCoordinator(
      {
        namespace: "thread-cap-prod",
        instanceId: "instance-a",
        maxConcurrent: 1,
        maxQueued: 3,
        maxQueuedPerThread: 1,
        leaseMs: 100,
        ...coordinatorPolicy,
      },
      { now: () => 1 },
    );
    await register(coordinator);
    expect(await coordinator.admit(request("thread-first"))).toEqual({
      status: "admitted",
      attempt: 1,
    });
    expect(await coordinator.admit(request("thread-second"))).toEqual({
      status: "rejected",
      reason: "thread-capacity",
    });
    expect(await coordinator.admit(request("other-thread", "thread-2"))).toEqual({
      status: "admitted",
      attempt: 1,
    });
  });

  test("rejects source-policy drift and releases capacity only after a fenced terminal write", async () => {
    const fixedSource = { id: "web", maxConcurrent: 1, maxQueued: 1 };
    const first = replica("instance-a", () => 1, {
      maxConcurrent: 2,
      maxQueued: 3,
      sources: [fixedSource],
    });
    const second = replica("instance-b", () => 1, {
      maxConcurrent: 2,
      maxQueued: 3,
      sources: [fixedSource],
    });
    await register(first, second);
    await first.admit({
      ...request("request-1"),
      source: fixedSource,
    });
    const active = await first.claim({ ...request("request-1"), source: fixedSource });
    if (active.status !== "acquired") throw new Error("expected acquisition");
    expect(
      await second.admit({
        ...request("drifted", "thread-2"),
        source: { id: "web", maxConcurrent: 10, maxQueued: 10 },
      }),
    ).toEqual({ status: "unavailable" });
    const waiting = { ...request("request-2", "thread-2"), source: fixedSource };
    expect(await second.admit(waiting)).toEqual({ status: "admitted", attempt: 1 });
    expect(await second.claim(waiting)).toEqual({ status: "waiting" });
    const terminalCheckpoint = await atomicCheckpoint(first, active.lease);
    expect(
      await first.commitTurn({ ...active.lease, sourceId: "other-source" }, terminalCheckpoint),
    ).toEqual({ status: "stale" });
    expect(await first.commitTurn(active.lease, terminalCheckpoint)).toEqual({ status: "ok" });
    expect((await second.claim(waiting)).status).toBe("acquired");
  });

  test("requeues an unstarted expired lease but quarantines started work until fenced recovery", async () => {
    let now = 0;
    const first = replica("instance-a", () => now);
    const second = replica("instance-b", () => now);
    await register(first, second);
    await first.admit(request("before-start"));
    const acquired = await first.claim(request("before-start"));
    if (acquired.status !== "acquired") throw new Error("expected acquisition");
    now = 50;
    expect(await first.heartbeatInstance()).toEqual({ status: "ok" });
    expect(await second.heartbeatInstance()).toEqual({ status: "ok" });
    now = 101;
    expect(await first.abandon(request("before-start"), acquired.lease.attempt)).toEqual({
      status: "stale",
    });
    expect(await second.claim(request("before-start"))).toEqual({ status: "stale" });
    const adopted = await second.admit(request("before-start"));
    expect(adopted).toEqual({ status: "adopted", attempt: 3 });
    if (adopted.status !== "adopted") throw new Error("expected adoption");
    const reacquired = await second.claim(request("before-start"), adopted.attempt);
    expect(reacquired.status).toBe("acquired");
    if (reacquired.status !== "acquired") throw new Error("expected reacquisition");
    expect(reacquired.lease.fence).toBeGreaterThan(acquired.lease.fence);
    expect(reacquired.lease.attempt).toBeGreaterThan(acquired.lease.attempt);
    expect(await first.heartbeat(acquired.lease)).toEqual({ status: "stale" });

    await second.admit(request("after-start"));
    expect(await completeAtomic(second, reacquired.lease)).toEqual({ status: "ok" });
    const started = await second.claim(request("after-start"));
    if (started.status !== "acquired") throw new Error("expected acquisition");
    expect(await second.markExecutionStarted(started.lease)).toEqual({ status: "ok" });
    now = 149;
    expect(await second.heartbeatInstance()).toEqual({ status: "ok" });
    now = 202;
    expect(await second.claim(request("after-start"))).toEqual({ status: "quarantined" });
    expect(
      await second.recover("thread-1", started.lease.fence, "worker-terminated-after-lease-loss"),
    ).toEqual({ status: "ok" });
  });

  test("invalidates local authority synchronously without waiting for coordinator I/O", async () => {
    const coordinator = replica("instance-a", () => 1);
    await register(coordinator);
    const owned = request("owned-request");
    await coordinator.admit(owned);
    const claimed = await coordinator.claim(owned);
    if (claimed.status !== "acquired") throw new Error("expected acquisition");
    const signal = coordinator.ownedSignal(owned);
    const lateRequest = request("late-mutation", "later-thread");
    const pendingMutation = coordinator.admit(lateRequest);

    coordinator.invalidateLocalAuthority("heartbeat-deadline");

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe("coordinator-authority-lost");
    expect(await pendingMutation).toEqual({ status: "unavailable" });
    expect(await coordinator.heartbeat(claimed.lease)).toEqual({ status: "unavailable" });
    expect(await coordinator.admit(request("later", "later-thread"))).toEqual({
      status: "unavailable",
    });
    const observer = replica("instance-b", () => 1);
    await register(observer);
    expect(await observer.status(lateRequest)).toEqual({ status: "missing" });
  });

  test("permits only fenced pre-start cleanup after local invalidation", async () => {
    const coordinator = replica("instance-a", () => 1);
    await register(coordinator);
    const active = request("invalidated-active", "active-thread");
    const queued = request("invalidated-queued", "queued-thread");
    expect(await coordinator.admit(active)).toEqual({ status: "admitted", attempt: 1 });
    expect((await coordinator.claim(active, 1)).status).toBe("acquired");
    expect(await coordinator.admit(queued)).toEqual({ status: "admitted", attempt: 1 });

    coordinator.invalidateLocalAuthority("heartbeat-deadline");

    expect(await coordinator.abandon(active, 1)).toEqual({ status: "ok" });
    expect(await coordinator.abandon(queued, 1)).toEqual({ status: "ok" });
    expect(await coordinator.admit(request("not-cleanup", "other-thread"))).toEqual({
      status: "unavailable",
    });
    const observer = replica("instance-b", () => 1);
    await register(observer);
    expect(await observer.status(active)).toEqual({ status: "terminal", state: "canceled" });
    expect(await observer.status(queued)).toEqual({ status: "terminal", state: "canceled" });
  });

  test("turns post-start failure into outcome-unknown quarantine before releasing a thread", async () => {
    const first = replica("instance-a", () => 1);
    const second = replica("instance-b", () => 1);
    await register(first, second);
    const effecting = request("effecting", "effect-thread");
    expect(await first.admit(effecting)).toEqual({ status: "admitted", attempt: 1 });
    const claimed = await first.claim(effecting);
    if (claimed.status !== "acquired") throw new Error("expected acquisition");
    expect(await first.markExecutionStarted(claimed.lease)).toEqual({ status: "ok" });
    expect(await first.fail(claimed.lease)).toEqual({ status: "outcome-unknown" });
    expect(await second.claim(effecting)).toEqual({ status: "quarantined" });
    expect(await second.admit(request("later-effect", "effect-thread"))).toEqual({
      status: "rejected",
      reason: "thread-quarantined",
    });
    expect(
      await second.recover("effect-thread", claimed.lease.fence, "execution-failed-after-start"),
    ).toEqual({ status: "ok" });
  });

  test("replays bounded terminal results only for the exact canonical binding", async () => {
    const first = replica("instance-a", () => 1);
    const second = replica("instance-b", () => 1);
    await register(first, second);
    const completed = request("result-request", "result-thread");
    await first.admit(completed);
    const claimed = await first.claim(completed);
    if (claimed.status !== "acquired") throw new Error("expected result lease");

    const exactResult = distributedReplayAtBytes(
      claimed.lease.threadId,
      coordinatorPolicy.result.maxReplayBytes,
    );
    expect(exactResult.body.byteLength).toBe(coordinatorPolicy.result.maxReplayBytes);
    expect(await completeAtomic(first, claimed.lease, exactResult)).toEqual({ status: "ok" });
    const status = await second.status(completed);
    expect(status).toEqual({ status: "completed", result: exactResult });
    if (status.status !== "completed") throw new Error("expected replay");
    status.result.body[0] = 0;
    expect(await second.status(completed)).toEqual({ status: "completed", result: exactResult });
    expect(await second.status({ ...completed, threadId: "changed-thread" })).toEqual({
      status: "conflict",
    });
    expect(await second.wait(completed, { timeoutMs: 0, pollMs: 10 })).toEqual({
      status: "completed",
      result: exactResult,
    });

    const oversized = request("oversized-result", "oversized-thread");
    await first.admit(oversized);
    const oversizedLease = await first.claim(oversized);
    if (oversizedLease.status !== "acquired") throw new Error("expected oversized lease");
    const oversizedCheckpoint = await atomicCheckpoint(
      first,
      oversizedLease.lease,
      distributedReplayAtBytes(
        oversizedLease.lease.threadId,
        coordinatorPolicy.result.maxReplayBytes + 1,
      ),
    );
    expect(await first.commitTurn(oversizedLease.lease, oversizedCheckpoint)).toEqual({
      status: "rejected",
      reason: "result-too-large",
    });
    expect(await second.status(oversized)).toEqual({ status: "pending", state: "active" });
    expect(
      await first.commitTurn(oversizedLease.lease, {
        ...oversizedCheckpoint,
        replay: distributedReplay(oversizedLease.lease.threadId, "smaller"),
      }),
    ).toEqual({ status: "ok" });

    const pending = request("aborted-wait", "aborted-thread");
    await first.admit(pending);
    const abort = new AbortController();
    abort.abort();
    expect(
      await second.wait(pending, { timeoutMs: 1_000, pollMs: 10, signal: abort.signal }),
    ).toEqual({
      status: "wait-aborted",
    });
  });

  test("cancels locally owned work on queue loss, coordinator loss, and close", async () => {
    const now = 0;
    let unavailable = false;
    const coordinator = replica("instance-a", () => now, {
      failClosed: () => unavailable,
    });
    await register(coordinator);

    const queued = request("queued-signal", "queued-signal-thread");
    expect(await coordinator.admit(queued)).toEqual({ status: "admitted", attempt: 1 });
    const queuedSignal = coordinator.ownedSignal(queued);
    expect(queuedSignal.aborted).toBeFalse();
    expect(await coordinator.beginDrain()).toEqual({ status: "ok" });
    expect(queuedSignal.aborted).toBeTrue();
    expect(queuedSignal.reason).toBe("draining");

    resetInMemoryDistributedCoordination();
    const activeCoordinator = replica("instance-b", () => now, {
      failClosed: () => unavailable,
    });
    await register(activeCoordinator);
    const active = request("active-signal", "active-signal-thread");
    await activeCoordinator.admit(active);
    const claimed = await activeCoordinator.claim(active);
    if (claimed.status !== "acquired") throw new Error("expected active signal lease");
    const activeSignal = activeCoordinator.ownedSignal(active);
    expect(activeSignal.aborted).toBeFalse();
    unavailable = true;
    expect(await activeCoordinator.heartbeatInstance()).toEqual({ status: "unavailable" });
    expect(activeSignal.aborted).toBeTrue();
    expect(activeSignal.reason).toBe("coordinator-authority-lost");

    unavailable = false;
    resetInMemoryDistributedCoordination();
    const failing = replica("instance-failure", () => now, {
      failClosed: () => unavailable,
    });
    await register(failing);
    const unsettled = request("unavailable-failure", "unavailable-failure-thread");
    await failing.admit(unsettled);
    const unsettledLease = await failing.claim(unsettled);
    if (unsettledLease.status !== "acquired") throw new Error("expected unsettled lease");
    const unsettledSignal = failing.ownedSignal(unsettled);
    unavailable = true;
    expect(await failing.fail(unsettledLease.lease)).toEqual({ status: "unavailable" });
    expect(unsettledSignal.aborted).toBeTrue();
    expect(unsettledSignal.reason).toBe("coordinator-authority-lost");

    unavailable = false;
    resetInMemoryDistributedCoordination();
    const closing = replica("instance-c", () => now);
    await register(closing);
    const closingRequest = request("closing-signal", "closing-thread");
    await closing.admit(closingRequest);
    const closingSignal = closing.ownedSignal(closingRequest);
    await closing.close();
    expect(closingSignal.aborted).toBeTrue();
    expect(closingSignal.reason).toBe("coordinator-closed");
  });

  test("sweeps an expired started lease during health and frees zero-queue capacity", async () => {
    let now = 0;
    const coordinator = replica("instance-a", () => now, {
      maxConcurrent: 1,
      maxQueued: 0,
    });
    await register(coordinator);
    const startedRequest = request("started");
    await coordinator.admit(startedRequest);
    const started = await coordinator.claim(startedRequest);
    if (started.status !== "acquired") throw new Error("expected acquisition");
    expect(await coordinator.markExecutionStarted(started.lease)).toEqual({ status: "ok" });

    now = 50;
    expect(await coordinator.heartbeatInstance()).toEqual({ status: "ok" });
    now = 101;
    expect(await coordinator.health()).toMatchObject({
      active: 0,
      queued: 0,
      quarantined: 1,
    });
    expect(await coordinator.admit(request("same-thread"))).toEqual({
      status: "rejected",
      reason: "thread-quarantined",
    });
    expect(await coordinator.admit(request("other-thread", "thread-2"))).toEqual({
      status: "admitted",
      attempt: 1,
    });
  });

  test("bounds replay and events while preserving unresolved incidents and monotonic fences", async () => {
    let now = 0;
    const coordinator = createInMemoryDistributedTurnCoordinator(
      {
        namespace: "retention-prod",
        instanceId: "retention-replica",
        maxConcurrent: 1,
        maxQueued: 2,
        maxQueuedPerThread: 2,
        leaseMs: 200_000,
        ...coordinatorPolicy,
        retention: {
          terminalRequestRetentionMs: 60_000,
          maxTerminalRequests: 2,
          eventRetentionMs: 60_000,
          maxEvents: 1,
        },
      },
      { now: () => now },
    );
    await register(coordinator);

    let firstFence = 0;
    for (const [index, [requestId, threadId]] of (
      [
        ["retained-first", "reused-thread"],
        ["retained-second", "retained-thread-2"],
        ["retained-third", "retained-thread-3"],
      ] as const
    ).entries()) {
      now = index;
      const item = request(requestId, threadId);
      expect(await coordinator.admit(item)).toEqual({ status: "admitted", attempt: 1 });
      const claimed = await coordinator.claim(item);
      if (claimed.status !== "acquired") throw new Error("expected retention lease");
      if (index === 0) firstFence = claimed.lease.fence;
      expect(
        await completeAtomic(
          coordinator,
          claimed.lease,
          distributedReplay(claimed.lease.threadId, requestId),
        ),
      ).toEqual({
        status: "ok",
      });
    }

    now = 3;
    const unknown = request("unknown-incident", "unknown-thread");
    expect(await coordinator.admit(unknown)).toEqual({ status: "admitted", attempt: 1 });
    const unknownLease = await coordinator.claim(unknown);
    if (unknownLease.status !== "acquired") throw new Error("expected incident lease");
    expect(await coordinator.markExecutionStarted(unknownLease.lease)).toEqual({ status: "ok" });
    expect(await coordinator.fail(unknownLease.lease)).toEqual({ status: "outcome-unknown" });

    now = 59_000;
    expect(await coordinator.heartbeatInstance()).toEqual({ status: "ok" });
    now = 60_003;
    expect(await coordinator.prune(1)).toEqual({
      status: "ok",
      events: 0,
      instances: 0,
      requests: 1,
      threads: 1,
    });
    expect(await coordinator.status(request("retained-first", "reused-thread"))).toEqual({
      status: "missing",
    });
    expect(await coordinator.status(unknown)).toEqual({ status: "quarantined" });
    expect(await coordinator.events({ limit: 1 })).toMatchObject({
      status: "ok",
      events: [{ eventType: "outcome_unknown", requestId: unknown.requestId }],
    });
    expect(await coordinator.events({ afterEventId: "01", limit: 1 })).toEqual({
      status: "unavailable",
    });

    expect(
      await coordinator.recover(unknown.threadId, unknownLease.lease.fence, "operator-reconciled"),
    ).toEqual({ status: "ok" });
    expect(await coordinator.status(unknown)).toEqual({ status: "terminal", state: "failed" });
    const firstPage = await coordinator.events({ limit: 1 });
    if (firstPage.status !== "ok") throw new Error("expected event page");
    expect(firstPage.events[0]?.eventType).toBe("outcome_unknown");
    if (!firstPage.nextEventId) throw new Error("expected event cursor");
    const secondPage = await coordinator.events({
      afterEventId: firstPage.nextEventId,
      limit: 1,
    });
    expect(secondPage).toMatchObject({
      status: "ok",
      events: [{ eventType: "operator_recovery", requestId: unknown.requestId }],
    });

    const reused = request("reused-after-prune", "reused-thread");
    expect(await coordinator.admit(reused)).toEqual({ status: "admitted", attempt: 1 });
    const reusedLease = await coordinator.claim(reused);
    if (reusedLease.status !== "acquired") throw new Error("expected reused thread lease");
    expect(reusedLease.lease.fence).toBeGreaterThan(firstFence);
    expect(await completeAtomic(coordinator, reusedLease.lease)).toEqual({ status: "ok" });

    now = 120_004;
    expect(await coordinator.prune(1)).toMatchObject({
      status: "ok",
      events: 1,
      requests: 1,
    });
    expect(await coordinator.events({ limit: 10 })).toMatchObject({
      status: "ok",
      events: [{ eventType: "operator_recovery" }],
    });
  });

  test("isolates namespaces, rejects admission on a draining replica, and fails closed during outage", async () => {
    const first = replica("instance-a", () => 1);
    const other = createInMemoryDistributedTurnCoordinator(
      {
        namespace: "concierge-prod",
        instanceId: "instance-b",
        maxConcurrent: 1,
        maxQueued: 1,
        maxQueuedPerThread: 1,
        leaseMs: 100,
        ...coordinatorPolicy,
      },
      { now: () => 1 },
    );
    const drainingStandby = replica("instance-c", () => 1);
    await register(first, other, drainingStandby);
    const drainingRequest = request("request-1");
    expect(await first.admit(drainingRequest)).toEqual({ status: "admitted", attempt: 1 });
    expect(await other.admit(request("request-1"))).toEqual({ status: "admitted", attempt: 1 });
    expect(await drainingStandby.beginDrain()).toEqual({ status: "ok" });
    expect(await drainingStandby.claim(drainingRequest, 1)).toEqual({ status: "waiting" });
    expect(await first.beginDrain()).toEqual({ status: "ok" });
    expect(await first.admit(request("request-2", "thread-2"))).toEqual({
      status: "rejected",
      reason: "draining",
    });
    expect(await first.health()).toMatchObject({ status: "draining" });
    const unavailable = replica("instance-d", () => 1, { failClosed: () => true });
    expect(await unavailable.admit(request("request-3", "thread-3"))).toEqual({
      status: "unavailable",
    });
    expect(await unavailable.health()).toEqual({
      status: "unavailable",
      active: 0,
      queued: 0,
      quarantined: 0,
    });
  });

  test("rejects legacy replay-only completion for a current-protocol execution", async () => {
    const coordinator = replica("atomic-only-owner", () => 1);
    await register(coordinator);
    const item = request("atomic-only", "atomic-only-thread");
    expect(await coordinator.admit(item)).toEqual({ status: "admitted", attempt: 1 });
    const claimed = await coordinator.claim(item);
    if (claimed.status !== "acquired") throw new Error("expected atomic-only lease");
    expect(await coordinator.markExecutionStarted(claimed.lease)).toEqual({ status: "ok" });
    expect(await coordinator.complete(claimed.lease, replay({ bypass: true }))).toEqual({
      status: "rejected",
      reason: "atomic-turn-state-required",
    });
    expect(await coordinator.status(item)).toEqual({ status: "pending", state: "active" });
  });

  test("claims peer-bound history and commits the complete turn state atomically", async () => {
    const first = replica("turn-state-owner", () => 1);
    const reader = replica("turn-state-reader", () => 1);
    await register(first, reader);

    const item = request("turn-state-request", "turn-state-thread");
    expect(await first.admit(item)).toEqual({ status: "admitted", attempt: 1 });
    const claimed = await first.claim(item);
    if (claimed.status !== "acquired") throw new Error("expected turn-state lease");

    const peerBinding = {
      version: 1 as const,
      bindingHash: "d".repeat(64),
      peerIdHash: "e".repeat(64),
      promotionScopeHash: "f".repeat(64),
      trustLevel: "public" as const,
      publicSubstate: "recognized" as const,
    };
    const loaded = await first.loadHistory(claimed.lease, peerBinding);
    expect(loaded).toMatchObject({ status: "ok", revision: 0, messageCount: 0 });
    if (loaded.status !== "ok") throw new Error("expected claimed history");
    expect(JSON.parse(new TextDecoder().decode(loaded.body))).toEqual({
      version: 1,
      messages: [],
    });

    expect(await first.markExecutionStarted(claimed.lease)).toEqual({ status: "ok" });
    const historyBody = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        messages: [
          {
            id: "message-1",
            role: "assistant",
            content: "committed",
            timestamp: 1,
            tokenCount: 1,
          },
        ],
      }),
    );
    const replayResult = distributedReplay(claimed.lease.threadId, "committed");
    expect(
      await first.commitTurn(claimed.lease, {
        peerBinding,
        expectedHistoryRevision: 0,
        history: { version: 1, body: historyBody, messageCount: 1 },
        replay: replayResult,
        costMarkers: [
          {
            version: 1,
            operationId: `auggy-op-v1-${"1".repeat(64)}`,
            priced: true,
            costUsd: 0.001,
          },
        ],
        outboxIntents: [
          {
            version: 1,
            ordinal: 0,
            operationId: `auggy-op-v1-${"2".repeat(64)}`,
            body: new TextEncoder().encode(
              JSON.stringify({ version: 1, targetAugment: "test-transport", text: "committed" }),
            ),
            contentType: "application/json",
            retryMode: "never",
            maxAttempts: 1,
          },
        ],
      }),
    ).toEqual({ status: "ok" });

    expect(await reader.status(item)).toEqual({ status: "completed", result: replayResult });

    const next = request("turn-state-next", item.threadId);
    expect(await reader.admit(next)).toEqual({ status: "admitted", attempt: 1 });
    const nextClaim = await reader.claim(next);
    if (nextClaim.status !== "acquired") throw new Error("expected next turn-state lease");
    const reloaded = await reader.loadHistory(nextClaim.lease, peerBinding);
    expect(reloaded).toMatchObject({ status: "ok", revision: 1, messageCount: 1 });
    if (reloaded.status !== "ok") throw new Error("expected reloaded history");
    expect(reloaded.body).toEqual(historyBody);

    expect(
      await reader.loadHistory(nextClaim.lease, {
        ...peerBinding,
        bindingHash: "0".repeat(64),
        peerIdHash: "9".repeat(64),
      }),
    ).toEqual({ status: "denied" });
  });

  test("reserves history capacity without materializing abandoned pre-start threads", async () => {
    const capacitySource = { id: "web", maxConcurrent: 2, maxQueued: 2 };
    const coordinator = replica("history-capacity-owner", () => 1, {
      maxConcurrent: 2,
      sources: [capacitySource],
      historyMaxThreads: 1,
    });
    await register(coordinator);
    const first = {
      ...request("history-reservation-1", "reserved-thread"),
      source: capacitySource,
    };
    const second = { ...request("history-reservation-2", "next-thread"), source: capacitySource };
    expect(await coordinator.admit(first)).toEqual({ status: "admitted", attempt: 1 });
    expect(await coordinator.admit(second)).toEqual({ status: "admitted", attempt: 1 });
    const firstClaim = await coordinator.claim(first);
    const secondClaim = await coordinator.claim(second);
    if (firstClaim.status !== "acquired" || secondClaim.status !== "acquired") {
      throw new Error("expected concurrent history reservations");
    }

    expect(await coordinator.loadHistory(firstClaim.lease, atomicPeerBinding)).toMatchObject({
      status: "ok",
      revision: 0,
    });
    expect(await coordinator.loadHistory(secondClaim.lease, atomicPeerBinding)).toEqual({
      status: "rejected",
      reason: "history-capacity",
    });
    expect(await coordinator.abandon(first, firstClaim.lease.attempt)).toEqual({ status: "ok" });
    expect(await coordinator.loadHistory(secondClaim.lease, atomicPeerBinding)).toMatchObject({
      status: "ok",
      revision: 0,
    });
  });

  test("fails a stale atomic commit without publishing history or replay", async () => {
    let now = 1;
    const first = replica("stale-turn-state-owner", () => now);
    await register(first);

    const item = request("stale-turn-state-request", "stale-turn-state-thread");
    expect(await first.admit(item)).toEqual({ status: "admitted", attempt: 1 });
    const claimed = await first.claim(item);
    if (claimed.status !== "acquired") throw new Error("expected turn-state lease");
    const peerBinding = {
      version: 1 as const,
      bindingHash: "1".repeat(64),
      peerIdHash: "2".repeat(64),
      promotionScopeHash: "3".repeat(64),
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
    };
    expect(await first.loadHistory(claimed.lease, peerBinding)).toMatchObject({
      status: "ok",
      revision: 0,
    });
    expect(await first.markExecutionStarted(claimed.lease)).toEqual({ status: "ok" });

    now = 102;
    expect(
      await first.commitTurn(claimed.lease, {
        peerBinding,
        expectedHistoryRevision: 0,
        history: {
          version: 1,
          body: new TextEncoder().encode(
            JSON.stringify({
              version: 1,
              messages: [
                {
                  id: "must-not-publish",
                  role: "assistant",
                  content: "must not publish",
                  timestamp: 1,
                  tokenCount: 1,
                },
              ],
            }),
          ),
          messageCount: 1,
        },
        replay: distributedReplay(claimed.lease.threadId, "must-not-replay"),
        costMarkers: [],
        outboxIntents: [],
      }),
    ).toEqual({ status: "stale" });
    const reader = replica("stale-turn-state-reader", () => now);
    await register(reader);
    expect(await reader.status(item)).toEqual({ status: "quarantined" });
    expect(await reader.recover(item.threadId, claimed.lease.fence, "verified-no-effect")).toEqual({
      status: "ok",
    });

    const next = request("after-stale-turn-state", item.threadId);
    expect(await reader.admit(next)).toEqual({ status: "admitted", attempt: 1 });
    const nextClaim = await reader.claim(next);
    if (nextClaim.status !== "acquired") throw new Error("expected recovered lease");
    const loaded = await reader.loadHistory(nextClaim.lease, peerBinding);
    expect(loaded).toMatchObject({ status: "ok", revision: 0, messageCount: 0 });
    if (loaded.status !== "ok") throw new Error("expected empty recovered history");
    expect(JSON.parse(new TextDecoder().decode(loaded.body))).toEqual({
      version: 1,
      messages: [],
    });
  });

  test("permits only an authenticated peer promotion with exact predecessor evidence", async () => {
    const coordinator = replica("promotion-owner", () => 1);
    await register(coordinator);
    const anonymous = {
      version: 1 as const,
      bindingHash: "4".repeat(64),
      peerIdHash: "5".repeat(64),
      promotionScopeHash: "6".repeat(64),
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
    };
    const firstRequest = request("anonymous-turn", "promotion-thread");
    expect(await coordinator.admit(firstRequest)).toEqual({ status: "admitted", attempt: 1 });
    const firstLease = await coordinator.claim(firstRequest);
    if (firstLease.status !== "acquired") throw new Error("expected anonymous lease");
    expect(await coordinator.loadHistory(firstLease.lease, anonymous)).toMatchObject({
      status: "ok",
    });
    expect(await coordinator.markExecutionStarted(firstLease.lease)).toEqual({ status: "ok" });
    expect(
      await coordinator.commitTurn(firstLease.lease, {
        peerBinding: anonymous,
        expectedHistoryRevision: 0,
        history: {
          version: 1,
          body: new TextEncoder().encode(JSON.stringify({ version: 1, messages: [] })),
          messageCount: 0,
        },
        replay: distributedReplay(firstLease.lease.threadId),
        costMarkers: [],
        outboxIntents: [],
      }),
    ).toEqual({ status: "ok" });

    const recognized = {
      ...anonymous,
      bindingHash: "7".repeat(64),
      peerIdHash: "8".repeat(64),
      publicSubstate: "recognized" as const,
      priorPeerIdHash: anonymous.peerIdHash,
    };
    const promotedRequest = request("recognized-turn", firstRequest.threadId);
    expect(await coordinator.admit(promotedRequest)).toEqual({ status: "admitted", attempt: 1 });
    const promotedLease = await coordinator.claim(promotedRequest);
    if (promotedLease.status !== "acquired") throw new Error("expected promotion lease");
    expect(
      await coordinator.loadHistory(promotedLease.lease, {
        ...recognized,
        promotionScopeHash: "9".repeat(64),
      }),
    ).toEqual({ status: "denied" });
    expect(await coordinator.loadHistory(promotedLease.lease, recognized)).toMatchObject({
      status: "ok",
      revision: 1,
    });
    expect(
      await coordinator.complete(promotedLease.lease, replay({ responseText: "bypass" })),
    ).toEqual({ status: "rejected", reason: "atomic-turn-state-required" });
  });

  test("rejects malformed or oversized atomic turn-state before mutation", async () => {
    const coordinator = replica("bounded-turn-state-owner", () => 1);
    await register(coordinator);
    const item = request("bounded-turn-state", "bounded-turn-state-thread");
    expect(await coordinator.admit(item)).toEqual({ status: "admitted", attempt: 1 });
    const claimed = await coordinator.claim(item);
    if (claimed.status !== "acquired") throw new Error("expected bounded state lease");
    const peerBinding = {
      version: 1 as const,
      bindingHash: "a".repeat(64),
      peerIdHash: "b".repeat(64),
      promotionScopeHash: "c".repeat(64),
      trustLevel: "agent" as const,
    };
    expect(await coordinator.loadHistory(claimed.lease, peerBinding)).toMatchObject({
      status: "ok",
    });
    expect(await coordinator.markExecutionStarted(claimed.lease)).toEqual({ status: "ok" });
    const base = {
      peerBinding,
      expectedHistoryRevision: 0,
      history: {
        version: 1 as const,
        body: new TextEncoder().encode(JSON.stringify({ version: 1, messages: [] })),
        messageCount: 0,
      },
      replay: distributedReplay(claimed.lease.threadId),
      costMarkers: [],
      outboxIntents: [],
    };
    expect(
      await coordinator.commitTurn(claimed.lease, {
        ...base,
        history: {
          ...base.history,
          body: new Uint8Array(coordinatorPolicy.turnState.history.maxSnapshotBytes + 1),
        },
      }),
    ).toEqual({ status: "rejected", reason: "history-too-large" });
    expect(
      await coordinator.commitTurn(claimed.lease, {
        ...base,
        history: {
          ...base.history,
          body: new TextEncoder().encode("not-json"),
        },
      }),
    ).toEqual({ status: "rejected", reason: "invalid-history" });
    expect(
      await coordinator.commitTurn(claimed.lease, {
        ...base,
        history: {
          version: 1,
          body: new TextEncoder().encode(
            JSON.stringify({ version: 1, messages: [{ id: "not-a-message" }] }),
          ),
          messageCount: 1,
        },
      }),
    ).toEqual({ status: "rejected", reason: "invalid-history" });
    expect(
      await coordinator.commitTurn(claimed.lease, {
        ...base,
        replay: replay({ version: 1, turnId: "turn-1", threadId: item.threadId }),
      }),
    ).toEqual({ status: "rejected", reason: "invalid-result" });
    expect(
      await coordinator.commitTurn(claimed.lease, {
        ...base,
        replay: distributedReplay("different-thread"),
      }),
    ).toEqual({ status: "rejected", reason: "invalid-result" });
    expect(await coordinator.status(item)).toEqual({ status: "pending", state: "active" });
  });
});
