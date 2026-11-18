import type OpenAI from "openai";
import type {
  AssembledPrompt,
  Message,
  ModelResponse,
  ModelResponseLimits,
  ModelToolExchange,
} from "auggy";
import { assembleSystemBlocks } from "auggy/internal/prompt-assembly";
import { priceResponsesUsage } from "auggy/internal/openai-pricing";
import { normalizeSchema } from "auggy/internal/schema-normalize";
import { safeParseToolCall } from "auggy/internal/tool-call";
import { createToolReplay } from "auggy/internal/tool-replay";
import {
  findModelResponseLimitError,
  ModelResponseLimitError,
  normalizeModelResponseAccounting,
  validateModelResponse,
} from "auggy/internal/response-limits";
import { providerRequestError } from "auggy/internal/provider-error";
import type { OpenAIEngineOptions } from "./index";
import { safeParseJson } from "./tool-arguments";

type Item = OpenAI.Responses.ResponseInputItem;

function historyItems(history: Message[]): Item[] {
  return history.flatMap((m): Item[] => {
    if (m.role === "assistant" || m.role === "user") return [{ role: m.role, content: m.content }];
    if (!m.toolCallId) return [];
    if (m.role === "tool_result")
      return [{ type: "function_call_output", call_id: m.toolCallId, output: m.content }];
    const call = safeParseToolCall(m.content);
    return call
      ? [
          {
            type: "function_call",
            call_id: m.toolCallId,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        ]
      : [];
  });
}

export function createResponsesCompletion(
  client: OpenAI,
  opts: OpenAIEngineOptions,
  limits: ModelResponseLimits,
) {
  const replay = createToolReplay<Item>();
  if (opts.reasoningEffort === "none" || opts.reasoningEffort === "minimal") {
    throw new Error("GPT-6.2 requires reasoningEffort of low or higher.");
  }
  return async (
    prompt: AssembledPrompt,
    exchange: ModelToolExchange | undefined,
    signal: AbortSignal,
  ): Promise<ModelResponse> => {
    const system = assembleSystemBlocks(prompt);
    const input = replay.messages(prompt.messages, system, exchange, historyItems, (outputs) =>
      outputs.map(({ id, content }) => ({
        type: "function_call_output",
        call_id: id,
        output: content,
      })),
    );
    const choice = prompt.toolChoice;
    const tools = prompt.tools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: normalizeSchema(t.inputSchema),
      strict: false,
    }));
    let response: OpenAI.Responses.Response;
    try {
      response = await client.responses.create(
        {
          model: opts.model,
          input: system ? [{ role: "developer", content: system }, ...input] : input,
          store: false,
          include: ["reasoning.encrypted_content"],
          service_tier: "default",
          prompt_cache_options: { ttl: "30m" },
          max_output_tokens: opts.maxTokens ?? 4096,
          ...(opts.reasoningEffort ? { reasoning: { effort: opts.reasoningEffort } } : {}),
          ...(tools.length
            ? {
                tools,
                tool_choice:
                  choice === "any"
                    ? "required"
                    : typeof choice === "object"
                      ? { type: "function", name: choice.name }
                      : "auto",
              }
            : {}),
        },
        { signal },
      );
    } catch (error) {
      const limit = findModelResponseLimitError(error);
      if (limit) throw limit;
      if (signal.aborted) throw signal.reason;
      throw providerRequestError("OpenAI", opts.model, error);
    }
    const usage = response?.usage;
    const price = priceResponsesUsage(opts.model, opts.costOverride, response?.service_tier, usage);
    const accounting = normalizeModelResponseAccounting({
      inputTokens: usage?.input_tokens ?? Number.NaN,
      outputTokens: usage?.output_tokens ?? Number.NaN,
      cacheReadTokens: usage?.input_tokens_details?.cached_tokens,
      cacheCreationTokens: usage?.input_tokens_details?.cache_write_tokens,
      ...(price.priced ? { costUsd: price.costUsd } : { unpricedReason: price.reason }),
    });
    try {
      if (
        !Array.isArray(response?.output) ||
        (response.status !== "completed" && response.status !== "incomplete")
      ) {
        throw new ModelResponseLimitError("maxResponseBytes");
      }
      const calls: NonNullable<ModelResponse["toolCalls"]> = [];
      const ids: string[] = [];
      const native: Item[] = [];
      let content = "";
      let refused = false;
      for (const item of response.output) {
        if (item?.type === "message") {
          if (item.role !== "assistant" || !Array.isArray(item.content))
            throw new ModelResponseLimitError("maxResponseBytes");
          for (const part of item.content) {
            const text =
              part?.type === "output_text"
                ? part.text
                : part?.type === "refusal"
                  ? part.refusal
                  : undefined;
            if (typeof text !== "string") throw new ModelResponseLimitError("maxTextBytes");
            content += text;
            if (part.type === "refusal") refused = true;
          }
        } else if (item?.type === "function_call") {
          // Truncated arguments must never reach a tool.
          if (response.status === "incomplete") continue;
          if (item.status != null && item.status !== "completed")
            throw new ModelResponseLimitError("maxResponseBytes");
          if (calls.length >= limits.maxToolCalls)
            throw new ModelResponseLimitError("maxToolCalls");
          ids.push(item.call_id);
          calls.push({ name: item.name, arguments: safeParseJson(item.arguments, limits) });
        } else if (item?.type !== "reasoning") {
          throw new ModelResponseLimitError("maxResponseBytes");
        }
        native.push(item);
      }
      if (
        calls.length &&
        (refused ||
          native.some(
            (item) =>
              "type" in item &&
              item.type === "reasoning" &&
              (typeof item.encrypted_content !== "string" || !item.encrypted_content),
          ))
      ) {
        throw new ModelResponseLimitError("maxResponseBytes");
      }
      const result = validateModelResponse(
        {
          ...accounting,
          content,
          ...(calls.length ? { toolCalls: calls } : {}),
          finishReason:
            response.status === "incomplete"
              ? "max_tokens"
              : calls.length
                ? "tool_use"
                : "end_turn",
        },
        limits,
      );
      if (calls.length)
        replay.remember(result, prompt.messages, system, [...input, ...native], ids);
      return result;
    } catch (error) {
      if (error instanceof ModelResponseLimitError) throw error.withAccounting(accounting);
      throw error;
    }
  };
}
