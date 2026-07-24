/**
 * Engine resolver — EngineConfig → ModelClient.
 *
 * Maps the `engine.provider` string from agent.yaml to the corresponding
 * engine package, then dynamically imports the package from the agent dir's
 * `node_modules`. Supports "anthropic", "openai", "openrouter", and "ollama".
 *
 * Why dynamic-import from the agent dir?
 *
 *   Per the v0.3.2 package split, provider SDKs (`@anthropic-ai/sdk`,
 *   `openai`, `ollama`) no longer ship inside `auggy` core — they live in
 *   per-provider adapter packages (`@auggy/anthropic`, `@auggy/openai`,
 *   `@auggy/openrouter`, `@auggy/ollama`) which are installed PER AGENT in
 *   the agent's `node_modules`. The `auggy` CLI binary still runs from a
 *   global install; the engine for any given turn resolves from that
 *   agent's local install. An Anthropic-only agent never installs the
 *   OpenAI or Ollama SDK.
 *
 * API keys are NEVER in the YAML config — each engine reads its own env:
 *   - anthropic   → ANTHROPIC_API_KEY (read by @anthropic-ai/sdk)
 *   - openai      → OPENAI_API_KEY    (read by the openai SDK)
 *   - openrouter  → OPENROUTER_API_KEY (read by @auggy/openrouter; throws
 *     explicitly if absent rather than letting the SDK fall through to
 *     OPENAI_API_KEY)
 *   - ollama      → no API key (local runtime; baseURL defaults to
 *     http://localhost:11434, override for remote Ollama deployments)
 */

import type {
  createAnthropicEngine as AnthropicFactory,
  AnthropicEngineOptions,
} from "@auggy/anthropic";
import type { createOpenAIEngine as OpenAIFactory, OpenAIEngineOptions } from "@auggy/openai";
import type {
  createOpenRouterEngine as OpenRouterFactory,
  OpenRouterEngineOptions,
} from "@auggy/openrouter";
import type { createOllamaEngine as OllamaFactory, OllamaEngineOptions } from "@auggy/ollama";
import { importFromAgent } from "./import-from-agent";
import { PROVIDER_TO_PACKAGE } from "./scaffold-package-json";
import type { ModelClient } from "../types";
import type { EngineConfig, Provider } from "./types";
import { isKnownProvider, KNOWN_PROVIDERS } from "./types";

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
  // Defensive: programmatic callers may bypass the YAML parser, which is
  // the contract owner for narrowing `provider` to `Provider`. Re-validate
  // at runtime so a misconfigured caller fails fast with a clear message.
  const providerRaw = config.provider as string | undefined;
  if (typeof providerRaw !== "string" || providerRaw.length === 0) {
    throw new Error(`engine.provider is required (got: ${JSON.stringify(providerRaw)})`);
  }
  if (!isKnownProvider(providerRaw)) {
    throw new Error(
      `Unknown engine provider: "${providerRaw}" (supported: ${KNOWN_PROVIDERS.join(", ")})`,
    );
  }
  const provider: Provider = providerRaw;

  // Per-provider dispatch. Switch over the narrowed `Provider` union so
  // TypeScript enforces exhaustiveness — adding a new provider to the
  // union triggers a compile error here until a case is added. Each
  // branch builds its own options shape (fields differ per provider:
  // anthropic gets `baseURL`, openai+openrouter get `reasoningEffort`,
  // openrouter gets `providerRouting` but omits `baseURL`).
  switch (provider) {
    case "anthropic": {
      const mod = await importer<{
        createAnthropicEngine: typeof AnthropicFactory;
      }>(agentDir, PROVIDER_TO_PACKAGE.anthropic);
      const opts: AnthropicEngineOptions = {
        model: config.model,
        maxContextTokens: config.maxContextTokens,
        maxTokens: config.maxTokens,
        baseURL: config.baseURL,
        allowInsecureHttpWithCredentials: config.allowInsecureHttpWithCredentials,
        costOverride: config.costOverride,
        responseLimits: config.responseLimits,
        // apiKey intentionally omitted — SDK reads ANTHROPIC_API_KEY from env.
      };
      return mod.createAnthropicEngine(opts);
    }
    case "openai": {
      const mod = await importer<{
        createOpenAIEngine: typeof OpenAIFactory;
      }>(agentDir, PROVIDER_TO_PACKAGE.openai);
      const opts: OpenAIEngineOptions = {
        model: config.model,
        maxContextTokens: config.maxContextTokens,
        maxTokens: config.maxTokens,
        baseURL: config.baseURL,
        allowInsecureHttpWithCredentials: config.allowInsecureHttpWithCredentials,
        reasoningEffort: config.reasoningEffort,
        costOverride: config.costOverride,
        responseLimits: config.responseLimits,
        // apiKey intentionally omitted — SDK reads OPENAI_API_KEY from env.
      };
      return mod.createOpenAIEngine(opts);
    }
    case "openrouter": {
      const mod = await importer<{
        createOpenRouterEngine: typeof OpenRouterFactory;
      }>(agentDir, PROVIDER_TO_PACKAGE.openrouter);
      const opts: OpenRouterEngineOptions = {
        model: config.model,
        maxContextTokens: config.maxContextTokens,
        maxTokens: config.maxTokens,
        reasoningEffort: config.reasoningEffort,
        providerRouting: config.providerRouting,
        costOverride: config.costOverride,
        responseLimits: config.responseLimits,
        // baseURL intentionally NOT passed — hardcoded to OpenRouter.
        // apiKey intentionally omitted — engine reads OPENROUTER_API_KEY from env.
      };
      return mod.createOpenRouterEngine(opts);
    }
    case "ollama": {
      const mod = await importer<{
        createOllamaEngine: typeof OllamaFactory;
      }>(agentDir, PROVIDER_TO_PACKAGE.ollama);
      const opts: OllamaEngineOptions = {
        model: config.model,
        maxContextTokens: config.maxContextTokens,
        maxTokens: config.maxTokens,
        baseURL: config.baseURL,
        allowInsecureHttpWithCredentials: config.allowInsecureHttpWithCredentials,
        keepAlive: config.keepAlive,
        options: config.options,
        responseLimits: config.responseLimits,
        // costOverride: NOT supported (free local runtime; no pricing apparatus).
        // reasoningEffort: NOT a concept in Ollama models.
        // apiKey is read from OLLAMA_API_KEY env var when present. Local
        // Ollama (default localhost:11434) doesn't authenticate; remote
        // Ollama (Ollama Cloud, self-hosted with auth) does. Leaving the
        // env var unset is the local case; setting it enables bearer auth.
        ...(process.env.OLLAMA_API_KEY ? { apiKey: process.env.OLLAMA_API_KEY } : {}),
      };
      return mod.createOllamaEngine(opts);
    }
    default: {
      // Exhaustiveness check — unreachable today, but if a future Provider
      // member is added without a `case` here, TypeScript fails with
      // "Type 'Provider' is not assignable to type 'never'."
      const _exhaustive: never = provider;
      throw new Error(`engine-resolver: unhandled provider ${String(_exhaustive)}`);
    }
  }
}
