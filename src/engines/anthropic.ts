import Anthropic from "@anthropic-ai/sdk";
import { lookupPricing, computeCostUsd } from "./_shared/pricing";
import type {
  AssembledPrompt,
  Message,
  ModelClient,
  ModelDelta,
  ModelResponse,
  ToolDefinition,
} from "../types";

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
   */
  costOverride?: {
    inputUsdPerMtok: number;
    outputUsdPerMtok: number;
  };
}

export function createAnthropicEngine(
  opts: AnthropicEngineOptions,
): ModelClient {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
  });

  const maxContextTokens = opts.maxContextTokens ?? 200_000;
  const maxOutputTokens = opts.maxTokens ?? 4096;

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
      const system = assembleSystemText(prompt);
      const messages = convertMessages(prompt.messages);
      const tools = convertTools(prompt.tools);
      const toolChoice = prompt.toolChoice === "any"
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

      const withCost = (r: ModelResponse): ModelResponse => {
        const rates = opts.costOverride ?? lookupPricing("anthropic", opts.model);
        const costUsd = rates
          ? computeCostUsd(rates, { inputTokens: r.inputTokens, outputTokens: r.outputTokens })
          : undefined;
        return { ...r, costUsd };
      };

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
        return withCost(buildModelResponse(finalMessage));
      }

      // Non-streaming path (backward compat for tests, other consumers)
      const response = await client.messages.create(params);
      return withCost(buildModelResponse(response));
    },
  };
}

// === AssembledPrompt → Anthropic request translation ===

function assembleSystemText(prompt: AssembledPrompt): string {
  const parts: string[] = [];

  if (prompt.systemBlocks.length > 0) {
    parts.push(prompt.systemBlocks.join("\n\n"));
  }

  // contextBlocks are preamble-placement blocks — content that should
  // appear before the user message. Anthropic has no "between system
  // and user" slot, so these fold into system.
  if (prompt.contextBlocks.length > 0) {
    parts.push(prompt.contextBlocks.join("\n\n"));
  }

  // assistantPreamble is typically used for personality reinforcement.
  // v1 puts it in system too rather than using Anthropic's assistant
  // prefill (which would force the model to continue from that text
  // instead of treating it as background).
  if (prompt.assistantPreamble && prompt.assistantPreamble.length > 0) {
    parts.push(prompt.assistantPreamble.join("\n\n"));
  }

  return parts.join("\n\n");
}

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
      (prev as { content: ContentBlockParam[] }).content = [
        ...prevBlocks,
        ...currBlocks,
      ];
    } else {
      coalesced.push(curr);
    }
  }

  return coalesced;
}

function toContentBlocks(
  content: string | ContentBlockParam[],
): ContentBlockParam[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content;
}

function safeParseToolCall(
  content: string,
):
  | { name: string; arguments: Record<string, unknown> }
  | null {
  try {
    const parsed = JSON.parse(content) as {
      name?: unknown;
      arguments?: unknown;
    };
    if (
      parsed &&
      typeof parsed.name === "string" &&
      parsed.arguments &&
      typeof parsed.arguments === "object"
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

type AnthropicTool = Anthropic.Messages.Tool;
type AnthropicInputSchema = Anthropic.Messages.Tool.InputSchema;

function convertTools(toolDefs: ToolDefinition[]): AnthropicTool[] {
  return toolDefs.map((td) => ({
    name: td.name,
    description: td.description,
    input_schema: normalizeSchema(td.inputSchema),
  }));
}

// JSON Schema keys Anthropic's API accepts for tool input schemas.
const ALLOWED_SCHEMA_KEYS = new Set([
  "properties",
  "required",
  "description",
  "enum",
  "items",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "pattern",
  "format",
  "default",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "additionalProperties",
]);

function normalizeSchema(
  schema: Record<string, unknown> | undefined,
): AnthropicInputSchema {
  if (!schema || Object.keys(schema).length === 0) {
    return { type: "object", properties: {} };
  }
  // Filter to known JSON Schema keys — strip $schema, $id, and other
  // keys that Anthropic may reject or silently ignore.
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key !== "type" && ALLOWED_SCHEMA_KEYS.has(key)) {
      filtered[key] = value;
    }
  }
  return { type: "object", ...filtered } as AnthropicInputSchema;
}

// === Anthropic response → ModelResponse translation ===

function buildModelResponse(
  response: Anthropic.Messages.Message,
): ModelResponse {
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

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    finishReason,
  };
}
