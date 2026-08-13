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
  | "credential_rejected"
  | "permission_missing"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_contract_invalid"
  | "mutation_ambiguous"
  | "resource_conflict"
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
}

export interface AgentMailDraft {
  inboxId: string;
  draftId: string;
  clientId?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  sendStatus?: string;
  updatedAt: number;
  createdAt: number;
}

export type AgentMailDraftSummary = Omit<
  AgentMailDraft,
  "clientId" | "text" | "html" | "createdAt"
>;

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
  listMessages(
    input?: { pageToken?: string; after?: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<{ messages: AgentMailMessageSummary[]; nextPageToken?: string }>;
  getMessage(messageId: string, signal?: AbortSignal): Promise<AgentMailMessage>;
  getThread(threadId: string, signal?: AbortSignal): Promise<AgentMailThread>;
  listDrafts(
    input?: { pageToken?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<{ drafts: AgentMailDraftSummary[]; nextPageToken?: string }>;
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
  updateDraft(
    input: { draftId: string; text: string },
    signal?: AbortSignal,
  ): Promise<AgentMailDraft>;
  sendDraft(
    input: { draftId: string; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<{ messageId: string; threadId: string }>;
  sendMessage(
    input: { to: string[]; subject: string; text: string; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<{ messageId: string; threadId: string }>;
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
      list(inboxId: string, input?: unknown, options?: unknown): Promise<unknown>;
      get(inboxId: string, messageId: string, options?: unknown): Promise<unknown>;
      send(inboxId: string, input: unknown, options?: unknown): Promise<unknown>;
    };
    threads: { get(inboxId: string, threadId: string, options?: unknown): Promise<unknown> };
    drafts: {
      list(inboxId: string, input?: unknown, options?: unknown): Promise<unknown>;
      create(inboxId: string, input: unknown, options?: unknown): Promise<unknown>;
      get(inboxId: string, draftId: string, options?: unknown): Promise<unknown>;
      update(inboxId: string, draftId: string, input: unknown, options?: unknown): Promise<unknown>;
      send(inboxId: string, draftId: string, input: unknown, options?: unknown): Promise<unknown>;
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

function classificationFromLabels(labels: string[]): AgentMailMessageClassification {
  if (labels.includes("spam")) return "spam";
  if (labels.includes("blocked")) return "blocked";
  if (labels.includes("unauthenticated")) return "unauthenticated";
  return "received";
}

function normalizeAttachment(
  value: unknown,
  operation: string,
): AgentMailMessage["attachments"][number] {
  const attachment = asRecord(value, operation);
  const normalized: AgentMailMessage["attachments"][number] = {
    attachmentId: requiredString(attachment, "attachmentId", operation),
  };
  const filename = optionalString(attachment, "filename", operation);
  const contentType = optionalString(attachment, "contentType", operation);
  if (filename !== undefined) normalized.filename = filename;
  if (contentType !== undefined) normalized.contentType = contentType;
  if (typeof attachment.size === "number" && Number.isSafeInteger(attachment.size)) {
    normalized.size = attachment.size;
  }
  return normalized;
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
    attachments: rawAttachments.map((attachment) => normalizeAttachment(attachment, operation)),
  };
}

function normalizeDraft(value: unknown, operation: string): AgentMailDraft {
  const draft = asRecord(value, operation);
  return {
    inboxId: requiredString(draft, "inboxId", operation),
    draftId: requiredString(draft, "draftId", operation),
    clientId: optionalString(draft, "clientId", operation),
    to: mailboxArray(draft.to, operation),
    cc: mailboxArray(draft.cc, operation),
    bcc: mailboxArray(draft.bcc, operation),
    subject: optionalString(draft, "subject", operation),
    text: optionalString(draft, "text", operation),
    html: optionalString(draft, "html", operation),
    inReplyTo: optionalString(draft, "inReplyTo", operation),
    sendStatus: optionalString(draft, "sendStatus", operation),
    updatedAt: timestamp(draft.updatedAt, operation),
    createdAt: timestamp(draft.createdAt, operation),
  };
}

function normalizeDraftSummary(value: unknown, operation: string): AgentMailDraftSummary {
  const draft = asRecord(value, operation);
  return {
    inboxId: requiredString(draft, "inboxId", operation),
    draftId: requiredString(draft, "draftId", operation),
    to: mailboxArray(draft.to, operation),
    cc: mailboxArray(draft.cc, operation),
    bcc: mailboxArray(draft.bcc, operation),
    subject: optionalString(draft, "subject", operation),
    inReplyTo: optionalString(draft, "inReplyTo", operation),
    sendStatus: optionalString(draft, "sendStatus", operation),
    updatedAt: timestamp(draft.updatedAt, operation),
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

function mapError(
  error: unknown,
  context: Omit<AgentMailProviderErrorDetails, "code" | "retryable" | "nextAction"> & {
    mutation?: boolean;
  },
): AgentMailProviderError {
  if (error instanceof AgentMailProviderError) return error;
  const status = error instanceof AgentMailError ? error.statusCode : undefined;
  const code = error instanceof AgentMailError ? providerCode(error) : undefined;
  let mapped: Pick<AgentMailProviderErrorDetails, "code" | "retryable" | "nextAction">;
  if (status === 401) {
    mapped = {
      code: "credential_rejected",
      retryable: false,
      nextAction: "Check AGENTMAIL_API_KEY. Auggy will not create or replace the supplied key.",
    };
  } else if (status === 403) {
    mapped = {
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
  return new AgentMailProviderError({
    ...safeContext,
    ...mapped,
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(code === undefined ? {} : { providerCode: code }),
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

    async getThread(threadId, signal) {
      assertIdentifier(threadId, "threadId");
      const value = await call({ operation: "get_thread", phase: "review", inboxId }, () =>
        client.inboxes.threads.get(inboxId, threadId, requestOptions(signal)),
      );
      const thread = asRecord(value, "get_thread");
      const messages = thread.messages;
      if (!Array.isArray(messages) || messages.length > 1_000) throw contractError("get_thread");
      const normalized: AgentMailThread = {
        inboxId: requiredString(thread, "inboxId", "get_thread"),
        threadId: requiredString(thread, "threadId", "get_thread"),
        subject: optionalString(thread, "subject", "get_thread"),
        lastMessageId: requiredString(thread, "lastMessageId", "get_thread"),
        messageCount:
          typeof thread.messageCount === "number" && Number.isSafeInteger(thread.messageCount)
            ? thread.messageCount
            : messages.length,
        updatedAt: timestamp(thread.updatedAt, "get_thread"),
        messages: messages.map((message) => normalizeMessage(message, "get_thread")),
      };
      if (normalized.inboxId !== inboxId || normalized.threadId !== threadId) {
        throw contractError("get_thread");
      }
      return normalized;
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

    async createReplyDraft(input, signal) {
      assertIdentifier(input.messageId, "messageId");
      assertIdempotencyValue(input.clientId, "clientId");
      if (!input.text || Buffer.byteLength(input.text, "utf8") > 1_048_576) {
        throw contractError("create_reply_draft");
      }
      const value = await call(
        {
          operation: "create_reply_draft",
          phase: "drafting",
          inboxId,
          messageId: input.messageId,
          mutation: true,
        },
        () => {
          const request = {
            text: input.text,
            clientId: input.clientId,
            inReplyTo: input.messageId,
            ...(input.replyAll === true ? { replyAll: true } : {}),
            ...(input.subject === undefined ? {} : { subject: input.subject }),
          };
          return client.inboxes.drafts.create(inboxId, request, requestOptions(signal));
        },
      );
      const draft = normalizeDraft(value, "create_reply_draft");
      if (
        draft.inboxId !== inboxId ||
        draft.inReplyTo !== input.messageId ||
        (draft.clientId !== undefined && draft.clientId !== input.clientId)
      ) {
        throw contractError("create_reply_draft");
      }
      return draft;
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

    async updateDraft(input, signal) {
      assertIdentifier(input.draftId, "draftId");
      if (!input.text || Buffer.byteLength(input.text, "utf8") > 1_048_576) {
        throw contractError("update_draft");
      }
      const value = await call(
        {
          operation: "update_draft",
          phase: "revision",
          inboxId,
          draftId: input.draftId,
          mutation: true,
        },
        () =>
          client.inboxes.drafts.update(
            inboxId,
            input.draftId,
            { text: input.text },
            requestOptions(signal),
          ),
      );
      const draft = normalizeDraft(value, "update_draft");
      if (draft.inboxId !== inboxId || draft.draftId !== input.draftId) {
        throw contractError("update_draft");
      }
      return draft;
    },

    async sendDraft(input, signal) {
      assertIdentifier(input.draftId, "draftId");
      assertIdempotencyValue(input.idempotencyKey, "idempotencyKey");
      const value = await call(
        {
          operation: "send_draft",
          phase: "sending",
          inboxId,
          draftId: input.draftId,
          mutation: true,
        },
        () =>
          client.inboxes.drafts.send(
            inboxId,
            input.draftId,
            {},
            requestOptions(signal, input.idempotencyKey),
          ),
      );
      const sent = asRecord(value, "send_draft");
      return {
        messageId: requiredString(sent, "messageId", "send_draft"),
        threadId: requiredString(sent, "threadId", "send_draft"),
      };
    },

    async sendMessage(input, signal) {
      assertIdempotencyValue(input.idempotencyKey, "idempotencyKey");
      if (input.to.length < 1 || input.to.length > 50 || !input.subject || !input.text) {
        throw contractError("send_message");
      }
      const value = await call(
        { operation: "send_message", phase: "sending", inboxId, mutation: true },
        () =>
          client.inboxes.messages.send(
            inboxId,
            { to: input.to, subject: input.subject, text: input.text },
            requestOptions(signal, input.idempotencyKey),
          ),
      );
      const sent = asRecord(value, "send_message");
      return {
        messageId: requiredString(sent, "messageId", "send_message"),
        threadId: requiredString(sent, "threadId", "send_message"),
      };
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
      // agentmail@0.5.14 defaults to `blob`, which Bun's Node-compatible `ws`
      // implementation rejects. Set the reconnecting socket preference before
      // its first asynchronous connection attempt; browsers and Node both
      // support arraybuffer.
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
