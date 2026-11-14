import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  assertContainerTelegramReplay,
  assertTelegramContainerFixtures,
  prepareTelegramContainerFixtures,
  telegramContainerControlCommand,
} from "../../scripts/release-smoke/integration-telegram-container";
import {
  telegramFixtureUpdate,
  type TelegramJournalEvent,
} from "../../scripts/release-smoke/integration-fixtures/telegram/protocol-fixture";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const project = () => {
  const directory = mkdtempSync(join(tmpdir(), "auggy-telegram-container-preparation-"));
  directories.push(directory);
  mkdirSync(join(directory, "src"));
  writeFileSync(
    join(directory, "src/index.ts"),
    readFileSync(
      new URL("../../src/scaffold-templates/application/src/index.ts.template", import.meta.url),
    ),
  );
  return directory;
};
const poll = (offset: number | null, updateIds: number[]): TelegramJournalEvent => ({
  kind: "poll",
  offset,
  updateIds,
  timeout: 1,
  json: true,
  runtimeUserAgent: true,
});

describe("polling container fixture preparation - not Docker acceptance", () => {
  test("preserves generated host and records exact copied fixture source hashes", () => {
    const root = project();
    const original = readFileSync(join(root, "src/index.ts"), "utf8");
    const fixture = prepareTelegramContainerFixtures(root);
    expect(fixture.files).toHaveLength(7);
    expect(fixture.copies).toHaveLength(5);
    const network = fixture.copies.find(
      (copy) => copy.target === "src/fixtures/telegram-network.ts",
    )!;
    expect(network.sourceSHA256).toBe(network.targetSHA256);
    const provider = fixture.copies.find(
      (copy) => copy.target === "src/fixtures/telegram-provider.ts",
    )!;
    expect(provider.sourceSHA256).toBe(provider.targetSHA256);
    const changed = readFileSync(join(root, "src/index.ts"), "utf8");
    expect(changed).toContain(original.slice(original.indexOf("  // The managed runner")));
    expect(changed).toContain(
      'async (launch) => {\n  installTelegramFixtureNetwork("auggy-telegram-fixture-network-v1", await startContainerTelegramFixture());',
    );
    expect(() => assertTelegramContainerFixtures(root, fixture.files)).not.toThrow();
    writeFileSync(
      join(root, "src/fixtures/telegram-container-startup.ts"),
      "throw Error('changed')",
    );
    expect(() => assertTelegramContainerFixtures(root, fixture.files)).toThrow("hash changed");
  });

  test("duplicate proof requires delivery followed by a new acknowledgement and zero work", () => {
    expect(() => assertContainerTelegramReplay([poll(2, [])], 1)).toThrow();
    expect(() => assertContainerTelegramReplay([poll(2, []), poll(null, [1])], 1)).toThrow();
    expect(() => assertContainerTelegramReplay([poll(null, [1]), poll(2, [])], 1)).not.toThrow();
    expect(() =>
      assertContainerTelegramReplay(
        [
          poll(null, [1]),
          poll(2, []),
          { kind: "reply", chatId: 101, text: "duplicate", json: true, runtimeUserAgent: true },
        ],
        1,
      ),
    ).toThrow("executed work");
  });

  test("Docker exec reads authority from container environment and uses finite request budgets", () => {
    const command = telegramContainerControlCommand({ operation: "snapshot" }, { kind: "ready" });
    expect(command.slice(0, 5)).toEqual([
      "bun",
      "--no-env-file",
      "--no-install",
      "--config=/dev/null",
      "-e",
    ]);
    expect(command[5]).toContain("process.env.AUGGY_FIXTURE_CONTROL_TOKEN");
    expect(command[5]).toContain("AbortSignal.timeout(2000)");
    expect(command[5]).toContain("Date.now()+15000");
    expect(command[5]).toContain("bytes>2097152");
  });

  test("private container control rejects missing authority and forwards real fixture HTTP", async () => {
    const root = project();
    prepareTelegramContainerFixtures(root);
    const keys = [
      "AUGGY_FIXTURE_CONTROL_TOKEN",
      "AUGGY_FIXTURE_TELEGRAM_ORIGIN",
      "AUGGY_FIXTURE_MODEL_ORIGIN",
    ] as const;
    const previous = keys.map((key) => [key, process.env[key]] as const);
    const token = "b".repeat(64);
    process.env.AUGGY_FIXTURE_CONTROL_TOKEN = token;
    process.env.AUGGY_FIXTURE_TELEGRAM_ORIGIN = "http://127.0.0.1:43141";
    process.env.AUGGY_FIXTURE_MODEL_ORIGIN = "http://127.0.0.1:43141";
    const fixture = await import(
      pathToFileURL(join(root, "src/fixtures/telegram-container-startup.ts")).href
    );
    let started = false;
    try {
      const origins = await fixture.startContainerTelegramFixture();
      started = true;
      expect(origins).toEqual({
        telegramOrigin: "http://127.0.0.1:43141",
        modelOrigin: "http://127.0.0.1:43141",
      });
      const missing = await fetch("http://127.0.0.1:43142/control", {
        method: "POST",
        body: JSON.stringify({ operation: "snapshot" }),
      });
      expect(missing.status).toBe(403);
      const update = telegramFixtureUpdate(1, 101);
      const accepted = await fetch("http://127.0.0.1:43142/control", {
        method: "POST",
        headers: { "x-fixture-control": token },
        body: JSON.stringify({ operation: "enqueue", update }),
      });
      expect(accepted.status).toBe(200);
      const response = await fetch(`${origins.telegramOrigin}/telegram/getUpdates`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "auggy-telegram/0.1" },
        body: JSON.stringify({ timeout: 1 }),
      });
      expect(await response.json()).toEqual({ ok: true, result: [update] });
      const snapshot = await fetch("http://127.0.0.1:43142/control", {
        method: "POST",
        headers: { "x-fixture-control": token },
        body: JSON.stringify({ operation: "snapshot" }),
      });
      const output = await snapshot.text();
      expect(output).not.toContain(token);
      expect(JSON.parse(output).protocol.events[0]).toEqual(poll(null, [1]));
    } finally {
      if (started) await fixture.stopContainerTelegramFixture();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
