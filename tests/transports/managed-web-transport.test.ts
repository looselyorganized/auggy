import { expect, test } from "bun:test";
import { join } from "node:path";
import { defineAgent } from "../../src/agent";
import { createManagedWebTransport } from "../../src/transports/web-transport";
import { createMockModel } from "../fixtures/mock-model";
import { createTempDir } from "../fixtures/temp-dir";

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = server.port!;
  await server.stop();
  return port;
}

test("external mount executes app handler with original guarded auth, limits and durable restart replay", async () => {
  const tmp = await createTempDir();
  const port = await freePort();
  const model = createMockModel({ response: "managed result" });
  const url = `http://127.0.0.1:${port}`;
  const make = (label: string) => {
    let ready = false;
    const web = createManagedWebTransport(
      {
        port,
        auth: { type: "bearer", token: "managed-web-test-only" },
        allowAnonymous: false,
        adminRoute: false,
        cors: { origins: ["https://client.example"] },
        maxRequestBodyBytes: 1024,
        idempotency: { dbPath: join(tmp.path, "runs.db") },
      },
      { name: "configured-web", canServe: () => ready },
    );
    const listener = web.http.createListener({
      routes: [
        {
          method: "POST",
          path: "/agent/run",
          handle: async (request) => {
            const response = await web.http.agentRun(request);
            const headers = new Headers(response.headers);
            headers.set("x-application-code", label);
            return new Response(response.body, { status: response.status, headers });
          },
        },
      ],
      fallback: web.http.fallback,
    });
    web.selectListener(listener);
    const agent = defineAgent(
      { name: "managed-web-test", model: "mock", augments: [web.augment] },
      model,
    );
    return {
      web,
      agent,
      ready: () => {
        ready = true;
      },
    };
  };
  const request = (bearer = "managed-web-test-only", content = "hi") =>
    fetch(`${url}/agent/run`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        "idempotency-key": "stable-request",
      },
      body: JSON.stringify({ threadId: "thread-one", messages: [{ role: "user", content }] }),
    });
  const first = make("first");
  let second: ReturnType<typeof make> | undefined;
  try {
    await first.agent.start();
    expect((await fetch(`${url}/health`)).status).toBe(503);
    first.ready();
    const denied = await request("wrong");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("x-application-code")).toBe("first");
    await denied.text();
    expect(model.calls).toHaveLength(0);
    const oversized = await request("managed-web-test-only", "x".repeat(2048));
    expect(oversized.status).toBe(413);
    await oversized.text();
    expect(model.calls).toHaveLength(0);
    const preflight = await fetch(`${url}/agent/run`, { method: "OPTIONS" });
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://client.example");
    const original = await request();
    const body = await original.text();
    expect(original.status).toBe(200);
    expect(body).toContain("managed result");
    expect(body).toContain("RUN_FINISHED");
    expect(model.calls).toHaveLength(1);
    first.web.closeAdmission();
    await first.agent.stop();
    expect(first.web.snapshot()).toMatchObject({
      pendingRequests: 0,
      pendingExecutions: 0,
      listenerActive: false,
      resourceState: "closed",
    });
    second = make("edited");
    await second.agent.start();
    second.ready();
    const replay = await request();
    expect({
      status: replay.status,
      application: replay.headers.get("x-application-code"),
    }).toEqual({ status: 200, application: "edited" });
    expect(await replay.text()).toBe(body);
    expect(model.calls).toHaveLength(1);
  } finally {
    await first.agent.stop();
    await second?.agent.stop();
    await tmp.cleanup();
  }
});

test("closing a managed transport retains active producer and stores until execution settles", async () => {
  const tmp = await createTempDir();
  const port = await freePort();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  const began = new Promise<void>((done) => {
    entered = done;
  });
  const model = createMockModel({ response: "settled" });
  const complete = model.complete.bind(model);
  model.complete = async (prompt) => {
    entered();
    await held;
    return complete(prompt);
  };
  const web = createManagedWebTransport(
    {
      port,
      auth: { type: "bearer", token: "drain-test-only" },
      adminRoute: false,
      allowAnonymous: false,
      idempotency: { dbPath: join(tmp.path, "runs.db") },
    },
    { name: "web", canServe: () => true },
  );
  web.selectListener(
    web.http.createListener({
      routes: [{ method: "POST", path: "/agent/run", handle: web.http.agentRun }],
      fallback: web.http.fallback,
    }),
  );
  const agent = defineAgent({ name: "drain", model: "mock", augments: [web.augment] }, model);
  await agent.start();
  try {
    const response = fetch(`http://127.0.0.1:${port}/agent/run`, {
      method: "POST",
      headers: {
        authorization: "Bearer drain-test-only",
        "content-type": "application/json",
        "idempotency-key": "drain",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    const body = response.then((value) => value.text());
    await began;
    web.closeAdmission();
    const stopping = agent.stop();
    expect(web.snapshot().pendingExecutions).toBe(1);
    expect(web.snapshot().resourceState).toBe("active");
    release();
    expect(await body).toContain("RUN_FINISHED");
    await stopping;
    expect(web.snapshot()).toMatchObject({ pendingExecutions: 0, resourceState: "closed" });
  } finally {
    release();
    await agent.stop();
    await tmp.cleanup();
  }
});
