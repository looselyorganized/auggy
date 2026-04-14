/**
 * Engine resolver — EngineConfig → ModelClient.
 *
 * Maps the `engine.provider` string from agent.yaml to the
 * corresponding engine factory. Currently only "anthropic" is
 * supported. The API key is NEVER in the config — the Anthropic
 * SDK reads ANTHROPIC_API_KEY from the environment.
 */

import { createAnthropicEngine } from "../engines/anthropic";
import type { ModelClient } from "../types";
import type { EngineConfig } from "./types";

export function resolveEngine(config: EngineConfig): ModelClient {
  if (config.provider === "anthropic") {
    return createAnthropicEngine({
      model: config.model,
      maxContextTokens: config.maxContextTokens,
      maxTokens: config.maxTokens,
      baseURL: config.baseURL,
      // apiKey intentionally omitted — SDK reads ANTHROPIC_API_KEY from env.
    });
  }

  throw new Error(
    `Unknown engine provider: "${config.provider}" (supported: anthropic)`,
  );
}
