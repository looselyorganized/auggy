import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineAgent } from "../../src/agent";
import { hasConfirmedCleanup } from "../../src/application/cleanup-proof";
import {
  createExternalAuthAssertion,
  type CreateExternalAuthAssertionOptions,
} from "../../src/auth/external-auth";
import { EXTERNAL_AUTH_REPLAY_GUARD_FILE } from "../../src/auth/external-auth-replay-contracts";
import { prepareRuntimeDataVolume } from "../../src/cli/runtime-volume";
import type { RuntimeDataAdmission } from "../../src/runtime-data-contracts";
import {
  createManagedWebTransport,
  webTransport,
  type WebTransportOptions,
} from "../../src/transports/web-transport";
import type { Augment } from "../../src/types";
import { createMockModel } from "../fixtures/mock-model";
import { createTempDir } from "../fixtures/temp-dir";

const agentId = "aug1_8a3d7828-1597-4db4-bd0e-adc1a1036211";
const audience = "managed-replay-agent";
const secret = "managed-replay-test-secret";
const assertionHeader = "x-auggy-auth-assertion";
const origin = "https://client.example";

function assertion(
  jti: string,
  overrides: Partial<CreateExternalAuthAssertionOptions> = {},
): string {
  return createExternalAuthAssertion({
    secret,
    audience,
    provider: "app",
    subject: "customer-one",
    ttlSeconds: 60,
    jti,
    ...overrides,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const tmp = await createTempDir();
  const root = realpathSync(tmp.path);
  chmodSync(root, 0o700);
  const admit = () =>
    prepareRuntimeDataVolume({ kind: "explicit", runtimeDataRoot: root }, agentId);
  let lease = admit();
  const dbPath = join(root, "auth-replay.db");
  const guardPath = join(root, EXTERNAL_AUTH_REPLAY_GUARD_FILE);
  const agents: ReturnType<typeof defineAgent>[] = [];

  function restoreGuard(ageMs: number) {
    const now = Date.now();
    writeFileSync(
      guardPath,
      JSON.stringify({
        version: 1,
        agentId,
        latestRestore: { restoreId: crypto.randomUUID(), restoredAtMs: now - ageMs },
        highWaterMs: now,
      }),
      { mode: 0o600 },
    );
  }

  async function make(
    overrides: Partial<WebTransportOptions> = {},
    augments: Augment[] = [],
    model = createMockModel({ response: "managed execution" }),
  ) {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const port = probe.port!;
    await probe.stop();
    const options: WebTransportOptions = {
      port,
      securityNamespace: audience,
      auth: { type: "bearer", token: "creator-test-secret" },
      adminRoute: false,
      allowAnonymous: false,
      visitorTokens: { enabled: false },
      cors: { origins: [origin] },
      idempotency: { dbPath: join(root, "runs.db") },
      externalAuth: {
        secret,
        audience,
        allowedProviders: ["app"],
        maxTtlSeconds: 60,
        replayProtection: { enabled: true, dbPath },
      },
      ...overrides,
    };
    const web = createManagedWebTransport(options, {
      name: "managed-web",
      canServe: () => true,
      runtimeDataAdmission: lease.runtimeDataAdmission,
      managedExternalAuthDbPaths: [dbPath],
    });
    web.selectListener(
      web.http.createListener({
        routes: [{ method: "POST", path: "/agent/run", handle: web.http.agentRun }],
        fallback: web.http.fallback,
      }),
    );
    const agent = defineAgent(
      { name: audience, model: "mock", augments: [...augments, web.augment] },
      model,
    );
    agents.push(agent);
    const url = `http://127.0.0.1:${port}`;
    return {
      agent,
      web,
      options,
      model,
      run(token: string, key?: string) {
        return fetch(`${url}/agent/run`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [assertionHeader]: token,
            ...(key ? { "idempotency-key": key } : {}),
          },
          body: JSON.stringify({
            threadId: "customer-thread",
            messages: [{ role: "user", content: "hello" }],
          }),
        });
      },
      route(token?: string, path = "/optional") {
        return fetch(`${url}${path}`, {
          headers: token === undefined ? {} : { [assertionHeader]: token },
        });
      },
    };
  }

  return {
    root,
    dbPath,
    guardPath,
    make,
    restoreGuard,
    readmit() {
      lease.release();
      lease = admit();
    },
    async cleanup() {
      for (const agent of agents.reverse()) await agent.stop();
      lease.release();
      await tmp.cleanup();
    },
  };
}

function optionalRoute(onCall: () => void = () => {}): Augment {
  return {
    name: "managed-auth-fixture",
    httpRoutes: [
      {
        method: "GET",
        path: "/optional",
        auth: "visitor.optional",
        handler: async (_request, context) => {
          onCall();
          return Response.json(context.auth);
        },
      },
    ],
  };
}

async function expectUnavailable(response: Response) {
  expect(response.status).toBe(503);
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  const retry = Number(response.headers.get("retry-after"));
  expect(Number.isInteger(retry)).toBe(true);
  expect(retry).toBeGreaterThanOrEqual(1);
  expect(retry).toBeLessThanOrEqual(3600);
  expect(await response.json()).toEqual({ error: "external_auth_unavailable" });
}

describe("managed external auth transport", () => {
  test("shutdown retains resources while a denied private response is cancelling", async () => {
    const state = await fixture();
    const entered = deferred();
    const finishHandler = deferred();
    const cancelling = deferred();
    const finishCancel = deferred();
    try {
      const app = await state.make({}, [
        {
          name: "private-stream",
          httpRoutes: [
            {
              method: "GET",
              path: "/optional",
              auth: "visitor.required",
              handler: async () => {
                entered.resolve();
                await finishHandler.promise;
                return new Response(
                  new ReadableStream({
                    cancel: async () => {
                      cancelling.resolve();
                      await finishCancel.promise;
                    },
                  }),
                );
              },
            },
          ],
        },
      ]);
      await app.agent.start();
      const pending = app.route(assertion("private-stream"));
      await entered.promise;
      writeFileSync(state.guardPath, "corrupt guard");
      finishHandler.resolve();
      await cancelling.promise;
      await expectUnavailable(await pending);
      let stopped = false;
      const stop = app.agent.stop().then(() => {
        stopped = true;
      });
      expect(app.web.snapshot()).toMatchObject({ pendingExecutions: 1, resourceState: "active" });
      expect(hasConfirmedCleanup(app.web.augment)).toBe(false);
      expect(stopped).toBe(false);
      finishCancel.resolve();
      await stop;
      expect(hasConfirmedCleanup(app.web.augment)).toBe(true);
      expect(app.web.snapshot()).toMatchObject({ pendingExecutions: 0, resourceState: "closed" });
    } finally {
      finishHandler.resolve();
      finishCancel.resolve();
      await state.cleanup();
    }
  });

  test("invalid signatures and malformed assertions do not advance the guard, including during a restore hold", async () => {
    const state = await fixture();
    let calls = 0;
    try {
      for (const held of [false, true]) {
        if (held) state.restoreGuard(0);
        const app = await state.make({ allowAnonymous: true }, [optionalRoute(() => calls++)]);
        await app.agent.start();
        const before = readFileSync(state.guardPath, "utf8");
        for (const token of ["garbage", assertion("wrong-signature", { secret: "wrong-secret" })]) {
          const response = await app.route(token);
          expect(response.status).toBe(401);
          expect(await response.json()).toEqual({ error: "unauthorized" });
          expect(readFileSync(state.guardPath, "utf8")).toBe(before);
        }
        expect(calls).toBe(0);
        if (held) await expectUnavailable(await app.route(assertion("authentic-held")));
        await app.agent.stop();
        state.readmit();
      }
    } finally {
      await state.cleanup();
    }
  });

  test("public and fabricated owners cannot open managed replay; boot rollback owns the store", async () => {
    const state = await fixture();
    try {
      const options: WebTransportOptions = {
        port: 0,
        auth: { type: "bearer", token: "test-only" },
        adminRoute: false,
        allowAnonymous: false,
        externalAuth: {
          secret,
          maxTtlSeconds: 60,
          replayProtection: { enabled: true, dbPath: state.dbPath },
        },
      };
      expect(() => webTransport(options)).toThrow(/admitted AUGGY_DATA_DIR/);
      const forged = createManagedWebTransport(options, {
        name: "forged",
        canServe: () => true,
        runtimeDataAdmission: { runtimeDataRoot: state.root, agentId } as RuntimeDataAdmission,
        managedExternalAuthDbPaths: [state.dbPath],
      });
      await expect(forged.augment.onBoot?.()).rejects.toThrow();
      expect(existsSync(state.dbPath)).toBe(false);
      await forged.augment.onShutdown?.();

      const failed = await state.make({ idempotency: { dbPath: state.root } });
      await expect(failed.web.augment.onBoot?.()).rejects.toThrow();
      expect(existsSync(state.dbPath)).toBe(true);
      expect(failed.web.snapshot()).toMatchObject({
        listenerActive: false,
        resourceState: "active",
      });
      expect(hasConfirmedCleanup(failed.web.augment)).toBe(false);
      await failed.web.augment.onShutdown?.();
      expect(hasConfirmedCleanup(failed.web.augment)).toBe(true);
      expect(failed.web.snapshot().resourceState).toBe("closed");
    } finally {
      await state.cleanup();
    }
  });

  test("durable route claims survive lease restart and never downgrade optional auth", async () => {
    const state = await fixture();
    let calls = 0;
    try {
      const first = await state.make({ allowAnonymous: true }, [optionalRoute(() => calls++)]);
      await first.agent.start();
      const token = assertion("persistent-claim");
      const accepted = await first.route(token);
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ state: "recognized" });
      const execution = await first.run(assertion("persistent-execution"), "persisted-operation");
      expect(execution.status).toBe(200);
      const saved = await execution.text();
      await first.agent.stop();
      expect(hasConfirmedCleanup(first.web.augment)).toBe(true);
      state.readmit();
      const second = await state.make({ allowAnonymous: true }, [optionalRoute(() => calls++)]);
      await second.agent.start();
      for (const denied of [
        token,
        "invalid",
        "",
        assertion("wrong-audience", { audience: "another-agent" }),
      ]) {
        const response = await second.route(denied);
        expect(response.status).toBe(401);
        expect(response.headers.get("access-control-allow-origin")).toBe(origin);
        expect(await response.json()).toEqual({ error: "unauthorized" });
      }
      const agui = await second.run(token);
      expect(agui.status).toBe(401);
      await agui.text();
      const anonymous = await second.route();
      expect(anonymous.status).toBe(200);
      expect(await anonymous.json()).toMatchObject({ state: "anonymous" });
      expect(calls).toBe(2);
      const replay = await second.run(assertion("fresh-after-restart"), "persisted-operation");
      expect(replay.status).toBe(200);
      expect(await replay.text()).toBe(saved);
      expect(second.model.calls).toHaveLength(0);
    } finally {
      await state.cleanup();
    }
  });

  test("fresh assertions replay the same operation without consuming another claim or changing authorization", async () => {
    const state = await fixture();
    try {
      const app = await state.make({}, [optionalRoute()]);
      await app.agent.start();
      const original = assertion("original", { grants: [{ action: "read", resource: "one" }] });
      const fresh = assertion("fresh", { grants: [{ action: "read", resource: "one" }] });
      const initial = await app.run(original, "operation");
      expect(initial.status).toBe(200);
      const saved = await initial.text();
      expect(saved).toContain("RUN_FINISHED");
      const replay = await app.run(fresh, "operation");
      expect(replay.status).toBe(200);
      expect(await replay.text()).toBe(saved);
      for (const changed of [
        assertion("wrong-subject", {
          subject: "another-customer",
          grants: [{ action: "read", resource: "one" }],
        }),
        assertion("wrong-grant", { grants: [{ action: "read", resource: "two" }] }),
      ]) {
        const response = await app.run(changed, "operation");
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: "idempotency_key_conflict" });
      }
      const stillUnused = await app.route(fresh);
      expect(stillUnused.status).toBe(200);
      await stillUnused.text();
      const consumed = await app.run(original, "other-operation");
      expect(consumed.status).toBe(401);
      await consumed.text();
      const unknown = await app.run(
        assertion("replacement", { grants: [{ action: "read", resource: "one" }] }),
        "other-operation",
      );
      expect(unknown.status).toBe(409);
      expect(await unknown.json()).toEqual({ error: "idempotency_outcome_unknown" });
      // Deferred replay still enforces managed bounds, even though it does not consume.
      const oversized = await app.run(
        assertion("j".repeat(257), { grants: [{ action: "read", resource: "one" }] }),
        "operation",
      );
      expect(oversized.status).toBe(401);
      await oversized.text();
      expect(app.model.calls).toHaveLength(1);
    } finally {
      await state.cleanup();
    }
  });

  test("a startup restore hold rejects asserted route and AGUI requests before effects", async () => {
    const state = await fixture();
    let calls = 0;
    try {
      state.restoreGuard(0);
      const app = await state.make({ allowAnonymous: true }, [optionalRoute(() => calls++)]);
      await app.agent.start();
      await expectUnavailable(await app.route(assertion("restored-route")));
      await expectUnavailable(await app.run(assertion("restored-run")));
      expect(calls).toBe(0);
      expect(app.model.calls).toHaveLength(0);
    } finally {
      await state.cleanup();
    }
  });

  test("an async route cannot return asserted data after the current TTL reopens the hold", async () => {
    const state = await fixture();
    const entered = deferred();
    const release = deferred();
    try {
      state.restoreGuard(95_000);
      const app = await state.make({}, [
        {
          name: "slow-authorized-route",
          httpRoutes: [
            {
              method: "GET",
              path: "/optional",
              auth: "visitor.required",
              handler: async () => {
                entered.resolve();
                await release.promise;
                return Response.json({ privateResult: "guarded" });
              },
            },
          ],
        },
      ]);
      await app.agent.start();
      const response = app.route(assertion("slow-route"));
      await entered.promise;
      app.options.externalAuth!.maxTtlSeconds = 120;
      release.resolve();
      await expectUnavailable(await response);
    } finally {
      release.resolve();
      await state.cleanup();
    }
  });

  test("restore holds and live TTL increases gate ordinary routes and saved SSE", async () => {
    const state = await fixture();
    try {
      state.restoreGuard(95_000);
      const app = await state.make({}, [optionalRoute()]);
      await app.agent.start();
      const original = await app.run(assertion("before-hold"), "saved-operation");
      expect(original.status).toBe(200);
      const saved = await original.text();
      app.options.externalAuth!.maxTtlSeconds = 120;
      await expectUnavailable(await app.run(assertion("during-hold"), "saved-operation"));
      await expectUnavailable(await app.route(assertion("held-route")));
      app.options.externalAuth!.maxTtlSeconds = 60;
      const resumed = await app.run(assertion("after-hold"), "saved-operation");
      expect(resumed.status).toBe(200);
      expect(await resumed.text()).toBe(saved);
      writeFileSync(state.guardPath, "corrupt guard");
      await expectUnavailable(await app.run(assertion("guard-unavailable"), "saved-operation"));
      await expectUnavailable(await app.route(assertion("guard-unavailable-route")));
      expect(app.model.calls).toHaveLength(1);
    } finally {
      await state.cleanup();
    }
  });

  test("followers recheck the durable gate after waiting while shutdown retains active resources", async () => {
    const state = await fixture();
    const entered = deferred();
    const release = deferred();
    const waiting = deferred();
    try {
      state.restoreGuard(95_000);
      const model = createMockModel({ response: "one execution" });
      const complete = model.complete.bind(model);
      model.complete = async (prompt) => {
        entered.resolve();
        await release.promise;
        return complete(prompt);
      };
      const app = await state.make(
        {
          idempotency: {
            dbPath: join(state.root, "runs.db"),
            onWaiterCountChange: ({ active }) => {
              if (active > 0) waiting.resolve();
            },
          },
        },
        [],
        model,
      );
      await app.agent.start();
      const first = app
        .run(assertion("leader"), "one-operation")
        .then((response) => response.text());
      await entered.promise;
      const follower = app.run(assertion("follower"), "one-operation");
      await waiting.promise;
      app.options.externalAuth!.maxTtlSeconds = 120;
      const stopping = app.agent.stop();
      expect(app.web.snapshot().resourceState).toBe("active");
      expect(hasConfirmedCleanup(app.web.augment)).toBe(false);
      release.resolve();
      expect(await first).toContain("RUN_FINISHED");
      await expectUnavailable(await follower);
      await stopping;
      expect(app.web.snapshot()).toMatchObject({ pendingExecutions: 0, resourceState: "closed" });
      expect(hasConfirmedCleanup(app.web.augment)).toBe(true);
      expect(model.calls).toHaveLength(1);
    } finally {
      release.resolve();
      await state.cleanup();
    }
  });

  test("timed-out followers recheck availability before returning an in-progress outcome", async () => {
    const state = await fixture();
    const entered = deferred();
    const release = deferred();
    const waiting = deferred();
    try {
      state.restoreGuard(95_000);
      const model = createMockModel();
      const complete = model.complete.bind(model);
      model.complete = async (prompt) => {
        entered.resolve();
        await release.promise;
        return complete(prompt);
      };
      const app = await state.make(
        {
          idempotency: {
            dbPath: join(state.root, "runs.db"),
            waitTimeoutMs: 10,
            onWaiterCountChange: ({ active }) => {
              if (active > 0) waiting.resolve();
            },
          },
        },
        [],
        model,
      );
      await app.agent.start();
      const leader = app
        .run(assertion("timeout-leader"), "one-operation")
        .then((response) => response.text());
      await entered.promise;
      const follower = app.run(assertion("timeout-follower"), "one-operation");
      await waiting.promise;
      app.options.externalAuth!.maxTtlSeconds = 120;
      await expectUnavailable(await follower);
      release.resolve();
      expect(await leader).toContain("RUN_FINISHED");
      expect(model.calls).toHaveLength(1);
    } finally {
      release.resolve();
      await state.cleanup();
    }
  });

  test("guard failure after winning a keyed claim marks its outcome unknown", async () => {
    const state = await fixture();
    try {
      const app = await state.make();
      let savedGuard = "";
      let sabotage = true;
      app.options.externalAuth!.visitorId = () => {
        if (sabotage) {
          savedGuard = readFileSync(state.guardPath, "utf8");
          writeFileSync(state.guardPath, "interrupted guard");
          sabotage = false;
        }
        return "customer-fixture";
      };
      await app.agent.start();
      await expectUnavailable(await app.run(assertion("claim-failure"), "unknown-operation"));
      writeFileSync(state.guardPath, savedGuard);
      const retry = await app.run(assertion("claim-retry"), "unknown-operation");
      expect(retry.status).toBe(409);
      expect(await retry.json()).toEqual({ error: "idempotency_outcome_unknown" });
      expect(app.model.calls).toHaveLength(0);
    } finally {
      await state.cleanup();
    }
  });

  test("caller-owned stores keep their public consume arguments and are never closed", async () => {
    const state = await fixture();
    let closes = 0;
    const calls: [string, number, number][] = [];
    const store = {
      consume(jti: string, expiresAt: number, now: number) {
        calls.push([jti, expiresAt, now]);
        return true;
      },
      close() {
        closes++;
      },
    };
    try {
      const app = await state.make(
        { externalAuth: { secret, audience, replayProtection: { enabled: true, store } } },
        [optionalRoute()],
      );
      await app.agent.start();
      const now = Date.now();
      const response = await app.route(assertion("caller-owned-id", { now }));
      expect(response.status).toBe(200);
      await response.text();
      await app.agent.stop();
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe("caller-owned-id");
      expect(calls[0]![1]).toBe(now + 60_000);
      expect(calls[0]![2]).toBeGreaterThanOrEqual(now);
      expect(closes).toBe(0);
      expect(existsSync(state.dbPath)).toBe(false);
      expect(existsSync(state.guardPath)).toBe(false);
    } finally {
      await state.cleanup();
    }
  });
});
