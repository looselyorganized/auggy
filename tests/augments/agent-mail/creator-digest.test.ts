import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  AgentMailCreatorDigestCapacityError,
  AgentMailCreatorDigestTargetConflictError,
} from "../../../src/augments/agentMail/creator-digest";
import {
  AGENTMAIL_LEDGER_APPLICATION_ID,
  createAgentMailInboundLedger,
  type AgentMailInboundLedger,
} from "../../../src/augments/agentMail/inbound-ledger";
import {
  agentMailRestEnvelope,
  normalizeAgentMailMessage,
} from "../../../src/augments/agentMail/provider";

const tempDirs: string[] = [];
const inboxId = "support@agentmail.to";
const targetA = "a".repeat(64);
const targetB = "b".repeat(64);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-mail-digest-test-"));
  tempDirs.push(dir);
  return join(dir, "inbound.sqlite");
}

function envelope(messageId: string, timestamp = "2026-07-14T10:20:30.000Z") {
  return agentMailRestEnvelope(
    normalizeAgentMailMessage({
      inbox_id: inboxId,
      thread_id: `thread_${messageId}`,
      message_id: messageId,
      labels: ["received"],
      timestamp,
      from: "private-sender@example.com",
      to: [inboxId],
      subject: "PRIVATE DIGEST SUBJECT",
      text: "PRIVATE DIGEST BODY",
      size: 128,
    }),
  );
}

function processWithAttention(
  ledger: AgentMailInboundLedger,
  messageId: string,
  workerId = `worker_${messageId}`,
) {
  ledger.enqueue(envelope(messageId));
  const claim = ledger.claimNext({ workerId, leaseMs: 10_000 });
  if (!claim) throw new Error("expected inbound claim");
  const attention = ledger.creatorAttention.reserve({
    inboxId,
    messageId,
    allowReopen: false,
  }).record;
  expect(ledger.complete(claim)).toBe(true);
  return attention;
}

describe("AgentMail creator digest", () => {
  test("selects only processed attention or quarantined work in deterministic priority order", () => {
    let batchId = 0;
    const ledger = createAgentMailInboundLedger({
      dbPath: tempDb(),
      now: () => 1_000,
      digestBatchId: () => `batch_${++batchId}`,
      incidentId: () => "incident_priority",
    });

    ledger.enqueue(envelope("pending"));
    ledger.creatorAttention.reserve({ inboxId, messageId: "pending", allowReopen: false });
    expect(
      ledger.claimNext({ workerId: "worker_pending", leaseMs: 10_000 })?.envelope.message.messageId,
    ).toBe("pending");

    processWithAttention(ledger, "open");
    const ambiguous = processWithAttention(ledger, "ambiguous");
    ledger.creatorAttention.transition({
      inboxId,
      messageId: "ambiguous",
      expectedVersion: ambiguous.version,
      state: "ambiguous",
    });

    ledger.enqueue(envelope("quarantined"));
    const claim = ledger.claimNext({ workerId: "worker_quarantine", leaseMs: 10_000 });
    expect(claim?.envelope.message.messageId).toBe("quarantined");
    ledger.quarantine(claim!, "turn-outcome-unknown");

    const batch = ledger.creatorDigest.prepare({
      inboxId,
      deliveryTargetSha256: targetA,
    });
    expect(batch?.items.map((item) => item.messageId)).toEqual([
      "quarantined",
      "ambiguous",
      "open",
    ]);
    expect(batch?.items[0]).toMatchObject({
      attentionVersion: 0,
      incidentId: "incident_priority",
      incidentVersion: 1,
      incidentReasonCode: "turn-outcome-unknown",
    });
    expect(batch?.items.every((item) => item.messageId !== "pending")).toBe(true);
    ledger.close();
  });

  test("reuses a pending immutable batch and fails closed on delivery-target drift", () => {
    let minted = 0;
    const ledger = createAgentMailInboundLedger({
      dbPath: tempDb(),
      now: () => 2_000,
      digestBatchId: () => `batch_target_${++minted}`,
    });
    processWithAttention(ledger, "target");

    const first = ledger.creatorDigest.prepare({
      inboxId,
      deliveryTargetSha256: targetA,
      limit: 20,
    })!;
    expect(
      ledger.creatorDigest.prepare({
        inboxId,
        deliveryTargetSha256: targetA,
        limit: 1,
      }),
    ).toEqual(first);
    expect(minted).toBe(1);
    expect(() =>
      ledger.creatorDigest.prepare({
        inboxId,
        deliveryTargetSha256: targetB,
      }),
    ).toThrow(AgentMailCreatorDigestTargetConflictError);
    expect(ledger.creatorDigest.getPending(inboxId)).toEqual(first);

    ledger.close();
  });

  test("uses generation CAS and exact source versions without a lossy timestamp cursor", () => {
    let minted = 0;
    const dbPath = tempDb();
    const ledger = createAgentMailInboundLedger({
      dbPath,
      now: () => 3_000,
      digestBatchId: () => `batch_cas_${++minted}`,
    });
    const attention = processWithAttention(ledger, "same_ms");
    const first = ledger.creatorDigest.prepare({
      inboxId,
      deliveryTargetSha256: targetA,
    })!;
    expect(ledger.creatorDigest.isCurrent(first.id)).toBe(true);

    expect(
      ledger.creatorDigest.settle({
        batchId: first.id,
        expectedBaseGeneration: first.baseGeneration + 1,
        expectedDeliveryTargetSha256: targetA,
        expectedContentSha256: first.contentSha256,
        disposition: "presented",
        evidence: "creator transport accepted generation one",
      }),
    ).toEqual({ status: "conflict", generation: 0 });
    expect(
      ledger.creatorDigest.settle({
        batchId: first.id,
        expectedBaseGeneration: first.baseGeneration,
        expectedDeliveryTargetSha256: targetB,
        expectedContentSha256: first.contentSha256,
        disposition: "presented",
        evidence: "creator transport accepted generation one",
      }),
    ).toEqual({ status: "conflict", generation: 0 });
    const settled = ledger.creatorDigest.settle({
      batchId: first.id,
      expectedBaseGeneration: first.baseGeneration,
      expectedDeliveryTargetSha256: targetA,
      expectedContentSha256: first.contentSha256,
      disposition: "presented",
      evidence: "creator transport accepted generation one",
    });
    expect(settled).toEqual({ status: "settled", generation: 1 });
    expect(ledger.creatorDigest.isCurrent(first.id)).toBe(false);
    expect(
      ledger.creatorDigest.settle({
        batchId: first.id,
        expectedBaseGeneration: first.baseGeneration,
        expectedDeliveryTargetSha256: targetA,
        expectedContentSha256: first.contentSha256,
        disposition: "presented",
        evidence: "creator transport accepted generation one",
      }),
    ).toEqual({ status: "already_settled", generation: 1 });
    expect(
      ledger.creatorDigest.settle({
        batchId: first.id,
        expectedBaseGeneration: first.baseGeneration,
        expectedDeliveryTargetSha256: targetA,
        expectedContentSha256: first.contentSha256,
        disposition: "dismissed",
        evidence: "creator transport accepted generation one",
      }),
    ).toEqual({ status: "conflict", generation: 1 });
    expect(
      ledger.creatorAttention.transition({
        inboxId,
        messageId: "same_ms",
        expectedVersion: attention.version,
        state: "ambiguous",
      }).record,
    ).toMatchObject({ version: 2, updatedAt: 3_000 });

    const second = ledger.creatorDigest.prepare({
      inboxId,
      deliveryTargetSha256: targetA,
    })!;
    expect(second.baseGeneration).toBe(1);
    expect(second.items[0]).toMatchObject({
      messageId: "same_ms",
      attentionVersion: 2,
      attentionState: "ambiguous",
    });
    expect(second.id).not.toBe(first.id);
    ledger.close();

    const bytes = readFileSync(dbPath);
    expect(bytes.includes(Buffer.from("creator transport accepted generation one"))).toBe(false);
  });

  test("reselects confirmed-no-effect work and suppresses creator-dismissed generations", () => {
    let minted = 0;
    const ledger = createAgentMailInboundLedger({
      dbPath: tempDb(),
      now: () => 4_000,
      digestBatchId: () => `batch_retry_${++minted}`,
    });
    processWithAttention(ledger, "retry");
    const first = ledger.creatorDigest.prepare({
      inboxId,
      deliveryTargetSha256: targetA,
    })!;
    expect(
      ledger.creatorDigest.settle({
        batchId: first.id,
        expectedBaseGeneration: first.baseGeneration,
        expectedDeliveryTargetSha256: targetA,
        expectedContentSha256: first.contentSha256,
        disposition: "confirmed-no-effect",
        evidence: "provider confirmed the notification was not accepted",
      }),
    ).toEqual({ status: "settled", generation: 1 });

    const retry = ledger.creatorDigest.prepare({
      inboxId,
      deliveryTargetSha256: targetA,
    })!;
    expect(retry.items[0]?.messageId).toBe("retry");
    expect(
      ledger.creatorDigest.settle({
        batchId: retry.id,
        expectedBaseGeneration: retry.baseGeneration,
        expectedDeliveryTargetSha256: targetA,
        expectedContentSha256: retry.contentSha256,
        disposition: "dismissed",
        evidence: "creator explicitly dismissed this exact digest generation",
      }),
    ).toEqual({ status: "settled", generation: 2 });
    expect(
      ledger.creatorDigest.prepare({
        inboxId,
        deliveryTargetSha256: targetA,
      }),
    ).toBeNull();
    ledger.close();
  });

  test("persists only metadata snapshots and rejects in-place mutation", () => {
    const dbPath = tempDb();
    const ledger = createAgentMailInboundLedger({
      dbPath,
      now: () => 5_000,
      digestBatchId: () => "batch_private",
    });
    processWithAttention(ledger, "private");
    const batch = ledger.creatorDigest.prepare({
      inboxId,
      deliveryTargetSha256: targetA,
    })!;
    ledger.close();

    const db = new Database(dbPath, { readwrite: true });
    const item = db
      .query<Record<string, unknown>, []>("SELECT * FROM agentmail_creator_digest_items LIMIT 1")
      .get();
    expect(item).toEqual({
      batch_id: "batch_private",
      ordinal: 0,
      inbox_id: inboxId,
      message_id: "private",
      attention_version: 1,
      attention_state: "open",
      review_id: null,
      incident_id: null,
      incident_version: 0,
      incident_reason_code: null,
      source_at: 5_000,
    });
    expect(() =>
      db.run(
        "UPDATE agentmail_creator_digest_batches SET created_at = created_at + 1 WHERE batch_id = 'batch_private'",
      ),
    ).toThrow(/immutable/i);
    expect(batch.deliveryTargetSha256).toBe(targetA);
    db.close();
  });

  test("retains current safety evidence and fails capacity before inserting", () => {
    const ledger = createAgentMailInboundLedger({
      dbPath: tempDb(),
      now: () => 6_000,
      digestBatchId: () => "batch_capacity",
      digestMaxBatches: 1,
      digestMaxItems: 1,
      digestRetentionMs: 0,
    });
    const attention = processWithAttention(ledger, "capacity");
    const first = ledger.creatorDigest.prepare({
      inboxId,
      deliveryTargetSha256: targetA,
    })!;
    ledger.creatorDigest.settle({
      batchId: first.id,
      expectedBaseGeneration: first.baseGeneration,
      expectedDeliveryTargetSha256: targetA,
      expectedContentSha256: first.contentSha256,
      disposition: "presented",
      evidence: "accepted",
    });
    ledger.creatorAttention.transition({
      inboxId,
      messageId: "capacity",
      expectedVersion: attention.version,
      state: "ambiguous",
    });

    expect(() =>
      ledger.creatorDigest.prepare({
        inboxId,
        deliveryTargetSha256: targetA,
      }),
    ).toThrow(AgentMailCreatorDigestCapacityError);
    expect(ledger.creatorDigest.counts()).toEqual({ batches: 1, items: 1, pending: 0 });
    ledger.close();
  });

  test("retains terminal attention while a presented snapshot could collide after ABA", () => {
    let now = 6_500;
    const ledger = createAgentMailInboundLedger({
      dbPath: tempDb(),
      now: () => now,
      attentionRetentionMs: 1,
      digestBatchId: () => "batch_aba",
    });
    const attention = processWithAttention(ledger, "attention-aba");
    const prepared = ledger.creatorDigest.prepare({
      inboxId,
      deliveryTargetSha256: targetA,
    })!;
    ledger.creatorDigest.settle({
      batchId: prepared.id,
      expectedBaseGeneration: prepared.baseGeneration,
      expectedDeliveryTargetSha256: targetA,
      expectedContentSha256: prepared.contentSha256,
      disposition: "presented",
      evidence: "creator saw version one",
    });
    ledger.creatorAttention.transition({
      inboxId,
      messageId: "attention-aba",
      expectedVersion: attention.version,
      state: "failed",
    });

    now += 2;
    expect(ledger.creatorAttention.prune()).toEqual({ deleted: 0 });
    expect(ledger.creatorAttention.get(inboxId, "attention-aba")?.version).toBe(2);
    ledger.close();
  });

  test("rejects a structurally valid batch whose recomputed privacy-safe hash is wrong", () => {
    const dbPath = tempDb();
    const ledger = createAgentMailInboundLedger({ dbPath, now: () => 7_000 });
    processWithAttention(ledger, "corrupt");
    ledger.close();

    const db = new Database(dbPath, { readwrite: true });
    db.run(
      `INSERT INTO agentmail_creator_digest_batches (
         batch_id, inbox_id, base_generation, delivery_target_sha256,
         item_count, content_sha256, created_at
       ) VALUES ('batch_corrupt', '${inboxId}', 0, '${targetA}', 1, '${"c".repeat(64)}', 7000)`,
    );
    db.run(
      `INSERT INTO agentmail_creator_digest_items (
         batch_id, ordinal, inbox_id, message_id, attention_version,
         attention_state, review_id, incident_id, incident_version,
         incident_reason_code, source_at
       ) VALUES (
         'batch_corrupt', 0, '${inboxId}', 'corrupt', 1,
         'open', NULL, NULL, 0, NULL, 7000
       )`,
    );
    db.close();

    expect(() => createAgentMailInboundLedger({ dbPath })).toThrow(/content hash is inconsistent/i);
    const probe = new Database(dbPath, { readonly: true });
    expect(
      probe.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
    ).toBe(4);
    expect(
      probe.query<{ application_id: number }, []>("PRAGMA application_id").get()?.application_id,
    ).toBe(AGENTMAIL_LEDGER_APPLICATION_ID);
    probe.close();
  });

  test("rejects a missing retained watermark generation", () => {
    const dbPath = tempDb();
    let minted = 0;
    const ledger = createAgentMailInboundLedger({
      dbPath,
      now: () => 7_500,
      digestBatchId: () => `batch_gap_${++minted}`,
    });
    processWithAttention(ledger, "gap");
    for (let generation = 1; generation <= 3; generation++) {
      const prepared = ledger.creatorDigest.prepare({
        inboxId,
        deliveryTargetSha256: targetA,
      })!;
      expect(
        ledger.creatorDigest.settle({
          batchId: prepared.id,
          expectedBaseGeneration: prepared.baseGeneration,
          expectedDeliveryTargetSha256: targetA,
          expectedContentSha256: prepared.contentSha256,
          disposition: "confirmed-no-effect",
          evidence: `generation ${generation} had no effect`,
        }),
      ).toMatchObject({ status: "settled", generation });
    }
    ledger.close();

    const db = new Database(dbPath, { readwrite: true });
    db.run("PRAGMA foreign_keys = ON");
    db.run("DELETE FROM agentmail_creator_digest_watermarks WHERE generation = 2");
    db.run("DELETE FROM agentmail_creator_digest_batches WHERE batch_id = 'batch_gap_2'");
    db.close();

    expect(() => createAgentMailInboundLedger({ dbPath })).toThrow(
      /watermark generations are not contiguous/i,
    );
  });

  test("survives restart with the exact pending batch and owner-only SQLite artifacts", () => {
    const dbPath = tempDb();
    let ledger = createAgentMailInboundLedger({
      dbPath,
      now: () => 8_000,
      digestBatchId: () => "batch_restart",
    });
    processWithAttention(ledger, "restart");
    const before = ledger.creatorDigest.prepare({
      inboxId,
      deliveryTargetSha256: targetA,
    });
    ledger.close();

    ledger = createAgentMailInboundLedger({ dbPath, now: () => 9_000 });
    expect(ledger.creatorDigest.getPending(inboxId)).toEqual(before);
    expect(
      ledger.creatorDigest.prepare({
        inboxId,
        deliveryTargetSha256: targetA,
      }),
    ).toEqual(before);
    ledger.close();
    expect(existsSync(dbPath)).toBe(true);
  });

  test("prunes only retired stale generations and keeps the latest watermark anchor", () => {
    let now = 10_000;
    let minted = 0;
    const ledger = createAgentMailInboundLedger({
      dbPath: tempDb(),
      now: () => now,
      digestBatchId: () => `batch_prune_${++minted}`,
      digestRetentionMs: 1,
    });
    const attention = processWithAttention(ledger, "prune");
    const first = ledger.creatorDigest.prepare({
      inboxId,
      deliveryTargetSha256: targetA,
    })!;
    ledger.creatorDigest.settle({
      batchId: first.id,
      expectedBaseGeneration: first.baseGeneration,
      expectedDeliveryTargetSha256: targetA,
      expectedContentSha256: first.contentSha256,
      disposition: "presented",
      evidence: "first presented",
    });
    ledger.creatorAttention.transition({
      inboxId,
      messageId: "prune",
      expectedVersion: attention.version,
      state: "ambiguous",
    });
    const second = ledger.creatorDigest.prepare({
      inboxId,
      deliveryTargetSha256: targetA,
    })!;
    ledger.creatorDigest.settle({
      batchId: second.id,
      expectedBaseGeneration: second.baseGeneration,
      expectedDeliveryTargetSha256: targetA,
      expectedContentSha256: second.contentSha256,
      disposition: "confirmed-no-effect",
      evidence: "second definitely had no effect",
    });
    expect(ledger.creatorDigest.counts()).toEqual({ batches: 2, items: 2, pending: 0 });

    now += 2;
    expect(ledger.creatorDigest.prune()).toEqual({ batches: 1, items: 1 });
    expect(ledger.creatorDigest.get(first.id)).toBeNull();
    expect(ledger.creatorDigest.get(second.id)?.settlement?.generation).toBe(2);
    expect(
      ledger.creatorDigest.prepare({
        inboxId,
        deliveryTargetSha256: targetA,
      })?.items[0],
    ).toMatchObject({ attentionVersion: 2, attentionState: "ambiguous" });
    ledger.close();
  });

  test("retires an interior generation while an older presented snapshot is protected", () => {
    const dbPath = tempDb();
    let now = 10_500;
    let minted = 0;
    let ledger = createAgentMailInboundLedger({
      dbPath,
      now: () => now,
      digestBatchId: () => `batch_prefix_${++minted}`,
      digestRetentionMs: 1,
    });
    processWithAttention(ledger, "prefix-protected");
    const first = ledger.creatorDigest.prepare({
      inboxId,
      deliveryTargetSha256: targetA,
      limit: 1,
    })!;
    ledger.creatorDigest.settle({
      batchId: first.id,
      expectedBaseGeneration: first.baseGeneration,
      expectedDeliveryTargetSha256: targetA,
      expectedContentSha256: first.contentSha256,
      disposition: "presented",
      evidence: "first remains current",
    });

    processWithAttention(ledger, "later-no-effect");
    for (let generation = 2; generation <= 3; generation++) {
      const prepared = ledger.creatorDigest.prepare({
        inboxId,
        deliveryTargetSha256: targetA,
        limit: 1,
      })!;
      ledger.creatorDigest.settle({
        batchId: prepared.id,
        expectedBaseGeneration: prepared.baseGeneration,
        expectedDeliveryTargetSha256: targetA,
        expectedContentSha256: prepared.contentSha256,
        disposition: "confirmed-no-effect",
        evidence: `later generation ${generation}`,
      });
    }

    now += 2;
    expect(ledger.creatorDigest.prune()).toEqual({ batches: 1, items: 1 });
    ledger.close();

    ledger = createAgentMailInboundLedger({ dbPath, now: () => now });
    expect(ledger.creatorDigest.counts()).toEqual({ batches: 2, items: 2, pending: 0 });
    ledger.close();
  });

  test("one long-lived generation cannot pin capacity or reorder same-time retirements", () => {
    const ids = [
      "z_first",
      "a_second",
      "m_third",
      "b_fourth",
      "y_fifth",
      "c_sixth",
      "x_seventh",
      "d_eighth",
    ];
    let minted = 0;
    const ledger = createAgentMailInboundLedger({
      dbPath: tempDb(),
      now: () => 10_750,
      digestBatchId: () => ids[minted++]!,
      digestMaxBatches: 3,
      digestMaxItems: 3,
      digestRetentionMs: 0,
    });
    processWithAttention(ledger, "permanent-presented");
    const first = ledger.creatorDigest.prepare({
      inboxId,
      deliveryTargetSha256: targetA,
      limit: 1,
    })!;
    ledger.creatorDigest.settle({
      batchId: first.id,
      expectedBaseGeneration: first.baseGeneration,
      expectedDeliveryTargetSha256: targetA,
      expectedContentSha256: first.contentSha256,
      disposition: "presented",
      evidence: "first remains current",
    });
    processWithAttention(ledger, "continuing-mail");

    for (let generation = 2; generation <= ids.length; generation++) {
      const prepared = ledger.creatorDigest.prepare({
        inboxId,
        deliveryTargetSha256: targetA,
        limit: 1,
      })!;
      expect(prepared.baseGeneration).toBe(generation - 1);
      ledger.creatorDigest.settle({
        batchId: prepared.id,
        expectedBaseGeneration: prepared.baseGeneration,
        expectedDeliveryTargetSha256: targetA,
        expectedContentSha256: prepared.contentSha256,
        disposition: "confirmed-no-effect",
        evidence: `generation ${generation} had no effect`,
      });
      expect(ledger.creatorDigest.counts().batches).toBeLessThanOrEqual(3);
    }

    expect(ledger.creatorDigest.get(first.id)).not.toBeNull();
    expect(ledger.creatorDigest.get("a_second")).toBeNull();
    expect(ledger.creatorDigest.get("d_eighth")?.settlement?.generation).toBe(8);
    ledger.close();
  });

  test("converges two ledger connections on one pending batch generation", () => {
    const dbPath = tempDb();
    const first = createAgentMailInboundLedger({
      dbPath,
      now: () => 11_000,
      digestBatchId: () => "batch_first_connection",
    });
    processWithAttention(first, "concurrent");
    const second = createAgentMailInboundLedger({
      dbPath,
      now: () => 11_000,
      digestBatchId: () => "batch_second_connection",
    });

    const prepared = first.creatorDigest.prepare({
      inboxId,
      deliveryTargetSha256: targetA,
    });
    expect(
      second.creatorDigest.prepare({
        inboxId,
        deliveryTargetSha256: targetA,
      }),
    ).toEqual(prepared);
    expect(first.creatorDigest.counts()).toEqual({ batches: 1, items: 1, pending: 1 });
    first.close();
    second.close();
  });

  test("enforces the public hard batch limit of 100", () => {
    const ledger = createAgentMailInboundLedger({ dbPath: tempDb() });
    expect(() =>
      ledger.creatorDigest.prepare({
        inboxId,
        deliveryTargetSha256: targetA,
        limit: 101,
      }),
    ).toThrow(/between 1 and 100/i);
    ledger.close();
  });
});
