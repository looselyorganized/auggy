const MAX_ERROR_BYTES = 4 * 1024;
export const MAX_SSE_BYTES = 4 * 1024 * 1024;
export const MAX_SSE_EVENTS = 100_000;
export const MAX_BEARER_TOKEN_BYTES = 8 * 1024;
const MAX_EXECUTION_ID_LENGTH = 256;

const TASK_STATES = [
  "working",
  "input-required",
  "auth-required",
  "completed",
  "failed",
  "canceled",
  "rejected",
] as const;
type TaskState = (typeof TASK_STATES)[number];

export type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AuggyRunErrorKind =
  | "admission-failed"
  | "auth-required"
  | "binding-conflict"
  | "incomplete-stream"
  | "input-required"
  | "invalid-response"
  | "local-canceled"
  | "outcome-unknown"
  | "rejected"
  | "remote-canceled"
  | "run-error"
  | "sse-limit"
  | "task-failed"
  | "task-status-unknown"
  | "task-working";

/**
 * Contains only a classification; it deliberately excludes request, response,
 * prompt, and credential data so callers can safely log `kind` if needed.
 */
export class AuggyRunError extends Error {
  constructor(
    readonly kind: AuggyRunErrorKind,
    readonly retryable: boolean,
  ) {
    super(kind);
    this.name = "AuggyRunError";
  }
}

export interface AuggyRunClientConfig {
  /** HTTPS origin of the Auggy deployment, supplied by the worker operator. */
  target: string;
  /** Worker-only bearer token. Never put this value in a Workflow input. */
  bearerToken: string;
  /** Total encoded SSE bytes accepted for one Activity request. */
  maxSseBytes: number;
  /** Total parsed SSE events accepted for one Activity request. */
  maxSseEvents: number;
  /** Test-only escape hatch for a fake loopback HTTP server. */
  allowInsecureLocalhost?: boolean;
  /** Injectable only for contract tests; the Worker always uses global fetch. */
  fetchImplementation?: FetchImplementation;
}

export interface AuggyRunRequest {
  /** Stable across Temporal Activity retries for this one intended operation. */
  idempotencyKey: string;
  threadId: string;
  message: string;
}

export interface AuggyRunCompleted {
  runId: string;
  threadId: string;
  text: string;
}

interface AuggySseEvent {
  type?: unknown;
  code?: unknown;
  runId?: unknown;
  threadId?: unknown;
  delta?: unknown;
  result?: unknown;
}

export interface AuggyRunClient {
  run(request: AuggyRunRequest, signal?: AbortSignal, onProgress?: () => void): Promise<AuggyRunCompleted>;
}

export function createAuggyRunClient(config: AuggyRunClientConfig): AuggyRunClient {
  const endpoint = agentRunEndpoint(config.target, config.allowInsecureLocalhost === true);
  const fetchImplementation = config.fetchImplementation ?? fetch;
  const tokenBytes = new TextEncoder().encode(config.bearerToken).byteLength;
  if (tokenBytes === 0 || tokenBytes > MAX_BEARER_TOKEN_BYTES || !/^[\x21-\x7e]+$/.test(config.bearerToken)) {
    throw new Error(`AUGGY_BEARER_TOKEN must be 1-${MAX_BEARER_TOKEN_BYTES} visible ASCII bytes`);
  }
  validateBoundedPositiveInteger(config.maxSseBytes, MAX_SSE_BYTES, "maxSseBytes");
  validateBoundedPositiveInteger(config.maxSseEvents, MAX_SSE_EVENTS, "maxSseEvents");

  return {
    async run(request, signal, onProgress) {
      validateRequest(request);
      let response: Response;
      try {
        response = await fetchImplementation(endpoint, {
          method: "POST",
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${config.bearerToken}`,
            "content-type": "application/json",
            "idempotency-key": request.idempotencyKey,
          },
          body: JSON.stringify({
            messages: [{ role: "user", content: request.message }],
            threadId: request.threadId,
          }),
          redirect: "error",
          signal,
        });
      } catch {
        if (signal?.aborted) throw new AuggyRunError("local-canceled", false);
        // The only retry mechanism is Temporal Activity retrying the same key.
        // The server will join, replay, or fail closed rather than start a new run.
        throw new AuggyRunError("admission-failed", true);
      }

      if (!response.ok) throw await httpError(response);
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
        throw new AuggyRunError("invalid-response", false);
      }
      if (response.body === null) throw new AuggyRunError("incomplete-stream", true);

      return consumeSse(
        response.body,
        request.threadId,
        config.maxSseBytes,
        config.maxSseEvents,
        onProgress,
      );
    },
  };
}

function agentRunEndpoint(target: string, allowInsecureLocalhost: boolean): string {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error("AUGGY_TARGET must be an absolute HTTPS URL");
  }
  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(allowInsecureLocalhost && isLoopback && url.protocol === "http:")) {
    throw new Error("AUGGY_TARGET must use HTTPS");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("AUGGY_TARGET must be an origin without path, credentials, query, or fragment");
  }
  return new URL("/agent/run", url).toString();
}

function validateRequest(request: AuggyRunRequest): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.idempotencyKey)) {
    throw new Error("idempotencyKey must match Auggy's 1-128 character key contract");
  }
  if (request.threadId.length === 0 || request.threadId.length > 256) throw new Error("threadId must be 1-256 characters");
  if (request.message.length === 0 || request.message.length > 16 * 1024) throw new Error("message must be 1-16384 characters");
}

async function httpError(response: Response): Promise<AuggyRunError> {
  if (response.status === 409) {
    const code = await boundedErrorCode(response);
    if (code === "idempotency_key_conflict") return new AuggyRunError("binding-conflict", false);
    if (code === "idempotency_outcome_unknown") return new AuggyRunError("outcome-unknown", false);
    return new AuggyRunError("outcome-unknown", false);
  }
  if ([408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
    return new AuggyRunError("admission-failed", true);
  }
  if (response.status >= 300 && response.status < 400) return new AuggyRunError("invalid-response", false);
  return new AuggyRunError("rejected", false);
}

async function boundedErrorCode(response: Response): Promise<string | null> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  let received = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > MAX_ERROR_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(concat(chunks, received)));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "string" &&
      parsed.error.length <= 128
    ) {
      return parsed.error;
    }
  } catch {
    // An error response is not a trusted SSE payload.
  }
  return null;
}

async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  expectedThreadId: string,
  maxBytes: number,
  maxEvents: number,
  onProgress: (() => void) | undefined,
): Promise<AuggyRunCompleted> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let events = 0;
  let buffered = "";
  let dataLines: string[] = [];
  let runId: string | null = null;
  let threadId: string | null = null;
  let text = "";
  let runError: AuggyRunError | null = null;
  let finished = false;

  const flushEvent = () => {
    if (dataLines.length === 0) return;
    events += 1;
    if (events > maxEvents) throw new AuggyRunError("sse-limit", false);
    const data = dataLines.join("\n");
    dataLines = [];
    let event: AuggySseEvent;
    try {
      event = JSON.parse(data) as AuggySseEvent;
    } catch {
      throw new AuggyRunError("invalid-response", false);
    }
    if (typeof event.type !== "string") throw new AuggyRunError("invalid-response", false);
    if (finished) throw new AuggyRunError("invalid-response", false);

    if (event.type === "RUN_STARTED") {
      if (runId !== null || threadId !== null) throw new AuggyRunError("invalid-response", false);
      runId = executionId(event.runId);
      threadId = executionId(event.threadId);
      if (threadId !== expectedThreadId) throw new AuggyRunError("invalid-response", false);
      return;
    }
    if (runId === null || threadId === null) throw new AuggyRunError("invalid-response", false);
    enforceEventIdentity(event, runId, threadId);

    if (event.type === "TEXT_MESSAGE_CONTENT") {
      if (typeof event.delta !== "string") throw new AuggyRunError("invalid-response", false);
      text += event.delta;
    }
    if (event.type === "RUN_ERROR") {
      if (runError !== null) throw new AuggyRunError("invalid-response", false);
      runError = streamError(event.code);
    }
    if (event.type === "RUN_FINISHED") {
      if (executionId(event.runId) !== runId || executionId(event.threadId) !== threadId) {
        throw new AuggyRunError("invalid-response", false);
      }
      finished = true;
      const status = finishedStatus(event.result);
      if (status !== "completed" && runError === null) runError = taskStateError(status);
    }
  };

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maxBytes) throw new AuggyRunError("sse-limit", false);
      onProgress?.();
      buffered += decoder.decode(next.value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const rawLine = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.length === 0) flushEvent();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        newline = buffered.indexOf("\n");
      }
    }
    buffered += decoder.decode();
    if (buffered.length > 0 || dataLines.length > 0) throw new AuggyRunError("incomplete-stream", true);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (runId === null || threadId === null || !finished) throw new AuggyRunError("incomplete-stream", true);
  if (runError !== null) throw runError;
  return { runId, threadId, text };
}

function streamError(code: unknown): AuggyRunError {
  if (
    code === "ADMISSION_FAILED" ||
    code === "SCHEDULER_RATE_LIMITED" ||
    code === "SCHEDULER_UNAVAILABLE"
  ) {
    return new AuggyRunError("admission-failed", true);
  }
  if (code === "CANCELED" || code === "CANCELLED" || code === "ABORTED") {
    return new AuggyRunError("remote-canceled", false);
  }
  if (code === "THREAD_QUARANTINED") return new AuggyRunError("outcome-unknown", false);
  if (code === "CAP_DENIED" || code === "REJECTED") return new AuggyRunError("rejected", false);
  return new AuggyRunError("run-error", false);
}

function executionId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_EXECUTION_ID_LENGTH) {
    throw new AuggyRunError("invalid-response", false);
  }
  return value;
}

function enforceEventIdentity(event: AuggySseEvent, runId: string, threadId: string): void {
  if (event.runId !== undefined && executionId(event.runId) !== runId) {
    throw new AuggyRunError("invalid-response", false);
  }
  if (event.threadId !== undefined && executionId(event.threadId) !== threadId) {
    throw new AuggyRunError("invalid-response", false);
  }
}

function finishedStatus(result: unknown): TaskState | "unknown" {
  if (typeof result !== "object" || result === null || !("status" in result)) {
    throw new AuggyRunError("invalid-response", false);
  }
  const status = result.status;
  if (typeof status !== "string") throw new AuggyRunError("invalid-response", false);
  return TASK_STATES.includes(status as TaskState) ? (status as TaskState) : "unknown";
}

function taskStateError(status: Exclude<TaskState, "completed"> | "unknown"): AuggyRunError {
  switch (status) {
    case "working":
      return new AuggyRunError("task-working", false);
    case "input-required":
      return new AuggyRunError("input-required", false);
    case "auth-required":
      return new AuggyRunError("auth-required", false);
    case "failed":
      return new AuggyRunError("task-failed", false);
    case "canceled":
      return new AuggyRunError("remote-canceled", false);
    case "rejected":
      return new AuggyRunError("rejected", false);
    case "unknown":
      return new AuggyRunError("task-status-unknown", false);
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function validateBoundedPositiveInteger(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
}
