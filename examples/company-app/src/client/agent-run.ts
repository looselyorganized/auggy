/** The browser request surface used by this client, independent of Bun fetch extensions. */
export interface BrowserFetchOptions {
  method?: "POST";
  credentials: "same-origin" | "omit";
  cache: "no-store";
  redirect: "error";
  signal: AbortSignal;
  headers?: Record<string, string>;
  body?: string;
}
export type BrowserFetch = (input: string | URL, options: BrowserFetchOptions) => Promise<Response>;

export type RunState = "connecting" | "streaming" | "completed" | "failed" | "interrupted";
export interface AgentOperation {
  readonly key: string;
  readonly threadId: string;
  readonly message: string;
}
export interface RunUpdate {
  state: RunState;
  text: string;
  message: string;
  retryable: boolean;
  code?: string;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_EVENTS = 10_000;
class InvalidAgentStream extends Error {}

export function createAgentOperation(message: string, threadId: string): AgentOperation {
  if (!message.trim() || message.length > 4000)
    throw new Error("Enter a message of at most 4,000 characters.");
  return Object.freeze({ key: crypto.randomUUID(), threadId, message: message.trim() });
}

function agentOrigin(value: string): string {
  const url = new URL(value);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    /[\p{Cc}\s\\]/u.test(value)
  )
    throw new Error("Invalid agent destination");
  return url.origin;
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new Error("Missing response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw new Error("Response exceeded limit");
      chunks.push(part.value);
    }
    const content = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function loadAgentConfiguration(fetchImpl: BrowserFetch = fetch): Promise<string> {
  const response = await fetchImpl("/api/auggy-config", {
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    void response.body?.cancel();
    throw new Error("Agent connection is not configured. Contact the application operator.");
  }
  const config = (await boundedJson(response, 4096)) as { agentOrigin?: unknown };
  if (typeof config.agentOrigin !== "string")
    throw new Error("Agent connection is not configured.");
  return agentOrigin(config.agentOrigin);
}

/** One user action owns one key. Retrying this object gets a fresh assertion, never a new key. */
export async function runAgentOperation(options: {
  agentOrigin: string;
  operation: AgentOperation;
  signal?: AbortSignal;
  onUpdate: (update: RunUpdate) => void;
  fetch?: BrowserFetch;
}): Promise<RunUpdate> {
  const fetchImpl = options.fetch ?? fetch;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 120_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  let text = "";
  let reader:
    | Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock">
    | undefined;
  let attemptedRun = false;
  const update = (
    state: RunState,
    message: string,
    retryable = false,
    code?: string,
  ): RunUpdate => {
    const value = { state, text, message, retryable, ...(code ? { code } : {}) };
    options.onUpdate(value);
    return value;
  };
  const abortReader = () => {
    void reader?.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abortReader, { once: true });
  try {
    const destination = agentOrigin(options.agentOrigin);
    update("connecting", "Connecting to your agent…");
    const issued = await fetchImpl("/api/auggy-auth-assertion", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
      headers: { "x-auggy-csrf-request": "1" },
    });
    if (!issued.ok) {
      void issued.body?.cancel();
      return update(
        "failed",
        issued.status === 401
          ? "Your application session has expired. Sign in through your application, then try again."
          : issued.status === 403
            ? "The application rejected this request. Reload this page before trying again."
            : "The application could not verify your session. Contact the application operator.",
        false,
        "assertion-unavailable",
      );
    }
    const body = (await boundedJson(issued, 64 * 1024)) as { assertion?: unknown };
    if (typeof body.assertion !== "string" || !body.assertion || body.assertion.length > 60_000)
      throw new Error("Invalid assertion response");
    signal.throwIfAborted();
    attemptedRun = true;
    const response = await fetchImpl(new URL("/agent/run", destination), {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal,
      headers: {
        "content-type": "application/json",
        "x-auggy-auth-assertion": body.assertion,
        "idempotency-key": options.operation.key,
      },
      body: JSON.stringify({
        threadId: options.operation.threadId,
        messages: [
          {
            id: `message-${options.operation.key}`,
            role: "user",
            content: options.operation.message,
          },
        ],
      }),
    });
    if (!response.ok) {
      let errorCode = "";
      try {
        const data = (await boundedJson(response, 4096)) as { error?: unknown };
        if (typeof data.error === "string") errorCode = data.error;
      } catch {
        /* Controlled UI text only. */
      }
      if (errorCode === "idempotency_outcome_unknown")
        return update(
          "failed",
          "This operation needs reconciliation. Contact the operator before submitting it again; its effect may already have occurred.",
          false,
          "outcome-unknown",
        );
      if (response.status === 409 && errorCode === "idempotency_in_progress")
        return update(
          "interrupted",
          "The operation is still running. Retry delivery to receive the same operation's result.",
          true,
          "in-progress",
        );
      return update(
        "failed",
        response.status === 401 || response.status === 403
          ? "The agent did not authorize this request. Check your application access before trying again."
          : response.status === 409
            ? "This operation belongs to different request or access details. Contact the operator."
            : "The agent is unavailable. Retry delivery with the same operation key.",
        response.status >= 500,
        "agent-request-failed",
      );
    }
    if (
      !response.body ||
      !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
    ) {
      void response.body?.cancel();
      return update(
        "failed",
        "The agent returned an invalid response. Contact the operator.",
        false,
        "invalid-stream",
      );
    }
    const streamReader = response.body.getReader();
    reader = streamReader;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let bytes = 0;
    let events = 0;
    for (;;) {
      signal.throwIfAborted();
      const part = await streamReader.read();
      signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new InvalidAgentStream("Stream exceeded limit");
      buffer += decoder.decode(part.value, { stream: true });
      for (;;) {
        const boundary = buffer.search(/\r?\n\r?\n/);
        if (boundary < 0) break;
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)![0];
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separator.length);
        if (frame.length > MAX_EVENT_BYTES || ++events > MAX_EVENTS)
          throw new InvalidAgentStream("Stream exceeded limit");
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        let event: { type?: unknown; delta?: unknown; result?: { status?: unknown } };
        try {
          event = JSON.parse(data);
        } catch {
          throw new InvalidAgentStream("Invalid stream event");
        }
        if (!event || typeof event !== "object" || typeof event.type !== "string")
          throw new InvalidAgentStream("Invalid stream event");
        if (event.type === "TEXT_MESSAGE_CONTENT") {
          if (typeof event.delta !== "string")
            throw new InvalidAgentStream("Invalid content event");
          text += event.delta;
          update("streaming", "Receiving your agent's response…");
        }
        if (event.type === "RUN_ERROR")
          return update(
            "failed",
            "The agent could not complete this operation. Contact the operator before repeating an action.",
            false,
            "run-failed",
          );
        if (event.type === "RUN_FINISHED") {
          if (
            event.result?.status !== undefined &&
            !["completed", "input-required"].includes(String(event.result.status))
          ) {
            return update(
              "failed",
              "The agent could not complete this operation. Contact the operator before repeating an action.",
              false,
              "run-failed",
            );
          }
          return update("completed", "Response complete.");
        }
      }
      if (buffer.length > MAX_EVENT_BYTES) throw new InvalidAgentStream("Stream exceeded limit");
    }
    return update(
      "interrupted",
      "Delivery ended before completion. Retry delivery to receive the same operation's result.",
      true,
      "truncated-stream",
    );
  } catch (error) {
    if (error instanceof InvalidAgentStream)
      return update(
        "failed",
        "The agent returned an invalid response. Contact the operator before repeating an action.",
        false,
        "invalid-stream",
      );
    return update(
      attemptedRun ? "interrupted" : "failed",
      attemptedRun
        ? "Delivery was interrupted. The agent may still be running; retry delivery using this operation."
        : "The application could not connect. Reload the page and try again.",
      attemptedRun,
      signal.aborted ? "interrupted" : "connection-failed",
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abortReader);
    void reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
