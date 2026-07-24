import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { defineAgent } from "@/agent";
import {
  createExternalAuthAssertion,
  createInMemoryExternalAuthReplayStore,
} from "@/auth/external-auth";
import { budgets } from "@/augments/budgets";
import { webTransport } from "@/transports/web-transport";
import { createVisitorToken, deriveSigningKey } from "@/transports/visitor-token";
import type { AssembledPrompt, ModelClient, ModelResponse } from "@/types";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTempDir } from "@tests/fixtures/temp-dir";

const BEARER = "idempotency-test-bearer";

function request(
  port: number,
  input: {
    key: string;
    threadId?: string;
    text?: string;
    anonymousSession?: string;
    bearer?: boolean;
    omitThreadId?: boolean;
    agent?: { id: string; secret: string };
    visitorToken?: string;
    externalAssertion?: string;
  },
): Promise<Response> {
  return fetch(`http://localhost:${port}/agent/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": input.key,
      ...(input.bearer === false ? {} : { authorization: `Bearer ${BEARER}` }),
      ...(input.anonymousSession ? { "x-auggy-anonymous-session": input.anonymousSession } : {}),
      ...(input.visitorToken ? { "x-visitor-token": input.visitorToken } : {}),
      ...(input.externalAssertion ? { "x-auggy-auth-assertion": input.externalAssertion } : {}),
      ...(input.agent
        ? { "x-agent-id": input.agent.id, "x-agent-secret": input.agent.secret }
        : {}),
    },
    body: JSON.stringify({
      ...(input.omitThreadId ? {} : { threadId: input.threadId ?? "idempotency-thread" }),
      messages: [{ role: "user", content: input.text ?? "hello" }],
    }),
  });
}

function createBarrierModel(): {
  model: ModelClient;
  calls: AssembledPrompt[];
  started: Promise<void>;
  release(): void;
} {
  const calls: AssembledPrompt[] = [];
  let startedResolve!: () => void;
  let releaseResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  return {
    calls,
    started,
    release: releaseResolve,
    model: {
      maxContextTokens: 100_000,
      countTokens(text) {
        return Math.ceil(text.length / 4);
      },
      async complete(prompt): Promise<ModelResponse> {
        calls.push(prompt);
        startedResolve();
        await released;
        return {
          content: "barrier complete",
          inputTokens: 1,
          outputTokens: 1,
          finishReason: "end_turn",
        };
      },
    },
  };
}

describe("web transport durable idempotency", () => {
  let tmp: { path: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await createTempDir();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it("replays one terminal stream, rejects binding changes, and survives restart", async () => {
    const dbPath = join(tmp.path, "web-idempotency.db");
    const firstModel = createMockModel({ response: "one execution" });
    const port = 19370;
    const firstTransport = webTransport({
      port,
      auth: { type: "bearer", token: BEARER },
      access: { agents: [{ id: "worker", sharedSecret: "worker-secret" }] },
      idempotency: { dbPath },
    });
    const firstAgent = defineAgent(
      { name: "idempotency", model: "mock", augments: [firstTransport] },
      firstModel,
    );
    await firstAgent.start();

    let originalBody = "";
    try {
      const original = await request(port, { key: "request-1" });
      expect(original.status).toBe(200);
      originalBody = await original.text();
      expect(originalBody).toMatch(/"runId":"[0-9a-f-]{36}"/);
      expect(originalBody).not.toContain("request-1");

      const replay = await request(port, { key: "request-1" });
      const replayBody = await replay.text();
      expect({ status: replay.status, body: replayBody }).toEqual({
        status: 200,
        body: originalBody,
      });
      expect(firstModel.calls).toHaveLength(1);

      const changedText = await request(port, { key: "request-1", text: "changed" });
      expect(changedText.status).toBe(409);
      expect(await changedText.json()).toEqual({ error: "idempotency_key_conflict" });

      const changedThread = await request(port, {
        key: "request-1",
        threadId: "another-thread",
      });
      expect(changedThread.status).toBe(409);

      const changedPeer = await request(port, {
        key: "request-1",
        agent: { id: "worker", secret: "worker-secret" },
      });
      expect(changedPeer.status).toBe(409);
      expect(firstModel.calls).toHaveLength(1);
    } finally {
      await firstAgent.stop();
    }

    const restartedModel = createMockModel({ response: "must not run" });
    const restartedPort = 19373;
    const restartedTransport = webTransport({
      port: restartedPort,
      auth: { type: "bearer", token: BEARER },
      idempotency: { dbPath },
    });
    const restartedAgent = defineAgent(
      { name: "idempotency", model: "mock", augments: [restartedTransport] },
      restartedModel,
    );
    await restartedAgent.start();
    try {
      const replay = await request(restartedPort, { key: "request-1" });
      const replayBody = await replay.text();
      expect({ status: replay.status, body: replayBody }).toEqual({
        status: 200,
        body: originalBody,
      });
      expect(restartedModel.calls).toHaveLength(0);
    } finally {
      await restartedAgent.stop();
    }
  });

  it("derives one canonical thread when a keyed request omits threadId", async () => {
    const model = createMockModel({ response: "canonical thread" });
    const port = 19376;
    const transport = webTransport({
      port,
      auth: { type: "bearer", token: BEARER },
      idempotency: { dbPath: join(tmp.path, "web-idempotency.db") },
    });
    const agent = defineAgent({ name: "idempotency", model: "mock", augments: [transport] }, model);
    await agent.start();

    try {
      const first = await request(port, { key: "no-thread-1", omitThreadId: true });
      const firstBody = await first.text();
      const replay = await request(port, { key: "no-thread-1", omitThreadId: true });
      expect(replay.status).toBe(200);
      expect(await replay.text()).toBe(firstBody);
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

  it("coalesces concurrent matching requests behind one execution", async () => {
    const barrier = createBarrierModel();
    const port = 19371;
    const transport = webTransport({
      port,
      auth: { type: "bearer", token: BEARER },
      idempotency: { dbPath: join(tmp.path, "web-idempotency.db") },
    });
    const agent = defineAgent(
      { name: "idempotency", model: "barrier", augments: [transport] },
      barrier.model,
    );
    await agent.start();

    try {
      const firstResponsePromise = request(port, { key: "concurrent-1" });
      await barrier.started;
      const secondResponsePromise = request(port, { key: "concurrent-1" });
      barrier.release();

      const [firstResponse, secondResponse] = await Promise.all([
        firstResponsePromise,
        secondResponsePromise,
      ]);
      const [firstBody, secondBody] = await Promise.all([
        firstResponse.text(),
        secondResponse.text(),
      ]);
      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      expect(secondBody).toBe(firstBody);
      expect(barrier.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

  it("abandons an unstarted durable claim when scheduler admission rejects it", async () => {
    const barrier = createBarrierModel();
    const port = 19402;
    const transport = webTransport({
      port,
      auth: { type: "bearer", token: BEARER },
      concurrency: 1,
      maxQueueDepth: 0,
      idempotency: { dbPath: join(tmp.path, "web-idempotency.db") },
    });
    const agent = defineAgent(
      {
        name: "idempotency",
        model: "barrier",
        augments: [transport],
        turnScheduling: {
          maxConcurrent: 1,
          maxQueued: 0,
          maxQueuedPerThread: 0,
        },
      },
      barrier.model,
    );
    await agent.start();

    try {
      const activeResponsePromise = request(port, {
        key: "active-request",
        threadId: "active-thread",
      });
      await barrier.started;

      const overloaded = await request(port, {
        key: "retryable-request",
        threadId: "retryable-thread",
      });
      expect(overloaded.status).toBe(200);
      expect(await overloaded.text()).toContain("SCHEDULER_RATE_LIMITED");
      expect(barrier.calls).toHaveLength(1);

      barrier.release();
      const activeResponse = await activeResponsePromise;
      expect(await activeResponse.text()).toContain("barrier complete");

      const retry = await request(port, {
        key: "retryable-request",
        threadId: "retryable-thread",
      });
      expect(retry.status).toBe(200);
      expect(await retry.text()).toContain("barrier complete");
      expect(barrier.calls).toHaveLength(2);
    } finally {
      barrier.release();
      await agent.stop();
    }
  });

  it("coalesces replay-protected external auth behind the keyed execution", async () => {
    const barrier = createBarrierModel();
    const audience = "idempotency-external-replay";
    const externalSecret = "idempotency-external-replay-secret";
    const assertion = createExternalAuthAssertion({
      secret: externalSecret,
      audience,
      provider: "app",
      subject: "user-1",
      jti: "assertion-1",
    });
    const port = 19401;
    const transport = webTransport({
      port,
      auth: { type: "bearer", token: BEARER },
      allowAnonymous: false,
      externalAuth: {
        secret: externalSecret,
        audience,
        allowedProviders: ["app"],
        replayProtection: {
          enabled: true,
          store: createInMemoryExternalAuthReplayStore(),
        },
      },
      idempotency: { dbPath: join(tmp.path, "web-idempotency.db") },
    });
    const agent = defineAgent(
      { name: audience, model: "barrier", augments: [transport] },
      barrier.model,
    );
    await agent.start();

    try {
      const leader = request(port, {
        key: "external-replay-key",
        bearer: false,
        externalAssertion: assertion,
      });
      await barrier.started;
      const follower = request(port, {
        key: "external-replay-key",
        bearer: false,
        externalAssertion: assertion,
      });
      barrier.release();
      const [leaderResponse, followerResponse] = await Promise.all([leader, follower]);
      const [leaderBody, followerBody] = await Promise.all([
        leaderResponse.text(),
        followerResponse.text(),
      ]);
      expect(leaderResponse.status).toBe(200);
      expect(followerResponse.status).toBe(200);
      expect(followerBody).toBe(leaderBody);
      expect(barrier.calls).toHaveLength(1);

      const differentKey = await request(port, {
        key: "external-replay-different-key",
        bearer: false,
        externalAssertion: assertion,
      });
      expect(differentKey.status).toBe(401);
      expect(barrier.calls).toHaveLength(1);
    } finally {
      barrier.release();
      await agent.stop();
    }
  });

  it("fails keyed programmatic requests closed without explicit ledger storage", async () => {
    const model = createMockModel({ response: "must not run" });
    const port = 19400;
    const transport = webTransport({
      port,
      auth: { type: "bearer", token: BEARER },
    });
    const agent = defineAgent({ name: "idempotency", model: "mock", augments: [transport] }, model);
    await agent.start();

    try {
      const response = await request(port, { key: "no-ledger" });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "idempotency_unavailable" });
      expect(model.calls).toHaveLength(0);
    } finally {
      await agent.stop();
    }
  });

  it("bounds active duplicate followers before they reach the kernel queue", async () => {
    const barrier = createBarrierModel();
    let waiterObservedResolve!: () => void;
    const waiterObserved = new Promise<void>((resolve) => {
      waiterObservedResolve = resolve;
    });
    const port = 19377;
    const transport = webTransport({
      port,
      auth: { type: "bearer", token: BEARER },
      idempotency: {
        dbPath: join(tmp.path, "web-idempotency.db"),
        maxWaiters: 1,
        maxWaitersPerKey: 1,
        onWaiterCountChange: ({ forKey }) => {
          if (forKey === 1) waiterObservedResolve();
        },
      },
    });
    const agent = defineAgent(
      { name: "idempotency", model: "barrier", augments: [transport] },
      barrier.model,
    );
    await agent.start();

    try {
      const leader = request(port, { key: "bounded-followers" });
      await barrier.started;
      const admittedFollower = request(port, { key: "bounded-followers" });
      await waiterObserved;

      const rejectedFollower = await request(port, { key: "bounded-followers" });
      expect(rejectedFollower.status).toBe(429);
      expect(await rejectedFollower.json()).toEqual({
        error: "idempotency_waiter_capacity_reached",
      });

      barrier.release();
      const [leaderResponse, followerResponse] = await Promise.all([leader, admittedFollower]);
      expect(leaderResponse.status).toBe(200);
      expect(followerResponse.status).toBe(200);
      expect(await followerResponse.text()).toBe(await leaderResponse.text());
      expect(barrier.calls).toHaveLength(1);
    } finally {
      barrier.release();
      await agent.stop();
    }
  });

  it("scopes one shared ledger to the registered agent security namespace", async () => {
    const dbPath = join(tmp.path, "shared-idempotency.db");
    const firstModel = createMockModel({ response: "agent a" });
    const firstTransport = webTransport({
      port: 19378,
      auth: { type: "bearer", token: BEARER },
      idempotency: { dbPath },
    });
    const firstAgent = defineAgent(
      { name: "agent-a", model: "mock", augments: [firstTransport] },
      firstModel,
    );
    await firstAgent.start();
    try {
      expect((await request(19378, { key: "same-key" })).status).toBe(200);
    } finally {
      await firstAgent.stop();
    }

    const secondModel = createMockModel({ response: "agent b" });
    const secondTransport = webTransport({
      port: 19379,
      auth: { type: "bearer", token: BEARER },
      idempotency: { dbPath },
    });
    const secondAgent = defineAgent(
      { name: "agent-b", model: "mock", augments: [secondTransport] },
      secondModel,
    );
    await secondAgent.start();
    try {
      const response = await request(19379, { key: "same-key" });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("agent b");
      expect(secondModel.calls).toHaveLength(1);
    } finally {
      await secondAgent.stop();
    }
  });

  it("binds nested delegated grant constraints into the canonical request", async () => {
    const signingKey = "idempotency-visitor-signing-key";
    const externalSecret = "idempotency-external-auth-key";
    const audience = "idempotency-auth-agent";
    const visitorId = "vis_idempotency_user";
    const key = await deriveSigningKey(signingKey);
    const token = await createVisitorToken(key, audience, 3_600, visitorId);
    const assertion = (constraintKeyId: string) =>
      createExternalAuthAssertion({
        secret: externalSecret,
        audience,
        provider: "app",
        subject: "user",
        grants: [
          {
            action: "order.read",
            resource: "order-1",
            constraints: { keyId: constraintKeyId, expiresAt: 42 },
          },
        ],
      });
    const model = createMockModel({ response: "authorized" });
    const port = 19380;
    const transport = webTransport({
      port,
      auth: { type: "bearer", token: BEARER },
      visitorTokens: { enabled: true, signingKey, agentBinding: audience },
      externalAuth: {
        secret: externalSecret,
        audience,
        allowedProviders: ["app"],
        visitorId,
      },
      idempotency: { dbPath: join(tmp.path, "web-idempotency.db") },
    });
    const agent = defineAgent({ name: audience, model: "mock", augments: [transport] }, model);
    await agent.start();
    try {
      const first = await request(port, {
        key: "delegated-constraint",
        bearer: false,
        visitorToken: token.token,
        externalAssertion: assertion("key-a"),
      });
      expect(first.status).toBe(200);
      await first.text();

      const changed = await request(port, {
        key: "delegated-constraint",
        bearer: false,
        visitorToken: token.token,
        externalAssertion: assertion("key-b"),
      });
      expect(changed.status).toBe(409);
      expect(await changed.json()).toEqual({ error: "idempotency_key_conflict" });
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

  it("requires a signed anonymous session before claiming a keyed execution", async () => {
    const model = createMockModel({ response: "anonymous execution" });
    const port = 19372;
    const transport = webTransport({
      port,
      auth: { type: "bearer", token: BEARER },
      allowAnonymous: true,
      idempotency: { dbPath: join(tmp.path, "web-idempotency.db") },
    });
    const agent = defineAgent({ name: "idempotency", model: "mock", augments: [transport] }, model);
    await agent.start();

    try {
      const bootstrap = await request(port, { key: "anonymous-1", bearer: false });
      expect(bootstrap.status).toBe(428);
      const session = bootstrap.headers.get("x-auggy-anonymous-session");
      expect(session).toBeTruthy();
      expect(model.calls).toHaveLength(0);

      const execution = await request(port, {
        key: "anonymous-1",
        bearer: false,
        anonymousSession: session ?? undefined,
      });
      expect(execution.status).toBe(200);
      const body = await execution.text();
      expect(model.calls).toHaveLength(1);

      const replay = await request(port, {
        key: "anonymous-1",
        bearer: false,
        anonymousSession: session ?? undefined,
      });
      expect(await replay.text()).toBe(body);
      expect(model.calls).toHaveLength(1);
    } finally {
      await agent.stop();
    }
  });

  it("replays terminal failures without repeating the failed attempt", async () => {
    let calls = 0;
    const model: ModelClient = {
      maxContextTokens: 100_000,
      countTokens(text) {
        return Math.ceil(text.length / 4);
      },
      async complete(): Promise<ModelResponse> {
        calls += 1;
        throw new Error("deterministic provider failure");
      },
    };
    const port = 19374;
    const transport = webTransport({
      port,
      auth: { type: "bearer", token: BEARER },
      idempotency: { dbPath: join(tmp.path, "web-idempotency.db") },
    });
    const agent = defineAgent(
      { name: "idempotency", model: "throwing", augments: [transport] },
      model,
    );
    await agent.start();

    try {
      const first = await request(port, { key: "failed-request-1" });
      const firstBody = await first.text();
      expect(firstBody).toContain("RUN_ERROR");
      expect(calls).toBe(1);

      const replay = await request(port, { key: "failed-request-1" });
      expect(await replay.text()).toBe(firstBody);
      expect(calls).toBe(1);
    } finally {
      await agent.stop();
    }
  });

  it("keeps caller keys out of internal budget reservation IDs", async () => {
    const model = createMockModel({ response: "budgeted" });
    const port = 19375;
    const idempotencyDbPath = join(tmp.path, "web-idempotency.db");
    const budgetDbPath = join(tmp.path, "budgets.db");
    const transport = webTransport({
      port,
      auth: { type: "bearer", token: BEARER },
      access: { agents: [{ id: "worker", sharedSecret: "worker-secret" }] },
      idempotency: { dbPath: idempotencyDbPath },
    });
    const agent = defineAgent(
      {
        name: "idempotency",
        model: "mock",
        augments: [
          budgets({
            dbPath: budgetDbPath,
            caps: { agent: { maxTurnsPerThread: 1 } },
          }),
          transport,
        ],
      },
      model,
    );
    await agent.start();

    try {
      const key = "public-request-key-1";
      const first = await request(port, {
        key,
        agent: { id: "worker", secret: "worker-secret" },
      });
      expect(first.status).toBe(200);
      await first.text();

      const replay = await request(port, {
        key,
        agent: { id: "worker", secret: "worker-secret" },
      });
      expect(replay.status).toBe(200);
      await replay.text();
      expect(model.calls).toHaveLength(1);

      const idempotencyDb = new Database(idempotencyDbPath, { readonly: true });
      const budgetDb = new Database(budgetDbPath, { readonly: true });
      try {
        const ledger = idempotencyDb
          .query<{ turn_id: string }, []>("SELECT turn_id FROM web_idempotency")
          .get();
        const reservation = budgetDb
          .query<{ turn_id: string }, []>("SELECT turn_id FROM turn_reservations")
          .get();
        expect(ledger?.turn_id).toMatch(/^[0-9a-f-]{36}$/);
        expect(reservation?.turn_id).toBe(ledger?.turn_id);
        expect(reservation?.turn_id).not.toBe(key);
        const allRows = idempotencyDb
          .query<Record<string, unknown>, []>("SELECT * FROM web_idempotency")
          .all();
        expect(JSON.stringify(allRows)).not.toContain(key);
      } finally {
        budgetDb.close();
        idempotencyDb.close();
      }
    } finally {
      await agent.stop();
    }
  });
});
