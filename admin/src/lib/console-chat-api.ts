import { adminFetch, type AdminFetchDependencies } from "./api";
import type {
  ChatMessage,
  ChatModelSnapshot,
  ChatPreviewMode,
  ChatRunStatus,
  ChatThread,
  ChatToolCall,
} from "./chat-workspace";

const THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PREVIEW_MODES = new Set<ChatPreviewMode>(["creator", "anonymous", "visitor"]);
const RUN_STATUSES = new Set<ChatRunStatus>([
  "idle",
  "streaming",
  "complete",
  "error",
  "interrupted",
]);
const TOOL_STATUSES = new Set<ChatToolCall["status"]>(["running", "completed", "error"]);

const SUMMARY_KEYS = [
  "id",
  "title",
  "previewMode",
  "model",
  "createdAt",
  "updatedAt",
  "lastReadAt",
  "unread",
  "runStatus",
] as const;

export type ConsoleChatThreadSummary = Omit<ChatThread, "messages">;

export type ConsoleChatApiErrorCode =
  | "csrf-expired"
  | "conflict"
  | "not-found"
  | "unavailable"
  | "invalid-response"
  | "request-failed";

export class ConsoleChatApiError extends Error {
  readonly status: number;
  readonly code: ConsoleChatApiErrorCode;
  readonly responseMessage?: string;

  constructor(
    message: string,
    options: { status: number; code: ConsoleChatApiErrorCode; responseMessage?: string },
  ) {
    super(message);
    this.name = "ConsoleChatApiError";
    this.status = options.status;
    this.code = options.code;
    this.responseMessage = options.responseMessage;
  }
}

export function isConsoleChatApiError(error: unknown): error is ConsoleChatApiError {
  return error instanceof ConsoleChatApiError;
}

export interface ConsoleChatApiRequestOptions extends AdminFetchDependencies {
  signal?: AbortSignal;
}

export async function listConsoleChatThreads(
  options: ConsoleChatApiRequestOptions = {},
): Promise<ConsoleChatThreadSummary[]> {
  const value = await requestJson("/console/api/chat/threads", { method: "GET" }, options);
  if (!isExactObject(value, ["threads"]) || !Array.isArray(value.threads)) {
    throw invalidResponse("thread list");
  }
  const threads = value.threads.map((thread, index) =>
    parseSummary(thread, `threads[${index}]`),
  );
  assertUniqueIds(threads, "thread list");
  return threads;
}

export async function getConsoleChatThread(
  threadId: string,
  options: ConsoleChatApiRequestOptions = {},
): Promise<ChatThread> {
  const value = await requestJson(threadPath(threadId), { method: "GET" }, options);
  if (!isExactObject(value, ["thread"])) throw invalidResponse("thread detail");
  const thread = parseThread(value.thread, "thread");
  assertRequestedThreadId(threadId, thread.id, "thread detail");
  return thread;
}

export async function renameConsoleChatThread(
  threadId: string,
  title: string,
  csrf: string,
  options: ConsoleChatApiRequestOptions = {},
): Promise<ConsoleChatThreadSummary> {
  return mutateForSummary(threadId, "rename", { csrf, title }, options);
}

export async function setConsoleChatThreadReadState(
  threadId: string,
  unread: boolean,
  csrf: string,
  options: ConsoleChatApiRequestOptions = {},
): Promise<ConsoleChatThreadSummary> {
  return mutateForSummary(threadId, "read-state", { csrf, unread }, options);
}

export async function deleteConsoleChatThread(
  threadId: string,
  csrf: string,
  options: ConsoleChatApiRequestOptions = {},
): Promise<void> {
  const value = await requestJson(
    `${threadPath(threadId)}/delete`,
    jsonPost({ csrf }),
    options,
  );
  if (!isExactObject(value, ["ok"]) || value.ok !== true) {
    throw invalidResponse("thread deletion");
  }
}

async function mutateForSummary(
  threadId: string,
  action: "rename" | "read-state",
  body: Record<string, unknown>,
  options: ConsoleChatApiRequestOptions,
): Promise<ConsoleChatThreadSummary> {
  const value = await requestJson(
    `${threadPath(threadId)}/${action}`,
    jsonPost(body),
    options,
  );
  if (!isExactObject(value, ["thread"])) throw invalidResponse(`thread ${action}`);
  const thread = parseSummary(value.thread, "thread");
  assertRequestedThreadId(threadId, thread.id, `thread ${action}`);
  return thread;
}

function assertRequestedThreadId(requested: string, returned: string, label: string): void {
  if (requested !== returned) throw invalidResponse(`${label} identifier`);
}

async function requestJson(
  path: string,
  init: RequestInit,
  options: ConsoleChatApiRequestOptions,
): Promise<unknown> {
  let response: Response;
  try {
    response = await adminFetch(
      path,
      {
        ...init,
        signal: options.signal,
        headers: { accept: "application/json", ...init.headers },
      },
      { fetchImpl: options.fetchImpl, locationHref: options.locationHref },
    );
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw error;
    throw new ConsoleChatApiError("Unable to reach the console chat service.", {
      status: 0,
      code: "request-failed",
    });
  }

  if (!response.ok) throw await responseError(response);
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw invalidResponse("content type", response.status);
  }

  try {
    return await response.json();
  } catch {
    throw invalidResponse("JSON", response.status);
  }
}

async function responseError(response: Response): Promise<ConsoleChatApiError> {
  let responseMessage: string | undefined;
  if (response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    try {
      const value: unknown = await response.json();
      if (isExactObject(value, ["error"]) && typeof value.error === "string") {
        responseMessage = value.error;
      }
    } catch {
      // The status remains authoritative when an error body is malformed.
    }
  }

  if (response.status === 419) {
    return new ConsoleChatApiError("Session expired — reload the page.", {
      status: 419,
      code: "csrf-expired",
      responseMessage,
    });
  }

  const code: ConsoleChatApiErrorCode =
    response.status === 404
      ? "not-found"
      : response.status === 409
        ? "conflict"
        : response.status === 503
          ? "unavailable"
          : "request-failed";
  const message = responseMessage || `Console chat request failed (${response.status}).`;
  return new ConsoleChatApiError(message, { status: response.status, code, responseMessage });
}

function jsonPost(body: Record<string, unknown>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function threadPath(threadId: string): string {
  if (!THREAD_ID_RE.test(threadId)) {
    throw new ConsoleChatApiError("Invalid console chat thread ID.", {
      status: 0,
      code: "request-failed",
    });
  }
  return `/console/api/chat/threads/${encodeURIComponent(threadId)}`;
}

function parseThread(value: unknown, label: string): ChatThread {
  if (!isRecord(value) || !hasExactKeys(value, [...SUMMARY_KEYS, "messages"])) {
    throw invalidResponse(label);
  }
  if (!Array.isArray(value.messages)) throw invalidResponse(`${label}.messages`);
  const summary = parseSummaryFields(value, label);
  const messages = value.messages.map((message, index) =>
    parseMessage(message, `${label}.messages[${index}]`),
  );
  assertUniqueIds(messages, `${label}.messages`);

  const threadStart = Date.parse(summary.createdAt);
  const threadEnd = Date.parse(summary.updatedAt);
  if (
    messages.some(
      (message) =>
        Date.parse(message.createdAt) < threadStart || Date.parse(message.updatedAt) > threadEnd,
    )
  ) {
    throw invalidResponse(`${label}.message timestamps`);
  }

  return { ...summary, messages };
}

function parseSummary(value: unknown, label: string): ConsoleChatThreadSummary {
  if (!isRecord(value) || !hasExactKeys(value, SUMMARY_KEYS)) throw invalidResponse(label);
  return parseSummaryFields(value, label);
}

function parseSummaryFields(value: Record<string, unknown>, label: string): ConsoleChatThreadSummary {
  if (!isThreadId(value.id)) throw invalidResponse(`${label}.id`);
  if (
    !isBoundedString(value.title, 1, 80) ||
    value.title.trim() !== value.title ||
    hasControlCharacter(value.title)
  ) {
    throw invalidResponse(`${label}.title`);
  }
  if (typeof value.previewMode !== "string" || !PREVIEW_MODES.has(value.previewMode as ChatPreviewMode)) {
    throw invalidResponse(`${label}.previewMode`);
  }
  const model = parseModel(value.model, `${label}.model`);
  const createdAt = parseIsoDate(value.createdAt, `${label}.createdAt`);
  const updatedAt = parseIsoDate(value.updatedAt, `${label}.updatedAt`);
  const lastReadAt =
    value.lastReadAt === null
      ? null
      : parseIsoDate(value.lastReadAt, `${label}.lastReadAt`);
  if (
    Date.parse(createdAt) > Date.parse(updatedAt) ||
    (lastReadAt !== null && Date.parse(lastReadAt) < Date.parse(createdAt))
  ) {
    throw invalidResponse(`${label}.timestamps`);
  }
  if (typeof value.unread !== "boolean") throw invalidResponse(`${label}.unread`);
  if (typeof value.runStatus !== "string" || !RUN_STATUSES.has(value.runStatus as ChatRunStatus)) {
    throw invalidResponse(`${label}.runStatus`);
  }

  return {
    id: value.id,
    title: value.title,
    previewMode: value.previewMode as ChatPreviewMode,
    model,
    createdAt,
    updatedAt,
    lastReadAt,
    unread: value.unread,
    runStatus: value.runStatus as ChatRunStatus,
  };
}

function parseModel(value: unknown, label: string): ChatModelSnapshot | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["id", "displayName"], ["provider"])) {
    throw invalidResponse(label);
  }
  if (!isBoundedString(value.id, 1, 512) || !isBoundedString(value.displayName, 1, 512)) {
    throw invalidResponse(label);
  }
  if (value.provider !== undefined && !isBoundedString(value.provider, 1, 512)) {
    throw invalidResponse(`${label}.provider`);
  }
  return {
    id: value.id,
    displayName: value.displayName,
    ...(value.provider === undefined ? {} : { provider: value.provider }),
  };
}

function parseMessage(value: unknown, label: string): ChatMessage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "role", "content", "createdAt", "updatedAt"], ["toolCalls", "error"])
  ) {
    throw invalidResponse(label);
  }
  if (!isThreadId(value.id)) throw invalidResponse(`${label}.id`);
  if (value.role !== "user" && value.role !== "assistant") throw invalidResponse(`${label}.role`);
  if (typeof value.content !== "string") throw invalidResponse(`${label}.content`);
  const createdAt = parseIsoDate(value.createdAt, `${label}.createdAt`);
  const updatedAt = parseIsoDate(value.updatedAt, `${label}.updatedAt`);
  if (Date.parse(createdAt) > Date.parse(updatedAt)) {
    throw invalidResponse(`${label}.timestamps`);
  }
  if (value.error !== undefined && typeof value.error !== "string") {
    throw invalidResponse(`${label}.error`);
  }
  let toolCalls: ChatToolCall[] | undefined;
  if (value.toolCalls !== undefined) {
    if (!Array.isArray(value.toolCalls)) throw invalidResponse(`${label}.toolCalls`);
    toolCalls = value.toolCalls.map((toolCall, index) =>
      parseToolCall(toolCall, `${label}.toolCalls[${index}]`),
    );
    // AG-UI IDs identify calls within a message/run. Providers may reuse an
    // opaque call ID in a later turn, so uniqueness is intentionally scoped
    // to this assistant message rather than the whole transcript.
    assertUniqueIds(toolCalls, `${label}.toolCalls`);
  }
  return {
    id: value.id,
    role: value.role,
    content: value.content,
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(value.error === undefined ? {} : { error: value.error }),
    createdAt,
    updatedAt,
  };
}

function parseToolCall(value: unknown, label: string): ChatToolCall {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "name", "status"], ["args", "result"])
  ) {
    throw invalidResponse(label);
  }
  if (!isBoundedString(value.id, 1, 256) || !isBoundedString(value.name, 1, 512)) {
    throw invalidResponse(label);
  }
  if (typeof value.status !== "string" || !TOOL_STATUSES.has(value.status as ChatToolCall["status"])) {
    throw invalidResponse(`${label}.status`);
  }
  if (value.args !== undefined && typeof value.args !== "string") {
    throw invalidResponse(`${label}.args`);
  }
  if (value.result !== undefined && typeof value.result !== "string") {
    throw invalidResponse(`${label}.result`);
  }
  return {
    id: value.id,
    name: value.name,
    ...(value.args === undefined ? {} : { args: value.args }),
    ...(value.result === undefined ? {} : { result: value.result }),
    status: value.status as ChatToolCall["status"],
  };
}

function parseIsoDate(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalidResponse(label);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw invalidResponse(label);
  }
  return value;
}

function invalidResponse(part: string, status = 200): ConsoleChatApiError {
  return new ConsoleChatApiError(`Console chat returned an invalid ${part} response.`, {
    status,
    code: "invalid-response",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  return isRecord(value) && hasExactKeys(value, required, optional);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function isThreadId(value: unknown): value is string {
  return typeof value === "string" && THREAD_ID_RE.test(value);
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  if (typeof value !== "string") return false;
  const length = Array.from(value).length;
  return length >= min && length <= max;
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function assertUniqueIds(values: readonly { id: string }[], label: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw invalidResponse(`${label} duplicate ID`);
    ids.add(value.id);
  }
}
