/** AgentMail SDK adapters for REST catch-up and reconnecting WebSocket delivery. */

import { AgentMailClient as SdkAgentMailClient } from "agentmail";
import {
  assertSecureCredentialTransport,
  assertSecureWebSocketCredentialTransport,
} from "../../engines/_shared/credential-transport";
import { createRedirectRejectingFetch } from "../../http";
import type { AgentMailInboundLedger } from "./inbound-ledger";
import {
  AGENTMAIL_RECEIVED_EVENT_TYPES,
  AgentMailPayloadError,
  agentMailRestEnvelope,
  normalizeAgentMailMessage,
  normalizeAgentMailMessageSummary,
  normalizeAgentMailReceivedEvent,
  receivedEventTypeForLabels,
  type AgentMailCatchUpReader,
  type AgentMailEventSubscription,
  type AgentMailLiveEventSource,
  type AgentMailMessagePage,
  type AgentMailReceivedEventType,
  type AgentMailSubscribeInput,
} from "./provider";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_FETCH_CONCURRENCY = 4;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const MAX_PAGE_SIZE = 100;

interface SdkMessagesClient {
  list(inboxId: string, request: Record<string, unknown>): Promise<unknown>;
  get(inboxId: string, messageId: string): Promise<unknown>;
}

interface SdkSocket {
  /** Public AgentMail SDK reconnecting-socket boundary. */
  readonly socket?: {
    binaryType: string;
  };
  readonly readyState?: number;
  on(event: "open" | "message" | "close" | "error", callback: (value?: unknown) => void): void;
  sendSubscribe(message: {
    type: "subscribe";
    inboxIds: string[];
    eventTypes: AgentMailReceivedEventType[];
  }): void;
  close(): void;
}

function configureWebSocketBinaryTransport(socket: SdkSocket | undefined): void {
  try {
    if (!socket?.socket) throw new Error("missing AgentMail WebSocket facade");
    socket.socket.binaryType = "arraybuffer";
    if (socket.socket.binaryType !== "arraybuffer") {
      throw new Error("AgentMail WebSocket rejected the binary type");
    }
  } catch {
    throw new AgentMailProviderRequestError("configure WebSocket binary transport", false);
  }
}

interface SdkClientBoundary {
  inboxes: { messages: SdkMessagesClient };
  websockets: {
    connect(input: {
      waitForOpen: false;
      reconnectAttempts: number;
      connectionTimeoutInSeconds: number;
      abortSignal: AbortSignal;
    }): Promise<SdkSocket>;
  };
}

export interface AgentMailSdkProviderOptions {
  apiKey: string;
  /** Existing AgentMail REST base URL; a trailing `/v0` is normalized for the SDK. */
  apiBaseUrl?: string;
  /** WebSocket origin override for local/sandbox providers. */
  websocketBaseUrl?: string;
  /** Development-only escape hatch for credentialed non-loopback HTTP/WS. */
  allowInsecureHttpWithCredentials?: boolean;
  timeoutMs?: number;
  handshakeTimeoutMs?: number;
  connectionTimeoutMs?: number;
  /** Test-only SDK boundary. */
  _sdk?: SdkClientBoundary;
  /** Test-only Fetch boundary. */
  _fetch?: typeof fetch;
}

export interface AgentMailSdkAdapters {
  catchUp: AgentMailCatchUpReader;
  live: AgentMailLiveEventSource;
}

export class AgentMailProviderRequestError extends Error {
  readonly code = "AGENTMAIL_PROVIDER_REQUEST_FAILED";

  constructor(
    readonly operation: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
  ) {
    super(
      `agentMail provider: ${operation} failed${httpStatus === undefined ? "" : ` (HTTP ${httpStatus})`}`,
    );
    this.name = "AgentMailProviderRequestError";
  }
}

export interface RunAgentMailCatchUpOptions {
  reader: AgentMailCatchUpReader;
  ledger: AgentMailInboundLedger;
  inboxId: string;
  /** Received classifications to fetch and enqueue. Defaults to every supported type. */
  processedEventTypes?: readonly AgentMailReceivedEventType[];
  pageSize?: number;
  fetchConcurrency?: number;
  maxPages?: number;
  signal?: AbortSignal;
}

export interface AgentMailCatchUpResult {
  pages: number;
  scanned: number;
  received: number;
  enqueued: number;
  duplicates: number;
  checkpoint: string | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function finiteStatus(error: unknown): number | undefined {
  const record = asRecord(error);
  const status = record?.statusCode ?? record?.status;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function requestError(operation: string, error: unknown): AgentMailProviderRequestError {
  const status = finiteStatus(error);
  const retryable =
    status === undefined || status === 408 || status === 425 || status === 429 || status >= 500;
  return new AgentMailProviderRequestError(operation, retryable, status);
}

function requirePositiveInteger(value: number, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`agentMail provider: ${label} must be between 1 and ${max}`);
  }
  return value;
}

function normalizedSdkBaseUrl(url: string, protocols: readonly string[], label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`agentMail provider: ${label} must be a valid URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(
      `agentMail provider: ${label} must use ${protocols.map((value) => value.slice(0, -1)).join(" or ")}`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error(`agentMail provider: ${label} must not contain URL credentials`);
  }
  parsed.pathname = parsed.pathname.replace(/\/v0\/?$/, "").replace(/\/$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function derivedWebSocketBaseUrl(restBaseUrl: string): string {
  const parsed = new URL(restBaseUrl);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  if (parsed.hostname === "api.agentmail.to") parsed.hostname = "ws.agentmail.to";
  if (parsed.hostname === "api.agentmail.eu") parsed.hostname = "ws.agentmail.eu";
  return parsed.toString().replace(/\/$/, "");
}

function createSdk(options: AgentMailSdkProviderOptions): SdkClientBoundary {
  if (options._sdk) return options._sdk;
  const timeoutInSeconds =
    requirePositiveInteger(options.timeoutMs ?? 15_000, "timeoutMs", 5 * 60_000) / 1_000;
  const credentialSafeFetch = createRedirectRejectingFetch(
    options._fetch ?? globalThis.fetch.bind(globalThis),
  );
  if (!options.apiBaseUrl && !options.websocketBaseUrl) {
    return new SdkAgentMailClient({
      apiKey: options.apiKey,
      timeoutInSeconds,
      fetch: credentialSafeFetch,
    }) as unknown as SdkClientBoundary;
  }

  const http = normalizedSdkBaseUrl(
    options.apiBaseUrl ?? "https://api.agentmail.to",
    ["http:", "https:"],
    "apiBaseUrl",
  );
  const websockets = normalizedSdkBaseUrl(
    options.websocketBaseUrl ?? derivedWebSocketBaseUrl(http),
    ["ws:", "wss:"],
    "websocketBaseUrl",
  );
  assertSecureCredentialTransport({
    provider: "AgentMail SDK",
    baseURL: http,
    credential: options.apiKey,
    allowInsecureHttpWithCredentials: options.allowInsecureHttpWithCredentials,
  });
  assertSecureWebSocketCredentialTransport({
    provider: "AgentMail SDK",
    baseURL: websockets,
    credential: options.apiKey,
    allowInsecureHttpWithCredentials: options.allowInsecureHttpWithCredentials,
  });
  return new SdkAgentMailClient({
    apiKey: options.apiKey,
    timeoutInSeconds,
    environment: { http, websockets },
    fetch: credentialSafeFetch,
  }) as unknown as SdkClientBoundary;
}

function safeReport(input: AgentMailSubscribeInput, error: Error): void {
  try {
    input.onError(error);
  } catch {
    // An observer must not break the listener's own failure handling.
  }
}

function isReceivedEventType(value: unknown): value is AgentMailReceivedEventType {
  return (
    typeof value === "string" &&
    (AGENTMAIL_RECEIVED_EVENT_TYPES as readonly string[]).includes(value)
  );
}

function receivedEventTypeSubset(
  value: readonly AgentMailReceivedEventType[],
  label: string,
): AgentMailReceivedEventType[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`agentMail provider: ${label} must be a non-empty received event-type subset`);
  }
  const unique = new Set<AgentMailReceivedEventType>();
  for (const eventType of value) {
    if (!isReceivedEventType(eventType)) {
      throw new Error(`agentMail provider: ${label} contains an unsupported received event type`);
    }
    if (unique.has(eventType)) {
      throw new Error(`agentMail provider: ${label} must not contain duplicate event types`);
    }
    unique.add(eventType);
  }
  return [...unique];
}

function eventField(record: Record<string, unknown>, camel: string, snake: string): unknown {
  return record[camel] ?? record[snake];
}

function validateSubscribedAck(
  event: Record<string, unknown>,
  inboxId: string,
  subscribedEventTypes: readonly AgentMailReceivedEventType[],
): void {
  const inboxIds = eventField(event, "inboxIds", "inbox_ids");
  const eventTypes = eventField(event, "eventTypes", "event_types");
  if (
    inboxIds !== undefined &&
    (!Array.isArray(inboxIds) || inboxIds.length !== 1 || inboxIds[0] !== inboxId)
  ) {
    throw new AgentMailPayloadError(
      "WebSocket subscription ack did not exactly match the configured inbox",
    );
  }
  if (eventTypes === undefined) return;
  if (!Array.isArray(eventTypes)) {
    throw new AgentMailPayloadError("WebSocket subscription ack contains invalid event types");
  }
  let acknowledgedEventTypes: AgentMailReceivedEventType[];
  try {
    acknowledgedEventTypes = receivedEventTypeSubset(
      eventTypes as AgentMailReceivedEventType[],
      "WebSocket subscription ack eventTypes",
    );
  } catch {
    throw new AgentMailPayloadError(
      "WebSocket subscription ack contains invalid received event types",
    );
  }
  const expected = new Set(subscribedEventTypes);
  if (
    acknowledgedEventTypes.length !== expected.size ||
    acknowledgedEventTypes.some((eventType) => !expected.has(eventType))
  ) {
    throw new AgentMailPayloadError(
      "WebSocket subscription ack did not exactly match the requested event types",
    );
  }
}

function createCatchUpReader(sdk: SdkClientBoundary): AgentMailCatchUpReader {
  return {
    async listMessages(input): Promise<AgentMailMessagePage> {
      const limit = requirePositiveInteger(
        input.limit ?? DEFAULT_PAGE_SIZE,
        "list limit",
        MAX_PAGE_SIZE,
      );
      const after = input.after ? new Date(input.after) : undefined;
      if (after && !Number.isFinite(after.getTime())) {
        throw new Error("agentMail provider: list after must be an ISO-8601 timestamp");
      }
      const processedEventTypes = receivedEventTypeSubset(
        input.processedEventTypes ?? AGENTMAIL_RECEIVED_EVENT_TYPES,
        "list processedEventTypes",
      );
      const processed = new Set(processedEventTypes);
      let response: unknown;
      try {
        response = await sdk.inboxes.messages.list(input.inboxId, {
          limit,
          ...(input.pageToken ? { pageToken: input.pageToken } : {}),
          ...(after ? { after } : {}),
          ascending: true,
          ...(processed.has("message.received.spam") ? { includeSpam: true } : {}),
          ...(processed.has("message.received.blocked") ? { includeBlocked: true } : {}),
          ...(processed.has("message.received.unauthenticated")
            ? { includeUnauthenticated: true }
            : {}),
        });
      } catch (error) {
        throw requestError("list messages", error);
      }

      const record = asRecord(response);
      if (!record || !Array.isArray(record.messages)) {
        throw new AgentMailPayloadError("list response is missing messages");
      }
      const messages = record.messages.map((message) =>
        normalizeAgentMailMessageSummary(message, input.inboxId),
      );
      for (let index = 1; index < messages.length; index++) {
        if (Date.parse(messages[index - 1]!.timestamp) > Date.parse(messages[index]!.timestamp)) {
          throw new AgentMailPayloadError("list response is not ordered oldest-first");
        }
      }
      const nextPageToken = record.nextPageToken ?? record.next_page_token;
      if (nextPageToken !== undefined && (typeof nextPageToken !== "string" || !nextPageToken)) {
        throw new AgentMailPayloadError("list response has an invalid next-page token");
      }
      return { messages, nextPageToken };
    },

    async getMessage(input) {
      let response: unknown;
      try {
        response = await sdk.inboxes.messages.get(input.inboxId, input.messageId);
      } catch (error) {
        throw requestError("get message", error);
      }
      const message = normalizeAgentMailMessage(response, input.inboxId);
      if (message.messageId !== input.messageId) {
        throw new AgentMailPayloadError("get response message ID does not match the request");
      }
      return message;
    },
  };
}

function createLiveSource(
  sdk: SdkClientBoundary,
  options: AgentMailSdkProviderOptions,
): AgentMailLiveEventSource {
  return {
    async subscribe(input): Promise<AgentMailEventSubscription> {
      const subscribedEventTypes = receivedEventTypeSubset(
        input.eventTypes,
        "WebSocket eventTypes",
      );
      const subscribedEventTypeSet = new Set(subscribedEventTypes);
      const handshakeTimeoutMs = requirePositiveInteger(
        options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
        "handshakeTimeoutMs",
        5 * 60_000,
      );
      const connectionTimeoutMs = requirePositiveInteger(
        options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
        "connectionTimeoutMs",
        5 * 60_000,
      );
      const controller = new AbortController();
      let socket: SdkSocket | undefined;
      let permanentlyClosed = false;
      let acknowledgedOnce = false;
      let generationAcknowledged = false;
      let deliveryChain = Promise.resolve();
      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      let resolveInitial!: () => void;
      let rejectInitial!: (error: Error) => void;
      const initial = new Promise<void>((resolve, reject) => {
        resolveInitial = resolve;
        rejectInitial = reject;
      });
      let initialSettled = false;

      const finishInitial = (error?: Error): void => {
        if (initialSettled) return;
        initialSettled = true;
        if (error) rejectInitial(error);
        else resolveInitial();
      };

      const closePermanently = (error?: Error): void => {
        if (permanentlyClosed) return;
        permanentlyClosed = true;
        if (error) safeReport(input, error);
        finishInitial(error);
        controller.abort();
        try {
          socket?.close();
        } catch {
          // Closing is best effort after the permanent error was captured.
        }
        resolveClosed();
      };

      const queueFatalWork = (work: () => Promise<void>): void => {
        deliveryChain = deliveryChain
          .then(async () => {
            if (!permanentlyClosed) await work();
          })
          .catch((error) => {
            closePermanently(
              error instanceof AgentMailPayloadError
                ? error
                : new AgentMailProviderRequestError("WebSocket event handling", false),
            );
          });
      };

      try {
        socket = await sdk.websockets.connect({
          waitForOpen: false,
          reconnectAttempts: Number.POSITIVE_INFINITY,
          connectionTimeoutInSeconds: connectionTimeoutMs / 1_000,
          abortSignal: controller.signal,
        });
      } catch (error) {
        const wrapped = requestError("connect WebSocket", error);
        closePermanently(wrapped);
        await initial.catch(() => undefined);
        throw wrapped;
      }

      try {
        configureWebSocketBinaryTransport(socket);
      } catch (error) {
        const wrapped =
          error instanceof AgentMailProviderRequestError
            ? error
            : new AgentMailProviderRequestError("configure WebSocket binary transport", false);
        closePermanently(wrapped);
        await initial;
        throw wrapped;
      }

      const sendSubscribe = (): void => {
        if (permanentlyClosed) return;
        generationAcknowledged = false;
        try {
          socket!.sendSubscribe({
            type: "subscribe",
            inboxIds: [input.inboxId],
            eventTypes: [...subscribedEventTypes],
          });
        } catch {
          closePermanently(new AgentMailProviderRequestError("subscribe WebSocket", true));
        }
      };

      socket.on("open", sendSubscribe);
      socket.on("error", () => {
        if (!permanentlyClosed) {
          safeReport(input, new AgentMailProviderRequestError("WebSocket connection", true));
        }
      });
      socket.on("close", (value) => {
        generationAcknowledged = false;
        if (permanentlyClosed) return;
        const code = asRecord(value)?.code;
        if (code === 1000) {
          closePermanently(new AgentMailProviderRequestError("WebSocket closed", true));
        } else {
          safeReport(input, new AgentMailProviderRequestError("WebSocket disconnected", true));
        }
      });
      socket.on("message", (value) => {
        if (permanentlyClosed) return;
        const event = asRecord(value);
        if (!event) {
          closePermanently(new AgentMailPayloadError("WebSocket emitted a non-object event"));
          return;
        }

        if (event.type === "subscribed") {
          if (generationAcknowledged) return;
          try {
            validateSubscribedAck(event, input.inboxId, subscribedEventTypes);
          } catch (error) {
            closePermanently(error as Error);
            return;
          }
          generationAcknowledged = true;
          const reconnected = acknowledgedOnce;
          queueFatalWork(async () => {
            await input.onSubscribed?.({ reconnected });
            acknowledgedOnce = true;
            finishInitial();
          });
          return;
        }

        if (event.type === "error") {
          closePermanently(
            new AgentMailProviderRequestError("WebSocket subscription rejected", false),
          );
          return;
        }

        const receivedType = eventField(event, "eventType", "event_type");
        if (!isReceivedEventType(receivedType)) {
          if (
            event.type === "message_received" ||
            (typeof receivedType === "string" && receivedType.startsWith("message.received"))
          ) {
            closePermanently(
              new AgentMailPayloadError("WebSocket emitted an unsupported received event type"),
            );
          }
          return;
        }
        if (!subscribedEventTypeSet.has(receivedType)) {
          closePermanently(
            new AgentMailPayloadError(
              "WebSocket emitted a supported received event type outside the subscription",
            ),
          );
          return;
        }
        if (!generationAcknowledged) {
          closePermanently(
            new AgentMailPayloadError("WebSocket delivered mail before subscription ack"),
          );
          return;
        }
        queueFatalWork(async () => {
          const envelope = normalizeAgentMailReceivedEvent(value, "websocket", input.inboxId);
          await input.onEvent(envelope);
        });
      });

      if (socket.readyState === 1) sendSubscribe();

      const timeout = setTimeout(() => {
        closePermanently(
          new AgentMailProviderRequestError("WebSocket subscription handshake", true),
        );
      }, handshakeTimeoutMs);
      try {
        await initial;
      } finally {
        clearTimeout(timeout);
      }

      return {
        closed,
        async close() {
          if (permanentlyClosed) return closed;
          permanentlyClosed = true;
          controller.abort();
          socket?.close();
          await deliveryChain;
          resolveClosed();
        },
      };
    },
  };
}

export function createAgentMailSdkAdapters(
  options: AgentMailSdkProviderOptions,
): AgentMailSdkAdapters {
  const sdk = createSdk(options);
  return {
    catchUp: createCatchUpReader(sdk),
    live: createLiveSource(sdk, options),
  };
}

async function mapConcurrent<T, U>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await map(values[index]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => worker()),
  );
  return results;
}

export async function runAgentMailCatchUp(
  options: RunAgentMailCatchUpOptions,
): Promise<AgentMailCatchUpResult> {
  const pageSize = requirePositiveInteger(
    options.pageSize ?? DEFAULT_PAGE_SIZE,
    "pageSize",
    MAX_PAGE_SIZE,
  );
  const fetchConcurrency = requirePositiveInteger(
    options.fetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY,
    "fetchConcurrency",
    32,
  );
  const maxPages = requirePositiveInteger(
    options.maxPages ?? DEFAULT_MAX_PAGES,
    "maxPages",
    10_000,
  );
  const processedEventTypes = receivedEventTypeSubset(
    options.processedEventTypes ?? AGENTMAIL_RECEIVED_EVENT_TYPES,
    "catch-up processedEventTypes",
  );
  const processedEventTypeSet = new Set(processedEventTypes);
  const after = options.ledger.catchUpAfter(options.inboxId);
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;
  const result: AgentMailCatchUpResult = {
    pages: 0,
    scanned: 0,
    received: 0,
    enqueued: 0,
    duplicates: 0,
    checkpoint: options.ledger.checkpoint(options.inboxId),
  };

  while (result.pages < maxPages) {
    if (options.signal?.aborted) throw new Error("agentMail catch-up aborted");
    const page = await options.reader.listMessages({
      inboxId: options.inboxId,
      after,
      pageToken,
      limit: pageSize,
      processedEventTypes,
    });
    result.pages++;
    result.scanned += page.messages.length;

    const receivedSummaries = page.messages.flatMap((summary) => {
      const eventType = receivedEventTypeForLabels(summary.labels);
      return eventType && processedEventTypeSet.has(eventType) ? [{ summary, eventType }] : [];
    });
    const envelopes = await mapConcurrent(receivedSummaries, fetchConcurrency, async (entry) => {
      const { summary, eventType } = entry;
      if (options.signal?.aborted) throw new Error("agentMail catch-up aborted");
      const message = await options.reader.getMessage({
        inboxId: options.inboxId,
        messageId: summary.messageId,
      });
      if (
        message.threadId !== summary.threadId ||
        Date.parse(message.timestamp) !== Date.parse(summary.timestamp)
      ) {
        throw new AgentMailPayloadError("full message identity does not match its list entry");
      }
      const envelope = agentMailRestEnvelope(message);
      if (envelope.eventType !== eventType) {
        throw new AgentMailPayloadError(
          "full message classification does not match its list entry",
        );
      }
      return envelope;
    });
    result.received += envelopes.length;

    const newestSummary = page.messages.at(-1);
    if (newestSummary) {
      const recorded = options.ledger.recordCatchUpBatch(envelopes, {
        inboxId: options.inboxId,
        through: newestSummary.timestamp,
      });
      result.enqueued += recorded.enqueued;
      result.duplicates += recorded.duplicates;
      result.checkpoint = recorded.checkpoint;
    } else if (page.nextPageToken) {
      throw new AgentMailPayloadError("empty list page unexpectedly has a continuation token");
    }

    if (!page.nextPageToken) return result;
    if (seenPageTokens.has(page.nextPageToken)) {
      throw new AgentMailPayloadError("list pagination token repeated");
    }
    seenPageTokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }

  throw new Error(`agentMail catch-up exceeded the configured ${maxPages}-page limit`);
}
