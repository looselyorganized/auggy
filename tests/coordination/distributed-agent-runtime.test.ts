import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { defineAgent } from "../../src/agent";
import { layeredMemory } from "../../src/augments/layeredMemory";
import { budgets } from "../../src/augments/budgets";
import type { ExtractionCompleteOptions } from "../../src/augments/layeredMemory/extractor/inject-handler";
import {
  createCanonicalDistributedTurnRequest,
  createDistributedRootTurnRuntime,
  createInMemoryDistributedTurnCoordinator,
  resetInMemoryDistributedCoordination,
} from "../../src/coordination";
import {
  decodeDistributedOutboxBody,
  decodeDistributedReplay,
} from "../../src/coordination/agent-turn-state";
import type { DistributedTurnCoordinator } from "../../src/coordination/types";
import {
  attachDistributedRuntimeForTest,
  type DistributedAgentRuntimeTestAdapter,
} from "../../src/coordination/testing-agent-runtime";
import { emptyTrace } from "../../src/kernel/trace-emitter";
import { registerCoordinatorBudgetTurnGate } from "../../src/kernel/turn-gate-authority";
import type {
  AgentConfig,
  Augment,
  ModelClient,
  TransportKernel,
  TurnResult,
  TurnTrigger,
  DistributedBudgetPolicyV1,
  DistributedMemoryPolicyV1,
} from "../../src/types";
import { createMockModel } from "../fixtures/mock-model";
import { createTempDir } from "../fixtures/temp-dir";
import { join } from "node:path";

const source = { id: "kernel:inject", maxConcurrent: 2, maxQueued: 10 } as const;
const resultPolicy = { maxReplayBytes: 65_536 } as const;
const turnStatePolicy = {
  history: { maxSnapshotBytes: 65_536, maxMessages: 100, maxThreads: 1_000 },
  maxCostMarkersPerTurn: 32,
  outbox: { maxIntentsPerTurn: 32, maxIntentBytes: 65_536, maxPendingIntents: 1_000 },
} as const;
const distributedTestBudgetPolicy: DistributedBudgetPolicyV1 = {
  id: "support",
  caps: { public: { recognized: { maxTurnsPerDay: 1 } } },
  maxReservations: 200,
  reservationRetentionMs: 86_400_000,
  maxAnonymousEvents: 100,
  maxPeerDays: 100,
  maxThresholdIntents: 0,
  aggregateRetentionDays: 7,
};
const distributedTestMemoryPolicy: DistributedMemoryPolicyV1 = {
  id: "episodic",
  namespacePrefix: "ep:",
  maxEntries: 100,
  maxEntriesPerPeer: 20,
  maxBytes: 1_048_576,
  maxBytesPerPeer: 262_144,
  maxEntryBytes: 8_192,
  maxQueryBytes: 1_024,
  maxResultBytes: 16_384,
  maxResults: 10,
  maxMutationsPerTurn: 10,
  maxOperations: 100,
  maxTombstones: 100,
  operationRetentionMs: 86_400_000,
  entryRetentionMs: 86_400_000,
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function coordinator(
  instanceId: string,
  leaseMs = 1_000,
  budgetPolicy?: DistributedBudgetPolicyV1,
  memoryPolicy?: DistributedMemoryPolicyV1,
): DistributedTurnCoordinator {
  return createInMemoryDistributedTurnCoordinator({
    namespace: "distributed-agent",
    instanceId,
    buildFingerprint: "c".repeat(64),
    maxConcurrent: 2,
    maxQueued: 10,
    maxQueuedPerThread: 10,
    leaseMs,
    sources: [source],
    retention: {
      terminalRequestRetentionMs: 60_000,
      maxTerminalRequests: 100,
      eventRetentionMs: 60_000,
      maxEvents: 100,
    },
    result: resultPolicy,
    turnState: turnStatePolicy,
    ...(budgetPolicy ? { budgets: { policies: [budgetPolicy] } } : {}),
    ...(memoryPolicy ? { memory: { policies: [memoryPolicy] } } : {}),
    compatibility: {
      protocolVersion: 5,
      protocolFingerprint: "a".repeat(64),
      configurationFingerprint: "b".repeat(64),
    },
  });
}

function adapter(
  owner: DistributedTurnCoordinator,
  options: { leaseMs?: number; heartbeatMs?: number; graceMs?: number } = {},
): DistributedAgentRuntimeTestAdapter {
  return {
    coordinator: owner,
    result: resultPolicy,
    turnState: turnStatePolicy,
    runtime: createDistributedRootTurnRuntime({
      coordinator: owner,
      leaseDurationMs: options.leaseMs ?? 1_000,
      heartbeatIntervalMs: options.heartbeatMs ?? 250,
      claimPollMs: 10,
      maxWaitMs: 1_000,
    }),
    ...(options.graceMs === undefined ? {} : { authorityLossGraceMs: options.graceMs }),
    drainTimeoutMs: 100,
  };
}

function defineDistributedTestAgent(
  config: AgentConfig,
  model: ModelClient,
  distributed: DistributedAgentRuntimeTestAdapter,
) {
  attachDistributedRuntimeForTest(config, distributed);
  return defineAgent(config, model);
}

function trigger(text = "hello"): TurnTrigger {
  return {
    type: "message",
    turnId: "turn-1",
    threadId: "thread-1",
    timestamp: 1,
    source: "trusted-test",
    peer: null,
    payload: {
      parts: [{ kind: "text", text }],
      sourceAugment: "trusted-test",
      peer: null,
      timestamp: 1,
    },
  };
}

const executionContext = {
  version: 1 as const,
  executionId: "execution-1",
  attempt: 1,
  idempotencyKeyHash: "d".repeat(64),
};

afterEach(resetInMemoryDistributedCoordination);

describe("distributed agent runtime wiring", () => {
  test("unbinds coordinator-backed layered memory when an agent stops", async () => {
    const dir = await createTempDir();
    const memory = await layeredMemory({
      backend: "coordinator",
      namespace: "ep",
      distributedPolicy: distributedTestMemoryPolicy,
    });
    let first: ReturnType<typeof defineDistributedTestAgent> | undefined;
    let second: ReturnType<typeof defineDistributedTestAgent> | undefined;
    try {
      first = defineDistributedTestAgent(
        {
          name: "distributed-memory-first",
          model: "mock",
          turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
          augments: [memory],
        },
        createMockModel(),
        adapter(
          coordinator("distributed-memory-first", 1_000, undefined, distributedTestMemoryPolicy),
        ),
      );
      await first.start();
      await first.stop();

      second = defineDistributedTestAgent(
        {
          name: "distributed-memory-second",
          model: "mock",
          turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
          augments: [memory],
        },
        createMockModel(),
        adapter(
          coordinator("distributed-memory-second", 1_000, undefined, distributedTestMemoryPolicy),
        ),
      );
      await expect(second.start()).resolves.toBeUndefined();
    } finally {
      await second?.stop();
      await first?.stop();
      await dir.cleanup();
    }
  });

  test("fails startup before augment boot when identity authority registration conflicts", async () => {
    const owner = coordinator("replica-identity-policy-conflict");
    let bootCalls = 0;
    let closeCalls = 0;
    const config: AgentConfig = {
      name: "distributed-identity-policy-conflict",
      model: "test",
      augments: [
        {
          name: "boot-sentinel",
          onBoot: async () => {
            bootCalls += 1;
          },
        },
      ],
    };
    const distributed = adapter(owner);
    distributed.visitorIdentityAuthority = {
      register: async () => ({ status: "conflict" }),
      issueVerificationRequest: async () => ({ status: "unavailable" }),
      verify: async () => ({ status: "unavailable" }),
      resolveVisitor: async () => ({ status: "unavailable" }),
      canPromote: async () => ({ status: "unavailable" }),
      revokeByEmail: async () => ({ status: "unavailable" }),
      claimExternalAssertion: async () => ({ status: "unavailable" }),
      close: async () => {
        closeCalls += 1;
      },
    };
    const agent = defineDistributedTestAgent(config, createMockModel(), distributed);

    await expect(agent.start()).rejects.toThrow("distributed identity authority is unavailable");
    expect(bootCalls).toBe(0);
    expect(closeCalls).toBe(1);
  });

  test("rejects direct visitor verification delivery before boot in distributed mode", async () => {
    const owner = coordinator("replica-visitor-delivery-disabled");
    let bootCalls = 0;
    const config: AgentConfig = {
      name: "distributed-visitor-delivery-disabled",
      model: "test",
      augments: [
        {
          name: "visitor-auth",
          type: "visitorAuth",
          onBoot: async () => {
            bootCalls += 1;
          },
        },
      ],
    };
    const agent = defineDistributedTestAgent(config, createMockModel(), adapter(owner));

    await expect(agent.start()).rejects.toThrow(
      "direct visitor verification delivery is unavailable in distributed mode",
    );
    expect(bootCalls).toBe(0);
  });

  test("rejects an unprovisioned distributed turn gate before augment boot", async () => {
    const owner = coordinator("replica-unprovisioned-budget");
    let bootCalls = 0;
    const agent = defineDistributedTestAgent(
      {
        name: "distributed-unprovisioned-budget",
        model: "test",
        augments: [
          {
            name: "unprovisioned-gate",
            turnGate: {
              async prepare() {
                throw new Error("must not run");
              },
            },
            onBoot: async () => {
              bootCalls++;
            },
          },
        ],
      },
      createMockModel(),
      adapter(owner),
    );

    await expect(agent.start()).rejects.toThrow("no matching coordinator-owned");
    expect(bootCalls).toBe(0);
  });

  test("enforces one shared peer-day budget across independently routed turns", async () => {
    const owner = coordinator("replica-shared-budget", 1_000, distributedTestBudgetPolicy);
    const reservations: string[] = [];
    const coordinatedOwner = new Proxy(owner, {
      get(target, property, receiver) {
        if (property === "reserveBudget") {
          return async (...args: Parameters<DistributedTurnCoordinator["reserveBudget"]>) => {
            const result = await target.reserveBudget(...args);
            reservations.push(result.status);
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DistributedTurnCoordinator;
    const model = createMockModel({ response: "first allowed" });
    const agent = defineDistributedTestAgent(
      {
        name: "distributed-shared-budget",
        model: "mock",
        augments: [budgets({ backend: "coordinator", policy: distributedTestBudgetPolicy })],
        turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
      },
      model,
      adapter(coordinatedOwner),
    );
    await agent.start();
    const peer = {
      id: "visitor:shared-budget",
      kind: "human" as const,
      trustLevel: "public" as const,
      publicSubstate: "recognized" as const,
      sourceAugment: "trusted-test",
    };
    const first = await agent.inject({ ...trigger(), peer }, { executionContext });
    const second = await agent.inject(
      { ...trigger(), turnId: "turn-2", threadId: "thread-2", peer },
      {
        executionContext: {
          ...executionContext,
          executionId: "execution-2",
          idempotencyKeyHash: "e".repeat(64),
        },
      },
    );

    expect(first).toMatchObject({ success: true, status: "completed" });
    expect(second).toMatchObject({ success: false, status: "rejected" });
    expect(second.error?.message).toBe("daily-turn-cap");
    expect(reservations).toEqual(["reserved", "rejected"]);
    expect(model.calls).toHaveLength(1);
    await agent.stop();
  });

  test("rejects malformed durable replay message and part shapes", () => {
    const encoded = (value: unknown) => ({
      body: new TextEncoder().encode(JSON.stringify(value)),
      contentType: "application/json" as const,
    });
    const envelope = (part: unknown) => ({
      version: 1,
      turnId: "turn-1",
      threadId: "thread-1",
      status: "completed",
      response: { parts: [part] },
    });

    expect(() => decodeDistributedReplay(encoded(envelope({ kind: "data", data: [] })))).toThrow(
      "invalid distributed data part",
    );
    expect(() =>
      decodeDistributedReplay(encoded(envelope({ kind: "unknown", text: "unsafe" }))),
    ).toThrow("invalid distributed message part kind");
    expect(() =>
      decodeDistributedReplay(
        encoded({ ...envelope({ kind: "text", text: "ok" }), response: { parts: [], taskId: 7 } }),
      ),
    ).toThrow("invalid distributed message field");
    expect(() =>
      decodeDistributedReplay(
        encoded(envelope({ kind: "text", text: "wrong thread" })),
        "thread-2",
      ),
    ).toThrow("invalid distributed replay");
  });

  test("rejects a durable delivery with inconsistent routing authority", () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        targetAugment: "telegram-primary",
        peer: {
          id: "peer-1",
          kind: "human",
          trustLevel: "creator",
          sourceAugment: "telegram-primary",
        },
        message: {
          targetAugment: "telegram-secondary",
          parts: [{ kind: "text", text: "must not reroute" }],
        },
      }),
    );

    expect(() => decodeDistributedOutboxBody(encoded)).toThrow(
      "distributed outbox target is inconsistent",
    );
  });

  test("keeps the incomplete runtime seam outside every published export", async () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8"),
    ) as { exports: Record<string, string> };
    expect(Object.values(manifest.exports)).not.toContain(
      "./src/coordination/testing-agent-runtime.ts",
    );
    const agentModule = await import("../../src/agent");
    expect("defineAgentWithDistributedRuntime" in agentModule).toBe(false);
  });

  test("joins an in-flight duplicate on another replica without invoking its model", async () => {
    const firstOwner = coordinator("instance-a");
    const secondOwner = coordinator("instance-b");
    const started = deferred();
    const release = deferred();
    let firstCalls = 0;
    let secondCalls = 0;
    const firstModel: ModelClient = {
      maxContextTokens: 10_000,
      countTokens: () => 1,
      complete: async () => {
        firstCalls++;
        started.resolve();
        await release.promise;
        return {
          content: "done",
          inputTokens: 10,
          outputTokens: 2,
          finishReason: "end_turn",
        };
      },
    };
    const secondModel: ModelClient = {
      maxContextTokens: 10_000,
      countTokens: () => 1,
      complete: async () => {
        secondCalls++;
        return {
          content: "must-not-run",
          inputTokens: 10,
          outputTokens: 2,
          finishReason: "end_turn",
        };
      },
    };
    const config = {
      name: "replicated-agent",
      model: "mock",
      augments: [],
      turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
    };
    const first = defineDistributedTestAgent(config, firstModel, adapter(firstOwner));
    const second = defineDistributedTestAgent(config, secondModel, adapter(secondOwner));
    await first.start();
    await second.start();

    const ownerResult = first.inject(trigger(), { executionContext });
    await started.promise;
    const joinedResult = second.inject(trigger(), { executionContext });
    release.resolve();

    expect((await ownerResult).success).toBe(true);
    expect(await joinedResult).toMatchObject({
      turnId: "turn-1",
      success: true,
      status: "completed",
      response: { parts: [{ kind: "text", text: "done" }] },
      toolCalls: [],
    });
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(0);
    await first.stop();
    await second.stop();
  });

  test("reloads the latest committed history on every arbitrarily routed root turn", async () => {
    const firstOwner = coordinator("history-replica-a");
    const secondOwner = coordinator("history-replica-b");
    const firstPrompts: string[] = [];
    const secondPrompts: string[] = [];
    const firstModel: ModelClient = {
      maxContextTokens: 10_000,
      countTokens: () => 1,
      complete: async (prompt) => {
        firstPrompts.push(JSON.stringify(prompt));
        return {
          content: firstPrompts.length === 1 ? "first-committed" : "third-committed",
          inputTokens: 10,
          outputTokens: 2,
          finishReason: "end_turn",
        };
      },
    };
    const secondModel: ModelClient = {
      maxContextTokens: 10_000,
      countTokens: () => 1,
      complete: async (prompt) => {
        secondPrompts.push(JSON.stringify(prompt));
        return {
          content: "second-committed",
          inputTokens: 10,
          outputTokens: 2,
          finishReason: "end_turn",
        };
      },
    };
    const config = {
      name: "shared-history-agent",
      model: "mock",
      augments: [],
      turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
    };
    const first = defineDistributedTestAgent(config, firstModel, adapter(firstOwner));
    const second = defineDistributedTestAgent(config, secondModel, adapter(secondOwner));
    await first.start();
    await second.start();

    expect((await first.inject(trigger(), { executionContext })).success).toBeTrue();
    expect(
      (
        await second.inject(trigger(), {
          executionContext: {
            ...executionContext,
            executionId: "execution-2",
            idempotencyKeyHash: "e".repeat(64),
          },
        })
      ).success,
    ).toBeTrue();
    expect(secondPrompts[0]).toContain("first-committed");
    expect(
      (
        await first.inject(trigger(), {
          executionContext: {
            ...executionContext,
            executionId: "execution-3",
            idempotencyKeyHash: "f".repeat(64),
          },
        })
      ).success,
    ).toBeTrue();
    expect(firstPrompts[1]).toContain("second-committed");
    await first.stop();
    await second.stop();
  });

  test("denies a changed resolved peer before exposing history or invoking the model", async () => {
    const firstOwner = coordinator("peer-history-a");
    const secondOwner = coordinator("peer-history-b");
    const firstModel = createMockModel({ response: "owner-history" });
    const secondModel = createMockModel({ response: "must-not-run" });
    const config = {
      name: "peer-bound-history-agent",
      model: "mock",
      augments: [],
      turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
    };
    const first = defineDistributedTestAgent(config, firstModel, adapter(firstOwner));
    const second = defineDistributedTestAgent(config, secondModel, adapter(secondOwner));
    await first.start();
    await second.start();
    const ownerTrigger: TurnTrigger = {
      ...trigger(),
      peer: {
        id: "peer-owner",
        kind: "human",
        trustLevel: "public" as const,
        publicSubstate: "recognized" as const,
        sourceAugment: "trusted-test",
      },
    };
    expect((await first.inject(ownerTrigger, { executionContext })).success).toBeTrue();
    const denied = await second.inject(
      {
        ...ownerTrigger,
        peer: { ...ownerTrigger.peer!, id: "peer-impostor" },
      },
      {
        executionContext: {
          ...executionContext,
          executionId: "peer-impostor-execution",
          idempotencyKeyHash: "0".repeat(64),
        },
      },
    );
    expect(denied).toMatchObject({ success: false, status: "rejected" });
    expect(secondModel.calls).toHaveLength(0);
    await first.stop();
    await second.stop();
  });

  test("fences model and tool effects, replays exact duplicates, and rejects changed bindings", async () => {
    const owner = coordinator("instance-a");
    const model = createMockModel();
    model.pushResponse({
      toolCalls: [{ name: "effect", arguments: {} }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "done" });
    const observed: Array<{ attempt?: number; fence?: number; operationId?: string }> = [];
    const agent = defineDistributedTestAgent(
      {
        name: "distributed-agent",
        model: "mock",
        turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
        augments: [
          {
            name: "effects",
            tools: [
              {
                name: "effect",
                description: "record one effect",
                category: "meta",
                input: z.object({}),
                execute: async (_input, context) => {
                  observed.push({
                    attempt: context?.executionAuthority?.attempt,
                    fence: context?.executionAuthority?.fence,
                    operationId: context?.operationId,
                  });
                  return "SENTINEL_PRIVATE_TOOL_OUTPUT";
                },
              },
            ],
          },
        ],
      },
      model,
      adapter(owner),
    );
    await agent.start();

    const first = await agent.inject(trigger(), { executionContext });
    const duplicate = await agent.inject(trigger(), { executionContext });
    const conflict = await agent.inject(trigger("changed"), { executionContext });

    expect(first.success).toBe(true);
    expect(duplicate).toMatchObject({
      turnId: first.turnId,
      success: true,
      status: "completed",
      response: { parts: first.response?.parts },
      toolCalls: [],
    });
    expect(JSON.stringify(duplicate)).not.toContain("SENTINEL_PRIVATE_TOOL_OUTPUT");
    expect(JSON.stringify(duplicate)).not.toContain(executionContext.idempotencyKeyHash);
    expect(duplicate.trace.inferenceSteps).toEqual([]);
    expect(conflict).toMatchObject({ status: "rejected", success: false });
    expect(model.calls).toHaveLength(2);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ attempt: 1, fence: 1 });
    expect(observed[0]?.operationId).toMatch(/^auggy-op-v1-[a-f0-9]{64}$/);
    await agent.stop();
  });

  test("stages cost and delivery while propagating fenced identities to local boundaries", async () => {
    const owner = coordinator("instance-a", 1_000, distributedTestBudgetPolicy);
    let committedCheckpoint: Parameters<DistributedTurnCoordinator["commitTurn"]>[1] | undefined;
    let committedLease: Parameters<DistributedTurnCoordinator["commitTurn"]>[0] | undefined;
    const coordinatedOwner = new Proxy(owner, {
      get(target, property, receiver) {
        if (property === "commitTurn") {
          return async (
            lease: Parameters<DistributedTurnCoordinator["commitTurn"]>[0],
            turnCheckpoint: Parameters<DistributedTurnCoordinator["commitTurn"]>[1],
          ) => {
            committedLease = lease;
            committedCheckpoint = turnCheckpoint;
            return target.commitTurn(lease, turnCheckpoint);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DistributedTurnCoordinator;
    const observed: Array<{
      surface: string;
      authority?: { version?: number; attempt: number; fence: number };
      operationId?: string;
      bindingHash?: string;
    }> = [];
    let resolveDelivery!: () => void;
    const deliveryObserved = new Promise<void>((resolve) => {
      resolveDelivery = resolve;
    });
    const hookResults: TurnResult[] = [];
    const record = (
      surface: string,
      value:
        | {
            executionAuthority?: { version?: number; attempt: number; fence: number };
            operationId?: string;
            executionContext?: { executionId?: string; bindingHash?: string };
          }
        | undefined,
    ) => {
      observed.push({
        surface,
        authority: value?.executionAuthority,
        operationId: value?.operationId,
        bindingHash: value?.executionContext?.bindingHash,
      });
    };
    const effectModel = createMockModel({ response: "delivered" });
    const complete = effectModel.complete.bind(effectModel);
    effectModel.complete = async (prompt, options) => {
      record("model", options);
      return complete(prompt, options);
    };
    const trustedTest: Augment = {
      name: "trusted-test",
      transport: {
        identify: () => null,
        register: async (kernel) => {
          kernel.onOutbound(async (_peer, _message, context) => {
            record("outbound", context);
            resolveDelivery();
          });
        },
      },
      turnGate: {
        prepare: async (args) => {
          record("gate", args);
          return {
            decision: { allow: true },
            confirm: async () => {},
            rollback: async () => {},
          };
        },
        commit: async (args) => {
          record("cost-commit", args);
        },
      },
      onTurnStart: async (turn) => {
        record("turn-start", turn);
      },
      context: async (turn) => {
        record("context", turn);
        return [];
      },
      onTurnEnd: async (hookResult, context) => {
        hookResults.push(hookResult);
        record("turn-end", context);
      },
      scheduleAfterTurn: async (hookResult, context) => {
        hookResults.push(hookResult);
        record("schedule", context);
      },
    };
    registerCoordinatorBudgetTurnGate(trustedTest.turnGate!, distributedTestBudgetPolicy);
    const agent = defineDistributedTestAgent(
      {
        name: "effect-context-agent",
        model: "mock",
        turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
        augments: [trustedTest],
      },
      effectModel,
      adapter(coordinatedOwner),
    );
    await agent.start();
    const result = await agent.inject(
      {
        ...trigger(),
        peer: {
          id: "peer-a",
          kind: "human",
          trustLevel: "creator",
          sourceAugment: "trusted-test",
        },
      },
      { executionContext },
    );

    let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      deliveryObserved,
      new Promise<never>((_, reject) => {
        deliveryTimer = setTimeout(
          () => reject(new Error("timed out waiting for outbox delivery")),
          1_000,
        );
      }),
    ]);
    if (deliveryTimer !== undefined) clearTimeout(deliveryTimer);

    expect(result.success).toBeTrue();
    expect(observed.map((entry) => entry.surface).sort()).toEqual([
      "context",
      "model",
      "outbound",
      "schedule",
      "turn-end",
      "turn-start",
    ]);
    for (const entry of observed.filter((candidate) => candidate.surface !== "outbound")) {
      expect(entry.authority).toEqual({ version: 1, attempt: 1, fence: 1 });
      expect(entry.operationId).toMatch(/^auggy-op-v1-[a-f0-9]{64}$/);
    }
    expect(new Set(observed.map((entry) => entry.operationId)).size).toBe(observed.length);
    expect(committedLease).toMatchObject({ attempt: 1, fence: 1 });
    expect(committedCheckpoint?.costMarkers).toHaveLength(1);
    expect(committedCheckpoint?.outboxIntents).toHaveLength(1);
    expect(committedCheckpoint?.costMarkers[0]?.operationId).toMatch(/^auggy-op-v1-[a-f0-9]{64}$/);
    expect(committedCheckpoint?.outboxIntents[0]?.operationId).toMatch(
      /^auggy-op-v1-[a-f0-9]{64}$/,
    );
    expect(committedCheckpoint?.outboxIntents[0]).toMatchObject({
      retryMode: "never",
      maxAttempts: 1,
    });
    expect(observed.find((entry) => entry.surface === "outbound")).toMatchObject({
      operationId: committedCheckpoint?.outboxIntents[0]?.operationId,
    });
    expect(committedCheckpoint?.costMarkers[0]?.operationId).not.toBe(
      committedCheckpoint?.outboxIntents[0]?.operationId,
    );
    for (const entry of observed) {
      expect(entry.bindingHash).toBeUndefined();
    }
    expect(hookResults).toHaveLength(2);
    for (const hookResult of hookResults) {
      expect(hookResult.executionContext).toBeUndefined();
      expect(hookResult.trace.executionContext).toEqual({
        version: 1,
        executionId: "execution-1",
        attempt: 1,
      });
    }
    await agent.stop();
  });

  test("cancels a non-cooperative delivery and quarantines its effect on shutdown", async () => {
    const owner = coordinator("outbox-shutdown-owner", 1_000, distributedTestBudgetPolicy);
    const deliveryStarted = deferred<{
      signal?: AbortSignal;
      operationId?: string;
    }>();
    const deliverySettled = deferred<{
      lease: Parameters<DistributedTurnCoordinator["settleOutbox"]>[0];
      settlement: Parameters<DistributedTurnCoordinator["settleOutbox"]>[1];
    }>();
    const coordinatedOwner = new Proxy(owner, {
      get(target, property, receiver) {
        if (property === "settleOutbox") {
          return async (
            lease: Parameters<DistributedTurnCoordinator["settleOutbox"]>[0],
            settlement: Parameters<DistributedTurnCoordinator["settleOutbox"]>[1],
          ) => {
            const result = await target.settleOutbox(lease, settlement);
            deliverySettled.resolve({ lease, settlement });
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DistributedTurnCoordinator;
    const never = new Promise<never>(() => {});
    const deliveryAugment: Augment = {
      name: "trusted-test",
      transport: {
        identify: () => null,
        register: async (kernel) => {
          kernel.onOutbound(async (_peer, _message, context) => {
            deliveryStarted.resolve({
              signal: context?.signal,
              operationId: context?.operationId,
            });
            await never;
          });
        },
      },
      turnGate: {
        prepare: async () => ({
          decision: { allow: true },
          confirm: async () => {},
          rollback: async () => {},
        }),
      },
    };
    registerCoordinatorBudgetTurnGate(deliveryAugment.turnGate!, distributedTestBudgetPolicy);
    const agent = defineDistributedTestAgent(
      {
        name: "outbox-shutdown-agent",
        model: "mock",
        turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
        augments: [deliveryAugment],
      },
      createMockModel({ response: "committed before delivery" }),
      adapter(coordinatedOwner),
    );
    await agent.start();
    const result = await agent.inject(
      {
        ...trigger(),
        peer: {
          id: "peer-outbox-shutdown",
          kind: "human",
          trustLevel: "creator",
          sourceAugment: "trusted-test",
        },
      },
      { executionContext },
    );
    expect(result.success).toBeTrue();
    const started = await deliveryStarted.promise;

    await agent.stop();
    const settled = await deliverySettled.promise;

    expect(started.signal?.aborted).toBeTrue();
    expect(started.operationId).toBe(settled.lease.operationId);
    expect(settled.settlement).toEqual({
      outcome: "outcome-unknown",
      reasonCode: "delivery-result-unknown",
    });
  });

  test("rejects an unsafe outbound retry declaration during startup", async () => {
    const owner = coordinator("invalid-outbox-policy-owner");
    const agent = defineDistributedTestAgent(
      {
        name: "invalid-outbox-policy-agent",
        model: "mock",
        augments: [
          {
            name: "invalid-delivery-policy",
            transport: {
              identify: () => null,
              register: async (kernel) => {
                kernel.onOutbound(async () => {}, { retryMode: "never", maxAttempts: 2 });
              },
            },
          },
        ],
      },
      createMockModel(),
      adapter(owner),
    );

    await expect(agent.start()).rejects.toThrow(
      'Augment "invalid-delivery-policy" registered an invalid delivery policy',
    );
  });

  test("bounds shutdown when a coordinator outbox claim does not return", async () => {
    const owner = coordinator("hung-outbox-claim-owner");
    const claimStarted = deferred();
    const never = new Promise<never>(() => {});
    const coordinatedOwner = new Proxy(owner, {
      get(target, property, receiver) {
        if (property === "claimOutbox") {
          return async () => {
            claimStarted.resolve();
            return never;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DistributedTurnCoordinator;
    const agent = defineDistributedTestAgent(
      {
        name: "hung-outbox-claim-agent",
        model: "mock",
        turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
        augments: [],
      },
      createMockModel(),
      adapter(coordinatedOwner),
    );
    await agent.start();
    await claimStarted.promise;

    const startedAt = Date.now();
    await agent.stop();

    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  test("rejects process-local layered memory before distributed startup", async () => {
    const dir = await createTempDir();
    let extractionOptions: ExtractionCompleteOptions | undefined;
    const memory = await layeredMemory({
      backend: "sqlite",
      dbPath: join(dir.path, "memory.db"),
      namespace: "distributed",
      retentionDays: 7,
      autoSave: {
        enabled: true,
        extractionFrequency: { agent: "every-turn" },
        engine: {
          complete: async (_prompt, options) => {
            extractionOptions = options;
            return {
              text: '[{"subject":"peer","predicate":"name","object":"Sam","confidence":0.95,"isVerbatim":true}]',
              costUsd: 0.001,
            };
          },
        },
      },
    });
    try {
      expect(() =>
        defineDistributedTestAgent(
          {
            name: "distributed-memory-agent",
            model: "mock",
            turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
            augments: [memory],
          },
          createMockModel({ response: "Hello Sam" }),
          adapter(coordinator("memory-owner")),
        ),
      ).toThrow(
        'distributed memory provider "layered-memory-distributed" has no coordinator-owned policy',
      );
      expect(extractionOptions).toBeUndefined();
    } finally {
      await memory.onShutdown?.();
      await dir.cleanup();
    }
  });

  test("stages peer memory through the fenced coordinator and never falls back to local storage", async () => {
    const dir = await createTempDir();
    const owner = coordinator(
      "distributed-layered-memory",
      1_000,
      undefined,
      distributedTestMemoryPolicy,
    );
    let searchCalls = 0;
    const wrapped = new Proxy(owner, {
      get(target, property, receiver) {
        if (property === "searchMemory") {
          return (...args: Parameters<DistributedTurnCoordinator["searchMemory"]>) => {
            searchCalls += 1;
            return target.searchMemory(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DistributedTurnCoordinator;
    const memory = await layeredMemory({
      backend: "coordinator",
      namespace: "ep",
      distributedPolicy: distributedTestMemoryPolicy,
    });
    const model = createMockModel();
    model.pushResponse({
      toolCalls: [
        { name: "memory_write", arguments: { topic: "profile", content: "prefers tea" } },
      ],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "saved" });
    model.pushResponse({
      toolCalls: [{ name: "memory_search", arguments: { query: "tea" } }],
      finishReason: "tool_use",
    });
    model.pushResponse({ content: "found" });
    const agent = defineDistributedTestAgent(
      {
        name: "distributed-layered-memory-agent",
        model: "mock",
        turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
        augments: [memory],
      },
      model,
      adapter(wrapped),
    );
    const peer = {
      id: "peer-memory",
      kind: "agent" as const,
      trustLevel: "agent" as const,
      sourceAugment: "trusted-test",
    };

    try {
      await agent.start();
      const written = await agent.inject({ ...trigger(), peer }, { executionContext });
      expect(written.success).toBeTrue();
      expect(written.toolCalls[0]?.output).toContain("STAGED:");

      const read = await agent.inject(
        { ...trigger("recall preferences"), turnId: "turn-2", threadId: "thread-2", peer },
        {
          executionContext: {
            ...executionContext,
            executionId: "execution-2",
            idempotencyKeyHash: "e".repeat(64),
          },
        },
      );
      expect(read.success).toBeTrue();
      // Context synthesis and the tool both use the coordinator. A local
      // SQLite fallback would leave the staged entry invisible here.
      expect(searchCalls).toBeGreaterThanOrEqual(3);
      expect(read.toolCalls[0]?.output).toContain("prefers tea");
      expect(read.toolCalls[0]?.output).toContain("ep:peer-memory:profile");

      const provider = memory.memory;
      if (!provider || !("search" in provider)) throw new Error("expected layered-memory provider");
      await expect(provider.search("tea", { peerId: peer.id })).rejects.toThrow(
        "distributed layered memory authority is required",
      );
      await expect(provider.forget?.(peer.id)).rejects.toThrow(
        "distributed layered memory authority is required",
      );
      await expect(provider.listEntries?.()).rejects.toThrow(
        "distributed layered memory listing requires coordinator authority",
      );
      await expect(memory.adminInfo?.()).rejects.toThrow(
        "distributed layered memory admin reads require coordinator authority",
      );
      await expect(memory.adminActions?.["memory-erase"]?.({ rowKey: peer.id })).resolves.toEqual({
        ok: false,
        message: "distributed layered memory admin erase requires a fenced turn",
      });
      await expect(
        provider.write?.("ep:peer-memory:forged", "local fallback", {
          peerId: peer.id,
          executionContext: { ...executionContext, executionId: "forged" },
          executionAuthority: { version: 1, attempt: 1, fence: 1 },
          operationId: "forged",
        }),
      ).rejects.toThrow("distributed layered memory execution is stale");
    } finally {
      await agent.stop();
      await dir.cleanup();
    }
  });

  test("aborts a non-cooperative terminal hook when distributed authority is lost", async () => {
    const base = coordinator("instance-a", 100);
    const never = new Promise<never>(() => {});
    const hookStarted = deferred<{
      signal?: AbortSignal;
      executionAuthority?: { version?: number; attempt: number; fence: number };
      operationId?: string;
    }>();
    const wrapped = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "heartbeat") return () => never;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DistributedTurnCoordinator;
    const agent = defineDistributedTestAgent(
      {
        name: "hung-hook-agent",
        model: "mock",
        turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
        augments: [
          {
            name: "hung-hook",
            onTurnEnd: async (_result, context) => {
              hookStarted.resolve(context ?? {});
              await never;
            },
          },
        ],
      },
      createMockModel({ response: "parent-done" }),
      adapter(wrapped, { leaseMs: 100, heartbeatMs: 20, graceMs: 10 }),
    );
    await agent.start();
    const running = agent.inject(trigger(), { executionContext });
    const context = await hookStarted.promise;
    const result = await running;

    expect(result).toMatchObject({ success: false, outcomeUnknown: true });
    expect(context.signal?.aborted).toBeTrue();
    expect(context.executionAuthority).toEqual({ version: 1, attempt: 1, fence: 1 });
    expect(context.operationId).toMatch(/^auggy-op-v1-[a-f0-9]{64}$/);
    expect(agent.health().scheduler).toMatchObject({ activeTurns: 0, quarantinedThreads: 1 });
    await agent.stop();
  });

  test("keeps causal child effects under the root lease with distinct operation identities", async () => {
    const owner = coordinator("instance-a");
    const model = createMockModel();
    for (const response of [
      { toolCalls: [{ name: "effect", arguments: {} }], finishReason: "tool_use" as const },
      { content: "parent-done" },
      { toolCalls: [{ name: "effect", arguments: {} }], finishReason: "tool_use" as const },
      { content: "child-done" },
    ]) {
      model.pushResponse(response);
    }
    const authorities: Array<{ attempt: number; fence: number; operationId: string }> = [];
    const agent = defineDistributedTestAgent(
      {
        name: "distributed-causal-agent",
        model: "mock",
        turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
        augments: [
          {
            name: "causal",
            tools: [
              {
                name: "effect",
                description: "record one effect",
                category: "meta",
                input: z.object({}),
                execute: async (_input, context) => {
                  authorities.push({
                    attempt: context!.executionAuthority!.attempt,
                    fence: context!.executionAuthority!.fence,
                    operationId: context!.operationId!,
                  });
                  return "effect-complete";
                },
              },
            ],
            scheduleAfterTurn: async (result, context) => {
              if (result.turnId !== "turn-1") return;
              await context.inject({ ...trigger("child"), turnId: "turn-child" });
            },
          },
        ],
      },
      model,
      adapter(owner),
    );
    await agent.start();
    const result = await agent.inject(trigger(), { executionContext });

    expect(result.success).toBe(true);
    expect(authorities).toHaveLength(2);
    expect(authorities[0]).toMatchObject({ attempt: 1, fence: 1 });
    expect(authorities[1]).toMatchObject({ attempt: 1, fence: 1 });
    expect(authorities[1]?.operationId).not.toBe(authorities[0]?.operationId);
    await agent.stop();
  });

  test("makes the root uncertain when an awaited causal child returns an ordinary failure", async () => {
    const owner = coordinator("instance-a");
    const model = createMockModel({ response: "parent-done" });
    let internalContext:
      | {
          executionAuthority?: { attempt: number; fence: number };
          operationId?: string;
          executionContext?: { executionId: string; attempt: number };
        }
      | undefined;
    const agent = defineDistributedTestAgent(
      {
        name: "causal-result-failure-agent",
        model: "mock",
        turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
        augments: [
          {
            name: "failed-child",
            handleInternalTurn: async (child, context) => {
              internalContext = context;
              return {
                turnId: child.turnId,
                success: false,
                status: "failed",
                toolCalls: [],
                trace: emptyTrace({
                  turnId: child.turnId,
                  threadId: child.threadId ?? child.turnId,
                  trigger: { type: child.type, sourceAugment: child.source },
                }),
              };
            },
            scheduleAfterTurn: async (result, context) => {
              if (result.turnId !== "turn-1") return;
              await context.inject({
                ...trigger("child"),
                type: "internal",
                turnId: "failed-child-turn",
              });
            },
          },
        ],
      },
      model,
      adapter(owner),
    );
    await agent.start();

    const result = await agent.inject(trigger(), { executionContext });

    expect(result).toMatchObject({ success: false, outcomeUnknown: true });
    expect(internalContext).toMatchObject({
      executionAuthority: { attempt: 1, fence: 1 },
      executionContext: { executionId: "execution-1", attempt: 1 },
    });
    expect(internalContext?.operationId).toMatch(/^auggy-op-v1-[a-f0-9]{64}$/);
    expect(agent.health().scheduler.quarantinedThreads).toBe(1);
    await agent.stop();
  });

  test("refuses a replayable success after a swallowed post-marker failure", async () => {
    const owner = coordinator("instance-a");
    const model = createMockModel({ response: "done" });
    const agent = defineDistributedTestAgent(
      {
        name: "uncertain-agent",
        model: "mock",
        turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
        augments: [
          {
            name: "optional-context",
            context: async () => {
              throw new Error("optional dependency failed after effect boundary");
            },
          },
        ],
      },
      model,
      adapter(owner),
    );
    await agent.start();

    const result = await agent.inject(trigger());
    expect(result).toMatchObject({ success: false, outcomeUnknown: true });
    expect(result.executionContext).toBeUndefined();
    expect(model.calls).toHaveLength(1);
    expect(agent.health().scheduler.quarantinedThreads).toBe(1);
    await agent.stop();
  });

  test("quarantines a root when a detached causal child fails after effect start", async () => {
    const owner = coordinator("instance-a");
    let calls = 0;
    const model: ModelClient = {
      maxContextTokens: 10_000,
      countTokens: () => 1,
      complete: async () => {
        calls++;
        if (calls === 1) {
          return {
            content: "parent-done",
            inputTokens: 10,
            outputTokens: 2,
            finishReason: "end_turn",
          };
        }
        throw new Error("child provider failed after dispatch");
      },
    };
    const agent = defineDistributedTestAgent(
      {
        name: "causal-failure-agent",
        model: "mock",
        turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
        augments: [
          {
            name: "detached-child",
            scheduleAfterTurn: async (result, context) => {
              if (result.turnId === "turn-1") {
                void context.inject({ ...trigger("child"), turnId: "turn-child" });
              }
            },
          },
        ],
      },
      model,
      adapter(owner),
    );
    await agent.start();

    const result = await agent.inject(trigger(), { executionContext });
    expect(result).toMatchObject({ success: false, outcomeUnknown: true });
    expect(calls).toBe(2);
    expect(agent.health().scheduler.quarantinedThreads).toBe(1);
    await agent.stop();
  });

  test("quarantines and releases the local lane when authority is lost to non-cooperative work", async () => {
    const base = coordinator("instance-a", 100);
    const standby = coordinator("instance-b", 100);
    await standby.register();
    const never = new Promise<never>(() => {});
    const wrapped = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "heartbeat") return () => never;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DistributedTurnCoordinator;
    const model: ModelClient = {
      maxContextTokens: 10_000,
      countTokens: () => 0,
      complete: async () => never,
    };
    const agent = defineDistributedTestAgent(
      {
        name: "hung-agent",
        model: "mock",
        augments: [],
        turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
      },
      model,
      adapter(wrapped, { leaseMs: 100, heartbeatMs: 20, graceMs: 10 }),
    );
    await agent.start();
    const result = await agent.inject(trigger(), { executionContext });

    expect(result).toMatchObject({ success: false, outcomeUnknown: true });
    expect(agent.health().scheduler).toMatchObject({
      activeTurns: 0,
      queuedTurns: 0,
      quarantinedThreads: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 110));
    const request = createCanonicalDistributedTurnRequest({
      trigger: trigger(),
      threadId: "thread-1",
      source,
      executionContext,
    });
    const observer = coordinator("instance-c", 100);
    expect(await observer.register()).toEqual({ status: "registered" });
    expect(await observer.status(request)).toEqual({ status: "quarantined" });
    await agent.stop();
  });

  test("detaches a non-cooperative causal child after distributed authority loss", async () => {
    const base = coordinator("instance-a", 100);
    const never = new Promise<never>(() => {});
    const childStarted = deferred();
    const wrapped = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "heartbeat") return () => never;
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DistributedTurnCoordinator;
    let calls = 0;
    const model: ModelClient = {
      maxContextTokens: 10_000,
      countTokens: () => 0,
      complete: async () => {
        calls++;
        if (calls === 1) {
          return {
            content: "parent-done",
            inputTokens: 1,
            outputTokens: 1,
            finishReason: "end_turn",
          };
        }
        childStarted.resolve();
        return never;
      },
    };
    const agent = defineDistributedTestAgent(
      {
        name: "hung-causal-agent",
        model: "mock",
        turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
        augments: [
          {
            name: "hung-child",
            scheduleAfterTurn: async (result, context) => {
              if (result.turnId === "turn-1") {
                void context.inject({ ...trigger("child"), turnId: "hung-child-turn" });
              }
            },
          },
        ],
      },
      model,
      adapter(wrapped, { leaseMs: 100, heartbeatMs: 20, graceMs: 10 }),
    );
    await agent.start();
    const running = agent.inject(trigger(), { executionContext });
    await childStarted.promise;

    expect(await running).toMatchObject({ success: false, outcomeUnknown: true });
    expect(agent.health().scheduler).toMatchObject({
      activeTurns: 0,
      queuedTurns: 0,
      quarantinedThreads: 1,
    });
    await agent.stop();
  });

  test("rejects legacy history persistence before distributed execution", async () => {
    const owner = coordinator("instance-a");
    const model = createMockModel({ response: "must-not-run" });
    let kernel: TransportKernel | undefined;
    const config: AgentConfig = {
      name: "history-boundary-agent",
      model: "mock",
      turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
      augments: [
        {
          name: "capture-transport",
          transport: {
            identify: () => null,
            register: async (registered) => {
              kernel = registered;
            },
          },
        },
      ],
    };
    const agent = defineDistributedTestAgent(config, model, adapter(owner));
    await agent.start();
    let persistenceCalls = 0;
    const persistence = {
      load: async () => {
        persistenceCalls++;
        return null;
      },
      assertAccess: async () => {
        persistenceCalls++;
      },
      commit: async () => {
        persistenceCalls++;
      },
    };

    await expect(
      kernel!.handleInbound(trigger(), { historyPersistence: persistence }),
    ).rejects.toThrow("rejects legacy unfenced thread history persistence");
    expect(persistenceCalls).toBe(0);
    expect(model.calls).toHaveLength(0);
    await agent.stop();
  });

  test("bounds shutdown and revokes authority for a non-cooperative active turn", async () => {
    const owner = coordinator("instance-a", 1_000);
    const started = deferred();
    const never = new Promise<never>(() => {});
    const model: ModelClient = {
      maxContextTokens: 10_000,
      countTokens: () => 0,
      complete: async () => {
        started.resolve();
        return never;
      },
    };
    const config: AgentConfig = {
      name: "bounded-drain-agent",
      model: "mock",
      augments: [],
      turnScheduling: { maxConcurrent: 2, maxQueued: 10, maxQueuedPerThread: 10 },
    };
    const agent = defineDistributedTestAgent(config, model, adapter(owner, { graceMs: 0 }));
    await agent.start();
    const running = agent.inject(trigger(), { executionContext });
    await started.promise;

    const stopped = await Promise.race([
      agent.stop().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    expect(stopped).toBe(true);
    expect(await running).toMatchObject({ success: false, outcomeUnknown: true });
    expect(agent.health().scheduler).toMatchObject({ state: "stopped", activeTurns: 0 });
  });
});
