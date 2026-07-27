import { afterEach, describe, expect, test } from "bun:test";
import { defineAgent } from "../../src/agent";
import { createExternalAuthAssertion } from "../../src/auth/external-auth";
import {
  createDistributedRootTurnRuntime,
  createInMemoryDistributedTurnCoordinator,
  resetInMemoryDistributedCoordination,
} from "../../src/coordination";
import {
  attachDistributedRuntimeForTest,
  type DistributedAgentRuntimeTestAdapter,
} from "../../src/coordination/testing-agent-runtime";
import { defineRoute } from "../../src/helpers";
import { distributedWebRoutePolicyId, webTransport } from "../../src/transports/web-transport";
import type {
  AgentConfig,
  AssembledPrompt,
  Augment,
  ModelClient,
  ModelResponse,
} from "../../src/types";
import { createMockModel } from "../fixtures/mock-model";

const BEARER = "distributed-web-test-bearer";
const SECURITY_NAMESPACE = "distributed-web-test";
const source = { id: "transport:web", maxConcurrent: 2, maxQueued: 8 } as const;
const resultPolicy = { maxReplayBytes: 65_536 } as const;
const turnStatePolicy = {
  history: { maxSnapshotBytes: 65_536, maxMessages: 100, maxThreads: 100 },
  maxCostMarkersPerTurn: 32,
  outbox: { maxIntentsPerTurn: 32, maxIntentBytes: 65_536, maxPendingIntents: 100 },
} as const;
const webCapacityClasses = [
  { id: "public", maxRetainedRequests: 15, maxRetainedRequestsPerPartition: 10 },
  { id: "agent", maxRetainedRequests: 9, maxRetainedRequestsPerPartition: 9 },
  { id: "creator", maxRetainedRequests: 6, maxRetainedRequestsPerPartition: 6 },
] as const;

const agents: Array<ReturnType<typeof defineAgent>> = [];

afterEach(async () => {
  for (const agent of agents.splice(0).reverse()) await agent.stop();
  resetInMemoryDistributedCoordination();
});

function coordinator(
  instanceId: string,
  anonymousLimit = 10,
  extraRateLimits: readonly { id: string; max: number; maxEvents: number; windowMs: number }[] = [],
  failClosed?: () => boolean,
  maxRateLimitEvents = 100,
) {
  return createInMemoryDistributedTurnCoordinator(
    {
      namespace: "distributed-web-admission",
      instanceId,
      buildFingerprint: "c".repeat(64),
      maxConcurrent: 2,
      maxQueued: 8,
      maxQueuedPerThread: 4,
      leaseMs: 5_000,
      sources: [source],
      retention: {
        terminalRequestRetentionMs: 60_000,
        maxTerminalRequests: 100,
        eventRetentionMs: 60_000,
        maxEvents: 100,
      },
      result: resultPolicy,
      turnState: turnStatePolicy,
      admission: {
        maxRateLimitEvents,
        capacityClasses: webCapacityClasses,
        rateLimits: [
          { id: "web.peer.v1", max: anonymousLimit, maxEvents: 20, windowMs: 60_000 },
          {
            id: "web.anonymous-global.v1",
            max: anonymousLimit,
            maxEvents: 20,
            windowMs: 60_000,
          },
          {
            id: "web.anonymous-network.v1",
            max: anonymousLimit,
            maxEvents: 20,
            windowMs: 60_000,
          },
          ...extraRateLimits,
        ],
      },
      compatibility: {
        protocolVersion: 6,
        protocolFingerprint: "a".repeat(64),
        configurationFingerprint: "b".repeat(64),
      },
    },
    { failClosed },
  );
}

function adapter(
  owner: ReturnType<typeof createInMemoryDistributedTurnCoordinator>,
): DistributedAgentRuntimeTestAdapter {
  return {
    coordinator: owner,
    result: resultPolicy,
    turnState: turnStatePolicy,
    runtime: createDistributedRootTurnRuntime({
      coordinator: owner,
      leaseDurationMs: 5_000,
      heartbeatIntervalMs: 1_000,
      claimPollMs: 10,
      maxWaitMs: 5_000,
    }),
    drainTimeoutMs: 100,
  };
}

async function replica(options: {
  instanceId: string;
  model: ModelClient;
  port: number;
  anonymousLimit?: number;
  peerLimit?: number;
  allowAnonymous?: boolean;
  extraAugments?: readonly Augment[];
  extraRateLimits?: readonly { id: string; max: number; maxEvents: number; windowMs: number }[];
  failClosed?: () => boolean;
  maxRateLimitEvents?: number;
  externalAuth?: Parameters<typeof webTransport>[0]["externalAuth"];
  adminRoute?: boolean;
  idempotencyDbPath?: string | null;
}) {
  const owner = coordinator(
    options.instanceId,
    options.peerLimit ?? options.anonymousLimit,
    options.extraRateLimits,
    options.failClosed,
    options.maxRateLimitEvents,
  );
  const transport = webTransport({
    port: options.port,
    auth: { type: "bearer", token: BEARER },
    securityNamespace: SECURITY_NAMESPACE,
    concurrency: source.maxConcurrent,
    maxQueueDepth: source.maxQueued,
    adminRoute: options.adminRoute ?? false,
    allowAnonymous: options.allowAnonymous ?? false,
    ...(options.allowAnonymous || options.peerLimit !== undefined
      ? {
          rateLimitPerPeer: {
            maxPerMinute: options.peerLimit ?? options.anonymousLimit ?? 10,
            ...(options.allowAnonymous
              ? {
                  anonymousNetwork: {
                    mode: "shared-store" as const,
                    globalMaxPerMinute: options.anonymousLimit ?? 10,
                  },
                }
              : {}),
          },
        }
      : {}),
    idempotency: {
      dbPath: options.idempotencyDbPath ?? null,
      maxRecords: 30,
      maxRecordsPerPartition: 10,
      maxPublicRecords: 15,
      maxAgentRecords: 9,
      maxCreatorRecords: 6,
    },
    ...(options.externalAuth ? { externalAuth: options.externalAuth } : {}),
  });
  const config: AgentConfig = {
    name: SECURITY_NAMESPACE,
    model: "test",
    augments: [...(options.extraAugments ?? []), transport],
  };
  attachDistributedRuntimeForTest(config, adapter(owner));
  const agent = defineAgent(config, options.model);
  agents.push(agent);
  await agent.start();
  return { agent, owner };
}

function runRequest(
  port: number,
  options: {
    key: string;
    text?: string;
    threadId?: string;
    anonymousSession?: string;
    anonymous?: boolean;
    signal?: AbortSignal;
  },
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/agent/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": options.key,
      ...(options.anonymous ? {} : { authorization: `Bearer ${BEARER}` }),
      ...(options.anonymousSession
        ? { "x-auggy-anonymous-session": options.anonymousSession }
        : {}),
    },
    body: JSON.stringify({
      threadId: options.threadId ?? "distributed-web-thread",
      messages: [{ role: "user", content: options.text ?? "hello" }],
    }),
    signal: options.signal,
  });
}

function barrierModel(): {
  model: ModelClient;
  calls: AssembledPrompt[];
  started: Promise<void>;
  release(): void;
} {
  const calls: AssembledPrompt[] = [];
  let started!: () => void;
  let release!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    calls,
    started: startedPromise,
    release,
    model: {
      maxContextTokens: 100_000,
      countTokens: (text) => Math.ceil(text.length / 4),
      async complete(prompt): Promise<ModelResponse> {
        calls.push(prompt);
        started();
        await released;
        return {
          content: "one distributed execution",
          inputTokens: 1,
          outputTokens: 1,
          finishReason: "end_turn",
        };
      },
    },
  };
}

describe("distributed web admission", () => {
  test("joins and replays one keyed execution across independent replica ledgers", async () => {
    const barrier = barrierModel();
    await replica({ instanceId: "replica-a", model: barrier.model, port: 19580 });
    await replica({ instanceId: "replica-b", model: barrier.model, port: 19581 });

    const first = runRequest(19580, { key: "shared-key" });
    await barrier.started;
    const duplicate = runRequest(19581, { key: "shared-key" });
    barrier.release();
    const [firstResponse, duplicateResponse] = await Promise.all([first, duplicate]);
    const [firstBody, duplicateBody] = await Promise.all([
      firstResponse.text(),
      duplicateResponse.text(),
    ]);
    expect(firstResponse.status).toBe(200);
    expect(duplicateResponse.status).toBe(200);
    expect(firstBody).toContain("one distributed execution");
    expect(duplicateBody).toContain("one distributed execution");
    expect(firstBody.match(/"runId":"([^"]+)/)?.[1]).toBe(
      duplicateBody.match(/"runId":"([^"]+)/)?.[1],
    );
    expect(barrier.calls).toHaveLength(1);

    const changed = await runRequest(19581, { key: "shared-key", text: "changed" });
    expect(await changed.text()).toContain("retry identity conflicts");
    expect(barrier.calls).toHaveLength(1);
  });

  test("keeps a keyed execution durable after its leader SSE client disconnects", async () => {
    const barrier = barrierModel();
    await replica({ instanceId: "disconnect-a", model: barrier.model, port: 19589 });
    await replica({ instanceId: "disconnect-b", model: barrier.model, port: 19590 });

    const leader = await runRequest(19589, { key: "disconnect-key" });
    await barrier.started;
    await leader.body?.cancel("test client disconnected");

    const follower = runRequest(19590, { key: "disconnect-key" });
    barrier.release();
    const replay = await follower;
    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain("one distributed execution");
    expect(barrier.calls).toHaveLength(1);
  });

  test("reserves anonymous fleet quota once and lets an exact duplicate replay", async () => {
    const model = createMockModel({ response: "anonymous distributed result" });
    await replica({
      instanceId: "anonymous-a",
      model,
      port: 19582,
      anonymousLimit: 1,
      allowAnonymous: true,
    });
    await replica({
      instanceId: "anonymous-b",
      model,
      port: 19583,
      anonymousLimit: 1,
      allowAnonymous: true,
    });

    const bootstrap = await runRequest(19582, { key: "anonymous-one", anonymous: true });
    expect(bootstrap.status).toBe(428);
    const anonymousSession = bootstrap.headers.get("x-auggy-anonymous-session");
    expect(anonymousSession).toBeTruthy();

    const first = await runRequest(19582, {
      key: "anonymous-one",
      anonymous: true,
      anonymousSession: anonymousSession!,
    });
    expect(await first.text()).toContain("anonymous distributed result");
    const duplicate = await runRequest(19583, {
      key: "anonymous-one",
      anonymous: true,
      anonymousSession: anonymousSession!,
    });
    expect(await duplicate.text()).toContain("anonymous distributed result");

    const overLimit = await runRequest(19583, {
      key: "anonymous-two",
      anonymous: true,
      anonymousSession: anonymousSession!,
    });
    expect(await overLimit.text()).toContain("Rate limit exceeded");
    expect(model.calls).toHaveLength(1);
  });

  test("enforces one augment-route quota across independently routed replicas", async () => {
    let handlerCalls = 0;
    const route: Augment = {
      name: "distributed-limited-route",
      httpRoutes: [
        defineRoute.get("/limited", {
          auth: "none",
          rateLimit: { maxPerMinute: 1 },
          handler: () => {
            handlerCalls++;
            return new Response("ok");
          },
        }),
      ],
    };
    const routePolicy = {
      id: distributedWebRoutePolicyId("GET", "/limited"),
      max: 1,
      maxEvents: 10,
      windowMs: 60_000,
    };
    const model = createMockModel();
    let databaseUnavailable = false;
    await replica({
      instanceId: "route-a",
      model,
      port: 19584,
      extraAugments: [route],
      extraRateLimits: [routePolicy],
      failClosed: () => databaseUnavailable,
    });
    await replica({
      instanceId: "route-b",
      model,
      port: 19585,
      extraAugments: [route],
      extraRateLimits: [routePolicy],
    });

    expect((await fetch("http://127.0.0.1:19584/limited")).status).toBe(200);
    const rejected = await fetch("http://127.0.0.1:19585/limited");
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(handlerCalls).toBe(1);

    databaseUnavailable = true;
    const unavailable = await fetch("http://127.0.0.1:19584/limited");
    expect(unavailable.status).toBe(503);
    expect(handlerCalls).toBe(1);
    databaseUnavailable = false;
  });

  test("enforces a recognized peer quota across arbitrarily routed turns", async () => {
    const model = createMockModel({ response: "peer-limited result" });
    await replica({ instanceId: "peer-a", model, port: 19587, peerLimit: 1 });
    await replica({ instanceId: "peer-b", model, port: 19588, peerLimit: 1 });

    const first = await runRequest(19587, { key: "peer-one" });
    expect(await first.text()).toContain("peer-limited result");
    const rejected = await runRequest(19588, { key: "peer-two" });
    expect(await rejected.text()).toContain("Rate limit exceeded");
    expect(model.calls).toHaveLength(1);
  });

  test("fails startup when a distributed route policy is missing", async () => {
    const route: Augment = {
      name: "distributed-missing-policy",
      httpRoutes: [
        defineRoute.get("/missing-policy", {
          auth: "none",
          rateLimit: { maxPerMinute: 1 },
          handler: () => new Response("must not listen"),
        }),
      ],
    };
    await expect(
      replica({
        instanceId: "missing-policy",
        model: createMockModel(),
        port: 19586,
        extraAugments: [route],
      }),
    ).rejects.toThrow("distributed coordinator policy does not satisfy web admission requirements");
  });

  test("fails startup when rate evidence cannot hold one complete anonymous admission", async () => {
    await expect(
      replica({
        instanceId: "insufficient-rate-evidence",
        model: createMockModel(),
        port: 19591,
        allowAnonymous: true,
        anonymousLimit: 10,
        maxRateLimitEvents: 2,
      }),
    ).rejects.toThrow(/admission|rate/i);
  });

  test("does not consume an unsupported unkeyed external-auth assertion", async () => {
    let consumeCalls = 0;
    const model = createMockModel();
    await replica({
      instanceId: "external-auth-deferred",
      model,
      port: 19592,
      externalAuth: {
        secret: "distributed-external-auth-secret",
        audience: SECURITY_NAMESPACE,
        replayProtection: {
          enabled: true,
          store: {
            consume() {
              consumeCalls++;
              return true;
            },
          },
        },
      },
    });
    const assertion = createExternalAuthAssertion({
      secret: "distributed-external-auth-secret",
      audience: SECURITY_NAMESPACE,
      provider: "test",
      subject: "external-user",
      ttlSeconds: 60,
      jti: "distributed-unkeyed-jti",
    });
    const response = await fetch("http://127.0.0.1:19592/agent/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-auggy-auth-assertion": assertion,
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "unsupported for now" }] }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "external_auth_distributed_unavailable" });
    expect(consumeCalls).toBe(0);
    expect(model.calls).toHaveLength(0);
  });

  test("fails startup instead of serving replica-local console state", async () => {
    await expect(
      replica({
        instanceId: "local-console-rejected",
        model: createMockModel(),
        port: 19593,
        adminRoute: true,
      }),
    ).rejects.toThrow(/adminRoute: false.*shared fenced authority/);
  });

  test("fails startup instead of accepting a replica-local idempotency ledger", async () => {
    await expect(
      replica({
        instanceId: "local-ledger-rejected",
        model: createMockModel(),
        port: 19594,
        idempotencyDbPath: ":memory:",
      }),
    ).rejects.toThrow(/idempotency\.dbPath: null.*only execution authority/);
  });
});
