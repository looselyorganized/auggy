import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { visitorAuth } from "../../../src/augments/visitor-auth";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "va-mig-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedLayeredMemoryDb(memDbPath: string, peerId: string, n: number): void {
  const db = new Database(memDbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(
    `CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, content TEXT NOT NULL,
      peer_id TEXT, trust_level TEXT, created_at INTEGER NOT NULL,
      superseded_by TEXT, retention_class TEXT NOT NULL DEFAULT 'operational',
      is_verbatim INTEGER NOT NULL DEFAULT 0,
      provenance_model TEXT, confidence REAL, embedding_model TEXT,
      scope TEXT NOT NULL DEFAULT 'peer', expires_at INTEGER,
      subject TEXT, predicate TEXT, object TEXT, source_turn_id TEXT, origin TEXT
    )`,
  );
  const stmt = db.prepare(
    `INSERT INTO entries (id, label, content, peer_id, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < n; i++) {
    stmt.run(`row-${i}`, `ep:${peerId}:${i}`, `content ${i}`, peerId, Date.now());
  }
  db.close();
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
  test("migrates rows from anon-<threadId> to vis_<uuid> after verify", async () => {
    const dbPath = join(tmp, "va.db");
    const memPath = join(tmp, "memory.db");
    seedLayeredMemoryDb(memPath, "anon-th-mig", 5);

    const sendCalls: { text: string }[] = [];
    const aug = visitorAuth({
      publicUrl: "https://zip.test",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "shared-key",
      layeredMemoryDbPath: memPath,
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
    const res = await aug.httpRoutes![0]!.handler(new Request(verifyUrl), {
      signal: new AbortController().signal,
    });
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
