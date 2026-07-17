import { describe, expect, test } from "bun:test";
import { createAgentMailInboundLedger } from "../../../src/augments/agentMail/inbound-ledger";
import { createAgentMailWebhookRoute } from "../../../src/augments/agentMail/webhook-provider";
import type { RouteWebhookContext } from "../../../src/types";

const inboxId = "support@agentmail.to";

describe("AgentMail webhook admission", () => {
  test("declares a concrete Svix policy without augment capability metadata", () => {
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:" });
    try {
      const route = createAgentMailWebhookRoute({ inboxId, ledger });
      expect(route).toMatchObject({
        method: "POST",
        path: "/webhooks/agentmail",
        auth: "none",
        maxBodyBytes: 1_048_576,
        policy: {
          kind: "webhook.signature",
          provider: "svix",
          secretEnv: "AGENTMAIL_WEBHOOK_SECRET",
        },
      });
      expect("capabilities" in route).toBe(false);
      expect("supports" in route).toBe(false);
    } finally {
      ledger.close();
    }
  });

  test("durably admits a verified event before acknowledging and deduplicates retries", async () => {
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:", now: () => 1_000 });
    try {
      const route = createAgentMailWebhookRoute({ inboxId, ledger });
      const event = receivedEvent();

      const first = await dispatch(route, verified(event));
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ accepted: true, duplicate: false });
      expect(ledger.get(inboxId, "message_1")?.state).toBe("pending");

      const retry = await dispatch(route, verified(event));
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ accepted: true, duplicate: true });
      expect(ledger.counts().pending).toBe(1);
    } finally {
      ledger.close();
    }
  });

  test("fails closed for unverified, wrong-inbox, and malformed received events", async () => {
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:" });
    try {
      const route = createAgentMailWebhookRoute({ inboxId, ledger });

      const unverified = await dispatch(route, undefined);
      expect(unverified.status).toBe(500);

      const wrongInboxMessage = { ...fullMessage, inbox_id: "other@agentmail.to" };
      const wrongInbox = await dispatch(
        route,
        verified(
          receivedEvent({
            message: wrongInboxMessage,
            thread: { inbox_id: wrongInboxMessage.inbox_id, thread_id: fullMessage.thread_id },
          }),
        ),
      );
      expect(wrongInbox.status).toBe(400);

      const mismatchedClassification = await dispatch(
        route,
        verified(receivedEvent({ event_type: "message.received.spam" })),
      );
      expect(mismatchedClassification.status).toBe(400);
      expect(ledger.counts().pending).toBe(0);
    } finally {
      ledger.close();
    }
  });

  test("acknowledges authenticated non-received events without admitting work", async () => {
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:" });
    try {
      const route = createAgentMailWebhookRoute({ inboxId, ledger });
      const response = await dispatch(
        route,
        verified({ type: "event", event_type: "message.sent", event_id: "event_sent" }),
      );
      expect(response.status).toBe(204);
      expect(ledger.counts().pending).toBe(0);
    } finally {
      ledger.close();
    }
  });

  test("rejects provider event ID reuse across messages", async () => {
    const ledger = createAgentMailInboundLedger({ dbPath: ":memory:" });
    try {
      const route = createAgentMailWebhookRoute({ inboxId, ledger });
      expect((await dispatch(route, verified(receivedEvent()))).status).toBe(200);

      const secondMessage = {
        ...fullMessage,
        message_id: "message_2",
        timestamp: "2026-07-14T10:20:31.000Z",
      };
      const collision = await dispatch(
        route,
        verified(
          receivedEvent({
            message: secondMessage,
            thread: { inbox_id: inboxId, thread_id: fullMessage.thread_id },
          }),
        ),
      );
      expect(collision.status).toBe(409);
      expect(await collision.json()).toEqual({ error: "webhook-ledger-conflict" });
      expect(ledger.get(inboxId, "message_2")).toBeNull();
    } finally {
      ledger.close();
    }
  });
});

const fullMessage = {
  inbox_id: inboxId,
  thread_id: "thread_1",
  message_id: "message_1",
  labels: ["received"],
  timestamp: "2026-07-14T10:20:30.000Z",
  from: "customer@example.com",
  to: [inboxId],
  subject: "Need help",
  preview: "Can you help?",
  text: "Can you help?",
  size: 512,
};

function receivedEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "event",
    event_type: "message.received",
    event_id: "event_1",
    message: fullMessage,
    thread: {
      inbox_id: inboxId,
      thread_id: fullMessage.thread_id,
      message_count: 1,
    },
    ...overrides,
  };
}

function verified(event: unknown): RouteWebhookContext {
  return {
    kind: "webhook.signature",
    provider: "svix",
    event,
    deliveryId: "delivery_1",
    timestamp: 1,
    receivedAt: 1_000,
  };
}

async function dispatch(
  route: ReturnType<typeof createAgentMailWebhookRoute>,
  webhook: RouteWebhookContext | undefined,
): Promise<Response> {
  return route.handler(new Request("https://example.test/webhooks/agentmail", { method: "POST" }), {
    signal: AbortSignal.timeout(1_000),
    ...(webhook ? { webhook } : {}),
  });
}
