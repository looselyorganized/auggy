import Anthropic from "@anthropic-ai/sdk";
import type {
  AssembledPrompt,
  Message,
  ModelClient,
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

    async complete(prompt: AssembledPrompt): Promise<ModelResponse> {
      const system = assembleSystemText(prompt);
      const messages = convertMessages(prompt.messages);
      const tools = convertTools(prompt.tools);

      const response = await client.messages.create({
        model: opts.model,
        max_tokens: maxOutputTokens,
        system,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
      });

      return buildModelResponse(response);
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

  return result;
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

function normalizeSchema(
  schema: Record<string, unknown> | undefined,
): AnthropicInputSchema {
  // Anthropic requires a JSON Schema object literally typed as "object".
  // Auggy's ToolDefinition allows an empty record (for tools with no
  // params); we fill in the minimum shape here so the API doesn't reject it.
  if (!schema || Object.keys(schema).length === 0) {
    return { type: "object", properties: {} };
  }
  const { type: _type, ...rest } = schema;
  return { type: "object", ...rest } as AnthropicInputSchema;
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
      toolCalls.push({
        name: block.name,
        arguments: block.input as Record<string, unknown>,
      });
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
