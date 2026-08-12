import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTMAIL_ORCHESTRATION_APPLICATION_ID,
  AGENTMAIL_ORCHESTRATION_SCHEMA_VERSION,
  createAgentMailOrchestrationStore,
  hashAgentMailOrchestrationValue,
} from "../../../src/augments/agentMail/store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "auggy-agentmail-store-"));
  roots.push(root);
  chmodSync(root, 0o700);
  return { root, dbPath: join(root, "orchestration.db") };
}

function claimInput(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "message_1",
    threadId: "thread_1",
    eventId: "event_1",
    classification: "received" as const,
    senderHash: hashAgentMailOrchestrationValue("sender@example.com"),
    payloadHash: hashAgentMailOrchestrationValue("message_1:thread_1"),
    receivedAt: 1_000,
    policyVersion: 1,
    ...overrides,
  };
}

describe("AgentMail orchestration store", () => {
  test("brands a fresh exact schema and persists only orchestration state", () => {
    const paths = fixture();
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      clock: () => 2_000,
    });
    expect(store.claimMessage(claimInput())).toEqual({ status: "claimed" });
    store.close();

    const db = new Database(paths.dbPath, { readonly: true });
    expect(
      (db.query("PRAGMA application_id").get() as { application_id: number }).application_id,
    ).toBe(AGENTMAIL_ORCHESTRATION_APPLICATION_ID);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      AGENTMAIL_ORCHESTRATION_SCHEMA_VERSION,
    );
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(agentmail_messages)")
      .all()
      .map((row) => row.name);
    expect(columns).not.toContain("body");
    expect(columns).not.toContain("html");
    expect(columns).not.toContain("api_key");
    db.close();
    expect(readFileSync(paths.dbPath).includes(Buffer.from("sender@example.com"))).toBe(false);
  });

  test("deduplicates exact events and fences message/event conflicts", () => {
    const paths = fixture();
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
    });
    expect(store.claimMessage(claimInput())).toEqual({ status: "claimed" });
    expect(store.claimMessage(claimInput())).toEqual({ status: "duplicate" });
    expect(
      store.claimMessage(
        claimInput({ payloadHash: hashAgentMailOrchestrationValue("changed payload") }),
      ),
    ).toEqual({ status: "conflict" });
    expect(store.claimMessage(claimInput({ messageId: "message_2" }))).toEqual({
      status: "conflict",
    });
    store.close();
  });

  test("claims work atomically, settles exact claims, and recovers interruption", () => {
    const paths = fixture();
    let now = 2_000;
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      clock: () => now,
    });
    store.claimMessage(claimInput());
    expect(store.claimNext()).toMatchObject({ state: "processing", attemptCount: 1 });
    expect(store.claimNext()).toBeUndefined();
    expect(store.recoverInterrupted(1_999)).toBe(0);
    now = 3_000;
    expect(store.recoverInterrupted(2_000)).toBe(1);
    expect(store.claimNext()).toMatchObject({ state: "processing", attemptCount: 2 });
    store.settleMessage("message_1", "quarantined", "provider_contract_invalid");
    expect(store.getMessage("message_1")?.state).toBe("quarantined");
    expect(() => store.settleMessage("message_1", "completed")).toThrow(/not actively claimed/);
    store.close();
  });

  test("advances recovery checkpoints only after durable claim and never backwards", () => {
    const paths = fixture();
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
    });
    expect(() => store.advanceCheckpoint(1_000, "unknown")).toThrow(/durably claimed/);
    store.claimMessage(claimInput());
    store.advanceCheckpoint(1_000, "message_1");
    store.advanceCheckpoint(500, "message_1");
    expect(store.getCheckpoint()).toEqual({ timestamp: 1_000, messageId: "message_1" });
    store.close();
  });

  test("binds one provider draft to one source message and fences stale approval", () => {
    const paths = fixture();
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      sendKey: () => "send-message-1",
    });
    store.claimMessage(claimInput());
    expect(
      store.recordDraft({
        sourceMessageId: "message_1",
        threadId: "thread_1",
        draftId: "draft_1",
        clientId: "reply-message-1",
        providerUpdatedAt: 1_500,
      }),
    ).toEqual({ status: "recorded" });
    expect(
      store.recordDraft({
        sourceMessageId: "message_1",
        threadId: "thread_1",
        draftId: "draft_1",
        clientId: "reply-message-1",
        providerUpdatedAt: 1_500,
      }),
    ).toEqual({ status: "duplicate" });
    expect(() =>
      store.approveDraft({
        sourceMessageId: "message_1",
        approvalEvidence: "creator approved in console",
        expectedUpdatedAt: 1_499,
      }),
    ).toThrow(/draft changed/);
    store.approveDraft({
      sourceMessageId: "message_1",
      approvalEvidence: "creator approved in console",
      expectedUpdatedAt: 1_500,
    });
    expect(store.reserveDraftSend("message_1")).toEqual({
      status: "reserved",
      sendKey: "send-message-1",
    });
    expect(store.reserveDraftSend("message_1")).toMatchObject({
      status: "replay",
      draft: { state: "sending", sendKey: "send-message-1" },
    });
    store.settleDraftSend("message_1", { status: "sent", messageId: "sent_1" });
    expect(store.getDraftByMessage("message_1")).toMatchObject({
      state: "sent",
      sentMessageId: "sent_1",
      sendKey: "send-message-1",
    });
    store.close();
  });

  test("deduplicates delivery events and rejects changed reuse", () => {
    const paths = fixture();
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
    });
    const event = {
      eventId: "delivery_1",
      eventType: "message.delivered",
      messageId: "sent_1",
      payloadHash: hashAgentMailOrchestrationValue("delivered:sent_1"),
      observedAt: 2_000,
    };
    expect(store.recordProviderEvent(event)).toBe("recorded");
    expect(store.recordProviderEvent(event)).toBe("duplicate");
    expect(
      store.recordProviderEvent({
        ...event,
        payloadHash: hashAgentMailOrchestrationValue("changed"),
      }),
    ).toBe("conflict");
    store.close();
  });

  test("rejects an unrelated or obsolete SQLite identity instead of migrating it", () => {
    const paths = fixture();
    const unrelated = new Database(paths.dbPath, { create: true });
    unrelated.run("PRAGMA application_id = 0x414d494c");
    unrelated.run("PRAGMA user_version = 5");
    unrelated.run("CREATE TABLE old_agentmail_state (id TEXT PRIMARY KEY)");
    unrelated.close();
    expect(() =>
      createAgentMailOrchestrationStore({
        dbPath: paths.dbPath,
        inboxId: "support@agentmail.to",
      }),
    ).toThrow(/application_id|belongs to another application|schema/i);
  });
});
