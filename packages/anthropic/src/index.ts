import Anthropic from "@anthropic-ai/sdk";
import { lookup, getFreshness, priceAnthropicResponse } from "auggy/internal/anthropic-pricing";
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
 * Anthropic engine — a ModelClient adapter that drives the agent's reasoning
 * via Anthropic's Messages API.
 *
 * Responsibilities:
 *  - Translate AssembledPrompt into the Messages API request shape
 *    (system text, conversation messages, tools)
 *  - Run the API call
 *  - Translate the response back into ModelResponse
 *
 * This engine is stateless beyond the underlying HTTP client. Retries,
 * timeouts, and rate limit handling live in the SDK; everything above
 * (queue, history, context budgeting) is the kernel's job.
 *
 * Token counting uses a character/4 approximation rather than Anthropic's
 * async token-counting endpoint, because Auggy's ModelClient interface
 * wants a synchronous countTokens and the accuracy gain isn't worth the
 * extra round trip on every budget computation.
 */
export interface AnthropicEngineOptions {
  /** API key. Defaults to the ANTHROPIC_API_KEY environment variable. */
  apiKey?: string;
  /** Model ID (e.g. "claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5-20251001"). */
  model: string;
  /** Total context window in tokens for this model. Defaults to 200_000. */
  maxContextTokens?: number;
  /** Per-turn output cap. Defaults to 4096. */
  maxTokens?: number;
  /** Optional base URL override (for proxying or compatible providers). */
  baseURL?: string;
  /**
   * Override pricing for cost estimation. If set, the adapter uses these rates
   * instead of the built-in pricing table. Useful for unknown models or custom
   * pricing arrangements. USD per million tokens.
   *
   * Accepts the full Pricing shape (input + output + optional cache write/read).
   * Legacy 2-field overrides still typecheck — cache rates are optional and
   * default to undefined (no cache cost contribution). Anthropic operators with
   * cache-heavy workloads should set both `cacheWriteUsdPerMtok` and
   * `cacheReadUsdPerMtok` to avoid under-reporting cached responses.
   */
  costOverride?: import("auggy/internal/cost").Pricing;
}

export function createAnthropicEngine(opts: AnthropicEngineOptions): ModelClient {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
  });

  const maxContextTokens = opts.maxContextTokens ?? 200_000;
  const maxOutputTokens = opts.maxTokens ?? 4096;

  // Pricing freshness + availability warning at startup. Cost estimation
  // is advisory; this surfaces gaps so the operator isn't surprised when
  // budgets enforce against fabricated zeros. Fires once at factory time,
  // not per-turn.
  if (!opts.costOverride) {
    const rates = lookup(opts.model);
    if (!rates) {
      // eslint-disable-next-line no-console
      console.warn(
        `[engines/anthropic] No pricing entry for model "${opts.model}" and no costOverride configured. ` +
          `costUsd will be undefined; dailyBudgetUsd cannot enforce against this model. ` +
          `Add the model to src/engines/anthropic/pricing.ts or configure engine.costOverride in agent.yaml.`,
      );
    } else {
      const f = getFreshness();
      if (f.stale) {
        // eslint-disable-next-line no-console
        console.warn(
          `[engines/anthropic] Pricing table verifiedAt ${f.verifiedAt} is more than 90 days old. ` +
            `Cost estimates may be drifting from actual billing. Verify rates and update src/engines/anthropic/pricing.ts.`,
        );
      }
    }
  }

  return {
    maxContextTokens,

    countTokens(text: string): number {
      // Rough approximation matching Auggy's default tokenizer. Anthropic
      // does expose an async countTokens endpoint, but the ModelClient
      // interface is sync and an extra round trip per budget computation
      // is not worth the accuracy.
      return Math.ceil(text.length / 4);
    },

    async complete(
      prompt: AssembledPrompt,
      opts2?: { onDelta?: (delta: ModelDelta) => void },
    ): Promise<ModelResponse> {
      const system = assembleSystemBlocks(prompt);
      const messages = convertMessages(prompt.messages);
      const tools = convertTools(prompt.tools);
      const toolChoice =
        prompt.toolChoice === "any"
          ? { type: "any" as const }
          : prompt.toolChoice === "auto" || !prompt.toolChoice
            ? { type: "auto" as const }
            : { type: "tool" as const, name: prompt.toolChoice.name };

      const params = {
        model: opts.model,
        max_tokens: maxOutputTokens,
        system,
        messages,
        ...(tools.length > 0 ? { tools, tool_choice: toolChoice } : {}),
      };

      const withCost = (r: ModelResponse, rawUsage: Anthropic.Messages.Usage): ModelResponse => {
        const result = priceAnthropicResponse(opts.model, opts.costOverride, {
          input_tokens: rawUsage.input_tokens,
          output_tokens: rawUsage.output_tokens,
          cache_creation_input_tokens: rawUsage.cache_creation_input_tokens ?? null,
          cache_read_input_tokens: rawUsage.cache_read_input_tokens ?? null,
          // cache_creation (TTL breakdown) and service_tier are new fields not yet
          // in the Anthropic SDK type; cast defensively via unknown.
          cache_creation: (rawUsage as unknown as Record<string, unknown>).cache_creation as
            | { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
            | null
            | undefined,
          service_tier: (rawUsage as unknown as Record<string, unknown>).service_tier as
            | string
            | null
            | undefined,
        });
        return result.priced
          ? { ...r, costUsd: result.costUsd }
          : { ...r, costUsd: undefined, unpricedReason: result.reason };
      };

      try {
        if (opts2?.onDelta) {
          // Streaming path: emit text deltas as they arrive from the model.
          // Tool-use blocks are NOT streamed in v1 — they arrive in the
          // finalMessage. This is intentional: text streaming is the latency
          // win; tool args are small.
          const stream = client.messages.stream(params);
          stream.on("text", (text) => {
            opts2.onDelta!({ kind: "text_delta", text });
          });
          const finalMessage = await stream.finalMessage();
          return withCost(buildModelResponse(finalMessage), finalMessage.usage);
        }

        // Non-streaming path (backward compat for tests, other consumers)
        const response = await client.messages.create(params);
        return withCost(buildModelResponse(response), response.usage);
      } catch (err) {
        rewrapCostCapError(err);
      }
    },
  };
}

/**
 * Anthropic SDK errors that indicate the operator's provider-side spend cap
 * has been reached get rewrapped with a clear, operator-actionable message.
 * Other errors are re-thrown unchanged.
 *
 * Per ADR-024, provider-side spend caps are the v1.0 hard limit on agent
 * spend. When they fire, Anthropic returns a 402 (Payment Required) or a
 * 429 with cap-related text in the message body. We surface a concise
 * pointer to the console rather than the raw SDK error string, so an
 * operator who sees this in logs / `auggy dev` output knows exactly where
 * to go.
 *
 * Detected by structural shape (`status` field on the thrown object) rather
 * than `instanceof Anthropic.APIError` — keeps the helper testable without
 * coupling to the SDK's class hierarchy.
 */
function rewrapCostCapError(err: unknown): never {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status: unknown }).status;
    const message = String((err as { message?: unknown }).message ?? "");
    const lower = message.toLowerCase();

    const isCostCap =
      status === 402 ||
      (status === 429 && /credit|spend|billing|limit|quota|cap|exceed|plan/.test(lower));

    if (isCostCap) {
      throw new Error(
        `Anthropic provider spend cap reached (HTTP ${String(status)}). ` +
          `Increase the cap or wait for reset in your Anthropic console at ` +
          `https://console.anthropic.com/settings/limits. ` +
          `(Original error: ${message})`,
      );
    }
  }
  throw err;
}

// === AssembledPrompt → Anthropic request translation ===
//
// System assembly: Anthropic has no "between system and user" slot, so
// contextBlocks fold into system. assistantPreamble likewise — v1 doesn't
// use Anthropic's assistant prefill, which would force the model to
// continue from that text instead of treating it as background. The
// concatenation logic lives in `auggy/internal/prompt-assembly` since
// it's identical across providers.

type MessageParam = Anthropic.Messages.MessageParam;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;

/**
 * Walk Auggy's flat message list and produce Anthropic's grouped format.
 * Auggy stores tool_use and tool_result as separate flat messages with
 * matching toolCallIds. Anthropic wants:
 *   - tool_use blocks folded into the preceding assistant message
 *   - tool_result blocks folded into a user-role message
 *
 * Consecutive tool_results collapse into a single user message so the
 * conversation alternates strictly between user and assistant roles.
 */
function convertMessages(messages: Message[]): MessageParam[] {
  const result: MessageParam[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i]!;

    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content });
      i++;
      continue;
    }

    if (msg.role === "assistant") {
      const blocks: ContentBlockParam[] = [];
      if (msg.content) {
        blocks.push({ type: "text", text: msg.content });
      }
      i++;
      // Gather any consecutive tool_use messages into the same assistant
      // turn. Auggy emits them back-to-back after a text response.
      while (i < messages.length && messages[i]!.role === "tool_use") {
        const tu = messages[i]!;
        const parsed = safeParseToolCall(tu.content);
        if (parsed && tu.toolCallId) {
          blocks.push({
            type: "tool_use",
            id: tu.toolCallId,
            name: parsed.name,
            input: parsed.arguments,
          });
        }
        i++;
      }
      if (blocks.length === 0) continue; // Anthropic rejects empty assistant
      result.push({ role: "assistant", content: blocks });
      continue;
    }

    if (msg.role === "tool_use") {
      // Orphaned tool_use with no preceding assistant text — wrap alone.
      const parsed = safeParseToolCall(msg.content);
      if (parsed && msg.toolCallId) {
        result.push({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: msg.toolCallId,
              name: parsed.name,
              input: parsed.arguments,
            },
          ],
        });
      }
      i++;
      continue;
    }

    if (msg.role === "tool_result") {
      const blocks: ContentBlockParam[] = [];
      while (i < messages.length && messages[i]!.role === "tool_result") {
        const tr = messages[i]!;
        if (tr.toolCallId) {
          blocks.push({
            type: "tool_result",
            tool_use_id: tr.toolCallId,
            content: tr.content,
          });
        }
        i++;
      }
      if (blocks.length > 0) {
        result.push({ role: "user", content: blocks });
      }
      continue;
    }

    // Unknown role — skip defensively.
    i++;
  }

  // Coalesce pass: Anthropic requires strict user/assistant alternation.
  // Consecutive same-role messages can appear when:
  //   - tool_result (mapped to user) is followed by the next turn's user message
  //   - Empty assistant content is skipped, producing adjacent user messages
  // Merge consecutive same-role messages by combining their content blocks.
  return coalesceMessages(result);
}

function coalesceMessages(messages: MessageParam[]): MessageParam[] {
  if (messages.length <= 1) return messages;

  const coalesced: MessageParam[] = [messages[0]!];

  for (let i = 1; i < messages.length; i++) {
    const prev = coalesced[coalesced.length - 1]!;
    const curr = messages[i]!;

    if (prev.role === curr.role) {
      // Merge: combine content into an array of content blocks
      const prevBlocks = toContentBlocks(prev.content);
      const currBlocks = toContentBlocks(curr.content);
      (prev as { content: ContentBlockParam[] }).content = [...prevBlocks, ...currBlocks];
    } else {
      coalesced.push(curr);
    }
  }

  return coalesced;
}

function toContentBlocks(content: string | ContentBlockParam[]): ContentBlockParam[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content;
}

type AnthropicTool = Anthropic.Messages.Tool;
type AnthropicInputSchema = Anthropic.Messages.Tool.InputSchema;

function convertTools(toolDefs: ToolDefinition[]): AnthropicTool[] {
  return toolDefs.map((td) => ({
    name: td.name,
    description: td.description,
    input_schema: normalizeSchema(td.inputSchema) as AnthropicInputSchema,
  }));
}

// === Anthropic response → ModelResponse translation ===

function buildModelResponse(response: Anthropic.Messages.Message): ModelResponse {
  let content = "";
  const toolCalls: {
    name: string;
    arguments: Record<string, unknown>;
  }[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      content += block.text;
    } else if (block.type === "tool_use") {
      // Validate input is a plain object — the model could hallucinate
      // a non-object value which would break downstream JSON.stringify
      const input = block.input;
      const args =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      toolCalls.push({ name: block.name, arguments: args });
    }
  }

  const finishReason: ModelResponse["finishReason"] =
    response.stop_reason === "tool_use"
      ? "tool_use"
      : response.stop_reason === "max_tokens"
        ? "max_tokens"
        : "end_turn";

  // Anthropic's SDK may return null or omit cache fields when caching isn't active.
  // Map nullish values to undefined so ModelResponse consumers can rely on undefined-checking.
  const cacheCreationTokens = response.usage.cache_creation_input_tokens ?? undefined;
  const cacheReadTokens = response.usage.cache_read_input_tokens ?? undefined;

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    finishReason,
  };
}
