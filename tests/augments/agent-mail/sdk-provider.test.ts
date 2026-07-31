import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentMailInboundLedger } from "../../../src/augments/agentMail/inbound-ledger";
import {
  AgentMailProviderRequestError,
  createAgentMailSdkAdapters,
  runAgentMailCatchUp,
} from "../../../src/augments/agentMail/sdk-provider";
import { AGENTMAIL_RECEIVED_EVENT_TYPES } from "../../../src/augments/agentMail/provider";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-mail-sdk-test-"));
  tempDirs.push(dir);
  return join(dir, "inbound.sqlite");
}

describe("AgentMail SDK credential transport", () => {
  test("rejects remote plaintext REST and WebSocket overrides", () => {
    expect(() =>
      createAgentMailSdkAdapters({
        apiKey: "GROUP9_AGENTMAIL_SDK_SENTINEL",
        apiBaseUrl: "http://provider.example.test",
        websocketBaseUrl: "wss://provider.example.test",
      }),
    ).toThrow(/plaintext HTTP/);

    expect(() =>
      createAgentMailSdkAdapters({
        apiKey: "GROUP9_AGENTMAIL_SDK_SENTINEL",
        apiBaseUrl: "https://provider.example.test",
        websocketBaseUrl: "ws://provider.example.test",
      }),
    ).toThrow(/plaintext WS/);
  });
});

function sdkMessage(
  messageId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    inboxId: "support@agentmail.to",
    threadId: "thread_1",
    messageId,
    labels: ["received"],
    timestamp: new Date("2026-07-14T10:20:30.000Z"),
    from: "customer@example.com",
    to: ["support@agentmail.to"],
    subject: "Need help",
    text: "Can you help?",
    size: 128,
    updatedAt: new Date("2026-07-14T10:20:31.000Z"),
    createdAt: new Date("2026-07-14T10:20:31.000Z"),
    ...overrides,
  };
}

type SocketEvent = "open" | "message" | "close" | "error";

class FakeSocket {
  readyState = 0;
  readonly subscriptions: unknown[] = [];
  closeCalls = 0;
  private readonly handlers = new Map<SocketEvent, Array<(value?: unknown) => void>>();

  on(event: SocketEvent, callback: (value?: unknown) => void): void {
    const callbacks = this.handlers.get(event) ?? [];
    callbacks.push(callback);
    this.handlers.set(event, callbacks);
  }

  sendSubscribe(message: unknown): void {
    this.subscriptions.push(message);
  }

  close(): void {
    this.closeCalls++;
    this.readyState = 3;
  }

  emit(event: SocketEvent, value?: unknown): void {
    if (event === "open") this.readyState = 1;
    if (event === "close") this.readyState = 3;
    for (const callback of this.handlers.get(event) ?? []) callback(value);
  }
}

function fakeSdk(input: {
  list?: (inboxId: string, request: Record<string, unknown>) => Promise<unknown>;
  get?: (inboxId: string, messageId: string) => Promise<unknown>;
  socket?: FakeSocket;
  onConnect?: (args: Record<string, unknown>) => void;
}) {
  const socket = input.socket ?? new FakeSocket();
  return {
    socket,
    sdk: {
      inboxes: {
        messages: {
          list:
            input.list ??
            (async () => ({
              messages: [],
            })),
          get: input.get ?? (async (_inboxId: string, messageId: string) => sdkMessage(messageId)),
        },
      },
      websockets: {
        async connect(args: Record<string, unknown>) {
          input.onConnect?.(args);
          return socket;
        },
      },
    },
  };
}

async function nextTask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function subscribedAck(
  eventTypes: readonly (typeof AGENTMAIL_RECEIVED_EVENT_TYPES)[number][] = AGENTMAIL_RECEIVED_EVENT_TYPES,
  inboxIds: string[] = ["support@agentmail.to"],
) {
  return {
    type: "subscribed",
    inboxIds,
    eventTypes: [...eventTypes],
  };
}

function receivedEvent(
  messageId: string,
  eventType: (typeof AGENTMAIL_RECEIVED_EVENT_TYPES)[number] = "message.received",
) {
  const labels =
    eventType === "message.received" ? ["received"] : [eventType.slice("message.received.".length)];
  return {
    type: "event",
    eventType,
    eventId: `event_${messageId}`,
    message: sdkMessage(messageId, { labels }),
    thread: {
      inboxId: "support@agentmail.to",
      threadId: "thread_1",
    },
  };
}

describe("AgentMail SDK catch-up reader", () => {
  test("requests an ascending inclusive classification scan and normalizes SDK dates", async () => {
    let request: Record<string, unknown> | undefined;
    const fake = fakeSdk({
      async list(_inboxId, value) {
        request = value;
        return {
          messages: [sdkMessage("message_1")],
          nextPageToken: "next_1",
        };
      },
    });
    const adapters = createAgentMailSdkAdapters({ apiKey: "am_test", _sdk: fake.sdk as never });
    const page = await adapters.catchUp.listMessages({
      inboxId: "support@agentmail.to",
      after: "2026-07-14T10:00:00.000Z",
      limit: 50,
    });

    expect(request).toMatchObject({
      limit: 50,
      ascending: true,
      includeSpam: true,
      includeBlocked: true,
      includeUnauthenticated: true,
    });
    expect(request?.after).toEqual(new Date("2026-07-14T10:00:00.000Z"));
    expect(page.messages[0]).toMatchObject({
      messageId: "message_1",
      timestamp: "2026-07-14T10:20:30.000Z",
    });
    expect(page.nextPageToken).toBe("next_1");
  });

  test("requests only selected provider classification buckets", async () => {
    let request: Record<string, unknown> | undefined;
    const fake = fakeSdk({
      async list(_inboxId, value) {
        request = value;
        return { messages: [] };
      },
    });
    const adapters = createAgentMailSdkAdapters({ apiKey: "am_test", _sdk: fake.sdk as never });
    await adapters.catchUp.listMessages({
      inboxId: "support@agentmail.to",
      processedEventTypes: ["message.received", "message.received.spam"],
    });

    expect(request?.includeSpam).toBe(true);
    expect("includeBlocked" in (request ?? {})).toBe(false);
    expect("includeUnauthenticated" in (request ?? {})).toBe(false);
  });

  test("rejects unordered pages and mismatched get responses", async () => {
    const fake = fakeSdk({
      async list() {
        return {
          messages: [
            sdkMessage("new", { timestamp: new Date("2026-07-14T10:21:00.000Z") }),
            sdkMessage("old", { timestamp: new Date("2026-07-14T10:20:00.000Z") }),
          ],
        };
      },
      async get() {
        return sdkMessage("substituted");
      },
    });
    const adapters = createAgentMailSdkAdapters({ apiKey: "am_test", _sdk: fake.sdk as never });

    await expect(
      adapters.catchUp.listMessages({ inboxId: "support@agentmail.to" }),
    ).rejects.toThrow(/oldest-first/);
    await expect(
      adapters.catchUp.getMessage({
        inboxId: "support@agentmail.to",
        messageId: "requested",
      }),
    ).rejects.toThrow(/does not match/);
  });

  test("wraps SDK failures without echoing provider response bodies", async () => {
    const fake = fakeSdk({
      async list() {
        throw { statusCode: 503, body: "sk-secret-from-provider" };
      },
    });
    const adapters = createAgentMailSdkAdapters({ apiKey: "am_test", _sdk: fake.sdk as never });
    let error: unknown;
    try {
      await adapters.catchUp.listMessages({ inboxId: "support@agentmail.to" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AgentMailProviderRequestError);
    expect(error).toMatchObject({ httpStatus: 503, retryable: true });
    expect(String(error)).not.toContain("sk-secret");
  });
});

describe("runAgentMailCatchUp", () => {
  test("filters sent mail, fetches full inbound bodies, and checkpoints the scanned page", async () => {
    const dbPath = tempDb();
    const ledger = createAgentMailInboundLedger({
      dbPath,
      now: () => Date.parse("2026-07-15T00:00:00.000Z"),
    });
    const getCalls: string[] = [];
    const fake = fakeSdk({
      async list() {
        return {
          messages: [
            sdkMessage("received_1", {
              timestamp: new Date("2026-07-14T23:10:00.000Z"),
            }),
            sdkMessage("sent_1", {
              labels: ["sent"],
              timestamp: new Date("2026-07-14T23:20:00.000Z"),
            }),
          ],
        };
      },
      async get(_inboxId, messageId) {
        getCalls.push(messageId);
        return sdkMessage(messageId, {
          timestamp: new Date("2026-07-14T23:10:00.000Z"),
          text: "full body",
        });
      },
    });
    const adapters = createAgentMailSdkAdapters({ apiKey: "am_test", _sdk: fake.sdk as never });
    const result = await runAgentMailCatchUp({
      reader: adapters.catchUp,
      ledger,
      inboxId: "support@agentmail.to",
    });

    expect(getCalls).toEqual(["received_1"]);
    expect(result).toMatchObject({ pages: 1, scanned: 2, received: 1, enqueued: 1 });
    expect(result.checkpoint).toBe("2026-07-14T23:20:00.000Z");
    expect(ledger.get("support@agentmail.to", "received_1")?.envelope.message.text).toBe(
      "full body",
    );
    expect(ledger.get("support@agentmail.to", "sent_1")).toBeNull();
    ledger.close();
  });

  test("fails on repeated continuation tokens", async () => {
    const ledger = createAgentMailInboundLedger({ dbPath: tempDb() });
    const fake = fakeSdk({
      async list() {
        return {
          messages: [sdkMessage("sent", { labels: ["sent"] })],
          nextPageToken: "same",
        };
      },
    });
    const adapters = createAgentMailSdkAdapters({ apiKey: "am_test", _sdk: fake.sdk as never });
    await expect(
      runAgentMailCatchUp({
        reader: adapters.catchUp,
        ledger,
        inboxId: "support@agentmail.to",
      }),
    ).rejects.toThrow(/pagination token repeated/);
    ledger.close();
  });

  test("skips unselected summaries before body fetch and still advances the checkpoint", async () => {
    const ledger = createAgentMailInboundLedger({ dbPath: tempDb() });
    const messages = [
      sdkMessage("ordinary", {
        labels: ["received"],
        timestamp: new Date("2026-07-14T20:00:00.000Z"),
      }),
      sdkMessage("spam", {
        labels: ["spam"],
        timestamp: new Date("2026-07-14T20:01:00.000Z"),
      }),
      sdkMessage("blocked", {
        labels: ["blocked"],
        timestamp: new Date("2026-07-14T20:02:00.000Z"),
      }),
      sdkMessage("unauthenticated", {
        labels: ["unauthenticated"],
        timestamp: new Date("2026-07-14T20:03:00.000Z"),
      }),
      sdkMessage("sent", {
        labels: ["sent"],
        timestamp: new Date("2026-07-14T20:04:00.000Z"),
      }),
    ];
    const byId = new Map(messages.map((message) => [message.messageId, message]));
    const getCalls: string[] = [];
    let listRequest: Record<string, unknown> | undefined;
    const fake = fakeSdk({
      async list(_inboxId, request) {
        listRequest = request;
        return { messages };
      },
      async get(_inboxId, messageId) {
        getCalls.push(messageId);
        return byId.get(messageId);
      },
    });
    const adapters = createAgentMailSdkAdapters({ apiKey: "am_test", _sdk: fake.sdk as never });
    const result = await runAgentMailCatchUp({
      reader: adapters.catchUp,
      ledger,
      inboxId: "support@agentmail.to",
      processedEventTypes: ["message.received", "message.received.blocked"],
    });

    expect(listRequest?.includeBlocked).toBe(true);
    expect("includeSpam" in (listRequest ?? {})).toBe(false);
    expect("includeUnauthenticated" in (listRequest ?? {})).toBe(false);
    expect(getCalls).toEqual(["ordinary", "blocked"]);
    expect(result).toMatchObject({ scanned: 5, received: 2, enqueued: 2 });
    expect(result.checkpoint).toBe("2026-07-14T20:04:00.000Z");
    expect(ledger.get("support@agentmail.to", "spam")).toBeNull();
    expect(ledger.get("support@agentmail.to", "unauthenticated")).toBeNull();
    ledger.close();
  });

  test("rejects empty and duplicate processed event-type sets", async () => {
    const ledger = createAgentMailInboundLedger({ dbPath: tempDb() });
    const fake = fakeSdk({});
    const adapters = createAgentMailSdkAdapters({ apiKey: "am_test", _sdk: fake.sdk as never });

    await expect(
      runAgentMailCatchUp({
        reader: adapters.catchUp,
        ledger,
        inboxId: "support@agentmail.to",
        processedEventTypes: [],
      }),
    ).rejects.toThrow(/non-empty received event-type subset/);
    await expect(
      runAgentMailCatchUp({
        reader: adapters.catchUp,
        ledger,
        inboxId: "support@agentmail.to",
        processedEventTypes: ["message.received", "message.received"],
      }),
    ).rejects.toThrow(/duplicate event types/);
    await expect(
      runAgentMailCatchUp({
        reader: adapters.catchUp,
        ledger,
        inboxId: "support@agentmail.to",
        processedEventTypes: ["message.sent" as never],
      }),
    ).rejects.toThrow(/unsupported received event type/);
    ledger.close();
  });

  test("fails the batch if full-message classification drifts from its summary", async () => {
    const ledger = createAgentMailInboundLedger({ dbPath: tempDb() });
    const fake = fakeSdk({
      async list() {
        return { messages: [sdkMessage("changed", { labels: ["received"] })] };
      },
      async get() {
        return sdkMessage("changed", { labels: ["spam"] });
      },
    });
    const adapters = createAgentMailSdkAdapters({ apiKey: "am_test", _sdk: fake.sdk as never });

    await expect(
      runAgentMailCatchUp({
        reader: adapters.catchUp,
        ledger,
        inboxId: "support@agentmail.to",
      }),
    ).rejects.toThrow(/classification does not match its list entry/);
    expect(ledger.get("support@agentmail.to", "changed")).toBeNull();
    expect(ledger.checkpoint("support@agentmail.to")).toBeUndefined();
    ledger.close();
  });
});

describe("AgentMail SDK WebSocket source", () => {
  test("requires a non-empty duplicate-free supported subscription subset", async () => {
    const fake = fakeSdk({});
    const adapters = createAgentMailSdkAdapters({ apiKey: "am_test", _sdk: fake.sdk as never });
    await expect(
      adapters.live.subscribe({
        inboxId: "support@agentmail.to",
        eventTypes: [],
        async onEvent() {},
        onError() {},
      }),
    ).rejects.toThrow(/non-empty received event-type subset/);
    await expect(
      adapters.live.subscribe({
        inboxId: "support@agentmail.to",
        eventTypes: ["message.received", "message.received"],
        async onEvent() {},
        onError() {},
      }),
    ).rejects.toThrow(/duplicate event types/);
    await expect(
      adapters.live.subscribe({
        inboxId: "support@agentmail.to",
        eventTypes: ["message.sent" as never],
        async onEvent() {},
        onError() {},
      }),
    ).rejects.toThrow(/unsupported received event type/);
  });

  test("subscribes to a proper subset and accepts an exact ack in any order", async () => {
    const fake = fakeSdk({});
    const adapters = createAgentMailSdkAdapters({
      apiKey: "am_test",
      handshakeTimeoutMs: 1_000,
      _sdk: fake.sdk as never,
    });
    const eventTypes = ["message.received.spam", "message.received"] as const;
    const subscribing = adapters.live.subscribe({
      inboxId: "support@agentmail.to",
      eventTypes,
      async onEvent() {},
      onError() {},
    });
    await nextTask();
    fake.socket.emit("open");
    expect(fake.socket.subscriptions[0]).toEqual({
      type: "subscribe",
      inboxIds: ["support@agentmail.to"],
      eventTypes: [...eventTypes],
    });
    fake.socket.emit("message", subscribedAck(["message.received", "message.received.spam"]));

    const subscription = await subscribing;
    await subscription.close();
  });

  test("waits for a full ack, runs catch-up first, and serializes received events", async () => {
    const connectArgs: Record<string, unknown>[] = [];
    const fake = fakeSdk({ onConnect: (args) => connectArgs.push(args) });
    const adapters = createAgentMailSdkAdapters({
      apiKey: "am_test",
      handshakeTimeoutMs: 1_000,
      _sdk: fake.sdk as never,
    });
    const order: string[] = [];
    const errors: Error[] = [];
    const subscribing = adapters.live.subscribe({
      inboxId: "support@agentmail.to",
      eventTypes: AGENTMAIL_RECEIVED_EVENT_TYPES,
      async onSubscribed({ reconnected }) {
        order.push(`catch-up:${reconnected}`);
      },
      async onEvent(event) {
        order.push(`event:${event.message.messageId}`);
      },
      onError(error) {
        errors.push(error);
      },
    });
    await nextTask();

    expect(connectArgs[0]).toMatchObject({
      waitForOpen: false,
      reconnectAttempts: Number.POSITIVE_INFINITY,
    });
    fake.socket.emit("open");
    expect(fake.socket.subscriptions[0]).toEqual({
      type: "subscribe",
      inboxIds: ["support@agentmail.to"],
      eventTypes: [...AGENTMAIL_RECEIVED_EVENT_TYPES],
    });
    fake.socket.emit("message", subscribedAck());
    fake.socket.emit("message", receivedEvent("message_1"));

    const subscription = await subscribing;
    await nextTask();
    expect(order).toEqual(["catch-up:false", "event:message_1"]);
    expect(errors).toEqual([]);
    await subscription.close();
    await subscription.closed;
    expect(fake.socket.closeCalls).toBe(1);
  });

  test("re-subscribes and runs reconnect catch-up before new events", async () => {
    const fake = fakeSdk({});
    const adapters = createAgentMailSdkAdapters({
      apiKey: "am_test",
      handshakeTimeoutMs: 1_000,
      _sdk: fake.sdk as never,
    });
    const order: string[] = [];
    const subscribing = adapters.live.subscribe({
      inboxId: "support@agentmail.to",
      eventTypes: AGENTMAIL_RECEIVED_EVENT_TYPES,
      async onSubscribed({ reconnected }) {
        order.push(`catch-up:${reconnected}`);
      },
      async onEvent(event) {
        order.push(`event:${event.message.messageId}`);
      },
      onError() {},
    });
    await nextTask();
    fake.socket.emit("open");
    fake.socket.emit("message", subscribedAck());
    const subscription = await subscribing;

    fake.socket.emit("close", { code: 1006 });
    fake.socket.emit("open");
    fake.socket.emit("message", subscribedAck());
    fake.socket.emit("message", receivedEvent("after_reconnect"));
    await nextTask();

    expect(fake.socket.subscriptions).toHaveLength(2);
    expect(order).toEqual(["catch-up:false", "catch-up:true", "event:after_reconnect"]);
    await subscription.close();
  });

  test("fails closed unless the ack event-type set exactly matches", async () => {
    const fake = fakeSdk({});
    const adapters = createAgentMailSdkAdapters({
      apiKey: "am_test",
      handshakeTimeoutMs: 1_000,
      _sdk: fake.sdk as never,
    });
    const errors: Error[] = [];
    const subscribing = adapters.live.subscribe({
      inboxId: "support@agentmail.to",
      eventTypes: AGENTMAIL_RECEIVED_EVENT_TYPES,
      async onEvent() {},
      onError(error) {
        errors.push(error);
      },
    });
    await nextTask();
    fake.socket.emit("open");
    fake.socket.emit("message", {
      type: "subscribed",
      inboxIds: ["support@agentmail.to"],
      eventTypes: ["message.received"],
    });

    await expect(subscribing).rejects.toThrow(/did not exactly match the requested event types/);
    expect(fake.socket.closeCalls).toBe(1);
    expect(errors).toHaveLength(1);
  });

  test("rejects ack extras, duplicate event types, and additional inboxes", async () => {
    const cases = [
      {
        ack: subscribedAck(["message.received", "message.received.spam"]),
        message: /did not exactly match the requested event types/,
      },
      {
        ack: subscribedAck(["message.received", "message.received"]),
        message: /contains invalid received event types/,
      },
      {
        ack: subscribedAck(["message.received"], ["support@agentmail.to", "other@agentmail.to"]),
        message: /did not exactly match the configured inbox/,
      },
    ];

    for (const entry of cases) {
      const fake = fakeSdk({});
      const adapters = createAgentMailSdkAdapters({
        apiKey: "am_test",
        handshakeTimeoutMs: 1_000,
        _sdk: fake.sdk as never,
      });
      const subscribing = adapters.live.subscribe({
        inboxId: "support@agentmail.to",
        eventTypes: ["message.received"],
        async onEvent() {},
        onError() {},
      });
      await nextTask();
      fake.socket.emit("open");
      fake.socket.emit("message", entry.ack);
      await expect(subscribing).rejects.toThrow(entry.message);
      expect(fake.socket.closeCalls).toBe(1);
    }
  });

  test("fails closed when live delivery emits a supported unsubscribed type", async () => {
    const fake = fakeSdk({});
    const adapters = createAgentMailSdkAdapters({
      apiKey: "am_test",
      handshakeTimeoutMs: 1_000,
      _sdk: fake.sdk as never,
    });
    const delivered: string[] = [];
    const errors: Error[] = [];
    const subscribing = adapters.live.subscribe({
      inboxId: "support@agentmail.to",
      eventTypes: ["message.received"],
      async onEvent(event) {
        delivered.push(event.eventType);
      },
      onError(error) {
        errors.push(error);
      },
    });
    await nextTask();
    fake.socket.emit("open");
    fake.socket.emit("message", subscribedAck(["message.received"]));
    const subscription = await subscribing;
    fake.socket.emit("message", receivedEvent("unexpected_spam", "message.received.spam"));
    await subscription.closed;

    expect(delivered).toEqual([]);
    expect(errors.some((error) => /outside the subscription/.test(error.message))).toBe(true);
    expect(fake.socket.closeCalls).toBe(1);
  });

  test("does not deliver queued mail when reconnect catch-up fails", async () => {
    const fake = fakeSdk({});
    const adapters = createAgentMailSdkAdapters({
      apiKey: "am_test",
      handshakeTimeoutMs: 1_000,
      _sdk: fake.sdk as never,
    });
    let delivered = 0;
    const subscribing = adapters.live.subscribe({
      inboxId: "support@agentmail.to",
      eventTypes: AGENTMAIL_RECEIVED_EVENT_TYPES,
      async onSubscribed() {
        throw new Error("catch-up database unavailable");
      },
      async onEvent() {
        delivered++;
      },
      onError() {},
    });
    await nextTask();
    fake.socket.emit("open");
    fake.socket.emit("message", subscribedAck());
    fake.socket.emit("message", receivedEvent("must_not_deliver"));

    await expect(subscribing).rejects.toThrow(/event handling failed/);
    await nextTask();
    expect(delivered).toBe(0);
    expect(fake.socket.closeCalls).toBe(1);
  });

  test("closes permanently on malformed received events instead of losing them", async () => {
    const fake = fakeSdk({});
    const adapters = createAgentMailSdkAdapters({
      apiKey: "am_test",
      handshakeTimeoutMs: 1_000,
      _sdk: fake.sdk as never,
    });
    const errors: Error[] = [];
    const subscribing = adapters.live.subscribe({
      inboxId: "support@agentmail.to",
      eventTypes: AGENTMAIL_RECEIVED_EVENT_TYPES,
      async onEvent() {},
      onError(error) {
        errors.push(error);
      },
    });
    await nextTask();
    fake.socket.emit("open");
    fake.socket.emit("message", subscribedAck());
    const subscription = await subscribing;
    fake.socket.emit("message", {
      ...receivedEvent("bad"),
      message: { ...sdkMessage("bad"), threadId: "substituted_thread" },
    });
    await subscription.closed;

    expect(errors.some((error) => /thread does not match/.test(error.message))).toBe(true);
    expect(fake.socket.closeCalls).toBe(1);
  });
});
