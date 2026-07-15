/**
 * Structural provider boundary for AgentMail inbound delivery.
 *
 * The REST, WebSocket, and webhook adapters all terminate here. Downstream
 * code only receives the canonical types below; it never branches on an
 * adapter-declared capability list or consumes unvalidated provider payloads.
 */

import { z } from "zod";

export const AGENTMAIL_RECEIVED_EVENT_TYPES = [
  "message.received",
  "message.received.spam",
  "message.received.blocked",
  "message.received.unauthenticated",
] as const;

export type AgentMailReceivedEventType = (typeof AGENTMAIL_RECEIVED_EVENT_TYPES)[number];

export type AgentMailInboundSource = "rest" | "websocket" | "webhook";

export interface AgentMailInboundAttachment {
  attachmentId: string;
  filename: string;
  contentType: string;
  size: number;
  contentDisposition: string | undefined;
  contentId: string | undefined;
}

/** Canonical full message. Provider wire names are normalized at the edge. */
export interface AgentMailInboundMessage {
  inboxId: string;
  threadId: string;
  messageId: string;
  labels: string[];
  timestamp: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  preview: string | undefined;
  text: string | undefined;
  html: string | undefined;
  extractedText: string | undefined;
  extractedHtml: string | undefined;
  size: number;
  attachments: AgentMailInboundAttachment[];
  inReplyTo: string | undefined;
  references: string[];
  createdAt: string | undefined;
  updatedAt: string | undefined;
}

/** A validated inbound event, independent of how it arrived. */
export interface AgentMailInboundEnvelope {
  source: AgentMailInboundSource;
  eventType: AgentMailReceivedEventType;
  providerEventId: string | undefined;
  message: AgentMailInboundMessage;
}

/**
 * Metadata returned by the list endpoint. Bodies deliberately are not part of
 * this type: a catch-up reader must call getMessage before yielding mail.
 */
export interface AgentMailMessageSummary {
  inboxId: string;
  threadId: string;
  messageId: string;
  labels: string[];
  timestamp: string;
}

export interface AgentMailMessagePage {
  messages: AgentMailMessageSummary[];
  nextPageToken: string | undefined;
}

export interface AgentMailListMessagesInput {
  inboxId: string;
  /** Exclusive lower time bound, encoded as an ISO-8601 timestamp. */
  after?: string;
  pageToken?: string;
  limit?: number;
}

/**
 * Catch-up contract. Implementations must list oldest-first and include spam,
 * blocked, and unauthenticated messages so policy can decide their fate.
 */
export interface AgentMailCatchUpReader {
  listMessages(input: AgentMailListMessagesInput): Promise<AgentMailMessagePage>;
  getMessage(input: { inboxId: string; messageId: string }): Promise<AgentMailInboundMessage>;
}

export interface AgentMailEventSubscription {
  /** Resolves after the underlying listener has permanently stopped. */
  closed: Promise<void>;
  close(): Promise<void>;
}

export interface AgentMailSubscribeInput {
  inboxId: string;
  eventTypes: readonly AgentMailReceivedEventType[];
  /** Runs after each confirmed subscription, before that generation's events are delivered. */
  onSubscribed?(input: { reconnected: boolean }): Promise<void>;
  onEvent(event: AgentMailInboundEnvelope): Promise<void>;
  onError(error: Error): void;
}

/** Live source contract implemented by WebSocket and verified webhook adapters. */
export interface AgentMailLiveEventSource {
  subscribe(input: AgentMailSubscribeInput): Promise<AgentMailEventSubscription>;
}

export class AgentMailPayloadError extends Error {
  readonly code = "AGENTMAIL_INVALID_PAYLOAD";

  constructor(detail: string) {
    super(`agentMail provider: invalid payload (${detail})`);
    this.name = "AgentMailPayloadError";
  }
}

const nonEmptyString = z.string().min(1);
const optionalString = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);
const stringList = z
  .array(z.string())
  .nullish()
  .transform((value) => value ?? []);
const isoTimestamp = nonEmptyString.refine((value) => Number.isFinite(Date.parse(value)), {
  message: "must be an ISO-8601 timestamp",
});

const attachmentSchema = z
  .object({
    attachment_id: nonEmptyString,
    filename: z.string(),
    content_type: nonEmptyString,
    size: z.number().int().nonnegative(),
    content_disposition: optionalString,
    content_id: optionalString,
  })
  .passthrough();

const fullMessageSchema = z
  .object({
    inbox_id: nonEmptyString,
    thread_id: nonEmptyString,
    message_id: nonEmptyString,
    labels: stringList,
    timestamp: isoTimestamp,
    from: nonEmptyString,
    to: z.array(nonEmptyString),
    cc: stringList,
    bcc: stringList,
    reply_to: stringList,
    subject: z
      .string()
      .nullish()
      .transform((value) => value ?? ""),
    preview: optionalString,
    text: optionalString,
    html: optionalString,
    extracted_text: optionalString,
    extracted_html: optionalString,
    size: z.number().int().nonnegative(),
    attachments: z
      .array(attachmentSchema)
      .nullish()
      .transform((value) => value ?? []),
    in_reply_to: optionalString,
    references: stringList,
    created_at: optionalString,
    updated_at: optionalString,
  })
  .passthrough();

const messageSummarySchema = z
  .object({
    inbox_id: nonEmptyString,
    thread_id: nonEmptyString,
    message_id: nonEmptyString,
    labels: stringList,
    timestamp: isoTimestamp,
  })
  .passthrough();

const receivedEventSchema = z
  .object({
    type: z.enum(["event", "message_received"]),
    event_type: z.enum(AGENTMAIL_RECEIVED_EVENT_TYPES),
    event_id: nonEmptyString,
    message: fullMessageSchema,
    thread: z
      .object({
        inbox_id: nonEmptyString,
        thread_id: nonEmptyString,
      })
      .passthrough(),
  })
  .passthrough();

function asRecord(payload: unknown): Record<string, unknown> | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  return payload as Record<string, unknown>;
}

function providerTimestamp(value: unknown): unknown {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : value;
}

/** Convert the documented TypeScript SDK model shape to provider wire names. */
function messageAsWirePayload(payload: unknown): unknown {
  const message = asRecord(payload);
  if (!message || !("inboxId" in message)) return payload;

  const attachments = Array.isArray(message.attachments)
    ? message.attachments.map((value) => {
        const attachment = asRecord(value);
        if (!attachment) return value;
        return {
          ...attachment,
          attachment_id: attachment.attachmentId,
          content_type: attachment.contentType,
          content_disposition: attachment.contentDisposition,
          content_id: attachment.contentId,
        };
      })
    : message.attachments;

  return {
    ...message,
    inbox_id: message.inboxId,
    thread_id: message.threadId,
    message_id: message.messageId,
    timestamp: providerTimestamp(message.timestamp),
    from: message.from_ ?? message.from,
    reply_to: message.replyTo,
    extracted_text: message.extractedText,
    extracted_html: message.extractedHtml,
    attachments,
    in_reply_to: message.inReplyTo,
    created_at: providerTimestamp(message.createdAt),
    updated_at: providerTimestamp(message.updatedAt),
  };
}

/** Convert the documented TypeScript SDK event shape to provider wire names. */
function eventAsWirePayload(payload: unknown): unknown {
  const event = asRecord(payload);
  if (!event || !("eventType" in event)) return payload;
  const thread = asRecord(event.thread);
  return {
    ...event,
    event_type: event.eventType,
    event_id: event.eventId,
    message: messageAsWirePayload(event.message),
    thread: thread
      ? {
          ...thread,
          inbox_id: thread.inboxId,
          thread_id: thread.threadId,
        }
      : event.thread,
  };
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
}

function assertExpectedInbox(actual: string, expected: string | undefined): void {
  if (expected !== undefined && actual !== expected) {
    throw new AgentMailPayloadError("message inbox does not match the configured inbox");
  }
}

function canonicalMessage(message: z.infer<typeof fullMessageSchema>): AgentMailInboundMessage {
  return {
    inboxId: message.inbox_id,
    threadId: message.thread_id,
    messageId: message.message_id,
    labels: [...message.labels],
    timestamp: message.timestamp,
    from: message.from,
    to: [...message.to],
    cc: [...message.cc],
    bcc: [...message.bcc],
    replyTo: [...message.reply_to],
    subject: message.subject,
    preview: message.preview,
    text: message.text,
    html: message.html,
    extractedText: message.extracted_text,
    extractedHtml: message.extracted_html,
    size: message.size,
    attachments: message.attachments.map((attachment) => ({
      attachmentId: attachment.attachment_id,
      filename: attachment.filename,
      contentType: attachment.content_type,
      size: attachment.size,
      contentDisposition: attachment.content_disposition,
      contentId: attachment.content_id,
    })),
    inReplyTo: message.in_reply_to,
    references: [...message.references],
    createdAt: message.created_at,
    updatedAt: message.updated_at,
  };
}

/** Validate and normalize a full REST message response. */
export function normalizeAgentMailMessage(
  payload: unknown,
  expectedInboxId?: string,
): AgentMailInboundMessage {
  const parsed = fullMessageSchema.safeParse(messageAsWirePayload(payload));
  if (!parsed.success) {
    throw new AgentMailPayloadError(describeIssues(parsed.error));
  }
  assertExpectedInbox(parsed.data.inbox_id, expectedInboxId);
  return canonicalMessage(parsed.data);
}

/** Validate and normalize one metadata-only list entry. */
export function normalizeAgentMailMessageSummary(
  payload: unknown,
  expectedInboxId?: string,
): AgentMailMessageSummary {
  const parsed = messageSummarySchema.safeParse(messageAsWirePayload(payload));
  if (!parsed.success) {
    throw new AgentMailPayloadError(describeIssues(parsed.error));
  }
  assertExpectedInbox(parsed.data.inbox_id, expectedInboxId);
  return {
    inboxId: parsed.data.inbox_id,
    threadId: parsed.data.thread_id,
    messageId: parsed.data.message_id,
    labels: [...parsed.data.labels],
    timestamp: parsed.data.timestamp,
  };
}

/** Validate and normalize either a WebSocket or webhook received event. */
export function normalizeAgentMailReceivedEvent(
  payload: unknown,
  source: Exclude<AgentMailInboundSource, "rest">,
  expectedInboxId?: string,
): AgentMailInboundEnvelope {
  const parsed = receivedEventSchema.safeParse(eventAsWirePayload(payload));
  if (!parsed.success) {
    throw new AgentMailPayloadError(describeIssues(parsed.error));
  }

  const { message, thread } = parsed.data;
  assertExpectedInbox(message.inbox_id, expectedInboxId);
  if (thread.inbox_id !== message.inbox_id || thread.thread_id !== message.thread_id) {
    throw new AgentMailPayloadError("event thread does not match its message");
  }
  const inferredEventType = receivedEventTypeForLabels(message.labels);
  if (inferredEventType !== parsed.data.event_type) {
    throw new AgentMailPayloadError("event classification does not match its message labels");
  }

  return {
    source,
    eventType: parsed.data.event_type,
    providerEventId: parsed.data.event_id,
    message: canonicalMessage(message),
  };
}

/** Infer the received classification used for REST catch-up from message labels. */
export function receivedEventTypeForLabels(
  labels: readonly string[],
): AgentMailReceivedEventType | undefined {
  const normalized = new Set(labels.map((label) => label.toLowerCase()));
  if (normalized.has("blocked")) return "message.received.blocked";
  if (normalized.has("spam")) return "message.received.spam";
  if (normalized.has("unauthenticated")) return "message.received.unauthenticated";
  if (normalized.has("received")) return "message.received";
  return undefined;
}

/** Wrap a full REST catch-up message in the same envelope used by live sources. */
export function agentMailRestEnvelope(message: AgentMailInboundMessage): AgentMailInboundEnvelope {
  const eventType = receivedEventTypeForLabels(message.labels);
  if (!eventType) {
    throw new AgentMailPayloadError("REST message is not labeled as received mail");
  }
  return {
    source: "rest",
    eventType,
    providerEventId: undefined,
    message,
  };
}
