/**
 * Engine resolver — EngineConfig → ModelClient.
 *
 * Maps the `engine.provider` string from agent.yaml to the corresponding
 * engine factory. Supports "anthropic", "openai", and "openrouter".
 *
 * API keys are NEVER in the YAML config — each engine reads its own
 * environment variable:
 *   - anthropic   → ANTHROPIC_API_KEY (read by the Anthropic SDK)
 *   - openai      → OPENAI_API_KEY    (read by the openai SDK)
 *   - openrouter  → OPENROUTER_API_KEY (read by createOpenRouterEngine,
 *     which throws explicitly if absent rather than letting the SDK fall
 *     through to OPENAI_API_KEY)
 */

import { createAnthropicEngine } from "../engines/anthropic";
import { createOpenAIEngine } from "../engines/openai";
import { createOpenRouterEngine } from "../engines/openrouter";
import type { ModelClient } from "../types";
import type { EngineConfig } from "./types";

export function resolveEngine(config: EngineConfig): ModelClient {
  // Defensive: programmatic callers may bypass the YAML parser. Catch
  // missing/empty provider with a clearer message than the catch-all throw.
  if (typeof config.provider !== "string" || config.provider.length === 0) {
    throw new Error(`engine.provider is required (got: ${JSON.stringify(config.provider)})`);
  }

  if (config.provider === "anthropic") {
    return createAnthropicEngine({
      model: config.model,
      maxContextTokens: config.maxContextTokens,
      maxTokens: config.maxTokens,
      baseURL: config.baseURL,
      costOverride: config.costOverride,
      // apiKey intentionally omitted — SDK reads ANTHROPIC_API_KEY from env.
    });
  }

  if (config.provider === "openai") {
    return createOpenAIEngine({
      model: config.model,
      maxContextTokens: config.maxContextTokens,
      maxTokens: config.maxTokens,
      baseURL: config.baseURL,
      reasoningEffort: config.reasoningEffort,
      costOverride: config.costOverride,
      // apiKey intentionally omitted — SDK reads OPENAI_API_KEY from env.
    });
  }

  if (config.provider === "openrouter") {
    return createOpenRouterEngine({
      model: config.model,
      maxContextTokens: config.maxContextTokens,
      maxTokens: config.maxTokens,
      reasoningEffort: config.reasoningEffort,
      providerRouting: config.providerRouting,
      costOverride: config.costOverride,
      // baseURL intentionally NOT passed — hardcoded to OpenRouter.
      // apiKey intentionally omitted — engine reads OPENROUTER_API_KEY from env.
    });
  }

  throw new Error(
    `Unknown engine provider: "${config.provider}" (supported: anthropic, openai, openrouter)`,
  );
}
