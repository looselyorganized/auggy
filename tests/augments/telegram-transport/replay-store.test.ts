import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteTelegramReplayStore } from "../../../src/augments/telegramTransport/replay-store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "telegram-replay-"));
  roots.push(root);
  return join(root, "claims.db");
}

describe("SQLite Telegram replay store", () => {
  it("atomically claims one payload and detects duplicate/conflict", () => {
    const store = createSqliteTelegramReplayStore({ dbPath: databasePath() });
    expect(store.claim("bot-1", 10, "a".repeat(64))).toBe("claimed");
    expect(store.claim("bot-1", 10, "a".repeat(64))).toBe("duplicate");
    expect(store.claim("bot-1", 10, "b".repeat(64))).toBe("conflict");
    store.close?.();
  });

  it("persists claims across reopen and scopes update ids per bot", () => {
    const path = databasePath();
    const first = createSqliteTelegramReplayStore({ dbPath: path });
    expect(first.claim("bot-1", 7, "a".repeat(64))).toBe("claimed");
    first.close?.();
    const second = createSqliteTelegramReplayStore({ dbPath: path });
    expect(second.claim("bot-1", 7, "a".repeat(64))).toBe("duplicate");
    expect(second.claim("bot-2", 7, "a".repeat(64))).toBe("claimed");
    second.close?.();
  });

  it("coordinates claims across two live store instances", () => {
    const path = databasePath();
    const first = createSqliteTelegramReplayStore({ dbPath: path });
    const second = createSqliteTelegramReplayStore({ dbPath: path });
    const results = [
      first.claim("shared-bot", 99, "c".repeat(64)),
      second.claim("shared-bot", 99, "c".repeat(64)),
    ];
    expect(results.sort()).toEqual(["claimed", "duplicate"]);
    first.close?.();
    second.close?.();
  });

  it("isolates capacity eviction between bot namespaces", () => {
    const store = createSqliteTelegramReplayStore({
      dbPath: databasePath(),
      maxEntries: 1,
    });
    expect(store.claim("bot-a", 1, "a".repeat(64))).toBe("claimed");
    expect(store.claim("bot-b", 1, "b".repeat(64))).toBe("claimed");
    expect(store.claim("bot-a", 1, "a".repeat(64))).toBe("duplicate");
    expect(store.claim("bot-b", 1, "b".repeat(64))).toBe("duplicate");
    store.close?.();
  });

  it("fails closed for malformed identifiers and hashes", () => {
    const store = createSqliteTelegramReplayStore({ dbPath: databasePath() });
    for (const id of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => store.claim("bot", id, "a".repeat(64))).toThrow();
    }
    expect(() => store.claim("bot", 1, "secret-token")).toThrow();
    store.close?.();
  });
});
