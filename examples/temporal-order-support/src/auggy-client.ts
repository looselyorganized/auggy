const MAX_ERROR_BYTES = 4 * 1024;

export type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AuggyRunErrorKind =
  | "admission-failed"
  | "binding-conflict"
  | "canceled"
  | "incomplete-stream"
  | "invalid-response"
  | "outcome-unknown"
  | "rejected"
  | "run-error"
  | "sse-limit";

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
  runId: string | null;
  text: string;
}

interface AuggySseEvent {
  type?: unknown;
  code?: unknown;
  runId?: unknown;
  delta?: unknown;
}

export interface AuggyRunClient {
  run(request: AuggyRunRequest, signal?: AbortSignal, onProgress?: () => void): Promise<AuggyRunCompleted>;
}

export function createAuggyRunClient(config: AuggyRunClientConfig): AuggyRunClient {
  const endpoint = agentRunEndpoint(config.target, config.allowInsecureLocalhost === true);
  const fetchImplementation = config.fetchImplementation ?? fetch;
  if (config.bearerToken.length === 0) throw new Error("AUGGY_BEARER_TOKEN must not be empty");
  if (!Number.isSafeInteger(config.maxSseBytes) || config.maxSseBytes < 1) {
    throw new Error("maxSseBytes must be a positive integer");
  }
  if (!Number.isSafeInteger(config.maxSseEvents) || config.maxSseEvents < 1) {
    throw new Error("maxSseEvents must be a positive integer");
  }

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
          signal,
        });
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw new AuggyRunError("canceled", false);
        // The only retry mechanism is Temporal Activity retrying the same key.
        // The server will join, replay, or fail closed rather than start a new run.
        throw new AuggyRunError("admission-failed", true);
      }

      if (!response.ok) throw await httpError(response);
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
        throw new AuggyRunError("invalid-response", false);
      }
      if (response.body === null) throw new AuggyRunError("incomplete-stream", true);

      return consumeSse(response.body, config.maxSseBytes, config.maxSseEvents, onProgress);
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
    if (event.type === "RUN_STARTED" && typeof event.runId === "string" && event.runId.length <= 256) runId = event.runId;
    if (event.type === "TEXT_MESSAGE_CONTENT" && typeof event.delta === "string") text += event.delta;
    if (event.type === "RUN_ERROR") runError = streamError(event.code);
    if (event.type === "RUN_FINISHED") finished = true;
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

  if (!finished) throw new AuggyRunError("incomplete-stream", true);
  if (runError !== null) throw runError;
  return { runId, text };
}

function streamError(code: unknown): AuggyRunError {
  if (code === "ADMISSION_FAILED") return new AuggyRunError("admission-failed", true);
  if (code === "CANCELED" || code === "CANCELLED") return new AuggyRunError("canceled", false);
  if (code === "REJECTED") return new AuggyRunError("rejected", false);
  return new AuggyRunError("run-error", false);
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
