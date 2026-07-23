import OpenAI from "openai";
import {
  assembleOpenAISystemMessage,
  buildOpenAIModelResponse,
  convertOpenAIMessages,
  convertOpenAITools,
  type ReasoningEffort,
} from "@auggy/openai";
import { resolveSlug, priceOpenRouterResponse } from "auggy/internal/openrouter-pricing";
import { warnCacheRatesIgnored } from "auggy/internal/cost";
import type { AssembledPrompt, ModelClient, ModelDelta, ModelResponse } from "auggy";

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
  reasoningEffort?: ReasoningEffort;
  /** OpenRouter provider routing hints. Forwarded as the `provider` body
   *  field. Restrictive slugs are checked against OpenRouter's authenticated
   *  provider directory immediately before every model request. */
  providerRouting?: OpenRouterProviderRouting;
  /**
   * Controlled-egress/test seam for the provider-directory request. The
   * response is still bounded and validated before it can authorize routing.
   */
  providerDirectoryFetch?: OpenRouterProviderDirectoryFetch;
  /**
   * Override pricing for cost estimation. If set, the adapter uses these rates
   * instead of the built-in pricing table. Useful for unknown models or custom
   * pricing arrangements. USD per million tokens.
   *
   * Accepts the full Pricing shape; cache fields are accepted for type symmetry
   * with Anthropic but not used by the OpenRouter adapter today (no cache-token
   * usage is parsed from OpenRouter responses).
   */
  costOverride?: import("auggy/internal/cost").Pricing;
}

export type OpenRouterProviderDirectoryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** OpenRouter provider routing config (forwarded as the `provider` body field).
 *  Mirrors `ProviderRouting` in `src/cli/types.ts` but lives here so the
 *  engine module is self-contained for the public API. */
export interface OpenRouterProviderRouting {
  /**
   * Allowlist of canonical base-provider slugs (e.g. ["openai", "anthropic"]).
   * Provider variants containing "/" are rejected until OpenRouter exposes an
   * authoritative variant catalog suitable for fail-closed validation.
   */
  only?: string[];
  /** Denylist of canonical base-provider slugs. */
  ignore?: string[];
  /** Sort upstream providers by this attribute. */
  sort?: "price" | "throughput" | "latency";
  /** Cap upstream prices in USD per million tokens. */
  max_price?: { prompt?: number; completion?: number };
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Local extension of the SDK request type with OpenRouter-specific extras.
 *  These fields don't exist in the SDK's typed surface — OpenRouter's
 *  server reads them when present and the SDK forwards them unchanged.
 *
 *  `reasoning.effort` uses the local `ReasoningEffort` union (wider than the
 *  SDK's type — includes `none` and `xhigh`); OpenRouter accepts the broader
 *  set on reasoning-capable models. */
type OpenRouterChatParams = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & {
  reasoning?: { effort: ReasoningEffort };
  provider?: OpenRouterProviderRouting & { allow_fallbacks?: false };
};

const PROVIDER_DIRECTORY_URL = `${OPENROUTER_BASE_URL}/providers`;
const PROVIDER_DIRECTORY_TIMEOUT_MS = 5_000;
const PROVIDER_DIRECTORY_MAX_BYTES = 256 * 1024;
const PROVIDER_DIRECTORY_MAX_ENTRIES = 512;
const PROVIDER_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROVIDER_ROUTING_KEYS = new Set(["only", "ignore", "sort", "max_price"]);

function validateSlugList(value: unknown, field: "only" | "ignore"): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error(
      `engine.providerRouting.${field}: must be an array containing 1 to 32 canonical provider slugs`,
    );
  }

  const seen = new Set<string>();
  const slugs: string[] = [];
  for (const valueSlug of value) {
    if (typeof valueSlug !== "string" || !PROVIDER_SLUG.test(valueSlug)) {
      throw new Error(
        `engine.providerRouting.${field}: provider slugs must be canonical lowercase base slugs`,
      );
    }
    if (seen.has(valueSlug)) {
      throw new Error(`engine.providerRouting.${field}: duplicate provider slug "${valueSlug}"`);
    }
    seen.add(valueSlug);
    slugs.push(valueSlug);
  }
  return slugs;
}

function validateProviderRouting(value: unknown): OpenRouterProviderRouting | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("engine.providerRouting: must be an object");
  }

  const routing = value as Record<string, unknown>;
  for (const key of Object.keys(routing)) {
    if (!PROVIDER_ROUTING_KEYS.has(key)) {
      throw new Error(`engine.providerRouting.${key}: unknown routing option`);
    }
  }

  const only = validateSlugList(routing.only, "only");
  const ignore = validateSlugList(routing.ignore, "ignore");
  if (only && ignore && only.some((slug) => ignore.includes(slug))) {
    throw new Error("engine.providerRouting: a provider cannot appear in both only and ignore");
  }
  if (
    routing.sort !== undefined &&
    !["price", "throughput", "latency"].includes(String(routing.sort))
  ) {
    throw new Error("engine.providerRouting.sort: must be price, throughput, or latency");
  }

  let maxPrice: OpenRouterProviderRouting["max_price"];
  if (routing.max_price !== undefined) {
    if (
      typeof routing.max_price !== "object" ||
      routing.max_price === null ||
      Array.isArray(routing.max_price)
    ) {
      throw new Error("engine.providerRouting.max_price: must be an object");
    }
    const price = routing.max_price as Record<string, unknown>;
    for (const key of Object.keys(price)) {
      if (key !== "prompt" && key !== "completion") {
        throw new Error(`engine.providerRouting.max_price.${key}: unknown price option`);
      }
    }
    for (const key of ["prompt", "completion"] as const) {
      const amount = price[key];
      if (
        amount !== undefined &&
        (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0)
      ) {
        throw new Error(`engine.providerRouting.max_price.${key}: must be a positive number`);
      }
    }
    maxPrice = price as OpenRouterProviderRouting["max_price"];
  }

  return {
    ...(only ? { only } : {}),
    ...(ignore ? { ignore } : {}),
    ...(routing.sort ? { sort: routing.sort as OpenRouterProviderRouting["sort"] } : {}),
    ...(maxPrice ? { max_price: maxPrice } : {}),
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > PROVIDER_DIRECTORY_MAX_BYTES)
  ) {
    throw new Error("invalid provider directory response");
  }
  if (!response.body) throw new Error("invalid provider directory response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > PROVIDER_DIRECTORY_MAX_BYTES) {
      await reader.cancel();
      throw new Error("invalid provider directory response");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function parseProviderDirectory(value: unknown): Set<string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid provider directory response");
  }
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length === 0 || data.length > PROVIDER_DIRECTORY_MAX_ENTRIES) {
    throw new Error("invalid provider directory response");
  }

  const slugs = new Set<string>();
  for (const item of data) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("invalid provider directory response");
    }
    const slug = (item as Record<string, unknown>).slug;
    if (typeof slug !== "string" || !PROVIDER_SLUG.test(slug) || slugs.has(slug)) {
      throw new Error("invalid provider directory response");
    }
    slugs.add(slug);
  }
  return slugs;
}

async function verifyRestrictiveRouting(
  routing: OpenRouterProviderRouting,
  apiKey: string,
  directoryFetch: OpenRouterProviderDirectoryFetch,
  callerSignal?: AbortSignal,
): Promise<void> {
  const configured = [...(routing.only ?? []), ...(routing.ignore ?? [])];
  if (configured.length === 0) return;

  const timeoutSignal = AbortSignal.timeout(PROVIDER_DIRECTORY_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  try {
    const response = await directoryFetch(PROVIDER_DIRECTORY_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      redirect: "error",
      signal,
    });
    if (!response.ok || response.redirected) {
      throw new Error("invalid provider directory response");
    }
    const available = parseProviderDirectory(await readBoundedJson(response));
    if (configured.some((slug) => !available.has(slug))) {
      throw new Error("unknown provider slug");
    }
  } catch {
    if (callerSignal?.aborted) {
      throw callerSignal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const policyName = routing.only ? "allowlist" : "routing policy";
    throw new Error(
      `OpenRouter provider ${policyName} could not be verified; no model request was sent`,
    );
  }
}

export function createOpenRouterEngine(opts: OpenRouterEngineOptions): ModelClient {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set (or pass apiKey explicitly to createOpenRouterEngine)",
    );
  }
  const providerRouting = validateProviderRouting(opts.providerRouting);
  const directoryFetch: OpenRouterProviderDirectoryFetch =
    opts.providerDirectoryFetch ?? globalThis.fetch.bind(globalThis);

  const client = new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: { "X-Title": "Auggy" },
  });

  const maxContextTokens = opts.maxContextTokens ?? 128_000;
  const maxOutputTokens = opts.maxTokens ?? 4096;

  // Pricing freshness + availability warning at startup. Fires once at
  // factory time, not per-turn.
  if (!opts.costOverride) {
    const resolved = resolveSlug(opts.model);
    if (!resolved) {
      // eslint-disable-next-line no-console
      console.warn(
        `[engines/openrouter] No pricing entry for slug "${opts.model}" and no costOverride configured. ` +
          `OpenRouter v0 cost estimation is limited to anthropic/* and openai/* slugs. ` +
          `For other providers, configure engine.costOverride in agent.yaml.`,
      );
    } else if (resolved.freshness.stale) {
      // Freshness binds to the resolved provider's verifiedAt, not OpenRouter's own table.
      // eslint-disable-next-line no-console
      console.warn(
        `[engines/openrouter] Pricing table verifiedAt ${resolved.freshness.verifiedAt} is more than 90 days old. ` +
          `Cost estimates may be drifting from actual billing. Verify rates and update src/engines/${resolved.resolvedProvider}/pricing.ts.`,
      );
    }
  } else {
    // Operator set a custom pricing override. Warn if they included cache
    // rates — the OpenRouter adapter doesn't parse cache tokens from
    // upstream responses, so those rates would be silently ignored.
    warnCacheRatesIgnored("openrouter", opts.costOverride);
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
      if (providerRouting) {
        await verifyRestrictiveRouting(
          providerRouting,
          apiKey,
          directoryFetch,
          requestOptions?.signal,
        );
      }
      const systemMessage = assembleOpenAISystemMessage(prompt);
      const messages = convertOpenAIMessages(prompt.messages);
      const tools = convertOpenAITools(prompt.tools);

      const allMessages: OpenAI.Chat.ChatCompletionMessageParam[] = systemMessage
        ? [systemMessage, ...messages]
        : messages;

      // The TS SDK has no extra_body field; OpenRouter-specific keys
      // (`reasoning`, `provider`) go directly on the params object via a
      // typed extension and are forwarded at runtime. The cast at the
      // boundary is the only place we loosen the SDK's typed contract.
      const params: OpenRouterChatParams = {
        model: opts.model,
        max_completion_tokens: maxOutputTokens,
        messages: allMessages,
        ...(tools.length > 0 ? { tools } : {}),
        ...(opts.reasoningEffort ? { reasoning: { effort: opts.reasoningEffort } } : {}),
        ...(providerRouting
          ? {
              provider: {
                ...providerRouting,
                ...(providerRouting.only ? { allow_fallbacks: false as const } : {}),
              },
            }
          : {}),
      };

      let completion: OpenAI.Chat.ChatCompletion;
      try {
        completion = await client.chat.completions.create(
          params as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
          { signal: requestOptions?.signal },
        );
      } catch (err) {
        // Wrap with provider+model context. Without this, an OpenRouter
        // upstream error (e.g. provider 502) reads identically to an
        // OpenAI direct-call error in logs.
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`OpenRouter engine (${opts.model}) failed: ${msg}`, { cause: err });
      }
      const response = buildOpenAIModelResponse(completion, `openrouter:${opts.model}`);
      const result = priceOpenRouterResponse(opts.model, opts.costOverride, {
        prompt_tokens: response.inputTokens,
        completion_tokens: response.outputTokens,
      });
      return result.priced
        ? { ...response, costUsd: result.costUsd }
        : { ...response, costUsd: undefined, unpricedReason: result.reason };
    },
  };
}
