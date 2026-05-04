import OpenAI from "openai";
import { normalizeSchema } from "./_shared/schema-normalize";
import { lookup, getFreshness, priceOpenAIResponse } from "./openai/pricing";
import type {
  AssembledPrompt,
  Message,
  ModelClient,
  ModelDelta,
  ModelResponse,
  ToolDefinition,
} from "../types";

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
  /** Reasoning effort for reasoning-capable models.
   *  - `none`: gpt-5.1 only
   *  - `minimal | low | medium | high`: universally supported on reasoning models
   *  - `xhigh`: gpt-5.1-codex-max and later
   *  Older Chat Completions models (e.g. gpt-4) do NOT support this — the API
   *  returns an error which propagates through `complete()`. */
  reasoningEffort?: OpenAI.Chat.ChatCompletionReasoningEffort;
  /**
   * Override pricing for cost estimation. If set, the adapter uses these rates
   * instead of the built-in pricing table. Useful for unknown models or custom
   * pricing arrangements. USD per million tokens.
   *
   * Accepts the full Pricing shape; cache fields are accepted for type symmetry
   * with Anthropic but not used by the OpenAI adapter today (no cache-token
   * usage is parsed from OpenAI Chat Completions responses).
   */
  costOverride?: import("./_shared/cost").Pricing;
}

export function createOpenAIEngine(opts: OpenAIEngineOptions): ModelClient {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
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
  } else if (
    opts.costOverride.cacheWriteUsdPerMtok !== undefined ||
    opts.costOverride.cacheReadUsdPerMtok !== undefined
  ) {
    // Operator set cache rates on OpenAI override. Today's adapter does not
    // parse cache tokens from OpenAI Chat Completions responses, so cache
    // rates would be silently ignored. Warn loudly rather than silently
    // under-report — operators provisioning these rates should know they
    // don't take effect.
    // eslint-disable-next-line no-console
    console.warn(
      `[engines/openai] costOverride.cacheWriteUsdPerMtok/cacheReadUsdPerMtok set but ignored — ` +
        `the OpenAI adapter does not parse cache tokens from upstream responses. Cache rates will not contribute to costUsd.`,
    );
  }

  return {
    maxContextTokens,

    countTokens(text: string): number {
      return Math.ceil(text.length / 4);
    },

    async complete(
      prompt: AssembledPrompt,
      _opts?: { onDelta?: (delta: ModelDelta) => void },
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
        ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
      };

      let completion: OpenAI.Chat.ChatCompletion;
      try {
        completion = await client.chat.completions.create(params);
      } catch (err) {
        // Wrap the SDK error so logs identify which engine + model failed,
        // not just "OpenAIError: 429". `cause` preserves the original SDK
        // error (including `.status`) for callers that introspect.
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`OpenAI engine (${opts.model}) failed: ${msg}`, {
          cause: err,
        });
      }
      const response = buildOpenAIModelResponse(completion, opts.model);
      const result = priceOpenAIResponse(opts.model, opts.costOverride, {
        prompt_tokens: completion.usage?.prompt_tokens ?? response.inputTokens,
        completion_tokens: completion.usage?.completion_tokens ?? response.outputTokens,
        reasoning_tokens: (completion.usage as Record<string, unknown> | null | undefined)
          ?.reasoning_tokens as number | undefined,
      });
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
 *  separate slot for context-block content, so it folds into system. */
export function assembleOpenAISystemMessage(
  prompt: AssembledPrompt,
): OpenAI.Chat.ChatCompletionSystemMessageParam | null {
  const parts: string[] = [];
  if (prompt.systemBlocks.length > 0) {
    parts.push(prompt.systemBlocks.join("\n\n"));
  }
  if (prompt.contextBlocks.length > 0) {
    parts.push(prompt.contextBlocks.join("\n\n"));
  }
  if (prompt.assistantPreamble && prompt.assistantPreamble.length > 0) {
    parts.push(prompt.assistantPreamble.join("\n\n"));
  }
  if (parts.length === 0) return null;
  return { role: "system", content: parts.join("\n\n") };
}

/** Parse the JSON-stringified tool-call payload that the kernel writes to
 *  `Message.content` for tool_use messages. The kernel writes
 *  `JSON.stringify({ name, arguments: object })` (see turn-loop.ts:518),
 *  so the recovered shape is `{ name: string, arguments: Record }`.
 *  Returns null defensively on malformed JSON. */
export function safeParseToolCall(
  content: string,
): { name: string; arguments: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(content) as {
      name?: unknown;
      arguments?: unknown;
    };
    if (
      parsed &&
      typeof parsed.name === "string" &&
      parsed.arguments &&
      typeof parsed.arguments === "object" &&
      !Array.isArray(parsed.arguments)
    ) {
      return {
        name: parsed.name,
        arguments: parsed.arguments as Record<string, unknown>,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

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

/** Defensive JSON.parse that returns `{}` on malformed input. Used to recover
 *  tool call argument objects from the SDK's string-form `function.arguments`. */
export function safeParseJson(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

export function buildOpenAIModelResponse(
  completion: OpenAI.Chat.ChatCompletion,
  modelLabel: string = "openai",
): ModelResponse {
  const choice = completion.choices[0];
  if (!choice) {
    // Empty choices array — rare API edge case (typically a content policy
    // rejection that was caught before generation). We throw rather than
    // return an empty response because a silent empty turn means the agent
    // sends nothing back to the user with no explanation. The thrown error
    // wraps up through the kernel's transport layer.
    throw new Error(
      `OpenAI engine (${modelLabel}) returned no choices in completion ` +
        `(usage=${JSON.stringify(completion.usage)}, id=${completion.id ?? "?"}). ` +
        `Likely a content-policy rejection — inspect the prompt for blocked content.`,
    );
  }

  const message = choice.message;
  const content = message.content ?? "";
  const toolCalls = (message.tool_calls ?? [])
    .map((tc) => {
      // OpenAI v6 may return either function or custom tool calls. Auggy
      // only emits function tools, so non-function results are dropped.
      if (tc.type === "function") {
        return {
          name: tc.function.name,
          arguments: safeParseJson(tc.function.arguments),
        };
      }
      return null;
    })
    .filter((x): x is { name: string; arguments: Record<string, unknown> } => x !== null);

  const finishReason: ModelResponse["finishReason"] =
    choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call"
      ? "tool_use"
      : choice.finish_reason === "length"
        ? "max_tokens"
        : "end_turn";

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    inputTokens: completion.usage?.prompt_tokens ?? 0,
    outputTokens: completion.usage?.completion_tokens ?? 0,
    finishReason,
  };
}
