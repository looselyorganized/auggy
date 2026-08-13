import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Augment,
  OutboundMessage,
  PeerIdentity,
  Tool,
  ToolExecuteContext,
  ToolResult,
  TransportKernel,
  TurnResult,
  TurnState,
  TurnTrigger,
} from "../../../src/types";
import type { NotifyDispatchHost, NotifyInternalDispatchInput } from "../../../src/augments/notify";
import { validateAgentMailConfig } from "../../../src/augments/agentMail/config";
import { snapshotAgentMailDraft } from "../../../src/augments/agentMail/draft-snapshot";
import { createAgentMailRuntime } from "../../../src/augments/agentMail/runtime";
import {
  AgentMailProviderError,
  type AgentMailAttachmentMetadata,
  type AgentMailDraft,
  type AgentMailMessage,
  type AgentMailMessageSummary,
  type AgentMailPage,
  type AgentMailProvider,
  type AgentMailThreadSummary,
} from "../../../src/augments/agentMail/provider";
import type { HttpClient } from "../../../src/http";
import {
  createAgentMailOrchestrationStore,
  hashAgentMailOrchestrationValue,
  type AgentMailOrchestrationStore,
} from "../../../src/augments/agentMail/store";

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

function message(overrides: Partial<AgentMailMessage> = {}): AgentMailMessage {
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
    ...overrides,
  };
}

function summary(value: AgentMailMessage): AgentMailMessageSummary {
  const {
    text: _text,
    html: _html,
    extractedText: _et,
    extractedHtml: _eh,
    replyTo: _replyTo,
    inReplyTo: _inReplyTo,
    references: _references,
    attachments: _attachments,
    ...item
  } = value;
  return item;
}

function draft(overrides: Partial<AgentMailDraft> = {}): AgentMailDraft {
  return {
    inboxId,
    draftId: "draft_1",
    clientId: "auggy.reply.v1.fixture",
    to: ["customer@example.com"],
    cc: [],
    bcc: [],
    subject: "[Store] Re: Need help",
    text: "We can help.",
    inReplyTo: "message_1",
    updatedAt: 2_000,
    createdAt: 2_000,
    ...overrides,
  };
}

class FakeProvider implements AgentMailProvider {
  sequence: string[] = [];
  pages: AgentMailMessageSummary[][] = [];
  messages = new Map<string, AgentMailMessage>();
  drafts = new Map<string, AgentMailDraft>();
  created: Array<Parameters<AgentMailProvider["createReplyDraft"]>[0]> = [];
  createdDrafts: Array<Parameters<NonNullable<AgentMailProvider["createDraft"]>>[0]> = [];
  updatedDrafts: Array<Parameters<AgentMailProvider["updateDraft"]>[0]> = [];
  deletedDrafts: string[] = [];
  sentDrafts: Array<Parameters<AgentMailProvider["sendDraft"]>[0]> = [];
  sentMessages: Array<Parameters<AgentMailProvider["sendMessage"]>[0]> = [];
  sentReplies: Array<Parameters<NonNullable<AgentMailProvider["replyToMessage"]>>[0]> = [];
  sentForwards: Array<Parameters<NonNullable<AgentMailProvider["forwardMessage"]>>[0]> = [];
  sendDraftErrors: unknown[] = [];
  sendMessageErrors: unknown[] = [];
  replyErrors: unknown[] = [];
  forwardErrors: unknown[] = [];
  messageLabelUpdates: Array<{ messageId: string; addLabels?: string[]; removeLabels?: string[] }> =
    [];
  threadLabelUpdates: Array<{ threadId: string; addLabels?: string[]; removeLabels?: string[] }> =
    [];
  deletedMessages: string[] = [];
  deletedThreads: string[] = [];
  messagePages: AgentMailPage<AgentMailMessageSummary>[] = [];
  threadPages: AgentMailPage<AgentMailThreadSummary>[] = [];
  attachmentMetadata?: AgentMailAttachmentMetadata;
  corruptDraftAfterUpdate = false;
  deleteDraftAfterSend = false;
  getMessageCalls = 0;
  handlers?: Parameters<AgentMailProvider["connect"]>[0];

  async verifyAccess() {
    this.sequence.push("verify");
    return {
      scopeType: "organization",
      scopeId: "org_1",
      organizationId: "org_1",
      configuredInboxId: inboxId,
      emailAddress: inboxId,
    };
  }
  async listMessages(input: { pageToken?: string } = {}) {
    this.sequence.push("list");
    const index = input.pageToken ? Number(input.pageToken) : 0;
    return {
      messages: this.pages[index] ?? [],
      ...(index + 1 < this.pages.length ? { nextPageToken: String(index + 1) } : {}),
    };
  }
  async getMessage(messageId: string) {
    this.getMessageCalls += 1;
    const value = this.messages.get(messageId);
    if (!value) throw new Error("message not found");
    return value;
  }
  async listMailboxMessages(input: { pageToken?: string; limit?: number } = {}) {
    const index = input.pageToken ? Number(input.pageToken) : 0;
    return this.messagePages[index] ?? { items: [], count: 0, limit: input.limit };
  }
  async searchMessages(input: { pageToken?: string; limit?: number }) {
    const index = input.pageToken ? Number(input.pageToken) : 0;
    return this.messagePages[index] ?? { items: [], count: 0, limit: input.limit };
  }
  async updateMessageLabels(input: {
    messageId: string;
    addLabels?: string[];
    removeLabels?: string[];
  }) {
    this.messageLabelUpdates.push(input);
    return { messageId: input.messageId, labels: input.addLabels ?? [] };
  }
  async deleteMessagePermanently(messageId: string) {
    this.deletedMessages.push(messageId);
  }
  async getMessageAttachment() {
    if (!this.attachmentMetadata) throw new Error("attachment not found");
    return this.attachmentMetadata;
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
  async listThreads(input: { pageToken?: string; limit?: number } = {}) {
    const index = input.pageToken ? Number(input.pageToken) : 0;
    return this.threadPages[index] ?? { items: [], count: 0, limit: input.limit };
  }
  async searchThreads(input: { pageToken?: string; limit?: number }) {
    const index = input.pageToken ? Number(input.pageToken) : 0;
    return this.threadPages[index] ?? { items: [], count: 0, limit: input.limit };
  }
  async updateThreadLabels(input: {
    threadId: string;
    addLabels?: string[];
    removeLabels?: string[];
  }) {
    this.threadLabelUpdates.push(input);
    return { threadId: input.threadId, labels: input.addLabels ?? [] };
  }
  async deleteThreadPermanently(threadId: string) {
    this.deletedThreads.push(threadId);
  }
  async listDrafts() {
    return { drafts: [...this.drafts.values()] };
  }
  async listMailboxDrafts(input: { pageToken?: string; limit?: number } = {}) {
    return {
      items: [...this.drafts.values()],
      count: this.drafts.size,
      limit: input.limit,
    };
  }
  async createDraft(input: Parameters<NonNullable<AgentMailProvider["createDraft"]>>[0]) {
    this.createdDrafts.push(input);
    const existing = [...this.drafts.values()].find((item) => item.clientId === input.clientId);
    if (existing) return existing;
    const source = input.sourceMessageId;
    const value = draft({
      draftId: `draft_${this.drafts.size + 1}`,
      clientId: input.clientId,
      to:
        input.to ??
        (input.kind === "replyAll"
          ? ["customer@example.com", "team@example.com"]
          : ["customer@example.com"]),
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      subject: input.subject,
      text: input.text,
      html: input.html,
      inReplyTo: input.kind === "reply" || input.kind === "replyAll" ? source : undefined,
      forwardOf: input.kind === "forward" ? source : undefined,
      updatedAt: 2_000 + this.drafts.size,
    });
    this.drafts.set(value.draftId, value);
    return value;
  }
  async createReplyDraft(input: Parameters<AgentMailProvider["createReplyDraft"]>[0]) {
    this.created.push(input);
    const existing = [...this.drafts.values()].find((item) => item.clientId === input.clientId);
    if (existing) return existing;
    const value = draft({
      draftId: `draft_${this.drafts.size + 1}`,
      clientId: input.clientId,
      text: input.text,
      subject: input.subject,
      inReplyTo: input.messageId,
      updatedAt: 2_000 + this.drafts.size,
    });
    this.drafts.set(value.draftId, value);
    return value;
  }
  async getDraft(draftId: string) {
    const value = this.drafts.get(draftId);
    if (!value) throw new Error("draft not found");
    return value;
  }
  async updateDraft(input: Parameters<AgentMailProvider["updateDraft"]>[0]) {
    this.updatedDrafts.push(input);
    const current = await this.getDraft(input.draftId);
    const updated = {
      ...current,
      ...(input.to === undefined ? {} : { to: input.to ?? [] }),
      ...(input.cc === undefined ? {} : { cc: input.cc ?? [] }),
      ...(input.bcc === undefined ? {} : { bcc: input.bcc ?? [] }),
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo ?? [] }),
      ...(input.subject === undefined ? {} : { subject: input.subject ?? undefined }),
      ...(input.text === undefined ? {} : { text: input.text ?? undefined }),
      ...(input.html === undefined ? {} : { html: input.html ?? undefined }),
      updatedAt: current.updatedAt + 1,
      ...(this.corruptDraftAfterUpdate ? { inReplyTo: "message_changed_after_accept" } : {}),
    };
    this.drafts.set(input.draftId, updated);
    return updated;
  }
  async deleteDraft(draftId: string) {
    this.deletedDrafts.push(draftId);
    this.drafts.delete(draftId);
  }
  async sendDraft(input: Parameters<AgentMailProvider["sendDraft"]>[0]) {
    this.sentDrafts.push(input);
    const error = this.sendDraftErrors.shift();
    if (error !== undefined) throw error;
    if (this.deleteDraftAfterSend) this.drafts.delete(input.draftId);
    return { messageId: "sent_reply_1", threadId: "thread_1" };
  }
  async sendMessage(input: Parameters<AgentMailProvider["sendMessage"]>[0]) {
    this.sentMessages.push(input);
    const error = this.sendMessageErrors.shift();
    if (error !== undefined) throw error;
    return { messageId: "sent_direct_1", threadId: "thread_direct_1" };
  }
  async replyToMessage(input: Parameters<NonNullable<AgentMailProvider["replyToMessage"]>>[0]) {
    this.sentReplies.push(input);
    const error = this.replyErrors.shift();
    if (error !== undefined) throw error;
    return { messageId: "sent_reply_direct_1", threadId: "thread_1" };
  }
  async forwardMessage(input: Parameters<NonNullable<AgentMailProvider["forwardMessage"]>>[0]) {
    this.sentForwards.push(input);
    const error = this.forwardErrors.shift();
    if (error !== undefined) throw error;
    return { messageId: "sent_forward_1", threadId: "thread_1" };
  }
  async connect(handlers: Parameters<AgentMailProvider["connect"]>[0]) {
    this.sequence.push("connect");
    this.handlers = handlers;
    return { close() {} };
  }
}

function fixture(
  options: {
    inbound?: boolean;
    notifications?: boolean;
    provider?: FakeProvider;
    outboundGlobalMaxPerHour?: number;
    clock?: () => number;
    mailbox?: Record<string, unknown>;
    destructive?: Record<string, unknown>;
    drafts?: Record<string, unknown>;
    attachmentClient?: Pick<HttpClient, "get">;
    storeTransform?: (store: AgentMailOrchestrationStore) => AgentMailOrchestrationStore;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "auggy-agentmail-runtime-"));
  roots.push(root);
  const store = createAgentMailOrchestrationStore({
    dbPath: join(root, "orchestration.db"),
    inboxId,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const provider = options.provider ?? new FakeProvider();
  const config = validateAgentMailConfig({
    apiKey: "am_test",
    inboxId,
    emailAddress: inboxId,
    dbPath: join(root, "orchestration.db"),
    inbound: options.inbound
      ? {
          mode: "websocket",
          allowAnySender: true,
          rateLimit: { globalMaxPerHour: 100, perSenderMaxPerHour: 5 },
        }
      : { mode: "none" },
    replies: options.inbound ? { mode: "review", allowReplyAll: false } : { mode: "disabled" },
    ...(options.mailbox === undefined ? {} : { mailbox: options.mailbox }),
    ...(options.destructive === undefined ? {} : { destructive: options.destructive }),
    ...(options.drafts === undefined ? {} : { drafts: options.drafts }),
    ...(options.notifications ? { notifications: { destination: "creator" } } : {}),
    outbound: {
      allowedTrustLevels: ["creator"],
      allowDirectDelivery: true,
      subjectPrefix: "[Store] ",
      rateLimit: {
        globalMaxPerHour: options.outboundGlobalMaxPerHour ?? 10,
        perRecipientCooldownMs: 0,
        dedupWindowMs: 0,
      },
    },
  });
  const augment = createAgentMailRuntime(config, {
    provider,
    store: options.storeTransform?.(store) ?? store,
    ...(options.attachmentClient === undefined
      ? {}
      : { attachmentClient: options.attachmentClient }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return { root, store, provider, augment, config };
}

function recordManagedDraft(
  store: AgentMailOrchestrationStore,
  providerDraft: AgentMailDraft,
  input: { sourceMessageId?: string; threadId?: string; operationId?: string } = {},
): void {
  const kind = providerDraft.forwardOf ? "forward" : providerDraft.inReplyTo ? "reply" : "new";
  const snapshot = snapshotAgentMailDraft(providerDraft, kind);
  const result = store.recordProviderDraft({
    draftId: providerDraft.draftId,
    kind,
    ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    operationId: input.operationId ?? `fixture.${providerDraft.draftId}`,
    clientId: providerDraft.clientId ?? `client.${providerDraft.draftId}`,
    providerRevision: snapshot.providerRevision,
    providerUpdatedAt: snapshot.providerUpdatedAt,
    materialHash: snapshot.materialHash,
  });
  if (result.status === "conflict") throw new Error("fixture draft identity conflict");
}

function notificationHost(deliveries: NotifyInternalDispatchInput[]): NotifyDispatchHost {
  const sent = new Set<string>();
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

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition did not settle");
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

function toolJson(value: string | ToolResult): Record<string, unknown> {
  return JSON.parse(typeof value === "string" ? value : value.content) as Record<string, unknown>;
}

function creatorTurn(turnId: string, threadId: string, text: string): TurnState {
  return {
    turnId,
    threadId,
    peer: creatorPeer,
    toolCallsSoFar: 0,
    turnStartedAt: Date.now(),
    metadata: {},
    trigger: {
      type: "message",
      turnId,
      threadId,
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

describe("AgentMail provider-native runtime", () => {
  test("routes one content-free draft-ready alert through the hardened Notify host", async () => {
    const provider = new FakeProvider();
    const incoming = message();
    provider.messages.set(incoming.messageId, incoming);
    provider.pages = [[summary(incoming)]];
    const f = fixture({ inbound: true, notifications: true, provider });
    const deliveries: NotifyInternalDispatchInput[] = [];
    const dispatchHost = notificationHost(deliveries);

    await f.augment.onBoot?.();
    f.augment.creatorAttentionHost.configure({
      dispatchHost,
      destination: "creator",
      destinationBindingHash: "b".repeat(64),
      maxAttempts: 3,
    });
    await f.augment.creatorAttentionHost.start();
    await f.augment.transport?.register(
      kernel(async () => "We can help."),
      "agentMail",
    );
    await f.augment.transport?.ready?.();
    await waitFor(() => deliveries.length === 1);

    expect(deliveries[0]).toMatchObject({
      source: "agentmail.draft-ready",
      destination: "creator",
      maxAttempts: 3,
      payload: {
        summary:
          "A new AgentMail reply draft is ready for review. Open Auggy Console or AgentMail.",
      },
    });
    expect(JSON.stringify(deliveries)).not.toContain("customer@example.com");
    expect(JSON.stringify(deliveries)).not.toContain("We can help");
    await f.augment.creatorAttentionHost.repair();
    expect(deliveries).toHaveLength(1);

    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("does not let a terminal notification backlog starve new creator attention", async () => {
    let now = 1_000;
    const f = fixture({ inbound: true, notifications: true, clock: () => now });
    for (let index = 0; index < 1_000; index++) {
      now = 1_000 + index;
      const messageId = `historical_message_${index}`;
      const threadId = `historical_thread_${index}`;
      f.store.claimMessage({
        messageId,
        threadId,
        classification: "received",
        sender: `historical-${index}@example.com`,
        senderHash: hashAgentMailOrchestrationValue(`historical-${index}@example.com`),
        payloadHash: hashAgentMailOrchestrationValue(`historical-payload-${index}`),
        receivedAt: now,
        policyVersion: 1,
      });
      recordManagedDraft(
        f.store,
        draft({
          draftId: `historical_draft_${index}`,
          clientId: `historical_client_${index}`,
          inReplyTo: messageId,
          updatedAt: now,
        }),
        { sourceMessageId: messageId, threadId },
      );
      f.store.markThreadDraftsStale(threadId, `newer_${messageId}`);
    }

    now = 10_000;
    f.store.claimMessage({
      messageId: "new_message",
      threadId: "new_thread",
      classification: "received",
      sender: "new@example.com",
      senderHash: hashAgentMailOrchestrationValue("new@example.com"),
      payloadHash: hashAgentMailOrchestrationValue("new-payload"),
      receivedAt: now,
      policyVersion: 1,
    });
    recordManagedDraft(
      f.store,
      draft({
        draftId: "new_draft",
        clientId: "new_client",
        inReplyTo: "new_message",
        updatedAt: now,
      }),
      { sourceMessageId: "new_message", threadId: "new_thread" },
    );

    const deliveries: NotifyInternalDispatchInput[] = [];
    await f.augment.onBoot?.();
    f.augment.creatorAttentionHost.configure({
      dispatchHost: notificationHost(deliveries),
      destination: "creator",
      destinationBindingHash: "b".repeat(64),
      maxAttempts: 3,
    });
    await f.augment.creatorAttentionHost.start();

    expect(deliveries).toHaveLength(1);
    const presented = f.store
      .listCreatorAttention({ states: ["presented"] })
      .find((record) => record.subjectId === "new_draft");
    expect(presented).toBeDefined();
    expect(deliveries[0]?.operationKey).toBe(presented?.operationKey);

    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("rejects a creator notification route that targets its monitored inbox", async () => {
    const f = fixture({ inbound: true, notifications: true });
    const dispatchHost = notificationHost([]);
    await f.augment.onBoot?.();
    expect(() =>
      f.augment.creatorAttentionHost.configure({
        dispatchHost,
        destination: "creator",
        destinationBindingHash: "b".repeat(64),
        maxAttempts: 3,
        agentMailRecipients: [inboxId.toUpperCase()],
      }),
    ).toThrow("would create a mail loop");
    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("runs admitted inbound mail through a normal public turn and creates one provider draft", async () => {
    const provider = new FakeProvider();
    const incoming = message();
    provider.messages.set(incoming.messageId, incoming);
    provider.pages = [[summary(incoming)]];
    const f = fixture({ inbound: true, provider });
    let observed: TurnTrigger | undefined;
    await f.augment.onBoot?.();
    await f.augment.transport?.register(
      kernel(async (trigger) => {
        observed = trigger;
        return "We can help with order 42.";
      }),
      "agentMail",
    );
    await f.augment.transport?.ready?.();
    await waitFor(() => provider.createdDrafts.length === 1);

    expect(observed?.peer).toMatchObject({ trustLevel: "public", publicSubstate: "anonymous" });
    expect(JSON.stringify(observed?.payload)).toContain("UNTRUSTED INBOUND EMAIL");
    expect(provider.createdDrafts[0]).toMatchObject({
      kind: "reply",
      sourceMessageId: "message_1",
      text: "We can help with order 42.",
      subject: "[Store] Re: Need help",
    });
    expect(f.store.getMessage("message_1")?.state).toBe("draft_ready");
    expect(f.store.getProviderDraft("draft_1")?.sourceMessageId).toBe("message_1");
    const projection = (await f.augment.adminInfo?.())?.projection;
    expect(projection).toMatchObject({
      kind: "mail",
      inboxId,
      inboxEmail: inboxId,
      externalConsoleUrl: "https://console.agentmail.to",
      status: { level: "ok", message: "Inbound ready" },
      inbound: {
        mode: "websocket",
        state: "ready",
        senderPolicy: "any",
        allowedSenderCount: 0,
        globalMaxPerHour: 100,
        perSenderMaxPerHour: 5,
      },
      replies: { mode: "review", allowReplyAll: false },
      drafts: [
        {
          draftId: "draft_1",
          sourceMessageId: "message_1",
          threadId: "thread_1",
          state: "ready",
          providerUpdatedAt: "1970-01-01T00:00:02.000Z",
        },
      ],
    });
    expect(JSON.stringify(projection)).not.toContain("We can help");
    expect(JSON.stringify(projection)).not.toContain("customer@example.com");

    await f.augment.onShutdown?.();
    f.store.close();
    const bytes = readFileSync(join(f.root, "orchestration.db"));
    expect(bytes.includes(Buffer.from("Please help with order 42."))).toBe(false);
    expect(bytes.includes(Buffer.from("We can help with order 42."))).toBe(false);
    expect(bytes.includes(Buffer.from("am_test"))).toBe(false);
  });

  test("completes offline recovery through provider-native creator review, revision, and exact send", async () => {
    const provider = new FakeProvider();
    const incoming = message({ text: "E2E private inbound body for order 42." });
    provider.messages.set(incoming.messageId, incoming);
    provider.pages = [[summary(incoming)]];
    const f = fixture({ inbound: true, provider });

    await f.augment.onBoot?.();
    await f.augment.transport?.register(
      kernel(async () => "E2E private first draft."),
      "agentMail",
    );
    await f.augment.transport?.ready?.();
    await waitFor(() => provider.createdDrafts.length === 1);

    expect(provider.sequence.indexOf("connect")).toBeLessThan(provider.sequence.indexOf("list"));
    expect(f.store.getMessage(incoming.messageId)?.state).toBe("draft_ready");

    await provider.handlers?.onEvent({
      type: "message.received",
      eventId: "event_duplicate_after_catchup",
      classification: incoming.classification,
      message: summary(incoming),
    });
    provider.handlers?.onClose?.({ code: 1006 });
    provider.handlers?.onOpen?.();
    await waitFor(() => provider.sequence.filter((item) => item === "list").length === 2);
    expect(provider.createdDrafts).toHaveLength(1);

    const list = requireTool(f.augment, "list_mail_drafts");
    const show = requireTool(f.augment, "show_mail_draft");
    const revise = requireTool(f.augment, "revise_mail_draft");
    const send = requireTool(f.augment, "send_mail_draft");
    expect(JSON.parse(String(await list.execute({ limit: 20 }, toolContext())))).toMatchObject({
      status: "ok",
      drafts: [{ draftId: "draft_1", state: "ready" }],
    });

    await f.augment.onTurnStart?.(creatorTurn("show_e2e", "console_e2e", "show draft draft_1"));
    const firstReview = JSON.parse(
      String(
        await show.execute(
          { draftId: "draft_1" },
          toolContext({ turnId: "show_e2e", threadId: "console_e2e" }),
        ),
      ),
    );
    expect(firstReview).toMatchObject({
      status: "review",
      text: "E2E private first draft.",
      providerUpdatedAt: 2_000,
    });
    await f.augment.onTurnEnd?.({ turnId: "show_e2e" } as TurnResult);

    await f.augment.onTurnStart?.(creatorTurn("revise_e2e", "console_e2e", "revise draft draft_1"));
    const revised = JSON.parse(
      String(
        await revise.execute(
          {
            draftId: "draft_1",
            expectedRevision: firstReview.providerRevision,
            text: "E2E private revised draft.",
          },
          toolContext({ turnId: "revise_e2e", threadId: "console_e2e" }),
        ),
      ),
    );
    expect(revised).toMatchObject({ status: "revised", providerUpdatedAt: 2_001 });
    await f.augment.onTurnEnd?.({ turnId: "revise_e2e" } as TurnResult);

    await f.augment.onTurnStart?.(
      creatorTurn("show_revised_e2e", "console_e2e", "show draft draft_1"),
    );
    const finalReview = JSON.parse(
      String(
        await show.execute(
          { draftId: "draft_1" },
          toolContext({ turnId: "show_revised_e2e", threadId: "console_e2e" }),
        ),
      ),
    );
    expect(finalReview).toMatchObject({
      status: "review",
      text: "E2E private revised draft.",
      providerUpdatedAt: 2_001,
    });
    await f.augment.onTurnEnd?.({ turnId: "show_revised_e2e" } as TurnResult);

    await f.augment.onTurnStart?.(creatorTurn("send_e2e", "console_e2e", "send it"));
    const sendContext = toolContext({ turnId: "send_e2e", threadId: "console_e2e" });
    provider.deleteDraftAfterSend = true;
    expect(
      toolJson(
        await send.execute(
          { draftId: "draft_1", expectedRevision: finalReview.providerRevision },
          sendContext,
        ),
      ),
    ).toMatchObject({ status: "sent", messageId: "sent_reply_1" });
    expect(
      JSON.parse(
        String(
          await send.execute(
            { draftId: "draft_1", expectedRevision: finalReview.providerRevision },
            sendContext,
          ),
        ),
      ),
    ).toMatchObject({ status: "sent", messageId: "sent_reply_1" });
    expect(provider.sentDrafts).toHaveLength(1);
    expect(provider.drafts.has("draft_1")).toBe(false);
    expect(provider.sentDrafts[0]).toMatchObject({ draftId: "draft_1" });
    expect(provider.sentDrafts[0]?.idempotencyKey).toMatch(/^agentmail\.delivery\.v2\./);
    await f.augment.onTurnEnd?.({ turnId: "send_e2e" } as TurnResult);

    await f.augment.onShutdown?.();
    f.store.close();
    const bytes = readFileSync(join(f.root, "orchestration.db"));
    expect(bytes.includes(Buffer.from("E2E private inbound body for order 42."))).toBe(false);
    expect(bytes.includes(Buffer.from("E2E private first draft."))).toBe(false);
    expect(bytes.includes(Buffer.from("E2E private revised draft."))).toBe(false);
    expect(bytes.includes(Buffer.from("am_test"))).toBe(false);
  });

  test("rejects classified mail before content fetch or model inference", async () => {
    const provider = new FakeProvider();
    const incoming = message({ classification: "spam", labels: ["spam"] });
    provider.messages.set(incoming.messageId, incoming);
    provider.pages = [[summary(incoming)]];
    const f = fixture({ inbound: true, provider });
    let turns = 0;
    await f.augment.onBoot?.();
    await f.augment.transport?.register(
      kernel(async () => {
        turns += 1;
        return "should not run";
      }),
      "agentMail",
    );
    await f.augment.transport?.ready?.();
    await waitFor(() => f.store.getMessage("message_1")?.state === "no_reply");
    expect(provider.getMessageCalls).toBe(0);
    expect(turns).toBe(0);
    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("requires a fresh creator identity for review tools and exact send intent", async () => {
    const f = fixture({ drafts: { allowReply: true } });
    const incoming = message();
    f.provider.messages.set(incoming.messageId, incoming);
    const providerDraft = draft();
    f.provider.drafts.set(providerDraft.draftId, providerDraft);
    f.store.claimMessage({
      messageId: incoming.messageId,
      threadId: incoming.threadId,
      classification: "received",
      sender: incoming.sender,
      senderHash: hashAgentMailOrchestrationValue(incoming.sender),
      payloadHash: hashAgentMailOrchestrationValue("payload"),
      receivedAt: incoming.timestamp,
      policyVersion: 1,
    });
    recordManagedDraft(f.store, providerDraft, {
      sourceMessageId: incoming.messageId,
      threadId: incoming.threadId,
    });
    await f.augment.onBoot?.();
    const show = requireTool(f.augment, "show_mail_draft");
    const send = requireTool(f.augment, "send_mail_draft");
    expect(await show.execute({ draftId: "draft_1" }, undefined)).toMatchObject({ isError: true });

    await f.augment.onTurnStart?.(
      creatorTurn("show_turn", "console_thread_1", "show draft draft_1"),
    );
    const shown = await show.execute({ draftId: "draft_1" }, toolContext({ turnId: "show_turn" }));
    expect(String(shown)).toContain("We can help.");
    await f.augment.onTurnEnd?.({ turnId: "show_turn" } as TurnResult);

    await f.augment.onTurnStart?.(
      creatorTurn("bad_send", "console_thread_1", "what do you think?"),
    );
    expect(
      await send.execute(
        {
          draftId: "draft_1",
          expectedRevision: snapshotAgentMailDraft(f.provider.drafts.get("draft_1")!, "reply")
            .providerRevision,
        },
        toolContext({ turnId: "bad_send" }),
      ),
    ).toMatchObject({ isError: true });
    expect(f.provider.sentDrafts).toHaveLength(0);
    await f.augment.onTurnEnd?.({ turnId: "bad_send" } as TurnResult);

    await f.augment.onTurnStart?.(creatorTurn("send_turn", "console_thread_1", "send it"));
    expect(
      toolJson(
        await send.execute(
          {
            draftId: "draft_1",
            expectedRevision: snapshotAgentMailDraft(f.provider.drafts.get("draft_1")!, "reply")
              .providerRevision,
          },
          toolContext({ turnId: "send_turn" }),
        ),
      ),
    ).toMatchObject({ status: "sent", messageId: "sent_reply_1" });
    expect(f.provider.sentDrafts).toHaveLength(1);
    expect(f.provider.sentDrafts[0]).toMatchObject({ draftId: "draft_1" });
    expect(f.provider.sentDrafts[0]?.idempotencyKey).toMatch(/^agentmail\.delivery\.v2\./);
    await f.augment.onTurnEnd?.({ turnId: "send_turn" } as TurnResult);
    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("direct send enforces identity and replays one durable operation without a duplicate send", async () => {
    const f = fixture();
    await f.augment.onBoot?.();
    const send = requireTool(f.augment, "send_message");
    const input = { to: ["buyer@example.com"], subject: "Update", text: "Your order shipped." };
    expect(await send.execute(input, undefined)).toMatchObject({ isError: true });
    expect(
      await send.execute(
        input,
        toolContext({
          peer: {
            id: "mail_public",
            kind: "human",
            trustLevel: "public",
            sourceAugment: "agentMail",
          },
        }),
      ),
    ).toMatchObject({ isError: true });
    await f.augment.onTurnStart?.(
      creatorTurn("direct_send", "console_thread_1", "send email to buyer@example.com"),
    );
    expect(
      toolJson(await send.execute(input, toolContext({ turnId: "direct_send" }))),
    ).toMatchObject({ status: "sent", messageId: "sent_direct_1" });
    expect(
      toolJson(await send.execute(input, toolContext({ turnId: "direct_send" }))),
    ).toMatchObject({ status: "sent", messageId: "sent_direct_1" });
    expect(f.provider.sentMessages).toHaveLength(1);
    expect(f.provider.sentMessages[0]?.subject).toBe("[Store] Update");
    expect(
      await send.execute(
        { ...input, text: "A changed body under the same operation." },
        toolContext({ turnId: "direct_send" }),
      ),
    ).toMatchObject({ isError: true });
    expect(f.provider.sentMessages).toHaveLength(1);
    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("retries a rate-limited direct send across turns with its exact persisted provider key", async () => {
    let now = 10_000;
    const provider = new FakeProvider();
    provider.sendMessageErrors.push(
      new AgentMailProviderError({
        code: "provider_rate_limited",
        operation: "send message",
        phase: "sending",
        retryable: true,
        nextAction: "Retry later.",
        retryAfterSeconds: 2,
      }),
    );
    const f = fixture({ provider, clock: () => now });
    await f.augment.onBoot?.();
    const send = requireTool(f.augment, "send_message");
    const retry = requireTool(f.augment, "retry_mail_delivery");
    const request = { to: ["buyer@example.com"], subject: "Update", text: "Shipped." };
    await f.augment.onTurnStart?.(
      creatorTurn("send_rate_1", "console_thread_1", "send email to buyer@example.com"),
    );
    const first = toolJson(
      await send.execute(request, toolContext({ turnId: "send_rate_1", operationId: "rate_op_1" })),
    );
    expect(first).toMatchObject({
      status: "retryable",
      operationId: "rate_op_1",
      retryAfter: 12_000,
      retryCommand: "retry mail delivery rate_op_1",
    });
    expect(provider.sentMessages).toHaveLength(1);
    const originalKey = provider.sentMessages[0]?.idempotencyKey;

    await f.augment.onTurnStart?.(
      creatorTurn("retry_early", "console_thread_1", "retry mail delivery rate_op_1"),
    );
    expect(
      await retry.execute(
        { action: "send_message", operationId: "rate_op_1", request },
        toolContext({ turnId: "retry_early", operationId: "new_turn_operation" }),
      ),
    ).toMatchObject({ isError: true });
    expect(provider.sentMessages).toHaveLength(1);

    now = 12_001;
    await f.augment.onTurnStart?.(
      creatorTurn("retry_exact", "console_thread_1", "retry mail delivery rate_op_1"),
    );
    expect(
      toolJson(
        await retry.execute(
          { action: "send_message", operationId: "rate_op_1", request },
          toolContext({ turnId: "retry_exact", operationId: "another_new_turn_operation" }),
        ),
      ),
    ).toMatchObject({ status: "sent", messageId: "sent_direct_1" });
    expect(provider.sentMessages).toHaveLength(2);
    expect(provider.sentMessages[1]?.idempotencyKey).toBe(originalKey);
    expect(f.store.getDeliveryOperation("rate_op_1")).toMatchObject({
      state: "sent",
      attemptCount: 2,
      idempotencyKey: originalKey,
    });
    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("uses a bounded retry fallback and rejects changed or unauthorized retry requests", async () => {
    let now = 20_000;
    const provider = new FakeProvider();
    provider.sendMessageErrors.push(
      new AgentMailProviderError({
        code: "provider_rate_limited",
        operation: "send message",
        phase: "sending",
        retryable: true,
        nextAction: "Retry later.",
      }),
    );
    const f = fixture({ provider, clock: () => now });
    await f.augment.onBoot?.();
    const send = requireTool(f.augment, "send_message");
    const retry = requireTool(f.augment, "retry_mail_delivery");
    const request = { to: ["buyer@example.com"], subject: "Update", text: "Shipped." };
    await f.augment.onTurnStart?.(
      creatorTurn("send_fallback", "console_thread_1", "send email to buyer@example.com"),
    );
    expect(
      toolJson(
        await send.execute(
          request,
          toolContext({ turnId: "send_fallback", operationId: "fallback_op_1" }),
        ),
      ),
    ).toMatchObject({ status: "retryable", retryAfter: 80_000 });
    now = 80_001;

    await f.augment.onTurnStart?.(
      creatorTurn("retry_wrong_words", "console_thread_1", "please retry that email"),
    );
    expect(
      await retry.execute(
        { action: "send_message", operationId: "fallback_op_1", request },
        toolContext({ turnId: "retry_wrong_words" }),
      ),
    ).toMatchObject({ isError: true });
    expect(provider.sentMessages).toHaveLength(1);

    await f.augment.onTurnStart?.(
      creatorTurn("retry_changed", "console_thread_1", "retry mail delivery fallback_op_1"),
    );
    expect(
      await retry.execute(
        {
          action: "send_message",
          operationId: "fallback_op_1",
          request: { ...request, text: "Changed after approval." },
        },
        toolContext({ turnId: "retry_changed" }),
      ),
    ).toMatchObject({ isError: true });
    expect(provider.sentMessages).toHaveLength(1);

    expect(
      await retry.execute(
        { action: "send_message", operationId: "fallback_op_1", request },
        toolContext({
          turnId: "retry_changed",
          peer: {
            id: "public",
            kind: "human",
            trustLevel: "public",
            sourceAugment: "webTransport",
          },
        }),
      ),
    ).toMatchObject({ isError: true });
    expect(provider.sentMessages).toHaveLength(1);
    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("never retries an outcome-unknown delivery", async () => {
    const provider = new FakeProvider();
    provider.sendMessageErrors.push(
      new AgentMailProviderError({
        code: "mutation_ambiguous",
        operation: "send message",
        phase: "sending",
        retryable: false,
        nextAction: "Reconcile before retrying.",
      }),
    );
    const f = fixture({ provider });
    await f.augment.onBoot?.();
    const send = requireTool(f.augment, "send_message");
    const retry = requireTool(f.augment, "retry_mail_delivery");
    const request = { to: ["buyer@example.com"], subject: "Update", text: "Shipped." };
    await f.augment.onTurnStart?.(
      creatorTurn("send_unknown", "console_thread_1", "send email to buyer@example.com"),
    );
    expect(
      await send.execute(
        request,
        toolContext({ turnId: "send_unknown", operationId: "unknown_op_1" }),
      ),
    ).toMatchObject({ isError: true, outcomeUnknown: true });
    await f.augment.onTurnStart?.(
      creatorTurn("retry_unknown", "console_thread_1", "retry mail delivery unknown_op_1"),
    );
    expect(
      await retry.execute(
        { action: "send_message", operationId: "unknown_op_1", request },
        toolContext({ turnId: "retry_unknown" }),
      ),
    ).toMatchObject({ isError: true, outcomeUnknown: true });
    expect(provider.sentMessages).toHaveLength(1);
    expect(f.store.getDeliveryOperation("unknown_op_1")?.state).toBe("outcome_unknown");
    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("revalidates a rate-limited draft before retry and refuses provider drift", async () => {
    let now = 30_000;
    const provider = new FakeProvider();
    const managed = draft({
      draftId: "draft_retry_1",
      clientId: "client_retry_1",
      inReplyTo: undefined,
      subject: "[Store] Update",
    });
    provider.drafts.set(managed.draftId, managed);
    provider.sendDraftErrors.push(
      new AgentMailProviderError({
        code: "provider_rate_limited",
        operation: "send draft",
        phase: "sending",
        retryable: true,
        nextAction: "Retry later.",
        retryAfterSeconds: 1,
      }),
    );
    const f = fixture({ provider, clock: () => now, drafts: { allowNew: true } });
    recordManagedDraft(f.store, managed);
    await f.augment.onBoot?.();
    const send = requireTool(f.augment, "send_mail_draft");
    const retry = requireTool(f.augment, "retry_mail_delivery");
    const expectedRevision = snapshotAgentMailDraft(managed, "new").providerRevision;
    await f.augment.onTurnStart?.(
      creatorTurn("send_draft_rate", "console_thread_1", "send draft draft_retry_1"),
    );
    expect(
      toolJson(
        await send.execute(
          { draftId: managed.draftId, expectedRevision },
          toolContext({ turnId: "send_draft_rate", operationId: "draft_retry_op_1" }),
        ),
      ),
    ).toMatchObject({ status: "retryable", operationId: "draft_retry_op_1" });
    expect(f.store.getProviderDraft(managed.draftId)?.state).toBe("retryable");
    expect((await f.augment.adminInfo?.())?.projection).toMatchObject({
      kind: "mail",
      drafts: [
        {
          draftId: managed.draftId,
          state: "retryable",
          retryOperationId: "draft_retry_op_1",
          retryAt: "1970-01-01T00:00:31.000Z",
        },
      ],
    });
    const originalKey = provider.sentDrafts[0]?.idempotencyKey;
    provider.drafts.set(managed.draftId, {
      ...managed,
      text: "Externally changed",
      sendAt: 60_000,
      updatedAt: 3_000,
    });
    now = 31_001;
    await f.augment.onTurnStart?.(
      creatorTurn(
        "retry_draft_changed",
        "console_thread_1",
        "retry mail delivery draft_retry_op_1",
      ),
    );
    const retryChanged = await retry.execute(
      { action: "send_draft", operationId: "draft_retry_op_1" },
      toolContext({ turnId: "retry_draft_changed" }),
    );
    expect(retryChanged).toMatchObject({ isError: true });
    expect(JSON.stringify(retryChanged)).toContain("scheduled in AgentMail");
    expect(provider.sentDrafts).toHaveLength(1);
    expect(provider.sentDrafts[0]?.idempotencyKey).toBe(originalKey);
    expect(f.store.getDeliveryOperation("draft_retry_op_1")?.state).toBe("retryable");
    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("retries an unchanged managed draft with its original provider key", async () => {
    let now = 40_000;
    const provider = new FakeProvider();
    const managed = draft({ draftId: "draft_retry_ok", clientId: "client_retry_ok" });
    provider.drafts.set(managed.draftId, managed);
    provider.messages.set("message_1", message());
    provider.sendDraftErrors.push(
      new AgentMailProviderError({
        code: "provider_rate_limited",
        operation: "send draft",
        phase: "sending",
        retryable: true,
        nextAction: "Retry later.",
        retryAfterSeconds: 1,
      }),
    );
    const f = fixture({ provider, clock: () => now, drafts: { allowReply: true } });
    recordManagedDraft(f.store, managed, { sourceMessageId: "message_1", threadId: "thread_1" });
    await f.augment.onBoot?.();
    const send = requireTool(f.augment, "send_mail_draft");
    const retry = requireTool(f.augment, "retry_mail_delivery");
    const expectedRevision = snapshotAgentMailDraft(managed, "reply").providerRevision;
    await f.augment.onTurnStart?.(
      creatorTurn("send_draft_retry", "console_thread_1", "send draft draft_retry_ok"),
    );
    expect(
      toolJson(
        await send.execute(
          { draftId: managed.draftId, expectedRevision },
          toolContext({ turnId: "send_draft_retry", operationId: "draft_retry_ok_op" }),
        ),
      ),
    ).toMatchObject({ status: "retryable" });
    const originalKey = provider.sentDrafts[0]?.idempotencyKey;
    now = 41_001;
    await f.augment.onTurnStart?.(
      creatorTurn("retry_draft_ok", "console_thread_1", "retry mail delivery draft_retry_ok_op"),
    );
    expect(
      toolJson(
        await retry.execute(
          { action: "send_draft", operationId: "draft_retry_ok_op" },
          toolContext({ turnId: "retry_draft_ok", operationId: "new_kernel_retry_op" }),
        ),
      ),
    ).toMatchObject({ status: "sent", messageId: "sent_reply_1" });
    expect(provider.sentDrafts).toHaveLength(2);
    expect(provider.sentDrafts[1]?.idempotencyKey).toBe(originalKey);
    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("fences provider acceptance when local delivery settlement fails", async () => {
    let failSettlement = true;
    const f = fixture({
      storeTransform: (store) =>
        new Proxy(store, {
          get(target, property, receiver) {
            if (property === "settleDeliveryOperation") {
              return (
                ...args: Parameters<AgentMailOrchestrationStore["settleDeliveryOperation"]>
              ) => {
                if (failSettlement && args[1].status === "sent") {
                  failSettlement = false;
                  throw new Error("simulated disk failure");
                }
                return target.settleDeliveryOperation(...args);
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    await f.augment.onBoot?.();
    const send = requireTool(f.augment, "send_message");
    await f.augment.onTurnStart?.(
      creatorTurn("settle_failure", "console_thread_1", "send email to buyer@example.com"),
    );
    const result = await send.execute(
      { to: ["buyer@example.com"], subject: "Update", text: "Shipped." },
      toolContext({ turnId: "settle_failure", operationId: "settle_failure_1" }),
    );
    expect(result).toMatchObject({ isError: true, outcomeUnknown: true });
    expect(f.provider.sentMessages).toHaveLength(1);
    expect(f.store.getDeliveryOperation("settle_failure_1")?.state).toBe("outcome_unknown");
    f.provider.messages.set(
      "sent_direct_1",
      message({ messageId: "sent_direct_1", threadId: "thread_direct_1" }),
    );
    await f.augment.onTurnStart?.(
      creatorTurn(
        "settle_reconcile",
        "console_thread_1",
        "reconcile delivery settle_failure_1 as sent",
      ),
    );
    expect(
      toolJson(
        await requireTool(f.augment, "reconcile_mail_delivery").execute(
          {
            operationId: "settle_failure_1",
            resolution: "sent",
            messageId: "sent_direct_1",
            threadId: "thread_direct_1",
          },
          toolContext({ turnId: "settle_reconcile" }),
        ),
      ),
    ).toMatchObject({ status: "sent", messageId: "sent_direct_1" });
    await f.augment.onShutdown?.();
    f.store.close();

    const restartedProvider = new FakeProvider();
    const restarted = createAgentMailRuntime(f.config, { provider: restartedProvider });
    await restarted.onBoot?.();
    await restarted.onTurnStart?.(
      creatorTurn("settle_retry", "console_thread_1", "send email to buyer@example.com"),
    );
    expect(
      toolJson(
        await requireTool(restarted, "send_message").execute(
          { to: ["buyer@example.com"], subject: "Update", text: "Shipped." },
          toolContext({ turnId: "settle_retry", operationId: "settle_failure_1" }),
        ),
      ),
    ).toMatchObject({ status: "sent", messageId: "sent_direct_1", replayed: true });
    expect(restartedProvider.sentMessages).toHaveLength(0);
    await restarted.onShutdown?.();
  });

  test("direct reply and forward require exact creator intent and preserve source identity", async () => {
    const f = fixture({ drafts: { allowForward: true } });
    const source = message({ replyTo: ["reply@example.com"] });
    f.provider.messages.set(source.messageId, source);
    await f.augment.onBoot?.();
    const reply = requireTool(f.augment, "reply_to_mail_message");
    expect(
      await reply.execute(
        { messageId: source.messageId, text: "Thanks" },
        toolContext({ operationId: "reply_without_intent" }),
      ),
    ).toMatchObject({ isError: true });
    await f.augment.onTurnStart?.(
      creatorTurn("reply_exact", "console_thread_1", `reply to message ${source.messageId}`),
    );
    expect(
      toolJson(
        await reply.execute(
          { messageId: source.messageId, text: "Thanks" },
          toolContext({ turnId: "reply_exact", operationId: "reply_exact_1" }),
        ),
      ),
    ).toMatchObject({ status: "sent", messageId: "sent_reply_direct_1" });
    expect(f.provider.sentReplies[0]).toMatchObject({
      messageId: source.messageId,
      text: "Thanks",
    });

    const forward = requireTool(f.augment, "forward_mail_message");
    await f.augment.onTurnStart?.(
      creatorTurn(
        "forward_exact",
        "console_thread_1",
        `forward message ${source.messageId} to owner@example.com`,
      ),
    );
    expect(
      toolJson(
        await forward.execute(
          { messageId: source.messageId, to: ["owner@example.com"], text: "FYI" },
          toolContext({ turnId: "forward_exact", operationId: "forward_exact_1" }),
        ),
      ),
    ).toMatchObject({ status: "sent", messageId: "sent_forward_1" });
    expect(f.provider.sentForwards[0]).toMatchObject({
      messageId: source.messageId,
      to: ["owner@example.com"],
    });
    expect(f.augment.tools?.some((tool) => tool.name.includes("reply_all"))).toBe(false);
    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("retries direct reply and forward through their exact AgentMail idempotency keys", async () => {
    let now = 50_000;
    const provider = new FakeProvider();
    const limited = () =>
      new AgentMailProviderError({
        code: "provider_rate_limited",
        operation: "deliver mail",
        phase: "sending",
        retryable: true,
        nextAction: "Retry later.",
        retryAfterSeconds: 1,
      });
    provider.replyErrors.push(limited());
    provider.forwardErrors.push(limited());
    const source = message({ replyTo: ["reply@example.com"] });
    provider.messages.set(source.messageId, source);
    const f = fixture({ provider, clock: () => now, drafts: { allowForward: true } });
    await f.augment.onBoot?.();
    const reply = requireTool(f.augment, "reply_to_mail_message");
    const forward = requireTool(f.augment, "forward_mail_message");
    const retry = requireTool(f.augment, "retry_mail_delivery");

    await f.augment.onTurnStart?.(
      creatorTurn("reply_limited", "console_thread_1", `reply to message ${source.messageId}`),
    );
    await reply.execute(
      { messageId: source.messageId, text: "Thanks" },
      toolContext({ turnId: "reply_limited", operationId: "reply_retry_op" }),
    );
    const replyKey = provider.sentReplies[0]?.idempotencyKey;
    now = 51_001;
    await f.augment.onTurnStart?.(
      creatorTurn("reply_retry", "console_thread_1", "retry mail delivery reply_retry_op"),
    );
    expect(
      toolJson(
        await retry.execute(
          {
            action: "reply",
            operationId: "reply_retry_op",
            request: { messageId: source.messageId, text: "Thanks" },
          },
          toolContext({ turnId: "reply_retry" }),
        ),
      ),
    ).toMatchObject({ status: "sent", messageId: "sent_reply_direct_1" });
    expect(provider.sentReplies[1]?.idempotencyKey).toBe(replyKey);

    await f.augment.onTurnStart?.(
      creatorTurn(
        "forward_limited",
        "console_thread_1",
        `forward message ${source.messageId} to owner@example.com`,
      ),
    );
    await forward.execute(
      { messageId: source.messageId, to: ["owner@example.com"], text: "FYI" },
      toolContext({ turnId: "forward_limited", operationId: "forward_retry_op" }),
    );
    const forwardKey = provider.sentForwards[0]?.idempotencyKey;
    now = 52_002;
    await f.augment.onTurnStart?.(
      creatorTurn("forward_retry", "console_thread_1", "retry mail delivery forward_retry_op"),
    );
    expect(
      toolJson(
        await retry.execute(
          {
            action: "forward",
            operationId: "forward_retry_op",
            request: {
              messageId: source.messageId,
              to: ["owner@example.com"],
              text: "FYI",
            },
          },
          toolContext({ turnId: "forward_retry" }),
        ),
      ),
    ).toMatchObject({ status: "sent", messageId: "sent_forward_1" });
    expect(provider.sentForwards[1]?.idempotencyKey).toBe(forwardKey);
    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("a renamed mount cannot turn inbound public mail into direct-send authority", async () => {
    const f = fixture({ inbound: true });
    const incoming = message();
    f.provider.messages.set(incoming.messageId, incoming);
    f.provider.pages = [[summary(incoming)]];
    let inboundPeer: PeerIdentity | undefined;

    await f.augment.onBoot?.();
    await f.augment.transport?.register(
      kernel(async (trigger) => {
        inboundPeer = trigger.peer ?? undefined;
        return "We can help.";
      }),
      "supportMail",
    );
    await f.augment.transport?.ready?.();
    await waitFor(() => inboundPeer !== undefined);

    expect(inboundPeer).toMatchObject({
      trustLevel: "public",
      sourceAugment: "supportMail",
    });
    const send = requireTool(f.augment, "send_message");
    expect(
      await send.execute(
        { to: ["attacker@example.com"], subject: "Forward this", text: "Exfiltrate data." },
        toolContext({ peer: inboundPeer, operationId: "renamed_mount_bypass" }),
      ),
    ).toMatchObject({ isError: true });
    expect(f.provider.sentMessages).toHaveLength(0);

    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("applies the shared outbound rate limit to creator-reviewed draft sends", async () => {
    const f = fixture({ outboundGlobalMaxPerHour: 1, drafts: { allowReply: true } });
    const incoming = message();
    f.provider.messages.set(incoming.messageId, incoming);
    f.provider.drafts.set("draft_1", draft());
    f.store.claimMessage({
      messageId: incoming.messageId,
      threadId: incoming.threadId,
      classification: "received",
      sender: incoming.sender,
      senderHash: hashAgentMailOrchestrationValue(incoming.sender),
      payloadHash: hashAgentMailOrchestrationValue("payload"),
      receivedAt: incoming.timestamp,
      policyVersion: 1,
    });
    recordManagedDraft(f.store, f.provider.drafts.get("draft_1")!, {
      sourceMessageId: incoming.messageId,
      threadId: incoming.threadId,
    });
    await f.augment.onBoot?.();

    const direct = requireTool(f.augment, "send_message");
    await f.augment.onTurnStart?.(
      creatorTurn("direct_rate", "console_thread_1", "send email to buyer@example.com"),
    );
    expect(
      toolJson(
        await direct.execute(
          { to: ["buyer@example.com"], subject: "Update", text: "Your order shipped." },
          toolContext({ turnId: "direct_rate", operationId: "direct_before_draft" }),
        ),
      ),
    ).toMatchObject({ status: "sent", messageId: "sent_direct_1" });

    const sendDraft = requireTool(f.augment, "send_mail_draft");
    await f.augment.onTurnStart?.(
      creatorTurn("rate_limited_draft", "console_thread_1", "send draft draft_1"),
    );
    const result = await sendDraft.execute(
      {
        draftId: "draft_1",
        expectedRevision: snapshotAgentMailDraft(f.provider.drafts.get("draft_1")!, "reply")
          .providerRevision,
      },
      toolContext({ turnId: "rate_limited_draft" }),
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("rate limited (global)");
    expect(f.provider.sentDrafts).toHaveLength(0);
    expect(f.store.getProviderDraft("draft_1")?.state).toBe("ready");

    await f.augment.onTurnEnd?.({ turnId: "rate_limited_draft" } as TurnResult);
    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("revises only a freshly shown plain-text draft and invalidates the old provider version", async () => {
    const f = fixture({ drafts: { allowReply: true } });
    const incoming = message();
    f.provider.messages.set(incoming.messageId, incoming);
    f.provider.drafts.set("draft_1", draft());
    f.store.claimMessage({
      messageId: incoming.messageId,
      threadId: incoming.threadId,
      classification: "received",
      sender: incoming.sender,
      senderHash: hashAgentMailOrchestrationValue(incoming.sender),
      payloadHash: hashAgentMailOrchestrationValue("payload"),
      receivedAt: incoming.timestamp,
      policyVersion: 1,
    });
    recordManagedDraft(f.store, f.provider.drafts.get("draft_1")!, {
      sourceMessageId: incoming.messageId,
      threadId: incoming.threadId,
    });
    await f.augment.onBoot?.();
    const revise = requireTool(f.augment, "revise_mail_draft");
    const expectedRevision = snapshotAgentMailDraft(
      f.provider.drafts.get("draft_1")!,
      "reply",
    ).providerRevision;

    await f.augment.onTurnStart?.(
      creatorTurn("show_only", "console_thread_1", "show draft draft_1"),
    );
    expect(
      await revise.execute(
        { draftId: "draft_1", expectedRevision, text: "Unauthorized change." },
        toolContext({ turnId: "show_only" }),
      ),
    ).toMatchObject({ isError: true });
    await f.augment.onTurnEnd?.({ turnId: "show_only" } as TurnResult);

    await f.augment.onTurnStart?.(
      creatorTurn("generic_revise", "another_console_thread", "revise a mail draft"),
    );
    expect(
      await revise.execute(
        { draftId: "draft_1", expectedRevision, text: "Unauthorized change." },
        toolContext({ turnId: "generic_revise", threadId: "another_console_thread" }),
      ),
    ).toMatchObject({ isError: true });
    await f.augment.onTurnEnd?.({ turnId: "generic_revise" } as TurnResult);

    await f.augment.onTurnStart?.(
      creatorTurn("revise_turn", "console_thread_1", "revise draft draft_1 to be concise"),
    );
    expect(
      toolJson(
        await revise.execute(
          {
            draftId: "draft_1",
            expectedRevision: toolJson(
              await requireTool(f.augment, "show_mail_draft").execute(
                { draftId: "draft_1" },
                toolContext({ turnId: "revise_turn" }),
              ),
            ).providerRevision,
            text: "Concise reply.",
          },
          toolContext({ turnId: "revise_turn" }),
        ),
      ),
    ).toMatchObject({ status: "revised" });
    expect(f.provider.drafts.get("draft_1")?.text).toBe("Concise reply.");
    expect(f.store.getProviderDraft("draft_1")).toMatchObject({
      state: "ready",
      providerUpdatedAt: 2_001,
    });
    await f.augment.onTurnEnd?.({ turnId: "revise_turn" } as TurnResult);
    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("fences a draft mutation when provider acceptance is followed by verification drift", async () => {
    const f = fixture({ drafts: { allowReply: true } });
    const incoming = message();
    f.provider.messages.set(incoming.messageId, incoming);
    f.provider.drafts.set("draft_1", draft());
    f.store.claimMessage({
      messageId: incoming.messageId,
      threadId: incoming.threadId,
      classification: "received",
      sender: incoming.sender,
      senderHash: hashAgentMailOrchestrationValue(incoming.sender),
      payloadHash: hashAgentMailOrchestrationValue("payload"),
      receivedAt: incoming.timestamp,
      policyVersion: 1,
    });
    recordManagedDraft(f.store, f.provider.drafts.get("draft_1")!, {
      sourceMessageId: incoming.messageId,
      threadId: incoming.threadId,
    });
    await f.augment.onBoot?.();
    await f.augment.onTurnStart?.(
      creatorTurn("revise_drift", "console_thread_1", "revise draft draft_1"),
    );
    const shown = toolJson(
      await requireTool(f.augment, "show_mail_draft").execute(
        { draftId: "draft_1" },
        toolContext({ turnId: "revise_drift" }),
      ),
    );
    f.provider.corruptDraftAfterUpdate = true;
    const result = await requireTool(f.augment, "revise_mail_draft").execute(
      {
        draftId: "draft_1",
        expectedRevision: shown.providerRevision,
        text: "Provider accepted this body.",
      },
      toolContext({ turnId: "revise_drift", operationId: "revise_post_accept_1" }),
    );
    expect(result).toMatchObject({ isError: true, outcomeUnknown: true });
    expect(f.store.getProviderDraftMutation("revise_post_accept_1")).toMatchObject({
      state: "outcome_unknown",
    });
    expect(f.store.getProviderDraft("draft_1")).toMatchObject({ state: "ambiguous" });
    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("keeps mailbox reads creator-only, bounded, paginated, and distinct from provider errors", async () => {
    const f = fixture({ mailbox: { maxListResults: 2 } });
    const first = message();
    const second = message({ messageId: "message_2", preview: "x".repeat(10_000) });
    f.provider.messages.set(first.messageId, first);
    f.provider.messages.set(second.messageId, second);
    f.provider.messagePages = [
      {
        items: [summary(first), summary(second)],
        count: 2,
        limit: 2,
        nextPageToken: "next_1",
      },
      { items: [], count: 0, limit: 2 },
    ];
    const list = requireTool(f.augment, "list_mail_messages");
    const publicResult = await list.execute(
      { limit: 2, includeTrash: false },
      toolContext({ peer: { ...creatorPeer, trustLevel: "public" } }),
    );
    expect(publicResult).toMatchObject({ isError: true });

    const firstPage = toolJson(
      await list.execute({ limit: 2, includeTrash: false }, toolContext()),
    );
    expect(firstPage).toMatchObject({ status: "ok", empty: false, nextPageToken: "next_1" });
    expect(firstPage.messages).toHaveLength(2);
    expect(JSON.stringify(firstPage).length).toBeLessThan(8_000);
    expect(
      toolJson(
        await list.execute({ limit: 2, includeTrash: false, pageToken: "1" }, toolContext()),
      ),
    ).toMatchObject({ status: "ok", empty: true, messages: [] });

    f.provider.searchMessages = async () => {
      throw new Error("provider response includes private content");
    };
    const search = requireTool(f.augment, "search_mail_messages");
    const failure = await search.execute({ query: "order", limit: 2 }, toolContext());
    expect(failure).toMatchObject({ isError: true });
    expect(JSON.stringify(failure)).toContain("runtime_failure");
    expect(JSON.stringify(failure)).not.toContain("private content");
    f.store.close();
  });

  test("reads bounded thread content and fails closed when an optional provider method is absent", async () => {
    const f = fixture({ mailbox: { maxListResults: 1 } });
    const first = message({ text: "old" });
    const second = message({ messageId: "message_2", text: "new" });
    f.provider.messages.set(first.messageId, first);
    f.provider.messages.set(second.messageId, second);
    const get = requireTool(f.augment, "get_mail_thread");
    const result = toolJson(await get.execute({ threadId: "thread_1" }, toolContext()));
    expect(result).toMatchObject({ status: "ok", messagesTruncated: true });
    expect(result.messages).toHaveLength(1);
    expect(JSON.stringify(result)).toContain("message_2");

    (f.provider as unknown as { listThreads?: AgentMailProvider["listThreads"] }).listThreads =
      undefined;
    const list = requireTool(f.augment, "list_mail_threads");
    const unavailable = await list.execute({ limit: 1, includeTrash: false }, toolContext());
    expect(unavailable).toMatchObject({ isError: true });
    expect(JSON.stringify(unavailable)).toContain("unavailable");
    f.store.close();
  });

  test("normalizes custom labels and separates reversible trash from permanent delete", async () => {
    const f = fixture({
      mailbox: {
        allowLabelMutation: true,
        allowedLabels: ["important", "customer"],
        allowTrashRestore: true,
      },
    });
    f.provider.messages.set("message_1", message());
    const update = requireTool(f.augment, "update_mail_message_labels");
    expect(
      toolJson(
        await update.execute(
          { messageId: "message_1", addLabels: [" Important "], removeLabels: ["CUSTOMER"] },
          toolContext(),
        ),
      ),
    ).toMatchObject({ status: "ok", messageId: "message_1" });
    expect(f.provider.messageLabelUpdates[0]).toEqual({
      messageId: "message_1",
      addLabels: ["important"],
      removeLabels: ["customer"],
    });

    await requireTool(f.augment, "trash_mail_message").execute(
      { messageId: "message_1" },
      toolContext(),
    );
    await requireTool(f.augment, "restore_mail_message").execute(
      { messageId: "message_1" },
      toolContext(),
    );
    expect(f.provider.messageLabelUpdates.slice(1)).toEqual([
      { messageId: "message_1", addLabels: ["trash"], removeLabels: [] },
      { messageId: "message_1", addLabels: [], removeLabels: ["trash"] },
    ]);
    const deniedDelete = await requireTool(f.augment, "delete_mail_message_permanently").execute(
      { messageId: "message_1" },
      toolContext(),
    );
    expect(deniedDelete).toMatchObject({ isError: true });
    expect(f.provider.deletedMessages).toEqual([]);
    f.store.close();

    const destructive = fixture({ destructive: { allowPermanentDelete: true } });
    destructive.provider.messages.set("message_1", message());
    expect(
      toolJson(
        await requireTool(destructive.augment, "delete_mail_message_permanently").execute(
          { messageId: "message_1" },
          toolContext(),
        ),
      ),
    ).toEqual({ status: "deleted", messageId: "message_1", permanent: true });
    expect(destructive.provider.deletedMessages).toEqual(["message_1"]);
    destructive.store.close();
  });

  test("applies the same normalized label and trash policy to threads", async () => {
    const f = fixture({
      mailbox: {
        allowLabelMutation: true,
        allowedLabels: ["important"],
        allowTrashRestore: true,
      },
    });
    f.provider.messages.set("message_1", message());
    await requireTool(f.augment, "update_mail_thread_labels").execute(
      { threadId: "thread_1", addLabels: [" IMPORTANT "] },
      toolContext(),
    );
    await requireTool(f.augment, "trash_mail_thread").execute(
      { threadId: "thread_1" },
      toolContext(),
    );
    expect(f.provider.threadLabelUpdates).toEqual([
      { threadId: "thread_1", addLabels: ["important"], removeLabels: [] },
      { threadId: "thread_1", addLabels: ["trash"], removeLabels: [] },
    ]);
    f.store.close();
  });

  test("creates native new and forward drafts without flattening provider forward identity", async () => {
    const f = fixture({ drafts: { allowNew: true, allowForward: true } });
    const incoming = message();
    f.provider.messages.set(incoming.messageId, incoming);
    await f.augment.onBoot?.();
    const create = requireTool(f.augment, "create_mail_draft");
    const createdNew = toolJson(
      await create.execute(
        { kind: "new", to: ["customer@example.com"], subject: "Update", text: "Hello" },
        toolContext({ operationId: "create_new_1" }),
      ),
    );
    expect(createdNew).toMatchObject({ status: "created", kind: "new" });
    const createdForward = toolJson(
      await create.execute(
        {
          kind: "forward",
          sourceMessageId: incoming.messageId,
          to: ["owner@example.com"],
          text: "Please review.",
        },
        toolContext({ operationId: "create_forward_1" }),
      ),
    );
    expect(createdForward).toMatchObject({ status: "created", kind: "forward" });
    expect(f.provider.createdDrafts.at(-1)).toMatchObject({
      kind: "forward",
      sourceMessageId: incoming.messageId,
    });
    expect(f.provider.drafts.get(String(createdForward.draftId))?.forwardOf).toBe(
      incoming.messageId,
    );
    expect(f.store.getProviderDraft(String(createdForward.draftId))).toMatchObject({
      kind: "forward",
      sourceMessageId: incoming.messageId,
    });
    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("requires explicit adoption and refreshes externally edited provider drafts", async () => {
    const f = fixture({ drafts: { allowReply: true } });
    const incoming = message();
    const unmanaged = draft({ draftId: "external_1", inReplyTo: incoming.messageId });
    f.provider.messages.set(incoming.messageId, incoming);
    f.provider.drafts.set(unmanaged.draftId, unmanaged);
    await f.augment.onBoot?.();
    const show = requireTool(f.augment, "show_mail_draft");
    expect(
      toolJson(await show.execute({ draftId: unmanaged.draftId }, toolContext())),
    ).toMatchObject({
      managed: false,
      inferredKind: "reply_or_reply_all",
    });
    const adopt = requireTool(f.augment, "adopt_mail_draft");
    await f.augment.onTurnStart?.(
      creatorTurn("adopt_1", "console_thread_1", "adopt draft external_1 as reply"),
    );
    expect(
      toolJson(
        await adopt.execute(
          { draftId: unmanaged.draftId, kind: "reply" },
          toolContext({ turnId: "adopt_1", operationId: "adopt_operation_1" }),
        ),
      ),
    ).toMatchObject({ status: "adopted", kind: "reply" });
    await f.augment.onTurnEnd?.({ turnId: "adopt_1" } as TurnResult);
    f.provider.drafts.set(unmanaged.draftId, {
      ...unmanaged,
      text: "Edited in AgentMail",
      updatedAt: unmanaged.updatedAt + 10,
    });
    const refreshed = toolJson(
      await show.execute({ draftId: unmanaged.draftId }, toolContext({ turnId: "show_external" })),
    );
    expect(refreshed).toMatchObject({ managed: true, externallyChanged: true });
    expect(f.store.getProviderDraft(unmanaged.draftId)?.providerUpdatedAt).toBe(
      unmanaged.updatedAt + 10,
    );
    const scheduledAt = Date.now() + 60_000;
    f.provider.drafts.set(unmanaged.draftId, {
      ...unmanaged,
      text: "Edited in AgentMail",
      sendAt: scheduledAt,
      updatedAt: unmanaged.updatedAt + 20,
    });
    const scheduled = toolJson(
      await show.execute({ draftId: unmanaged.draftId }, toolContext({ turnId: "show_scheduled" })),
    );
    expect(scheduled).toMatchObject({ managed: true, sendAt: expect.any(Number) });
    expect(f.store.getProviderDraft(unmanaged.draftId)).toMatchObject({ state: "scheduled" });
    expect((await f.augment.adminInfo?.())?.projection).toMatchObject({
      kind: "mail",
      drafts: [
        {
          draftId: unmanaged.draftId,
          state: "scheduled",
          sendAt: new Date(scheduledAt).toISOString(),
        },
      ],
    });
    const scheduledRevision = String(scheduled.providerRevision);
    await f.augment.onTurnStart?.(
      creatorTurn("revise_scheduled", "console_thread_1", "revise draft external_1"),
    );
    const reviseScheduled = await requireTool(f.augment, "revise_mail_draft").execute(
      { draftId: unmanaged.draftId, expectedRevision: scheduledRevision, text: "Do not revise" },
      toolContext({ turnId: "revise_scheduled", operationId: "revise_scheduled_1" }),
    );
    await f.augment.onTurnStart?.(
      creatorTurn("send_scheduled", "console_thread_1", "send draft external_1"),
    );
    const sendScheduled = await requireTool(f.augment, "send_mail_draft").execute(
      { draftId: unmanaged.draftId, expectedRevision: scheduledRevision },
      toolContext({ turnId: "send_scheduled", operationId: "send_scheduled_1" }),
    );
    await f.augment.onTurnStart?.(
      creatorTurn("delete_scheduled", "console_thread_1", "delete draft external_1"),
    );
    const deleteScheduled = await requireTool(f.augment, "delete_mail_draft").execute(
      { draftId: unmanaged.draftId, expectedRevision: scheduledRevision },
      toolContext({ turnId: "delete_scheduled", operationId: "delete_scheduled_1" }),
    );
    for (const result of [reviseScheduled, sendScheduled, deleteScheduled]) {
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain("scheduled in AgentMail");
    }
    expect(f.provider.updatedDrafts).toHaveLength(0);
    expect(f.provider.sentDrafts).toHaveLength(0);
    expect(f.provider.deletedDrafts).toHaveLength(0);
    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("durably deletes a draft only after exact creator intent", async () => {
    const f = fixture({
      drafts: { allowNew: true },
      destructive: { allowPermanentDelete: true },
    });
    await f.augment.onBoot?.();
    const created = toolJson(
      await requireTool(f.augment, "create_mail_draft").execute(
        { kind: "new", to: ["customer@example.com"], subject: "Draft", text: "Body" },
        toolContext({ operationId: "create_delete_1" }),
      ),
    );
    const draftId = String(created.draftId);
    const shown = toolJson(
      await requireTool(f.augment, "show_mail_draft").execute({ draftId }, toolContext()),
    );
    const remove = requireTool(f.augment, "delete_mail_draft");
    expect(
      await remove.execute(
        { draftId, expectedRevision: shown.providerRevision },
        toolContext({ operationId: "delete_denied" }),
      ),
    ).toMatchObject({ isError: true });
    await f.augment.onTurnStart?.(
      creatorTurn("delete_exact", "console_thread_1", `delete draft ${draftId}`),
    );
    expect(
      toolJson(
        await remove.execute(
          { draftId, expectedRevision: shown.providerRevision },
          toolContext({ turnId: "delete_exact", operationId: "delete_exact_1" }),
        ),
      ),
    ).toEqual({ status: "deleted", draftId });
    expect(f.store.getProviderDraft(draftId)?.state).toBe("deleted");
    await f.augment.onTurnEnd?.({ turnId: "delete_exact" } as TurnResult);
    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("reads safe text attachments without exposing the provider signed URL", async () => {
    const signedUrl = "https://files.agentmail.example/download?secret=do-not-leak";
    const provider = new FakeProvider();
    provider.attachmentMetadata = {
      attachmentId: "attachment_1",
      filename: "order.txt",
      size: 5,
      contentType: "text/plain",
      downloadUrl: signedUrl,
      expiresAt: 20_000,
    };
    const headers = new Headers({ "content-type": "text/plain", "content-length": "5" });
    const f = fixture({
      provider,
      clock: () => 10_000,
      mailbox: {
        allowAttachmentAccess: true,
        maxAttachmentBytes: 100,
        allowedAttachmentTypes: ["text/plain"],
      },
      attachmentClient: {
        async get() {
          return {
            finalUrl: signedUrl,
            status: 200,
            statusText: "OK",
            contentType: "text/plain",
            headers,
            body: "hello",
          };
        },
      },
    });
    const tool = requireTool(f.augment, "read_mail_attachment");
    expect(
      await tool.execute(
        { messageId: "message_1", attachmentId: "attachment_1" },
        toolContext({ peer: { ...creatorPeer, trustLevel: "public" } }),
      ),
    ).toMatchObject({ isError: true });
    const result = toolJson(
      await tool.execute({ messageId: "message_1", attachmentId: "attachment_1" }, toolContext()),
    );
    expect(result).toMatchObject({
      status: "ok",
      attachment: { filename: "order.txt", contentType: "text/plain", size: 5, text: "hello" },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("download");
    f.store.close();
  });
});
