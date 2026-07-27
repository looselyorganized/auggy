import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { defineAgent } from "../../src/agent";
import { createExternalAuthAssertion } from "../../src/auth/external-auth";
import {
  createDistributedRootTurnRuntime,
  createInMemoryDistributedTurnCoordinator,
  PostgresVisitorIdentityAuthority,
  resetInMemoryDistributedCoordination,
} from "../../src/coordination";
import type { VisitorIdentityAuthority } from "../../src/coordination/visitor-identity-authority";
import {
  attachDistributedRuntimeForTest,
  type DistributedAgentRuntimeTestAdapter,
} from "../../src/coordination/testing-agent-runtime";
import { defineRoute } from "../../src/helpers";
import { distributedWebRoutePolicyId, webTransport } from "../../src/transports/web-transport";
import { createVisitorToken, deriveSigningKey } from "../../src/transports/visitor-token";
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
const postgresUrl = process.env.AUGGY_TEST_POSTGRES_URL;
const postgresTest = postgresUrl ? test : test.skip;
const postgresNamespaces = new Set<string>();

afterEach(async () => {
  for (const agent of agents.splice(0).reverse()) await agent.stop();
  resetInMemoryDistributedCoordination();
  if (!postgresUrl || postgresNamespaces.size === 0) return;
  const sql = new SQL(postgresUrl);
  try {
    for (const namespace of postgresNamespaces) {
      await sql.unsafe(
        "DELETE FROM public.auggy_coordination_external_assertions WHERE namespace = $1",
        [namespace],
      );
      await sql.unsafe(
        "DELETE FROM public.auggy_coordination_visitor_requests WHERE namespace = $1",
        [namespace],
      );
      await sql.unsafe("DELETE FROM public.auggy_coordination_visitors WHERE namespace = $1", [
        namespace,
      ]);
      await sql.unsafe(
        "DELETE FROM public.auggy_coordination_visitor_authorities WHERE namespace = $1",
        [namespace],
      );
    }
  } finally {
    postgresNamespaces.clear();
    await sql.close();
  }
});

function coordinator(
  instanceId: string,
  anonymousLimit = 10,
  extraRateLimits: readonly { id: string; max: number; maxEvents: number; windowMs: number }[] = [],
  failClosed?: () => boolean,
  maxRateLimitEvents = 100,
  namespace = "distributed-web-admission",
) {
  return createInMemoryDistributedTurnCoordinator(
    {
      namespace,
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
  visitorIdentityAuthority?: VisitorIdentityAuthority,
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
    ...(visitorIdentityAuthority ? { visitorIdentityAuthority } : {}),
    drainTimeoutMs: 100,
  };
}

function identityAuthority(
  overrides: Partial<VisitorIdentityAuthority> = {},
): VisitorIdentityAuthority {
  return {
    register: async () => ({ status: "registered" }),
    issueVerificationRequest: async () => ({ status: "unavailable" }),
    verify: async () => ({ status: "unavailable" }),
    resolveVisitor: async () => ({ status: "unavailable" }),
    canPromote: async () => ({ status: "unavailable" }),
    revokeByEmail: async () => ({ status: "unavailable" }),
    claimExternalAssertion: async () => ({ status: "unavailable" }),
    close: async () => {},
    ...overrides,
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
  coordinationNamespace?: string;
  externalAuth?: Parameters<typeof webTransport>[0]["externalAuth"];
  visitorTokens?: Parameters<typeof webTransport>[0]["visitorTokens"];
  visitorIdentityAuthority?: VisitorIdentityAuthority;
  adminRoute?: boolean;
  idempotencyDbPath?: string | null;
}) {
  const owner = coordinator(
    options.instanceId,
    options.peerLimit ?? options.anonymousLimit,
    options.extraRateLimits,
    options.failClosed,
    options.maxRateLimitEvents,
    options.coordinationNamespace,
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
    ...(options.visitorTokens ? { visitorTokens: options.visitorTokens } : {}),
  });
  const config: AgentConfig = {
    name: SECURITY_NAMESPACE,
    model: "test",
    augments: [...(options.extraAugments ?? []), transport],
  };
  attachDistributedRuntimeForTest(config, adapter(owner, options.visitorIdentityAuthority));
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

  test("rechecks shared visitor revocation immediately before model dispatch", async () => {
    const signingKey = "distributed-final-visitor-check";
    const key = await deriveSigningKey(signingKey);
    const issued = await createVisitorToken(
      key,
      SECURITY_NAMESPACE,
      3_600,
      "vis_final_check",
      undefined,
      undefined,
      undefined,
      1,
    );
    let resolveCalls = 0;
    const authority = identityAuthority({
      resolveVisitor: async () => {
        resolveCalls += 1;
        return resolveCalls <= 2
          ? {
              status: "active",
              visitorId: "vis_final_check",
              identityVersion: 1,
              email: "final-check@example.test",
              verifiedAt: Date.now(),
              reverifyDueAt: Date.now() + 86_400_000,
            }
          : { status: "revoked" };
      },
    });
    const model = createMockModel();
    const { owner } = await replica({
      instanceId: "visitor-final-check",
      model,
      port: 19600,
      allowAnonymous: true,
      anonymousLimit: 10,
      visitorTokens: {
        enabled: true,
        signingKey,
        agentBinding: SECURITY_NAMESPACE,
      },
      visitorIdentityAuthority: authority,
    });
    let historyLoads = 0;
    const loadHistory = owner.loadHistory.bind(owner);
    owner.loadHistory = (...args) => {
      historyLoads += 1;
      return loadHistory(...args);
    };

    const response = await fetch("http://127.0.0.1:19600/agent/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "visitor-final-check-key",
        "x-visitor-token": issued.token,
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "must not execute" }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("VISITOR_AUTHORIZATION_REVOKED");
    expect(resolveCalls).toBe(3);
    expect(historyLoads).toBe(0);
    expect(model.calls).toHaveLength(0);
  });

  test("normalizes rejected distributed identity authority calls without leaking errors", async () => {
    const signingKey = "distributed-rejected-visitor-authority";
    const key = await deriveSigningKey(signingKey);
    const issued = await createVisitorToken(
      key,
      SECURITY_NAMESPACE,
      3_600,
      "vis_rejected_authority",
      undefined,
      undefined,
      undefined,
      1,
    );
    const sentinel = "SENTINEL_DISTRIBUTED_IDENTITY_DATABASE_SECRET";
    const model = createMockModel();
    await replica({
      instanceId: "visitor-rejected-authority",
      model,
      port: 19601,
      allowAnonymous: true,
      anonymousLimit: 10,
      visitorTokens: {
        enabled: true,
        signingKey,
        agentBinding: SECURITY_NAMESPACE,
      },
      visitorIdentityAuthority: identityAuthority({
        resolveVisitor: async () => {
          throw new Error(sentinel);
        },
      }),
    });

    const response = await fetch("http://127.0.0.1:19601/agent/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "visitor-rejected-authority-key",
        "x-visitor-token": issued.token,
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "must not execute" }] }),
    });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toBe('{"error":"identity_authority_unavailable"}');
    expect(body).not.toContain(sentinel);
    expect(model.calls).toHaveLength(0);
  });

  postgresTest("shares exact external assertion replay authority across two replicas", async () => {
    const namespace = `distributed-web-identity-${crypto.randomUUID()}`;
    postgresNamespaces.add(namespace);
    const authorityOptions = {
      url: postgresUrl!,
      namespace,
      audience: SECURITY_NAMESPACE,
      policy: {
        maxVerificationRequests: 20,
        maxVisitors: 20,
        maxExternalAssertions: 20,
        verificationTokenTtlMs: 900_000,
        verificationRequestRetentionMs: 60_000,
        reverifyAfterMs: 86_400_000,
        maxExternalAssertionTtlMs: 300_000,
        rateLimit: { perHour: 10, perDay: 10, minIntervalMs: 0 },
      },
    } as const;
    const firstAuthority = new PostgresVisitorIdentityAuthority(authorityOptions);
    const secondAuthority = new PostgresVisitorIdentityAuthority(authorityOptions);
    await firstAuthority.migrate();
    expect(await firstAuthority.register()).toEqual({ status: "registered" });
    expect(await secondAuthority.register()).toEqual({ status: "registered" });

    let localReplayCalls = 0;
    const externalAuth = {
      secret: "distributed-external-auth-shared-secret",
      audience: SECURITY_NAMESPACE,
      replayProtection: {
        enabled: true as const,
        store: {
          consume() {
            localReplayCalls += 1;
            return true;
          },
        },
      },
    };
    const model = createMockModel();
    await replica({
      instanceId: "external-auth-shared-a",
      model,
      port: 19595,
      coordinationNamespace: namespace,
      externalAuth,
      visitorIdentityAuthority: firstAuthority,
    });
    await replica({
      instanceId: "external-auth-shared-b",
      model,
      port: 19596,
      coordinationNamespace: namespace,
      externalAuth,
      visitorIdentityAuthority: secondAuthority,
    });

    const assertion = createExternalAuthAssertion({
      secret: externalAuth.secret,
      audience: SECURITY_NAMESPACE,
      provider: "test",
      subject: "external-user",
      ttlSeconds: 60,
      jti: `shared-jti-${crypto.randomUUID()}`,
    });
    const send = (port: number, key: string, content: string) =>
      fetch(`http://127.0.0.1:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
          "x-auggy-auth-assertion": assertion,
        },
        body: JSON.stringify({
          threadId: "distributed-external-thread",
          messages: [{ role: "user", content }],
        }),
      });

    const key = `shared-key-${crypto.randomUUID()}`;
    const [first, second] = await Promise.all([
      send(19595, key, "same request"),
      send(19596, key, "same request"),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    await Promise.all([first.text(), second.text()]);
    expect(model.calls).toHaveLength(1);

    const changedKey = await send(19596, `changed-key-${crypto.randomUUID()}`, "same request");
    expect(changedKey.status).toBe(401);
    expect(await changedKey.json()).toEqual({ error: "unauthorized" });

    const changed = await send(19596, `changed-key-${crypto.randomUUID()}`, "changed request");
    expect(changed.status).toBe(401);
    expect(await changed.json()).toEqual({ error: "unauthorized" });
    expect(model.calls).toHaveLength(1);
    expect(localReplayCalls).toBe(0);
  });

  postgresTest("shares visitor identity and revocation authority across replicas", async () => {
    const namespace = `distributed-web-visitor-${crypto.randomUUID()}`;
    postgresNamespaces.add(namespace);
    const authorityOptions = {
      url: postgresUrl!,
      namespace,
      audience: SECURITY_NAMESPACE,
      policy: {
        maxVerificationRequests: 20,
        maxVisitors: 20,
        maxExternalAssertions: 20,
        verificationTokenTtlMs: 900_000,
        verificationRequestRetentionMs: 60_000,
        reverifyAfterMs: 86_400_000,
        maxExternalAssertionTtlMs: 300_000,
        rateLimit: { perHour: 10, perDay: 10, minIntervalMs: 0 },
      },
    } as const;
    const firstAuthority = new PostgresVisitorIdentityAuthority(authorityOptions);
    const secondAuthority = new PostgresVisitorIdentityAuthority(authorityOptions);
    await firstAuthority.migrate();
    await firstAuthority.register();
    await secondAuthority.register();

    const rawVerificationToken = crypto.randomUUID();
    const requestId = `visitor-request-${crypto.randomUUID()}`;
    expect(
      await firstAuthority.issueVerificationRequest({
        requestId,
        bindingHash: new Bun.CryptoHasher("sha256").update(requestId).digest("hex"),
        token: rawVerificationToken,
        email: "shared-visitor@example.test",
        peerId: "anon_session_22222222-2222-4222-8222-222222222222",
        threadId: "shared-visitor-thread",
      }),
    ).toMatchObject({ status: "issued" });
    const verified = await firstAuthority.verify({ token: rawVerificationToken });
    if (verified.status !== "verified") throw new Error("shared visitor verification failed");

    const signingKey = "distributed-shared-visitor-signing-key";
    const cryptoKey = await deriveSigningKey(signingKey);
    const issued = await createVisitorToken(
      cryptoKey,
      SECURITY_NAMESPACE,
      3_600,
      verified.visitorId,
      verified.priorPeerId,
      undefined,
      verified.priorThreadId,
      verified.identityVersion,
      verified.authoritativeNow,
    );
    const legacy = await createVisitorToken(
      cryptoKey,
      SECURITY_NAMESPACE,
      3_600,
      verified.visitorId,
    );
    let handlerCalls = 0;
    const route: Augment = {
      name: "distributed-visitor-route",
      httpRoutes: [
        defineRoute.get("/shared-visitor", {
          auth: "visitor.required",
          handler: (context) => {
            handlerCalls += 1;
            return Response.json({
              state: context.auth.mode === "visitor" ? context.auth.state : "wrong-mode",
              visitorId:
                context.auth.mode === "visitor" && context.auth.state === "recognized"
                  ? context.auth.visitorId
                  : null,
            });
          },
        }),
      ],
    };
    const visitorTokens = {
      enabled: true,
      signingKey,
      agentBinding: SECURITY_NAMESPACE,
    } as const;
    await replica({
      instanceId: "visitor-shared-a",
      model: createMockModel(),
      port: 19597,
      coordinationNamespace: namespace,
      extraAugments: [route],
      visitorTokens,
      visitorIdentityAuthority: firstAuthority,
    });
    await replica({
      instanceId: "visitor-shared-b",
      model: createMockModel(),
      port: 19598,
      coordinationNamespace: namespace,
      extraAugments: [route],
      visitorTokens,
      visitorIdentityAuthority: secondAuthority,
    });

    const recognized = await fetch("http://127.0.0.1:19598/shared-visitor", {
      headers: { "x-visitor-token": issued.token },
    });
    expect(recognized.status).toBe(200);
    expect(await recognized.json()).toEqual({
      state: "recognized",
      visitorId: verified.visitorId,
    });

    const legacyResponse = await fetch("http://127.0.0.1:19597/shared-visitor", {
      headers: { "x-visitor-token": legacy.token },
    });
    expect(legacyResponse.status).toBe(503);
    expect(await legacyResponse.json()).toEqual({ error: "identity_authority_unavailable" });

    const sql = new SQL(postgresUrl!);
    try {
      await sql.unsafe(
        "UPDATE public.auggy_coordination_visitors SET verified_at = clock_timestamp() - INTERVAL '2 seconds', reverify_due_at = clock_timestamp() - INTERVAL '1 second' WHERE namespace = $1 AND audience = $2 AND visitor_id = $3",
        [namespace, SECURITY_NAMESPACE, verified.visitorId],
      );
    } finally {
      await sql.close();
    }
    const reverifyExpired = await fetch("http://127.0.0.1:19598/shared-visitor", {
      headers: { "x-visitor-token": issued.token },
    });
    expect(reverifyExpired.status).toBe(401);

    expect(
      await firstAuthority.revokeByEmail("shared-visitor@example.test", "operator-revoked"),
    ).toMatchObject({ status: "revoked", visitorId: verified.visitorId });
    const revoked = await fetch("http://127.0.0.1:19598/shared-visitor", {
      headers: { "x-visitor-token": issued.token },
    });
    expect(revoked.status).toBe(401);
    expect(handlerCalls).toBe(1);
  });

  postgresTest("promotes only PostgreSQL-proven anonymous history before execution", async () => {
    const namespace = `distributed-web-promotion-${crypto.randomUUID()}`;
    postgresNamespaces.add(namespace);
    const authority = new PostgresVisitorIdentityAuthority({
      url: postgresUrl!,
      namespace,
      audience: SECURITY_NAMESPACE,
      policy: {
        maxVerificationRequests: 20,
        maxVisitors: 20,
        maxExternalAssertions: 20,
        verificationTokenTtlMs: 900_000,
        verificationRequestRetentionMs: 60_000,
        reverifyAfterMs: 86_400_000,
        maxExternalAssertionTtlMs: 300_000,
        rateLimit: { perHour: 10, perDay: 10, minIntervalMs: 0 },
      },
    });
    await authority.migrate();
    await authority.register();
    const signingKey = "distributed-promotion-signing-key";
    const model = createMockModel({ response: "promotion result" });
    await replica({
      instanceId: "visitor-promotion",
      model,
      port: 19599,
      coordinationNamespace: namespace,
      allowAnonymous: true,
      anonymousLimit: 10,
      visitorTokens: {
        enabled: true,
        signingKey,
        agentBinding: SECURITY_NAMESPACE,
      },
      visitorIdentityAuthority: authority,
    });

    const bootstrap = await runRequest(19599, {
      key: `promotion-bootstrap-${crypto.randomUUID()}`,
      threadId: "visitor-promotion-thread",
      anonymous: true,
    });
    expect(bootstrap.status).toBe(428);
    const anonymousSession = bootstrap.headers.get("x-auggy-anonymous-session");
    expect(anonymousSession).toBeTruthy();
    await bootstrap.text();

    const anonymous = await runRequest(19599, {
      key: `promotion-anonymous-${crypto.randomUUID()}`,
      text: "anonymous history sentinel",
      threadId: "visitor-promotion-thread",
      anonymous: true,
      anonymousSession: anonymousSession ?? undefined,
    });
    const anonymousBody = await anonymous.text();
    expect(anonymous.status).toBe(200);
    const canonicalThread = anonymousBody.match(/"threadId":"([^"]+)"/)?.[1];
    expect(canonicalThread).toMatch(/^web_thread_/);

    const [encodedSession] = (anonymousSession ?? "").split(".");
    const sessionPayload = JSON.parse(
      Buffer.from(encodedSession!, "base64url").toString("utf8"),
    ) as { peerId: string; threadScopeId: string };
    const rawVerificationToken = crypto.randomUUID();
    const requestId = `promotion-request-${crypto.randomUUID()}`;
    expect(
      await authority.issueVerificationRequest({
        requestId,
        bindingHash: new Bun.CryptoHasher("sha256").update(requestId).digest("hex"),
        token: rawVerificationToken,
        email: "promotion@example.test",
        peerId: sessionPayload.peerId,
        threadId: canonicalThread!,
      }),
    ).toMatchObject({ status: "issued" });
    const verified = await authority.verify({ token: rawVerificationToken });
    if (verified.status !== "verified") throw new Error("promotion verification failed");
    const tokenKey = await deriveSigningKey(signingKey);
    const visitor = await createVisitorToken(
      tokenKey,
      SECURITY_NAMESPACE,
      3_600,
      verified.visitorId,
      verified.priorPeerId,
      sessionPayload.threadScopeId,
      verified.priorThreadId,
      verified.identityVersion,
      verified.authoritativeNow,
    );

    const promoted = await fetch("http://127.0.0.1:19599/agent/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `promotion-recognized-${crypto.randomUUID()}`,
        "x-auggy-anonymous-session": anonymousSession!,
        "x-visitor-token": visitor.token,
      },
      body: JSON.stringify({
        threadId: canonicalThread,
        messages: [{ role: "user", content: "recognized continuation" }],
      }),
    });
    expect(promoted.status).toBe(200);
    await promoted.text();
    expect(model.calls).toHaveLength(2);
    expect(
      model.calls[1]?.messages.some((message) =>
        message.content.includes("anonymous history sentinel"),
      ),
    ).toBe(true);
  });

  test("does not consume an unsupported unkeyed external-auth assertion", async () => {
    let consumeCalls = 0;
    const sentinel = "SENTINEL_DISTRIBUTED_ASSERTION_DATABASE_SECRET";
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
      visitorIdentityAuthority: identityAuthority({
        claimExternalAssertion: async () => {
          throw new Error(sentinel);
        },
      }),
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
    const body = await response.text();
    expect(body).toBe('{"error":"external_auth_distributed_unavailable"}');
    expect(body).not.toContain(sentinel);
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
