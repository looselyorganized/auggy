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
  getMessage?: () => Promise<unknown>;
  getDraft?: () => Promise<unknown>;
  createDraft?: (input: unknown) => Promise<unknown>;
  updateDraft?: (input: unknown) => Promise<unknown>;
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
        get: overrides.getMessage ?? (async () => message({ text: "Full body" })),
        send: async (_id, input, options) =>
          overrides.sendMessage?.(input, options) ?? {
            messageId: "message_sent",
            threadId: "thread_sent",
          },
        draftReply: async (_id, _messageId, input) => overrides.createDraft?.(input) ?? draft(),
        draftReplyAll: async (_id, _messageId, input) => overrides.createDraft?.(input) ?? draft(),
      },
      threads: {
        get: async () => ({
          inboxId,
          threadId: "thread_1",
          lastMessageId: "message_1",
          messageCount: 1,
          updatedAt: now,
          messages: [message({ text: "Full body" })],
        }),
      },
      drafts: {
        list: async () => ({ drafts: [draft()] }),
        create: async (_id, input) => overrides.createDraft?.(input) ?? draft(),
        get: overrides.getDraft ?? (async () => draft()),
        update: async (_id, _draftId, input) =>
          overrides.updateDraft?.(input) ?? draft(input as Record<string, unknown>),
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
    expect(createInput).toEqual({ text: "We can help.", clientId: "reply-message_1" });
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
      [401, "credential_rejected"],
      [403, "permission_missing"],
      [404, "resource_not_found"],
      [409, "resource_conflict"],
      [429, "provider_rate_limited"],
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
