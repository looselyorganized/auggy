import { describe, expect, test } from "bun:test";
import {
  AgentMailPayloadError,
  agentMailRestEnvelope,
  normalizeAgentMailMessage,
  normalizeAgentMailMessageSummary,
  normalizeAgentMailReceivedEvent,
  receivedEventTypeForLabels,
  type AgentMailCatchUpReader,
  type AgentMailLiveEventSource,
} from "../../../src/augments/agentMail/provider";

const fullMessage = {
  inbox_id: "support@agentmail.to",
  thread_id: "thread_1",
  message_id: "message_1",
  labels: ["inbox"],
  timestamp: "2026-07-14T10:20:30.000Z",
  from: "customer@example.com",
  to: ["support@agentmail.to"],
  cc: null,
  bcc: [],
  reply_to: ["replies@example.com"],
  subject: "Need help",
  preview: "Can you help?",
  text: "Can you help?",
  html: "<p>Can you help?</p>",
  extracted_text: "Can you help?",
  extracted_html: "<p>Can you help?</p>",
  size: 512,
  attachments: [
    {
      attachment_id: "attachment_1",
      filename: "question.txt",
      content_type: "text/plain",
      size: 12,
      content_disposition: "attachment",
      content_id: null,
    },
  ],
  in_reply_to: null,
  references: null,
  created_at: "2026-07-14T10:20:31.000Z",
  updated_at: null,
};

function receivedEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "event",
    event_type: "message.received",
    event_id: "event_1",
    message: fullMessage,
    thread: {
      inbox_id: fullMessage.inbox_id,
      thread_id: fullMessage.thread_id,
      message_count: 1,
    },
    ...overrides,
  };
}

describe("AgentMail provider boundary", () => {
  test("contracts are structural and contain no replacement capability metadata", () => {
    type CatchUpHasCapabilities = "capabilities" extends keyof AgentMailCatchUpReader
      ? true
      : false;
    type LiveHasCapabilities = "capabilities" extends keyof AgentMailLiveEventSource ? true : false;
    type CatchUpHasSupports = "supports" extends keyof AgentMailCatchUpReader ? true : false;
    type LiveHasSupports = "supports" extends keyof AgentMailLiveEventSource ? true : false;

    const catchUpHasCapabilities: CatchUpHasCapabilities = false;
    const liveHasCapabilities: LiveHasCapabilities = false;
    const catchUpHasSupports: CatchUpHasSupports = false;
    const liveHasSupports: LiveHasSupports = false;

    expect([
      catchUpHasCapabilities,
      liveHasCapabilities,
      catchUpHasSupports,
      liveHasSupports,
    ]).toEqual([false, false, false, false]);
  });

  test("normalizes a webhook event into provider-independent fields", () => {
    const envelope = normalizeAgentMailReceivedEvent(
      receivedEvent(),
      "webhook",
      fullMessage.inbox_id,
    );

    expect(envelope.source).toBe("webhook");
    expect(envelope.eventType).toBe("message.received");
    expect(envelope.providerEventId).toBe("event_1");
    expect(envelope.message).toMatchObject({
      inboxId: "support@agentmail.to",
      threadId: "thread_1",
      messageId: "message_1",
      replyTo: ["replies@example.com"],
      references: [],
      createdAt: "2026-07-14T10:20:31.000Z",
      updatedAt: undefined,
    });
    expect(envelope.message.attachments[0]).toEqual({
      attachmentId: "attachment_1",
      filename: "question.txt",
      contentType: "text/plain",
      size: 12,
      contentDisposition: "attachment",
      contentId: undefined,
    });
  });

  test("accepts WebSocket framing and HTML-only messages", () => {
    const htmlOnly = {
      ...fullMessage,
      labels: ["unauthenticated"],
      preview: undefined,
      text: undefined,
      extracted_text: undefined,
      html: "<p>HTML only</p>",
      extracted_html: "<p>HTML only</p>",
    };
    const envelope = normalizeAgentMailReceivedEvent(
      receivedEvent({
        type: "message_received",
        event_type: "message.received.unauthenticated",
        message: htmlOnly,
      }),
      "websocket",
    );

    expect(envelope.message.text).toBeUndefined();
    expect(envelope.message.preview).toBeUndefined();
    expect(envelope.message.html).toBe("<p>HTML only</p>");
    expect(envelope.eventType).toBe("message.received.unauthenticated");
  });

  test("normalizes the documented TypeScript SDK model shape", () => {
    const sdkMessage = {
      inboxId: fullMessage.inbox_id,
      threadId: fullMessage.thread_id,
      messageId: fullMessage.message_id,
      labels: fullMessage.labels,
      timestamp: fullMessage.timestamp,
      from_: fullMessage.from,
      to: fullMessage.to,
      subject: fullMessage.subject,
      preview: fullMessage.preview,
      text: fullMessage.text,
      html: fullMessage.html,
      size: fullMessage.size,
      replyTo: fullMessage.reply_to,
      attachments: [
        {
          attachmentId: "attachment_sdk",
          filename: "sdk.txt",
          contentType: "text/plain",
          size: 4,
          contentDisposition: "attachment",
        },
      ],
      createdAt: fullMessage.created_at,
    };
    const envelope = normalizeAgentMailReceivedEvent(
      {
        type: "message_received",
        eventType: "message.received",
        eventId: "event_sdk",
        message: sdkMessage,
        thread: {
          inboxId: fullMessage.inbox_id,
          threadId: fullMessage.thread_id,
        },
      },
      "websocket",
      fullMessage.inbox_id,
    );

    expect(envelope.providerEventId).toBe("event_sdk");
    expect(envelope.message.from).toBe(fullMessage.from);
    expect(envelope.message.attachments[0]?.attachmentId).toBe("attachment_sdk");
  });

  test("rejects non-received events and malformed timestamps", () => {
    expect(() =>
      normalizeAgentMailReceivedEvent(receivedEvent({ event_type: "message.sent" }), "websocket"),
    ).toThrow(AgentMailPayloadError);

    expect(() => normalizeAgentMailMessage({ ...fullMessage, timestamp: "not-a-date" })).toThrow(
      /timestamp/,
    );
  });

  test("rejects inbox substitution and incoherent event threads", () => {
    expect(() =>
      normalizeAgentMailReceivedEvent(receivedEvent(), "webhook", "other@agentmail.to"),
    ).toThrow(/configured inbox/);

    expect(() =>
      normalizeAgentMailReceivedEvent(
        receivedEvent({
          thread: { inbox_id: fullMessage.inbox_id, thread_id: "thread_2" },
        }),
        "webhook",
      ),
    ).toThrow(/thread does not match/);

    expect(() =>
      normalizeAgentMailReceivedEvent(
        receivedEvent({ event_type: "message.received.spam" }),
        "webhook",
      ),
    ).toThrow(/classification does not match/);
  });

  test("validation errors do not echo provider payload values", () => {
    const secret = "sk-do-not-log-this-value";
    let error: unknown;
    try {
      normalizeAgentMailMessage({ ...fullMessage, message_id: "", text: secret });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AgentMailPayloadError);
    expect(String(error)).not.toContain(secret);
  });

  test("normalizes list metadata without pretending it contains a body", () => {
    const summary = normalizeAgentMailMessageSummary(
      {
        inbox_id: fullMessage.inbox_id,
        thread_id: fullMessage.thread_id,
        message_id: fullMessage.message_id,
        labels: ["spam"],
        timestamp: fullMessage.timestamp,
        preview: "metadata that must not cross the summary boundary",
      },
      fullMessage.inbox_id,
    );

    expect(summary).toEqual({
      inboxId: fullMessage.inbox_id,
      threadId: fullMessage.thread_id,
      messageId: fullMessage.message_id,
      labels: ["spam"],
      timestamp: fullMessage.timestamp,
    });
    expect("text" in summary).toBe(false);
    expect("preview" in summary).toBe(false);
  });

  test("REST catch-up preserves provider classifications for later policy", () => {
    expect(receivedEventTypeForLabels(["INBOX", "blocked", "spam"])).toBe(
      "message.received.blocked",
    );
    expect(receivedEventTypeForLabels(["spam"])).toBe("message.received.spam");
    expect(receivedEventTypeForLabels(["unauthenticated"])).toBe(
      "message.received.unauthenticated",
    );

    const message = normalizeAgentMailMessage({ ...fullMessage, labels: ["spam"] });
    expect(agentMailRestEnvelope(message)).toMatchObject({
      source: "rest",
      eventType: "message.received.spam",
      providerEventId: undefined,
      message: { messageId: fullMessage.message_id },
    });
  });
});
