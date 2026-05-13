/**
 * Engine resolver — EngineConfig → ModelClient.
 *
 * Maps the `engine.provider` string from agent.yaml to the corresponding
 * engine package, then dynamically imports the package from the agent dir's
 * `node_modules`. Supports "anthropic", "openai", and "openrouter".
 *
 * Why dynamic-import from the agent dir?
 *
 *   Per the v0.3.2 package split, provider SDKs (`@anthropic-ai/sdk`,
 *   `openai`) no longer ship inside `auggy` core — they live in
 *   per-provider adapter packages (`@auggy/anthropic`, `@auggy/openai`,
 *   `@auggy/openrouter`) which are installed PER AGENT in the agent's
 *   `node_modules`. The `auggy` CLI binary still runs from a global
 *   install; the engine for any given turn resolves from that agent's
 *   local install. An Anthropic-only agent never installs the OpenAI SDK.
 *
 * API keys are NEVER in the YAML config — each engine reads its own env:
 *   - anthropic   → ANTHROPIC_API_KEY (read by @anthropic-ai/sdk)
 *   - openai      → OPENAI_API_KEY    (read by the openai SDK)
 *   - openrouter  → OPENROUTER_API_KEY (read by @auggy/openrouter; throws
 *     explicitly if absent rather than letting the SDK fall through to
 *     OPENAI_API_KEY)
 */

import type {
  createAnthropicEngine as AnthropicFactory,
  AnthropicEngineOptions,
} from "@auggy/anthropic";
import type {
  createOpenAIEngine as OpenAIFactory,
  OpenAIEngineOptions,
} from "@auggy/openai";
import type {
  createOpenRouterEngine as OpenRouterFactory,
  OpenRouterEngineOptions,
} from "@auggy/openrouter";
import { importFromAgent } from "./import-from-agent";
import type { ModelClient } from "../types";
import type { EngineConfig } from "./types";

/**
 * Test seam: injectable importer. Production callers omit this and get the
 * real `importFromAgent`. Tests can pass a stubbed importer to skip the
 * agent-dir resolution and supply a factory directly — useful when the test
 * isn't exercising the resolution path itself.
 */
export type EngineImporter = <T>(agentDir: string, specifier: string) => Promise<T>;

export async function resolveEngine(
  config: EngineConfig,
  agentDir: string,
  importer: EngineImporter = importFromAgent,
): Promise<ModelClient> {
  // Defensive: programmatic callers may bypass the YAML parser. Catch
  // missing/empty provider with a clearer message than the catch-all throw.
  if (typeof config.provider !== "string" || config.provider.length === 0) {
    throw new Error(`engine.provider is required (got: ${JSON.stringify(config.provider)})`);
  }

  if (config.provider === "anthropic") {
    const mod = await importer<{
      createAnthropicEngine: typeof AnthropicFactory;
    }>(agentDir, "@auggy/anthropic");
    const opts: AnthropicEngineOptions = {
      model: config.model,
      maxContextTokens: config.maxContextTokens,
      maxTokens: config.maxTokens,
      baseURL: config.baseURL,
      costOverride: config.costOverride,
      // apiKey intentionally omitted — SDK reads ANTHROPIC_API_KEY from env.
    };
    return mod.createAnthropicEngine(opts);
  }

  if (config.provider === "openai") {
    const mod = await importer<{
      createOpenAIEngine: typeof OpenAIFactory;
    }>(agentDir, "@auggy/openai");
    const opts: OpenAIEngineOptions = {
      model: config.model,
      maxContextTokens: config.maxContextTokens,
      maxTokens: config.maxTokens,
      baseURL: config.baseURL,
      reasoningEffort: config.reasoningEffort,
      costOverride: config.costOverride,
      // apiKey intentionally omitted — SDK reads OPENAI_API_KEY from env.
    };
    return mod.createOpenAIEngine(opts);
  }

  if (config.provider === "openrouter") {
    const mod = await importer<{
      createOpenRouterEngine: typeof OpenRouterFactory;
    }>(agentDir, "@auggy/openrouter");
    const opts: OpenRouterEngineOptions = {
      model: config.model,
      maxContextTokens: config.maxContextTokens,
      maxTokens: config.maxTokens,
      reasoningEffort: config.reasoningEffort,
      providerRouting: config.providerRouting,
      costOverride: config.costOverride,
      // baseURL intentionally NOT passed — hardcoded to OpenRouter.
      // apiKey intentionally omitted — engine reads OPENROUTER_API_KEY from env.
    };
    return mod.createOpenRouterEngine(opts);
  }

  throw new Error(
    `Unknown engine provider: "${config.provider}" (supported: anthropic, openai, openrouter)`,
  );
}
