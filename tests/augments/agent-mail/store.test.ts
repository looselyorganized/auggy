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
    sender: "sender@example.com",
    senderHash: hashAgentMailOrchestrationValue("sender@example.com"),
    payloadHash: hashAgentMailOrchestrationValue("message_1:thread_1"),
    receivedAt: 1_000,
    policyVersion: 1,
    ...overrides,
  };
}

function providerDraftInput(overrides: Record<string, unknown> = {}) {
  return {
    draftId: "draft_provider_1",
    kind: "new" as const,
    operationId: "create_provider_draft_1",
    clientId: "client_provider_draft_1",
    providerRevision: "revision_1",
    providerUpdatedAt: 1_500,
    materialHash: hashAgentMailOrchestrationValue("provider draft material 1"),
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
    for (const table of ["agentmail_drafts", "agentmail_draft_delivery_operations"]) {
      const stateColumns = db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name);
      expect(stateColumns).not.toContain("body");
      expect(stateColumns).not.toContain("html");
      expect(stateColumns).not.toContain("attachments");
      expect(stateColumns).not.toContain("api_key");
      expect(stateColumns).not.toContain("signed_url");
    }
    db.close();
    expect(readFileSync(paths.dbPath).includes(Buffer.from("Full body"))).toBe(false);
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

  test("atomically enqueues one metadata-only creator alert for a provider draft", () => {
    const paths = fixture();
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      clock: () => 2_000,
    });
    store.claimMessage(claimInput());
    const draft = {
      sourceMessageId: "message_1",
      threadId: "thread_1",
      draftId: "draft_1",
      clientId: "reply-message-1",
      providerUpdatedAt: 1_500,
    };
    expect(store.recordDraft(draft)).toEqual({ status: "recorded" });
    expect(store.recordDraft(draft)).toEqual({ status: "duplicate" });
    const alerts = store.listCreatorAttention();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: "draft_ready",
      subjectId: "draft_1",
      relatedMessageId: "message_1",
      state: "pending",
      version: 1,
      attemptCount: 0,
    });
    expect(alerts[0]!.operationKey).toMatch(/^agentmail\.attention\.[a-f0-9]{64}$/);

    expect(() =>
      store.recordDraft({ ...draft, sourceMessageId: "missing", draftId: "draft_2" }),
    ).toThrow(/source does not match/);
    expect(store.listCreatorAttention()).toHaveLength(1);
    store.close();

    const db = new Database(paths.dbPath, { readonly: true });
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(agentmail_creator_attention)")
      .all()
      .map((row) => row.name);
    expect(columns).not.toContain("sender");
    expect(columns).not.toContain("recipient");
    expect(columns).not.toContain("subject");
    expect(columns).not.toContain("body");
    expect(columns).not.toContain("provider_response");
    db.close();
  });

  test("binds, claims, retries, settles, and acknowledges one attention generation", () => {
    const paths = fixture();
    let now = 2_000;
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      clock: () => now,
    });
    store.claimMessage(claimInput());
    store.recordDraft({
      sourceMessageId: "message_1",
      threadId: "thread_1",
      draftId: "draft_1",
      clientId: "reply-message-1",
      providerUpdatedAt: 1_500,
    });
    const attention = store.listCreatorAttention()[0]!;
    const binding = {
      attentionId: attention.attentionId,
      destination: "creator",
      destinationBindingHash: "a".repeat(64),
      payloadHash: "b".repeat(64),
      maxAttempts: 3,
    };
    expect(store.bindCreatorAttention(binding)).toMatchObject({ status: "bound" });
    expect(store.bindCreatorAttention(binding)).toMatchObject({ status: "duplicate" });
    expect(
      store.bindCreatorAttention({ ...binding, destinationBindingHash: "c".repeat(64) }),
    ).toMatchObject({ status: "conflict" });

    const firstClaim = store.claimCreatorAttention(attention.attentionId)!;
    expect(firstClaim.state).toBe("dispatching");
    expect(store.claimCreatorAttention(attention.attentionId)).toBeUndefined();
    now = 3_000;
    const retry = store.settleCreatorAttention({
      attentionId: attention.attentionId,
      expectedVersion: firstClaim.version,
      outcome: { status: "retry", attemptCount: 1, resultCode: "delivery_failed" },
    });
    expect(retry).toMatchObject({ state: "pending", attemptCount: 1 });

    const secondClaim = store.claimCreatorAttention(attention.attentionId)!;
    const presented = store.settleCreatorAttention({
      attentionId: attention.attentionId,
      expectedVersion: secondClaim.version,
      outcome: { status: "presented", attemptCount: 2, resultCode: "sent" },
    });
    expect(presented).toMatchObject({ state: "presented", attemptCount: 2, settledAt: 3_000 });
    expect(presented.settlementHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      store.listCreatorAttention({
        states: ["presented"],
        acknowledgementPending: true,
      }),
    ).toEqual([presented]);
    const acknowledged = store.acknowledgeCreatorAttention({
      attentionId: attention.attentionId,
      expectedVersion: presented.version,
      settlementHash: presented.settlementHash!,
    });
    expect(acknowledged.notifyAcknowledgedAt).toBe(3_000);
    expect(
      store.listCreatorAttention({
        states: ["presented"],
        acknowledgementPending: true,
      }),
    ).toEqual([]);
    expect(
      store.acknowledgeCreatorAttention({
        attentionId: attention.attentionId,
        expectedVersion: presented.version,
        settlementHash: presented.settlementHash!,
      }),
    ).toEqual(acknowledged);
    store.close();
  });

  test("repairs interrupted attention dispatch without minting another operation", () => {
    const paths = fixture();
    let store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
    });
    store.claimMessage(claimInput());
    store.recordDraft({
      sourceMessageId: "message_1",
      threadId: "thread_1",
      draftId: "draft_1",
      clientId: "reply-message-1",
      providerUpdatedAt: 1_500,
    });
    const attention = store.listCreatorAttention()[0]!;
    store.bindCreatorAttention({
      attentionId: attention.attentionId,
      destination: "creator",
      destinationBindingHash: "a".repeat(64),
      payloadHash: "b".repeat(64),
      maxAttempts: 3,
    });
    const operationKey = store.claimCreatorAttention(attention.attentionId)!.operationKey;
    store.close();

    store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
    });
    expect(store.recoverCreatorAttention()).toEqual({ dispatching: 1, superseded: 0 });
    const recovered = store.getCreatorAttention(attention.attentionId)!;
    expect(recovered).toMatchObject({
      state: "pending",
      operationKey,
      lastResultCode: "interrupted_dispatch",
    });
    expect(store.recoverCreatorAttention()).toEqual({ dispatching: 0, superseded: 0 });
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

  test("enqueues delivery-failure attention only for locally managed sent mail", () => {
    const paths = fixture();
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      sendKey: () => "stable-send-key",
    });
    const outboundHash = hashAgentMailOrchestrationValue("managed outbound");
    store.reserveOutboundOperation({ operationId: "operation_1", payloadHash: outboundHash });
    store.settleOutboundOperation("operation_1", {
      status: "sent",
      messageId: "sent_1",
      threadId: "thread_1",
    });
    const ignored = {
      eventId: "bounce_unmanaged",
      eventType: "message.bounced",
      messageId: "not_ours",
      payloadHash: hashAgentMailOrchestrationValue("unmanaged bounce"),
      observedAt: 2_000,
    };
    expect(store.recordProviderEvent(ignored)).toBe("recorded");
    expect(store.listCreatorAttention()).toHaveLength(0);

    const delivered = {
      eventId: "delivery_1",
      eventType: "message.delivered",
      messageId: "sent_1",
      payloadHash: hashAgentMailOrchestrationValue("managed delivery"),
      observedAt: 2_100,
    };
    expect(store.recordProviderEvent(delivered)).toBe("recorded");
    expect(store.listCreatorAttention()).toHaveLength(0);

    const failed = {
      eventId: "bounce_1",
      eventType: "message.bounced",
      messageId: "sent_1",
      payloadHash: hashAgentMailOrchestrationValue("managed bounce"),
      observedAt: 2_200,
    };
    expect(store.recordProviderEvent(failed)).toBe("recorded");
    expect(store.recordProviderEvent(failed)).toBe("duplicate");
    expect(store.listCreatorAttention()).toEqual([
      expect.objectContaining({
        kind: "delivery_failure",
        subjectId: "bounce_1",
        relatedMessageId: "sent_1",
        state: "pending",
      }),
    ]);
    store.close();
  });

  test("reconciles delivery failures recorded before local draft and direct-send settlement", () => {
    const paths = fixture();
    let sendKey = 0;
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      sendKey: () => `stable-send-key-${++sendKey}`,
    });
    const directFailure = {
      eventId: "reject_direct",
      eventType: "message.rejected",
      messageId: "sent_direct",
      payloadHash: hashAgentMailOrchestrationValue("direct rejected"),
      observedAt: 2_000,
    };
    expect(store.recordProviderEvent(directFailure)).toBe("recorded");
    expect(store.listCreatorAttention()).toHaveLength(0);
    store.reserveOutboundOperation({
      operationId: "operation_direct",
      payloadHash: hashAgentMailOrchestrationValue("direct payload"),
    });
    store.settleOutboundOperation("operation_direct", {
      status: "sent",
      messageId: "sent_direct",
      threadId: "thread_direct",
    });

    store.claimMessage(claimInput());
    store.recordDraft({
      sourceMessageId: "message_1",
      threadId: "thread_1",
      draftId: "draft_1",
      clientId: "reply-message-1",
      providerUpdatedAt: 1_500,
    });
    store.approveDraft({
      sourceMessageId: "message_1",
      approvalEvidence: "creator explicitly approved",
      expectedUpdatedAt: 1_500,
    });
    store.reserveDraftSend("message_1");
    const draftFailure = {
      eventId: "complaint_draft",
      eventType: "message.complained",
      messageId: "sent_draft",
      payloadHash: hashAgentMailOrchestrationValue("draft complaint"),
      observedAt: 2_100,
    };
    expect(store.recordProviderEvent(draftFailure)).toBe("recorded");
    expect(
      store.listCreatorAttention().filter((attention) => attention.kind === "delivery_failure"),
    ).toHaveLength(1);
    store.settleDraftSend("message_1", { status: "sent", messageId: "sent_draft" });

    expect(
      store
        .listCreatorAttention({ states: ["pending"] })
        .filter((attention) => attention.kind === "delivery_failure")
        .map((attention) => attention.subjectId),
    ).toEqual(["reject_direct", "complaint_draft"]);
    expect(store.recordProviderEvent(directFailure)).toBe("duplicate");
    expect(store.recordProviderEvent(draftFailure)).toBe("duplicate");
    expect(
      store.listCreatorAttention().filter((attention) => attention.kind === "delivery_failure"),
    ).toHaveLength(2);
    store.close();
  });

  test("durably enforces inbound limits, outbound cooldown, and send-operation replay", () => {
    const paths = fixture();
    let now = 4_000_000;
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      clock: () => now,
      sendKey: () => "stable-send-key",
    });
    const senderHash = hashAgentMailOrchestrationValue("sender@example.com");
    const firstPayload = hashAgentMailOrchestrationValue("inbound-1");
    expect(
      store.reserveInboundRate({
        messageId: "message_1",
        senderHash,
        payloadHash: firstPayload,
        globalMaxPerHour: 10,
        perSenderMaxPerHour: 1,
      }),
    ).toEqual({ status: "reserved" });
    expect(
      store.reserveInboundRate({
        messageId: "message_1",
        senderHash,
        payloadHash: firstPayload,
        globalMaxPerHour: 10,
        perSenderMaxPerHour: 1,
      }),
    ).toEqual({ status: "replay" });
    expect(
      store.reserveInboundRate({
        messageId: "message_2",
        senderHash,
        payloadHash: hashAgentMailOrchestrationValue("inbound-2"),
        globalMaxPerHour: 10,
        perSenderMaxPerHour: 1,
      }),
    ).toMatchObject({ status: "rate_limited", reason: "actor" });

    const recipientHash = hashAgentMailOrchestrationValue("buyer@example.com");
    const outboundHash = hashAgentMailOrchestrationValue("outbound-1");
    expect(
      store.reserveOutboundRate({
        operationId: "operation_1",
        recipientHashes: [recipientHash],
        payloadHash: outboundHash,
        globalMaxPerHour: 10,
        perRecipientCooldownMs: 300_000,
        dedupWindowMs: 0,
      }),
    ).toEqual({ status: "reserved" });
    expect(
      store.reserveOutboundRate({
        operationId: "operation_2",
        recipientHashes: [recipientHash],
        payloadHash: hashAgentMailOrchestrationValue("outbound-2"),
        globalMaxPerHour: 10,
        perRecipientCooldownMs: 300_000,
        dedupWindowMs: 0,
      }),
    ).toMatchObject({ status: "rate_limited", reason: "actor" });

    const reserved = store.reserveOutboundOperation({
      operationId: "operation_1",
      payloadHash: outboundHash,
    });
    expect(reserved).toMatchObject({
      status: "reserved",
      operation: { sendKey: "stable-send-key", state: "reserved" },
    });
    store.settleOutboundOperation("operation_1", {
      status: "sent",
      messageId: "sent_1",
      threadId: "thread_1",
    });
    expect(
      store.reserveOutboundOperation({ operationId: "operation_1", payloadHash: outboundHash }),
    ).toMatchObject({
      status: "replay",
      operation: { state: "sent", sentMessageId: "sent_1" },
    });
    now += 3_600_001;
    expect(
      store.reserveInboundRate({
        messageId: "message_3",
        senderHash,
        payloadHash: hashAgentMailOrchestrationValue("inbound-3"),
        globalMaxPerHour: 10,
        perSenderMaxPerHour: 1,
      }),
    ).toEqual({ status: "reserved" });
    store.close();
  });

  test("stales older thread drafts even when newer mail arrived before draft recording", () => {
    const paths = fixture();
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
    });
    store.claimMessage(claimInput({ eventId: "event_1", receivedAt: 1_000 }));
    store.claimMessage(
      claimInput({
        messageId: "message_2",
        eventId: "event_2",
        payloadHash: hashAgentMailOrchestrationValue("message_2"),
        receivedAt: 2_000,
      }),
    );
    store.recordDraft({
      sourceMessageId: "message_1",
      threadId: "thread_1",
      draftId: "draft_1",
      clientId: "reply-message-1",
      providerUpdatedAt: 2_500,
    });
    expect(store.getDraftByMessage("message_1")?.state).toBe("stale");
    expect(store.listCreatorAttention()).toEqual([
      expect.objectContaining({
        kind: "draft_ready",
        subjectId: "draft_1",
        state: "superseded",
      }),
    ]);
    const obsolete = store.listCreatorAttention()[0]!;
    const obsoleteBinding = store.bindCreatorAttention({
      attentionId: obsolete.attentionId,
      destination: "creator",
      destinationBindingHash: "a".repeat(64),
      payloadHash: "b".repeat(64),
      maxAttempts: 3,
    });
    expect(obsoleteBinding).toMatchObject({
      status: "duplicate",
      record: { state: "superseded" },
    });
    expect(obsoleteBinding.record.destination).toBeUndefined();
    store.close();
  });

  test("supersedes pending draft alerts when a draft becomes stale or is sent", () => {
    const paths = fixture();
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      sendKey: () => "send-message-1",
    });
    store.claimMessage(claimInput());
    store.recordDraft({
      sourceMessageId: "message_1",
      threadId: "thread_1",
      draftId: "draft_1",
      clientId: "reply-message-1",
      providerUpdatedAt: 1_500,
    });
    store.markDraftStale("message_1");
    expect(store.listCreatorAttention()[0]).toMatchObject({
      state: "superseded",
      lastResultCode: "draft_no_longer_pending_review",
    });

    store.claimMessage(
      claimInput({
        messageId: "message_2",
        threadId: "thread_2",
        eventId: "event_2",
        payloadHash: hashAgentMailOrchestrationValue("message_2"),
      }),
    );
    store.recordDraft({
      sourceMessageId: "message_2",
      threadId: "thread_2",
      draftId: "draft_2",
      clientId: "reply-message-2",
      providerUpdatedAt: 1_600,
    });
    store.approveDraft({
      sourceMessageId: "message_2",
      approvalEvidence: "creator explicitly approved",
      expectedUpdatedAt: 1_600,
    });
    store.reserveDraftSend("message_2");
    store.settleDraftSend("message_2", { status: "sent", messageId: "sent_2" });
    expect(
      store.listCreatorAttention().find((attention) => attention.subjectId === "draft_2"),
    ).toMatchObject({ state: "superseded" });
    store.close();
  });

  test("turns crash-interrupted mutations into reconciliation-required ambiguity", () => {
    const paths = fixture();
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      sendKey: () => "stable-send-key",
    });
    store.claimMessage(claimInput());
    store.recordDraft({
      sourceMessageId: "message_1",
      threadId: "thread_1",
      draftId: "draft_1",
      clientId: "reply-message-1",
      providerUpdatedAt: 1_500,
    });
    store.approveDraft({
      sourceMessageId: "message_1",
      approvalEvidence: "creator send action",
      expectedUpdatedAt: 1_500,
    });
    store.reserveDraftSend("message_1");
    store.reserveOutboundOperation({
      operationId: "operation_1",
      payloadHash: hashAgentMailOrchestrationValue("outbound"),
    });
    expect(store.recoverAmbiguousMutations()).toEqual({ drafts: 1, outbound: 1 });
    expect(store.getDraftByMessage("message_1")?.state).toBe("ambiguous");
    expect(store.recoverAmbiguousMutations()).toEqual({ drafts: 0, outbound: 0 });
    store.close();
  });

  test("keys provider-native drafts by provider and operation identity across restarts", () => {
    const paths = fixture();
    let store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
    });
    store.claimMessage(claimInput());
    const reply = providerDraftInput({
      draftId: "draft_reply_1",
      kind: "reply" as const,
      sourceMessageId: "message_1",
      threadId: "thread_1",
      operationId: "create_reply_1",
      clientId: "client_reply_1",
    });
    expect(store.recordProviderDraft(reply)).toEqual({ status: "recorded" });
    expect(store.recordProviderDraft(reply)).toEqual({ status: "duplicate" });
    expect(store.recordProviderDraft({ ...reply, providerRevision: "revision_changed" })).toEqual({
      status: "conflict",
    });
    expect(
      store.recordProviderDraft(
        providerDraftInput({ draftId: "draft_collision", operationId: "create_reply_1" }),
      ),
    ).toEqual({ status: "conflict" });
    expect(() =>
      store.recordProviderDraft(
        providerDraftInput({ kind: "forward" as const, sourceMessageId: undefined }),
      ),
    ).toThrow(/kind and source message/);
    expect(
      store.recordProviderDraft(
        providerDraftInput({
          draftId: "draft_external_reply",
          kind: "reply_all" as const,
          sourceMessageId: "provider_message_not_ingested_by_auggy",
          threadId: "provider_thread_not_ingested_by_auggy",
          operationId: "create_external_reply",
          clientId: "client_external_reply",
        }),
      ),
    ).toEqual({ status: "recorded" });
    expect(store.recordProviderDraft(providerDraftInput())).toEqual({ status: "recorded" });
    expect(store.listProviderDrafts()).toHaveLength(3);
    store.close();

    store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
    });
    expect(store.getProviderDraft("draft_reply_1")).toMatchObject({
      kind: "reply",
      sourceMessageId: "message_1",
      operationId: "create_reply_1",
      materialHash: reply.materialHash,
    });
    expect(store.getProviderDraft("draft_provider_1")).toMatchObject({ kind: "new" });
    store.close();
  });

  test("invalidates approvals on provider refresh and fences delivery with immutable manifests", () => {
    const paths = fixture();
    let now = 2_000;
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      clock: () => now,
      sendKey: () => "provider-idempotency-key",
    });
    const firstMaterial = hashAgentMailOrchestrationValue("first provider material");
    const secondMaterial = hashAgentMailOrchestrationValue("second provider material");
    const firstManifest = hashAgentMailOrchestrationValue("first immutable approval manifest");
    const secondManifest = hashAgentMailOrchestrationValue("second immutable approval manifest");
    store.recordProviderDraft(providerDraftInput({ materialHash: firstMaterial, sendAt: 10_000 }));
    expect(
      store.approveProviderDraft({
        draftId: "draft_provider_1",
        expectedProviderRevision: "revision_1",
        expectedMaterialHash: firstMaterial,
        approvalGeneration: 1,
        manifestHash: firstManifest,
      }),
    ).toMatchObject({ state: "approved", approvalGeneration: 1 });
    now = 3_000;
    const refreshed = store.refreshProviderDraft({
      draftId: "draft_provider_1",
      expectedProviderRevision: "revision_1",
      providerRevision: "revision_2",
      providerUpdatedAt: 2_500,
      materialHash: secondMaterial,
      sendAt: 11_000,
    });
    expect(refreshed).toMatchObject({ state: "ready", approvalGeneration: 1 });
    expect(refreshed.approvalManifestHash).toBeUndefined();
    expect(() =>
      store.approveProviderDraft({
        draftId: "draft_provider_1",
        expectedProviderRevision: "revision_2",
        expectedMaterialHash: secondMaterial,
        approvalGeneration: 1,
        manifestHash: secondManifest,
      }),
    ).toThrow(/generation is not monotonic/);
    store.approveProviderDraft({
      draftId: "draft_provider_1",
      expectedProviderRevision: "revision_2",
      expectedMaterialHash: secondMaterial,
      approvalGeneration: 2,
      manifestHash: secondManifest,
    });
    const reserved = store.reserveProviderDraftDelivery({
      draftId: "draft_provider_1",
      operationId: "schedule_draft_1",
      kind: "schedule",
      expectedProviderRevision: "revision_2",
      expectedMaterialHash: secondMaterial,
      approvalGeneration: 2,
      manifestHash: secondManifest,
      sendAt: 11_000,
    });
    expect(reserved).toMatchObject({
      status: "reserved",
      operation: { idempotencyKey: "provider-idempotency-key", state: "reserved" },
    });
    expect(
      store.reserveProviderDraftDelivery({
        draftId: "draft_provider_1",
        operationId: "schedule_draft_1",
        kind: "schedule",
        expectedProviderRevision: "revision_2",
        expectedMaterialHash: secondMaterial,
        approvalGeneration: 2,
        manifestHash: secondManifest,
        sendAt: 11_000,
      }),
    ).toMatchObject({
      status: "replay",
      operation: { idempotencyKey: "provider-idempotency-key" },
    });
    expect(
      store.settleProviderDraftDelivery("schedule_draft_1", {
        status: "scheduled",
        sendAt: 11_000,
      }),
    ).toMatchObject({ state: "scheduled", sendAt: 11_000 });
    expect(store.getProviderDraft("draft_provider_1")).toMatchObject({ state: "scheduled" });
    store.close();
  });

  test("recovers uncertain provider sends and requires explicit reconciliation", () => {
    const paths = fixture();
    let store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      sendKey: () => "provider-send-key",
    });
    const materialHash = hashAgentMailOrchestrationValue("send material");
    const manifestHash = hashAgentMailOrchestrationValue("send manifest");
    store.recordProviderDraft(providerDraftInput({ materialHash }));
    store.approveProviderDraft({
      draftId: "draft_provider_1",
      expectedProviderRevision: "revision_1",
      expectedMaterialHash: materialHash,
      approvalGeneration: 1,
      manifestHash,
    });
    store.reserveProviderDraftDelivery({
      draftId: "draft_provider_1",
      operationId: "send_draft_1",
      kind: "send",
      expectedProviderRevision: "revision_1",
      expectedMaterialHash: materialHash,
      approvalGeneration: 1,
      manifestHash,
    });
    store.close();

    store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
    });
    expect(store.recoverAmbiguousMutations()).toEqual({ drafts: 1, outbound: 0 });
    expect(store.getDraftDeliveryOperation("send_draft_1")).toMatchObject({
      state: "outcome_unknown",
      outcomeCode: "interrupted_before_settlement",
    });
    expect(store.getProviderDraft("draft_provider_1")).toMatchObject({
      state: "ambiguous",
      reconciliationState: "required",
    });
    const evidenceHash = hashAgentMailOrchestrationValue("provider search confirmed send");
    const reconciled = store.reconcileProviderDraftDelivery({
      operationId: "send_draft_1",
      evidenceHash,
      resolution: { status: "sent", messageId: "sent_1", threadId: "thread_1" },
    });
    expect(reconciled).toMatchObject({
      state: "sent",
      sentMessageId: "sent_1",
      sentThreadId: "thread_1",
      reconciliationHash: evidenceHash,
    });
    expect(
      store.reconcileProviderDraftDelivery({
        operationId: "send_draft_1",
        evidenceHash,
        resolution: { status: "sent", messageId: "sent_1", threadId: "thread_1" },
      }),
    ).toEqual(reconciled);
    expect(() =>
      store.reconcileProviderDraftDelivery({
        operationId: "send_draft_1",
        evidenceHash: hashAgentMailOrchestrationValue("conflicting evidence"),
        resolution: { status: "not_sent" },
      }),
    ).toThrow(/not awaiting reconciliation/);
    store.close();
  });

  test("compacts terminal state in bounded batches while retaining active and ambiguous work", () => {
    const paths = fixture();
    let now = 1_000;
    let sendKey = 0;
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      clock: () => now,
      sendKey: () => `send-key-${++sendKey}`,
    });
    const materialHash = hashAgentMailOrchestrationValue("terminal material");
    const manifestHash = hashAgentMailOrchestrationValue("terminal manifest");
    store.recordProviderDraft(providerDraftInput({ materialHash }));
    store.approveProviderDraft({
      draftId: "draft_provider_1",
      expectedProviderRevision: "revision_1",
      expectedMaterialHash: materialHash,
      approvalGeneration: 1,
      manifestHash,
    });
    store.reserveProviderDraftDelivery({
      draftId: "draft_provider_1",
      operationId: "send_terminal",
      kind: "send",
      expectedProviderRevision: "revision_1",
      expectedMaterialHash: materialHash,
      approvalGeneration: 1,
      manifestHash,
    });
    store.settleProviderDraftDelivery("send_terminal", {
      status: "sent",
      messageId: "sent_terminal",
      threadId: "thread_terminal",
    });

    store.recordProviderDraft(
      providerDraftInput({
        draftId: "draft_active",
        operationId: "create_active",
        clientId: "client_active",
        materialHash: hashAgentMailOrchestrationValue("active material"),
      }),
    );
    now = 5_000;
    const first = store.compact({ terminalBefore: 4_000, maxRows: 1 });
    expect(Object.values(first).reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(store.getProviderDraft("draft_active")?.state).toBe("ready");
    const second = store.compact({ terminalBefore: 4_000, maxRows: 1 });
    expect(Object.values(second).reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(1);
    expect(store.getProviderDraft("draft_active")?.state).toBe("ready");
    const third = store.compact({ terminalBefore: 4_000, maxRows: 1 });
    expect(Object.values(third).reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(1);
    expect(store.getProviderDraft("draft_provider_1")).toBeUndefined();
    store.close();
  });

  test("fails closed when the exact orchestration fingerprint is corrupt", () => {
    const paths = fixture();
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
    });
    store.close();
    const db = new Database(paths.dbPath);
    db.run("UPDATE agentmail_store_metadata SET contract_fingerprint = ? WHERE singleton = 1", [
      "0".repeat(64),
    ]);
    db.close();
    expect(() =>
      createAgentMailOrchestrationStore({
        dbPath: paths.dbPath,
        inboxId: "support@agentmail.to",
      }),
    ).toThrow(/fingerprint.*corrupt/i);
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
