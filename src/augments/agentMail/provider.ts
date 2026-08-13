import {
  AgentMailClient,
  AgentMailEnvironment,
  AgentMailError,
  AgentMailTimeoutError,
  type AgentMail,
} from "agentmail";
import {
  assertSecureCredentialTransport,
  assertSecureWebSocketCredentialTransport,
} from "../../engines/_shared/credential-transport";
import { canonicalizeEmail, isWellFormedEmail } from "../visitorAuth/email-validation";

export type AgentMailProviderErrorCode =
  | "configuration_invalid"
  | "request_invalid"
  | "credential_rejected"
  | "permission_missing"
  | "message_rejected"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_contract_invalid"
  | "mutation_ambiguous"
  | "resource_conflict"
  | "resource_unprocessable"
  | "resource_not_found";

export interface AgentMailProviderErrorDetails {
  code: AgentMailProviderErrorCode;
  operation: string;
  phase: string;
  retryable: boolean;
  nextAction: string;
  httpStatus?: number;
  providerCode?: string;
  inboxId?: string;
  messageId?: string;
  draftId?: string;
  threadId?: string;
  attachmentId?: string;
  retryAfterSeconds?: number;
}

export class AgentMailProviderError extends Error {
  readonly details: Readonly<AgentMailProviderErrorDetails>;
  readonly outcomeUnknown: boolean;

  constructor(details: AgentMailProviderErrorDetails) {
    super(
      `AgentMail ${details.operation} failed (${details.code}) during ${details.phase}. ${details.nextAction}`,
    );
    this.name = "AgentMailProviderError";
    this.details = Object.freeze({ ...details });
    this.outcomeUnknown = details.code === "mutation_ambiguous";
  }
}

export interface AgentMailProviderIdentity {
  scopeType: string;
  scopeId: string;
  organizationId: string;
  inboxId?: string;
  configuredInboxId: string;
  emailAddress?: string;
}

export type AgentMailMessageClassification = "received" | "spam" | "blocked" | "unauthenticated";

export interface AgentMailMessageSummary {
  inboxId: string;
  threadId: string;
  messageId: string;
  sender: string;
  to: string[];
  cc: string[];
  subject?: string;
  preview?: string;
  labels: string[];
  timestamp: number;
  updatedAt: number;
  size: number;
  classification: AgentMailMessageClassification;
  attachmentCount: number;
  createdAt?: number;
  bcc?: string[];
}

export interface AgentMailMessage extends AgentMailMessageSummary {
  text?: string;
  html?: string;
  extractedText?: string;
  extractedHtml?: string;
  replyTo: string[];
  inReplyTo?: string;
  references: string[];
  attachments: Array<{
    attachmentId: string;
    filename?: string;
    contentType?: string;
    size?: number;
  }>;
}

export interface AgentMailThread {
  inboxId: string;
  threadId: string;
  subject?: string;
  lastMessageId: string;
  messageCount: number;
  updatedAt: number;
  messages: AgentMailMessage[];
  labels?: string[];
  timestamp?: number;
  createdAt?: number;
  size?: number;
  senders?: string[];
  recipients?: string[];
  preview?: string;
  attachmentCount?: number;
}

export type AgentMailThreadSummary = Omit<AgentMailThread, "messages">;

export interface AgentMailAttachmentMetadata {
  attachmentId: string;
  filename?: string;
  size: number;
  contentType?: string;
  contentDisposition?: "inline" | "attachment";
  contentId?: string;
  downloadUrl: string;
  expiresAt: number;
}

export interface AgentMailDraftAttachment {
  attachmentId: string;
  filename?: string;
  size: number;
  contentType?: string;
  contentDisposition?: "inline" | "attachment";
  contentId?: string;
}

export interface AgentMailDraft {
  inboxId: string;
  draftId: string;
  clientId?: string;
  labels?: string[];
  replyTo?: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string;
  text?: string;
  html?: string;
  preview?: string;
  attachments?: AgentMailDraftAttachment[];
  inReplyTo?: string;
  forwardOf?: string;
  references?: string[];
  sendStatus?: string;
  sendAt?: number;
  updatedAt: number;
  createdAt: number;
}

export type AgentMailDraftSummary = Omit<
  AgentMailDraft,
  "clientId" | "text" | "html" | "createdAt" | "references" | "replyTo"
>;

export interface AgentMailPage<T> {
  items: T[];
  count: number;
  limit?: number;
  nextPageToken?: string;
}

export interface AgentMailListInput {
  pageToken?: string;
  limit?: number;
  before?: number;
  after?: number;
  ascending?: boolean;
  labels?: string[];
}

export interface AgentMailSearchInput {
  query: string;
  pageToken?: string;
  limit?: number;
  before?: number;
  after?: number;
}

export interface AgentMailSendAttachment {
  filename?: string;
  contentType?: string;
  contentDisposition?: "inline" | "attachment";
  contentId?: string;
  content?: string;
  url?: string;
}

export interface AgentMailComposeInput {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject?: string;
  text?: string;
  html?: string;
  labels?: string[];
  attachments?: AgentMailSendAttachment[];
}

export type AgentMailCreateDraftInput = AgentMailComposeInput & {
  kind: "new" | "reply" | "replyAll" | "forward";
  sourceMessageId?: string;
  clientId: string;
};

export interface AgentMailUpdateDraftInput {
  draftId: string;
  replyTo?: string[] | null;
  to?: string[] | null;
  cc?: string[] | null;
  bcc?: string[] | null;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  addAttachments?: AgentMailSendAttachment[];
  removeAttachmentIds?: string[];
  addLabels?: string[];
  removeLabels?: string[];
}

export interface AgentMailDeliveryResult {
  messageId: string;
  threadId: string;
}

export type AgentMailProviderEvent =
  | {
      type: "message.received";
      eventId: string;
      classification: AgentMailMessageClassification;
      message: AgentMailMessageSummary;
    }
  | {
      type:
        | "message.sent"
        | "message.delivered"
        | "message.bounced"
        | "message.complained"
        | "message.rejected";
      eventId: string;
      inboxId: string;
      threadId: string;
      messageId: string;
      timestamp: number;
    };

export interface AgentMailProviderSubscription {
  close(): void;
}

export interface AgentMailProvider {
  verifyAccess(signal?: AbortSignal): Promise<AgentMailProviderIdentity>;
  listMailboxMessages?(
    input?: AgentMailListInput & {
      from?: string[];
      to?: string[];
      subject?: string[];
      includeSpam?: boolean;
      includeBlocked?: boolean;
      includeUnauthenticated?: boolean;
      includeTrash?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<AgentMailPage<AgentMailMessageSummary>>;
  searchMessages?(
    input: AgentMailSearchInput,
    signal?: AbortSignal,
  ): Promise<AgentMailPage<AgentMailMessageSummary>>;
  listMessages(
    input?: { pageToken?: string; after?: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<{ messages: AgentMailMessageSummary[]; nextPageToken?: string }>;
  getMessage(messageId: string, signal?: AbortSignal): Promise<AgentMailMessage>;
  updateMessageLabels?(
    input: { messageId: string; addLabels?: string[]; removeLabels?: string[] },
    signal?: AbortSignal,
  ): Promise<{ messageId: string; labels: string[] }>;
  deleteMessagePermanently?(messageId: string, signal?: AbortSignal): Promise<void>;
  getMessageAttachment?(
    input: { messageId: string; attachmentId: string },
    signal?: AbortSignal,
  ): Promise<AgentMailAttachmentMetadata>;
  listThreads?(
    input?: AgentMailListInput & {
      senders?: string[];
      recipients?: string[];
      subject?: string[];
      includeSpam?: boolean;
      includeBlocked?: boolean;
      includeUnauthenticated?: boolean;
      includeTrash?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<AgentMailPage<AgentMailThreadSummary>>;
  searchThreads?(
    input: AgentMailSearchInput,
    signal?: AbortSignal,
  ): Promise<AgentMailPage<AgentMailThreadSummary>>;
  getThread(threadId: string, signal?: AbortSignal): Promise<AgentMailThread>;
  updateThreadLabels?(
    input: { threadId: string; addLabels?: string[]; removeLabels?: string[] },
    signal?: AbortSignal,
  ): Promise<{ threadId: string; labels: string[] }>;
  deleteThreadPermanently?(threadId: string, signal?: AbortSignal): Promise<void>;
  getThreadAttachment?(
    input: { threadId: string; attachmentId: string },
    signal?: AbortSignal,
  ): Promise<AgentMailAttachmentMetadata>;
  listDrafts(
    input?: { pageToken?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<{ drafts: AgentMailDraftSummary[]; nextPageToken?: string }>;
  listMailboxDrafts?(
    input?: AgentMailListInput,
    signal?: AbortSignal,
  ): Promise<AgentMailPage<AgentMailDraftSummary>>;
  createDraft?(input: AgentMailCreateDraftInput, signal?: AbortSignal): Promise<AgentMailDraft>;
  createReplyDraft(
    input: {
      messageId: string;
      text: string;
      clientId: string;
      replyAll?: boolean;
      subject?: string;
    },
    signal?: AbortSignal,
  ): Promise<AgentMailDraft>;
  getDraft(draftId: string, signal?: AbortSignal): Promise<AgentMailDraft>;
  getDraftAttachment?(
    input: { draftId: string; attachmentId: string },
    signal?: AbortSignal,
  ): Promise<AgentMailAttachmentMetadata>;
  updateDraft(input: AgentMailUpdateDraftInput, signal?: AbortSignal): Promise<AgentMailDraft>;
  deleteDraft?(draftId: string, signal?: AbortSignal): Promise<void>;
  sendDraft(
    input: { draftId: string; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<AgentMailDeliveryResult>;
  sendMessage(
    input: AgentMailComposeInput & { to: string[]; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<AgentMailDeliveryResult>;
  replyToMessage?(
    input: Omit<AgentMailComposeInput, "subject"> & {
      messageId: string;
      idempotencyKey: string;
    },
    signal?: AbortSignal,
  ): Promise<AgentMailDeliveryResult>;
  replyAllToMessage?(
    input: Omit<AgentMailComposeInput, "to" | "cc" | "bcc" | "subject"> & {
      messageId: string;
      idempotencyKey: string;
    },
    signal?: AbortSignal,
  ): Promise<AgentMailDeliveryResult>;
  forwardMessage?(
    input: AgentMailComposeInput & { messageId: string; to: string[]; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<AgentMailDeliveryResult>;
  connect(
    handlers: {
      onEvent(event: AgentMailProviderEvent): void | Promise<void>;
      onOpen?(): void;
      onClose?(event: { code?: number }): void;
      onError?(error: AgentMailProviderError): void;
    },
    signal?: AbortSignal,
  ): Promise<AgentMailProviderSubscription>;
}

export interface AgentMailProviderOptions {
  apiKey: string;
  inboxId: string;
  apiBaseUrl?: string;
  websocketBaseUrl?: string;
  allowInsecureHttpWithCredentials?: boolean;
  timeoutInSeconds?: number;
  sdkClient?: AgentMailSdkClient;
}

interface AgentMailSdkSocket {
  readonly readyState?: number;
  /** Generated SDK wrapper exposes its reconnecting socket publicly. */
  readonly socket?: { binaryType: string };
  on(event: "open", callback: () => void): void;
  on(event: "message", callback: (event: unknown) => void): void;
  on(event: "close", callback: (event: { code?: number }) => void): void;
  on(event: "error", callback: (error: Error) => void): void;
  sendSubscribe(input: { type: "subscribe"; inboxIds: string[] }): void;
  waitForOpen(): Promise<unknown>;
  close(): void;
}

export interface AgentMailSdkClient {
  auth: { me(options?: unknown): Promise<unknown> };
  inboxes: {
    get(inboxId: string, options?: unknown): Promise<unknown>;
    messages: {
      list(
        inboxId: string,
        input?: AgentMail.inboxes.ListMessagesRequest,
        options?: unknown,
      ): Promise<unknown>;
      search(
        inboxId: string,
        input: AgentMail.inboxes.SearchMessagesRequest,
        options?: unknown,
      ): Promise<unknown>;
      get(inboxId: string, messageId: string, options?: unknown): Promise<unknown>;
      getAttachment(
        inboxId: string,
        messageId: string,
        attachmentId: string,
        options?: unknown,
      ): Promise<unknown>;
      update(
        inboxId: string,
        messageId: string,
        input: AgentMail.UpdateMessageRequest,
        options?: unknown,
      ): Promise<unknown>;
      delete(inboxId: string, messageId: string, options?: unknown): Promise<unknown>;
      send(
        inboxId: string,
        input: AgentMail.SendMessageRequest,
        options?: unknown,
      ): Promise<unknown>;
      reply(
        inboxId: string,
        messageId: string,
        input: AgentMail.ReplyToMessageRequest,
        options?: unknown,
      ): Promise<unknown>;
      replyAll(
        inboxId: string,
        messageId: string,
        input: AgentMail.ReplyAllMessageRequest,
        options?: unknown,
      ): Promise<unknown>;
      forward(
        inboxId: string,
        messageId: string,
        input: AgentMail.SendMessageRequest,
        options?: unknown,
      ): Promise<unknown>;
    };
    threads: {
      list(
        inboxId: string,
        input?: AgentMail.inboxes.ListThreadsRequest,
        options?: unknown,
      ): Promise<unknown>;
      search(
        inboxId: string,
        input: AgentMail.inboxes.SearchThreadsRequest,
        options?: unknown,
      ): Promise<unknown>;
      get(inboxId: string, threadId: string, options?: unknown): Promise<unknown>;
      getAttachment(
        inboxId: string,
        threadId: string,
        attachmentId: string,
        options?: unknown,
      ): Promise<unknown>;
      update(
        inboxId: string,
        threadId: string,
        input: AgentMail.UpdateThreadRequest,
        options?: unknown,
      ): Promise<unknown>;
      delete(inboxId: string, threadId: string, options?: unknown): Promise<unknown>;
    };
    drafts: {
      list(
        inboxId: string,
        input?: AgentMail.inboxes.ListDraftsRequest,
        options?: unknown,
      ): Promise<unknown>;
      create(
        inboxId: string,
        input: AgentMail.CreateDraftRequest,
        options?: unknown,
      ): Promise<unknown>;
      get(inboxId: string, draftId: string, options?: unknown): Promise<unknown>;
      getAttachment(
        inboxId: string,
        draftId: string,
        attachmentId: string,
        options?: unknown,
      ): Promise<unknown>;
      update(
        inboxId: string,
        draftId: string,
        input: AgentMail.UpdateDraftRequest,
        options?: unknown,
      ): Promise<unknown>;
      delete(inboxId: string, draftId: string, options?: unknown): Promise<unknown>;
      send(
        inboxId: string,
        draftId: string,
        input: AgentMail.UpdateMessageRequest,
        options?: unknown,
      ): Promise<unknown>;
    };
  };
  websockets: {
    connect(input?: {
      waitForOpen?: boolean;
      abortSignal?: AbortSignal;
    }): Promise<AgentMailSdkSocket>;
  };
}

const ID_PATTERN = /^[A-Za-z0-9._~@+\-:]+$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._~-]{1,256}$/;
const MAX_PAGE_SIZE = 100;
const MAX_FILTER_VALUES = 20;
const MAX_LABELS = 50;
const MAX_RECIPIENTS = 50;
const MAX_ATTACHMENTS = 50;
const MAX_BODY_BYTES = 1_048_576;
const MAX_ATTACHMENT_CONTENT_CHARS = 33_554_432;
const MAX_QUERY_CHARS = 1_024;

function requestError(operation: string, nextAction: string): AgentMailProviderError {
  return new AgentMailProviderError({
    code: "request_invalid",
    operation,
    phase: "request_validation",
    retryable: false,
    nextAction,
  });
}

function assertIdentifier(value: string, field: string): void {
  if (!value || value.length > 512 || !ID_PATTERN.test(value)) {
    throw new AgentMailProviderError({
      code: "configuration_invalid",
      operation: "validate",
      phase: "configuration",
      retryable: false,
      nextAction: `Set ${field} to the exact non-empty AgentMail identifier.`,
    });
  }
}

function assertIdempotencyValue(value: string, field: "clientId" | "idempotencyKey"): void {
  if (!IDEMPOTENCY_PATTERN.test(value)) {
    throw new AgentMailProviderError({
      code: "configuration_invalid",
      operation: "validate",
      phase: "request",
      retryable: false,
      nextAction: `${field} must use 1-256 characters from A-Z, a-z, 0-9, dot, underscore, tilde, or hyphen.`,
    });
  }
}

function assertLimit(limit: number | undefined, operation: string): void {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)) {
    throw requestError(operation, `limit must be an integer from 1 through ${MAX_PAGE_SIZE}.`);
  }
}

function assertEpoch(value: number | undefined, field: string, operation: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw requestError(operation, `${field} must be a valid non-negative epoch timestamp.`);
  }
}

function boundedStrings(
  values: string[] | undefined,
  field: string,
  operation: string,
  max = MAX_FILTER_VALUES,
): string[] | undefined {
  if (values === undefined) return undefined;
  if (values.length > max) throw requestError(operation, `${field} accepts at most ${max} values.`);
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => value.length === 0 || value.length > 256)) {
    throw requestError(operation, `${field} values must contain 1-256 characters.`);
  }
  return normalized;
}

function validateListInput(input: AgentMailListInput, operation: string): void {
  assertLimit(input.limit, operation);
  assertEpoch(input.before, "before", operation);
  assertEpoch(input.after, "after", operation);
  if (input.before !== undefined && input.after !== undefined && input.before <= input.after) {
    throw requestError(operation, "before must be later than after.");
  }
  if (
    input.pageToken !== undefined &&
    (input.pageToken.length === 0 || input.pageToken.length > 4_096)
  ) {
    throw requestError(operation, "pageToken must contain 1-4096 characters.");
  }
  boundedStrings(input.labels, "labels", operation, MAX_LABELS);
}

function validateSearchInput(input: AgentMailSearchInput, operation: string): void {
  validateListInput(input, operation);
  if (
    typeof input.query !== "string" ||
    input.query.trim().length === 0 ||
    input.query.length > MAX_QUERY_CHARS
  ) {
    throw requestError(operation, `query must contain 1-${MAX_QUERY_CHARS} characters.`);
  }
}

function boundedOptionalText(
  value: string | null | undefined,
  field: string,
  operation: string,
  maxBytes = MAX_BODY_BYTES,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw requestError(operation, `${field} exceeds the ${maxBytes}-byte provider boundary.`);
  }
  return value;
}

function normalizeOutboundMailboxes(
  values: string[] | null | undefined,
  field: string,
  operation: string,
): string[] | null | undefined {
  if (values === undefined || values === null) return values;
  if (values.length > MAX_RECIPIENTS) {
    throw requestError(operation, `${field} accepts at most ${MAX_RECIPIENTS} addresses.`);
  }
  return values.map((value) => {
    try {
      return normalizeMailboxAddress(value, operation);
    } catch {
      throw requestError(operation, `${field} contains an invalid mailbox address.`);
    }
  });
}

function normalizeSendAttachments(
  attachments: AgentMailSendAttachment[] | undefined,
  operation: string,
): AgentMail.SendAttachment[] | undefined {
  if (attachments === undefined) return undefined;
  if (attachments.length > MAX_ATTACHMENTS) {
    throw requestError(operation, `attachments accepts at most ${MAX_ATTACHMENTS} items.`);
  }
  return attachments.map((attachment) => {
    const hasContent = typeof attachment.content === "string";
    const hasUrl = typeof attachment.url === "string";
    if (hasContent === hasUrl) {
      throw requestError(operation, "each attachment must set exactly one of content or url.");
    }
    if (hasContent && (attachment.content?.length ?? 0) > MAX_ATTACHMENT_CONTENT_CHARS) {
      throw requestError(operation, "attachment content exceeds the provider boundary.");
    }
    if (hasUrl) {
      let parsed: URL;
      try {
        parsed = new URL(attachment.url as string);
      } catch {
        throw requestError(operation, "attachment url must be a valid HTTPS URL.");
      }
      if (parsed.protocol !== "https:") {
        throw requestError(operation, "attachment url must use HTTPS.");
      }
    }
    for (const [field, value, max] of [
      ["filename", attachment.filename, 512],
      ["contentType", attachment.contentType, 256],
      ["contentId", attachment.contentId, 512],
    ] as const) {
      if (value !== undefined && (value.length === 0 || value.length > max)) {
        throw requestError(operation, `attachment ${field} must contain 1-${max} characters.`);
      }
    }
    return { ...attachment };
  });
}

function asRecord(value: unknown, operation: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw contractError(operation);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, operation: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) {
    throw contractError(operation);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  operation: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 1_048_576) {
    throw contractError(operation);
  }
  return value;
}

function stringArray(value: unknown, operation: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw contractError(operation);
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 4_096) {
      throw contractError(operation);
    }
    result.push(item);
  }
  return result;
}

function timestamp(value: unknown, operation: string): number {
  const epoch = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  if (!Number.isFinite(epoch)) throw contractError(operation);
  return epoch;
}

function optionalTimestamp(value: unknown, operation: string): number | undefined {
  return value === undefined ? undefined : timestamp(value, operation);
}

function classificationFromLabels(labels: string[]): AgentMailMessageClassification {
  if (labels.includes("spam")) return "spam";
  if (labels.includes("blocked")) return "blocked";
  if (labels.includes("unauthenticated")) return "unauthenticated";
  return "received";
}

function normalizeStoredAttachment(value: unknown, operation: string): AgentMailDraftAttachment {
  const attachment = asRecord(value, operation);
  const size = attachment.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw contractError(operation);
  }
  const normalized: AgentMailDraftAttachment = {
    attachmentId: requiredString(attachment, "attachmentId", operation),
    size,
  };
  const filename = optionalString(attachment, "filename", operation);
  const contentType = optionalString(attachment, "contentType", operation);
  const contentId = optionalString(attachment, "contentId", operation);
  if (filename !== undefined) normalized.filename = filename;
  if (contentType !== undefined) normalized.contentType = contentType;
  if (contentId !== undefined) normalized.contentId = contentId;
  if (attachment.contentDisposition !== undefined) {
    if (
      attachment.contentDisposition !== "inline" &&
      attachment.contentDisposition !== "attachment"
    ) {
      throw contractError(operation);
    }
    normalized.contentDisposition = attachment.contentDisposition;
  }
  return normalized;
}

function normalizeAttachmentMetadata(
  value: unknown,
  expectedAttachmentId: string,
  operation: string,
): AgentMailAttachmentMetadata {
  const attachment = asRecord(value, operation);
  const normalized = normalizeStoredAttachment(attachment, operation);
  if (normalized.attachmentId !== expectedAttachmentId) throw contractError(operation);
  const downloadUrl = requiredString(attachment, "downloadUrl", operation);
  let parsed: URL;
  try {
    parsed = new URL(downloadUrl);
  } catch {
    throw contractError(operation);
  }
  if (parsed.protocol !== "https:") throw contractError(operation);
  return {
    ...normalized,
    downloadUrl,
    expiresAt: timestamp(attachment.expiresAt, operation),
  };
}

function normalizeMessageSummary(value: unknown, operation: string): AgentMailMessageSummary {
  const message = asRecord(value, operation);
  const labels = stringArray(message.labels, operation);
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  return {
    inboxId: requiredString(message, "inboxId", operation),
    threadId: requiredString(message, "threadId", operation),
    messageId: requiredString(message, "messageId", operation),
    sender: normalizeMailboxAddress(requiredString(message, "from", operation), operation),
    to: mailboxArray(message.to, operation),
    cc: mailboxArray(message.cc, operation),
    bcc: mailboxArray(message.bcc, operation),
    subject: optionalString(message, "subject", operation),
    preview: optionalString(message, "preview", operation),
    labels,
    timestamp: timestamp(message.timestamp, operation),
    updatedAt: timestamp(message.updatedAt, operation),
    size:
      typeof message.size === "number" && Number.isSafeInteger(message.size) && message.size >= 0
        ? message.size
        : 0,
    classification: classificationFromLabels(labels),
    attachmentCount: attachments.length,
    createdAt: optionalTimestamp(message.createdAt, operation),
  };
}

function normalizeMailboxAddress(value: string, operation: string): string {
  if (
    value.length > 998 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 0 || code === 10 || code === 13;
    })
  ) {
    throw contractError(operation);
  }
  const trimmed = value.trim();
  const open = trimmed.indexOf("<");
  const close = trimmed.indexOf(">");
  let candidate = trimmed;
  if (open !== -1 || close !== -1) {
    if (
      open <= 0 ||
      close !== trimmed.length - 1 ||
      open !== trimmed.lastIndexOf("<") ||
      close !== trimmed.lastIndexOf(">")
    ) {
      throw contractError(operation);
    }
    candidate = trimmed.slice(open + 1, close).trim();
  }
  const normalized = canonicalizeEmail(candidate);
  if (!isWellFormedEmail(normalized)) throw contractError(operation);
  return normalized;
}

function mailboxArray(value: unknown, operation: string): string[] {
  return stringArray(value, operation).map((address) =>
    normalizeMailboxAddress(address, operation),
  );
}

function normalizeMessage(value: unknown, operation: string): AgentMailMessage {
  const message = asRecord(value, operation);
  const summary = normalizeMessageSummary(message, operation);
  const rawAttachments = Array.isArray(message.attachments) ? message.attachments : [];
  return {
    ...summary,
    text: optionalString(message, "text", operation),
    html: optionalString(message, "html", operation),
    extractedText: optionalString(message, "extractedText", operation),
    extractedHtml: optionalString(message, "extractedHtml", operation),
    replyTo: mailboxArray(message.replyTo, operation),
    inReplyTo: optionalString(message, "inReplyTo", operation),
    references: stringArray(message.references, operation),
    attachments: rawAttachments.map((attachment) =>
      normalizeStoredAttachment(attachment, operation),
    ),
  };
}

function normalizeDraft(value: unknown, operation: string): AgentMailDraft {
  const draft = asRecord(value, operation);
  const attachments = Array.isArray(draft.attachments) ? draft.attachments : [];
  return {
    inboxId: requiredString(draft, "inboxId", operation),
    draftId: requiredString(draft, "draftId", operation),
    clientId: optionalString(draft, "clientId", operation),
    labels: stringArray(draft.labels, operation),
    replyTo: mailboxArray(draft.replyTo, operation),
    to: mailboxArray(draft.to, operation),
    cc: mailboxArray(draft.cc, operation),
    bcc: mailboxArray(draft.bcc, operation),
    subject: optionalString(draft, "subject", operation),
    text: optionalString(draft, "text", operation),
    html: optionalString(draft, "html", operation),
    preview: optionalString(draft, "preview", operation),
    attachments: attachments.map((attachment) => normalizeStoredAttachment(attachment, operation)),
    inReplyTo: optionalString(draft, "inReplyTo", operation),
    forwardOf: optionalString(draft, "forwardOf", operation),
    references: stringArray(draft.references, operation),
    sendStatus: optionalString(draft, "sendStatus", operation),
    sendAt: optionalTimestamp(draft.sendAt, operation),
    updatedAt: timestamp(draft.updatedAt, operation),
    createdAt: timestamp(draft.createdAt, operation),
  };
}

function normalizeDraftSummary(value: unknown, operation: string): AgentMailDraftSummary {
  const draft = asRecord(value, operation);
  const attachments = Array.isArray(draft.attachments) ? draft.attachments : [];
  return {
    inboxId: requiredString(draft, "inboxId", operation),
    draftId: requiredString(draft, "draftId", operation),
    labels: stringArray(draft.labels, operation),
    to: mailboxArray(draft.to, operation),
    cc: mailboxArray(draft.cc, operation),
    bcc: mailboxArray(draft.bcc, operation),
    subject: optionalString(draft, "subject", operation),
    preview: optionalString(draft, "preview", operation),
    attachments: attachments.map((attachment) => normalizeStoredAttachment(attachment, operation)),
    inReplyTo: optionalString(draft, "inReplyTo", operation),
    forwardOf: optionalString(draft, "forwardOf", operation),
    sendStatus: optionalString(draft, "sendStatus", operation),
    sendAt: optionalTimestamp(draft.sendAt, operation),
    updatedAt: timestamp(draft.updatedAt, operation),
  };
}

function normalizeThreadSummary(value: unknown, operation: string): AgentMailThreadSummary {
  const thread = asRecord(value, operation);
  const attachments = Array.isArray(thread.attachments) ? thread.attachments : [];
  const messageCount = thread.messageCount;
  const size = thread.size;
  if (
    typeof messageCount !== "number" ||
    !Number.isSafeInteger(messageCount) ||
    messageCount < 0 ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0
  ) {
    throw contractError(operation);
  }
  return {
    inboxId: requiredString(thread, "inboxId", operation),
    threadId: requiredString(thread, "threadId", operation),
    labels: stringArray(thread.labels, operation),
    timestamp: timestamp(thread.timestamp, operation),
    senders: mailboxArray(thread.senders, operation),
    recipients: mailboxArray(thread.recipients, operation),
    subject: optionalString(thread, "subject", operation),
    preview: optionalString(thread, "preview", operation),
    lastMessageId: requiredString(thread, "lastMessageId", operation),
    messageCount,
    size,
    updatedAt: timestamp(thread.updatedAt, operation),
    createdAt: timestamp(thread.createdAt, operation),
    attachmentCount: attachments.length,
  };
}

function normalizeThread(
  value: unknown,
  expectedThreadId: string,
  operation: string,
): AgentMailThread {
  const thread = asRecord(value, operation);
  const messages = thread.messages;
  if (!Array.isArray(messages) || messages.length > 1_000) throw contractError(operation);
  const summary = normalizeThreadSummary(thread, operation);
  if (summary.threadId !== expectedThreadId) throw contractError(operation);
  return {
    ...summary,
    messages: messages.map((message) => normalizeMessage(message, operation)),
  };
}

function normalizePage<T>(
  value: unknown,
  arrayKey: "messages" | "threads" | "drafts",
  operation: string,
  normalizeItem: (item: unknown, operation: string) => T,
): AgentMailPage<T> {
  const page = asRecord(value, operation);
  const items = page[arrayKey];
  if (!Array.isArray(items) || items.length > MAX_PAGE_SIZE) throw contractError(operation);
  const count = page.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < items.length) {
    throw contractError(operation);
  }
  const limit = page.limit;
  if (
    limit !== undefined &&
    (typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      limit > MAX_PAGE_SIZE)
  ) {
    throw contractError(operation);
  }
  const nextPageToken = optionalString(page, "nextPageToken", operation);
  return {
    items: items.map((item) => normalizeItem(item, operation)),
    count,
    ...(limit === undefined ? {} : { limit }),
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
  };
}

function normalizeLabelMutation(
  value: unknown,
  expectedId: string,
  idKey: "messageId" | "threadId",
  operation: string,
): { labels: string[] } & Record<typeof idKey, string> {
  const result = asRecord(value, operation);
  const id = requiredString(result, idKey, operation);
  if (id !== expectedId) throw contractError(operation);
  return { [idKey]: id, labels: stringArray(result.labels, operation) } as {
    labels: string[];
  } & Record<typeof idKey, string>;
}

function normalizeDelivery(value: unknown, operation: string): AgentMailDeliveryResult {
  const sent = asRecord(value, operation);
  return {
    messageId: requiredString(sent, "messageId", operation),
    threadId: requiredString(sent, "threadId", operation),
  };
}

function contractError(operation: string): AgentMailProviderError {
  return new AgentMailProviderError({
    code: "provider_contract_invalid",
    operation,
    phase: "response_validation",
    retryable: false,
    nextAction:
      "Update Auggy or inspect AgentMail API contract drift; the affected item was quarantined.",
  });
}

function providerCode(error: AgentMailError): string | undefined {
  const body = error.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const code = (body as Record<string, unknown>).code;
  return typeof code === "string" && code.length <= 128 ? code : undefined;
}

function providerName(error: AgentMailError): string | undefined {
  const body = error.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const name = (body as Record<string, unknown>).name;
  return typeof name === "string" && name.length <= 128 ? name : undefined;
}

function retryAfterSeconds(error: AgentMailError): number | undefined {
  const headers = error.rawResponse?.headers;
  const raw = headers?.get("retry-after");
  if (raw === null || raw === undefined) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400 ? seconds : undefined;
}

function mapError(
  error: unknown,
  context: Omit<AgentMailProviderErrorDetails, "code" | "retryable" | "nextAction"> & {
    mutation?: boolean;
  },
): AgentMailProviderError {
  if (error instanceof AgentMailProviderError) return error;
  const status = error instanceof AgentMailError ? error.statusCode : undefined;
  const code = error instanceof AgentMailError ? providerCode(error) : undefined;
  const name = error instanceof AgentMailError ? providerName(error) : undefined;
  let mapped: Pick<AgentMailProviderErrorDetails, "code" | "retryable" | "nextAction">;
  if (status === 400) {
    mapped = {
      code: "request_invalid",
      retryable: false,
      nextAction: "Correct the bounded AgentMail request; the provider rejected its fields.",
    };
  } else if (status === 401) {
    mapped = {
      code: "credential_rejected",
      retryable: false,
      nextAction: "Check AGENTMAIL_API_KEY. Auggy will not create or replace the supplied key.",
    };
  } else if (status === 403) {
    const rejected =
      code === "message_rejected" || name === "MessageRejectedError" || name === "MessageRejected";
    mapped = rejected
      ? {
          code: "message_rejected",
          retryable: false,
          nextAction:
            "Review the message content and provider rejection policy before trying again.",
        }
      : {
          code: "permission_missing",
          retryable: false,
          nextAction: "Grant the supplied AgentMail key the permission required by this operation.",
        };
  } else if (status === 404) {
    mapped = {
      code: "resource_not_found",
      retryable: false,
      nextAction: "Verify the configured inbox and provider resource identifiers.",
    };
  } else if (status === 409) {
    mapped = {
      code: "resource_conflict",
      retryable: false,
      nextAction: "Refetch the provider object and require creator review before changing it.",
    };
  } else if (status === 429) {
    mapped = {
      code: "provider_rate_limited",
      retryable: true,
      nextAction: "Leave the durable operation pending and retry after the provider limit resets.",
    };
  } else if (status === 422) {
    mapped = {
      code: "resource_unprocessable",
      retryable: false,
      nextAction: "Reduce or correct the requested resource mutation before trying again.",
    };
  } else if (typeof status === "number" && status >= 500) {
    mapped = {
      code: context.mutation ? "mutation_ambiguous" : "provider_unavailable",
      retryable: !context.mutation,
      nextAction: context.mutation
        ? "Reconcile by provider ID before retrying the mutation."
        : "Keep durable work pending and retry with backoff.",
    };
  } else if (error instanceof AgentMailTimeoutError || status === undefined) {
    mapped = {
      code: context.mutation ? "mutation_ambiguous" : "provider_unavailable",
      retryable: !context.mutation,
      nextAction: context.mutation
        ? "The provider may have applied the mutation; reconcile before retrying."
        : "Retry after connectivity is restored.",
    };
  } else {
    mapped = {
      code: "provider_contract_invalid",
      retryable: false,
      nextAction: "Inspect the operation and update Auggy for the provider contract.",
    };
  }
  const { mutation: _mutation, ...safeContext } = context;
  const retryAfter = error instanceof AgentMailError ? retryAfterSeconds(error) : undefined;
  return new AgentMailProviderError({
    ...safeContext,
    ...mapped,
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(code === undefined ? {} : { providerCode: code }),
    ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
  });
}

function requestOptions(signal?: AbortSignal, idempotencyKey?: string): Record<string, unknown> {
  return {
    maxRetries: 0,
    ...(signal === undefined ? {} : { abortSignal: signal }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

function sdkClient(options: AgentMailProviderOptions): AgentMailSdkClient {
  if (options.sdkClient) return options.sdkClient;
  const environment = {
    http: options.apiBaseUrl ?? AgentMailEnvironment.Prod.http,
    websockets: options.websocketBaseUrl ?? AgentMailEnvironment.Prod.websockets,
  };
  return new AgentMailClient({
    apiKey: options.apiKey,
    environment,
    timeoutInSeconds: options.timeoutInSeconds ?? 30,
    maxRetries: 0,
  }) as unknown as AgentMailSdkClient;
}

function normalizeEvent(value: unknown, configuredInboxId: string): AgentMailProviderEvent | null {
  const event = asRecord(value, "receive_event");
  if (event.type === "subscribed") return null;
  const eventType = requiredString(event, "eventType", "receive_event");
  const eventId = requiredString(event, "eventId", "receive_event");
  if (eventType.startsWith("message.received")) {
    const message = normalizeMessageSummary(event.message, "receive_event");
    if (message.inboxId !== configuredInboxId) return null;
    const classification: AgentMailMessageClassification =
      eventType === "message.received.spam"
        ? "spam"
        : eventType === "message.received.blocked"
          ? "blocked"
          : eventType === "message.received.unauthenticated"
            ? "unauthenticated"
            : "received";
    return { type: "message.received", eventId, classification, message };
  }
  const field =
    eventType === "message.sent"
      ? "send"
      : eventType === "message.delivered"
        ? "delivery"
        : eventType === "message.bounced"
          ? "bounce"
          : eventType === "message.complained"
            ? "complaint"
            : eventType === "message.rejected"
              ? "reject"
              : null;
  if (field === null) return null;
  const detail = asRecord(event[field], "receive_event");
  const inboxId = requiredString(detail, "inboxId", "receive_event");
  if (inboxId !== configuredInboxId) return null;
  return {
    type: eventType,
    eventId,
    inboxId,
    threadId: requiredString(detail, "threadId", "receive_event"),
    messageId: requiredString(detail, "messageId", "receive_event"),
    timestamp: timestamp(detail.timestamp, "receive_event"),
  } as AgentMailProviderEvent;
}

function listRequest(
  input: AgentMailListInput,
  operation: string,
): {
  limit: number;
  pageToken?: string;
  labels?: string[];
  before?: Date;
  after?: Date;
  ascending?: boolean;
} {
  validateListInput(input, operation);
  return {
    limit: input.limit ?? MAX_PAGE_SIZE,
    ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
    ...(input.labels === undefined
      ? {}
      : { labels: boundedStrings(input.labels, "labels", operation) }),
    ...(input.before === undefined ? {} : { before: new Date(input.before) }),
    ...(input.after === undefined ? {} : { after: new Date(input.after) }),
    ...(input.ascending === undefined ? {} : { ascending: input.ascending }),
  };
}

function searchRequest(
  input: AgentMailSearchInput,
  operation: string,
): {
  q: string;
  pageToken?: string;
  limit?: number;
  before?: Date;
  after?: Date;
} {
  validateSearchInput(input, operation);
  return {
    q: input.query.trim(),
    ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.before === undefined ? {} : { before: new Date(input.before) }),
    ...(input.after === undefined ? {} : { after: new Date(input.after) }),
  };
}

function composeRequest(
  input: AgentMailComposeInput,
  operation: string,
): AgentMail.SendMessageRequest {
  const request: AgentMail.SendMessageRequest = {};
  const to = normalizeOutboundMailboxes(input.to, "to", operation);
  const cc = normalizeOutboundMailboxes(input.cc, "cc", operation);
  const bcc = normalizeOutboundMailboxes(input.bcc, "bcc", operation);
  const replyTo = normalizeOutboundMailboxes(input.replyTo, "replyTo", operation);
  const totalRecipients = (to?.length ?? 0) + (cc?.length ?? 0) + (bcc?.length ?? 0);
  if (totalRecipients > MAX_RECIPIENTS) {
    throw requestError(
      operation,
      `combined to, cc, and bcc accepts at most ${MAX_RECIPIENTS} addresses.`,
    );
  }
  if (to !== undefined && to !== null) request.to = to;
  if (cc !== undefined && cc !== null) request.cc = cc;
  if (bcc !== undefined && bcc !== null) request.bcc = bcc;
  if (replyTo !== undefined && replyTo !== null) request.replyTo = replyTo;
  const subject = boundedOptionalText(input.subject, "subject", operation, 998);
  const text = boundedOptionalText(input.text, "text", operation);
  const html = boundedOptionalText(input.html, "html", operation);
  if (subject !== undefined && subject !== null) request.subject = subject;
  if (text !== undefined && text !== null) request.text = text;
  if (html !== undefined && html !== null) request.html = html;
  if (input.labels !== undefined) {
    request.labels = boundedStrings(input.labels, "labels", operation, MAX_LABELS);
  }
  const attachments = normalizeSendAttachments(input.attachments, operation);
  if (attachments !== undefined) request.attachments = attachments;
  return request;
}

function assertDeliveryContent(
  request: AgentMail.SendMessageRequest,
  operation: string,
  requireRecipient: boolean,
): void {
  if (
    requireRecipient &&
    (request.to?.length ?? 0) + (request.cc?.length ?? 0) + (request.bcc?.length ?? 0) < 1
  ) {
    throw requestError(operation, "at least one recipient is required.");
  }
  if (!request.text && !request.html) {
    throw requestError(operation, "text or html content is required for delivery.");
  }
}

function labelRequest(
  input: { addLabels?: string[]; removeLabels?: string[] },
  operation: string,
): { addLabels?: string[]; removeLabels?: string[] } {
  const addLabels = boundedStrings(input.addLabels, "addLabels", operation, MAX_LABELS);
  const removeLabels = boundedStrings(input.removeLabels, "removeLabels", operation, MAX_LABELS);
  if ((addLabels?.length ?? 0) === 0 && (removeLabels?.length ?? 0) === 0) {
    throw requestError(operation, "addLabels or removeLabels must contain at least one label.");
  }
  return {
    ...(addLabels === undefined ? {} : { addLabels }),
    ...(removeLabels === undefined ? {} : { removeLabels }),
  };
}

export function createAgentMailProvider(options: AgentMailProviderOptions): AgentMailProvider {
  if (typeof options.apiKey !== "string" || options.apiKey.length === 0) {
    throw new AgentMailProviderError({
      code: "configuration_invalid",
      operation: "validate",
      phase: "configuration",
      retryable: false,
      nextAction: "Set AGENTMAIL_API_KEY to the key Auggy should use at runtime.",
    });
  }
  assertIdentifier(options.inboxId, "AGENTMAIL_INBOX_ID");
  const apiUrl = options.apiBaseUrl ?? AgentMailEnvironment.Prod.http;
  const websocketUrl = options.websocketBaseUrl ?? AgentMailEnvironment.Prod.websockets;
  assertSecureCredentialTransport({
    provider: "AgentMail",
    baseURL: apiUrl,
    credential: options.apiKey,
    allowInsecureHttpWithCredentials: options.allowInsecureHttpWithCredentials,
  });
  assertSecureWebSocketCredentialTransport({
    provider: "AgentMail",
    baseURL: websocketUrl,
    credential: options.apiKey,
    allowInsecureHttpWithCredentials: options.allowInsecureHttpWithCredentials,
  });
  const client = sdkClient(options);
  const inboxId = options.inboxId;

  async function call<T>(
    context: Parameters<typeof mapError>[1],
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw mapError(error, context);
    }
  }

  async function mutate<T>(
    context: Parameters<typeof mapError>[1],
    operation: () => Promise<unknown>,
    normalize: (value: unknown) => T,
  ): Promise<T> {
    const value = await call({ ...context, mutation: true }, operation);
    try {
      return normalize(value);
    } catch (error) {
      if (!(error instanceof AgentMailProviderError)) throw error;
      throw new AgentMailProviderError({
        code: "mutation_ambiguous",
        operation: context.operation,
        phase: "response_validation",
        retryable: false,
        nextAction:
          "AgentMail may have applied the mutation but returned an invalid result; reconcile the provider resource before retrying.",
        ...(context.inboxId === undefined ? {} : { inboxId: context.inboxId }),
        ...(context.messageId === undefined ? {} : { messageId: context.messageId }),
        ...(context.draftId === undefined ? {} : { draftId: context.draftId }),
        ...(context.threadId === undefined ? {} : { threadId: context.threadId }),
        ...(context.attachmentId === undefined ? {} : { attachmentId: context.attachmentId }),
      });
    }
  }

  async function createProviderDraft(
    input: AgentMailCreateDraftInput,
    signal?: AbortSignal,
  ): Promise<AgentMailDraft> {
    const operation = "create_draft";
    assertIdempotencyValue(input.clientId, "clientId");
    if (input.kind === "new" && input.sourceMessageId !== undefined) {
      throw requestError(operation, "a new draft cannot reference a source message.");
    }
    if (input.kind !== "new") {
      if (input.sourceMessageId === undefined) {
        throw requestError(operation, `${input.kind} drafts require sourceMessageId.`);
      }
      assertIdentifier(input.sourceMessageId, "sourceMessageId");
    }
    if (
      input.kind === "replyAll" &&
      (input.to !== undefined || input.cc !== undefined || input.bcc !== undefined)
    ) {
      throw requestError(operation, "reply-all draft recipients are derived by AgentMail.");
    }
    const composed = composeRequest(input, operation);
    const request: AgentMail.CreateDraftRequest = {
      ...(composed.labels === undefined ? {} : { labels: composed.labels }),
      ...(composed.replyTo === undefined ? {} : { replyTo: composed.replyTo as string[] }),
      ...(composed.to === undefined ? {} : { to: composed.to as string[] }),
      ...(composed.cc === undefined ? {} : { cc: composed.cc as string[] }),
      ...(composed.bcc === undefined ? {} : { bcc: composed.bcc as string[] }),
      ...(composed.subject === undefined ? {} : { subject: composed.subject }),
      ...(composed.text === undefined ? {} : { text: composed.text }),
      ...(composed.html === undefined ? {} : { html: composed.html }),
      ...(composed.attachments === undefined ? {} : { attachments: composed.attachments }),
      clientId: input.clientId,
      ...(input.kind === "reply" || input.kind === "replyAll"
        ? { inReplyTo: input.sourceMessageId }
        : {}),
      ...(input.kind === "replyAll" ? { replyAll: true } : {}),
      ...(input.kind === "forward" ? { forwardOf: input.sourceMessageId } : {}),
    };
    return mutate(
      {
        operation,
        phase: "drafting",
        inboxId,
        ...(input.sourceMessageId === undefined ? {} : { messageId: input.sourceMessageId }),
      },
      () => client.inboxes.drafts.create(inboxId, request, requestOptions(signal)),
      (value) => {
        const draft = normalizeDraft(value, operation);
        if (
          draft.inboxId !== inboxId ||
          draft.clientId !== input.clientId ||
          ((input.kind === "reply" || input.kind === "replyAll") &&
            draft.inReplyTo !== input.sourceMessageId) ||
          (input.kind === "forward" && draft.forwardOf !== input.sourceMessageId)
        ) {
          throw contractError(operation);
        }
        return draft;
      },
    );
  }

  return {
    async verifyAccess(signal) {
      const [identityValue, inboxValue] = await Promise.all([
        call({ operation: "auth_me", phase: "readiness", inboxId }, () =>
          client.auth.me(requestOptions(signal)),
        ),
        call({ operation: "get_inbox", phase: "readiness", inboxId }, () =>
          client.inboxes.get(inboxId, requestOptions(signal)),
        ),
      ]);
      const identity = asRecord(identityValue, "auth_me");
      const inbox = asRecord(inboxValue, "get_inbox");
      const canonicalInboxId = requiredString(inbox, "inboxId", "get_inbox");
      if (canonicalInboxId !== inboxId) throw contractError("get_inbox");
      const scopedInbox = optionalString(identity, "inboxId", "auth_me");
      if (scopedInbox !== undefined && scopedInbox !== inboxId) {
        throw new AgentMailProviderError({
          code: "permission_missing",
          operation: "auth_me",
          phase: "readiness",
          retryable: false,
          nextAction: "Use a key scoped to the configured inbox or a parent organization/pod.",
          inboxId,
        });
      }
      return {
        scopeType: requiredString(identity, "scopeType", "auth_me"),
        scopeId: requiredString(identity, "scopeId", "auth_me"),
        organizationId: requiredString(identity, "organizationId", "auth_me"),
        ...(scopedInbox === undefined ? {} : { inboxId: scopedInbox }),
        configuredInboxId: inboxId,
        emailAddress: optionalString(inbox, "emailAddress", "get_inbox") ?? canonicalInboxId,
      };
    },

    async listMailboxMessages(input = {}, signal) {
      const operation = "list_mailbox_messages";
      const request: AgentMail.inboxes.ListMessagesRequest = {
        ...listRequest(input, operation),
        ...(input.from === undefined
          ? {}
          : { from: boundedStrings(input.from, "from", operation) }),
        ...(input.to === undefined ? {} : { to: boundedStrings(input.to, "to", operation) }),
        ...(input.subject === undefined
          ? {}
          : { subject: boundedStrings(input.subject, "subject", operation) }),
        ...(input.includeSpam === undefined ? {} : { includeSpam: input.includeSpam }),
        ...(input.includeBlocked === undefined ? {} : { includeBlocked: input.includeBlocked }),
        ...(input.includeUnauthenticated === undefined
          ? {}
          : { includeUnauthenticated: input.includeUnauthenticated }),
        ...(input.includeTrash === undefined ? {} : { includeTrash: input.includeTrash }),
      };
      const value = await call({ operation, phase: "listing", inboxId }, () =>
        client.inboxes.messages.list(inboxId, request, requestOptions(signal)),
      );
      const page = normalizePage(value, "messages", operation, normalizeMessageSummary);
      if (page.items.some((message) => message.inboxId !== inboxId)) throw contractError(operation);
      return page;
    },

    async searchMessages(input, signal) {
      const operation = "search_messages";
      const search = searchRequest(input, operation);
      const request: AgentMail.inboxes.SearchMessagesRequest = {
        q: search.q,
        limit: search.limit ?? MAX_PAGE_SIZE,
        ...(search.pageToken === undefined ? {} : { pageToken: search.pageToken }),
        ...(search.before === undefined ? {} : { before: search.before }),
        ...(search.after === undefined ? {} : { after: search.after }),
      };
      const value = await call({ operation, phase: "search", inboxId }, () =>
        client.inboxes.messages.search(inboxId, request, requestOptions(signal)),
      );
      const page = normalizePage(value, "messages", operation, normalizeMessageSummary);
      if (page.items.some((message) => message.inboxId !== inboxId)) throw contractError(operation);
      return page;
    },

    async listMessages(input = {}, signal) {
      if (
        input.limit !== undefined &&
        (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
      ) {
        throw contractError("list_messages");
      }
      const value = await call({ operation: "list_messages", phase: "catch_up", inboxId }, () =>
        client.inboxes.messages.list(
          inboxId,
          {
            limit: input.limit ?? 100,
            ascending: true,
            // AgentMail inbox history includes both received and sent mail.
            // Catch-up is an inbound recovery path, so constrain the provider
            // query before any item can reach the durable message ledger.
            labels: ["received"],
            ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
            ...(input.after === undefined ? {} : { after: new Date(input.after) }),
          },
          requestOptions(signal),
        ),
      );
      const page = asRecord(value, "list_messages");
      if (!Array.isArray(page.messages)) throw contractError("list_messages");
      const messages = page.messages.map((message) =>
        normalizeMessageSummary(message, "list_messages"),
      );
      // Fail closed if the provider ever stops honoring the direction filter.
      // Treating a sent message as inbound could wake the agent on its own
      // output and create a reply-draft feedback loop.
      if (messages.some((message) => !message.labels.includes("received"))) {
        throw contractError("list_messages");
      }
      const nextPageToken = optionalString(page, "nextPageToken", "list_messages");
      return {
        messages,
        ...(nextPageToken === undefined ? {} : { nextPageToken }),
      };
    },

    async getMessage(messageId, signal) {
      assertIdentifier(messageId, "messageId");
      const value = await call(
        { operation: "get_message", phase: "triage", inboxId, messageId },
        () => client.inboxes.messages.get(inboxId, messageId, requestOptions(signal)),
      );
      const message = normalizeMessage(value, "get_message");
      if (message.inboxId !== inboxId || message.messageId !== messageId)
        throw contractError("get_message");
      return message;
    },

    async updateMessageLabels(input, signal) {
      assertIdentifier(input.messageId, "messageId");
      const operation = "update_message_labels";
      const request = labelRequest(input, operation);
      return mutate(
        { operation, phase: "labeling", inboxId, messageId: input.messageId },
        () =>
          client.inboxes.messages.update(inboxId, input.messageId, request, requestOptions(signal)),
        (value) => normalizeLabelMutation(value, input.messageId, "messageId", operation),
      );
    },

    async deleteMessagePermanently(messageId, signal) {
      assertIdentifier(messageId, "messageId");
      await call(
        {
          operation: "delete_message_permanently",
          phase: "deletion",
          inboxId,
          messageId,
          mutation: true,
        },
        () => client.inboxes.messages.delete(inboxId, messageId, requestOptions(signal)),
      );
    },

    async getMessageAttachment(input, signal) {
      assertIdentifier(input.messageId, "messageId");
      assertIdentifier(input.attachmentId, "attachmentId");
      const operation = "get_message_attachment";
      const value = await call(
        {
          operation,
          phase: "attachment_lookup",
          inboxId,
          messageId: input.messageId,
          attachmentId: input.attachmentId,
        },
        () =>
          client.inboxes.messages.getAttachment(
            inboxId,
            input.messageId,
            input.attachmentId,
            requestOptions(signal),
          ),
      );
      return normalizeAttachmentMetadata(value, input.attachmentId, operation);
    },

    async listThreads(input = {}, signal) {
      const operation = "list_threads";
      const request: AgentMail.inboxes.ListThreadsRequest = {
        ...listRequest(input, operation),
        ...(input.senders === undefined
          ? {}
          : { senders: boundedStrings(input.senders, "senders", operation) }),
        ...(input.recipients === undefined
          ? {}
          : { recipients: boundedStrings(input.recipients, "recipients", operation) }),
        ...(input.subject === undefined
          ? {}
          : { subject: boundedStrings(input.subject, "subject", operation) }),
        ...(input.includeSpam === undefined ? {} : { includeSpam: input.includeSpam }),
        ...(input.includeBlocked === undefined ? {} : { includeBlocked: input.includeBlocked }),
        ...(input.includeUnauthenticated === undefined
          ? {}
          : { includeUnauthenticated: input.includeUnauthenticated }),
        ...(input.includeTrash === undefined ? {} : { includeTrash: input.includeTrash }),
      };
      const value = await call({ operation, phase: "listing", inboxId }, () =>
        client.inboxes.threads.list(inboxId, request, requestOptions(signal)),
      );
      const page = normalizePage(value, "threads", operation, normalizeThreadSummary);
      if (page.items.some((thread) => thread.inboxId !== inboxId)) throw contractError(operation);
      return page;
    },

    async searchThreads(input, signal) {
      const operation = "search_threads";
      const search = searchRequest(input, operation);
      const request: AgentMail.inboxes.SearchThreadsRequest = {
        q: search.q,
        limit: search.limit ?? MAX_PAGE_SIZE,
        ...(search.pageToken === undefined ? {} : { pageToken: search.pageToken }),
        ...(search.before === undefined ? {} : { before: search.before }),
        ...(search.after === undefined ? {} : { after: search.after }),
      };
      const value = await call({ operation, phase: "search", inboxId }, () =>
        client.inboxes.threads.search(inboxId, request, requestOptions(signal)),
      );
      const page = normalizePage(value, "threads", operation, normalizeThreadSummary);
      if (page.items.some((thread) => thread.inboxId !== inboxId)) throw contractError(operation);
      return page;
    },

    async getThread(threadId, signal) {
      assertIdentifier(threadId, "threadId");
      const operation = "get_thread";
      const value = await call({ operation, phase: "review", inboxId, threadId }, () =>
        client.inboxes.threads.get(inboxId, threadId, requestOptions(signal)),
      );
      const normalized = normalizeThread(value, threadId, operation);
      if (normalized.inboxId !== inboxId) throw contractError(operation);
      return normalized;
    },

    async updateThreadLabels(input, signal) {
      assertIdentifier(input.threadId, "threadId");
      const operation = "update_thread_labels";
      const request = labelRequest(input, operation);
      return mutate(
        { operation, phase: "labeling", inboxId, threadId: input.threadId },
        () =>
          client.inboxes.threads.update(inboxId, input.threadId, request, requestOptions(signal)),
        (value) => normalizeLabelMutation(value, input.threadId, "threadId", operation),
      );
    },

    async deleteThreadPermanently(threadId, signal) {
      assertIdentifier(threadId, "threadId");
      await call(
        {
          operation: "delete_thread_permanently",
          phase: "deletion",
          inboxId,
          threadId,
          mutation: true,
        },
        () => client.inboxes.threads.delete(inboxId, threadId, requestOptions(signal)),
      );
    },

    async getThreadAttachment(input, signal) {
      assertIdentifier(input.threadId, "threadId");
      assertIdentifier(input.attachmentId, "attachmentId");
      const operation = "get_thread_attachment";
      const value = await call(
        {
          operation,
          phase: "attachment_lookup",
          inboxId,
          threadId: input.threadId,
          attachmentId: input.attachmentId,
        },
        () =>
          client.inboxes.threads.getAttachment(
            inboxId,
            input.threadId,
            input.attachmentId,
            requestOptions(signal),
          ),
      );
      return normalizeAttachmentMetadata(value, input.attachmentId, operation);
    },

    async listDrafts(input = {}, signal) {
      if (
        input.limit !== undefined &&
        (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
      ) {
        throw contractError("list_drafts");
      }
      const value = await call({ operation: "list_drafts", phase: "review", inboxId }, () =>
        client.inboxes.drafts.list(
          inboxId,
          {
            limit: input.limit ?? 100,
            ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
          },
          requestOptions(signal),
        ),
      );
      const page = asRecord(value, "list_drafts");
      if (!Array.isArray(page.drafts)) throw contractError("list_drafts");
      const nextPageToken = optionalString(page, "nextPageToken", "list_drafts");
      return {
        drafts: page.drafts.map((draft) => normalizeDraftSummary(draft, "list_drafts")),
        ...(nextPageToken === undefined ? {} : { nextPageToken }),
      };
    },

    async listMailboxDrafts(input = {}, signal) {
      const operation = "list_mailbox_drafts";
      const request = listRequest(input, operation);
      const value = await call({ operation, phase: "listing", inboxId }, () =>
        client.inboxes.drafts.list(inboxId, request, requestOptions(signal)),
      );
      const page = normalizePage(value, "drafts", operation, normalizeDraftSummary);
      if (page.items.some((draft) => draft.inboxId !== inboxId)) throw contractError(operation);
      return page;
    },

    async createDraft(input, signal) {
      return createProviderDraft(input, signal);
    },

    async createReplyDraft(input, signal) {
      return createProviderDraft(
        {
          kind: input.replyAll === true ? "replyAll" : "reply",
          sourceMessageId: input.messageId,
          text: input.text,
          clientId: input.clientId,
          ...(input.subject === undefined ? {} : { subject: input.subject }),
        },
        signal,
      );
    },

    async getDraft(draftId, signal) {
      assertIdentifier(draftId, "draftId");
      const value = await call({ operation: "get_draft", phase: "review", inboxId, draftId }, () =>
        client.inboxes.drafts.get(inboxId, draftId, requestOptions(signal)),
      );
      const draft = normalizeDraft(value, "get_draft");
      if (draft.inboxId !== inboxId || draft.draftId !== draftId) throw contractError("get_draft");
      return draft;
    },

    async getDraftAttachment(input, signal) {
      assertIdentifier(input.draftId, "draftId");
      assertIdentifier(input.attachmentId, "attachmentId");
      const operation = "get_draft_attachment";
      const value = await call(
        {
          operation,
          phase: "attachment_lookup",
          inboxId,
          draftId: input.draftId,
          attachmentId: input.attachmentId,
        },
        () =>
          client.inboxes.drafts.getAttachment(
            inboxId,
            input.draftId,
            input.attachmentId,
            requestOptions(signal),
          ),
      );
      return normalizeAttachmentMetadata(value, input.attachmentId, operation);
    },

    async updateDraft(input, signal) {
      assertIdentifier(input.draftId, "draftId");
      const operation = "update_draft";
      const request: AgentMail.UpdateDraftRequest = {};
      const replyTo = normalizeOutboundMailboxes(input.replyTo, "replyTo", operation);
      const to = normalizeOutboundMailboxes(input.to, "to", operation);
      const cc = normalizeOutboundMailboxes(input.cc, "cc", operation);
      const bcc = normalizeOutboundMailboxes(input.bcc, "bcc", operation);
      if (replyTo !== undefined) request.replyTo = replyTo;
      if (to !== undefined) request.to = to;
      if (cc !== undefined) request.cc = cc;
      if (bcc !== undefined) request.bcc = bcc;
      if (input.subject !== undefined) {
        request.subject = boundedOptionalText(input.subject, "subject", operation, 998);
      }
      if (input.text !== undefined) {
        request.text = boundedOptionalText(input.text, "text", operation);
      }
      if (input.html !== undefined) {
        request.html = boundedOptionalText(input.html, "html", operation);
      }
      const addAttachments = normalizeSendAttachments(input.addAttachments, operation);
      if (addAttachments !== undefined) request.addAttachments = addAttachments;
      const removeAttachments = boundedStrings(
        input.removeAttachmentIds,
        "removeAttachmentIds",
        operation,
        MAX_ATTACHMENTS,
      );
      if (removeAttachments !== undefined) request.removeAttachments = removeAttachments;
      const addLabels = boundedStrings(input.addLabels, "addLabels", operation, MAX_LABELS);
      if (addLabels !== undefined) request.addLabels = addLabels;
      const removeLabels = boundedStrings(
        input.removeLabels,
        "removeLabels",
        operation,
        MAX_LABELS,
      );
      if (removeLabels !== undefined) request.removeLabels = removeLabels;
      if (Object.keys(request).length === 0) {
        throw requestError(operation, "at least one draft field must be changed.");
      }
      return mutate(
        {
          operation,
          phase: "revision",
          inboxId,
          draftId: input.draftId,
        },
        () => client.inboxes.drafts.update(inboxId, input.draftId, request, requestOptions(signal)),
        (value) => {
          const draft = normalizeDraft(value, operation);
          if (draft.inboxId !== inboxId || draft.draftId !== input.draftId) {
            throw contractError(operation);
          }
          return draft;
        },
      );
    },

    async deleteDraft(draftId, signal) {
      assertIdentifier(draftId, "draftId");
      await call(
        {
          operation: "delete_draft",
          phase: "deletion",
          inboxId,
          draftId,
          mutation: true,
        },
        () => client.inboxes.drafts.delete(inboxId, draftId, requestOptions(signal)),
      );
    },

    async sendDraft(input, signal) {
      assertIdentifier(input.draftId, "draftId");
      assertIdempotencyValue(input.idempotencyKey, "idempotencyKey");
      const operation = "send_draft";
      return mutate(
        {
          operation,
          phase: "sending",
          inboxId,
          draftId: input.draftId,
        },
        () =>
          client.inboxes.drafts.send(
            inboxId,
            input.draftId,
            {},
            requestOptions(signal, input.idempotencyKey),
          ),
        (value) => normalizeDelivery(value, operation),
      );
    },

    async sendMessage(input, signal) {
      assertIdempotencyValue(input.idempotencyKey, "idempotencyKey");
      const operation = "send_message";
      const request = composeRequest(input, operation);
      assertDeliveryContent(request, operation, true);
      return mutate(
        { operation, phase: "sending", inboxId },
        () =>
          client.inboxes.messages.send(
            inboxId,
            request,
            requestOptions(signal, input.idempotencyKey),
          ),
        (value) => normalizeDelivery(value, operation),
      );
    },

    async replyToMessage(input, signal) {
      assertIdentifier(input.messageId, "messageId");
      assertIdempotencyValue(input.idempotencyKey, "idempotencyKey");
      const operation = "reply_to_message";
      const request = composeRequest(input, operation) as AgentMail.ReplyToMessageRequest;
      assertDeliveryContent(request, operation, false);
      return mutate(
        { operation, phase: "sending", inboxId, messageId: input.messageId },
        () =>
          client.inboxes.messages.reply(
            inboxId,
            input.messageId,
            request,
            requestOptions(signal, input.idempotencyKey),
          ),
        (value) => normalizeDelivery(value, operation),
      );
    },

    async replyAllToMessage(input, signal) {
      assertIdentifier(input.messageId, "messageId");
      assertIdempotencyValue(input.idempotencyKey, "idempotencyKey");
      const operation = "reply_all_to_message";
      const request = composeRequest(input, operation) as AgentMail.ReplyAllMessageRequest;
      assertDeliveryContent(request, operation, false);
      return mutate(
        { operation, phase: "sending", inboxId, messageId: input.messageId },
        () =>
          client.inboxes.messages.replyAll(
            inboxId,
            input.messageId,
            request,
            requestOptions(signal, input.idempotencyKey),
          ),
        (value) => normalizeDelivery(value, operation),
      );
    },

    async forwardMessage(input, signal) {
      assertIdentifier(input.messageId, "messageId");
      assertIdempotencyValue(input.idempotencyKey, "idempotencyKey");
      const operation = "forward_message";
      const request = composeRequest(input, operation);
      const recipients =
        (request.to?.length ?? 0) + (request.cc?.length ?? 0) + (request.bcc?.length ?? 0);
      if (recipients < 1) throw requestError(operation, "at least one recipient is required.");
      return mutate(
        { operation, phase: "sending", inboxId, messageId: input.messageId },
        () =>
          client.inboxes.messages.forward(
            inboxId,
            input.messageId,
            request,
            requestOptions(signal, input.idempotencyKey),
          ),
        (value) => normalizeDelivery(value, operation),
      );
    },

    async connect(handlers, signal) {
      const socket = await call(
        { operation: "connect_websocket", phase: "live_connect", inboxId },
        () =>
          client.websockets.connect({
            waitForOpen: false,
            ...(signal ? { abortSignal: signal } : {}),
          }),
      );
      // The pinned generated SDK defaults to `blob`, which Bun's
      // Node-compatible `ws` implementation rejects. Set the reconnecting
      // socket preference before its first asynchronous connection attempt;
      // browsers and Node both support arraybuffer.
      if (socket.socket) socket.socket.binaryType = "arraybuffer";
      let subscribed = false;
      const subscribe = () => {
        if (subscribed) return;
        try {
          socket.sendSubscribe({ type: "subscribe", inboxIds: [inboxId] });
          subscribed = true;
          handlers.onOpen?.();
        } catch (error) {
          handlers.onError?.(
            mapError(error, {
              operation: "subscribe_websocket",
              phase: "live_subscribe",
              inboxId,
            }),
          );
        }
      };
      socket.on("open", subscribe);
      socket.on("close", (event) => {
        subscribed = false;
        handlers.onClose?.(event);
      });
      socket.on("error", (error) => {
        handlers.onError?.(
          mapError(error, { operation: "receive_websocket", phase: "live_stream", inboxId }),
        );
      });
      socket.on("message", (event) => {
        try {
          const normalized = normalizeEvent(event, inboxId);
          if (normalized)
            void Promise.resolve(handlers.onEvent(normalized)).catch((error) => {
              handlers.onError?.(
                mapError(error, {
                  operation: "dispatch_event",
                  phase: "live_stream",
                  inboxId,
                }),
              );
            });
        } catch (error) {
          handlers.onError?.(
            mapError(error, {
              operation: "receive_event",
              phase: "response_validation",
              inboxId,
            }),
          );
        }
      });
      await call({ operation: "connect_websocket", phase: "live_connect", inboxId }, () =>
        socket.waitForOpen(),
      );
      subscribe();
      return { close: () => socket.close() };
    },
  };
}

// Compile-time assertions against the pinned SDK surface. These are erased at runtime.
type _SdkMessage = AgentMail.Message;
type _SdkDraft = AgentMail.Draft;
void (0 as unknown as _SdkMessage | _SdkDraft);
