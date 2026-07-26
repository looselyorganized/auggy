import type { AuggyRunClientConfig } from "./auggy-client.js";

export interface OperatorConfig {
  temporal: {
    address: string;
    namespace: string;
    taskQueue: string;
    apiKey?: string;
  };
  auggy: AuggyRunClientConfig;
}
/** Read only process/operator configuration; never pass this object to a Workflow. */
export function readOperatorConfig(env: NodeJS.ProcessEnv = process.env): OperatorConfig {
  const taskQueue = required(env, "TEMPORAL_TASK_QUEUE");
  if (!/^[A-Za-z0-9._:/@-]{1,200}$/.test(taskQueue)) throw new Error("TEMPORAL_TASK_QUEUE has invalid characters");
  return {
    temporal: {
      address: env.TEMPORAL_ADDRESS?.trim() || "localhost:7233",
      namespace: env.TEMPORAL_NAMESPACE?.trim() || "default",
      taskQueue,
      apiKey: optional(env, "TEMPORAL_API_KEY"),
    },
    auggy: {
      target: required(env, "AUGGY_TARGET"),
      bearerToken: required(env, "AUGGY_BEARER_TOKEN"),
      maxSseBytes: positiveInteger(env.AUGGY_MAX_SSE_BYTES, 1_048_576, "AUGGY_MAX_SSE_BYTES"),
      maxSseEvents: positiveInteger(env.AUGGY_MAX_SSE_EVENTS, 10_000, "AUGGY_MAX_SSE_EVENTS"),
    },
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
