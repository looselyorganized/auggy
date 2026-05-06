import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { createSqliteStore } from "@/augments/layered-memory/storage/sqlite-store";
import { createSupabaseStore } from "@/augments/layered-memory/storage/supabase-store";
import type { LayeredSupabaseClient } from "@/augments/layered-memory/storage/supabase-store";
import { createMockSupabase } from "@tests/fixtures/mock-supabase";
import { createTempDir } from "@tests/fixtures/temp-dir";
import type { MemoryStore } from "@/augments/layered-memory/storage/types";

describe("writeAutoSavedEntry (sqlite)", () => {
  let store: MemoryStore;
  let cleanupTmp: () => Promise<void>;

  beforeEach(async () => {
    const dir = await createTempDir();
    cleanupTmp = dir.cleanup;
    const dbPath = join(dir.path, "memory.db");
    store = createSqliteStore({ dbPath, retentionDays: 90, namespace: "test" });
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
    await cleanupTmp();
  });

  test("persists structured-fact + origin=agent-derived", async () => {
    await store.writeAutoSavedEntry({
      peerId: "p1",
      label: "test:p1:pref",
      content: "Sam likes lemon tea",
      subject: "peer",
      predicate: "prefers",
      object: "lemon tea",
      confidence: 0.85,
      retentionClass: "operational",
      isVerbatim: false,
      sourceTurnId: "turn-123",
      model: "claude-haiku-4-5",
    });
    const entry = await store.read("test:p1:pref");
    expect(entry).not.toBeNull();
    expect(entry?.origin).toBe("agent-derived");
    expect(entry?.subject).toBe("peer");
    expect(entry?.predicate).toBe("prefers");
    expect(entry?.object).toBe("lemon tea");
    expect(entry?.peerId).toBe("p1");
    expect(entry?.sourceTurnId).toBe("turn-123");
    expect(entry?.isVerbatim).toBe(false);
  });

  test("rejects writes outside namespace prefix", async () => {
    await expect(
      store.writeAutoSavedEntry({
        peerId: "p1",
        label: "wrong:p1:foo",
        content: "x",
        confidence: 1,
        retentionClass: "operational",
        isVerbatim: false,
        sourceTurnId: "t1",
        model: "m",
      }),
    ).rejects.toThrow(/namespace/);
  });

  test("throws when namespace not configured on the store", async () => {
    const dir = await createTempDir();
    const noNsStore = createSqliteStore({
      dbPath: join(dir.path, "nons.db"),
      retentionDays: 90,
    });
    await noNsStore.initialize();
    await expect(
      noNsStore.writeAutoSavedEntry({
        peerId: "p1",
        label: "anything",
        content: "x",
        confidence: 1,
        retentionClass: "operational",
        isVerbatim: false,
        sourceTurnId: "t1",
        model: "m",
      }),
    ).rejects.toThrow(/namespace/);
    await noNsStore.close();
    await dir.cleanup();
  });
});

describe("writeAutoSavedEntry (supabase)", () => {
  test("persists structured-fact + origin=agent-derived", async () => {
    const mock = createMockSupabase() as unknown as LayeredSupabaseClient;
    const store = createSupabaseStore({
      client: mock,
      table: "memory",
      retentionDays: 90,
      namespace: "test",
    });
    await store.initialize();

    await store.writeAutoSavedEntry({
      peerId: "p1",
      label: "test:p1:pref",
      content: "Sam likes lemon tea",
      subject: "peer",
      predicate: "prefers",
      object: "lemon tea",
      confidence: 0.85,
      retentionClass: "operational",
      isVerbatim: false,
      sourceTurnId: "turn-123",
      model: "claude-haiku-4-5",
    });

    const entry = await store.read("test:p1:pref");
    expect(entry).not.toBeNull();
    expect(entry?.origin).toBe("agent-derived");
    expect(entry?.subject).toBe("peer");
    expect(entry?.sourceTurnId).toBe("turn-123");
  });

  test("rejects writes outside namespace prefix", async () => {
    const mock = createMockSupabase() as unknown as LayeredSupabaseClient;
    const store = createSupabaseStore({
      client: mock,
      table: "memory",
      retentionDays: 90,
      namespace: "test",
    });
    await store.initialize();
    await expect(
      store.writeAutoSavedEntry({
        peerId: "p1",
        label: "wrong:p1:foo",
        content: "x",
        confidence: 1,
        retentionClass: "operational",
        isVerbatim: false,
        sourceTurnId: "t1",
        model: "m",
      }),
    ).rejects.toThrow(/namespace/);
  });

  test("throws when namespace not configured on the store", async () => {
    const mock = createMockSupabase() as unknown as LayeredSupabaseClient;
    const noNsStore = createSupabaseStore({
      client: mock,
      table: "memory",
      retentionDays: 90,
    });
    await noNsStore.initialize();
    await expect(
      noNsStore.writeAutoSavedEntry({
        peerId: "p1",
        label: "anything",
        content: "x",
        confidence: 1,
        retentionClass: "operational",
        isVerbatim: false,
        sourceTurnId: "t1",
        model: "m",
      }),
    ).rejects.toThrow(/namespace/);
  });
});
