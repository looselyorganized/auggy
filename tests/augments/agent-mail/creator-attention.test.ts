import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  AGENTMAIL_LEDGER_APPLICATION_ID,
  AGENTMAIL_LEDGER_SCHEMA_VERSION,
  createAgentMailInboundLedger,
} from "../../../src/augments/agentMail/inbound-ledger";
import { AgentMailCreatorAttentionCapacityError } from "../../../src/augments/agentMail/creator-attention";
import {
  agentMailRestEnvelope,
  normalizeAgentMailMessage,
} from "../../../src/augments/agentMail/provider";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-mail-attention-test-"));
  tempDirs.push(dir);
  return join(dir, "inbound.sqlite");
}

function envelope(messageId: string, inboxId = "support@agentmail.to") {
  return agentMailRestEnvelope(
    normalizeAgentMailMessage({
      inbox_id: inboxId,
      thread_id: `thread_${messageId}`,
      message_id: messageId,
      labels: ["received"],
      timestamp: "2026-07-30T10:00:00.000Z",
      from: "customer@example.com",
      to: [inboxId],
      subject: "Need help",
      text: "Can you help?",
      size: 128,
    }),
  );
}

describe("AgentMail creator attention", () => {
  test("requires admission and reserves metadata before work can begin", () => {
    const ledger = createAgentMailInboundLedger({ dbPath: tempDb() });

    expect(() =>
      ledger.creatorAttention.reserve({
        inboxId: "support@agentmail.to",
        messageId: "missing",
        allowReopen: false,
      }),
    ).toThrow(/admitted/);

    ledger.enqueue(envelope("message_1"));
    const created = ledger.creatorAttention.reserve({
      inboxId: "support@agentmail.to",
      messageId: "message_1",
      allowReopen: false,
    });
    expect(created).toMatchObject({
      status: "created",
      record: {
        inboxId: "support@agentmail.to",
        messageId: "message_1",
        state: "open",
        version: 1,
      },
    });
    expect(created.record).not.toHaveProperty("preview");
    expect(created.record).not.toHaveProperty("reviewId");
    expect(ledger.creatorAttention.counts()).toMatchObject({ open: 1 });
    ledger.close();
  });

  test("stores metadata only and survives restart", () => {
    const dbPath = tempDb();
    const ledger = createAgentMailInboundLedger({ dbPath });
    ledger.enqueue(envelope("message_metadata"));
    const reserved = ledger.creatorAttention.reserve({
      inboxId: "support@agentmail.to",
      messageId: "message_metadata",
      allowReopen: false,
    });
    ledger.close();

    const probe = new Database(dbPath, { readonly: true });
    const columns = probe
      .query<{ name: string }, []>("PRAGMA table_info(agentmail_creator_attention)")
      .all()
      .map((column) => column.name);
    expect(columns).toEqual([
      "inbox_id",
      "message_id",
      "state",
      "record_version",
      "review_id",
      "created_at",
      "updated_at",
      "terminal_at",
    ]);
    probe.close();

    const restarted = createAgentMailInboundLedger({ dbPath });
    expect(restarted.creatorAttention.get("support@agentmail.to", "message_metadata")).toEqual(
      reserved.record,
    );
    restarted.close();
  });

  test("returns an active duplicate without consuming another slot", () => {
    const clock = { now: 1_000 };
    const ledger = createAgentMailInboundLedger({
      dbPath: tempDb(),
      now: () => clock.now,
      attentionMaxRecords: 1,
    });
    ledger.enqueue(envelope("message_duplicate"));
    const first = ledger.creatorAttention.reserve({
      inboxId: "support@agentmail.to",
      messageId: "message_duplicate",
      allowReopen: false,
    });
    clock.now++;
    const duplicate = ledger.creatorAttention.reserve({
      inboxId: "support@agentmail.to",
      messageId: "message_duplicate",
      allowReopen: false,
    });

    expect(duplicate).toEqual({
      status: "active_duplicate",
      record: first.record,
    });
    expect(ledger.creatorAttention.list({ limit: 10 })).toHaveLength(1);
    ledger.close();
  });

  test("fails capacity reservation before a caller can start side effects", () => {
    const ledger = createAgentMailInboundLedger({
      dbPath: tempDb(),
      attentionMaxRecords: 1,
    });
    for (const messageId of ["message_full", "message_blocked"]) {
      ledger.enqueue(envelope(messageId));
    }
    ledger.creatorAttention.reserve({
      inboxId: "support@agentmail.to",
      messageId: "message_full",
      allowReopen: false,
    });

    let sideEffectStarted = false;
    expect(() => {
      ledger.creatorAttention.reserve({
        inboxId: "support@agentmail.to",
        messageId: "message_blocked",
        allowReopen: false,
      });
      sideEffectStarted = true;
    }).toThrow(AgentMailCreatorAttentionCapacityError);
    expect(() =>
      ledger.creatorAttention.reserve({
        inboxId: "support@agentmail.to",
        messageId: "message_blocked",
        allowReopen: false,
      }),
    ).toThrow(/capacity 1/);
    expect(sideEffectStarted).toBeFalse();
    expect(ledger.creatorAttention.get("support@agentmail.to", "message_blocked")).toBeNull();
    ledger.close();
  });

  test("atomically prunes terminal capacity while reserving the next message", () => {
    const clock = { now: 1_000 };
    const ledger = createAgentMailInboundLedger({
      dbPath: tempDb(),
      now: () => clock.now,
      attentionMaxRecords: 1,
      attentionRetentionMs: 30 * 24 * 60 * 60_000,
    });
    for (const messageId of ["message_terminal", "message_next"]) {
      ledger.enqueue(envelope(messageId));
    }
    const first = ledger.creatorAttention.reserve({
      inboxId: "support@agentmail.to",
      messageId: "message_terminal",
      allowReopen: false,
    }).record;
    ledger.creatorAttention.transition({
      inboxId: first.inboxId,
      messageId: first.messageId,
      expectedVersion: first.version,
      state: "dismissed",
    });

    clock.now++;
    const next = ledger.creatorAttention.reserve({
      inboxId: "support@agentmail.to",
      messageId: "message_next",
      allowReopen: false,
    });
    expect(next.status).toBe("created");
    expect(ledger.creatorAttention.get("support@agentmail.to", "message_terminal")).toBeNull();
    expect(ledger.creatorAttention.list({ limit: 10 })).toHaveLength(1);
    ledger.close();
  });

  test("never prunes quarantined terminal replay evidence under age or pressure", () => {
    const clock = { now: 1_000 };
    const ledger = createAgentMailInboundLedger({
      dbPath: tempDb(),
      now: () => clock.now,
      attentionMaxRecords: 3,
      attentionRetentionMs: 100,
      leaseToken: (() => {
        let sequence = 0;
        return () => `lease_${++sequence}`;
      })(),
      incidentId: (() => {
        let sequence = 0;
        return () => `incident_${++sequence}`;
      })(),
    });
    const inboxId = "support@agentmail.to";

    for (const state of ["sent", "rejected"] as const) {
      const messageId = `message_quarantined_${state}`;
      ledger.enqueue(envelope(messageId));
      const claim = ledger.claimNext({ workerId: "worker", leaseMs: 60_000 })!;
      const open = ledger.creatorAttention.reserve({
        inboxId,
        messageId,
        allowReopen: false,
      }).record;
      const pending = ledger.creatorAttention.transition({
        inboxId,
        messageId,
        expectedVersion: open.version,
        state: "pending_review",
        reviewId: `review_${state}`,
      }).record!;
      ledger.creatorAttention.transition({
        inboxId,
        messageId,
        expectedVersion: pending.version,
        state,
      });
      expect(ledger.quarantine(claim, "test-outcome-unknown")).not.toBeNull();
    }

    ledger.enqueue(envelope("message_safe_pressure"));
    const safePressure = ledger.creatorAttention.reserve({
      inboxId,
      messageId: "message_safe_pressure",
      allowReopen: false,
    }).record;
    ledger.creatorAttention.transition({
      inboxId,
      messageId: safePressure.messageId,
      expectedVersion: safePressure.version,
      state: "dismissed",
    });

    clock.now++;
    ledger.enqueue(envelope("message_safe_age"));
    const safeAge = ledger.creatorAttention.reserve({
      inboxId,
      messageId: "message_safe_age",
      allowReopen: false,
    }).record;
    expect(ledger.creatorAttention.get(inboxId, "message_safe_pressure")).toBeNull();
    ledger.creatorAttention.transition({
      inboxId,
      messageId: safeAge.messageId,
      expectedVersion: safeAge.version,
      state: "dismissed",
    });

    clock.now += 101;
    expect(ledger.creatorAttention.prune()).toEqual({ deleted: 1 });
    expect(ledger.creatorAttention.get(inboxId, "message_safe_age")).toBeNull();
    for (const state of ["sent", "rejected"] as const) {
      expect(ledger.creatorAttention.get(inboxId, `message_quarantined_${state}`)).toMatchObject({
        state,
      });
    }
    ledger.close();
  });

  test("reopens failed or dismissed work only with explicit retry authority", () => {
    const clock = { now: 1_000 };
    const ledger = createAgentMailInboundLedger({
      dbPath: tempDb(),
      now: () => clock.now,
    });

    for (const terminalState of ["failed", "dismissed"] as const) {
      const messageId = `message_${terminalState}`;
      ledger.enqueue(envelope(messageId));
      const opened = ledger.creatorAttention.reserve({
        inboxId: "support@agentmail.to",
        messageId,
        allowReopen: false,
      }).record;
      const pending = ledger.creatorAttention.transition({
        inboxId: opened.inboxId,
        messageId,
        expectedVersion: opened.version,
        state: "pending_review",
        reviewId: `review_${terminalState}`,
      }).record!;
      clock.now++;
      const terminal = ledger.creatorAttention.transition({
        inboxId: pending.inboxId,
        messageId,
        expectedVersion: pending.version,
        state: terminalState,
      }).record!;

      expect(() =>
        ledger.creatorAttention.reserve({
          inboxId: terminal.inboxId,
          messageId,
          allowReopen: false,
        }),
      ).toThrow(/authorized retry/);
      expect(ledger.creatorAttention.get(terminal.inboxId, messageId)).toEqual(terminal);

      clock.now++;
      const reopened = ledger.creatorAttention.reserve({
        inboxId: terminal.inboxId,
        messageId,
        allowReopen: true,
      });
      expect(reopened).toMatchObject({
        status: "reopened",
        record: {
          state: "open",
          version: terminal.version + 1,
        },
      });
      expect(reopened.record).not.toHaveProperty("reviewId");
      expect(reopened.record).not.toHaveProperty("terminalAt");
      expect(ledger.creatorAttention.getByReviewId(`review_${terminalState}`)).toBeNull();
    }
    ledger.close();
  });

  test("never reopens sent or rejected records", () => {
    const ledger = createAgentMailInboundLedger({ dbPath: tempDb() });
    for (const terminalState of ["sent", "rejected"] as const) {
      const messageId = `message_${terminalState}`;
      ledger.enqueue(envelope(messageId));
      const opened = ledger.creatorAttention.reserve({
        inboxId: "support@agentmail.to",
        messageId,
        allowReopen: false,
      }).record;
      const pending = ledger.creatorAttention.transition({
        inboxId: opened.inboxId,
        messageId,
        expectedVersion: opened.version,
        state: "pending_review",
        reviewId: `review_${terminalState}`,
      }).record!;
      ledger.creatorAttention.transition({
        inboxId: pending.inboxId,
        messageId,
        expectedVersion: pending.version,
        state: terminalState,
      });

      expect(() =>
        ledger.creatorAttention.reserve({
          inboxId: pending.inboxId,
          messageId,
          allowReopen: true,
        }),
      ).toThrow(new RegExp(`terminal ${terminalState}`));
    }
    ledger.close();
  });

  test("uses CAS transitions and supports review-ID expiry reconciliation", () => {
    const clock = { now: 1_000 };
    const ledger = createAgentMailInboundLedger({
      dbPath: tempDb(),
      now: () => clock.now,
      attentionRetentionMs: 100,
    });
    ledger.enqueue(envelope("message_expiry"));
    const opened = ledger.creatorAttention.reserve({
      inboxId: "support@agentmail.to",
      messageId: "message_expiry",
      allowReopen: false,
    }).record;
    const pending = ledger.creatorAttention.transition({
      inboxId: opened.inboxId,
      messageId: opened.messageId,
      expectedVersion: opened.version,
      state: "pending_review",
      reviewId: "review_expiry",
    }).record!;

    const stale = ledger.creatorAttention.transitionByReviewId({
      reviewId: "review_expiry",
      expectedVersion: pending.version - 1,
      state: "failed",
    });
    expect(stale).toEqual({ updated: false, record: pending });

    clock.now = 2_000;
    const expired = ledger.creatorAttention.transitionByReviewId({
      reviewId: "review_expiry",
      expectedVersion: pending.version,
      state: "failed",
    });
    expect(expired).toMatchObject({
      updated: true,
      record: {
        state: "failed",
        reviewId: "review_expiry",
        version: pending.version + 1,
        terminalAt: 2_000,
      },
    });
    expect(
      ledger.creatorAttention.transitionByReviewId({
        reviewId: "missing",
        expectedVersion: 1,
        state: "failed",
      }),
    ).toEqual({ updated: false, record: null });
    clock.now = 2_101;
    expect(ledger.creatorAttention.prune()).toEqual({ deleted: 1 });
    expect(ledger.creatorAttention.getByReviewId("review_expiry")).toBeNull();
    ledger.close();
  });

  test("binds each review ID to one message across restart", () => {
    const dbPath = tempDb();
    const ledger = createAgentMailInboundLedger({ dbPath });
    for (const messageId of ["message_review_a", "message_review_b"]) {
      ledger.enqueue(envelope(messageId));
    }
    const first = ledger.creatorAttention.reserve({
      inboxId: "support@agentmail.to",
      messageId: "message_review_a",
      allowReopen: false,
    }).record;
    const pending = ledger.creatorAttention.transition({
      inboxId: first.inboxId,
      messageId: first.messageId,
      expectedVersion: first.version,
      state: "pending_review",
      reviewId: "review_unique",
    }).record!;
    const second = ledger.creatorAttention.reserve({
      inboxId: "support@agentmail.to",
      messageId: "message_review_b",
      allowReopen: false,
    }).record;
    expect(() =>
      ledger.creatorAttention.transition({
        inboxId: second.inboxId,
        messageId: second.messageId,
        expectedVersion: second.version,
        state: "pending_review",
        reviewId: "review_unique",
      }),
    ).toThrow(/already belongs/);
    ledger.close();

    const restarted = createAgentMailInboundLedger({ dbPath });
    expect(restarted.creatorAttention.getByReviewId("review_unique")).toEqual(pending);
    restarted.close();
  });

  test("serializes racing transitions across ledger connections", () => {
    const dbPath = tempDb();
    const first = createAgentMailInboundLedger({ dbPath });
    first.enqueue(envelope("message_race"));
    const record = first.creatorAttention.reserve({
      inboxId: "support@agentmail.to",
      messageId: "message_race",
      allowReopen: false,
    }).record;
    const second = createAgentMailInboundLedger({ dbPath });
    expect(
      second.creatorAttention.reserve({
        inboxId: record.inboxId,
        messageId: record.messageId,
        allowReopen: false,
      }),
    ).toEqual({ status: "active_duplicate", record });

    expect(
      first.creatorAttention.transition({
        inboxId: record.inboxId,
        messageId: record.messageId,
        expectedVersion: record.version,
        state: "dismissed",
      }).updated,
    ).toBeTrue();
    expect(
      second.creatorAttention.transition({
        inboxId: record.inboxId,
        messageId: record.messageId,
        expectedVersion: record.version,
        state: "sent",
      }),
    ).toMatchObject({ updated: false, record: { state: "dismissed", version: 2 } });
    first.close();
    second.close();
  });

  test("queries bounded state and inbox views", () => {
    const ledger = createAgentMailInboundLedger({ dbPath: tempDb() });
    for (const [messageId, inboxId] of [
      ["message_a", "support@agentmail.to"],
      ["message_b", "support@agentmail.to"],
      ["message_c", "billing@agentmail.to"],
    ] as const) {
      ledger.enqueue(envelope(messageId, inboxId));
      ledger.creatorAttention.reserve({ inboxId, messageId, allowReopen: false });
    }
    const second = ledger.creatorAttention.get("support@agentmail.to", "message_b")!;
    ledger.creatorAttention.transition({
      inboxId: second.inboxId,
      messageId: second.messageId,
      expectedVersion: second.version,
      state: "ambiguous",
    });

    expect(
      ledger.creatorAttention.list({
        inboxId: "support@agentmail.to",
        states: ["open"],
        limit: 10,
      }),
    ).toHaveLength(1);
    expect(ledger.creatorAttention.counts("support@agentmail.to")).toMatchObject({
      open: 1,
      ambiguous: 1,
    });
    expect(() => ledger.creatorAttention.list({ limit: 101 })).toThrow(/limit/);
    expect(() => ledger.creatorAttention.list({ states: ["open", "open"] })).toThrow(/duplicates/);
    ledger.close();
  });

  test("prunes expired terminal records while retaining active attention", () => {
    const clock = { now: 1_000 };
    const ledger = createAgentMailInboundLedger({
      dbPath: tempDb(),
      now: () => clock.now,
      attentionMaxRecords: 3,
      attentionRetentionMs: 100,
    });
    for (const messageId of ["message_old", "message_active"]) {
      ledger.enqueue(envelope(messageId));
    }
    const old = ledger.creatorAttention.reserve({
      inboxId: "support@agentmail.to",
      messageId: "message_old",
      allowReopen: false,
    }).record;
    ledger.creatorAttention.transition({
      inboxId: old.inboxId,
      messageId: old.messageId,
      expectedVersion: old.version,
      state: "dismissed",
    });
    ledger.creatorAttention.reserve({
      inboxId: "support@agentmail.to",
      messageId: "message_active",
      allowReopen: false,
    });

    clock.now = 1_101;
    expect(ledger.creatorAttention.prune()).toEqual({ deleted: 1 });
    expect(ledger.creatorAttention.get("support@agentmail.to", "message_old")).toBeNull();
    expect(ledger.creatorAttention.list({ states: ["open"], limit: 10 })).toHaveLength(1);
    ledger.close();
  });

  test("migrates exact branded and unbranded v2 ledgers to metadata-only v3", () => {
    for (const unbranded of [false, true]) {
      const dbPath = tempDb();
      const messageId = `message_v2_${unbranded ? "unbranded" : "branded"}`;
      const original = createAgentMailInboundLedger({ dbPath });
      original.enqueue(envelope(messageId));
      original.close();

      const legacy = new Database(dbPath, { readwrite: true });
      legacy.run("DROP TABLE agentmail_creator_attention");
      legacy.run("UPDATE agentmail_inbound_meta SET value = '2' WHERE key = 'schema_version'");
      legacy.run(`PRAGMA application_id = ${unbranded ? 0 : AGENTMAIL_LEDGER_APPLICATION_ID}`);
      legacy.run(`PRAGMA user_version = ${unbranded ? 0 : 2}`);
      legacy.close();

      const migrated = createAgentMailInboundLedger({ dbPath });
      expect(migrated.get("support@agentmail.to", messageId)).not.toBeNull();
      expect(
        migrated.creatorAttention.reserve({
          inboxId: "support@agentmail.to",
          messageId,
          allowReopen: false,
        }).status,
      ).toBe("created");
      migrated.close();

      const probe = new Database(dbPath, { readonly: true });
      expect(
        probe.query<{ application_id: number }, []>("PRAGMA application_id").get()?.application_id,
      ).toBe(AGENTMAIL_LEDGER_APPLICATION_ID);
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
});
