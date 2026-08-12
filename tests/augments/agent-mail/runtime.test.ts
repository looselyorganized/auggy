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
  TransportKernel,
  TurnResult,
  TurnState,
  TurnTrigger,
} from "../../../src/types";
import type { NotifyDispatchHost, NotifyInternalDispatchInput } from "../../../src/augments/notify";
import { validateAgentMailConfig } from "../../../src/augments/agentMail/config";
import { createAgentMailRuntime } from "../../../src/augments/agentMail/runtime";
import type {
  AgentMailDraft,
  AgentMailMessage,
  AgentMailMessageSummary,
  AgentMailProvider,
  AgentMailProviderEvent,
} from "../../../src/augments/agentMail/provider";
import {
  createAgentMailOrchestrationStore,
  hashAgentMailOrchestrationValue,
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
  pages: AgentMailMessageSummary[][] = [];
  messages = new Map<string, AgentMailMessage>();
  drafts = new Map<string, AgentMailDraft>();
  created: Array<Parameters<AgentMailProvider["createReplyDraft"]>[0]> = [];
  sentDrafts: Array<Parameters<AgentMailProvider["sendDraft"]>[0]> = [];
  sentMessages: Array<Parameters<AgentMailProvider["sendMessage"]>[0]> = [];
  getMessageCalls = 0;
  handlers?: { onEvent(event: AgentMailProviderEvent): void | Promise<void> };

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
    this.getMessageCalls += 1;
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
  async connect(handlers: { onEvent(event: AgentMailProviderEvent): void | Promise<void> }) {
    this.handlers = handlers;
    return { close() {} };
  }
}

function fixture(
  options: { inbound?: boolean; notifications?: boolean; provider?: FakeProvider } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "auggy-agentmail-runtime-"));
  roots.push(root);
  const store = createAgentMailOrchestrationStore({
    dbPath: join(root, "orchestration.db"),
    inboxId,
    sendKey: () => "auggy-test-send-key",
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
  const augment = createAgentMailRuntime(config, { provider, store });
  return { root, store, provider, augment };
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
    await waitFor(() => provider.created.length === 1);

    expect(observed?.peer).toMatchObject({ trustLevel: "public", publicSubstate: "anonymous" });
    expect(JSON.stringify(observed?.payload)).toContain("UNTRUSTED INBOUND EMAIL");
    expect(provider.created[0]).toMatchObject({
      messageId: "message_1",
      text: "We can help with order 42.",
      replyAll: false,
      subject: "[Store] Re: Need help",
    });
    expect(f.store.getMessage("message_1")?.state).toBe("draft_ready");
    expect(f.store.getDraftByMessage("message_1")?.draftId).toBe("draft_1");
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
    const f = fixture();
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
    f.store.recordDraft({
      sourceMessageId: incoming.messageId,
      threadId: incoming.threadId,
      draftId: providerDraft.draftId,
      clientId: providerDraft.clientId!,
      providerUpdatedAt: providerDraft.updatedAt,
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
        { draftId: "draft_1", expectedUpdatedAt: 2_000 },
        toolContext({ turnId: "bad_send" }),
      ),
    ).toMatchObject({ isError: true });
    expect(f.provider.sentDrafts).toHaveLength(0);
    await f.augment.onTurnEnd?.({ turnId: "bad_send" } as TurnResult);

    await f.augment.onTurnStart?.(creatorTurn("send_turn", "console_thread_1", "send it"));
    expect(
      await send.execute(
        { draftId: "draft_1", expectedUpdatedAt: 2_000 },
        toolContext({ turnId: "send_turn" }),
      ),
    ).toContain("sent_reply_1");
    expect(f.provider.sentDrafts).toEqual([
      { draftId: "draft_1", idempotencyKey: "auggy-test-send-key" },
    ]);
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
    expect(await send.execute(input, toolContext())).toContain("sent_direct_1");
    expect(await send.execute(input, toolContext())).toContain("sent_direct_1");
    expect(f.provider.sentMessages).toHaveLength(1);
    expect(f.provider.sentMessages[0]?.subject).toBe("[Store] Update");
    await f.augment.onShutdown?.();
    f.store.close();
  });

  test("revises only a freshly shown plain-text draft and invalidates the old provider version", async () => {
    const f = fixture();
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
    f.store.recordDraft({
      sourceMessageId: incoming.messageId,
      threadId: incoming.threadId,
      draftId: "draft_1",
      clientId: "auggy.reply.v1.fixture",
      providerUpdatedAt: 2_000,
    });
    await f.augment.onBoot?.();
    const revise = requireTool(f.augment, "revise_mail_draft");
    await f.augment.onTurnStart?.(
      creatorTurn("revise_turn", "console_thread_1", "revise this draft to be concise"),
    );
    expect(
      await revise.execute(
        { draftId: "draft_1", expectedUpdatedAt: 2_000, text: "Concise reply." },
        toolContext({ turnId: "revise_turn" }),
      ),
    ).toContain('"status":"revised"');
    expect(f.provider.drafts.get("draft_1")?.text).toBe("Concise reply.");
    expect(f.store.getDraftByMessage("message_1")).toMatchObject({
      state: "ready",
      providerUpdatedAt: 2_001,
    });
    await f.augment.onTurnEnd?.({ turnId: "revise_turn" } as TurnResult);
    await f.augment.onShutdown?.();
    f.store.close();
  });
});
