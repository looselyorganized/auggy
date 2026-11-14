import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  assertTelegramFixtureOverlay,
  assertTelegramDeliveryIdentity,
  assertTelegramSourceMarker,
  inspectTelegramReplay,
  prepareTelegramFixtureOverlay,
} from "../../scripts/release-smoke/integration-telegram";
import {
  installTelegramFixtureNetwork,
  TELEGRAM_FIXTURE_INSTALL_MARKER,
  TELEGRAM_FIXTURE_TOKEN,
} from "../../scripts/release-smoke/integration-fixtures/telegram/telegram-network";
import {
  createTelegramProtocolFixture,
  telegramFixtureUpdate,
} from "../../scripts/release-smoke/integration-fixtures/telegram/protocol-fixture";

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
const project = () => {
  const root = mkdtempSync(join(tmpdir(), "auggy-telegram-preparation-"));
  temporary.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "src/index.ts"),
    readFileSync(
      new URL("../../src/scaffold-templates/application/src/index.ts.template", import.meta.url),
    ),
  );
  return root;
};

describe("Telegram fixture preparation only - not installed acceptance", () => {
  test("overlay preflight rejects absence, changed bytes and delayed installation", () => {
    const root = project();
    expect(() =>
      assertTelegramFixtureOverlay(root, {
        networkSHA256: "0".repeat(64),
        startupSHA256: "0".repeat(64),
      }),
    ).toThrow();
    const overlay = prepareTelegramFixtureOverlay(root);
    expect(overlay.changes.map((change) => change.path)).toEqual([
      "src/fixtures/telegram-network.ts",
      "src/index.ts",
    ]);
    expect(() => assertTelegramFixtureOverlay(root, overlay.identity)).not.toThrow();
    const startup = readFileSync(join(root, "src/index.ts"), "utf8");
    expect(startup).toContain(
      `async (launch) => {\n  installTelegramFixtureNetwork("${TELEGRAM_FIXTURE_INSTALL_MARKER}");`,
    );
    writeFileSync(
      join(root, "src/index.ts"),
      startup.replace("auggy-telegram-fixture-network-v1", "wrong-marker"),
    );
    expect(() => assertTelegramFixtureOverlay(root, overlay.identity)).toThrow();
    writeFileSync(join(root, "src/index.ts"), startup);
    writeFileSync(join(root, "src/fixtures/telegram-network.ts"), "throw new Error('tampered')");
    expect(() => assertTelegramFixtureOverlay(root, overlay.identity)).toThrow();
  });

  test("marker assertions need an actual observed domain execution", () => {
    expect(() => assertTelegramSourceMarker([], "telegram-proof:edited")).toThrow();
    const event = {
      kind: "attempt" as const,
      marker: "telegram-proof:baseline",
      trust: "creator",
      peerId: "creator",
      peerKind: "human",
      publicSubstate: null,
      threadId: "thread",
    };
    expect(() => assertTelegramSourceMarker([event], "telegram-proof:edited")).toThrow();
    expect(() =>
      assertTelegramSourceMarker(
        [{ ...event, marker: "telegram-proof:edited" }],
        "telegram-proof:edited",
      ),
    ).not.toThrow();
  });

  test("read-only replay inspector rejects an unrelated database", () => {
    const root = project();
    mkdirSync(join(root, "data"));
    const database = new Database(join(root, "data/telegram-replay.db"));
    database.exec("CREATE TABLE unrelated (id TEXT)");
    database.close();
    expect(() => inspectTelegramReplay(root)).toThrow("database identity");
  });

  test("identity oracle rejects changed public state, principal, kind and thread", () => {
    const update = telegramFixtureUpdate(3, 404);
    const event = {
      kind: "attempt" as const,
      marker: "telegram-proof:baseline",
      trust: "public",
      peerId: "tg_anon_tg-bot-123456789-chat-404",
      peerKind: "human",
      publicSubstate: "anonymous" as const,
      threadId: "tg-bot-123456789-chat-404",
    };
    expect(() => assertTelegramDeliveryIdentity([event], update, "anonymous")).not.toThrow();
    for (const changed of [
      { ...event, publicSubstate: "recognized" as const },
      { ...event, publicSubstate: null },
      { ...event, peerId: "creator" },
      { ...event, peerKind: "agent" },
      { ...event, threadId: "tg-bot-999-chat-404" },
    ])
      expect(() => assertTelegramDeliveryIdentity([changed], update, "anonymous")).toThrow(
        "identity",
      );
    expect(() => assertTelegramDeliveryIdentity([event, event], update, "anonymous")).toThrow(
      "exactly one",
    );
  });

  test("overlay forwards real serialized requests and restores native fetch", async () => {
    const fixture = createTelegramProtocolFixture();
    const native = globalThis.fetch;
    const restore = installTelegramFixtureNetwork(TELEGRAM_FIXTURE_INSTALL_MARKER, {
      telegramOrigin: fixture.origin,
      modelOrigin: fixture.origin,
    });
    try {
      const update = telegramFixtureUpdate(1, 101);
      fixture.enqueue(update);
      const headers = { "content-type": "application/json", "user-agent": "auggy-telegram/0.1" };
      const response = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_FIXTURE_TOKEN}/getUpdates`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ offset: 1, timeout: 1 }),
          redirect: "manual",
        },
      );
      expect(await response.json()).toEqual({ ok: true, result: [update] });
      const reply = await fetch(
        new Request(`https://api.telegram.org/bot${TELEGRAM_FIXTURE_TOKEN}/sendMessage`, {
          method: "POST",
          headers,
          body: JSON.stringify({ chat_id: 101, text: "synthetic reply" }),
        }),
      );
      expect(reply.status).toBe(200);
      expect(fixture.snapshot().events).toEqual([
        { kind: "poll", offset: 1, timeout: 1, updateIds: [1], json: true, runtimeUserAgent: true },
        { kind: "reply", chatId: 101, text: "synthetic reply", json: true, runtimeUserAgent: true },
      ]);
      const serialized = JSON.stringify(fixture.snapshot());
      expect(serialized).not.toContain(TELEGRAM_FIXTURE_TOKEN);
      expect(serialized).not.toContain("headers");
    } finally {
      restore();
      await fixture.stop();
    }
    expect(globalThis.fetch).toBe(native);
  });

  test("unknown destination, token, method, query and userinfo fail before native fetch", async () => {
    const fixture = createTelegramProtocolFixture();
    const restore = installTelegramFixtureNetwork(TELEGRAM_FIXTURE_INSTALL_MARKER, {
      telegramOrigin: fixture.origin,
      modelOrigin: fixture.origin,
    });
    try {
      for (const target of [
        "https://example.invalid/",
        "https://api.telegram.org/botWRONG/getUpdates",
        `https://api.telegram.org/bot${TELEGRAM_FIXTURE_TOKEN}/getMe`,
        `https://api.telegram.org/bot${TELEGRAM_FIXTURE_TOKEN}/getUpdates?token=wrong`,
        `${fixture.origin}/control`,
        `${fixture.origin}/v1/messages/redirect`,
      ])
        await expect(fetch(target, { method: "POST", body: "{}" })).rejects.toThrow();
      await expect(
        fetch(`https://api.telegram.org/bot${TELEGRAM_FIXTURE_TOKEN}/getUpdates`),
      ).rejects.toThrow();
      expect(fixture.snapshot().events).toHaveLength(0);
      expect(fixture.snapshot().rejectedRequests).toBe(0);
    } finally {
      restore();
      await fixture.stop();
    }
  });

  test("overlay validates explicit marker and loopback ownership without changing fetch", () => {
    const native = globalThis.fetch;
    expect(() =>
      installTelegramFixtureNetwork("wrong", {
        telegramOrigin: "http://127.0.0.1:3000",
        modelOrigin: "http://127.0.0.1:3000",
      }),
    ).toThrow();
    for (const origin of [
      "https://api.telegram.org",
      "http://localhost:3000",
      "http://127.0.0.1:3000/path",
      "http://user@127.0.0.1:3000",
    ])
      expect(() =>
        installTelegramFixtureNetwork(TELEGRAM_FIXTURE_INSTALL_MARKER, {
          telegramOrigin: origin,
          modelOrigin: "http://127.0.0.1:3000",
        }),
      ).toThrow();
    expect(globalThis.fetch).toBe(native);
  });

  test("native HTTP failures, redirects and abort signals are not synthesized away", async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return new Response("actual fixture failure", {
          status: 307,
          headers: { location: "https://example.invalid/must-not-follow" },
        });
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const restore = installTelegramFixtureNetwork(TELEGRAM_FIXTURE_INSTALL_MARKER, {
      telegramOrigin: origin,
      modelOrigin: origin,
    });
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_FIXTURE_TOKEN}/getUpdates`,
        { method: "POST", body: "{}" },
      );
      expect(response.status).toBe(307);
      expect(await response.text()).toBe("actual fixture failure");
      const controller = new AbortController();
      controller.abort();
      await expect(
        fetch(`https://api.telegram.org/bot${TELEGRAM_FIXTURE_TOKEN}/getUpdates`, {
          method: "POST",
          body: "{}",
          signal: controller.signal,
        }),
      ).rejects.toThrow();
      expect(requests).toBe(1);
    } finally {
      restore();
      await server.stop(true);
    }
  });
});
