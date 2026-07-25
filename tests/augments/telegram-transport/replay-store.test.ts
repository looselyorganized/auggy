import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
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

function seedV1Database(path: string): void {
  const db = new Database(path, { create: true });
  db.run(`CREATE TABLE telegram_update_claims (
    namespace TEXT NOT NULL,
    update_id INTEGER NOT NULL,
    payload_hash TEXT NOT NULL,
    claimed_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, update_id)
  )`);
  db.run(`CREATE INDEX idx_telegram_claims_time
     ON telegram_update_claims(claimed_at)`);
  db.run("INSERT INTO telegram_update_claims VALUES (?, ?, ?, ?)", [
    "migrated-bot",
    4,
    "a".repeat(64),
    100,
  ]);
  db.run("PRAGMA application_id = 1413960272");
  db.run("PRAGMA user_version = 1");
  db.close();
  chmodSync(path, 0o600);
}

describe("SQLite Telegram replay store", () => {
  it("atomically quarantines a namespace on payload conflict", () => {
    const store = createSqliteTelegramReplayStore({
      dbPath: databasePath(),
      randomUUID: () => "incident-1",
      now: () => 123,
    });
    expect(store.claim("bot-1", 10, "a".repeat(64))).toBe("claimed");
    expect(store.claim("bot-1", 10, "a".repeat(64))).toBe("duplicate");
    expect(store.claim("bot-1", 10, "b".repeat(64))).toBe("conflict");
    expect(store.claim("bot-1", 11, "c".repeat(64))).toBe("quarantined");
    expect(store.getConflict("bot-1")).toEqual({
      id: "incident-1",
      updateId: 10,
      detectedAt: 123,
    });
    store.close?.();
  });

  it("recovers by discarding only the conflicting payload and retaining the canonical claim", () => {
    const incidentIds = ["incident-recover", "incident-third-payload"];
    const store = createSqliteTelegramReplayStore({
      dbPath: databasePath(),
      randomUUID: () => incidentIds.shift()!,
    });
    expect(store.claim("bot", 20, "a".repeat(64))).toBe("claimed");
    expect(store.claim("bot", 20, "b".repeat(64))).toBe("conflict");
    expect(store.resolveConflict("bot", "wrong")).toBe(false);
    expect(store.resolveConflict("other-bot", "incident-recover")).toBe(false);
    expect(store.resolveConflict("bot", "incident-recover")).toBe(true);
    expect(store.resolveConflict("bot", "incident-recover")).toBe(false);
    expect(store.getConflict("bot")).toBeNull();
    expect(store.claim("bot", 20, "a".repeat(64))).toBe("duplicate");
    expect(store.claim("bot", 20, "b".repeat(64))).toBe("discarded");
    expect(store.claim("bot", 21, "c".repeat(64))).toBe("claimed");
    expect(store.claim("bot", 20, "d".repeat(64))).toBe("conflict");
    expect(store.resolveConflict("bot", "incident-recover")).toBe(false);
    expect(store.getConflict("bot")?.id).toBe("incident-third-payload");
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

  it("persists unresolved quarantine and resolved discard state across reopen", () => {
    const path = databasePath();
    const first = createSqliteTelegramReplayStore({
      dbPath: path,
      randomUUID: () => "incident-persisted",
    });
    expect(first.claim("bot", 30, "a".repeat(64))).toBe("claimed");
    expect(first.claim("bot", 30, "b".repeat(64))).toBe("conflict");
    first.close?.();

    const quarantined = createSqliteTelegramReplayStore({ dbPath: path });
    expect(quarantined.claim("bot", 31, "c".repeat(64))).toBe("quarantined");
    expect(quarantined.getConflict("bot")?.id).toBe("incident-persisted");
    expect(quarantined.resolveConflict("bot", "incident-persisted")).toBe(true);
    quarantined.close?.();

    const resolved = createSqliteTelegramReplayStore({ dbPath: path });
    expect(resolved.getConflict("bot")).toBeNull();
    expect(resolved.claim("bot", 30, "b".repeat(64))).toBe("discarded");
    expect(resolved.claim("bot", 31, "c".repeat(64))).toBe("claimed");
    resolved.close?.();
  });

  it("migrates an exact branded v1 database without losing canonical claims", () => {
    const path = databasePath();
    seedV1Database(path);
    const store = createSqliteTelegramReplayStore({
      dbPath: path,
      randomUUID: () => "incident-after-migration",
      now: () => 100,
    });
    expect(store.claim("migrated-bot", 4, "a".repeat(64))).toBe("duplicate");
    expect(store.claim("migrated-bot", 4, "b".repeat(64))).toBe("conflict");
    expect(store.getConflict("migrated-bot")?.id).toBe("incident-after-migration");
    store.close?.();
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

  it("resolves one conflict exactly once across two live store instances", () => {
    const path = databasePath();
    const first = createSqliteTelegramReplayStore({
      dbPath: path,
      randomUUID: () => "incident-cas",
    });
    const second = createSqliteTelegramReplayStore({ dbPath: path });
    expect(first.claim("shared-bot", 100, "a".repeat(64))).toBe("claimed");
    expect(second.claim("shared-bot", 100, "b".repeat(64))).toBe("conflict");
    const conflictId = first.getConflict("shared-bot")!.id;
    expect([
      first.resolveConflict("shared-bot", conflictId),
      second.resolveConflict("shared-bot", conflictId),
    ]).toEqual([true, false]);
    expect(first.claim("shared-bot", 100, "b".repeat(64))).toBe("discarded");
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

  it("isolates time-based retention between bot namespaces", () => {
    const path = databasePath();
    const longRetention = createSqliteTelegramReplayStore({
      dbPath: path,
      retentionMs: 100_000,
      now: () => 100,
    });
    const shortRetention = createSqliteTelegramReplayStore({
      dbPath: path,
      retentionMs: 10,
      now: () => 10_000,
    });

    expect(longRetention.claim("long-bot", 1, "a".repeat(64))).toBe("claimed");
    expect(shortRetention.claim("short-bot", 1, "b".repeat(64))).toBe("claimed");
    expect(longRetention.claim("long-bot", 1, "a".repeat(64))).toBe("duplicate");

    longRetention.close?.();
    shortRetention.close?.();
  });

  it("fails closed for malformed identifiers and hashes", () => {
    const store = createSqliteTelegramReplayStore({ dbPath: databasePath() });
    for (const id of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => store.claim("bot", id, "a".repeat(64))).toThrow();
    }
    expect(() => store.claim("bot", 1, "secret-token")).toThrow();
    expect(() => store.getConflict("")).toThrow();
    expect(() => store.resolveConflict("bot", "")).toThrow();
    store.close?.();
  });
});
