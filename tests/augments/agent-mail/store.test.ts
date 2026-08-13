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

function directDeliveryInput(overrides: Record<string, unknown> = {}) {
  return {
    operationId: "delivery_direct_1",
    action: "send_message" as const,
    endpoint: "messages.send" as const,
    approvalGeneration: 1,
    approvalManifestHash: hashAgentMailOrchestrationValue("delivery approval 1"),
    requestHash: hashAgentMailOrchestrationValue("exact direct request 1"),
    idempotencyKey: "delivery-direct-key-1",
    recipientHashes: [hashAgentMailOrchestrationValue("recipient@example.com")],
    rateLimit: {
      globalMaxPerHour: 10,
      perRecipientCooldownMs: 300_000,
      dedupWindowMs: 300_000,
    },
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
    for (const table of [
      "agentmail_drafts",
      "agentmail_draft_mutations",
      "agentmail_delivery_operations",
    ]) {
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

  test("atomically enqueues one metadata-only creator alert for a provider draft", () => {
    const paths = fixture();
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      clock: () => 2_000,
    });
    store.claimMessage(claimInput());
    const draft = providerDraftInput({
      sourceMessageId: "message_1",
      threadId: "thread_1",
      draftId: "draft_1",
      kind: "reply" as const,
      operationId: "reply-message-1",
      clientId: "reply-message-1",
      providerRevision: "revision-1",
      providerUpdatedAt: 1_500,
    });
    expect(store.recordProviderDraft(draft)).toEqual({ status: "recorded" });
    expect(store.recordProviderDraft(draft)).toEqual({ status: "duplicate" });
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
      store.recordProviderDraft({
        ...draft,
        draftId: "draft_2",
        operationId: "reply-message-2",
        clientId: "reply-message-2",
        threadId: "wrong-thread",
      }),
    ).toThrow(/source thread does not match/);
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
    store.recordProviderDraft(
      providerDraftInput({
        sourceMessageId: "message_1",
        threadId: "thread_1",
        draftId: "draft_1",
        kind: "reply" as const,
        operationId: "reply-message-1",
        clientId: "reply-message-1",
        providerUpdatedAt: 1_500,
      }),
    );
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
    store.recordProviderDraft(
      providerDraftInput({
        sourceMessageId: "message_1",
        threadId: "thread_1",
        draftId: "draft_1",
        kind: "reply" as const,
        operationId: "reply-message-1",
        clientId: "reply-message-1",
        providerUpdatedAt: 1_500,
      }),
    );
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

  test("keeps prepared draft creation retryable and reconciles only a dispatched crash", () => {
    const paths = fixture();
    const manifestHash = hashAgentMailOrchestrationValue("create draft request");
    let store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
    });
    const input = {
      kind: "create" as const,
      operationId: "mutation_create_1",
      draftKind: "reply" as const,
      sourceMessageId: "provider_message_1",
      threadId: "provider_thread_1",
      clientId: "stable_create_client_1",
      manifestHash,
    };
    expect(store.reserveProviderDraftMutation(input)).toMatchObject({
      status: "reserved",
      operation: { state: "prepared", clientId: "stable_create_client_1" },
    });
    expect(store.reserveProviderDraftMutation(input)).toMatchObject({ status: "replay" });
    expect(
      store.reserveProviderDraftMutation({
        ...input,
        manifestHash: hashAgentMailOrchestrationValue("changed create request"),
      }),
    ).toMatchObject({ status: "conflict" });
    expect(
      store.reserveProviderDraftMutation({
        ...input,
        operationId: "mutation_create_2",
      }),
    ).toMatchObject({ status: "conflict" });
    store.close();

    store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
    });
    expect(store.recoverAmbiguousMutations()).toEqual({
      drafts: 0,
      draftMutations: 0,
      deliveryOperations: 0,
    });
    expect(store.getProviderDraftMutation("mutation_create_1")?.state).toBe("prepared");
    expect(store.markProviderDraftMutationDispatching("mutation_create_1")).toMatchObject({
      status: "dispatch",
      operation: { state: "dispatching" },
    });
    store.close();

    store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
    });
    expect(store.recoverAmbiguousMutations()).toEqual({
      drafts: 0,
      draftMutations: 1,
      deliveryOperations: 0,
    });
    expect(store.listUnresolvedProviderDraftMutations()).toEqual([
      expect.objectContaining({ operationId: "mutation_create_1", state: "outcome_unknown" }),
    ]);
    const materialHash = hashAgentMailOrchestrationValue("created provider material");
    expect(
      store.reconcileProviderDraftMutation({
        operationId: "mutation_create_1",
        evidenceHash: hashAgentMailOrchestrationValue("provider client lookup"),
        resolution: {
          status: "updated",
          draftId: "provider_draft_1",
          providerRevision: "revision_1",
          providerUpdatedAt: 2_000,
          materialHash,
        },
      }),
    ).toMatchObject({ state: "updated", resultDraftId: "provider_draft_1" });
    expect(store.getProviderDraft("provider_draft_1")).toMatchObject({
      kind: "reply",
      sourceMessageId: "provider_message_1",
      clientId: "stable_create_client_1",
      materialHash,
      state: "ready",
    });
    store.close();
  });

  test("durably revises and deletes provider drafts", () => {
    const paths = fixture();
    let now = 2_000;
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      clock: () => now,
    });
    const material1 = hashAgentMailOrchestrationValue("material 1");
    const material2 = hashAgentMailOrchestrationValue("material 2");
    store.recordProviderDraft(providerDraftInput({ materialHash: material1 }));
    store.approveProviderDraft({
      draftId: "draft_provider_1",
      expectedProviderRevision: "revision_1",
      expectedMaterialHash: material1,
      approvalGeneration: 1,
      manifestHash: hashAgentMailOrchestrationValue("approval 1"),
    });

    const revise = store.reserveProviderDraftMutation({
      kind: "revise",
      operationId: "mutation_revise_1",
      draftId: "draft_provider_1",
      expectedProviderRevision: "revision_1",
      expectedMaterialHash: material1,
      manifestHash: hashAgentMailOrchestrationValue("revision request"),
    });
    expect(revise).toMatchObject({ status: "reserved", operation: { state: "prepared" } });
    expect(store.getProviderDraft("draft_provider_1")).toMatchObject({
      state: "ready",
      approvalGeneration: 1,
    });
    expect(store.getProviderDraft("draft_provider_1")?.approvalManifestHash).toBeUndefined();
    store.markProviderDraftMutationDispatching("mutation_revise_1");
    now = 3_000;
    store.settleProviderDraftMutation("mutation_revise_1", {
      status: "updated",
      draftId: "draft_provider_1",
      providerRevision: "revision_2",
      providerUpdatedAt: 2_500,
      materialHash: material2,
    });

    store.reserveProviderDraftMutation({
      kind: "delete",
      operationId: "mutation_delete_404",
      draftId: "draft_provider_1",
      expectedProviderRevision: "revision_2",
      expectedMaterialHash: material2,
      manifestHash: hashAgentMailOrchestrationValue("delete request 404"),
    });
    store.markProviderDraftMutationDispatching("mutation_delete_404");
    store.settleProviderDraftMutation("mutation_delete_404", {
      status: "failed",
      code: "provider_not_found",
    });
    expect(store.getProviderDraft("draft_provider_1")).toMatchObject({ state: "ready" });
    expect(store.getProviderDraft("draft_provider_1")?.sentMessageId).toBeUndefined();

    store.reserveProviderDraftMutation({
      kind: "delete",
      operationId: "mutation_delete_1",
      draftId: "draft_provider_1",
      expectedProviderRevision: "revision_2",
      expectedMaterialHash: material2,
      manifestHash: hashAgentMailOrchestrationValue("delete request success"),
    });
    store.markProviderDraftMutationDispatching("mutation_delete_1");
    expect(
      store.settleProviderDraftMutation("mutation_delete_1", { status: "deleted" }),
    ).toMatchObject({ state: "deleted", resultDraftId: "draft_provider_1" });
    expect(store.getProviderDraft("draft_provider_1")).toMatchObject({ state: "deleted" });
    store.close();
  });

  test("keeps active and unknown draft mutations through bounded compaction", () => {
    const paths = fixture();
    let now = 1_000;
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      clock: () => now,
    });
    store.reserveProviderDraftMutation({
      kind: "create",
      operationId: "prepared_create",
      draftKind: "new",
      clientId: "prepared_client",
      manifestHash: hashAgentMailOrchestrationValue("prepared create"),
    });
    store.reserveProviderDraftMutation({
      kind: "create",
      operationId: "unknown_create",
      draftKind: "new",
      clientId: "unknown_client",
      manifestHash: hashAgentMailOrchestrationValue("unknown create"),
    });
    store.markProviderDraftMutationDispatching("unknown_create");
    store.recoverAmbiguousMutations();
    now = 10_000;
    store.compact({ terminalBefore: 9_000, maxRows: 100 });
    expect(store.getProviderDraftMutation("prepared_create")?.state).toBe("prepared");
    expect(store.getProviderDraftMutation("unknown_create")?.state).toBe("outcome_unknown");
    store.close();
  });

  test("atomically reserves one exact direct delivery and charges rate quota once", () => {
    const paths = fixture();
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
    });
    const input = directDeliveryInput();
    expect(store.reserveDeliveryOperation(input)).toMatchObject({
      status: "reserved",
      operation: {
        action: "send_message",
        endpoint: "messages.send",
        idempotencyKey: "delivery-direct-key-1",
        state: "prepared",
        attemptCount: 0,
      },
    });
    expect(store.reserveDeliveryOperation(input)).toMatchObject({ status: "replay" });
    expect(
      store.reserveDeliveryOperation({
        ...input,
        requestHash: hashAgentMailOrchestrationValue("changed direct request"),
      }),
    ).toMatchObject({ status: "conflict" });

    const db = new Database(paths.dbPath, { readonly: true });
    expect(
      db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM agentmail_delivery_operations")
        .get()?.count,
    ).toBe(1);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM agentmail_rate_reservations WHERE direction = 'outbound'",
        )
        .get()?.count,
    ).toBe(1);
    const operationColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(agentmail_delivery_operations)")
      .all()
      .map((row) => row.name);
    for (const forbidden of ["body", "html", "url", "api_key", "provider_response"]) {
      expect(operationColumns).not.toContain(forbidden);
    }
    db.close();
    store.close();
  });

  test("leaves a draft ready and unapproved when atomic delivery reservation is rate denied", () => {
    const paths = fixture();
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
    });
    store.reserveDeliveryOperation(
      directDeliveryInput({
        operationId: "delivery_consumes_quota",
        idempotencyKey: "delivery-consumes-quota",
      }),
    );
    const materialHash = hashAgentMailOrchestrationValue("rate denied draft material");
    const approvalManifestHash = hashAgentMailOrchestrationValue("rate denied draft approval");
    store.recordProviderDraft(providerDraftInput({ materialHash }));
    expect(
      store.reserveDeliveryOperation({
        operationId: "delivery_rate_denied_draft",
        action: "send_draft",
        endpoint: "drafts.send",
        draftId: "draft_provider_1",
        draftKind: "new",
        approvalGeneration: 1,
        approvalManifestHash,
        providerRevision: "revision_1",
        materialHash,
        requestHash: hashAgentMailOrchestrationValue("rate denied exact request"),
        idempotencyKey: "delivery-rate-denied-draft",
        recipientHashes: [hashAgentMailOrchestrationValue("other@example.com")],
        rateLimit: {
          globalMaxPerHour: 1,
          perRecipientCooldownMs: 0,
          dedupWindowMs: 0,
        },
      }),
    ).toEqual({ status: "rate_limited", reason: "global", retryAfterMs: 3_600_000 });
    expect(store.getDeliveryOperation("delivery_rate_denied_draft")).toBeUndefined();
    expect(store.getProviderDraft("draft_provider_1")).toMatchObject({
      state: "ready",
      approvalGeneration: 0,
    });
    expect(store.getProviderDraft("draft_provider_1")?.approvalManifestHash).toBeUndefined();
    const db = new Database(paths.dbPath, { readonly: true });
    expect(
      db
        .query<{ count: number }, []>(
          `SELECT count(*) AS count FROM agentmail_rate_reservations
            WHERE operation_id = 'delivery_rate_denied_draft'`,
        )
        .get()?.count,
    ).toBe(0);
    db.close();
    store.close();
  });

  test("rolls back draft approval and quota when delivery identity insertion conflicts", () => {
    const paths = fixture();
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
    });
    store.reserveDeliveryOperation(
      directDeliveryInput({
        operationId: "delivery_existing_key",
        idempotencyKey: "shared-delivery-key",
      }),
    );
    const materialHash = hashAgentMailOrchestrationValue("conflicted draft material");
    store.recordProviderDraft(providerDraftInput({ materialHash }));
    expect(() =>
      store.reserveDeliveryOperation({
        operationId: "delivery_conflicted_draft",
        action: "send_draft",
        endpoint: "drafts.send",
        draftId: "draft_provider_1",
        draftKind: "new",
        approvalGeneration: 1,
        approvalManifestHash: hashAgentMailOrchestrationValue("conflicted draft approval"),
        providerRevision: "revision_1",
        materialHash,
        requestHash: hashAgentMailOrchestrationValue("conflicted draft request"),
        idempotencyKey: "shared-delivery-key",
        recipientHashes: [hashAgentMailOrchestrationValue("other@example.com")],
        rateLimit: {
          globalMaxPerHour: 10,
          perRecipientCooldownMs: 0,
          dedupWindowMs: 0,
        },
      }),
    ).toThrow(/another delivery operation is already active/);
    expect(store.getDeliveryOperation("delivery_conflicted_draft")).toBeUndefined();
    expect(store.getProviderDraft("draft_provider_1")).toMatchObject({
      state: "ready",
      approvalGeneration: 0,
    });
    expect(store.getProviderDraft("draft_provider_1")?.approvalManifestHash).toBeUndefined();
    const db = new Database(paths.dbPath, { readonly: true });
    expect(
      db
        .query<{ count: number }, []>(
          `SELECT count(*) AS count FROM agentmail_rate_reservations
            WHERE operation_id = 'delivery_conflicted_draft'`,
        )
        .get()?.count,
    ).toBe(0);
    db.close();
    store.close();
  });

  test("keeps prepared delivery retryable across restart and recovers only dispatching work", () => {
    const paths = fixture();
    let now = 1_000;
    let store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      clock: () => now,
    });
    store.reserveDeliveryOperation(directDeliveryInput());
    store.close();

    store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      clock: () => now,
    });
    expect(store.recoverAmbiguousMutations()).toEqual({
      drafts: 0,
      draftMutations: 0,
      deliveryOperations: 0,
    });
    expect(store.getDeliveryOperation("delivery_direct_1")?.state).toBe("prepared");
    const dispatch = store.beginDeliveryDispatch("delivery_direct_1");
    expect(dispatch).toMatchObject({
      status: "dispatch",
      operation: {
        state: "dispatching",
        firstDispatchAt: 1_000,
        attemptCount: 1,
      },
    });
    store.close();

    now = 2_000;
    store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      clock: () => now,
    });
    expect(store.recoverAmbiguousMutations()).toEqual({
      drafts: 0,
      draftMutations: 0,
      deliveryOperations: 1,
    });
    expect(store.getDeliveryOperation("delivery_direct_1")).toMatchObject({
      state: "outcome_unknown",
      idempotencyKey: "delivery-direct-key-1",
      attemptCount: 1,
    });
    expect(store.beginDeliveryDispatch("delivery_direct_1")).toMatchObject({
      status: "manual_reconciliation_required",
      operation: { state: "outcome_unknown", attemptCount: 1 },
    });
    store.close();
  });

  test("retries provider throttling with the same key without consuming quota twice", () => {
    const paths = fixture();
    let now = 5_000;
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      clock: () => now,
    });
    store.reserveDeliveryOperation(directDeliveryInput());
    store.beginDeliveryDispatch("delivery_direct_1");
    store.settleDeliveryOperation("delivery_direct_1", {
      status: "retryable",
      code: "provider_rate_limited",
      retryAfter: 8_000,
    });
    expect(store.beginDeliveryRetry("delivery_direct_1")).toMatchObject({
      status: "wait",
      retryAfterMs: 3_000,
      operation: { idempotencyKey: "delivery-direct-key-1", attemptCount: 1 },
    });
    now = 8_000;
    expect(store.beginDeliveryRetry("delivery_direct_1")).toMatchObject({
      status: "dispatch",
      operation: { idempotencyKey: "delivery-direct-key-1", attemptCount: 2 },
    });
    store.settleDeliveryOperation("delivery_direct_1", {
      status: "sent",
      messageId: "sent_message_1",
      threadId: "sent_thread_1",
    });
    expect(store.getDeliveryOperation("delivery_direct_1")).toMatchObject({
      state: "sent",
      sentMessageId: "sent_message_1",
      sentThreadId: "sent_thread_1",
      attemptCount: 2,
    });
    const db = new Database(paths.dbPath, { readonly: true });
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM agentmail_rate_reservations WHERE direction = 'outbound'",
        )
        .get()?.count,
    ).toBe(1);
    db.close();
    store.close();
  });

  test("allows only explicit retryable dispatch and permanently fences unknown outcomes", () => {
    const paths = fixture();
    let now = 5_000;
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      clock: () => now,
    });
    store.reserveDeliveryOperation(directDeliveryInput());
    store.beginDeliveryDispatch("delivery_direct_1");
    store.settleDeliveryOperation("delivery_direct_1", {
      status: "retryable",
      code: "provider_rate_limited",
      retryAfter: 6_000,
    });
    expect(store.beginDeliveryDispatch("delivery_direct_1")).toMatchObject({
      status: "replay",
      operation: { state: "retryable", attemptCount: 1 },
    });
    now = 6_000;
    expect(store.beginDeliveryRetry("delivery_direct_1")).toMatchObject({
      status: "dispatch",
      operation: { state: "dispatching", attemptCount: 2 },
    });
    store.settleDeliveryOperation("delivery_direct_1", {
      status: "outcome_unknown",
      code: "provider_timeout_after_write",
    });
    now = Number.MAX_SAFE_INTEGER - 1;
    expect(store.beginDeliveryDispatch("delivery_direct_1")).toMatchObject({
      status: "manual_reconciliation_required",
      operation: { state: "outcome_unknown", attemptCount: 2 },
    });
    expect(store.beginDeliveryRetry("delivery_direct_1")).toMatchObject({
      status: "replay",
      operation: { state: "outcome_unknown", attemptCount: 2 },
    });
    store.close();
  });

  test("persists retry identity across restart without persisting mail content", () => {
    const paths = fixture();
    let store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      clock: () => 1_000,
    });
    store.reserveDeliveryOperation(
      directDeliveryInput({
        operationId: "restart_retry_1",
        idempotencyKey: "restart-retry-key-1",
        requestHash: hashAgentMailOrchestrationValue("Private subject and private body"),
      }),
    );
    store.beginDeliveryDispatch("restart_retry_1");
    store.settleDeliveryOperation("restart_retry_1", {
      status: "retryable",
      code: "provider_rate_limited",
      retryAfter: 2_000,
    });
    store.close();

    store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      clock: () => 2_001,
    });
    expect(store.getDeliveryOperation("restart_retry_1")).toMatchObject({
      state: "retryable",
      idempotencyKey: "restart-retry-key-1",
      attemptCount: 1,
    });
    expect(store.beginDeliveryRetry("restart_retry_1")).toMatchObject({
      status: "dispatch",
      operation: { idempotencyKey: "restart-retry-key-1", attemptCount: 2 },
    });
    store.close();
    const bytes = readFileSync(paths.dbPath);
    expect(bytes.includes(Buffer.from("Private subject"))).toBe(false);
    expect(bytes.includes(Buffer.from("private body"))).toBe(false);
  });

  test("binds draft delivery to approval and requires fresh approval after confirmed not sent", () => {
    const paths = fixture();
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
    });
    const materialHash = hashAgentMailOrchestrationValue("draft delivery material");
    const approvalManifestHash = hashAgentMailOrchestrationValue("draft delivery approval");
    store.recordProviderDraft(
      providerDraftInput({
        kind: "reply_all" as const,
        sourceMessageId: "provider_message_1",
        threadId: "provider_thread_1",
        materialHash,
      }),
    );
    const input = {
      operationId: "delivery_draft_1",
      action: "send_draft" as const,
      endpoint: "drafts.send" as const,
      draftId: "draft_provider_1",
      sourceMessageId: "provider_message_1",
      threadId: "provider_thread_1",
      draftKind: "reply_all" as const,
      approvalGeneration: 1,
      approvalManifestHash,
      providerRevision: "revision_1",
      materialHash,
      requestHash: hashAgentMailOrchestrationValue("exact draft send request"),
      idempotencyKey: "delivery-draft-key-1",
      recipientHashes: [hashAgentMailOrchestrationValue("recipient@example.com")],
      rateLimit: {
        globalMaxPerHour: 10,
        perRecipientCooldownMs: 0,
        dedupWindowMs: 0,
      },
    };
    expect(store.reserveDeliveryOperation(input)).toMatchObject({ status: "reserved" });
    expect(store.getProviderDraft("draft_provider_1")).toMatchObject({
      state: "sending",
      approvalGeneration: 1,
      approvalManifestHash,
    });
    store.beginDeliveryDispatch("delivery_draft_1");
    store.settleDeliveryOperation("delivery_draft_1", {
      status: "outcome_unknown",
      code: "provider_timeout_after_write",
    });
    expect(store.getProviderDraft("draft_provider_1")).toMatchObject({
      state: "ambiguous",
      reconciliationState: "required",
    });
    const evidenceHash = hashAgentMailOrchestrationValue("provider search found no send");
    expect(
      store.reconcileDeliveryOperation({
        operationId: "delivery_draft_1",
        evidenceHash,
        resolution: { status: "not_sent" },
      }),
    ).toMatchObject({ state: "reconciled_not_sent", reconciliationHash: evidenceHash });
    expect(store.getProviderDraft("draft_provider_1")).toMatchObject({
      state: "ready",
      approvalGeneration: 1,
      reconciliationState: "confirmed_not_sent",
    });
    expect(store.getProviderDraft("draft_provider_1")?.approvalManifestHash).toBeUndefined();
    expect(() =>
      store.reserveDeliveryOperation({ ...input, operationId: "delivery_draft_2" }),
    ).toThrow(/snapshot or approval generation changed/);
    store.close();
  });

  test("clears draft approval on nonretryable delivery failure and retains active key windows", () => {
    const paths = fixture();
    let now = 1_000;
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      clock: () => now,
    });
    const materialHash = hashAgentMailOrchestrationValue("failed draft material");
    const approvalManifestHash = hashAgentMailOrchestrationValue("failed draft approval");
    store.recordProviderDraft(providerDraftInput({ materialHash }));
    store.reserveDeliveryOperation({
      operationId: "delivery_failed_1",
      action: "send_draft",
      endpoint: "drafts.send",
      draftId: "draft_provider_1",
      draftKind: "new",
      approvalGeneration: 1,
      approvalManifestHash,
      providerRevision: "revision_1",
      materialHash,
      requestHash: hashAgentMailOrchestrationValue("failed draft request"),
      idempotencyKey: "delivery-failed-key-1",
      recipientHashes: [hashAgentMailOrchestrationValue("recipient@example.com")],
      rateLimit: { globalMaxPerHour: 10, perRecipientCooldownMs: 0, dedupWindowMs: 0 },
    });
    store.beginDeliveryDispatch("delivery_failed_1");
    store.settleDeliveryOperation("delivery_failed_1", {
      status: "failed",
      code: "provider_validation_error",
    });
    expect(store.getProviderDraft("draft_provider_1")).toMatchObject({ state: "ready" });
    expect(store.getProviderDraft("draft_provider_1")?.approvalManifestHash).toBeUndefined();

    store.reserveDeliveryOperation(
      directDeliveryInput({
        operationId: "delivery_unknown_active",
        idempotencyKey: "delivery-unknown-key",
        requestHash: hashAgentMailOrchestrationValue("unknown active request"),
        recipientHashes: [hashAgentMailOrchestrationValue("other@example.com")],
      }),
    );
    store.beginDeliveryDispatch("delivery_unknown_active");
    store.settleDeliveryOperation("delivery_unknown_active", {
      status: "outcome_unknown",
      code: "provider_timeout_after_write",
    });
    now = 100_000_000;
    store.compact({ terminalBefore: now, maxRows: 1_000 });
    expect(store.getDeliveryOperation("delivery_unknown_active")?.state).toBe("outcome_unknown");
    const db = new Database(paths.dbPath, { readonly: true });
    expect(
      db
        .query<{ count: number }, []>(
          `SELECT count(*) AS count FROM agentmail_rate_reservations
            WHERE operation_id = 'delivery_unknown_active'`,
        )
        .get()?.count,
    ).toBe(1);
    db.close();
    store.close();
  });

  test("observes externally scheduled and unscheduled provider drafts without authorizing them", () => {
    const paths = fixture();
    let now = 2_000;
    const store = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId: "support@agentmail.to",
      clock: () => now,
    });
    const firstMaterial = hashAgentMailOrchestrationValue("first provider material");
    const secondMaterial = hashAgentMailOrchestrationValue("second provider material");
    store.recordProviderDraft(providerDraftInput({ materialHash: firstMaterial, sendAt: 10_000 }));
    expect(store.getProviderDraft("draft_provider_1")).toMatchObject({
      state: "scheduled",
      sendAt: 10_000,
    });
    now = 3_000;
    const refreshed = store.refreshProviderDraft({
      draftId: "draft_provider_1",
      expectedProviderRevision: "revision_1",
      providerRevision: "revision_2",
      providerUpdatedAt: 2_500,
      materialHash: secondMaterial,
      sendAt: 11_000,
    });
    expect(refreshed).toMatchObject({ state: "scheduled", sendAt: 11_000 });
    for (const kind of ["revise", "delete"] as const) {
      expect(() =>
        store.reserveProviderDraftMutation({
          kind,
          operationId: `${kind}_scheduled_1`,
          draftId: "draft_provider_1",
          expectedProviderRevision: "revision_2",
          expectedMaterialHash: secondMaterial,
          manifestHash: hashAgentMailOrchestrationValue(`${kind} scheduled manifest`),
        }),
      ).toThrow("provider draft cannot be mutated in its current state");
    }
    const unscheduled = store.refreshProviderDraft({
      draftId: "draft_provider_1",
      expectedProviderRevision: "revision_2",
      providerRevision: "revision_3",
      providerUpdatedAt: 3_500,
      materialHash: hashAgentMailOrchestrationValue("third provider material"),
    });
    expect(unscheduled).toMatchObject({ state: "ready" });
    expect(unscheduled.sendAt).toBeUndefined();
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
