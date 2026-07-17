import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  AGENTMAIL_LEDGER_APPLICATION_ID,
  AGENTMAIL_LEDGER_SCHEMA_VERSION,
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
    expect(() => createAgentMailInboundLedger({ dbPath: link })).toThrow(/symlink/i);
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

  test("stamps and preserves the AgentMail database identity", () => {
    const dbPath = tempDb();
    let ledger = createAgentMailInboundLedger({ dbPath });
    ledger.close();
    ledger = createAgentMailInboundLedger({ dbPath });
    ledger.close();

    const probe = new Database(dbPath, { readonly: true });
    expect(
      probe.query<{ application_id: number }, []>("PRAGMA application_id").get()?.application_id,
    ).toBe(AGENTMAIL_LEDGER_APPLICATION_ID);
    expect(
      probe.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
    ).toBe(AGENTMAIL_LEDGER_SCHEMA_VERSION);
    probe.close();
  });

  test("rejects a database owned by another application without mutating it", () => {
    const dbPath = tempDb();
    const ledger = createAgentMailInboundLedger({ dbPath });
    ledger.close();
    const seed = new Database(dbPath, { readwrite: true });
    seed.run("PRAGMA application_id = 1234567");
    seed.close();
    const bytes = readFileSync(dbPath);
    const hadWal = existsSync(`${dbPath}-wal`);
    const hadShm = existsSync(`${dbPath}-shm`);

    expect(() => createAgentMailInboundLedger({ dbPath })).toThrow(/another application/i);
    expect(readFileSync(dbPath)).toEqual(bytes);
    expect(existsSync(`${dbPath}-wal`)).toBe(hadWal);
    expect(existsSync(`${dbPath}-shm`)).toBe(hadShm);
  });

  test("rejects a newer branded user_version without mutating it", () => {
    const dbPath = tempDb();
    const ledger = createAgentMailInboundLedger({ dbPath });
    ledger.close();
    const seed = new Database(dbPath, { readwrite: true });
    seed.run(`PRAGMA user_version = ${AGENTMAIL_LEDGER_SCHEMA_VERSION + 1}`);
    seed.close();
    const bytes = readFileSync(dbPath);

    expect(() => createAgentMailInboundLedger({ dbPath })).toThrow(/newer than supported/i);
    expect(readFileSync(dbPath)).toEqual(bytes);
  });

  test("rejects an unbranded partial lookalike schema", () => {
    const dbPath = tempDb();
    const seed = new Database(dbPath, { create: true });
    seed.run("CREATE TABLE agentmail_inbound_meta (key TEXT, value TEXT)");
    seed.close();
    chmodSync(dbPath, 0o600);
    const bytes = readFileSync(dbPath);

    expect(() => createAgentMailInboundLedger({ dbPath })).toThrow(/schema/i);
    expect(readFileSync(dbPath)).toEqual(bytes);
  });

  test("adopts an exact unbranded legacy ledger without losing data", () => {
    const dbPath = tempDb();
    let ledger = createAgentMailInboundLedger({ dbPath });
    ledger.enqueue(restEnvelope("legacy_message"));
    ledger.close();
    const legacy = new Database(dbPath, { readwrite: true });
    legacy.run("PRAGMA application_id = 0");
    legacy.run("PRAGMA user_version = 0");
    legacy.close();

    ledger = createAgentMailInboundLedger({ dbPath });
    expect(ledger.get("support@agentmail.to", "legacy_message")?.state).toBe("pending");
    ledger.close();
    const probe = new Database(dbPath, { readonly: true });
    expect(
      probe.query<{ application_id: number }, []>("PRAGMA application_id").get()?.application_id,
    ).toBe(AGENTMAIL_LEDGER_APPLICATION_ID);
    probe.close();
  });

  test("rejects an otherwise exact legacy ledger with an unexpected object", () => {
    const dbPath = tempDb();
    const ledger = createAgentMailInboundLedger({ dbPath });
    ledger.close();
    const legacy = new Database(dbPath, { readwrite: true });
    legacy.run("PRAGMA journal_mode = DELETE");
    legacy.run("PRAGMA application_id = 0");
    legacy.run("PRAGMA user_version = 0");
    legacy.run("CREATE TABLE unexpected_owner (value TEXT)");
    legacy.close();
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    const bytes = readFileSync(dbPath);

    expect(() => createAgentMailInboundLedger({ dbPath })).toThrow(/unexpected objects/i);
    expect(readFileSync(dbPath)).toEqual(bytes);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  test("does not case-fold quoted CHECK literals while admitting legacy schema", () => {
    const templatePath = tempDb();
    const ledger = createAgentMailInboundLedger({ dbPath: templatePath });
    ledger.close();
    const template = new Database(templatePath, { readwrite: true });
    const objects = template
      .query<{ name: string; sql: string; type: string }, []>(
        "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    template.close();

    const dbPath = tempDb();
    const lookalike = new Database(dbPath, { create: true });
    for (const object of objects.filter((item) => item.type === "table")) {
      lookalike.run(
        object.name === "agentmail_inbound_messages"
          ? object.sql.replace("'rest'", "'REST'")
          : object.sql,
      );
    }
    for (const object of objects.filter((item) => item.type === "index")) {
      lookalike.run(object.sql);
    }
    lookalike.run("INSERT INTO agentmail_inbound_meta (key, value) VALUES ('schema_version', '1')");
    lookalike.close();
    chmodSync(dbPath, 0o600);
    const bytes = readFileSync(dbPath);

    expect(() => createAgentMailInboundLedger({ dbPath })).toThrow(/object is incompatible/i);
    expect(readFileSync(dbPath)).toEqual(bytes);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  test("rejects semantically inconsistent stored state without mutating it", () => {
    const dbPath = tempDb();
    const ledger = createAgentMailInboundLedger({ dbPath });
    ledger.enqueue(restEnvelope("invalid_state"));
    ledger.close();
    const seed = new Database(dbPath, { readwrite: true });
    seed.run(
      "UPDATE agentmail_inbound_messages SET state = 'processing', attempt_count = 1 WHERE message_id = 'invalid_state'",
    );
    seed.close();
    const bytes = readFileSync(dbPath);

    expect(() => createAgentMailInboundLedger({ dbPath })).toThrow(/processing state/i);
    expect(readFileSync(dbPath)).toEqual(bytes);
  });

  test("stores the admitted provider event ID so valid writes reopen", () => {
    const dbPath = tempDb();
    let ledger = createAgentMailInboundLedger({ dbPath });
    ledger.enqueue({ ...liveEnvelope("normalized_event"), providerEventId: "event\nid" });
    ledger.close();

    ledger = createAgentMailInboundLedger({ dbPath });
    expect(ledger.get("support@agentmail.to", "normalized_event")?.envelope.providerEventId).toBe(
      "event id",
    );
    ledger.close();
  });

  test("rejects message identity text that would fail restart admission", () => {
    const dbPath = tempDb();
    let ledger = createAgentMailInboundLedger({ dbPath });
    expect(() => ledger.enqueue(restEnvelope("message\nid"))).toThrow(/message_id.*control/i);
    expect(() => ledger.enqueue(restEnvelope("   "))).toThrow(/message_id.*invalid/i);
    expect(ledger.counts().pending).toBe(0);
    ledger.close();

    ledger = createAgentMailInboundLedger({ dbPath });
    expect(ledger.counts().pending).toBe(0);
    ledger.close();
  });

  test("rejects checkpoint text that would fail restart admission", () => {
    const dbPath = tempDb();
    let ledger = createAgentMailInboundLedger({ dbPath });
    expect(() =>
      ledger.recordCatchUpBatch([], {
        inboxId: "support@agentmail.to",
        through: "\n2026-07-14T10:20:30.000Z",
      }),
    ).toThrow(/checkpoint timestamp.*control/i);
    expect(() =>
      ledger.recordCatchUpBatch([], {
        inboxId: "   ",
        through: "2026-07-14T10:20:30.000Z",
      }),
    ).toThrow(/checkpoint inbox_id.*invalid/i);
    ledger.close();

    ledger = createAgentMailInboundLedger({ dbPath });
    expect(ledger.checkpoint("support@agentmail.to")).toBeUndefined();
    ledger.close();
  });

  test("rejects a stored live source without a provider event ID", () => {
    const dbPath = tempDb();
    const ledger = createAgentMailInboundLedger({ dbPath });
    ledger.enqueue(liveEnvelope("missing_event"));
    ledger.close();
    const seed = new Database(dbPath, { readwrite: true });
    seed.run(
      "UPDATE agentmail_inbound_messages SET provider_event_id = NULL WHERE message_id = 'missing_event'",
    );
    seed.close();

    expect(() => createAgentMailInboundLedger({ dbPath })).toThrow(/missing provider_event_id/i);
  });

  test("rejects corrupted processing lease identifiers at startup", () => {
    const dbPath = tempDb();
    const clock = { now: 100 };
    const ledger = ledgerAt(dbPath, clock);
    ledger.enqueue(restEnvelope("bad_lease"));
    ledger.claimNext({ workerId: "worker", leaseMs: 100 });
    ledger.close();
    const seed = new Database(dbPath, { readwrite: true });
    seed.run(
      "UPDATE agentmail_inbound_messages SET lease_owner = 'bad' || char(10) || 'owner' WHERE message_id = 'bad_lease'",
    );
    seed.close();

    expect(() => createAgentMailInboundLedger({ dbPath })).toThrow(/lease_owner.*control/i);
  });

  test("rejects claim lease timestamp overflow before persisting it", () => {
    const dbPath = tempDb();
    const clock = { now: Number.MAX_SAFE_INTEGER };
    let ledger = ledgerAt(dbPath, clock);
    ledger.enqueue(restEnvelope("claim_overflow"));
    expect(() => ledger.claimNext({ workerId: "worker", leaseMs: 1 })).toThrow(/safe timestamp/i);
    expect(ledger.get("support@agentmail.to", "claim_overflow")?.state).toBe("pending");
    ledger.close();

    ledger = ledgerAt(dbPath, clock);
    expect(ledger.get("support@agentmail.to", "claim_overflow")?.state).toBe("pending");
    ledger.close();
  });

  test("rejects renewal lease timestamp overflow before persisting it", () => {
    const dbPath = tempDb();
    const clock = { now: Number.MAX_SAFE_INTEGER - 1 };
    let ledger = ledgerAt(dbPath, clock);
    ledger.enqueue(restEnvelope("renew_overflow"));
    const claim = ledger.claimNext({ workerId: "worker", leaseMs: 1 })!;
    clock.now = Number.MAX_SAFE_INTEGER;
    expect(() => ledger.renew(claim, 1)).toThrow(/safe timestamp/i);
    ledger.close();

    ledger = ledgerAt(dbPath, clock);
    expect(ledger.get("support@agentmail.to", "renew_overflow")?.state).toBe("processing");
    ledger.close();
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
