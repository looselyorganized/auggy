import { Ollama, type ChatRequest, type ChatResponse, type Message as OllamaMessage, type Tool as OllamaTool, type Options as OllamaOptions } from "ollama";
import { normalizeSchema } from "auggy/internal/schema-normalize";
import { safeParseToolCall } from "auggy/internal/tool-call";
import { assembleSystemBlocks } from "auggy/internal/prompt-assembly";
import type {
  AssembledPrompt,
  Message,
  ModelClient,
  ModelDelta,
  ModelResponse,
  ToolDefinition,
} from "auggy";

/**
 * Ollama engine — a ModelClient adapter that drives the agent's reasoning
 * via Ollama's native HTTP API (the `/api/chat` endpoint, exposed by
 * `ollama serve`).
 *
 * Why native (not the OpenAI-compat shim):
 *  - Tool-calling errors surface clearly (Ollama's compat layer obscures them)
 *  - `keep_alive` (model unload control) is Ollama-specific
 *  - No pricing apparatus inherited from a paid-provider adapter — Ollama is
 *    free, so `costUsd` is always undefined and `budgets.dailyBudgetUsd`
 *    cannot enforce against ollama agents (use `maxTurnsPerThread` or
 *    `anonymousGlobalLimit` instead)
 *  - No API key — Ollama doesn't authenticate by default
 *
 * Responsibilities:
 *  - Translate AssembledPrompt into Ollama's chat request shape (system as
 *    a leading message, conversation messages, tools)
 *  - Run the API call (streaming via NDJSON when `onDelta` provided)
 *  - Translate the response back into ModelResponse
 *
 * Stateless beyond the underlying HTTP client. Retries and timeouts live in
 * the SDK; everything above (queue, history, context budgeting) is the
 * kernel's job.
 *
 * Token counting uses char/4 approximation, matching the Anthropic + OpenAI
 * adapters. The kernel uses src/tokenizer.ts directly for hot paths.
 */
export interface OllamaEngineOptions {
  /** Model name as installed locally (e.g. "llama3.2", "qwen2.5",
   *  "qwen2.5-coder"). Operator must have run `ollama pull <model>` first;
   *  unpulled models cause a clear "model not found" error from the SDK. */
  model: string;
  /** Base URL of the Ollama server. Defaults to "http://localhost:11434".
   *  Override for remote Ollama deployments or non-default ports. */
  baseURL?: string;
  /** Total context window in tokens. Defaults to 8_192 (conservative —
   *  many smaller Ollama models have ≤8k context). Set this per model:
   *  Llama 3.2 supports 128k, Qwen 2.5 supports 128k, smaller models
   *  may be 4k-8k. The kernel uses this for context budgeting and does
   *  not validate against the actual model limit. */
  maxContextTokens?: number;
  /** Per-turn output cap. Forwarded as `options.num_predict`. Defaults
   *  to 2048 (smaller than other providers because local hardware
   *  generation is slower; raise if you want longer responses). */
  maxTokens?: number;
  /** `keep_alive` value forwarded to Ollama — controls how long the model
   *  stays loaded in memory after the request. Defaults to "5m" (Ollama's
   *  own default). Set to `0` to unload after each turn (lower memory,
   *  slower cold starts), or `"-1"` to keep loaded indefinitely (faster
   *  responses, more memory). */
  keepAlive?: string | number;
  /** Optional Ollama-native generation options (temperature, top_k, top_p,
   *  seed, repeat_penalty, mirostat, etc.). Forwarded as the `options`
   *  field of the chat request. `num_predict` is set from `maxTokens`
   *  above; other fields here override it if both are specified. */
  options?: Partial<OllamaOptions>;
  /** Optional bearer token. When set, forwarded as
   *  `Authorization: Bearer <apiKey>` on every request. Required for
   *  Ollama Cloud (ollama.com hosted) and self-hosted Ollama behind
   *  bearer-gated proxies. Local Ollama (default `localhost:11434`)
   *  does not authenticate; leave unset for that case. */
  apiKey?: string;
}

export function createOllamaEngine(opts: OllamaEngineOptions): ModelClient {
  const client = new Ollama({
    host: opts.baseURL ?? "http://localhost:11434",
    ...(opts.apiKey ? { headers: { Authorization: `Bearer ${opts.apiKey}` } } : {}),
  });

  const maxContextTokens = opts.maxContextTokens ?? 8_192;
  const maxOutputTokens = opts.maxTokens ?? 2048;
  const keepAlive = opts.keepAlive ?? "5m";

  // No pricing warning at startup — Ollama is free, costUsd is always
  // undefined, and that's the documented contract. Operators using budgets
  // for cost enforcement should switch to `maxTurnsPerThread` or
  // `anonymousGlobalLimit` for ollama agents.

  return {
    maxContextTokens,

    countTokens(text: string): number {
      // Char/4 approximation matches Auggy's default tokenizer. Ollama's
      // tokenizer is model-dependent and not exposed via the JS SDK.
      return Math.ceil(text.length / 4);
    },

    async complete(
      prompt: AssembledPrompt,
      opts2?: { onDelta?: (delta: ModelDelta) => void; signal?: AbortSignal },
    ): Promise<ModelResponse> {
      opts2?.signal?.throwIfAborted();
      const messages = convertMessages(prompt);
      const tools = convertTools(prompt.tools);

      const baseRequest: Omit<ChatRequest, "stream"> = {
        model: opts.model,
        messages,
        keep_alive: keepAlive,
        options: { num_predict: maxOutputTokens, ...opts.options },
        ...(tools.length > 0 ? { tools } : {}),
      };

      if (opts2?.onDelta || opts2?.signal) {
        // Ollama only exposes request cancellation through its abortable
        // streaming iterator. Use that path whenever a signal is supplied,
        // even when the caller wants a buffered response and no deltas.
        // Ollama streams NDJSON chunks; the SDK exposes them as an
        // AsyncIterable.
        //
        // Tool-call quirk: Ollama emits the entire `tool_calls` array in a
        // single intermediate chunk (typically the FIRST chunk for a
        // tool-using turn) with `done: false`, then a final `done: true`
        // chunk that does NOT repeat tool_calls. We must accumulate
        // tool_calls across all chunks — relying on the last chunk loses
        // them entirely (silent empty turn, model output discarded).
        const stream = await client.chat({ ...baseRequest, stream: true });
        const abortStream = () => stream.abort();
        opts2.signal?.addEventListener("abort", abortStream, { once: true });
        if (opts2.signal?.aborted) {
          stream.abort();
          opts2.signal.removeEventListener("abort", abortStream);
          opts2.signal.throwIfAborted();
        }
        let accumulated = "";
        let lastChunk: ChatResponse | null = null;
        const accumulatedToolCalls: NonNullable<OllamaMessage["tool_calls"]> = [];
        try {
          for await (const chunk of stream) {
            if (chunk.message?.content) {
              accumulated += chunk.message.content;
              opts2.onDelta?.({ kind: "text_delta", text: chunk.message.content });
            }
            if (chunk.message?.tool_calls) {
              accumulatedToolCalls.push(...chunk.message.tool_calls);
            }
            lastChunk = chunk;
          }
        } finally {
          opts2.signal?.removeEventListener("abort", abortStream);
        }
        if (!lastChunk) {
          throw new Error("Ollama stream returned no chunks");
        }
        return buildModelResponse(accumulated, lastChunk, accumulatedToolCalls);
      }

      // Non-streaming path (buffered; for tests / consumers that don't
      // need streaming). Tool calls come back in response.message.tool_calls
      // directly — no accumulation needed.
      const response = await client.chat({ ...baseRequest, stream: false });
      return buildModelResponse(
        response.message?.content ?? "",
        response,
        response.message?.tool_calls ?? [],
      );
    },
  };
}

// === AssembledPrompt → Ollama request translation ===
//
// Ollama's chat API takes a flat list of messages with roles. Unlike
// Anthropic (which separates `system` and `messages`), system content is
// just a Message with role: "system" at the front. Unlike Anthropic's
// nested tool_use/tool_result content blocks, Ollama uses a flat structure:
//   - Assistant tool-using turn: message with content + tool_calls array
//   - Tool result: message with role: "tool", tool_name, content
//
// assembleSystemBlocks builds the combined system string from identity +
// contextBlocks + (optional) assistantPreamble; we prepend it as a single
// system message when non-empty.

function convertMessages(prompt: AssembledPrompt): OllamaMessage[] {
  const result: OllamaMessage[] = [];

  // Lead with system message if any system blocks present.
  const system = assembleSystemBlocks(prompt);
  if (system) {
    result.push({ role: "system", content: system });
  }

  let i = 0;
  const messages = prompt.messages;
  while (i < messages.length) {
    const msg = messages[i]!;

    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content });
      i++;
      continue;
    }

    if (msg.role === "assistant") {
      const toolCalls: { function: { name: string; arguments: Record<string, unknown> } }[] = [];
      const content = msg.content ?? "";
      i++;
      // Gather any consecutive tool_use messages into this assistant turn.
      while (i < messages.length && messages[i]!.role === "tool_use") {
        const tu = messages[i]!;
        const parsed = safeParseToolCall(tu.content);
        if (parsed) {
          toolCalls.push({
            function: { name: parsed.name, arguments: parsed.arguments },
          });
        }
        i++;
      }
      const assistantMsg: OllamaMessage = { role: "assistant", content };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      // Skip empty assistant messages with no content and no tool calls
      // (Ollama tolerates but it's noise).
      if (content || toolCalls.length > 0) {
        result.push(assistantMsg);
      }
      continue;
    }

    if (msg.role === "tool_use") {
      // Orphaned tool_use with no preceding assistant text — wrap alone.
      const parsed = safeParseToolCall(msg.content);
      if (parsed) {
        result.push({
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: parsed.name, arguments: parsed.arguments } }],
        });
      }
      i++;
      continue;
    }

    if (msg.role === "tool_result") {
      // Ollama tool results use role: "tool" with tool_name set to the
      // name of the tool that produced the result. Auggy's Message doesn't
      // store tool name on tool_result — we leave tool_name unset (the
      // toolCallId is the binding the model needs, and Ollama tolerates
      // its absence).
      result.push({ role: "tool", content: msg.content });
      i++;
      continue;
    }

    // Unknown role — skip defensively.
    i++;
  }

  return result;
}

function convertTools(toolDefs: ToolDefinition[]): OllamaTool[] {
  return toolDefs.map((td) => ({
    type: "function",
    function: {
      name: td.name,
      description: td.description,
      parameters: normalizeSchema(td.inputSchema) as OllamaTool["function"]["parameters"],
    },
  }));
}

// === Ollama response → ModelResponse translation ===
//
// `rawToolCalls` is passed in by the caller. Streaming path accumulates
// across all chunks (tool_calls arrive in an intermediate chunk for
// Ollama, not the final one). Buffered path passes
// `response.message?.tool_calls ?? []` directly.

function buildModelResponse(
  content: string,
  response: ChatResponse,
  rawToolCalls: NonNullable<OllamaMessage["tool_calls"]>,
): ModelResponse {
  const toolCalls: { name: string; arguments: Record<string, unknown> }[] = [];
  for (const tc of rawToolCalls) {
    // tc.function.arguments is `{[key: string]: any}` per Ollama SDK
    // types — already an object, no parsing needed.
    toolCalls.push({
      name: tc.function.name,
      arguments: tc.function.arguments as Record<string, unknown>,
    });
  }

  // Map Ollama's done_reason to Auggy's finishReason. Ollama uses:
  //   - "stop": natural end
  //   - "length": hit num_predict cap
  //   - tool_calls present in message: model decided to call tools
  // Some Ollama versions / models don't set done_reason consistently;
  // infer "tool_use" from presence of tool_calls as the most reliable signal.
  const finishReason: ModelResponse["finishReason"] =
    toolCalls.length > 0
      ? "tool_use"
      : response.done_reason === "length"
        ? "max_tokens"
        : "end_turn";

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    // Ollama exposes prompt_eval_count (input) and eval_count (output) in
    // the final response. Streaming chunks before the final one don't carry
    // these — that's why buildModelResponse takes the lastChunk in the
    // streaming path. Field names mirror Anthropic's inputTokens/outputTokens.
    inputTokens: response.prompt_eval_count ?? 0,
    outputTokens: response.eval_count ?? 0,
    finishReason,
    // costUsd: undefined — Ollama is free; no pricing apparatus.
  };
}
