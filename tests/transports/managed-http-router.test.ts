import { describe, expect, test } from "bun:test";
import { createManagedHttpRouter } from "../../src/transports/managed-http-router";
import type { ManagedHttpRequest } from "../../src/types";

function setup() {
  const calls: Array<{ request: Request; address: string | undefined }> = [];
  let ready = true;
  const router = createManagedHttpRouter({
    name: "web",
    external: true,
    canServe: () => ready,
    prelude: (request) =>
      request.method === "OPTIONS" ? new Response(null, { status: 204 }) : null,
    agentRun: async (request, connection) => {
      calls.push({ request, address: connection.requestIP?.(request)?.address });
      return new Response("guarded");
    },
    fallback: async () => new Response("fallback"),
  });
  return {
    router,
    calls,
    setReady: (value: boolean) => {
      ready = value;
    },
  };
}

describe("managed HTTP ownership", () => {
  test("binds original request/connection, permits response edits, and delegates once", async () => {
    const { router, calls } = setup();
    let saved: ManagedHttpRequest | undefined;
    const listener = router.http.createListener({
      routes: [
        {
          method: "POST",
          path: "/agent/run",
          handle: async (request) => {
            saved = request;
            expect(Object.isFrozen(request)).toBe(true);
            expect(Object.isFrozen(request.headers)).toBe(true);
            const response = router.http.agentRun(request);
            expect(() => router.http.agentRun(request)).toThrow("consumed");
            const result = await response;
            result.headers.set("x-app", "edited");
            return result;
          },
        },
      ],
      fallback: router.http.fallback,
    });
    router.select(listener);
    router.seal();
    const original = new Request("http://localhost/agent/run", { method: "POST", body: "raw" });
    const response = await router.dispatch(original, {
      requestIP: () => ({ address: "127.0.0.9" }),
    });
    expect(response.headers.get("x-app")).toBe("edited");
    expect(calls).toEqual([{ request: original, address: "127.0.0.9" }]);
    expect(() => router.http.agentRun(saved!)).toThrow("receipt");
  });

  test("rejects fabricated, cross-instance and mismatched descriptor authority", async () => {
    const a = setup().router,
      b = setup().router;
    expect(() => a.http.agentRun({} as ManagedHttpRequest)).toThrow("receipt");
    expect(() =>
      a.http.createListener({
        routes: [{ method: "POST", path: "/agent/run", handle: a.http.agentRun }],
        fallback: b.http.fallback,
      }),
    ).toThrow("fallback");
    const listener = a.http.createListener({
      routes: [
        {
          method: "POST",
          path: "/agent/run",
          handle: (receipt) => {
            expect(() => b.http.agentRun(receipt)).toThrow("receipt");
            return a.http.fallback(receipt);
          },
        },
      ],
      fallback: a.http.fallback,
    });
    expect(() => b.select(listener)).toThrow("ownership");
    a.select(listener);
    a.seal();
    expect(
      (await a.dispatch(new Request("http://localhost/agent/run", { method: "POST" }), {})).status,
    ).toBe(404);
    expect(() => a.select(listener)).toThrow("ownership");
  });

  test("retains preflight and readiness gates and observes in-flight handlers", async () => {
    const { router, calls, setReady } = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listener = router.http.createListener({
      routes: [
        {
          method: "POST",
          path: "/agent/run",
          handle: async (request) => {
            await held;
            return router.http.agentRun(request);
          },
        },
      ],
      fallback: router.http.fallback,
    });
    router.select(listener);
    router.seal();
    setReady(false);
    expect((await router.dispatch(new Request("http://localhost/health"), {})).status).toBe(503);
    setReady(true);
    expect(
      (await router.dispatch(new Request("http://localhost/agent/run", { method: "OPTIONS" }), {}))
        .status,
    ).toBe(204);
    const response = router.dispatch(
      new Request("http://localhost/agent/run", { method: "POST" }),
      {},
    );
    await Promise.resolve();
    router.closeAdmission();
    expect(router.pendingRequests()).toBe(1);
    let settled = false;
    const drained = router.waitForQuiescence().then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    expect((await router.dispatch(new Request("http://localhost/health"), {})).status).toBe(503);
    release();
    await response;
    await drained;
    expect(calls).toHaveLength(1);
    expect(settled).toBe(true);
  });

  test("detached delegation stays owned even if application handler returns or throws early", async () => {
    for (const throws of [false, true]) {
      let release!: () => void;
      const held = new Promise<void>((done) => {
        release = done;
      });
      const router = createManagedHttpRouter({
        name: "web",
        external: true,
        canServe: () => true,
        prelude: () => null,
        agentRun: async () => {
          await held;
          return new Response("settled");
        },
        fallback: async () => new Response(),
      });
      router.select(
        router.http.createListener({
          routes: [
            {
              method: "POST",
              path: "/agent/run",
              handle: (request) => {
                void router.http.agentRun(request);
                if (throws) throw new Error("application wrapper failed");
                return new Response("detached");
              },
            },
          ],
          fallback: router.http.fallback,
        }),
      );
      router.seal();
      const response = router.dispatch(
        new Request("http://localhost/agent/run", { method: "POST" }),
        {},
      );
      if (throws) await expect(response).rejects.toThrow("wrapper failed");
      else await response;
      router.closeAdmission();
      expect(router.pendingRequests()).toBe(1);
      let settled = false;
      const draining = router.waitForQuiescence().then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      await draining;
      expect(router.pendingRequests()).toBe(0);
    }
  });
});
