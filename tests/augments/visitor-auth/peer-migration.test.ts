import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { visitorAuth } from "../../../src/augments/visitorAuth";
import { createSqliteStore } from "../../../src/augments/layeredMemory/storage/sqlite-store";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "va-mig-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function seedLayeredMemoryDb(
  memDbPath: string,
  peerId: string,
  n: number,
  namespace = "ep",
): Promise<void> {
  const store = createSqliteStore({ dbPath: memDbPath, namespace, retentionDays: 90 });
  for (let i = 0; i < n; i++) {
    await store.write({
      label: `${namespace}:${peerId}:${i}`,
      content: `content ${i}`,
      peerId,
      trustLevel: "public",
      createdAt: Date.now(),
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });
  }
  await store.close();
}

function countRowsForPeer(memDbPath: string, peerId: string): number {
  const db = new Database(memDbPath);
  const r = db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE peer_id = ?`).get(peerId) as
    | { c: number }
    | undefined;
  db.close();
  return r?.c ?? 0;
}

describe("anonymous → recognized peer-id migration on verify", () => {
  test("keeps direct API migration disabled when the database path is omitted or null", () => {
    for (const layeredMemoryDbPath of [undefined, null]) {
      expect(() =>
        visitorAuth({
          publicUrl: "http://127.0.0.1:3000",
          dbPath: join(tmp, `va-disabled-${String(layeredMemoryDbPath)}.db`),
          agentMail: { transport: "console" },
          signingKey: "shared-key",
          layeredMemoryDbPath,
        }),
      ).not.toThrow();
    }
  });

  test("requires an explicit namespace for direct shared-database migration", () => {
    expect(() =>
      visitorAuth({
        publicUrl: "https://zip.test",
        dbPath: join(tmp, "va-no-namespace.db"),
        agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
        signingKey: "shared-key",
        layeredMemoryDbPath: join(tmp, "memory.db"),
        _agentMailClient: {} as never,
      }),
    ).toThrow(/layeredMemoryNamespace.*required/i);
  });

  test("rejects an empty configured migration path", () => {
    expect(() =>
      visitorAuth({
        publicUrl: "https://zip.test",
        dbPath: join(tmp, "va-empty-path.db"),
        agentMail: { transport: "console" },
        signingKey: "shared-key",
        layeredMemoryDbPath: "   ",
        layeredMemoryNamespace: "ep",
      }),
    ).toThrow(/layeredMemoryDbPath.*non-empty/i);
  });

  test("migrates rows from anon-<threadId> to vis_<uuid> after verify", async () => {
    const dbPath = join(tmp, "va.db");
    const memPath = join(tmp, "memory.db");
    await seedLayeredMemoryDb(memPath, "anon-th-mig", 5);

    const sendCalls: { text: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "shared-key",
      layeredMemoryDbPath: memPath,
      layeredMemoryNamespace: "ep",
      _agentMailClient: {
        send: async (i: { text: string }) => {
          sendCalls.push({ text: i.text });
          return { status: "sent" as const, messageId: "m", threadId: "t" };
        },
        getInbox: async () => ({ inboxId: "ibx_x", status: "ok" as const }),
      } as never,
    });
    await aug.onBoot?.();
    const peer = {
      id: "anon-th-mig",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    await aug.onTurnStart?.({
      turnId: "t",
      threadId: "th-mig",
      trigger: {
        type: "message",
        turnId: "t",
        timestamp: 0,
        payload: {
          parts: [{ kind: "text", text: "alice@example.com" }],
          sourceAugment: "web",
          peer,
          timestamp: 0,
        },
      },
      peer,
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never);
    await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      { turnId: "t", threadId: "th-mig", peer },
    );
    const verifyUrl = sendCalls[0]!.text.match(/(https:\/\/[^\s]+)/)![1]!;
    const tokenParam = new URL(verifyUrl).searchParams.get("token")!;
    // POST (route index 1) consumes the token and triggers peer-id migration.
    const res = await aug.httpRoutes![1]!.handler(
      new Request(verifyUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(tokenParam)}`,
      }),
      { signal: new AbortController().signal },
    );
    expect(res.status).toBe(200);
    // Rows under the OLD anon peer-id are gone:
    expect(countRowsForPeer(memPath, "anon-th-mig")).toBe(0);
    // Rows under the NEW vis_ peer-id total 5:
    const newVisRows = (() => {
      const db = new Database(memPath);
      const r = db
        .prepare(`SELECT COUNT(*) AS c FROM entries WHERE peer_id LIKE 'vis_%'`)
        .get() as { c: number };
      db.close();
      return r.c;
    })();
    expect(newVisRows).toBe(5);
    await aug.onShutdown?.();
  });

  test("migration changes only the configured namespace in a shared database", async () => {
    const dbPath = join(tmp, "va-shared.db");
    const memPath = join(tmp, "memory-shared.db");
    const ownNamespace = "aug1_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:ep";
    const otherNamespace = "aug1_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:ep";
    await seedLayeredMemoryDb(memPath, "anon-shared", 2, ownNamespace);
    await seedLayeredMemoryDb(memPath, "anon-shared", 3, otherNamespace);

    const sendCalls: { text: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "shared-key",
      layeredMemoryDbPath: memPath,
      layeredMemoryNamespace: ownNamespace,
      _agentMailClient: {
        send: async (input: { text: string }) => {
          sendCalls.push({ text: input.text });
          return { status: "sent" as const, messageId: "m", threadId: "t" };
        },
        getInbox: async () => ({ inboxId: "ibx_x", status: "ok" as const }),
      } as never,
    });
    await aug.onBoot?.();
    const peer = {
      id: "anon-shared",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    await aug.onTurnStart?.({
      turnId: "t-shared",
      threadId: "th-shared",
      trigger: {
        type: "message",
        turnId: "t-shared",
        timestamp: 0,
        payload: {
          parts: [{ kind: "text", text: "shared@example.com" }],
          sourceAugment: "web",
          peer,
          timestamp: 0,
        },
      },
      peer,
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never);
    await aug.tools![0]!.execute(
      { method: "email", email: "shared@example.com" },
      { turnId: "t-shared", threadId: "th-shared", peer },
    );
    const verifyUrl = sendCalls[0]!.text.match(/(https:\/\/[^\s]+)/)![1]!;
    const token = new URL(verifyUrl).searchParams.get("token")!;
    const response = await aug.httpRoutes![1]!.handler(
      new Request(verifyUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(token)}`,
      }),
      { signal: new AbortController().signal },
    );
    expect(response.status).toBe(200);

    const db = new Database(memPath);
    try {
      const ownOld = db
        .prepare<{ count: number }, [string, string]>(
          "SELECT COUNT(*) AS count FROM entries WHERE peer_id = ? AND label LIKE ?",
        )
        .get("anon-shared", `${ownNamespace}:%`)!.count;
      const otherOld = db
        .prepare<{ count: number }, [string, string]>(
          "SELECT COUNT(*) AS count FROM entries WHERE peer_id = ? AND label LIKE ?",
        )
        .get("anon-shared", `${otherNamespace}:%`)!.count;
      expect(ownOld).toBe(0);
      expect(otherOld).toBe(3);
    } finally {
      db.close();
    }
    await aug.onShutdown?.();
  });

  test("skips migration when layeredMemoryDbPath is null", async () => {
    const dbPath = join(tmp, "va2.db");
    const sendCalls: { text: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "shared-key",
      layeredMemoryDbPath: null,
      _agentMailClient: {
        send: async (i: { text: string }) => {
          sendCalls.push({ text: i.text });
          return { status: "sent" as const, messageId: "m", threadId: "t" };
        },
        getInbox: async () => ({ inboxId: "ibx_x", status: "ok" as const }),
      } as never,
    });
    await aug.onBoot?.();
    const peer = {
      id: "anon-skip",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    await aug.onTurnStart?.({
      turnId: "t",
      threadId: "th-skip",
      trigger: {
        type: "message",
        turnId: "t",
        timestamp: 0,
        payload: {
          parts: [{ kind: "text", text: "alice@example.com" }],
          sourceAugment: "web",
          peer,
          timestamp: 0,
        },
      },
      peer,
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never);
    await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      { turnId: "t", threadId: "th-skip", peer },
    );
    const verifyUrl = sendCalls[0]!.text.match(/(https:\/\/[^\s]+)/)![1]!;
    const res = await aug.httpRoutes![0]!.handler(new Request(verifyUrl), {
      signal: new AbortController().signal,
    });
    expect(res.status).toBe(200);
    await aug.onShutdown?.();
  });

  test("logs warning + continues when memory.db is absent", async () => {
    const dbPath = join(tmp, "va3.db");
    const sendCalls: { text: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "shared-key",
      layeredMemoryDbPath: join(tmp, "nonexistent-memory.db"),
      layeredMemoryNamespace: "ep",
      _agentMailClient: {
        send: async (i: { text: string }) => {
          sendCalls.push({ text: i.text });
          return { status: "sent" as const, messageId: "m", threadId: "t" };
        },
        getInbox: async () => ({ inboxId: "ibx_x", status: "ok" as const }),
      } as never,
    });
    await aug.onBoot?.();
    const peer = {
      id: "anon-absent",
      kind: "anonymous" as const,
      trustLevel: "public" as const,
      publicSubstate: "anonymous" as const,
      sourceAugment: "web",
    };
    await aug.onTurnStart?.({
      turnId: "t",
      threadId: "th-absent",
      trigger: {
        type: "message",
        turnId: "t",
        timestamp: 0,
        payload: {
          parts: [{ kind: "text", text: "alice@example.com" }],
          sourceAugment: "web",
          peer,
          timestamp: 0,
        },
      },
      peer,
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never);
    await aug.tools![0]!.execute(
      { method: "email", email: "alice@example.com" },
      { turnId: "t", threadId: "th-absent", peer },
    );
    const verifyUrl = sendCalls[0]!.text.match(/(https:\/\/[^\s]+)/)![1]!;
    const res = await aug.httpRoutes![0]!.handler(new Request(verifyUrl), {
      signal: new AbortController().signal,
    });
    expect(res.status).toBe(200); // verify still succeeds
    await aug.onShutdown?.();
  });
});
