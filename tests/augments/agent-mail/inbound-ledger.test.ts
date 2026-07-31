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
  AGENTMAIL_MAX_POLICY_TOMBSTONES_PER_INBOX,
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

function downgradeToV1(dbPath: string, unbranded = false): void {
  const db = new Database(dbPath, { readwrite: true });
  db.run("DROP TABLE agentmail_inbound_quota_rejections");
  db.run("DROP INDEX idx_agentmail_inbound_quota_sender_window");
  db.run("DROP INDEX idx_agentmail_inbound_quota_window");
  db.run("DROP TABLE agentmail_inbound_quota_reservations");
  db.run("DROP TABLE agentmail_creator_digest_retirement_ranges");
  db.run("DROP TABLE agentmail_creator_digest_watermarks");
  db.run("DROP TABLE agentmail_creator_digest_items");
  db.run("DROP TABLE agentmail_creator_digest_batches");
  db.run("DROP TABLE agentmail_creator_attention");
  db.run("DROP TABLE agentmail_inbound_recoveries");
  db.run("DROP TABLE agentmail_inbound_quarantines");
  db.run("UPDATE agentmail_inbound_meta SET value = '1' WHERE key = 'schema_version'");
  db.run(`PRAGMA application_id = ${unbranded ? 0 : AGENTMAIL_LEDGER_APPLICATION_ID}`);
  db.run(`PRAGMA user_version = ${unbranded ? 0 : 1}`);
  db.close();
}

function downgradeToV2(dbPath: string, unbranded = false): void {
  const db = new Database(dbPath, { readwrite: true });
  db.run("DROP TABLE agentmail_inbound_quota_rejections");
  db.run("DROP INDEX idx_agentmail_inbound_quota_sender_window");
  db.run("DROP INDEX idx_agentmail_inbound_quota_window");
  db.run("DROP TABLE agentmail_inbound_quota_reservations");
  db.run("DROP TABLE agentmail_creator_digest_retirement_ranges");
  db.run("DROP TABLE agentmail_creator_digest_watermarks");
  db.run("DROP TABLE agentmail_creator_digest_items");
  db.run("DROP TABLE agentmail_creator_digest_batches");
  db.run("DROP TABLE agentmail_creator_attention");
  db.run("UPDATE agentmail_inbound_meta SET value = '2' WHERE key = 'schema_version'");
  db.run(`PRAGMA application_id = ${unbranded ? 0 : AGENTMAIL_LEDGER_APPLICATION_ID}`);
  db.run(`PRAGMA user_version = ${unbranded ? 0 : 2}`);
  db.close();
}

function downgradeToV3(dbPath: string, unbranded = false): void {
  const db = new Database(dbPath, { readwrite: true });
  db.run("DROP TABLE agentmail_inbound_quota_rejections");
  db.run("DROP INDEX idx_agentmail_inbound_quota_sender_window");
  db.run("DROP INDEX idx_agentmail_inbound_quota_window");
  db.run("DROP TABLE agentmail_inbound_quota_reservations");
  db.run("DROP TABLE agentmail_creator_digest_retirement_ranges");
  db.run("DROP TABLE agentmail_creator_digest_watermarks");
  db.run("DROP TABLE agentmail_creator_digest_items");
  db.run("DROP TABLE agentmail_creator_digest_batches");
  db.run("UPDATE agentmail_inbound_meta SET value = '3' WHERE key = 'schema_version'");
  db.run(`PRAGMA application_id = ${unbranded ? 0 : AGENTMAIL_LEDGER_APPLICATION_ID}`);
  db.run(`PRAGMA user_version = ${unbranded ? 0 : 3}`);
  db.close();
}

function downgradeToV4(dbPath: string, unbranded = false): void {
  const db = new Database(dbPath, { readwrite: true });
  db.run("DROP TABLE agentmail_inbound_quota_rejections");
  db.run("DROP INDEX idx_agentmail_inbound_quota_sender_window");
  db.run("DROP INDEX idx_agentmail_inbound_quota_window");
  db.run("DROP TABLE agentmail_inbound_quota_reservations");
  db.run("UPDATE agentmail_inbound_meta SET value = '4' WHERE key = 'schema_version'");
  db.run(`PRAGMA application_id = ${unbranded ? 0 : AGENTMAIL_LEDGER_APPLICATION_ID}`);
  db.run(`PRAGMA user_version = ${unbranded ? 0 : 4}`);
  db.close();
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

  test("migrates exact branded and unbranded v1 ledgers without losing rows", () => {
    for (const unbranded of [false, true]) {
      const dbPath = tempDb();
      const clock = { now: 9_000 };
      let ledger = createAgentMailInboundLedger({
        dbPath,
        now: () => clock.now,
        leaseToken: () => "legacy_processing_lease",
      });
      ledger.enqueue(restEnvelope("legacy_pending", { timestamp: "2026-07-14T10:20:32.000Z" }));
      ledger.enqueue(restEnvelope("legacy_processed"));
      ledger.enqueue(restEnvelope("legacy_processing", { timestamp: "2026-07-14T10:20:31.000Z" }));
      const processed = ledger.claimNext({ workerId: "worker", leaseMs: 1_000 })!;
      expect(ledger.complete(processed)).toBe(true);
      expect(ledger.claimNext({ workerId: "worker", leaseMs: 1_000 })).not.toBeNull();
      ledger.close();
      downgradeToV1(dbPath, unbranded);

      clock.now++;
      ledger = createAgentMailInboundLedger({
        dbPath,
        now: () => clock.now,
        incidentId: () => `migrated_${unbranded ? "unbranded" : "branded"}`,
      });
      ledger.fenceInterruptedClaims();
      expect(ledger.get("support@agentmail.to", "legacy_processed")?.state).toBe("processed");
      expect(ledger.get("support@agentmail.to", "legacy_pending")?.state).toBe("pending");
      expect(ledger.get("support@agentmail.to", "legacy_processing")?.state).toBe(
        "outcome_unknown",
      );
      expect(ledger.listIncidents()).toHaveLength(1);
      ledger.close();

      const probe = new Database(dbPath, { readonly: true });
      expect(
        probe.query<{ application_id: number }, []>("PRAGMA application_id").get()?.application_id,
      ).toBe(AGENTMAIL_LEDGER_APPLICATION_ID);
      expect(
        probe.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
      ).toBe(AGENTMAIL_LEDGER_SCHEMA_VERSION);
      probe.close();
    }
  });

  test("migrates exact branded and unbranded v3 ledgers without losing attention", () => {
    for (const unbranded of [false, true]) {
      const dbPath = tempDb();
      let ledger = createAgentMailInboundLedger({
        dbPath,
        now: () => 10_000,
        leaseToken: () => "legacy_v3_lease",
      });
      ledger.enqueue(restEnvelope(`legacy_v3_${unbranded}`));
      const claim = ledger.claimNext({ workerId: "worker", leaseMs: 1_000 })!;
      const attention = ledger.creatorAttention.reserve({
        inboxId: "support@agentmail.to",
        messageId: `legacy_v3_${unbranded}`,
        allowReopen: false,
      }).record;
      expect(ledger.complete(claim)).toBe(true);
      ledger.close();
      downgradeToV3(dbPath, unbranded);

      ledger = createAgentMailInboundLedger({ dbPath, now: () => 10_001 });
      expect(ledger.creatorAttention.get("support@agentmail.to", `legacy_v3_${unbranded}`)).toEqual(
        attention,
      );
      expect(ledger.creatorDigest.counts()).toEqual({ batches: 0, items: 0, pending: 0 });
      ledger.close();

      const probe = new Database(dbPath, { readonly: true });
      expect(
        probe.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
      ).toBe(AGENTMAIL_LEDGER_SCHEMA_VERSION);
      expect(
        probe
          .query<{ value: string }, []>(
            "SELECT value FROM agentmail_inbound_meta WHERE key = 'schema_version'",
          )
          .get()?.value,
      ).toBe(String(AGENTMAIL_LEDGER_SCHEMA_VERSION));
      probe.close();
    }
  });

  test("rejects modified v3 schema before adding any digest objects", () => {
    const dbPath = tempDb();
    const ledger = createAgentMailInboundLedger({ dbPath });
    ledger.close();
    downgradeToV3(dbPath);
    const seed = new Database(dbPath, { readwrite: true });
    seed.run("DROP INDEX idx_agentmail_creator_attention_queue");
    seed.run(
      `CREATE INDEX idx_agentmail_creator_attention_queue
         ON agentmail_creator_attention(state, updated_at ASC, inbox_id, message_id)`,
    );
    seed.close();
    const bytes = readFileSync(dbPath);

    expect(() => createAgentMailInboundLedger({ dbPath })).toThrow(/object is incompatible/i);
    expect(readFileSync(dbPath)).toEqual(bytes);
    const probe = new Database(dbPath, { readonly: true });
    expect(
      probe
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM sqlite_schema
            WHERE name LIKE 'agentmail_creator_digest_%'`,
        )
        .get()?.count,
    ).toBe(0);
    expect(
      probe.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
    ).toBe(3);
    probe.close();
  });

  test("rejects an otherwise exact legacy ledger with an unexpected object", () => {
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

    // Build the lookalike directly in SQLite's default DELETE mode. Switching
    // an object that still owns prepared Bun statements out of WAL mode can
    // report SQLITE_BUSY even after its database handle has closed.
    const dbPath = tempDb();
    const legacy = new Database(dbPath, { create: true });
    for (const object of objects.filter((item) => item.type === "table")) {
      legacy.run(object.sql);
    }
    for (const object of objects.filter((item) => item.type === "index")) {
      legacy.run(object.sql);
    }
    legacy.run(
      `INSERT INTO agentmail_inbound_meta (key, value) VALUES ('schema_version', '${AGENTMAIL_LEDGER_SCHEMA_VERSION}')`,
    );
    legacy.run("CREATE TABLE unexpected_owner (value TEXT)");
    legacy.close();
    chmodSync(dbPath, 0o600);
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
    const v1Objects = new Set([
      "agentmail_inbound_meta",
      "agentmail_inbound_messages",
      "idx_agentmail_inbound_claim",
      "idx_agentmail_inbound_thread",
      "agentmail_inbound_checkpoints",
    ]);
    for (const object of objects.filter(
      (item) => item.type === "table" && v1Objects.has(item.name),
    )) {
      lookalike.run(
        object.name === "agentmail_inbound_messages"
          ? object.sql.replace("'rest'", "'REST'")
          : object.sql,
      );
    }
    for (const object of objects.filter(
      (item) => item.type === "index" && v1Objects.has(item.name),
    )) {
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
    ledger.fenceInterruptedClaims();
    expect(ledger.get("support@agentmail.to", "renew_overflow")?.state).toBe("outcome_unknown");
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
    expect(ledger.counts()).toEqual({
      pending: 1,
      processing: 0,
      processed: 0,
      discarded: 0,
      outcomeUnknown: 0,
    });
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

  test("an expired claim is durably fenced and never leased again", () => {
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
    const second = ledger.claimNext({ workerId: "worker-b", leaseMs: 100 });
    expect(second).toBeNull();
    expect(ledger.complete(first)).toBe(false);
    expect(ledger.listIncidents()).toHaveLength(1);
    expect(ledger.listIncidents()[0]?.reasonCode).toBe("processing-lease-expired");
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

  test("pre-model defer returns only the exact live claim without charging its attempt", () => {
    const clock = { now: 52_000 };
    const ledger = ledgerAt(tempDb(), clock);
    ledger.enqueue(restEnvelope("message_deferred"));
    const claim = ledger.claimNext({ workerId: "worker", leaseMs: 1_000 })!;

    expect(
      ledger.defer(claim, {
        reason: "creator-attention-capacity",
      }),
    ).toBe(true);
    expect(ledger.defer(claim, { reason: "stale duplicate" })).toBe(false);
    expect(ledger.get("support@agentmail.to", "message_deferred")).toMatchObject({
      state: "pending",
      attemptCount: 0,
      lastError: "creator-attention-capacity",
    });

    const next = ledger.claimNext({ workerId: "worker-next", leaseMs: 1_000 })!;
    expect(next.attemptCount).toBe(1);
    expect(ledger.complete(next)).toBe(true);
    ledger.close();
  });

  test("persists outcome-unknown quarantine across restart and excludes it from claims", () => {
    const dbPath = tempDb();
    const clock = { now: 55_000 };
    let ledger = createAgentMailInboundLedger({
      dbPath,
      now: () => clock.now,
      leaseToken: () => "lease_unknown",
      incidentId: () => "incident_unknown",
    });
    ledger.enqueue(restEnvelope("message_unknown"));
    const claim = ledger.claimNext({ workerId: "worker", leaseMs: 1_000 })!;
    expect(ledger.quarantine(claim, "turn-outcome-unknown")).toMatchObject({
      id: "incident_unknown",
      version: 1,
      messageId: "message_unknown",
      threadId: "thread_1",
    });
    expect(ledger.counts()).toEqual({
      pending: 0,
      processing: 0,
      processed: 0,
      discarded: 0,
      outcomeUnknown: 1,
    });
    ledger.close();

    ledger = createAgentMailInboundLedger({ dbPath, now: () => clock.now });
    ledger.enqueue(restEnvelope("message_same_thread", { timestamp: "2026-07-14T10:20:31.000Z" }));
    expect(ledger.get("support@agentmail.to", "message_unknown")?.state).toBe("outcome_unknown");
    expect(ledger.claimNext({ workerId: "restart", leaseMs: 1_000 })).toBeNull();
    expect(ledger.listIncidents()).toEqual([
      expect.objectContaining({ id: "incident_unknown", reasonCode: "turn-outcome-unknown" }),
    ]);
    expect(
      ledger.reconcileIncident({
        incidentId: "incident_unknown",
        expectedVersion: 1,
        disposition: "confirmed-handled",
        evidence: "provider confirms original effects completed",
      }),
    ).toMatchObject({ resolved: true });
    expect(
      ledger.claimNext({ workerId: "restart", leaseMs: 1_000 })?.envelope.message.messageId,
    ).toBe("message_same_thread");
    ledger.close();
  });

  test("promotes an interrupted processing claim to outcome unknown on restart", () => {
    const dbPath = tempDb();
    const clock = { now: 56_000 };
    let ledger = createAgentMailInboundLedger({
      dbPath,
      now: () => clock.now,
      leaseToken: () => "lease_interrupted",
    });
    ledger.enqueue(restEnvelope("message_interrupted"));
    expect(ledger.claimNext({ workerId: "worker", leaseMs: 10_000 })).not.toBeNull();
    ledger.close();

    clock.now++;
    ledger = createAgentMailInboundLedger({
      dbPath,
      now: () => clock.now,
      incidentId: () => "incident_restart",
    });
    expect(ledger.listIncidents()).toEqual([]);
    ledger.fenceInterruptedClaims();
    expect(ledger.get("support@agentmail.to", "message_interrupted")?.state).toBe(
      "outcome_unknown",
    );
    expect(ledger.listIncidents()[0]).toMatchObject({
      id: "incident_restart",
      reasonCode: "process-restarted",
    });
    expect(ledger.claimNext({ workerId: "restart", leaseMs: 1_000 })).toBeNull();
    ledger.close();
  });

  test("reconciles incidents once with compare-and-swap and stores only evidence hashes", () => {
    const dbPath = tempDb();
    const clock = { now: 57_000 };
    const sentinel = "RAW-OPERATOR-EVIDENCE-DO-NOT-PERSIST";
    const ledger = createAgentMailInboundLedger({
      dbPath,
      now: () => clock.now,
      leaseToken: () => "lease_recovery",
      incidentId: () => "incident_recovery",
    });
    ledger.enqueue(restEnvelope("message_recovery"));
    const claim = ledger.claimNext({ workerId: "worker", leaseMs: 1_000 })!;
    ledger.quarantine(claim, "turn-outcome-unknown");

    expect(
      ledger.reconcileIncident({
        incidentId: "incident_recovery",
        expectedVersion: 2,
        disposition: "confirmed-handled",
        evidence: sentinel,
      }),
    ).toEqual({ resolved: false });
    expect(
      ledger.reconcileIncident({
        incidentId: "incident_recovery",
        expectedVersion: 1,
        disposition: "confirmed-handled",
        evidence: sentinel,
      }),
    ).toEqual({ resolved: true, threadId: "thread_1", releaseThread: true });
    expect(
      ledger.reconcileIncident({
        incidentId: "incident_recovery",
        expectedVersion: 1,
        disposition: "confirmed-handled",
        evidence: sentinel,
      }),
    ).toEqual({ resolved: false });
    expect(ledger.get("support@agentmail.to", "message_recovery")?.state).toBe("processed");
    ledger.close();

    for (const suffix of ["", "-wal", "-shm"]) {
      const path = `${dbPath}${suffix}`;
      if (existsSync(path)) expect(readFileSync(path).includes(Buffer.from(sentinel))).toBe(false);
    }
  });

  test("confirmed-no-effect recovery returns a quarantined message to pending", () => {
    const clock = { now: 58_000 };
    const ledger = createAgentMailInboundLedger({
      dbPath: tempDb(),
      now: () => clock.now,
      leaseToken: () => "lease_retry",
      incidentId: () => "incident_retry",
    });
    ledger.enqueue(restEnvelope("message_retry_after_recovery"));
    const claim = ledger.claimNext({ workerId: "worker", leaseMs: 1_000 })!;
    ledger.quarantine(claim, "turn-outcome-unknown");
    expect(
      ledger.reconcileIncident({
        incidentId: "incident_retry",
        expectedVersion: 1,
        disposition: "confirmed-no-effect",
        evidence: "provider confirms no mutation was accepted",
      }),
    ).toMatchObject({ resolved: true });
    expect(ledger.get("support@agentmail.to", "message_retry_after_recovery")?.state).toBe(
      "pending",
    );
    expect(ledger.claimNext({ workerId: "worker-2", leaseMs: 1_000 })?.attemptCount).toBe(2);
    ledger.close();
  });

  test("does not claim a second message while its thread has active or ambiguous work", () => {
    const clock = { now: 59_000 };
    let token = 0;
    let incident = 0;
    const ledger = createAgentMailInboundLedger({
      dbPath: tempDb(),
      now: () => clock.now,
      leaseToken: () => `lease_${++token}`,
      incidentId: () => `incident_${++incident}`,
    });
    ledger.enqueue(restEnvelope("message_concurrent_a"));
    ledger.enqueue(restEnvelope("message_concurrent_b", { timestamp: "2026-07-14T10:20:31.000Z" }));
    const first = ledger.claimNext({ workerId: "worker-a", leaseMs: 1_000 })!;
    expect(ledger.claimNext({ workerId: "worker-b", leaseMs: 1_000 })).toBeNull();
    ledger.quarantine(first, "turn-outcome-unknown");
    expect(ledger.claimNext({ workerId: "worker-b", leaseMs: 1_000 })).toBeNull();

    expect(
      ledger.reconcileIncident({
        incidentId: "incident_1",
        expectedVersion: 1,
        disposition: "confirmed-handled",
        evidence: "first attempt confirmed handled",
      }),
    ).toEqual({ resolved: true, threadId: "thread_1", releaseThread: true });
    expect(ledger.listIncidentThreads()).toEqual([]);
    expect(ledger.claimNext({ workerId: "worker-b", leaseMs: 1_000 })).not.toBeNull();
    ledger.close();
  });

  test("two connections atomically claim different messages", () => {
    const dbPath = tempDb();
    const clock = { now: 60_000 };
    const firstLedger = ledgerAt(dbPath, clock, "first");
    const secondLedger = ledgerAt(dbPath, clock, "second");
    firstLedger.enqueue(restEnvelope("message_a"));
    firstLedger.enqueue(
      restEnvelope("message_b", {
        thread_id: "thread_2",
        timestamp: "2026-07-14T10:20:31.000Z",
      }),
    );

    const first = firstLedger.claimNext({ workerId: "worker-a", leaseMs: 1_000 });
    const second = secondLedger.claimNext({ workerId: "worker-b", leaseMs: 1_000 });
    expect(first?.envelope.message.messageId).toBe("message_a");
    expect(second?.envelope.message.messageId).toBe("message_b");
    expect(firstLedger.counts().processing).toBe(2);
    firstLedger.close();
    secondLedger.close();
  });

  test("scopes claims, recovery, incidents, threads, and counts to one inbox", () => {
    const clock = { now: 60_000 };
    const ledger = ledgerAt(tempDb(), clock);
    ledger.enqueue(restEnvelope("support_message"));
    ledger.enqueue(
      restEnvelope("billing_message", {
        inbox_id: "billing@agentmail.to",
        to: ["billing@agentmail.to"],
        thread_id: "billing_thread",
      }),
    );

    const supportClaim = ledger.claimNext({
      workerId: "support-worker",
      leaseMs: 1_000,
      inboxId: "support@agentmail.to",
    });
    expect(supportClaim?.envelope.message.messageId).toBe("support_message");
    expect(ledger.counts("support@agentmail.to").processing).toBe(1);
    expect(ledger.counts("billing@agentmail.to")).toMatchObject({
      pending: 1,
      processing: 0,
      outcomeUnknown: 0,
    });

    const billingClaim = ledger.claimNext({
      workerId: "billing-worker",
      leaseMs: 1_000,
      inboxId: "billing@agentmail.to",
    });
    expect(billingClaim?.envelope.message.messageId).toBe("billing_message");

    const supportIncidents = ledger.fenceInterruptedClaims({
      inboxId: "support@agentmail.to",
    });
    expect(supportIncidents).toHaveLength(1);
    expect(supportIncidents[0]?.inboxId).toBe("support@agentmail.to");
    expect(ledger.listIncidents(50, "billing@agentmail.to")).toEqual([]);
    expect(ledger.listIncidentThreads("support@agentmail.to")).toEqual(["thread_1"]);
    expect(ledger.hasIncidentThread("thread_1", "billing@agentmail.to")).toBe(false);
    expect(ledger.counts("support@agentmail.to")).toMatchObject({
      processing: 0,
      outcomeUnknown: 1,
    });
    expect(ledger.counts("billing@agentmail.to")).toMatchObject({
      processing: 1,
      outcomeUnknown: 0,
    });

    const incident = supportIncidents[0]!;
    expect(
      ledger.reconcileIncident({
        incidentId: incident.id,
        expectedVersion: incident.version,
        disposition: "confirmed-handled",
        evidence: "wrong inbox must not resolve",
        inboxId: "billing@agentmail.to",
      }).resolved,
    ).toBe(false);
    expect(
      ledger.reconcileIncident({
        incidentId: incident.id,
        expectedVersion: incident.version,
        disposition: "confirmed-handled",
        evidence: "confirmed in provider logs",
        inboxId: "support@agentmail.to",
      }).resolved,
    ).toBe(true);
    expect(ledger.complete(billingClaim!)).toBe(true);
    ledger.close();
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

  test("atomically applies per-sender before global quota and reports metadata-only status", () => {
    const dbPath = tempDb();
    const clock = { now: 100_000 };
    const ledger = ledgerAt(dbPath, clock);
    const limits = {
      canonicalSender: "customer@example.com",
      globalMaxPerHour: 3,
      perSenderMaxPerHour: 2,
    };
    const reserve = (
      messageId: string,
      from = limits.canonicalSender,
      overrides: Record<string, unknown> = {},
    ) => {
      ledger.enqueue(
        restEnvelope(messageId, {
          from,
          thread_id: `thread_${messageId}`,
          ...overrides,
        }),
      );
      const claim = ledger.claimNext({ workerId: `worker_${messageId}`, leaseMs: 60_000 })!;
      const decision = ledger.reserveInboundQuota(claim, {
        ...limits,
        canonicalSender: from,
      });
      if (decision.status === "admitted") expect(ledger.complete(claim)).toBe(true);
      clock.now++;
      return decision;
    };

    expect(reserve("quota_a1")).toMatchObject({ status: "admitted", reservation: "created" });
    expect(reserve("quota_a2")).toMatchObject({ status: "admitted", reservation: "created" });
    expect(reserve("quota_b1", "other@example.com")).toMatchObject({ status: "admitted" });
    expect(
      reserve("quota_a3", limits.canonicalSender, {
        subject: "PRIVATE_REJECTION_MARKER",
        text: "PRIVATE_REJECTION_BODY",
        to: ["private-recipient@example.com"],
        labels: ["received", ...Array.from({ length: 500 }, () => "PRIVATE_LABEL_MARKER")],
      }),
    ).toEqual({
      status: "discarded",
      reason: "policy-rate-limit-per-sender",
    });
    expect(reserve("quota_c1", "third@example.com")).toEqual({
      status: "discarded",
      reason: "policy-rate-limit-global",
    });
    expect(ledger.get("support@agentmail.to", "quota_a3")).toMatchObject({
      state: "discarded",
      discardReason: "policy-rate-limit-per-sender",
      envelope: {
        message: {
          from: "policy-rejected@redacted.invalid",
          subject: "",
          text: undefined,
          to: [],
        },
      },
    });
    expect(ledger.inboundQuotaStatus("support@agentmail.to")).toEqual({
      rollingGlobalUsage: 3,
      globalRejections: 1,
      perSenderRejections: 1,
      lastRejectedAt: 100_004,
    });
    ledger.close();

    const probe = new Database(dbPath, { readonly: true });
    const columns = probe
      .query<{ name: string }, []>("PRAGMA table_info(agentmail_inbound_quota_reservations)")
      .all()
      .map((row) => row.name);
    expect(columns).toEqual(["inbox_id", "message_id", "sender_key_sha256", "admitted_at"]);
    const keys = probe
      .query<{ sender_key_sha256: string }, []>(
        "SELECT sender_key_sha256 FROM agentmail_inbound_quota_reservations",
      )
      .all();
    expect(keys).toHaveLength(3);
    expect(keys.every((row) => /^[0-9a-f]{64}$/.test(row.sender_key_sha256))).toBe(true);
    expect(keys.every((row) => !row.sender_key_sha256.includes("example.com"))).toBe(true);
    const rejectedPayload = probe
      .query<{ payload_json: string }, [string]>(
        "SELECT payload_json FROM agentmail_inbound_messages WHERE message_id = ?",
      )
      .get("quota_a3")?.payload_json;
    expect(rejectedPayload).not.toContain("PRIVATE_REJECTION_MARKER");
    expect(rejectedPayload).not.toContain("PRIVATE_REJECTION_BODY");
    expect(rejectedPayload).not.toContain("private-recipient@example.com");
    expect(rejectedPayload).not.toContain("customer@example.com");
    expect(rejectedPayload).not.toContain("PRIVATE_LABEL_MARKER");
    expect(JSON.parse(rejectedPayload ?? "{}").labels).toEqual(["received"]);
    expect(
      probe
        .query<
          {
            global_rejections: number;
            per_sender_rejections: number;
            filter_bytes: number;
          },
          [string]
        >(
          `SELECT global_rejections, per_sender_rejections,
                  length(rejection_filter) AS filter_bytes
             FROM agentmail_inbound_quota_rejections WHERE inbox_id = ?`,
        )
        .get("support@agentmail.to"),
    ).toEqual({ global_rejections: 1, per_sender_rejections: 1, filter_bytes: 262_144 });
    probe.close();

    const reopened = ledgerAt(dbPath, clock, "reopened-quota");
    expect(
      reopened.enqueue(
        restEnvelope("quota_a3", {
          thread_id: "thread_quota_a3",
          subject: "PRIVATE_REJECTION_MARKER",
          text: "PRIVATE_REJECTION_BODY",
        }),
      ),
    ).toEqual({ status: "duplicate", state: "discarded" });
    expect(reopened.get("support@agentmail.to", "quota_a3")?.envelope.message).toMatchObject({
      from: "policy-rejected@redacted.invalid",
      subject: "",
      text: undefined,
    });
    expect(reopened.inboundQuotaStatus("support@agentmail.to").perSenderRejections).toBe(1);
    reopened.close();
  });

  test("bounds all policy tombstones while preserving fail-closed replay authority", () => {
    const clock = { now: 300_000 };
    const dbPath = tempDb();
    let ledger = ledgerAt(dbPath, clock);
    const limits = {
      canonicalSender: "customer@example.com",
      globalMaxPerHour: 1,
      perSenderMaxPerHour: 1,
    };
    ledger.enqueue(restEnvelope("tombstone_admitted", { thread_id: "tombstone_admitted" }));
    const admitted = ledger.claimNext({ workerId: "admitted", leaseMs: 60_000 })!;
    expect(ledger.reserveInboundQuota(admitted, limits).status).toBe("admitted");
    expect(ledger.complete(admitted)).toBe(true);

    const rejectionCount = AGENTMAIL_MAX_POLICY_TOMBSTONES_PER_INBOX + 3;
    const quotaRejectionCount = Math.ceil(rejectionCount / 2);
    for (let index = 0; index < rejectionCount; index++) {
      const messageId = `tombstone_rejected_${String(index).padStart(4, "0")}`;
      ledger.enqueue(
        restEnvelope(messageId, {
          thread_id: messageId,
          subject: `private-${index}`,
          text: `secret-${index}`,
        }),
      );
      const claim = ledger.claimNext({ workerId: `reject-${index}`, leaseMs: 60_000 })!;
      if (index % 2 === 0) {
        expect(ledger.reserveInboundQuota(claim, limits).status).toBe("discarded");
      } else {
        expect(ledger.discardInboundPolicy(claim, "policy-sender-invalid")).toBe(true);
      }
      clock.now++;
    }

    expect(ledger.counts("support@agentmail.to").discarded).toBe(
      AGENTMAIL_MAX_POLICY_TOMBSTONES_PER_INBOX,
    );
    expect(ledger.inboundQuotaStatus("support@agentmail.to").perSenderRejections).toBe(
      quotaRejectionCount,
    );
    expect(ledger.get("support@agentmail.to", "tombstone_rejected_0000")).toBeNull();
    expect(
      ledger.get(
        "support@agentmail.to",
        `tombstone_rejected_${String(rejectionCount - 1).padStart(4, "0")}`,
      ),
    ).toMatchObject({
      state: "discarded",
      envelope: { message: { from: "policy-rejected@redacted.invalid", text: undefined } },
    });
    const countersBeforeReplay = ledger.inboundQuotaStatus("support@agentmail.to");
    ledger.close();
    ledger = ledgerAt(dbPath, clock, "replay-filter-restart");
    clock.now += 3_600_001;
    expect(
      ledger.enqueue(
        restEnvelope("tombstone_rejected_0000", {
          thread_id: "tombstone_rejected_0000",
          subject: "replayed private content",
          text: "must never re-enter",
        }),
      ),
    ).toEqual({ status: "duplicate", state: "discarded" });
    expect(ledger.get("support@agentmail.to", "tombstone_rejected_0000")).toBeNull();
    expect(ledger.inboundQuotaStatus("support@agentmail.to")).toEqual({
      ...countersBeforeReplay,
      rollingGlobalUsage: 0,
    });
    ledger.close();
  });

  test("keeps a unique message reservation across retries, restarts, and recovery", () => {
    const dbPath = tempDb();
    const clock = { now: 200_000 };
    let ledger = createAgentMailInboundLedger({
      dbPath,
      now: () => clock.now,
      leaseToken: () => "quota_initial_lease",
    });
    ledger.enqueue(restEnvelope("quota_retry", { thread_id: "quota_retry_thread" }));
    const initial = ledger.claimNext({ workerId: "initial", leaseMs: 60_000 })!;
    const input = {
      canonicalSender: "customer@example.com",
      globalMaxPerHour: 1,
      perSenderMaxPerHour: 1,
    };
    expect(ledger.reserveInboundQuota(initial, input)).toEqual({
      status: "admitted",
      reservation: "created",
      reservedAt: 200_000,
    });
    expect(ledger.reserveInboundQuota(initial, input)).toMatchObject({
      status: "admitted",
      reservation: "existing",
    });
    expect(ledger.retry(initial, { error: "temporary model failure" })).toBe(true);
    clock.now += 3_600_001;
    ledger.enqueue(
      restEnvelope("quota_cleanup_candidate", {
        from: "other@example.com",
        thread_id: "quota_cleanup_thread",
        timestamp: "2026-07-14T10:20:29.000Z",
      }),
    );
    const cleanup = ledger.claimNext({ workerId: "cleanup", leaseMs: 60_000 })!;
    expect(cleanup.envelope.message.messageId).toBe("quota_cleanup_candidate");
    expect(
      ledger.reserveInboundQuota(cleanup, {
        canonicalSender: "other@example.com",
        globalMaxPerHour: 10,
        perSenderMaxPerHour: 10,
      }).status,
    ).toBe("admitted");
    expect(ledger.complete(cleanup)).toBe(true);
    ledger.close();

    clock.now++;
    ledger = createAgentMailInboundLedger({
      dbPath,
      now: () => clock.now,
      leaseToken: () => "quota_restart_lease",
      incidentId: () => "quota_incident",
    });
    const restarted = ledger.claimNext({ workerId: "restart", leaseMs: 60_000 })!;
    expect(ledger.reserveInboundQuota(restarted, input)).toEqual({
      status: "admitted",
      reservation: "existing",
      reservedAt: 200_000,
    });
    expect(ledger.quarantine(restarted, "turn-outcome-unknown")).not.toBeNull();
    expect(
      ledger.reconcileIncident({
        incidentId: "quota_incident",
        expectedVersion: 1,
        disposition: "confirmed-no-effect",
        evidence: "provider confirms no effect",
      }).resolved,
    ).toBe(true);
    const recovered = ledger.claimNext({ workerId: "recovered", leaseMs: 60_000 })!;
    expect(ledger.reserveInboundQuota(recovered, input)).toMatchObject({
      status: "admitted",
      reservation: "existing",
    });
    expect(ledger.complete(recovered)).toBe(true);
    expect(ledger.inboundQuotaStatus("support@agentmail.to").rollingGlobalUsage).toBe(1);
    ledger.close();
  });

  test("uses an exclusive rolling-hour boundary and counts future reservations fail-closed", () => {
    const clock = { now: 3_600_100 };
    const ledger = ledgerAt(tempDb(), clock);
    const limits = {
      canonicalSender: "customer@example.com",
      globalMaxPerHour: 1,
      perSenderMaxPerHour: 1,
    };
    const claim = (messageId: string) => {
      ledger.enqueue(restEnvelope(messageId, { thread_id: `thread_${messageId}` }));
      return ledger.claimNext({ workerId: `worker_${messageId}`, leaseMs: 60_000 })!;
    };

    const first = claim("window_first");
    expect(ledger.reserveInboundQuota(first, limits).status).toBe("admitted");
    expect(ledger.complete(first)).toBe(true);

    clock.now = 7_200_099;
    expect(ledger.reserveInboundQuota(claim("window_before"), limits)).toMatchObject({
      status: "discarded",
      reason: "policy-rate-limit-per-sender",
    });

    clock.now = 7_200_100;
    const boundary = claim("window_boundary");
    expect(ledger.reserveInboundQuota(boundary, limits)).toEqual({
      status: "admitted",
      reservation: "created",
      reservedAt: 7_200_100,
    });
    expect(ledger.complete(boundary)).toBe(true);

    clock.now = 3_600_100;
    expect(ledger.reserveInboundQuota(claim("window_clock_rollback"), limits)).toMatchObject({
      status: "discarded",
      reason: "policy-rate-limit-per-sender",
    });
    expect(ledger.inboundQuotaStatus("support@agentmail.to").rollingGlobalUsage).toBe(1);
    ledger.close();
  });

  test("serializes quota reservations across connections and isolates inbox counters", () => {
    const dbPath = tempDb();
    const clock = { now: 500_000 };
    const first = ledgerAt(dbPath, clock, "quota_first");
    const second = ledgerAt(dbPath, clock, "quota_second");
    first.enqueue(restEnvelope("concurrent_first", { thread_id: "quota_thread_first" }));
    first.enqueue(restEnvelope("concurrent_second", { thread_id: "quota_thread_second" }));
    first.enqueue(
      restEnvelope("billing_first", {
        inbox_id: "billing@agentmail.to",
        to: ["billing@agentmail.to"],
        thread_id: "quota_thread_billing",
      }),
    );
    const firstClaim = first.claimNext({
      workerId: "quota-first",
      leaseMs: 60_000,
      inboxId: "support@agentmail.to",
    })!;
    const secondClaim = second.claimNext({
      workerId: "quota-second",
      leaseMs: 60_000,
      inboxId: "support@agentmail.to",
    })!;
    const billingClaim = first.claimNext({
      workerId: "quota-billing",
      leaseMs: 60_000,
      inboxId: "billing@agentmail.to",
    })!;
    const limits = {
      canonicalSender: "customer@example.com",
      globalMaxPerHour: 1,
      perSenderMaxPerHour: 1,
    };

    expect(first.reserveInboundQuota(firstClaim, limits).status).toBe("admitted");
    expect(second.reserveInboundQuota(secondClaim, limits)).toMatchObject({
      status: "discarded",
      reason: "policy-rate-limit-per-sender",
    });
    expect(first.reserveInboundQuota(billingClaim, limits).status).toBe("admitted");
    expect(first.inboundQuotaStatus("support@agentmail.to").rollingGlobalUsage).toBe(1);
    expect(first.inboundQuotaStatus("billing@agentmail.to").rollingGlobalUsage).toBe(1);
    first.close();
    second.close();
  });

  test("samples quota admission time only after acquiring the serialization lock", () => {
    const dbPath = tempDb();
    let inspectLock = false;
    let observedWriteLock = false;
    let probe: Database | undefined;
    const ledger = createAgentMailInboundLedger({
      dbPath,
      now: () => {
        if (inspectLock && probe) {
          try {
            probe.run("BEGIN IMMEDIATE");
            probe.run("ROLLBACK");
          } catch {
            observedWriteLock = true;
            if (probe.inTransaction) probe.run("ROLLBACK");
          }
        }
        return 500_000;
      },
      leaseToken: () => "lock-sampling-lease",
    });
    probe = new Database(dbPath, { readwrite: true });
    probe.run("PRAGMA busy_timeout = 0");
    ledger.enqueue(restEnvelope("lock_sampling", { thread_id: "lock_sampling" }));
    const claim = ledger.claimNext({ workerId: "lock-sampling", leaseMs: 60_000 })!;
    inspectLock = true;
    expect(
      ledger.reserveInboundQuota(claim, {
        canonicalSender: "customer@example.com",
        globalMaxPerHour: 1,
        perSenderMaxPerHour: 1,
      }).status,
    ).toBe("admitted");
    expect(observedWriteLock).toBe(true);
    probe.close();
    ledger.close();
  });

  test("conservatively backfills recent quota evidence from every supported legacy schema", () => {
    for (const [name, downgrade] of [
      ["v1", downgradeToV1],
      ["v2", downgradeToV2],
      ["v3", downgradeToV3],
    ] as const) {
      const dbPath = tempDb();
      const clock = { now: 9_999_900 };
      let ledger = ledgerAt(dbPath, clock, `migration_${name}`);
      ledger.enqueue(restEnvelope(`migration_${name}`, { thread_id: `migration_${name}` }));
      expect(
        ledger.complete(ledger.claimNext({ workerId: `worker_${name}`, leaseMs: 60_000 })!),
      ).toBe(true);
      ledger.close();
      downgrade(dbPath);

      clock.now = 10_000_000;
      ledger = ledgerAt(dbPath, clock, `reopened_${name}`);
      expect(ledger.inboundQuotaStatus("support@agentmail.to").rollingGlobalUsage).toBe(1);
      ledger.close();
    }
  });

  test("migrates exact v4 ledgers with conservative recent quota evidence", () => {
    for (const unbranded of [false, true]) {
      const dbPath = tempDb();
      const migratedAt = 10_000_000;
      const clock = { now: migratedAt - 3_600_000 };
      let token = 0;
      let ledger = createAgentMailInboundLedger({
        dbPath,
        now: () => clock.now,
        leaseToken: () => `migration_lease_${++token}`,
      });
      ledger.enqueue(restEnvelope("migration_boundary", { thread_id: "migration_boundary" }));
      expect(ledger.complete(ledger.claimNext({ workerId: "boundary", leaseMs: 60_000 })!)).toBe(
        true,
      );

      clock.now = migratedAt - 100;
      ledger.enqueue(restEnvelope("migration_processed", { thread_id: "migration_processed" }));
      expect(ledger.complete(ledger.claimNext({ workerId: "processed", leaseMs: 60_000 })!)).toBe(
        true,
      );
      ledger.enqueue(
        restEnvelope("migration_legacy_sender", {
          thread_id: "migration_legacy_sender",
          from: "evil@alias@example.com",
        }),
      );
      expect(
        ledger.complete(ledger.claimNext({ workerId: "legacy-sender", leaseMs: 60_000 })!),
      ).toBe(true);
      ledger.enqueue(restEnvelope("migration_processing", { thread_id: "migration_processing" }));
      const processing = ledger.claimNext({ workerId: "processing", leaseMs: 60_000 })!;
      ledger.enqueue(restEnvelope("migration_pending", { thread_id: "migration_pending" }));
      ledger.enqueue(restEnvelope("migration_discarded", { thread_id: "migration_discarded" }));
      expect(
        ledger.discard(
          ledger.claimNext({ workerId: "discarded", leaseMs: 60_000 })!,
          "inbound policy: spam",
        ),
      ).toBe(true);
      ledger.close();
      downgradeToV4(dbPath, unbranded);

      clock.now = migratedAt;
      ledger = createAgentMailInboundLedger({ dbPath, now: () => clock.now });
      expect(ledger.inboundQuotaStatus("support@agentmail.to").rollingGlobalUsage).toBe(3);
      expect(
        ledger.reserveInboundQuota(processing, {
          canonicalSender: "customer@example.com",
          globalMaxPerHour: 3,
          perSenderMaxPerHour: 3,
        }),
      ).toMatchObject({ status: "admitted", reservation: "existing" });
      ledger.close();

      const probe = new Database(dbPath, { readonly: true });
      const ids = probe
        .query<{ message_id: string }, []>(
          "SELECT message_id FROM agentmail_inbound_quota_reservations ORDER BY message_id",
        )
        .all()
        .map((row) => row.message_id);
      expect(ids).toEqual([
        "migration_legacy_sender",
        "migration_processed",
        "migration_processing",
      ]);
      expect(
        probe.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
      ).toBe(AGENTMAIL_LEDGER_SCHEMA_VERSION);
      probe.close();
    }
  });

  test("compacts, bounds, and indexes legacy v4 policy rejections before stamping v5", () => {
    const dbPath = tempDb();
    const clock = { now: 20_000_000 };
    let ledger = ledgerAt(dbPath, clock, "legacy-policy");
    const rejectionCount = AGENTMAIL_MAX_POLICY_TOMBSTONES_PER_INBOX + 3;
    for (let index = 0; index < rejectionCount; index++) {
      const messageId = `legacy_policy_${String(index).padStart(4, "0")}`;
      ledger.enqueue(
        restEnvelope(messageId, {
          thread_id: messageId,
          subject: `PRIVATE_LEGACY_SUBJECT_${index}`,
          text: `PRIVATE_LEGACY_BODY_${index}`,
          from: `legacy-${index}@example.com`,
          labels: ["received", `PRIVATE_LEGACY_LABEL_${index}`],
        }),
      );
      const claim = ledger.claimNext({ workerId: `legacy-${index}`, leaseMs: 60_000 })!;
      expect(ledger.discard(claim, "policy-sender-not-allowed")).toBe(true);
      clock.now++;
    }
    ledger.close();
    downgradeToV4(dbPath);

    clock.now += 10;
    ledger = ledgerAt(dbPath, clock, "migrated-policy");
    expect(ledger.counts("support@agentmail.to").discarded).toBe(
      AGENTMAIL_MAX_POLICY_TOMBSTONES_PER_INBOX,
    );
    expect(ledger.get("support@agentmail.to", "legacy_policy_0000")).toBeNull();
    const newest = ledger.get(
      "support@agentmail.to",
      `legacy_policy_${String(rejectionCount - 1).padStart(4, "0")}`,
    );
    expect(newest).toMatchObject({
      state: "discarded",
      envelope: {
        message: {
          from: "policy-rejected@redacted.invalid",
          subject: "",
          text: undefined,
          labels: ["received"],
        },
      },
    });
    ledger.close();

    const probe = new Database(dbPath, { readonly: true });
    expect(
      probe
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count
             FROM agentmail_inbound_messages
            WHERE payload_json LIKE '%PRIVATE_LEGACY_%'`,
        )
        .get()?.count,
    ).toBe(0);
    expect(
      probe
        .query<{ filter_bytes: number }, [string]>(
          `SELECT length(rejection_filter) AS filter_bytes
             FROM agentmail_inbound_quota_rejections WHERE inbox_id = ?`,
        )
        .get("support@agentmail.to")?.filter_bytes,
    ).toBe(262_144);
    probe.close();

    clock.now += 3_600_001;
    ledger = ledgerAt(dbPath, clock, "replayed-policy");
    expect(
      ledger.enqueue(
        restEnvelope("legacy_policy_0000", {
          thread_id: "legacy_policy_0000",
          subject: "replayed legacy secret",
          text: "must remain rejected",
        }),
      ),
    ).toEqual({ status: "duplicate", state: "discarded" });
    expect(ledger.get("support@agentmail.to", "legacy_policy_0000")).toBeNull();
    expect(ledger.inboundQuotaStatus("support@agentmail.to")).toEqual({
      rollingGlobalUsage: 0,
      globalRejections: 0,
      perSenderRejections: 0,
      lastRejectedAt: undefined,
    });
    ledger.close();
  });

  test("rejects a partially migrated v4 ledger without completing or restamping it", () => {
    const dbPath = tempDb();
    const ledger = createAgentMailInboundLedger({ dbPath });
    ledger.close();
    downgradeToV4(dbPath);
    const partial = new Database(dbPath, { readwrite: true });
    partial.run(
      `CREATE TABLE agentmail_inbound_quota_reservations (
         inbox_id TEXT NOT NULL,
         message_id TEXT NOT NULL,
         sender_key_sha256 TEXT NOT NULL,
         admitted_at INTEGER NOT NULL
       )`,
    );
    partial.close();

    expect(() => createAgentMailInboundLedger({ dbPath })).toThrow(/unexpected objects/i);
    const probe = new Database(dbPath, { readonly: true });
    expect(
      probe.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
    ).toBe(4);
    expect(
      probe
        .query<{ value: string }, []>(
          "SELECT value FROM agentmail_inbound_meta WHERE key = 'schema_version'",
        )
        .get()?.value,
    ).toBe("4");
    expect(
      probe
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name LIKE 'idx_agentmail_inbound_quota_%'",
        )
        .get()?.count,
    ).toBe(0);
    probe.close();
  });

  test("enforces sender syntax and documented quota maxima at the ledger authority", () => {
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:" });
    ledger.enqueue(
      restEnvelope("quota_bad_sender", { from: "not-an-email", thread_id: "bad-sender-thread" }),
    );
    const badSender = ledger.claimNext({ workerId: "bad-sender", leaseMs: 60_000 })!;
    expect(() =>
      ledger.reserveInboundQuota(badSender, {
        canonicalSender: "not-an-email",
        globalMaxPerHour: 10,
        perSenderMaxPerHour: 1,
      }),
    ).toThrow(/well-formed email/i);

    ledger.enqueue(restEnvelope("quota_oversized", { thread_id: "oversized-thread" }));
    const oversized = ledger.claimNext({ workerId: "oversized", leaseMs: 60_000 })!;
    expect(() =>
      ledger.reserveInboundQuota(oversized, {
        canonicalSender: "customer@example.com",
        globalMaxPerHour: 10_001,
        perSenderMaxPerHour: 1,
      }),
    ).toThrow(/globalMaxPerHour.*10000/i);
    ledger.close();
  });

  test("rejects stale claims and corrupted v5 quota evidence", () => {
    const dbPath = tempDb();
    const clock = { now: 600_000 };
    let ledger = ledgerAt(dbPath, clock);
    ledger.enqueue(restEnvelope("quota_stale"));
    const stale = ledger.claimNext({ workerId: "stale", leaseMs: 1 })!;
    clock.now++;
    expect(() =>
      ledger.reserveInboundQuota(stale, {
        canonicalSender: "customer@example.com",
        globalMaxPerHour: 5,
        perSenderMaxPerHour: 5,
      }),
    ).toThrow(/exact live claim/i);
    ledger.close();

    ledger = ledgerAt(dbPath, clock);
    ledger.close();
    const corrupt = new Database(dbPath, { readwrite: true });
    corrupt.run("PRAGMA ignore_check_constraints = ON");
    corrupt.run(
      `INSERT INTO agentmail_inbound_quota_reservations
       (inbox_id, message_id, sender_key_sha256, admitted_at)
       VALUES ('support@agentmail.to', 'quota_stale', 'not-a-digest', 1)`,
    );
    corrupt.close();
    expect(() => createAgentMailInboundLedger({ dbPath })).toThrow(/quota|check constraint/i);
  });
});
