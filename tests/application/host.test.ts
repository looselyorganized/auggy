import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  createApplicationHost,
  type ApplicationHostOptions,
  type OwnedApplicationHost,
} from "../../src/application/host";
import { readPidManifest } from "../../src/cli/pid-registry";
import { registerCleanupProof } from "../../src/application/cleanup-proof";
import type { AgentComposer, Augment, ConfiguredWebHttp } from "../../src/types";
import { createMockModel } from "../fixtures/mock-model";
import { contractComposer, contractTurnProgram } from "../fixtures/application-contract";
import { createSqliteDurableJobStore } from "../../src/jobs/sqlite-store";
import { routeFixtureAugment } from "../fixtures/route-fixture-augment";
import { prepareRuntimeDataVolume } from "../../src/cli/runtime-volume";

const roots: string[] = [];
const hosts: OwnedApplicationHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop({ deadlineMs: 100 });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(augments: Augment[] = []) {
  const root = mkdtempSync(join(tmpdir(), "auggy-managed-host-"));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  const configPath = join(project, "agent.yaml");
  const id = `aug1_${crypto.randomUUID()}`;
  writeFileSync(
    join(project, "src/index.ts"),
    "// Test declaration; host does not import this module.\n",
  );
  writeFileSync(join(project, "identity.md"), "# Test agent\n");
  writeFileSync(
    configPath,
    stringify({
      id,
      name: "host-test",
      application: { entrypoint: "./src/index.ts", contractVersion: 1 },
      engine: { provider: "anthropic", model: "fixture" },
      augments: [
        {
          name: "identity",
          type: "fileMemory",
          options: {
            label: "self",
            source: "./identity.md",
            mutable: false,
            origin: "operator",
            priority: "required",
            placement: "system",
            eviction: "never",
          },
        },
      ],
    }),
  );
  const registry = {
    auggyDir: join(root, "registry"),
    processIdentityForPid: () => "test-process-incarnation",
  };
  const options: ApplicationHostOptions = {
    configPath,
    mode: "foreground",
    ...registry,
    compose: contractComposer,
    factories: {
      resolveEngine: async () => createMockModel(),
      resolveAugments: async () => augments,
    },
  };
  return {
    root,
    project,
    id,
    configPath,
    registry,
    options,
    manifest: () => readPidManifest(id, registry),
    configure(patch: Record<string, unknown>) {
      writeFileSync(
        configPath,
        stringify({ ...parse(readFileSync(configPath, "utf8")), ...patch }),
      );
    },
    host(extra: Partial<ApplicationHostOptions> = {}) {
      const host = createApplicationHost({ ...options, ...extra });
      hosts.push(host);
      return host;
    },
  };
}

test("all managed replay paths are admitted before any provider or transport factory", async () => {
  const f = fixture();
  const data = join(f.root, "durable-data");
  mkdirSync(data, { mode: 0o700 });
  const previous = process.env.AUGGY_DATA_DIR;
  delete process.env.AUGGY_DATA_DIR;
  const web = (name: string, port: number, dbPath: string) => ({
    name,
    type: "webTransport",
    options: {
      port,
      auth: { type: "bearer", token: "test-bearer" },
      adminRoute: false,
      externalAuth: {
        secret: "fixture-app-secret",
        maxTtlSeconds: 60,
        replayProtection: { enabled: true, dbPath },
      },
    },
  });
  let calls = 0;
  const factories = {
    resolveEngine: async () => {
      calls++;
      return createMockModel();
    },
    resolveAugments: async () => {
      calls++;
      return [];
    },
  };
  try {
    f.configure({ augments: [web("first", 8087, "./data/replay.db")] });
    const absent = f.host({ factories });
    await expect(absent.prepare()).rejects.toThrow(/admitted AUGGY_DATA_DIR/);
    await absent.stop();
    process.env.AUGGY_DATA_DIR = data;
    f.configure({
      augments: [web("first", 8087, "./data/replay.db"), web("second", 8088, "../../outside.db")],
    });
    const outside = f.host({ factories });
    await expect(outside.prepare()).rejects.toThrow(/within/);
    await outside.stop();
    expect(existsSync(join(data, "replay.db"))).toBe(false);
    f.configure({
      augments: [web("first", 8087, "./data/replay.db"), web("second", 8088, "./data/replay.db")],
    });
    const duplicate = f.host({ factories });
    await expect(duplicate.prepare()).rejects.toThrow(/distinct augment owners/);
    await duplicate.stop();
    for (const dbPath of [
      ":memory:",
      "file:replay.db",
      "sqlite:replay.db",
      ".auggy-auth-replay-guard.json/child.db",
      ".AUGGY-AUTH-REPLAY-GUARD.PENDING/child.db",
      join(data, ".auggy-state-identity.json", "child.db"),
    ]) {
      f.configure({ augments: [web("first", 8087, dbPath)] });
      const invalid = f.host({ factories });
      await expect(invalid.prepare()).rejects.toThrow(
        /ordinary file|reserved runtime control path/,
      );
      await invalid.stop();
    }
    expect(existsSync(join(data, ".auggy-auth-replay-guard.json"))).toBe(false);
    expect(existsSync(join(data, ".AUGGY-AUTH-REPLAY-GUARD.PENDING"))).toBe(false);
    expect(calls).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.AUGGY_DATA_DIR;
    else process.env.AUGGY_DATA_DIR = previous;
  }
});

for (const launch of [
  { mode: "direct", legacy: false },
  { mode: "foreground", legacy: false },
  { mode: "foreground", legacy: true },
] as const) {
  test(`${launch.mode}${launch.legacy ? " legacy" : ""} admits explicit storage before factories and holds it through shutdown`, async () => {
    const f = fixture();
    const data = join(f.root, "durable-data");
    mkdirSync(data, { mode: 0o700 });
    const previous = process.env.AUGGY_DATA_DIR;
    process.env.AUGGY_DATA_DIR = data;
    const selection = { kind: "explicit", runtimeDataRoot: data } as const;
    let factoryCalls = 0;
    let shutdowns = 0;
    const assertHeld = () =>
      expect(() => prepareRuntimeDataVolume(selection, f.id)).toThrow(/another live replica/);
    const host = f.host({
      ...launch,
      factories: {
        resolveEngine: async () => {
          factoryCalls++;
          assertHeld();
          return createMockModel();
        },
        resolveAugments: async (_configs, _dir, options) => {
          factoryCalls++;
          expect(options?.runtimeDataRoot).toBe(data);
          expect(options?.runtimeDataPlatform).toBe("generic");
          assertHeld();
          return [
            {
              name: "storage-owner",
              onShutdown: async () => {
                shutdowns++;
                assertHeld();
              },
            },
          ];
        },
      },
    });
    try {
      await host.prepare();
      expect(factoryCalls).toBe(2);
      expect(f.manifest()?.runtimeData).toEqual({ platform: "generic", root: data });
      await host.start({ http: [] });
      expect(await host.stop()).toMatchObject({ status: "stopped", ownership: "released" });
      expect(shutdowns).toBe(1);
      const next = prepareRuntimeDataVolume(selection, f.id);
      next.release();
    } finally {
      await host.stop();
      if (previous === undefined) delete process.env.AUGGY_DATA_DIR;
      else process.env.AUGGY_DATA_DIR = previous;
    }
  });
}

test("explicit missing or unsafe data roots fail before any provider or augment factory", async () => {
  const f = fixture();
  const unsafe = join(f.root, "unsafe-data");
  const missing = join(f.root, "missing-data");
  mkdirSync(unsafe);
  chmodSync(unsafe, 0o755);
  const previous = process.env.AUGGY_DATA_DIR;
  let factoryCalls = 0;
  try {
    for (const root of [missing, unsafe]) {
      process.env.AUGGY_DATA_DIR = root;
      const host = f.host({
        factories: {
          resolveEngine: async () => {
            factoryCalls++;
            return createMockModel();
          },
          resolveAugments: async () => {
            factoryCalls++;
            return [];
          },
        },
      });
      await expect(host.prepare()).rejects.toThrow();
      expect(await host.stop()).toMatchObject({ ownership: "released" });
      expect(f.manifest()).toBeNull();
    }
    expect(factoryCalls).toBe(0);
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(join(unsafe, "agent-mail"))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.AUGGY_DATA_DIR;
    else process.env.AUGGY_DATA_DIR = previous;
  }
});

test("stopping during pending construction retains the data lease until resources settle", async () => {
  const f = fixture();
  const data = join(f.root, "durable-data");
  mkdirSync(data, { mode: 0o700 });
  const previous = process.env.AUGGY_DATA_DIR;
  process.env.AUGGY_DATA_DIR = data;
  const entered = deferred();
  const settled = deferred();
  const selection = { kind: "explicit", runtimeDataRoot: data } as const;
  const host = f.host({
    factories: {
      resolveEngine: async () => {
        entered.resolve();
        await settled.promise;
        return createMockModel();
      },
    },
  });
  try {
    const preparing = host.prepare().catch((error) => error);
    await entered.promise;
    expect(await host.stop({ deadlineMs: 5 })).toMatchObject({ status: "retained" });
    expect(() => prepareRuntimeDataVolume(selection, f.id)).toThrow(/another live replica/);
    settled.resolve();
    expect(await preparing).toBeInstanceOf(Error);
    expect(await host.stop()).toMatchObject({ status: "stopped", ownership: "released" });
    const next = prepareRuntimeDataVolume(selection, f.id);
    next.release();
  } finally {
    settled.resolve();
    await host.stop();
    if (previous === undefined) delete process.env.AUGGY_DATA_DIR;
    else process.env.AUGGY_DATA_DIR = previous;
  }
});

test("claims precede every factory and composition; readiness and one-shot cleanup are explicit", async () => {
  const events: string[] = [];
  const f = fixture([
    {
      name: "resource",
      onBoot: async () => {
        events.push("boot");
      },
      onShutdown: async () => {
        events.push("close");
      },
    },
  ]);
  const host = f.host({
    onConfigured: () => {
      expect(f.manifest()).toBeNull();
      events.push("configured");
    },
    factories: {
      resolveEngine: async () => {
        expect(f.manifest()?.agentId).toBe(f.id);
        events.push("engine");
        return createMockModel();
      },
      resolveAugments: async (...args) => {
        expect(f.manifest()?.agentId).toBe(f.id);
        events.push("augments");
        return f.options.factories!.resolveAugments!(...args);
      },
    },
    compose: (configured) => {
      expect(f.manifest()?.agentId).toBe(f.id);
      events.push("compose");
      return contractComposer(configured);
    },
  });
  const prepared = await host.prepare();
  expect(prepared.http).toEqual([]);
  expect(host.isReady).toBe(false);
  expect(events).toEqual(["configured", "engine", "augments", "compose"]);
  expect(await host.start({ http: [] })).toEqual({ agentName: "host-test", http: [] });
  expect(host.isReady).toBe(true);
  expect(await host.stop()).toEqual({
    status: "stopped",
    ownership: "released",
    cleanup: "complete",
    failures: [],
  });
  expect(await host.stop()).toEqual(await host.closed);
  expect(f.manifest()).toBeNull();
  expect(events).toEqual(["configured", "engine", "augments", "compose", "boot", "close"]);
  await expect(host.prepare()).rejects.toThrow(/one-shot/);
  await expect(host.start({ http: [] })).rejects.toThrow(/once/);
});

test("a competing host fails before factories and does not release the incumbent's claims", async () => {
  const f = fixture();
  const incumbent = f.host();
  await incumbent.prepare();
  let factories = 0;
  const contender = f.host({
    factories: {
      resolveEngine: async () => {
        factories++;
        return createMockModel();
      },
    },
  });
  await expect(contender.prepare()).rejects.toThrow(/live or unverifiable runtime/);
  await contender.stop();
  expect(factories).toBe(0);
  expect(f.manifest()?.agentId).toBe(f.id);
  await incumbent.stop();
  expect(f.manifest()).toBeNull();
});

test("stop during a pending factory retains claims and late settlement cleans allocated resources", async () => {
  const f = fixture();
  const entered = deferred(),
    held = deferred();
  let closed = 0;
  const host = f.host({
    factories: {
      resolveEngine: async () => createMockModel(),
      resolveAugments: async () => {
        entered.resolve();
        await held.promise;
        return [
          {
            name: "late",
            onShutdown: async () => {
              closed++;
            },
          },
        ];
      },
    },
  });
  const preparing = host.prepare();
  const rejected = preparing.catch((error) => error);
  await entered.promise;
  expect(await host.stop({ deadlineMs: 5 })).toMatchObject({
    status: "retained",
    reason: "deadline",
  });
  expect(f.manifest()?.agentId).toBe(f.id);
  held.resolve();
  expect(await rejected).toBeInstanceOf(Error);
  expect(await host.stop()).toMatchObject({ status: "stopped", cleanup: "complete" });
  expect(closed).toBe(1);
  expect(f.manifest()).toBeNull();
});

test("agent constructor failure rolls back the full factory graph once without boot", async () => {
  const closed: string[] = [];
  const gate = (name: string): Augment => ({
    name,
    turnGate: {
      prepare: async () => ({
        decision: { allow: true },
        confirm: async () => {},
        rollback: async () => {},
      }),
    },
    onBoot: async () => {
      throw new Error("must not boot");
    },
    onShutdown: async () => {
      closed.push(name);
    },
  });
  const f = fixture([gate("a"), gate("b")]);
  const host = f.host();
  await expect(host.prepare()).rejects.toThrow(/Only one augment/);
  expect(await host.stop()).toMatchObject({ status: "stopped", cleanup: "complete" });
  expect(closed).toEqual(["b", "a"]);
  expect(f.manifest()).toBeNull();
});

test("unstarted host cleanup owns factory allocations and rejects foreign listener bindings", async () => {
  let closed = 0;
  const f = fixture([
    {
      name: "unbooted",
      onShutdown: async () => {
        closed++;
      },
    },
  ]);
  const host = f.host();
  await host.prepare();
  await expect(host.start({ http: [{} as never] })).rejects.toThrow(/exactly one listener/);
  expect(await host.stop()).toMatchObject({ status: "stopped" });
  expect(closed).toBe(1);
  expect(f.manifest()).toBeNull();
});

test("each stop observer has a deadline while joining the same actual hook cleanup", async () => {
  const entered = deferred(),
    held = deferred();
  let calls = 0;
  const f = fixture([
    {
      name: "held",
      onShutdown: async () => {
        calls++;
        entered.resolve();
        await held.promise;
      },
    },
  ]);
  const host = f.host();
  await host.prepare();
  await host.start({ http: [] });
  const short = host.stop({ deadlineMs: 5 });
  await entered.promise;
  const long = host.stop({ deadlineMs: 1000 });
  expect(await short).toMatchObject({ status: "retained", reason: "deadline" });
  expect(f.manifest()?.agentId).toBe(f.id);
  expect(host.isReady).toBe(false);
  held.resolve();
  expect(await long).toMatchObject({ status: "stopped", cleanup: "complete" });
  expect(calls).toBe(1);
  expect(f.manifest()).toBeNull();
});

test("settled unknown cleanup retains claims; confirmed closure reports failure while releasing", async () => {
  for (const proven of [false, true]) {
    let closed = false;
    const augment: Augment = {
      name: "cleanup-error",
      onShutdown: async () => {
        closed = true;
        throw new Error("not evidence");
      },
    };
    if (proven) registerCleanupProof(augment, () => closed);
    const f = fixture([augment]);
    const host = f.host();
    await host.prepare();
    await host.start({ http: [] });
    const stopped = await host.stop();
    expect(stopped.failures).toEqual(["augment-shutdown-failed"]);
    expect(stopped).toMatchObject(
      proven
        ? { status: "stopped", cleanup: "failed" }
        : { status: "retained", reason: "outcome-unknown" },
    );
    expect(f.manifest() !== null).toBe(!proven);
  }
});

test("composition receipt cannot be reused after a throwing callback", async () => {
  const f = fixture();
  let saved: Parameters<AgentComposer>[0] | undefined;
  const host = f.host({
    compose: (configured) => {
      saved = configured;
      throw new Error("application failed");
    },
  });
  await expect(host.prepare()).rejects.toThrow("application failed");
  expect(() => contractComposer(saved!)).toThrow(/consumed/);
  expect(await host.stop()).toMatchObject({ status: "stopped" });
  expect(f.manifest()).toBeNull();
});

test("public shutdown deadlines reject invalid values before starting cleanup", async () => {
  const f = fixture();
  const host = f.host();
  await host.prepare();
  await host.start({ http: [] });
  for (const deadlineMs of [0, -1, 0.5, NaN, Infinity, 900001])
    await expect(host.stop({ deadlineMs })).rejects.toThrow(/deadline/);
  expect(host.isReady).toBe(true);
  expect(await host.stop()).toMatchObject({ status: "stopped" });
});

async function freePort() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port!;
  await server.stop(true);
  return port;
}

function listener(web: ConfiguredWebHttp) {
  return web.createListener({
    routes: [
      {
        method: "POST",
        path: "/agent/run",
        handle: async (request) => {
          const response = await web.agentRun(request);
          const headers = new Headers(response.headers);
          headers.set("x-project-handler", web.name);
          return new Response(response.body, { status: response.status, headers });
        },
      },
    ],
    fallback: web.fallback,
  });
}

test("real resolver gives each configured HTTP instance one app-owned listener and preserves original auth", async () => {
  const f = fixture();
  const ports = [await freePort(), await freePort()];
  f.configure({
    augments: ports.map((port, index) => ({
      name: `web-${index}`,
      type: "webTransport",
      options: {
        port,
        auth: { type: "bearer", token: "host-web-test" },
        allowAnonymous: false,
        adminRoute: false,
      },
    })),
  });
  const model = createMockModel({ response: "host response" });
  const host = f.host({ factories: { resolveEngine: async () => model } });
  const prepared = await host.prepare();
  expect(prepared.http.map((web) => web.name)).toEqual(["web-0", "web-1"]);
  const ready = await host.start({ http: prepared.http.map(listener).reverse() });
  expect(ready.http.map((web) => web.port)).toEqual(ports);
  for (const [index, port] of ports.entries()) {
    const denied = await fetch(`http://127.0.0.1:${port}/agent/run`, {
      method: "POST",
      body: "{}",
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("x-project-handler")).toBe(`web-${index}`);
    await denied.text();
    const run = await fetch(`http://127.0.0.1:${port}/agent/run`, {
      method: "POST",
      headers: { authorization: "Bearer host-web-test", "content-type": "application/json" },
      body: JSON.stringify({
        threadId: `web-${index}`,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(run.status).toBe(200);
    expect(await run.text()).toContain("host response");
  }
  expect(model.calls).toHaveLength(2);
  expect(await host.stop()).toMatchObject({ status: "stopped", cleanup: "complete" });
  expect(f.manifest()).toBeNull();
});

test("duplicate and foreign HTTP descriptors fail before listener startup", async () => {
  const f = fixture();
  const ports = [await freePort(), await freePort()];
  f.configure({
    augments: ports.map((port, index) => ({
      name: `web-${index}`,
      type: "webTransport",
      options: { port, adminRoute: false },
    })),
  });
  const host = f.host({ factories: { resolveEngine: async () => createMockModel() } });
  const prepared = await host.prepare();
  const descriptor = listener(prepared.http[0]!);
  await expect(host.start({ http: [descriptor, descriptor] })).rejects.toThrow(
    /exactly one listener/,
  );
  expect(await host.stop()).toMatchObject({ status: "stopped" });
  const other = f.host({ factories: { resolveEngine: async () => createMockModel() } });
  const current = await other.prepare();
  await expect(other.start({ http: [descriptor, listener(current.http[1]!)] })).rejects.toThrow(
    /ownership conflict/,
  );
  expect(await other.stop()).toMatchObject({ status: "stopped" });
  for (const port of ports) {
    const server = Bun.serve({ port, fetch: () => new Response() });
    await server.stop(true);
  }
});

test("durable jobs wait for every transport then execute the selected application turn program", async () => {
  const entered = deferred(),
    held = deferred();
  const f = fixture([
    {
      name: "transport",
      transport: {
        identify: () => null,
        register: async () => {},
        ready: async () => {
          entered.resolve();
          await held.promise;
        },
      },
    },
  ]);
  f.configure({ settings: { jobs: { enabled: true, dbPath: "./jobs.sqlite", claimPollMs: 100 } } });
  const model = createMockModel();
  let applicationTurns = 0;
  const host = f.host({
    factories: { ...f.options.factories, resolveEngine: async () => model },
    compose: (configured) =>
      configured.compose({
        turnProgram: {
          ...contractTurnProgram,
          run: async (turn) => {
            applicationTurns++;
            return contractTurnProgram.run(turn);
          },
        },
      }),
  });
  await host.prepare();
  const store = createSqliteDurableJobStore({ dbPath: join(f.project, "jobs.sqlite") });
  const submitted = store.submit({
    idempotencyKey: "host-job",
    binding: { test: "host" },
    payload: {
      version: 1,
      value: {
        version: 1,
        kind: "agent-turn",
        threadId: "host-job",
        prompt: "run the local application recipe",
        timeoutMs: 1000,
        maxAttempts: 1,
      },
    },
  });
  try {
    const starting = host.start({ http: [] });
    await entered.promise;
    await Bun.sleep(120);
    expect(host.isReady).toBe(false);
    expect(store.getSummary(submitted.job.id)?.state).toBe("queued");
    expect(applicationTurns).toBe(0);
    held.resolve();
    await starting;
    const deadline = Date.now() + 2000;
    while (store.getSummary(submitted.job.id)?.state !== "completed") {
      if (Date.now() > deadline) throw new Error("durable job did not complete");
      await Bun.sleep(10);
    }
    expect(applicationTurns).toBe(1);
    expect(model.calls).toHaveLength(1);
    expect(await host.stop()).toMatchObject({ status: "stopped", cleanup: "complete" });
    expect(f.manifest()).toBeNull();
  } finally {
    held.resolve();
    await host.stop();
    store.close();
  }
});

test("timed-out HTTP route retains host claims and route resources until actual handler settlement", async () => {
  const f = fixture();
  const port = await freePort();
  f.configure({
    augments: [{ name: "web", type: "webTransport", options: { port, adminRoute: false } }],
  });
  const held = deferred();
  let resourceClosed = false;
  const route = routeFixtureAugment({
    auth: "none",
    timeoutMs: 10,
    handler: async () => {
      await held.promise;
      expect(resourceClosed).toBe(false);
      return new Response("late");
    },
  });
  route.onShutdown = async () => {
    resourceClosed = true;
  };
  const host = f.host({
    factories: {
      resolveEngine: async () => createMockModel(),
      resolveAugments: async (_configs, _dir, options) => [
        options!.webTransportFactory!(
          { port, auth: { type: "bearer", token: "route-test-only" }, adminRoute: false },
          "web",
        ),
        route,
      ],
    },
  });
  try {
    const prepared = await host.prepare();
    await host.start({ http: prepared.http.map(listener) });
    const response = await fetch(`http://127.0.0.1:${port}/test/echo`);
    expect(response.status).toBe(504);
    await response.text();
    expect(await host.stop({ deadlineMs: 10 })).toMatchObject({
      status: "retained",
      reason: "deadline",
    });
    expect(resourceClosed).toBe(false);
    expect(f.manifest()?.agentId).toBe(f.id);
    held.resolve();
    expect(await host.stop()).toMatchObject({ status: "stopped", cleanup: "complete" });
    expect(resourceClosed).toBe(true);
    expect(f.manifest()).toBeNull();
  } finally {
    held.resolve();
    await host.stop();
  }
});

test("streaming HTTP response drains before shutdown of the route's augment resources", async () => {
  const f = fixture();
  const port = await freePort();
  f.configure({
    augments: [{ name: "web", type: "webTransport", options: { port, adminRoute: false } }],
  });
  const held = deferred();
  let resourceClosed = false;
  let bodySawClosedResource: boolean | undefined;
  const route = routeFixtureAugment({
    auth: "bearer",
    handler: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("begin"));
            await held.promise;
            bodySawClosedResource = resourceClosed;
            controller.enqueue(new TextEncoder().encode("end"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/plain" } },
      ),
  });
  route.onShutdown = async () => {
    resourceClosed = true;
  };
  const host = f.host({
    factories: {
      resolveEngine: async () => createMockModel(),
      resolveAugments: async (_configs, _dir, options) => [
        options!.webTransportFactory!(
          { port, auth: { type: "bearer", token: "stream-test-only" }, adminRoute: false },
          "web",
        ),
        route,
      ],
    },
  });
  let cancelBody: (() => Promise<void>) | undefined;
  try {
    const prepared = await host.prepare();
    await host.start({ http: prepared.http.map(listener) });
    const response = await fetch(`http://127.0.0.1:${port}/test/echo`, {
      headers: { authorization: "Bearer stream-test-only" },
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    cancelBody = () => reader.cancel();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("begin");
    expect(await host.stop({ deadlineMs: 10 })).toMatchObject({
      status: "retained",
      reason: "deadline",
    });
    expect(resourceClosed).toBe(false);
    expect(f.manifest()?.agentId).toBe(f.id);
    held.resolve();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("end");
    expect((await reader.read()).done).toBe(true);
    expect(await host.stop()).toMatchObject({ status: "stopped", cleanup: "complete" });
    expect(bodySawClosedResource).toBe(false);
    expect(resourceClosed).toBe(true);
    expect(f.manifest()).toBeNull();
  } finally {
    held.resolve();
    await cancelBody?.();
    await host.stop();
  }
});
