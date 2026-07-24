import OpenAI from "openai";
import { normalizeSchema } from "auggy/internal/schema-normalize";
import { lookup, getFreshness, priceOpenAIResponse } from "auggy/internal/openai-pricing";
import { safeParseToolCall } from "auggy/internal/tool-call";
import { assembleSystemBlocks } from "auggy/internal/prompt-assembly";
import { warnCacheRatesIgnored } from "auggy/internal/cost";
import { assertSecureCredentialTransport } from "auggy/internal/credential-transport";
import { providerRequestError } from "auggy/internal/provider-error";
import {
  createBoundedModelFetch,
  findModelResponseLimitError,
  measureJsonValue,
  ModelResponseLimitError,
  resolveModelResponseLimits,
  utf8ByteLength,
  validateModelResponse,
} from "auggy/internal/response-limits";
import type {
  AssembledPrompt,
  Message,
  ModelClient,
  ModelDelta,
  ModelResponse,
  ModelResponseLimits,
  ToolDefinition,
} from "auggy";

/**
 * OpenAI engine — a ModelClient adapter that drives the agent's reasoning
 * via OpenAI's Chat Completions API.
 *
 * Responsibilities:
 *  - Translate AssembledPrompt into Chat Completions request shape
 *    (system message, conversation messages, tools)
 *  - Run the API call (buffered; no streaming)
 *  - Translate the response back into ModelResponse
 *
 * The engine is stateless beyond the underlying SDK. Retries, timeouts, and
 * rate-limit handling live in the SDK; everything above (queue, history,
 * context budgeting) is the kernel's job.
 *
 * Token counting uses a character/4 approximation, matching the Anthropic
 * engine and Auggy's default tokenizer. The kernel does not call this
 * method on hot paths (it uses src/tokenizer.ts directly), so accuracy is
 * not load-bearing.
 */
/**
 * Reasoning-effort levels exposed by the engine.
 *
 * Local string union — intentionally NOT typed as `OpenAI.Chat.ChatCompletionReasoningEffort`
 * so the engine's public option interface doesn't drag the `openai` SDK into
 * consumer type resolution via emitted `.d.ts`. Mirrors `EngineConfig.reasoningEffort`
 * in `src/cli/types.ts` exactly. Wider than the SDK's current union (includes `none`
 * and `xhigh`); the API call casts at the forwarding site below.
 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface OpenAIEngineOptions {
  /** API key. Defaults to OPENAI_API_KEY env (read by the SDK). */
  apiKey?: string;
  /** Model ID (e.g. "gpt-5", "gpt-5.1", "o3", "o4-mini"). */
  model: string;
  /** Total context window in tokens. Defaults to 128_000.
   *  Set this per model — the kernel uses it for context budgeting and
   *  doesn't validate against the actual API limit. */
  maxContextTokens?: number;
  /** Per-turn output cap, sent as `max_completion_tokens`. Defaults to 4096.
   *  Note: `max_tokens` is deprecated in v6 SDK and rejected by o-series. */
  maxTokens?: number;
  /** Optional base URL override (for proxies or compatible providers). */
  baseURL?: string;
  /** Development-only escape hatch for credentialed non-loopback HTTP. */
  allowInsecureHttpWithCredentials?: boolean;
  /** Reasoning effort for reasoning-capable models.
   *  - `none`: gpt-5.1 only
   *  - `minimal | low | medium | high`: universally supported on reasoning models
   *  - `xhigh`: gpt-5.1-codex-max and later
   *  Older Chat Completions models (e.g. gpt-4) do NOT support this — the API
   *  returns an error which propagates through `complete()`. */
  reasoningEffort?: ReasoningEffort;
  /**
   * Override pricing for cost estimation. If set, the adapter uses these rates
   * instead of the built-in pricing table. Useful for unknown models or custom
   * pricing arrangements. USD per million tokens.
   *
   * Accepts the full Pricing shape; cache fields are accepted for type symmetry
   * with Anthropic but not used by the OpenAI adapter today (no cache-token
   * usage is parsed from OpenAI Chat Completions responses).
   */
  costOverride?: import("auggy/internal/cost").Pricing;
  /** Finite application-layer response limits. Omitted fields use secure defaults. */
  responseLimits?: Partial<ModelResponseLimits>;
}

export function createOpenAIEngine(opts: OpenAIEngineOptions): ModelClient {
  const responseLimits = resolveModelResponseLimits(opts.responseLimits);
  const effectiveApiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  assertSecureCredentialTransport({
    provider: "OpenAI",
    baseURL: opts.baseURL ?? "https://api.openai.com/v1",
    credential: effectiveApiKey,
    allowInsecureHttpWithCredentials: opts.allowInsecureHttpWithCredentials,
  });
  const client = new OpenAI({
    apiKey: effectiveApiKey,
    baseURL: opts.baseURL,
    fetch: createBoundedModelFetch(
      globalThis.fetch.bind(globalThis) as typeof fetch,
      responseLimits,
    ),
  });

  const maxContextTokens = opts.maxContextTokens ?? 128_000;
  const maxOutputTokens = opts.maxTokens ?? 4096;

  // Pricing freshness + availability warning at startup. Fires once at
  // factory time, not per-turn.
  if (!opts.costOverride) {
    const rates = lookup(opts.model);
    if (!rates) {
      // eslint-disable-next-line no-console
      console.warn(
        `[engines/openai] No pricing entry for model "${opts.model}" and no costOverride configured. ` +
          `costUsd will be undefined; dailyBudgetUsd cannot enforce against this model. ` +
          `Add the model to src/engines/openai/pricing.ts or configure engine.costOverride in agent.yaml.`,
      );
    } else {
      const f = getFreshness();
      if (f.stale) {
        // eslint-disable-next-line no-console
        console.warn(
          `[engines/openai] Pricing table verifiedAt ${f.verifiedAt} is more than 90 days old. ` +
            `Cost estimates may be drifting from actual billing. Verify rates and update src/engines/openai/pricing.ts.`,
        );
      }
    }
  } else {
    // Operator set a custom pricing override. Warn if they included cache
    // rates — the OpenAI adapter doesn't parse cache tokens from upstream
    // responses, so those rates would be silently ignored.
    warnCacheRatesIgnored("openai", opts.costOverride);
  }

  return {
    maxContextTokens,

    countTokens(text: string): number {
      return Math.ceil(text.length / 4);
    },

    async complete(
      prompt: AssembledPrompt,
      requestOptions?: { onDelta?: (delta: ModelDelta) => void; signal?: AbortSignal },
    ): Promise<ModelResponse> {
      const systemMessage = assembleOpenAISystemMessage(prompt);
      const messages = convertOpenAIMessages(prompt.messages);
      const tools = convertOpenAITools(prompt.tools);

      const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = systemMessage
        ? [systemMessage, ...messages]
        : messages;

      const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model: opts.model,
        max_completion_tokens: maxOutputTokens,
        messages: allMessages,
        ...(tools.length > 0 ? { tools } : {}),
        ...(opts.reasoningEffort
          ? {
              reasoning_effort:
                opts.reasoningEffort as OpenAI.Chat.ChatCompletionReasoningEffort,
            }
          : {}),
      };

      let completion: OpenAI.Chat.ChatCompletion;
      try {
        completion = await client.chat.completions.create(params, {
          signal: requestOptions?.signal,
        });
      } catch (err) {
        const responseLimitError = findModelResponseLimitError(err);
        if (responseLimitError) throw responseLimitError;
        throw providerRequestError("OpenAI", opts.model, err);
      }
      const usage = parseOpenAIUsage(
        isProviderRecord(completion) ? completion.usage : undefined,
      );
      const { inputTokens, outputTokens } = usage;
      const result = usage.valid
        ? priceOpenAIResponse(opts.model, opts.costOverride, {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            reasoning_tokens: usage.reasoningTokens,
          })
        : { priced: false as const, reason: INVALID_USAGE_REASON };
      const accounting = result.priced
        ? { inputTokens, outputTokens, costUsd: result.costUsd }
        : { inputTokens, outputTokens, unpricedReason: result.reason };
      let response: ModelResponse;
      try {
        response = buildOpenAIModelResponse(completion, opts.model, responseLimits);
      } catch (error) {
        if (error instanceof ModelResponseLimitError) {
          throw error.withAccounting(accounting);
        }
        throw error;
      }
      return result.priced
        ? { ...response, costUsd: result.costUsd }
        : { ...response, costUsd: undefined, unpricedReason: result.reason };
    },
  };
}

// ===========================================================================
// AssembledPrompt → OpenAI request translation
// ===========================================================================

/** Join system + context + assistant-preamble blocks into a single system
 *  message, or return null if there is nothing to say. OpenAI has no
 *  separate slot for context-block content, so it folds into system.
 *  Block assembly lives in `auggy/internal/prompt-assembly` (shared with
 *  the Anthropic adapter); this wrapper handles the OpenAI-specific
 *  null-on-empty + message-envelope shape. */
export function assembleOpenAISystemMessage(
  prompt: AssembledPrompt,
): OpenAI.Chat.ChatCompletionSystemMessageParam | null {
  const content = assembleSystemBlocks(prompt);
  if (content.length === 0) return null;
  return { role: "system", content };
}

/** Re-export of `safeParseToolCall` from `auggy/internal/tool-call`. The
 *  parser lives in core's `_shared` so the Anthropic adapter can use the
 *  same defensive shape (incl. the array-rejection guard). External
 *  consumers can still `import { safeParseToolCall } from "@auggy/openai"`. */
export { safeParseToolCall } from "auggy/internal/tool-call";

/** Walk Auggy's flat message list and produce OpenAI's grouped format.
 *
 *  Auggy stores tool_use and tool_result as separate flat messages with
 *  matching toolCallIds. OpenAI wants:
 *   - `tool_use` entries folded into the preceding assistant message's
 *     `tool_calls` array
 *   - `tool_result` entries each emitted as a standalone `role: "tool"`
 *     message (no batching needed — OpenAI accepts consecutive tool messages)
 *
 *  Consecutive `user` messages are coalesced (joined with \n\n) since OpenAI
 *  expects user/assistant alternation in most contexts.
 */
export function convertOpenAIMessages(
  messages: Message[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i]!;

    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content });
      i++;
      continue;
    }

    if (msg.role === "assistant") {
      const text = msg.content;
      const toolCalls: OpenAI.Chat.ChatCompletionMessageFunctionToolCall[] = [];
      i++;
      while (i < messages.length && messages[i]!.role === "tool_use") {
        const tu = messages[i]!;
        const parsed = safeParseToolCall(tu.content);
        if (parsed && tu.toolCallId) {
          toolCalls.push({
            id: tu.toolCallId,
            type: "function",
            function: {
              name: parsed.name,
              arguments: JSON.stringify(parsed.arguments),
            },
          });
        } else {
          // Malformed history is a kernel-side bug or storage corruption.
          // Drop the entry rather than fail the turn, but emit a warning so
          // operators can grep for `[Auggy:openai]` and trace the cause.
          warnDroppedToolUse(tu, parsed);
        }
        i++;
      }
      const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: text || null,
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      // OpenAI rejects assistant messages that have neither content nor tool_calls.
      if (assistantMsg.content || assistantMsg.tool_calls) {
        result.push(assistantMsg);
      }
      continue;
    }

    if (msg.role === "tool_use") {
      // Orphaned tool_use (no preceding assistant text). Emit as a standalone
      // assistant message with only the tool call.
      const parsed = safeParseToolCall(msg.content);
      if (parsed && msg.toolCallId) {
        result.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: msg.toolCallId,
              type: "function",
              function: {
                name: parsed.name,
                arguments: JSON.stringify(parsed.arguments),
              },
            },
          ],
        });
      } else {
        warnDroppedToolUse(msg, parsed);
      }
      i++;
      continue;
    }

    if (msg.role === "tool_result") {
      if (msg.toolCallId) {
        result.push({
          role: "tool",
          tool_call_id: msg.toolCallId,
          content: msg.content,
        });
      }
      i++;
      continue;
    }

    // Unknown role — skip defensively.
    i++;
  }

  return coalesceConsecutiveUsers(result);
}

/** Surface dropped tool_use entries to operators. The kernel writes these
 *  payloads itself, so a malformed entry indicates a kernel bug or storage
 *  corruption — silent drops would let the agent re-call tools without
 *  knowing. We log instead of throwing because failing the entire turn
 *  over one bad history entry is too aggressive. */
function warnDroppedToolUse(
  m: Message,
  parsed: { name: string; arguments: Record<string, unknown> } | null,
): void {
  const reason = parsed === null ? "parse failed" : "missing toolCallId";
  const preview = m.content.slice(0, 80);
  // eslint-disable-next-line no-console
  console.warn(
    `[Auggy:openai] dropping malformed tool_use msg=${m.id} reason=${reason} content=${JSON.stringify(preview)}`,
  );
}

function coalesceConsecutiveUsers(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (messages.length <= 1) return messages;
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [messages[0]!];
  for (let i = 1; i < messages.length; i++) {
    const prev = out[out.length - 1]!;
    const curr = messages[i]!;
    if (prev.role === "user" && curr.role === "user") {
      const prevContent = typeof prev.content === "string" ? prev.content : "";
      const currContent = typeof curr.content === "string" ? curr.content : "";
      (prev as OpenAI.Chat.ChatCompletionUserMessageParam).content =
        `${prevContent}\n\n${currContent}`;
    } else {
      out.push(curr);
    }
  }
  return out;
}

/** Convert Auggy ToolDefinitions to OpenAI Chat Completions tool format.
 *  Schema normalization strips JSON Schema metadata keys (`$schema`, `$id`)
 *  that the API ignores or rejects. */
export function convertOpenAITools(toolDefs: ToolDefinition[]): OpenAI.Chat.ChatCompletionTool[] {
  return toolDefs.map((td) => ({
    type: "function",
    function: {
      name: td.name,
      description: td.description,
      parameters: normalizeSchema(td.inputSchema),
    },
  }));
}

// ===========================================================================
// OpenAI response → ModelResponse translation
// ===========================================================================

/** Strictly parses a bounded tool argument object from the SDK string form. */
export function safeParseJson(
  s: string,
  configured?: Partial<ModelResponseLimits>,
): Record<string, unknown> {
  const limits = resolveModelResponseLimits(configured);
  if (typeof s !== "string") {
    throw new ModelResponseLimitError("maxToolArgumentBytes");
  }
  if (utf8ByteLength(s, limits.maxToolArgumentBytes) > limits.maxToolArgumentBytes) {
    throw new ModelResponseLimitError("maxToolArgumentBytes");
  }
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      measureJsonValue(parsed, {
        maxBytes: limits.maxToolArgumentBytes,
        maxDepth: limits.maxArgumentDepth,
        maxNodes: limits.maxArgumentNodes,
      });
      return parsed as Record<string, unknown>;
    }
  } catch {
    throw new ModelResponseLimitError("maxToolArgumentBytes");
  }
  throw new ModelResponseLimitError("maxToolArgumentBytes");
}

function isProviderRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const INVALID_USAGE_REASON = "Provider returned invalid accounting metadata.";

export interface ParsedOpenAIUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  valid: boolean;
}

function isUsageToken(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Parse OpenAI-compatible usage without converting absent or malformed
 * counters into a priced zero-token inference.
 */
export function parseOpenAIUsage(value: unknown): ParsedOpenAIUsage {
  if (!isProviderRecord(value)) {
    return { inputTokens: 0, outputTokens: 0, valid: false };
  }
  const promptTokens = value.prompt_tokens;
  const completionTokens = value.completion_tokens;
  const reasoningTokens = value.reasoning_tokens;
  if (
    !isUsageToken(promptTokens) ||
    !isUsageToken(completionTokens) ||
    (reasoningTokens !== undefined && !isUsageToken(reasoningTokens))
  ) {
    return { inputTokens: 0, outputTokens: 0, valid: false };
  }
  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    valid: true,
  };
}

export function buildOpenAIModelResponse(
  completion: OpenAI.Chat.ChatCompletion,
  modelLabel: string = "openai",
  configured?: Partial<ModelResponseLimits>,
): ModelResponse {
  const limits = resolveModelResponseLimits(configured);
  const rawCompletion = completion as unknown;
  if (!isProviderRecord(rawCompletion) || !Array.isArray(rawCompletion.choices)) {
    throw new ModelResponseLimitError("maxResponseBytes");
  }
  const choice = rawCompletion.choices[0];
  if (!choice) {
    // Empty choices array — rare API edge case (typically a content policy
    // rejection that was caught before generation). We throw rather than
    // return an empty response because a silent empty turn means the agent
    // sends nothing back to the user with no explanation. The thrown error
    // wraps up through the kernel's transport layer.
    throw new ModelResponseLimitError(
      "maxResponseBytes",
      `OpenAI engine (${modelLabel}) returned no choices in completion. ` +
        `Likely a content-policy rejection — inspect the prompt for blocked content.`,
    );
  }
  if (!isProviderRecord(choice) || !isProviderRecord(choice.message)) {
    throw new ModelResponseLimitError("maxResponseBytes");
  }

  const message = choice.message;
  if (message.content !== null && message.content !== undefined && typeof message.content !== "string") {
    throw new ModelResponseLimitError("maxTextBytes");
  }
  const content = message.content ?? "";
  const rawToolCalls = message.tool_calls ?? [];
  if (!Array.isArray(rawToolCalls)) {
    throw new ModelResponseLimitError("maxToolCalls");
  }
  if (rawToolCalls.length > limits.maxToolCalls) {
    throw new ModelResponseLimitError("maxToolCalls");
  }
  const toolCalls = rawToolCalls
    .map((tc) => {
      // OpenAI v6 may return either function or custom tool calls. Auggy
      // only emits function tools, so non-function results are dropped.
      if (!isProviderRecord(tc)) {
        throw new ModelResponseLimitError("maxToolArgumentBytes");
      }
      if (tc.type === "function") {
        if (
          !isProviderRecord(tc.function) ||
          typeof tc.function.name !== "string" ||
          typeof tc.function.arguments !== "string"
        ) {
          throw new ModelResponseLimitError("maxToolArgumentBytes");
        }
        return {
          name: tc.function.name,
          arguments: safeParseJson(tc.function.arguments, limits),
        };
      }
      return null;
    })
    .filter((x): x is { name: string; arguments: Record<string, unknown> } => x !== null);

  const finishReasonValue = choice.finish_reason;
  if (
    typeof finishReasonValue !== "string" ||
    !["stop", "tool_calls", "function_call", "length", "content_filter"].includes(
      finishReasonValue,
    )
  ) {
    throw new ModelResponseLimitError("maxResponseBytes");
  }
  const finishReason: ModelResponse["finishReason"] =
    finishReasonValue === "tool_calls" || finishReasonValue === "function_call"
      ? "tool_use"
      : finishReasonValue === "length"
        ? "max_tokens"
        : "end_turn";

  const usage = parseOpenAIUsage(rawCompletion.usage);
  return validateModelResponse({
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    finishReason,
  }, limits);
}
