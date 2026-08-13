import { describe, expect, test } from "bun:test";
import { AgentMailError } from "agentmail";
import {
  AgentMailProviderError,
  createAgentMailProvider,
  type AgentMailProviderEvent,
  type AgentMailSdkClient,
} from "../../../src/augments/agentMail/provider";

const inboxId = "support@agentmail.to";
const now = new Date("2026-08-12T12:00:00.000Z");

function message(overrides: Record<string, unknown> = {}) {
  return {
    inboxId,
    threadId: "thread_1",
    messageId: "message_1",
    labels: ["received"],
    timestamp: now,
    from: "Customer <customer@example.com>",
    to: [inboxId],
    subject: "Need help",
    preview: "Can you help?",
    attachments: [],
    size: 128,
    updatedAt: now,
    createdAt: now,
    ...overrides,
  };
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    inboxId,
    draftId: "draft_1",
    clientId: "reply-message_1",
    labels: [],
    to: ["customer@example.com"],
    cc: [],
    bcc: [],
    subject: "Re: Need help",
    text: "We can help.",
    inReplyTo: "message_1",
    updatedAt: now,
    createdAt: now,
    ...overrides,
  };
}

function thread(overrides: Record<string, unknown> = {}) {
  return {
    inboxId,
    threadId: "thread_1",
    labels: ["received"],
    timestamp: now,
    senders: ["customer@example.com"],
    recipients: [inboxId],
    subject: "Need help",
    preview: "Can you help?",
    lastMessageId: "message_1",
    messageCount: 1,
    size: 128,
    updatedAt: now,
    createdAt: now,
    attachments: [],
    messages: [message({ text: "Full body" })],
    ...overrides,
  };
}

function attachment(overrides: Record<string, unknown> = {}) {
  return {
    attachmentId: "attachment_1",
    filename: "invoice.pdf",
    size: 256,
    contentType: "application/pdf",
    contentDisposition: "attachment",
    downloadUrl: "https://downloads.agentmail.to/attachment_1",
    expiresAt: now,
    ...overrides,
  };
}

class FakeSocket {
  readonly socket = { binaryType: "blob" };
  readonly subscriptions: Array<{ type: "subscribe"; inboxIds: string[] }> = [];
  closed = false;
  private readonly handlers = new Map<string, (...args: never[]) => void>();

  on(event: string, callback: (...args: never[]) => void): void {
    this.handlers.set(event, callback);
  }

  sendSubscribe(value: { type: "subscribe"; inboxIds: string[] }): void {
    this.subscriptions.push(value);
  }

  async waitForOpen(): Promise<void> {
    this.handlers.get("open")?.();
  }

  close(): void {
    this.closed = true;
  }

  emit(event: string, value?: unknown): void {
    (this.handlers.get(event) as ((value?: unknown) => void) | undefined)?.(value);
  }
}

interface FakeOverrides {
  authMe?: () => Promise<unknown>;
  listMessages?: (input: unknown, options: unknown) => Promise<unknown>;
  searchMessages?: (input: unknown, options: unknown) => Promise<unknown>;
  getMessage?: () => Promise<unknown>;
  getMessageAttachment?: () => Promise<unknown>;
  updateMessage?: (input: unknown, options: unknown) => Promise<unknown>;
  deleteMessage?: (options: unknown) => Promise<unknown>;
  replyMessage?: (input: unknown, options: unknown) => Promise<unknown>;
  replyAllMessage?: (input: unknown, options: unknown) => Promise<unknown>;
  forwardMessage?: (input: unknown, options: unknown) => Promise<unknown>;
  listThreads?: (input: unknown, options: unknown) => Promise<unknown>;
  searchThreads?: (input: unknown, options: unknown) => Promise<unknown>;
  getThread?: () => Promise<unknown>;
  getThreadAttachment?: () => Promise<unknown>;
  updateThread?: (input: unknown, options: unknown) => Promise<unknown>;
  deleteThread?: (options: unknown) => Promise<unknown>;
  listDrafts?: (input: unknown, options: unknown) => Promise<unknown>;
  getDraft?: () => Promise<unknown>;
  getDraftAttachment?: () => Promise<unknown>;
  createDraft?: (input: unknown, options: unknown) => Promise<unknown>;
  updateDraft?: (input: unknown) => Promise<unknown>;
  deleteDraft?: (options: unknown) => Promise<unknown>;
  sendDraft?: (options: unknown) => Promise<unknown>;
  sendMessage?: (input: unknown, options: unknown) => Promise<unknown>;
  socket?: FakeSocket;
}

function fakeSdk(overrides: FakeOverrides = {}): AgentMailSdkClient {
  const socket = overrides.socket ?? new FakeSocket();
  return {
    auth: {
      me:
        overrides.authMe ??
        (async () => ({
          scopeType: "organization",
          scopeId: "org_1",
          organizationId: "org_1",
        })),
    },
    inboxes: {
      get: async () => ({ inboxId, emailAddress: inboxId }),
      messages: {
        list: async (_id, input, options) =>
          overrides.listMessages?.(input, options) ?? {
            messages: [message()],
            nextPageToken: "page_2",
          },
        search: async (_id, input, options) =>
          overrides.searchMessages?.(input, options) ?? {
            messages: [message()],
            count: 1,
            limit: 100,
          },
        get: overrides.getMessage ?? (async () => message({ text: "Full body" })),
        getAttachment: overrides.getMessageAttachment ?? (async () => attachment()),
        update: async (_id, _messageId, input, options) =>
          overrides.updateMessage?.(input, options) ?? {
            messageId: "message_1",
            labels: ["important"],
          },
        delete: async (_id, _messageId, options) => overrides.deleteMessage?.(options) ?? undefined,
        send: async (_id, input, options) =>
          overrides.sendMessage?.(input, options) ?? {
            messageId: "message_sent",
            threadId: "thread_sent",
          },
        reply: async (_id, _messageId, input, options) =>
          overrides.replyMessage?.(input, options) ?? {
            messageId: "message_reply",
            threadId: "thread_1",
          },
        replyAll: async (_id, _messageId, input, options) =>
          overrides.replyAllMessage?.(input, options) ?? {
            messageId: "message_reply_all",
            threadId: "thread_1",
          },
        forward: async (_id, _messageId, input, options) =>
          overrides.forwardMessage?.(input, options) ?? {
            messageId: "message_forward",
            threadId: "thread_forward",
          },
      },
      threads: {
        list: async (_id, input, options) =>
          overrides.listThreads?.(input, options) ?? {
            threads: [thread()],
            count: 1,
            limit: 100,
          },
        search: async (_id, input, options) =>
          overrides.searchThreads?.(input, options) ?? {
            threads: [thread()],
            count: 1,
            limit: 100,
          },
        get: overrides.getThread ?? (async () => thread()),
        getAttachment: overrides.getThreadAttachment ?? (async () => attachment()),
        update: async (_id, _threadId, input, options) =>
          overrides.updateThread?.(input, options) ?? {
            threadId: "thread_1",
            labels: ["important"],
          },
        delete: async (_id, _threadId, options) => overrides.deleteThread?.(options) ?? undefined,
      },
      drafts: {
        list: async (_id, input, options) =>
          overrides.listDrafts?.(input, options) ?? { drafts: [draft()] },
        create: async (_id, input, options) => overrides.createDraft?.(input, options) ?? draft(),
        get: overrides.getDraft ?? (async () => draft()),
        getAttachment: overrides.getDraftAttachment ?? (async () => attachment()),
        update: async (_id, _draftId, input) =>
          overrides.updateDraft?.(input) ?? draft(input as Record<string, unknown>),
        delete: async (_id, _draftId, options) => overrides.deleteDraft?.(options) ?? undefined,
        send: async (_id, _draftId, _input, options) =>
          overrides.sendDraft?.(options) ?? {
            messageId: "message_sent",
            threadId: "thread_1",
          },
      },
    },
    websockets: { connect: async () => socket },
  };
}

function provider(sdkClient: AgentMailSdkClient) {
  return createAgentMailProvider({ apiKey: "am_operator_supplied", inboxId, sdkClient });
}

describe("AgentMail provider boundary", () => {
  test("verifies supplied credential scope and exact inbox without provisioning", async () => {
    expect(await provider(fakeSdk()).verifyAccess()).toEqual({
      scopeType: "organization",
      scopeId: "org_1",
      organizationId: "org_1",
      configuredInboxId: inboxId,
      emailAddress: inboxId,
    });
  });

  test("rejects an inbox-scoped key bound to another inbox", async () => {
    const mail = provider(
      fakeSdk({
        authMe: async () => ({
          scopeType: "inbox",
          scopeId: "other@agentmail.to",
          organizationId: "org_1",
          inboxId: "other@agentmail.to",
        }),
      }),
    );
    await expect(mail.verifyAccess()).rejects.toMatchObject({
      details: { code: "permission_missing", retryable: false },
    });
  });

  test("lists received inbox mail in ascending recovery order without privileged label reads", async () => {
    let observedInput: unknown;
    let observedOptions: unknown;
    const mail = provider(
      fakeSdk({
        listMessages: async (input, options) => {
          observedInput = input;
          observedOptions = options;
          return { messages: [message({ labels: ["received", "spam"] })], nextPageToken: "next" };
        },
      }),
    );
    const page = await mail.listMessages({ after: now.getTime() - 1_000, limit: 50 });
    expect(observedInput).toEqual({
      ascending: true,
      after: new Date(now.getTime() - 1_000),
      labels: ["received"],
      limit: 50,
    });
    expect(observedOptions).toMatchObject({ maxRetries: 0 });
    expect(page).toMatchObject({
      nextPageToken: "next",
      messages: [
        {
          messageId: "message_1",
          sender: "customer@example.com",
          classification: "spam",
          attachmentCount: 0,
        },
      ],
    });
  });

  test("fails closed when catch-up returns mail outside the received direction", async () => {
    const mail = provider(
      fakeSdk({
        listMessages: async () => ({ messages: [message({ labels: ["sent"] })] }),
      }),
    );

    await expect(mail.listMessages({ limit: 1 })).rejects.toMatchObject({
      details: {
        code: "provider_contract_invalid",
        operation: "list_messages",
        phase: "response_validation",
      },
    });
  });

  test("fails closed on malformed or multi-address provider sender fields", async () => {
    const mail = provider(
      fakeSdk({
        getMessage: async () => message({ from: "Alice <alice@example.com>, bob@example.com" }),
      }),
    );
    await expect(mail.getMessage("message_1")).rejects.toMatchObject({
      details: { code: "provider_contract_invalid", operation: "get_message" },
    });
  });

  test("round-trips opaque provider message identifiers", async () => {
    const messageId = "<live/message=42+reply@example.agentmail>";
    const threadId = "<live/thread=42@example.agentmail>";
    const mail = provider(
      fakeSdk({
        getMessage: async () => message({ messageId, text: "Full body" }),
        sendMessage: async () => ({ messageId, threadId }),
      }),
    );

    const sent = await mail.sendMessage({
      to: ["customer@example.com"],
      text: "Full body",
      idempotencyKey: "opaque-id-round-trip",
    });
    expect(sent).toEqual({ messageId, threadId });
    expect(await mail.getMessage(sent.messageId)).toMatchObject({ messageId, text: "Full body" });
    await expect(mail.getMessage("message\r\ninjected")).rejects.toMatchObject({
      details: { code: "configuration_invalid", operation: "validate" },
    });
  });

  test("rejects present invalid optional draft fields instead of treating them as absent", async () => {
    const mail = provider(
      fakeSdk({
        getDraft: async () => draft({ html: "x".repeat(1_048_577) }),
      }),
    );

    await expect(mail.getDraft("draft_1")).rejects.toMatchObject({
      details: {
        code: "provider_contract_invalid",
        operation: "get_draft",
        phase: "response_validation",
      },
    });
  });

  test("rejects a malformed pagination token instead of silently ending catch-up", async () => {
    const mail = provider(
      fakeSdk({
        listMessages: async () => ({ messages: [message()], nextPageToken: 42 }),
      }),
    );

    await expect(mail.listMessages({ limit: 1 })).rejects.toMatchObject({
      details: {
        code: "provider_contract_invalid",
        operation: "list_messages",
        phase: "response_validation",
      },
    });
  });

  test("fetches content just in time and creates the provider reply draft", async () => {
    let createInput: unknown;
    const mail = provider(
      fakeSdk({
        createDraft: async (input) => {
          createInput = input;
          return draft();
        },
      }),
    );
    expect(await mail.getMessage("message_1")).toMatchObject({ text: "Full body" });
    expect(await mail.getThread("thread_1")).toMatchObject({ messageCount: 1 });
    expect(
      await mail.createReplyDraft({
        messageId: "message_1",
        text: "We can help.",
        clientId: "reply-message_1",
      }),
    ).toMatchObject({ draftId: "draft_1", inReplyTo: "message_1" });
    expect(createInput).toEqual({
      text: "We can help.",
      clientId: "reply-message_1",
      inReplyTo: "message_1",
    });
  });

  test("creates reply-all drafts through the provider-native draft contract", async () => {
    let createInput: unknown;
    const mail = provider(
      fakeSdk({
        createDraft: async (input) => {
          createInput = input;
          return draft({ clientId: "reply-all-message_1", inReplyTo: "message_1" });
        },
      }),
    );

    await mail.createReplyDraft({
      messageId: "message_1",
      text: "We can all help.",
      clientId: "reply-all-message_1",
      replyAll: true,
    });

    expect(createInput).toEqual({
      text: "We can all help.",
      clientId: "reply-all-message_1",
      inReplyTo: "message_1",
      replyAll: true,
    });
  });

  test("provides bounded message, thread, and draft discovery", async () => {
    const observed: Array<[string, unknown]> = [];
    const mail = provider(
      fakeSdk({
        listMessages: async (input) => {
          observed.push(["messages", input]);
          return { messages: [message()], count: 1, limit: 2 };
        },
        searchMessages: async (input) => {
          observed.push(["message-search", input]);
          return { messages: [message()], count: 1, limit: 3 };
        },
        listThreads: async (input) => {
          observed.push(["threads", input]);
          return { threads: [thread()], count: 1, limit: 4 };
        },
        searchThreads: async (input) => {
          observed.push(["thread-search", input]);
          return { threads: [thread()], count: 1, limit: 5 };
        },
        listDrafts: async (input) => {
          observed.push(["drafts", input]);
          return { drafts: [draft()], count: 1, limit: 6 };
        },
      }),
    );

    expect(
      await mail.listMailboxMessages?.({
        limit: 2,
        after: now.getTime() - 1_000,
        from: ["customer@example.com"],
        includeSpam: true,
      }),
    ).toMatchObject({ count: 1, limit: 2, items: [{ messageId: "message_1" }] });
    expect(await mail.searchMessages?.({ query: " invoice ", limit: 3 })).toMatchObject({
      items: [{ messageId: "message_1" }],
    });
    expect(await mail.listThreads?.({ limit: 4, senders: ["customer@example.com"] })).toMatchObject(
      { items: [{ threadId: "thread_1" }] },
    );
    expect(await mail.searchThreads?.({ query: "support", limit: 5 })).toMatchObject({
      items: [{ threadId: "thread_1" }],
    });
    expect(await mail.listMailboxDrafts?.({ limit: 6 })).toMatchObject({
      items: [{ draftId: "draft_1" }],
    });
    expect(observed).toEqual([
      [
        "messages",
        {
          limit: 2,
          after: new Date(now.getTime() - 1_000),
          from: ["customer@example.com"],
          includeSpam: true,
        },
      ],
      ["message-search", { q: "invoice", limit: 3 }],
      ["threads", { limit: 4, senders: ["customer@example.com"] }],
      ["thread-search", { q: "support", limit: 5 }],
      ["drafts", { limit: 6 }],
    ]);
  });

  test("normalizes labels, permanent deletes, and attachment metadata", async () => {
    const mutations: Array<[string, unknown]> = [];
    const mail = provider(
      fakeSdk({
        updateMessage: async (input, options) => {
          mutations.push(["message-labels", { input, options }]);
          return { messageId: "message_1", labels: ["important"] };
        },
        updateThread: async (input, options) => {
          mutations.push(["thread-labels", { input, options }]);
          return { threadId: "thread_1", labels: ["important"] };
        },
        deleteMessage: async (options) => {
          mutations.push(["message-delete", options]);
        },
        deleteThread: async (options) => {
          mutations.push(["thread-delete", options]);
        },
        deleteDraft: async (options) => {
          mutations.push(["draft-delete", options]);
        },
      }),
    );

    expect(
      await mail.updateMessageLabels?.({ messageId: "message_1", addLabels: ["important"] }),
    ).toEqual({ messageId: "message_1", labels: ["important"] });
    expect(
      await mail.updateThreadLabels?.({ threadId: "thread_1", addLabels: ["important"] }),
    ).toEqual({ threadId: "thread_1", labels: ["important"] });
    expect(
      await mail.getMessageAttachment?.({ messageId: "message_1", attachmentId: "attachment_1" }),
    ).toMatchObject({ attachmentId: "attachment_1", size: 256 });
    expect(
      await mail.getThreadAttachment?.({ threadId: "thread_1", attachmentId: "attachment_1" }),
    ).toMatchObject({ attachmentId: "attachment_1", size: 256 });
    expect(
      await mail.getDraftAttachment?.({ draftId: "draft_1", attachmentId: "attachment_1" }),
    ).toMatchObject({ attachmentId: "attachment_1", size: 256 });
    await mail.deleteMessagePermanently?.("message_1");
    await mail.deleteThreadPermanently?.("thread_1");
    await mail.deleteDraft?.("draft_1");
    expect(mutations).toEqual([
      ["message-labels", { input: { addLabels: ["important"] }, options: { maxRetries: 0 } }],
      ["thread-labels", { input: { addLabels: ["important"] }, options: { maxRetries: 0 } }],
      ["message-delete", { maxRetries: 0 }],
      ["thread-delete", { maxRetries: 0 }],
      ["draft-delete", { maxRetries: 0 }],
    ]);
  });

  test("creates every native draft kind and applies complete draft updates", async () => {
    const requests: unknown[] = [];
    let updateInput: unknown;
    const mail = provider(
      fakeSdk({
        createDraft: async (input, options) => {
          requests.push({ input, options });
          const value = input as Record<string, unknown>;
          return draft({
            clientId: value.clientId,
            inReplyTo: value.inReplyTo,
            forwardOf: value.forwardOf,
          });
        },
        updateDraft: async (input) => {
          updateInput = input;
          return draft({ text: "Updated" });
        },
      }),
    );

    await mail.createDraft?.({
      kind: "new",
      clientId: "new-1",
      to: ["customer@example.com"],
      text: "Hello",
    });
    await mail.createDraft?.({
      kind: "reply",
      sourceMessageId: "message_1",
      clientId: "reply-1",
      text: "Reply",
    });
    await mail.createDraft?.({
      kind: "replyAll",
      sourceMessageId: "message_1",
      clientId: "reply-all-1",
      html: "<p>Reply all</p>",
    });
    await mail.createDraft?.({
      kind: "forward",
      sourceMessageId: "message_1",
      clientId: "forward-1",
      to: ["owner@example.com"],
    });
    await mail.updateDraft({
      draftId: "draft_1",
      replyTo: ["support@example.com"],
      to: [],
      subject: null,
      text: "Updated",
      html: null,
      addAttachments: [{ url: "https://files.example.com/invoice.pdf" }],
      removeAttachmentIds: ["attachment_old"],
      addLabels: ["reviewed"],
      removeLabels: ["draft"],
    });

    expect(requests).toEqual([
      {
        input: { to: ["customer@example.com"], text: "Hello", clientId: "new-1" },
        options: { maxRetries: 0 },
      },
      {
        input: { text: "Reply", clientId: "reply-1", inReplyTo: "message_1" },
        options: { maxRetries: 0 },
      },
      {
        input: {
          html: "<p>Reply all</p>",
          clientId: "reply-all-1",
          inReplyTo: "message_1",
          replyAll: true,
        },
        options: { maxRetries: 0 },
      },
      {
        input: { to: ["owner@example.com"], clientId: "forward-1", forwardOf: "message_1" },
        options: { maxRetries: 0 },
      },
    ]);
    expect(updateInput).toEqual({
      replyTo: ["support@example.com"],
      to: [],
      subject: null,
      text: "Updated",
      html: null,
      addAttachments: [{ url: "https://files.example.com/invoice.pdf" }],
      removeAttachments: ["attachment_old"],
      addLabels: ["reviewed"],
      removeLabels: ["draft"],
    });
  });

  test("uses native idempotent send, reply, reply-all, and forward operations", async () => {
    const calls: Array<[string, unknown, unknown]> = [];
    const mail = provider(
      fakeSdk({
        sendMessage: async (input, options) => {
          calls.push(["send", input, options]);
          return { messageId: "sent", threadId: "thread_sent" };
        },
        replyMessage: async (input, options) => {
          calls.push(["reply", input, options]);
          return { messageId: "reply", threadId: "thread_1" };
        },
        replyAllMessage: async (input, options) => {
          calls.push(["reply-all", input, options]);
          return { messageId: "reply-all", threadId: "thread_1" };
        },
        forwardMessage: async (input, options) => {
          calls.push(["forward", input, options]);
          return { messageId: "forward", threadId: "thread_forward" };
        },
      }),
    );

    await mail.sendMessage({
      to: ["customer@example.com"],
      subject: "Hello",
      html: "<p>Hello</p>",
      idempotencyKey: "send-1",
    });
    await mail.replyToMessage?.({
      messageId: "message_1",
      text: "Reply",
      idempotencyKey: "reply-1",
    });
    await mail.replyAllToMessage?.({
      messageId: "message_1",
      text: "Reply all",
      idempotencyKey: "reply-all-1",
    });
    await mail.forwardMessage?.({
      messageId: "message_1",
      to: ["owner@example.com"],
      idempotencyKey: "forward-1",
    });

    expect(calls).toEqual([
      [
        "send",
        { to: ["customer@example.com"], subject: "Hello", html: "<p>Hello</p>" },
        { maxRetries: 0, idempotencyKey: "send-1" },
      ],
      ["reply", { text: "Reply" }, { maxRetries: 0, idempotencyKey: "reply-1" }],
      ["reply-all", { text: "Reply all" }, { maxRetries: 0, idempotencyKey: "reply-all-1" }],
      ["forward", { to: ["owner@example.com"] }, { maxRetries: 0, idempotencyKey: "forward-1" }],
    ]);
  });

  test("rejects unsafe requests before calling AgentMail", async () => {
    const mail = provider(fakeSdk());
    await expect(mail.searchMessages?.({ query: "" })).rejects.toMatchObject({
      details: { code: "request_invalid" },
    });
    await expect(mail.listThreads?.({ limit: 101 })).rejects.toMatchObject({
      details: { code: "request_invalid" },
    });
    await expect(
      mail.createDraft?.({
        kind: "replyAll",
        sourceMessageId: "message_1",
        clientId: "reply-all-1",
        to: ["override@example.com"],
      }),
    ).rejects.toMatchObject({ details: { code: "request_invalid" } });
    await expect(mail.updateDraft({ draftId: "draft_1" })).rejects.toMatchObject({
      details: { code: "request_invalid" },
    });
    await expect(
      mail.sendMessage({
        to: ["customer@example.com"],
        text: "Attachment",
        attachments: [{ content: "base64", url: "https://files.example.com/a.txt" }],
        idempotencyKey: "send-1",
      }),
    ).rejects.toMatchObject({ details: { code: "request_invalid" } });
  });

  test("passes exact send idempotency keys to the SDK", async () => {
    const options: unknown[] = [];
    const mail = provider(
      fakeSdk({
        sendDraft: async (value) => {
          options.push(value);
          return { messageId: "draft_send", threadId: "thread_1" };
        },
        sendMessage: async (_input, value) => {
          options.push(value);
          return { messageId: "direct_send", threadId: "thread_2" };
        },
      }),
    );
    await mail.sendDraft({ draftId: "draft_1", idempotencyKey: "send-draft-1" });
    await mail.sendMessage({
      to: ["customer@example.com"],
      subject: "Hello",
      text: "Body",
      idempotencyKey: "send-message-1",
    });
    expect(options).toEqual([
      { maxRetries: 0, idempotencyKey: "send-draft-1" },
      { maxRetries: 0, idempotencyKey: "send-message-1" },
    ]);
  });

  test("normalizes live events, filters other inboxes, and resubscribes", async () => {
    const socket = new FakeSocket();
    const events: AgentMailProviderEvent[] = [];
    const subscription = await provider(fakeSdk({ socket })).connect({
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(socket.subscriptions).toEqual([{ type: "subscribe", inboxIds: [inboxId] }]);
    expect(socket.socket.binaryType).toBe("arraybuffer");
    socket.emit("message", {
      type: "event",
      eventType: "message.received.unauthenticated",
      eventId: "event_1",
      message: message(),
    });
    socket.emit("message", {
      type: "event",
      eventType: "message.received",
      eventId: "event_other",
      message: message({ inboxId: "other@agentmail.to" }),
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "message.received",
        classification: "unauthenticated",
        eventId: "event_1",
      }),
    ]);
    socket.emit("close", { code: 1006 });
    socket.emit("open");
    expect(socket.subscriptions).toHaveLength(2);
    subscription.close();
    expect(socket.closed).toBe(true);
  });

  test("maps provider failures to stable redacted categories", async () => {
    for (const [status, code] of [
      [400, "request_invalid"],
      [401, "credential_rejected"],
      [403, "permission_missing"],
      [404, "resource_not_found"],
      [409, "resource_conflict"],
      [422, "resource_unprocessable"],
      [429, "provider_rate_limited"],
      [503, "provider_unavailable"],
    ] as const) {
      const secret = `provider-secret-${status}`;
      const mail = provider(
        fakeSdk({
          getMessage: async () => {
            throw new AgentMailError({
              statusCode: status,
              body: { code: `provider_${status}`, message: secret },
              message: secret,
            });
          },
        }),
      );
      try {
        await mail.getMessage("message_1");
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(AgentMailProviderError);
        expect((error as AgentMailProviderError).details.code).toBe(code);
        expect(String((error as Error).message)).not.toContain(secret);
      }
    }
  });

  test("distinguishes provider rejection from missing permission and exposes bounded retry delay", async () => {
    const rejected = provider(
      fakeSdk({
        getMessage: async () => {
          throw new AgentMailError({
            statusCode: 403,
            body: { code: "message_rejected", message: "provider detail" },
          });
        },
      }),
    );
    await expect(rejected.getMessage("message_1")).rejects.toMatchObject({
      details: { code: "message_rejected", retryable: false },
    });

    const limited = provider(
      fakeSdk({
        getMessage: async () => {
          throw new AgentMailError({
            statusCode: 429,
            rawResponse: new Response(null, { status: 429, headers: { "retry-after": "30" } }),
          });
        },
      }),
    );
    await expect(limited.getMessage("message_1")).rejects.toMatchObject({
      details: { code: "provider_rate_limited", retryAfterSeconds: 30 },
    });
  });

  test("fences unconfirmed mutation and rejects malformed success", async () => {
    const ambiguous = provider(
      fakeSdk({
        updateDraft: async () => {
          throw new Error("socket closed after request");
        },
      }),
    );
    await expect(
      ambiguous.updateDraft({ draftId: "draft_1", text: "Changed" }),
    ).rejects.toMatchObject({ details: { code: "mutation_ambiguous", retryable: false } });

    const malformedMutation = provider(
      fakeSdk({ sendMessage: async () => ({ messageId: "sent_without_thread" }) }),
    );
    await expect(
      malformedMutation.sendMessage({
        to: ["customer@example.com"],
        text: "Hello",
        idempotencyKey: "send-1",
      }),
    ).rejects.toMatchObject({
      details: {
        code: "mutation_ambiguous",
        operation: "send_message",
        phase: "response_validation",
      },
    });

    const malformed = provider(fakeSdk({ getMessage: async () => ({ messageId: "message_1" }) }));
    await expect(malformed.getMessage("message_1")).rejects.toMatchObject({
      details: { code: "provider_contract_invalid", retryable: false },
    });
  });

  test("refuses non-loopback plaintext credential transport", () => {
    expect(() =>
      createAgentMailProvider({
        apiKey: "am_secret",
        inboxId,
        apiBaseUrl: "http://provider.example.test",
        sdkClient: fakeSdk(),
      }),
    ).toThrow(/refuses to send credentials/);
  });
});
