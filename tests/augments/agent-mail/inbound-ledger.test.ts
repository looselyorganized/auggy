import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  AgentMailLedgerConflictError,
  createAgentMailInboundLedger,
  type AgentMailInboundLedger,
} from "../../../src/augments/agentMail/inbound-ledger";
import {
  agentMailRestEnvelope,
  normalizeAgentMailMessage,
  type AgentMailInboundEnvelope,
} from "../../../src/augments/agentMail/provider";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-mail-ledger-test-"));
  tempDirs.push(dir);
  return join(dir, "inbound.sqlite");
}

function rawMessage(
  messageId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    inbox_id: "support@agentmail.to",
    thread_id: "thread_1",
    message_id: messageId,
    labels: ["received"],
    timestamp: "2026-07-14T10:20:30.000Z",
    from: "customer@example.com",
    to: ["support@agentmail.to"],
    subject: "Need help",
    text: "Can you help?",
    size: 128,
    ...overrides,
  };
}

function restEnvelope(
  messageId: string,
  overrides: Record<string, unknown> = {},
): AgentMailInboundEnvelope {
  return agentMailRestEnvelope(normalizeAgentMailMessage(rawMessage(messageId, overrides)));
}

function liveEnvelope(
  messageId: string,
  overrides: Record<string, unknown> = {},
): AgentMailInboundEnvelope {
  const message = normalizeAgentMailMessage(rawMessage(messageId, overrides));
  return {
    source: "websocket",
    eventType: "message.received",
    providerEventId: `event_${messageId}`,
    message,
  };
}

function ledgerAt(
  dbPath: string,
  clock: { now: number },
  tokenPrefix = "lease",
): AgentMailInboundLedger {
  let token = 0;
  return createAgentMailInboundLedger({
    dbPath,
    now: () => clock.now,
    leaseToken: () => `${tokenPrefix}_${++token}`,
  });
}

describe("AgentMail inbound ledger", () => {
  test("creates sensitive SQLite files with owner-only permissions", () => {
    const dbPath = tempDb();
    const ledger = createAgentMailInboundLedger({ dbPath });
    ledger.enqueue(restEnvelope("message_permissions"));

    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        expect(statSync(`${dbPath}${suffix}`).mode & 0o777).toBe(0o600);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
      }
    }
    ledger.close();
  });

  test("rejects a symlink database path", () => {
    const target = tempDb();
    const link = join(dirname(target), "linked.sqlite");
    symlinkSync(target, link);
    expect(() => createAgentMailInboundLedger({ dbPath: link })).toThrow(/symbolic link/);
  });

  test("rejects symlinked SQLite sidecars before chmod can follow them", () => {
    const dbPath = tempDb();
    const target = join(dirname(dbPath), "outside-journal");
    writeFileSync(target, "outside");
    chmodSync(target, 0o644);
    symlinkSync(target, `${dbPath}-journal`);
    expect(() => createAgentMailInboundLedger({ dbPath })).toThrow(/artifact.*non-symlink/i);
    expect(statSync(target).mode & 0o777).not.toBe(0o600);
  });

  test("rejects dangling SQLite sidecar symlinks before opening the database", () => {
    const dbPath = tempDb();
    symlinkSync(join(dirname(dbPath), "missing-target"), `${dbPath}-wal`);
    expect(() => createAgentMailInboundLedger({ dbPath })).toThrow(/artifact.*non-symlink/i);
  });

  test("refuses a newer schema without rewriting its version", () => {
    const dbPath = tempDb();
    const db = new Database(dbPath, { create: true });
    db.run("CREATE TABLE agentmail_inbound_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.run("INSERT INTO agentmail_inbound_meta (key, value) VALUES ('schema_version', '99')");
    db.close();

    expect(() => createAgentMailInboundLedger({ dbPath })).toThrow(/newer than supported/);
    const probe = new Database(dbPath, { readonly: true });
    const row = probe
      .prepare<{ value: string }, []>(
        "SELECT value FROM agentmail_inbound_meta WHERE key = 'schema_version'",
      )
      .get();
    expect(row?.value).toBe("99");
    probe.close();
  });

  test("deduplicates the same message across REST and live delivery", () => {
    const clock = { now: 1_000 };
    const ledger = ledgerAt(tempDb(), clock);

    expect(ledger.enqueue(restEnvelope("message_1"))).toEqual({
      status: "enqueued",
      state: "pending",
    });
    clock.now++;
    expect(ledger.enqueue(liveEnvelope("message_1"))).toEqual({
      status: "duplicate",
      state: "pending",
    });

    const row = ledger.get("support@agentmail.to", "message_1");
    expect(row?.envelope.source).toBe("websocket");
    expect(row?.envelope.providerEventId).toBe("event_message_1");
    expect(row?.firstSeenAt).toBe(1_000);
    expect(row?.lastSeenAt).toBe(1_001);
    expect(ledger.counts()).toEqual({ pending: 1, processing: 0, processed: 0, discarded: 0 });
    ledger.close();
  });

  test("never reopens a terminal message when a duplicate arrives", () => {
    const clock = { now: 10_000 };
    const ledger = ledgerAt(tempDb(), clock);
    ledger.enqueue(liveEnvelope("message_done"));
    const claim = ledger.claimNext({ workerId: "worker", leaseMs: 1_000 });
    expect(claim).not.toBeNull();
    expect(ledger.complete(claim!)).toBe(true);

    clock.now++;
    expect(ledger.enqueue(restEnvelope("message_done"))).toEqual({
      status: "duplicate",
      state: "processed",
    });
    expect(ledger.get("support@agentmail.to", "message_done")?.envelope).toMatchObject({
      source: "rest",
      providerEventId: undefined,
    });
    expect(ledger.claimNext({ workerId: "worker", leaseMs: 1_000 })).toBeNull();
    expect(ledger.get("support@agentmail.to", "message_done")?.state).toBe("processed");
    ledger.close();
  });

  test("fails closed on message identity and provider-event collisions", () => {
    const ledger = createAgentMailInboundLedger({ dbPath: tempDb() });
    ledger.enqueue(liveEnvelope("message_1"));

    expect(() =>
      ledger.enqueue(
        liveEnvelope("message_1", {
          from: "substituted@example.com",
        }),
      ),
    ).toThrow(AgentMailLedgerConflictError);

    expect(() =>
      ledger.enqueue({
        ...liveEnvelope("message_2"),
        providerEventId: "event_message_1",
      }),
    ).toThrow(/provider event ID was reused/);
    expect(ledger.counts().pending).toBe(1);
    ledger.close();
  });

  test("claims oldest-first and persists completion across restart", () => {
    const dbPath = tempDb();
    const clock = { now: 20_000 };
    let ledger = ledgerAt(dbPath, clock);
    ledger.enqueue(restEnvelope("message_newer", { timestamp: "2026-07-14T10:21:30.000Z" }));
    ledger.enqueue(restEnvelope("message_older", { timestamp: "2026-07-14T10:19:30.000Z" }));

    const claim = ledger.claimNext({ workerId: "worker-a", leaseMs: 5_000 });
    expect(claim?.envelope.message.messageId).toBe("message_older");
    expect(claim?.attemptCount).toBe(1);
    expect(ledger.complete(claim!)).toBe(true);
    expect(ledger.complete(claim!)).toBe(false);
    ledger.close();

    ledger = ledgerAt(dbPath, clock, "restart");
    expect(ledger.get("support@agentmail.to", "message_older")?.state).toBe("processed");
    expect(
      ledger.claimNext({ workerId: "worker-b", leaseMs: 5_000 })?.envelope.message.messageId,
    ).toBe("message_newer");
    ledger.close();
  });

  test("an expired claim is recoverable and its stale token cannot acknowledge new work", () => {
    const clock = { now: 30_000 };
    let token = 0;
    const ledger = createAgentMailInboundLedger({
      dbPath: tempDb(),
      now: () => clock.now,
      leaseToken: () => `token_${++token}`,
    });
    ledger.enqueue(restEnvelope("message_lease"));
    const first = ledger.claimNext({ workerId: "worker-a", leaseMs: 100 })!;

    clock.now = 30_100;
    expect(ledger.renew(first, 100)).toBe(false);
    const second = ledger.claimNext({ workerId: "worker-b", leaseMs: 100 })!;
    expect(second.attemptCount).toBe(2);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(ledger.complete(first)).toBe(false);
    expect(ledger.complete(second)).toBe(true);
    ledger.close();
  });

  test("retry backoff and discard are durable explicit outcomes", () => {
    const dbPath = tempDb();
    const clock = { now: 40_000 };
    let ledger = ledgerAt(dbPath, clock);
    ledger.enqueue(restEnvelope("message_retry"));
    const first = ledger.claimNext({ workerId: "worker", leaseMs: 1_000 })!;
    expect(
      ledger.retry(first, {
        error: "temporary\nengine failure",
        availableAt: 50_000,
      }),
    ).toBe(true);
    expect(ledger.get("support@agentmail.to", "message_retry")?.lastError).toBe(
      "temporary engine failure",
    );
    ledger.close();

    ledger = ledgerAt(dbPath, clock, "retry");
    expect(ledger.claimNext({ workerId: "worker", leaseMs: 1_000 })).toBeNull();
    clock.now = 50_000;
    const second = ledger.claimNext({ workerId: "worker", leaseMs: 1_000 })!;
    expect(second.attemptCount).toBe(2);
    expect(ledger.discard(second, "inbound policy: spam")).toBe(true);
    expect(ledger.get("support@agentmail.to", "message_retry")).toMatchObject({
      state: "discarded",
      discardReason: "inbound policy: spam",
      lastError: undefined,
    });
    ledger.close();
  });

  test("two connections atomically claim different messages", () => {
    const dbPath = tempDb();
    const clock = { now: 60_000 };
    const firstLedger = ledgerAt(dbPath, clock, "first");
    const secondLedger = ledgerAt(dbPath, clock, "second");
    firstLedger.enqueue(restEnvelope("message_a"));
    firstLedger.enqueue(restEnvelope("message_b", { timestamp: "2026-07-14T10:20:31.000Z" }));

    const first = firstLedger.claimNext({ workerId: "worker-a", leaseMs: 1_000 });
    const second = secondLedger.claimNext({ workerId: "worker-b", leaseMs: 1_000 });
    expect(first?.envelope.message.messageId).toBe("message_a");
    expect(second?.envelope.message.messageId).toBe("message_b");
    expect(firstLedger.counts().processing).toBe(2);
    firstLedger.close();
    secondLedger.close();
  });

  test("atomically records a catch-up page and advances an overlapped checkpoint", () => {
    const clock = { now: Date.parse("2026-07-15T00:00:00.000Z") };
    const ledger = createAgentMailInboundLedger({
      dbPath: tempDb(),
      now: () => clock.now,
      initialLookbackMs: 3_600_000,
      checkpointOverlapMs: 60_000,
    });

    expect(ledger.catchUpAfter("support@agentmail.to")).toBe("2026-07-14T23:00:00.000Z");
    const result = ledger.recordCatchUpBatch([
      restEnvelope("message_page_1", { timestamp: "2026-07-14T23:10:00.000Z" }),
      restEnvelope("message_page_2", { timestamp: "2026-07-14T23:20:00.000Z" }),
    ]);
    expect(result).toEqual({
      enqueued: 2,
      duplicates: 0,
      checkpoint: "2026-07-14T23:20:00.000Z",
    });
    expect(ledger.catchUpAfter("support@agentmail.to")).toBe("2026-07-14T23:19:00.000Z");

    expect(
      ledger.recordCatchUpBatch([
        restEnvelope("message_page_1", { timestamp: "2026-07-14T23:10:00.000Z" }),
      ]),
    ).toMatchObject({ enqueued: 0, duplicates: 1 });
    expect(ledger.checkpoint("support@agentmail.to")).toBe("2026-07-14T23:20:00.000Z");
    ledger.close();
  });

  test("rolls back the entire catch-up page and checkpoint on a conflict", () => {
    const ledger = createAgentMailInboundLedger({ dbPath: tempDb() });
    ledger.enqueue(liveEnvelope("message_existing"));

    expect(() =>
      ledger.recordCatchUpBatch([
        restEnvelope("message_would_be_new"),
        restEnvelope("message_existing", { from: "collision@example.com" }),
      ]),
    ).toThrow(AgentMailLedgerConflictError);

    expect(ledger.get("support@agentmail.to", "message_would_be_new")).toBeNull();
    expect(ledger.checkpoint("support@agentmail.to")).toBeUndefined();
    expect(ledger.counts().pending).toBe(1);
    ledger.close();
  });

  test("rejects non-REST catch-up batches without moving the checkpoint", () => {
    const ledger = createAgentMailInboundLedger({ dbPath: tempDb() });
    expect(() => ledger.recordCatchUpBatch([liveEnvelope("message_live")])).toThrow(
      /only contain REST/,
    );
    expect(ledger.counts().pending).toBe(0);
    expect(ledger.checkpoint("support@agentmail.to")).toBeUndefined();
    ledger.close();
  });
});
