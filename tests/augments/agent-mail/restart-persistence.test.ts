import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAgentMailConfig } from "../../../src/augments/agentMail/config";
import type {
  AgentMailDraft,
  AgentMailMessage,
  AgentMailMessageSummary,
  AgentMailProvider,
  AgentMailProviderEvent,
} from "../../../src/augments/agentMail/provider";
import { createAgentMailRuntime } from "../../../src/augments/agentMail/runtime";
import {
  createAgentMailOrchestrationStore,
  hashAgentMailOrchestrationValue,
} from "../../../src/augments/agentMail/store";
import type { NotifyDispatchHost, NotifyInternalDispatchInput } from "../../../src/augments/notify";
import type {
  Augment,
  OutboundMessage,
  PeerIdentity,
  Tool,
  ToolExecuteContext,
  TransportKernel,
  TurnResult,
  TurnState,
  TurnTrigger,
} from "../../../src/types";

const roots: string[] = [];
const inboxId = "support@agentmail.to";
const creatorPeer: PeerIdentity = {
  id: "creator_1",
  kind: "human",
  trustLevel: "creator",
  sourceAugment: "webTransport",
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixturePath(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "auggy-agentmail-restart-"));
  roots.push(root);
  chmodSync(root, 0o700);
  return { root, dbPath: join(root, "orchestration.db") };
}

function message(): AgentMailMessage {
  return {
    inboxId,
    threadId: "thread_1",
    messageId: "message_1",
    sender: "customer@example.com",
    to: [inboxId],
    cc: [],
    subject: "Need help",
    preview: "Please help",
    labels: ["received"],
    timestamp: 1_000,
    updatedAt: 1_000,
    size: 100,
    classification: "received",
    attachmentCount: 0,
    text: "Please help with order 42.",
    replyTo: [],
    references: [],
    attachments: [],
  };
}

function summary(value: AgentMailMessage): AgentMailMessageSummary {
  const {
    text: _text,
    html: _html,
    extractedText: _extractedText,
    extractedHtml: _extractedHtml,
    replyTo: _replyTo,
    inReplyTo: _inReplyTo,
    references: _references,
    attachments: _attachments,
    ...item
  } = value;
  return item;
}

class FakeProvider implements AgentMailProvider {
  messages = new Map<string, AgentMailMessage>();
  drafts = new Map<string, AgentMailDraft>();
  pages: AgentMailMessageSummary[][] = [];
  created: Array<Parameters<AgentMailProvider["createReplyDraft"]>[0]> = [];
  sentDrafts: Array<Parameters<AgentMailProvider["sendDraft"]>[0]> = [];
  sentMessages: Array<Parameters<AgentMailProvider["sendMessage"]>[0]> = [];

  async verifyAccess() {
    return {
      scopeType: "organization",
      scopeId: "org_1",
      organizationId: "org_1",
      configuredInboxId: inboxId,
      emailAddress: inboxId,
    };
  }

  async listMessages(input: { pageToken?: string } = {}) {
    const index = input.pageToken ? Number(input.pageToken) : 0;
    return {
      messages: this.pages[index] ?? [],
      ...(index + 1 < this.pages.length ? { nextPageToken: String(index + 1) } : {}),
    };
  }

  async getMessage(messageId: string) {
    const value = this.messages.get(messageId);
    if (!value) throw new Error("message not found");
    return value;
  }

  async getThread(threadId: string) {
    const messages = [...this.messages.values()].filter((item) => item.threadId === threadId);
    return {
      inboxId,
      threadId,
      lastMessageId: messages.at(-1)?.messageId ?? "none",
      messageCount: messages.length,
      updatedAt: messages.at(-1)?.updatedAt ?? 0,
      messages,
    };
  }

  async listDrafts() {
    return { drafts: [...this.drafts.values()] };
  }

  async createReplyDraft(input: Parameters<AgentMailProvider["createReplyDraft"]>[0]) {
    this.created.push(input);
    const draft: AgentMailDraft = {
      inboxId,
      draftId: "draft_1",
      clientId: input.clientId,
      to: ["customer@example.com"],
      cc: [],
      bcc: [],
      subject: input.subject,
      text: input.text,
      inReplyTo: input.messageId,
      createdAt: 2_000,
      updatedAt: 2_000,
    };
    this.drafts.set(draft.draftId, draft);
    return draft;
  }

  async getDraft(draftId: string) {
    const value = this.drafts.get(draftId);
    if (!value) throw new Error("draft not found");
    return value;
  }

  async updateDraft(input: { draftId: string; text: string }) {
    const current = await this.getDraft(input.draftId);
    const updated = { ...current, text: input.text, updatedAt: current.updatedAt + 1 };
    this.drafts.set(input.draftId, updated);
    return updated;
  }

  async sendDraft(input: Parameters<AgentMailProvider["sendDraft"]>[0]) {
    this.sentDrafts.push(input);
    return { messageId: "sent_reply_1", threadId: "thread_1" };
  }

  async sendMessage(input: Parameters<AgentMailProvider["sendMessage"]>[0]) {
    this.sentMessages.push(input);
    return { messageId: "sent_direct_1", threadId: "thread_direct_1" };
  }

  async connect(_handlers: { onEvent(event: AgentMailProviderEvent): void | Promise<void> }) {
    return { close() {} };
  }
}

function config(dbPath: string, options: { inbound?: boolean; notifications?: boolean } = {}) {
  return validateAgentMailConfig({
    apiKey: "am_test",
    inboxId,
    emailAddress: inboxId,
    dbPath,
    inbound: options.inbound
      ? {
          mode: "websocket",
          allowAnySender: true,
          rateLimit: { globalMaxPerHour: 100, perSenderMaxPerHour: 5 },
        }
      : { mode: "none" },
    replies: options.inbound ? { mode: "review", allowReplyAll: false } : { mode: "disabled" },
    ...(options.notifications ? { notifications: { destination: "creator" } } : {}),
    outbound: {
      allowedTrustLevels: ["creator"],
      subjectPrefix: "[Store] ",
      rateLimit: {
        globalMaxPerHour: 10,
        perRecipientCooldownMs: 0,
        dedupWindowMs: 0,
      },
    },
  });
}

function claimInput() {
  const incoming = message();
  return {
    messageId: incoming.messageId,
    threadId: incoming.threadId,
    classification: incoming.classification,
    sender: incoming.sender,
    senderHash: hashAgentMailOrchestrationValue(incoming.sender),
    payloadHash: hashAgentMailOrchestrationValue(
      JSON.stringify([
        incoming.inboxId,
        incoming.messageId,
        incoming.threadId,
        incoming.timestamp,
        incoming.classification,
        incoming.sender,
      ]),
    ),
    receivedAt: incoming.timestamp,
    policyVersion: 1,
  };
}

function kernel(onTurn: (trigger: TurnTrigger) => Promise<string>): TransportKernel {
  let outbound: ((peer: PeerIdentity, message: OutboundMessage) => Promise<void>) | undefined;
  return {
    async handleInbound(trigger) {
      const text = await onTurn(trigger);
      const response: OutboundMessage = {
        parts: [{ kind: "text", text }],
        contextId: trigger.contextId,
      };
      if (trigger.peer && outbound) await outbound(trigger.peer, response);
      return { turnId: trigger.turnId, success: true, status: "completed", response } as TurnResult;
    },
    onOutbound(callback) {
      outbound = callback;
    },
    getAgentCard: () => ({}) as never,
    quarantineThread: () => true,
    recoverThread: () => true,
    getAugmentRoutes: () => [],
    getAugments: () => [],
  };
}

function creatorTurn(turnId: string, text: string): TurnState {
  return {
    turnId,
    threadId: "console_thread_1",
    peer: creatorPeer,
    toolCallsSoFar: 0,
    turnStartedAt: Date.now(),
    metadata: {},
    trigger: {
      type: "message",
      turnId,
      threadId: "console_thread_1",
      timestamp: Date.now(),
      source: "webTransport",
      peer: creatorPeer,
      payload: {
        parts: [{ kind: "text", text }],
        sourceAugment: "webTransport",
        peer: creatorPeer,
        timestamp: Date.now(),
      },
    },
  };
}

function toolContext(overrides: Partial<ToolExecuteContext> = {}): ToolExecuteContext {
  return {
    turnId: "turn_1",
    threadId: "console_thread_1",
    peer: creatorPeer,
    operationId: "operation_1",
    ...overrides,
  };
}

function requireTool(augment: Augment, name: string): Tool {
  const value = augment.tools?.find((candidate) => candidate.name === name);
  if (!value) throw new Error(`missing tool ${name}`);
  return value;
}

function notificationHost(
  deliveries: NotifyInternalDispatchInput[],
  sent: Set<string>,
): NotifyDispatchHost {
  return {
    destinationMetadata: () => ({ transport: "webhook" }),
    destinationBindingSha256: () => "b".repeat(64),
    inspectInternal(input) {
      return sent.has(input.operationKey)
        ? { status: "sent", attemptCount: 1 }
        : { status: "not_found", attemptCount: 0 };
    },
    async dispatchInternal(input) {
      deliveries.push(input);
      sent.add(input.operationKey);
      return { status: "sent", replayed: false, attemptCount: 1 };
    },
    acknowledgeInternalSettlement() {
      return { status: "acknowledged" };
    },
    authorizeInternalRetry() {
      return { status: "not_found", attemptCount: 0 };
    },
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition did not settle");
}

describe("AgentMail restart persistence", () => {
  test("recovers a just-interrupted inbound claim and reopens the same provider draft projection", async () => {
    const paths = fixturePath();
    const seed = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId,
      clock: () => Date.now() - 1_000,
    });
    seed.claimMessage(claimInput());
    expect(seed.claimNext()).toMatchObject({ state: "processing" });
    seed.close();

    const provider = new FakeProvider();
    const incoming = message();
    provider.messages.set(incoming.messageId, incoming);
    provider.pages = [[summary(incoming)]];
    const first = createAgentMailRuntime(config(paths.dbPath, { inbound: true }), { provider });
    await first.onBoot?.();
    await first.transport?.register(
      kernel(async () => "We can help."),
      "agentMail",
    );
    await first.transport?.ready?.();
    await waitFor(() => provider.created.length === 1);
    expect((await first.adminInfo?.())?.projection).toMatchObject({
      kind: "mail",
      drafts: [{ draftId: "draft_1", state: "ready" }],
    });
    await first.onShutdown?.();

    const restarted = createAgentMailRuntime(config(paths.dbPath), {
      provider: new FakeProvider(),
    });
    await restarted.onBoot?.();
    expect((await restarted.adminInfo?.())?.projection).toMatchObject({
      kind: "mail",
      drafts: [{ draftId: "draft_1", state: "ready" }],
    });
    await restarted.onShutdown?.();
  });

  test("fences crash-interrupted draft and direct sends after reopening the volume", async () => {
    const paths = fixturePath();
    const seed = createAgentMailOrchestrationStore({
      dbPath: paths.dbPath,
      inboxId,
      sendKey: () => "stable-send-key",
    });
    seed.claimMessage(claimInput());
    seed.recordDraft({
      sourceMessageId: "message_1",
      threadId: "thread_1",
      draftId: "draft_1",
      clientId: "auggy.reply.v1.fixture",
      providerUpdatedAt: 2_000,
    });
    seed.approveDraft({
      sourceMessageId: "message_1",
      approvalEvidence: "creator send action",
      expectedUpdatedAt: 2_000,
    });
    seed.reserveDraftSend("message_1");
    seed.reserveOutboundOperation({
      operationId: "operation_1",
      payloadHash: hashAgentMailOrchestrationValue(
        JSON.stringify([["buyer@example.com"], "[Store] Update", "Your order shipped."]),
      ),
    });
    seed.close();

    const provider = new FakeProvider();
    const restarted = createAgentMailRuntime(config(paths.dbPath), { provider });
    await restarted.onBoot?.();
    expect((await restarted.adminInfo?.())?.projection).toMatchObject({
      kind: "mail",
      drafts: [{ draftId: "draft_1", state: "ambiguous" }],
    });

    await restarted.onTurnStart?.(creatorTurn("send_draft", "send draft draft_1"));
    const draftResult = await requireTool(restarted, "send_mail_draft").execute(
      { draftId: "draft_1", expectedUpdatedAt: 2_000 },
      toolContext({ turnId: "send_draft" }),
    );
    expect(draftResult).toMatchObject({ isError: true, outcomeUnknown: true });

    const directResult = await requireTool(restarted, "send_message").execute(
      { to: ["buyer@example.com"], subject: "Update", text: "Your order shipped." },
      toolContext(),
    );
    expect(directResult).toMatchObject({ isError: true, outcomeUnknown: true });
    expect(provider.sentDrafts).toHaveLength(0);
    expect(provider.sentMessages).toHaveLength(0);
    await restarted.onTurnEnd?.({ turnId: "send_draft" } as TurnResult);
    await restarted.onShutdown?.();
  });

  test("repairs one interrupted creator alert and does not redeliver it after another restart", async () => {
    const paths = fixturePath();
    const seed = createAgentMailOrchestrationStore({ dbPath: paths.dbPath, inboxId });
    seed.claimMessage(claimInput());
    seed.recordDraft({
      sourceMessageId: "message_1",
      threadId: "thread_1",
      draftId: "draft_1",
      clientId: "auggy.reply.v1.fixture",
      providerUpdatedAt: 2_000,
    });
    const attention = seed.listCreatorAttention()[0]!;
    seed.bindCreatorAttention({
      attentionId: attention.attentionId,
      destination: "creator",
      destinationBindingHash: "b".repeat(64),
      payloadHash: hashAgentMailOrchestrationValue(
        JSON.stringify([
          "agentmail-attention-payload/v1",
          "agentmail.draft-ready",
          "A new AgentMail reply draft is ready for review. Open Auggy Console or AgentMail.",
          null,
          null,
        ]),
      ),
      maxAttempts: 3,
    });
    const operationKey = seed.claimCreatorAttention(attention.attentionId)!.operationKey;
    seed.close();

    const deliveries: NotifyInternalDispatchInput[] = [];
    const sent = new Set<string>();
    const host = notificationHost(deliveries, sent);
    const first = createAgentMailRuntime(
      config(paths.dbPath, { inbound: true, notifications: true }),
      {
        provider: new FakeProvider(),
      },
    );
    await first.onBoot?.();
    first.creatorAttentionHost.configure({
      dispatchHost: host,
      destination: "creator",
      destinationBindingHash: "b".repeat(64),
      maxAttempts: 3,
    });
    await first.creatorAttentionHost.start();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.operationKey).toBe(operationKey);
    await first.onShutdown?.();

    const second = createAgentMailRuntime(
      config(paths.dbPath, { inbound: true, notifications: true }),
      {
        provider: new FakeProvider(),
      },
    );
    await second.onBoot?.();
    second.creatorAttentionHost.configure({
      dispatchHost: host,
      destination: "creator",
      destinationBindingHash: "b".repeat(64),
      maxAttempts: 3,
    });
    await second.creatorAttentionHost.start();
    expect(deliveries).toHaveLength(1);
    await second.onShutdown?.();

    const reopened = createAgentMailOrchestrationStore({ dbPath: paths.dbPath, inboxId });
    expect(reopened.getCreatorAttention(attention.attentionId)).toMatchObject({
      state: "presented",
      operationKey,
    });
    expect(reopened.getCreatorAttention(attention.attentionId)?.notifyAcknowledgedAt).toBeNumber();
    reopened.close();
  });
});
