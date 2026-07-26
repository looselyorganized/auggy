import {
  MAX_BEARER_TOKEN_BYTES,
  MAX_SSE_BYTES,
  MAX_SSE_EVENTS,
  type AuggyRunClientConfig,
} from "./auggy-client.js";

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
      bearerToken: boundedSecret(env, "AUGGY_BEARER_TOKEN", MAX_BEARER_TOKEN_BYTES),
      maxSseBytes: boundedPositiveInteger(env.AUGGY_MAX_SSE_BYTES, 1_048_576, MAX_SSE_BYTES, "AUGGY_MAX_SSE_BYTES"),
      maxSseEvents: boundedPositiveInteger(env.AUGGY_MAX_SSE_EVENTS, 10_000, MAX_SSE_EVENTS, "AUGGY_MAX_SSE_EVENTS"),
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

function boundedSecret(env: NodeJS.ProcessEnv, name: string, maximumBytes: number): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > maximumBytes || !/^[\x21-\x7e]+$/.test(value)) throw new Error(`${name} exceeds its safe bound`);
  return value;
}

function boundedPositiveInteger(value: string | undefined, fallback: number, maximum: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}
