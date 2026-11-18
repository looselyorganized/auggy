import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertSealedTelegramContainerSnapshot,
  parseTelegramContainerSnapshot,
  prepareTelegramContainerFixtures,
  writeTelegramGenerationReceipt,
} from "../../scripts/release-smoke/integration-telegram-container";
import { telegramFixtureUpdate } from "../../scripts/release-smoke/integration-fixtures/telegram/protocol-fixture";

const PROXY = "http://127.0.0.1:43141";
const CONTROL = "http://127.0.0.1:43142/control";
const TOKEN = "e".repeat(64);
const nativeFetch = globalThis.fetch;
type Intercept = (request: Request, init: RequestInit | undefined) => Promise<Response>;

async function fixture(
  run: (context: {
    root: string;
    control(operation: string, extra?: Record<string, unknown>, token?: string): Promise<Response>;
    final(): Promise<string>;
  }) => Promise<void>,
  intercept?: Intercept,
) {
  const root = mkdtempSync(join(tmpdir(), "m5-telegram-seal-"));
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "src/main.ts"),
    readFileSync(
      new URL("../../src/scaffold-templates/application/src/main.ts.template", import.meta.url),
    ),
  );
  prepareTelegramContainerFixtures(root);
  const keys = [
    "AUGGY_FIXTURE_CONTROL_TOKEN",
    "AUGGY_FIXTURE_GENERATION_ID",
    "AUGGY_FIXTURE_TELEGRAM_ORIGIN",
    "AUGGY_FIXTURE_MODEL_ORIGIN",
  ] as const;
  const before = keys.map((key) => [key, process.env[key]] as const);
  process.env.AUGGY_FIXTURE_CONTROL_TOKEN = TOKEN;
  process.env.AUGGY_FIXTURE_GENERATION_ID = "test:sealed";
  process.env.AUGGY_FIXTURE_TELEGRAM_ORIGIN = PROXY;
  process.env.AUGGY_FIXTURE_MODEL_ORIGIN = PROXY;
  const module = await import(
    pathToFileURL(join(root, "src/fixtures/telegram-container-startup.ts")).href
  );
  let started = false;
  const control = (operation: string, extra: Record<string, unknown> = {}, token = TOKEN) =>
    nativeFetch(CONTROL, {
      method: "POST",
      headers: { "x-fixture-control": token, "content-type": "application/json" },
      body: JSON.stringify({ operation, ...extra }),
      signal: AbortSignal.timeout(10_000),
    });
  try {
    if (intercept)
      globalThis.fetch = ((request: Request, init?: RequestInit) =>
        intercept(request, init)) as typeof fetch;
    await module.startContainerTelegramFixture();
    started = true;
    globalThis.fetch = nativeFetch;
    await run({
      root,
      control,
      async final() {
        for (let attempt = 0; attempt < 7; attempt++) {
          const response = await control("final");
          const bytes = await response.text();
          if (response.status === 200) return bytes;
          expect(response.status).toBe(202);
        }
        throw new Error("Terminal fixture evidence unavailable");
      },
    });
  } finally {
    globalThis.fetch = nativeFetch;
    if (started) await module.stopContainerTelegramFixture().catch(() => {});
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const post = (path: string, body: unknown, signal?: AbortSignal) =>
  nativeFetch(`${PROXY}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "auggy-telegram/0.1" },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(20_000),
  });
const effect = {
  marker: "telegram-proof:baseline",
  trust: "creator",
  peerId: "101",
  peerKind: "user",
  publicSubstate: null,
  threadId: "thread",
};

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

test("authentication protects both quotas; exhausted ordinary observations retain immutable terminal export", async () => {
  await fixture(async ({ control, final }) => {
    for (let i = 0; i < 140; i++) {
      const denied = await control(i % 2 ? "seal" : "snapshot", {}, "wrong");
      expect(denied.status).toBe(403);
      await denied.body?.cancel();
    }
    for (let i = 0; i < 128; i++) {
      const ordinary =
        i % 2
          ? await nativeFetch(CONTROL, {
              method: "POST",
              headers: { "x-fixture-control": TOKEN },
              body: "{",
              signal: AbortSignal.timeout(2000),
            })
          : await control("snapshot");
      expect(ordinary.status).toBe(i % 2 ? 400 : 200);
      await ordinary.body?.cancel();
    }
    const exhausted = await control("snapshot");
    expect(exhausted.status).toBe(429);
    await exhausted.body?.cancel();
    const sealing = await control("seal");
    expect([200, 202]).toContain(sealing.status);
    await sealing.body?.cancel();
    const first = await final();
    const snapshot = parseTelegramContainerSnapshot(first);
    assertSealedTelegramContainerSnapshot(snapshot);
    expect(first).not.toContain(TOKEN);
    const second = await control("final");
    expect(await second.text()).toBe(first);
    await expect(post("/effect", effect)).rejects.toThrow();
    // Seal + first export + second export consumed three of the reserve's eight.
    for (let i = 0; i < 5; i++) expect(await (await control("final")).text()).toBe(first);
    const spent = await control("final");
    expect(spent.status).toBe(429);
    await spent.body?.cancel();
  });
}, 10_000);

test("sealing owns a streamed response until EOF rather than accepting response headers", async () => {
  let release: (() => void) | undefined;
  await fixture(
    async ({ control, final }) => {
      const response = await post("/v1/messages", {});
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
      const before = parseTelegramContainerSnapshot(await (await control("snapshot")).text());
      expect(before.lifecycle.activeProxy).toBe(1);
      expect(before.lifecycle.activeModel).toBe(1);
      await (await control("seal")).body?.cancel();
      let completed = false;
      const receipt = final().then((value) => {
        completed = true;
        return value;
      });
      await Bun.sleep(50);
      expect(completed).toBe(false);
      release!();
      expect((await reader.read()).done).toBe(true);
      reader.releaseLock();
      const sealed = parseTelegramContainerSnapshot(await receipt);
      assertSealedTelegramContainerSnapshot(sealed);
      expect(sealed.lifecycle.cancelledBodies).toBe(0);
      await expect(post("/effect", effect)).rejects.toThrow();
    },
    async (request, init) => {
      if (new URL(request.url).pathname !== "/v1/messages") return nativeFetch(request, init);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            release = () => controller.close();
          },
        }),
      );
    },
  );
});

test("cancelled response bodies release ownership and the final receipt remains immutable", async () => {
  let cancelled = false;
  let finishCancellation: (() => void) | undefined;
  await fixture(
    async ({ control, final }) => {
      const abort = new AbortController();
      const response = await post("/v1/messages", {}, abort.signal);
      const reader = response.body!.getReader();
      await reader.read();
      abort.abort();
      const closing = reader.cancel().catch(() => {});
      try {
        await waitFor(() => cancelled);
        const pending = parseTelegramContainerSnapshot(await (await control("snapshot")).text());
        expect(pending.lifecycle.activeModel).toBe(1);
        expect(pending.lifecycle.activeProxy).toBe(1);
      } finally {
        finishCancellation?.();
      }
      await closing;
      reader.releaseLock();
      await (await control("seal")).body?.cancel();
      const sealed = parseTelegramContainerSnapshot(await final());
      assertSealedTelegramContainerSnapshot(sealed);
      expect(sealed.lifecycle.cancelledBodies).toBe(1);
    },
    async (request, init) => {
      if (new URL(request.url).pathname !== "/v1/messages") return nativeFetch(request, init);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
          },
          cancel() {
            cancelled = true;
            return new Promise<void>((resolve) => {
              finishCancellation = resolve;
            });
          },
        }),
      );
    },
  );
});

test("work admitted to the proxy before sealing cannot commit a late protocol effect", async () => {
  let arrived = false;
  let release: (() => void) | undefined;
  await fixture(
    async ({ control, final }) => {
      const late = post("/effect", effect);
      await waitFor(() => arrived);
      await (await control("seal")).body?.cancel();
      release!();
      const rejected = await late;
      expect(rejected.status).toBe(503);
      await rejected.body?.cancel();
      const sealed = parseTelegramContainerSnapshot(await final());
      expect(sealed.lifecycle.state).toBe("failed");
      expect(sealed.lifecycle.failures).toContain("late-work");
      expect(sealed.protocol.rejectedWhileSealing).toBe(1);
      expect(sealed.protocol.events.some((event) => event.kind === "effect")).toBe(false);
      expect(() => assertSealedTelegramContainerSnapshot(sealed)).toThrow("not sealed");
    },
    async (request, init) => {
      if (new URL(request.url).pathname === "/effect") {
        arrived = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return nativeFetch(request, init);
    },
  );
});

test("an undrained response reaches the real bound and cannot produce passing evidence", async () => {
  await fixture(
    async ({ control, final }) => {
      const response = await post("/v1/messages", {});
      const reader = response.body!.getReader();
      await reader.read();
      const started = Date.now();
      await (await control("seal")).body?.cancel();
      const sealed = parseTelegramContainerSnapshot(await final());
      expect(Date.now() - started).toBeGreaterThanOrEqual(9_900);
      expect(sealed.lifecycle.state).toBe("failed");
      expect(sealed.lifecycle.failures).toContain("drain-timeout");
      expect(() => assertSealedTelegramContainerSnapshot(sealed)).toThrow("not sealed");
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    },
    async (request, init) => {
      if (new URL(request.url).pathname !== "/v1/messages") return nativeFetch(request, init);
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            heartbeat = setInterval(
              () => controller.enqueue(new TextEncoder().encode("still-open")),
              250,
            );
          },
          cancel() {
            if (heartbeat) clearInterval(heartbeat);
          },
        }),
      );
    },
  );
}, 25_000);

test("pending delivery and erased provider rejection are not accepted at sealing", async () => {
  await fixture(async ({ control, final }) => {
    const rejected = await post("/v1/messages", {});
    expect(rejected.status).toBe(401);
    await rejected.body?.cancel();
    const enqueued = await control("enqueue", { update: telegramFixtureUpdate(1, 101) });
    expect(enqueued.status).toBe(200);
    await enqueued.body?.cancel();
    await (await control("seal")).body?.cancel();
    const sealed = parseTelegramContainerSnapshot(await final());
    expect(sealed.provider.rejectedRequests).toBe(0);
    expect(sealed.providerGenerations[0]!.rejectedRequests).toBe(1);
    expect(sealed.providerGenerations.map((entry) => entry.generation)).toEqual([1, 2]);
    expect(sealed.lifecycle.failures).toContain("pending-updates");
    expect(sealed.lifecycle.failures).toContain("provider-rejection");
    expect(() => assertSealedTelegramContainerSnapshot(sealed)).toThrow("not sealed");
  });
});

test("generation receipts are strict, private, exclusive and bound to source and instance identities", async () => {
  await fixture(async ({ root, control, final }) => {
    await (await control("seal")).body?.cancel();
    const snapshot = parseTelegramContainerSnapshot(await final());
    const evidence = join(root, "evidence");
    mkdirSync(evidence, { mode: 0o700 });
    const options = {
      directory: evidence,
      generation: "sealed",
      runId: "test",
      source: { revision: "a".repeat(40), tree: "b".repeat(40) },
      imageId: `sha256:${"c".repeat(64)}`,
      exportSHA256: "d".repeat(64),
      containerId: "e".repeat(64),
      snapshot,
    };
    const receipt = writeTelegramGenerationReceipt(options);
    expect(lstatSync(join(evidence, receipt.path)).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(join(evidence, receipt.path), "utf8");
    expect(JSON.parse(bytes).snapshot).toEqual(snapshot);
    expect(() => writeTelegramGenerationReceipt(options)).toThrow("already exists");
    expect(() => writeTelegramGenerationReceipt({ ...options, runId: randomUUID() })).toThrow(
      "identity changed",
    );
    const linked = join(root, "linked");
    mkdirSync(linked, { mode: 0o700 });
    symlinkSync(join(evidence, receipt.path), join(linked, receipt.path));
    expect(() => writeTelegramGenerationReceipt({ ...options, directory: linked })).toThrow();
    expect(readFileSync(join(evidence, receipt.path), "utf8")).toBe(bytes);
    chmodSync(linked, 0o755);
    expect(() => writeTelegramGenerationReceipt({ ...options, directory: linked })).toThrow(
      "private",
    );
    const extra = { ...snapshot, authority: TOKEN };
    expect(() => parseTelegramContainerSnapshot(JSON.stringify(extra))).toThrow();
    const missingHistory = { ...snapshot, providerGenerations: [] };
    expect(() => parseTelegramContainerSnapshot(JSON.stringify(missingHistory))).toThrow();
    expect(() =>
      assertSealedTelegramContainerSnapshot({
        ...snapshot,
        lifecycle: { ...snapshot.lifecycle, businessListenersClosed: false },
      }),
    ).toThrow("not sealed");
  });
});
