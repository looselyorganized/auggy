import OpenAI from "openai";
import {
  assembleOpenAISystemMessage,
  buildOpenAIModelResponse,
  convertOpenAIMessages,
  convertOpenAITools,
} from "./openai";
import { lookupPricing, computeCostUsd } from "./_shared/pricing";
import type {
  AssembledPrompt,
  ModelClient,
  ModelDelta,
  ModelResponse,
} from "../types";

/**
 * OpenRouter engine — wraps the official `openai` SDK with the OpenRouter
 * baseURL and OpenRouter-specific extras (`reasoning` wrapper, `provider`
 * routing). The wire format is OpenAI Chat Completions, so message and tool
 * conversion are imported directly from the OpenAI engine.
 *
 * The TS SDK has no named `extra_body` parameter (the Python SDK does); extra
 * body fields are passed by spreading them into the `create()` params with a
 * type cast — the SDK forwards unknown fields at runtime.
 */
export interface OpenRouterEngineOptions {
  /** API key. Falls back to `process.env.OPENROUTER_API_KEY` if omitted.
   *  If neither is set, the factory THROWS — passing `apiKey: undefined`
   *  to the SDK would silently fall through to `OPENAI_API_KEY` and use the
   *  wrong credential against OpenRouter's endpoint. */
  apiKey?: string;
  /** OpenRouter model slug (e.g. "qwen/qwen3.5-397b-a17b", "openai/gpt-5"). */
  model: string;
  /** Total context window in tokens. Defaults to 128_000 (conservative).
   *  OpenRouter model context windows vary widely — set this per model.
   *  Too high and the kernel may build prompts the upstream provider
   *  cannot accept; too low and you waste budget. */
  maxContextTokens?: number;
  /** Per-turn output cap, sent as `max_completion_tokens`. Defaults to 4096. */
  maxTokens?: number;
  /** Reasoning effort for reasoning-capable models (Qwen3.5 thinking,
   *  o-series via OpenRouter, etc). Forwarded as `reasoning.effort` in the
   *  OpenRouter-normalized request body. See OpenAIEngineOptions for the
   *  semantics of each value. */
  reasoningEffort?: OpenAI.Chat.ChatCompletionReasoningEffort;
  /** OpenRouter provider routing hints. Forwarded as the `provider` body
   *  field. Slugs in `only`/`ignore` are NOT semantically validated — typos
   *  silently fall back to OpenRouter's default routing. */
  providerRouting?: OpenRouterProviderRouting;
}

/** OpenRouter provider routing config (forwarded as the `provider` body field).
 *  Mirrors `ProviderRouting` in `src/cli/types.ts` but lives here so the
 *  engine module is self-contained for the public API. */
export interface OpenRouterProviderRouting {
  /** Allowlist of provider slugs (e.g. ["OpenAI", "Anthropic"]). */
  only?: string[];
  /** Denylist of provider slugs. */
  ignore?: string[];
  /** Sort upstream providers by this attribute. */
  sort?: "price" | "throughput" | "latency";
  /** Cap upstream prices in USD per million tokens. */
  max_price?: { prompt?: number; completion?: number };
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Resolve pricing for an OpenRouter model slug.
 *
 * OpenRouter slugs are "<provider>/<model>" (e.g. "anthropic/claude-sonnet-4-6").
 * We parse the prefix and delegate to the underlying provider's pricing table.
 * Slugs with no slash, or an unrecognised provider prefix, fall back to the
 * openrouter table (currently empty — returns null → costUsd undefined).
 */
function lookupOpenRouterPricing(model: string) {
  const slashIdx = model.indexOf("/");
  if (slashIdx === -1) return lookupPricing("openrouter", model);
  const provider = model.slice(0, slashIdx);
  const tail = model.slice(slashIdx + 1);
  if (provider === "anthropic") return lookupPricing("anthropic", tail);
  if (provider === "openai") return lookupPricing("openai", tail);
  return lookupPricing("openrouter", model);
}

/** Local extension of the SDK request type with OpenRouter-specific extras.
 *  These fields don't exist in the SDK's typed surface — OpenRouter's
 *  server reads them when present and the SDK forwards them unchanged. */
type OpenRouterChatParams =
  OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & {
    reasoning?: { effort: OpenAI.Chat.ChatCompletionReasoningEffort };
    provider?: OpenRouterProviderRouting;
  };

export function createOpenRouterEngine(
  opts: OpenRouterEngineOptions,
): ModelClient {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set (or pass apiKey explicitly to createOpenRouterEngine)",
    );
  }

  const client = new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: { "X-Title": "Auggy" },
  });

  const maxContextTokens = opts.maxContextTokens ?? 128_000;
  const maxOutputTokens = opts.maxTokens ?? 4096;

  return {
    maxContextTokens,

    countTokens(text: string): number {
      return Math.ceil(text.length / 4);
    },

    async complete(prompt: AssembledPrompt, _opts?: { onDelta?: (delta: ModelDelta) => void }): Promise<ModelResponse> {
      const systemMessage = assembleOpenAISystemMessage(prompt);
      const messages = convertOpenAIMessages(prompt.messages);
      const tools = convertOpenAITools(prompt.tools);

      const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] =
        systemMessage ? [systemMessage, ...messages] : messages;

      // The TS SDK has no extra_body field; OpenRouter-specific keys
      // (`reasoning`, `provider`) go directly on the params object via a
      // typed extension and are forwarded at runtime. The cast at the
      // boundary is the only place we loosen the SDK's typed contract.
      const params: OpenRouterChatParams = {
        model: opts.model,
        max_completion_tokens: maxOutputTokens,
        messages: allMessages,
        ...(tools.length > 0 ? { tools } : {}),
        ...(opts.reasoningEffort
          ? { reasoning: { effort: opts.reasoningEffort } }
          : {}),
        ...(opts.providerRouting ? { provider: opts.providerRouting } : {}),
      };

      let completion: OpenAI.Chat.ChatCompletion;
      try {
        completion = await client.chat.completions.create(
          params as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        );
      } catch (err) {
        // Wrap with provider+model context. Without this, an OpenRouter
        // upstream error (e.g. provider 502) reads identically to an
        // OpenAI direct-call error in logs.
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `OpenRouter engine (${opts.model}) failed: ${msg}`,
          { cause: err },
        );
      }
      const response = buildOpenAIModelResponse(completion, `openrouter:${opts.model}`);
      const rates = lookupOpenRouterPricing(opts.model);
      const costUsd = rates
        ? computeCostUsd(rates, { inputTokens: response.inputTokens, outputTokens: response.outputTokens })
        : undefined;
      return { ...response, costUsd };
    },
  };
}
