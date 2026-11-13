/** A bounded Anthropic Messages server for the packed release acceptance path. */
export const PROVIDER_FIXTURE_API_KEY = "sk-ant-auggy-release-smoke-not-real";
export const PROVIDER_FIXTURE_FINAL_TEXT = "Packed acceptance tool result verified.";

export type ProviderFixtureScenario = "success" | "invalid-tool-arguments" | "provider-failure";

export interface ProviderFixtureTool {
  name: string;
  input: Record<string, unknown>;
  invalidInput: Record<string, unknown>;
}

export interface ProviderFixtureOptions {
  toolResultSentinel: string;
  toolPath?: string;
  /** Explicit reference capability; omitted preserves the existing fs_read fixture. */
  tool?: ProviderFixtureTool;
  scenario?: ProviderFixtureScenario;
  apiKey?: string;
  maxCalls?: number;
  maxRequestBytes?: number;
}

type RequestOutcome =
  | "tool-request"
  | "verified-tool-result"
  | "verified-validation-error"
  | "provider-failure"
  | "invalid-request"
  | "call-limit";

export interface ProviderFixtureEvidence {
  scenario: ProviderFixtureScenario;
  generation: number;
  calls: number;
  toolRequests: number;
  validatedToolResults: number;
  finalResponses: number;
  rejectedRequests: number;
  summaries: { call: number; streaming: boolean; outcome: RequestOutcome; status: number }[];
}

export interface ProviderFixture {
  readonly baseURL: string;
  readonly ready: { type: "provider-fixture-ready"; baseURL: string };
  setScenario(scenario: ProviderFixtureScenario): void;
  reset(): void;
  evidence(): ProviderFixtureEvidence;
  stop(): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Bounded JSON equality; request object key order is not protocol meaning. */
function canonicalInput(value: unknown, depth = 0): string {
  if (depth > 8) throw new Error("Fixture tool input nesting exceeded.");
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length > 128) throw new Error("Fixture tool input array exceeded.");
    return `[${value.map((entry) => canonicalInput(entry, depth + 1)).join(",")}]`;
  }
  if (record(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const keys = Object.keys(value).sort();
    if (keys.length > 128) throw new Error("Fixture tool input keys exceeded.");
    const encoded = `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalInput(value[key], depth + 1)}`).join(",")}}`;
    if (encoded.length > 8_192) throw new Error("Fixture tool input bytes exceeded.");
    return encoded;
  }
  throw new Error("Fixture tool input must be finite JSON data.");
}

function validScenario(value: string): value is ProviderFixtureScenario {
  return ["success", "invalid-tool-arguments", "provider-failure"].includes(value);
}

function limit(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid provider fixture ${name}.`);
  }
  return value;
}

function errorResponse(status: number, message: string): Response {
  return Response.json(
    { type: "error", error: { type: "invalid_request_error", message } },
    { status },
  );
}

async function readBody(request: Request, maxBytes: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("missing-body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 2_000);
  try {
    while (true) {
      const chunk = await reader.read();
      if (timedOut) throw new Error("body-timeout");
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("body-limit");
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

function toolResultMatches(
  messages: unknown[],
  name: string,
  input: Record<string, unknown>,
  sentinel: string,
  invalidArguments: boolean,
): boolean {
  const last = messages.at(-1);
  if (!record(last) || last.role !== "user" || !Array.isArray(last.content)) return false;
  const results = last.content.filter((block) => record(block) && block.type === "tool_result");
  if (results.length !== 1) return false;
  const result = results[0]!;
  if (
    typeof result.tool_use_id !== "string" ||
    typeof result.content !== "string" ||
    (!invalidArguments && result.is_error === true)
  ) {
    return false;
  }
  // The kernel assigns its own toolCallId. Validate the returned pair, not the
  // provider's original ID, which is deliberately not an execution authority.
  const previous = messages.at(-2);
  if (!record(previous) || previous.role !== "assistant" || !Array.isArray(previous.content)) {
    return false;
  }
  const toolUses = previous.content.filter((block) => record(block) && block.type === "tool_use");
  if (toolUses.length !== 1) return false;
  const tool = toolUses[0]!;
  if (
    tool.id !== result.tool_use_id ||
    tool.name !== name ||
    !record(tool.input) ||
    canonicalInput(tool.input) !== canonicalInput(input)
  ) {
    return false;
  }
  return invalidArguments
    ? result.content.startsWith("Validation error:") && !result.content.includes(sentinel)
    : result.content.includes(sentinel);
}

function messageResponse(
  model: string,
  content: Record<string, unknown>,
  streaming: boolean,
  id: string,
): Response {
  const stopReason = content.type === "tool_use" ? "tool_use" : "end_turn";
  const message = {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [content],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 7 },
  };
  if (!streaming) return Response.json(message);
  const events = [
    {
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 11, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block:
        content.type === "tool_use" ? { ...content, input: {} } : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta:
        content.type === "tool_use"
          ? { type: "input_json_delta", partial_json: JSON.stringify(content.input) }
          : { type: "text_delta", text: content.text },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 7 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    },
  );
}

export function createProviderFixture(options: ProviderFixtureOptions): ProviderFixture {
  if (!options.toolResultSentinel || options.toolResultSentinel.length > 1_024) {
    throw new Error("Provider fixture needs a bounded nonempty tool result sentinel.");
  }
  const scenario = options.scenario ?? "success";
  if (!validScenario(scenario)) throw new Error("Invalid provider fixture scenario.");
  const toolPath = options.toolPath ?? "workspace/acceptance.txt";
  if (!toolPath || toolPath.length > 1_024) throw new Error("Invalid provider fixture tool path.");
  if (options.tool && options.toolPath !== undefined) {
    throw new Error("Explicit fixture tool and legacy toolPath cannot both be set.");
  }
  const selectedTool = options.tool ?? {
    name: "fs_read",
    input: { path: toolPath },
    invalidInput: { path: 17 },
  };
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(selectedTool.name)) {
    throw new Error("Invalid provider fixture tool name.");
  }
  if (!record(selectedTool.input) || !record(selectedTool.invalidInput)) {
    throw new Error("Fixture tool inputs must be objects.");
  }
  // Snapshot caller input before opening a listener; later mutation cannot alter a scenario.
  const tool: ProviderFixtureTool = {
    name: selectedTool.name,
    input: JSON.parse(canonicalInput(selectedTool.input)),
    invalidInput: JSON.parse(canonicalInput(selectedTool.invalidInput)),
  };
  if (canonicalInput(tool.input) === canonicalInput(tool.invalidInput)) {
    throw new Error("Fixture invalid tool input must differ from valid input.");
  }
  const apiKey = options.apiKey ?? PROVIDER_FIXTURE_API_KEY;
  const maxCalls = limit(options.maxCalls ?? 4, 32, "call limit");
  const maxRequestBytes = limit(options.maxRequestBytes ?? 1_048_576, 2_097_152, "body limit");
  let active = false;
  let stopped = false;
  let phase: "initial" | "result" | "complete" = "initial";
  let state: ProviderFixtureEvidence;
  function reset(nextScenario: ProviderFixtureScenario, generation: number): void {
    if (stopped || active)
      throw new Error("Provider fixture cannot reset while active or stopped.");
    if (!validScenario(nextScenario)) throw new Error("Invalid provider fixture scenario.");
    phase = "initial";
    state = {
      scenario: nextScenario,
      generation,
      calls: 0,
      toolRequests: 0,
      validatedToolResults: 0,
      finalResponses: 0,
      rejectedRequests: 0,
      summaries: [],
    };
  }
  reset(scenario, 1);
  const serveOptions = {
    hostname: "127.0.0.1",
    idleTimeout: 5,
    maxRequestBodySize: maxRequestBytes,
    async fetch(request: Request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/messages") {
        return errorResponse(404, "Unknown fixture endpoint.");
      }
      if (request.headers.get("x-api-key") !== apiKey) {
        state.rejectedRequests++;
        return errorResponse(401, "Invalid fixture credentials.");
      }
      if (active) {
        state.rejectedRequests++;
        return errorResponse(409, "Concurrent fixture requests are not supported.");
      }
      active = true;
      const call = ++state.calls;
      let streaming = false;
      const note = (outcome: RequestOutcome, status: number): void => {
        if (state.summaries.length < maxCalls + 1) {
          state.summaries.push({ call, streaming, outcome, status });
        }
        if (status !== 200) state.rejectedRequests++;
      };
      try {
        if (call > maxCalls) {
          note("call-limit", 429);
          return errorResponse(429, "Provider fixture call limit reached.");
        }
        const body = await readBody(request, maxRequestBytes);
        if (
          !record(body) ||
          typeof body.model !== "string" ||
          !body.model ||
          !Array.isArray(body.messages) ||
          body.messages.length === 0 ||
          (body.stream !== undefined && typeof body.stream !== "boolean")
        ) {
          throw new Error("invalid-envelope");
        }
        streaming = body.stream === true;
        if (state.scenario === "provider-failure") {
          note("provider-failure", 503);
          return Response.json(
            {
              type: "error",
              error: { type: "overloaded_error", message: "Fixture provider failure." },
            },
            { status: 503, headers: { "retry-after": "0" } },
          );
        }
        const invalidArguments = state.scenario === "invalid-tool-arguments";
        const input = invalidArguments ? tool.invalidInput : tool.input;
        if (phase === "initial") {
          if (
            !Array.isArray(body.tools) ||
            !body.tools.some((entry) => record(entry) && entry.name === tool.name)
          ) {
            throw new Error("missing-tool");
          }
          phase = "result";
          state.toolRequests++;
          note("tool-request", 200);
          return messageResponse(
            body.model,
            { type: "tool_use", id: "toolu_fixture_read", name: tool.name, input },
            streaming,
            `msg_fixture_${state.generation}_${call}`,
          );
        }
        if (
          phase !== "result" ||
          !toolResultMatches(
            body.messages,
            tool.name,
            input,
            options.toolResultSentinel,
            invalidArguments,
          )
        ) {
          throw new Error("invalid-tool-result");
        }
        phase = "complete";
        state.validatedToolResults++;
        state.finalResponses++;
        note(invalidArguments ? "verified-validation-error" : "verified-tool-result", 200);
        return messageResponse(
          body.model,
          { type: "text", text: PROVIDER_FIXTURE_FINAL_TEXT },
          streaming,
          `msg_fixture_${state.generation}_${call}`,
        );
      } catch {
        note("invalid-request", 400);
        return errorResponse(400, "Request did not match the fixture scenario.");
      } finally {
        active = false;
      }
    },
  };
  const server = (() => {
    let lastError: unknown;
    const fallbackStart = 20_000 + Math.floor(Math.random() * 20_000);
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        return Bun.serve({
          ...serveOptions,
          port: attempt === 0 ? 0 : fallbackStart + attempt - 1,
        });
      } catch (error) {
        if (!record(error) || error.code !== "EADDRINUSE") throw error;
        lastError = error;
      }
    }
    throw lastError;
  })();
  const baseURL = `http://127.0.0.1:${server.port}`;
  return {
    baseURL,
    ready: { type: "provider-fixture-ready", baseURL },
    setScenario(nextScenario) {
      reset(nextScenario, state.generation + 1);
    },
    reset() {
      reset(state.scenario, state.generation + 1);
    },
    evidence() {
      return structuredClone(state);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await server.stop(true);
    },
  };
}
