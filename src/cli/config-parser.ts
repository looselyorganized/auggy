/**
 * Config parser — YAML agent.yaml → ParsedConfig.
 *
 * Three passes:
 *   1. YAML parse (raw object)
 *   2. Env var interpolation (${VAR_NAME} → process.env.VAR_NAME)
 *   3. Structural validation (required fields, types, constraints)
 *
 * The parser loads a .env file from the agent directory before parsing
 * so secrets are available for interpolation (same pattern as the
 * telemetry-exporter daemon).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join, isAbsolute, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  ParsedConfig,
  AugmentConfig,
  EngineConfig,
  AgentSettings,
  DurableJobsConfig,
  SecurityEvalOverride,
} from "./types";
import { KNOWN_PROVIDERS, isKnownProvider } from "./types";
import { parseEnvFile } from "./env-parse";
import {
  buildConsoleAllowedOrigins,
  compileTrustedProxyNetworks,
} from "../transports/console-request-security";
import { DEFAULT_EXTRACTION_BUFFER_LIMITS } from "../augments/layeredMemory/extractor/buffer";
import { MAX_PROVIDER_REQUEST_TIMEOUT_MS } from "../engines/_shared/provider-resilience";
import { parseUtcCron } from "../jobs/cron";
import { isWellFormedEmail } from "../augments/visitorAuth/email-validation";

// ---------------------------------------------------------------------------
// .env loading
// ---------------------------------------------------------------------------

/**
 * Load a .env file into process.env. Uses the shared `parseEnvFile` so the
 * runtime sees exactly what the admin Credentials UI writes/reads (codex
 * adversarial-review High-2 fix — previously the runtime stripped quotes
 * but did not honor `\n`/`\t`/`\\` escapes inside double-quoted values,
 * which silently corrupted PEM/JSON/multiline secrets).
 *
 * Silently skips if the file doesn't exist.
 */
export function loadEnvFile(dir: string): void {
  const envPath = resolve(dir, ".env");
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, "utf-8");
  for (const line of parseEnvFile(content)) {
    if (line.kind !== "kv") continue;
    // Skip empty values (placeholder lines like KEY= in the template).
    // Don't override existing env vars (shell exports take precedence).
    if (line.key && line.value && !(line.key in process.env)) {
      process.env[line.key] = line.value;
    }
  }
}

// ---------------------------------------------------------------------------
// Env var interpolation
// ---------------------------------------------------------------------------

const ENV_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const DEFAULT_DISTRIBUTED_COORDINATION = {
  urlEnv: "AUGGY_COORDINATION_DATABASE_URL",
  leaseDurationMs: 30_000,
  heartbeatIntervalMs: 5_000,
  claimPollMs: 100,
  maxWaitMs: 30_000,
} as const;

export const DEFAULT_DURABLE_JOBS = {
  dbPath: "./data/durable-jobs.sqlite",
  leaseDurationMs: 30_000,
  heartbeatIntervalMs: 5_000,
  claimPollMs: 250,
  turnTimeoutMs: 5 * 60_000,
  maxAttempts: 3,
  maxTotalRecords: 10_000,
  maxQueuedRecords: 1_000,
  maxPrivateBytes: 128 * 1024 * 1024,
  terminalRetentionMs: 30 * 24 * 60 * 60_000,
  auditRetentionMs: 90 * 24 * 60 * 60_000,
} as const;

const MAX_DURABLE_SCHEDULES = 100;
const MAX_DURABLE_PROMPT_BYTES = 32 * 1024;
const SAFE_DURABLE_SCHEDULE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_DURABLE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

function parseDurableJobsSettings(value: unknown, errors: string[]): DurableJobsConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push("settings.jobs: must be an object");
    return undefined;
  }

  const jobs = value as Record<string, unknown>;
  const allowed = new Set([
    "enabled",
    "dbPath",
    "leaseDurationMs",
    "heartbeatIntervalMs",
    "claimPollMs",
    "turnTimeoutMs",
    "maxAttempts",
    "maxTotalRecords",
    "maxQueuedRecords",
    "maxPrivateBytes",
    "terminalRetentionMs",
    "auditRetentionMs",
    "schedules",
  ]);
  for (const key of Object.keys(jobs)) {
    if (!allowed.has(key)) errors.push(`settings.jobs.${key}: unknown durable-jobs setting`);
  }
  if (jobs.enabled !== true) {
    errors.push("settings.jobs.enabled: must be true; omit settings.jobs to disable durable jobs");
  }

  const dbPath = jobs.dbPath ?? DEFAULT_DURABLE_JOBS.dbPath;
  const dbPathHasControl =
    typeof dbPath === "string" &&
    [...dbPath].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    });
  if (
    typeof dbPath !== "string" ||
    dbPath.length < 1 ||
    dbPath.length > 4_096 ||
    dbPath !== dbPath.trim() ||
    dbPath !== dbPath.normalize("NFC") ||
    dbPath === ":memory:" ||
    dbPathHasControl
  ) {
    errors.push("settings.jobs.dbPath: must be a bounded durable filesystem path");
  }

  const numericConstraints = {
    leaseDurationMs: { minimum: 1_000, maximum: 60 * 60_000 },
    heartbeatIntervalMs: { minimum: 100, maximum: 20 * 60_000 },
    // The durable worker refuses sub-100ms polling to prevent an invalid but
    // accepted config from creating a tight SQLite polling loop at startup.
    claimPollMs: { minimum: 100, maximum: 60_000 },
    turnTimeoutMs: { minimum: 1_000, maximum: 15 * 60_000 },
    maxAttempts: { minimum: 1, maximum: 10 },
    maxTotalRecords: { minimum: 1, maximum: 1_000_000 },
    maxQueuedRecords: { minimum: 1, maximum: 1_000_000 },
    maxPrivateBytes: { minimum: 64 * 1024, maximum: 2 * 1024 * 1024 * 1024 },
    terminalRetentionMs: { minimum: 60 * 60_000, maximum: 3650 * 24 * 60 * 60_000 },
    auditRetentionMs: { minimum: 24 * 60 * 60_000, maximum: 3650 * 24 * 60 * 60_000 },
  } as const;
  const normalizedNumbers = {} as Record<keyof typeof numericConstraints, number>;
  for (const key of Object.keys(numericConstraints) as Array<keyof typeof numericConstraints>) {
    const constraint = numericConstraints[key];
    const candidate = jobs[key] ?? DEFAULT_DURABLE_JOBS[key];
    if (
      !Number.isSafeInteger(candidate) ||
      (candidate as number) < constraint.minimum ||
      (candidate as number) > constraint.maximum
    ) {
      errors.push(
        `settings.jobs.${key}: must be a safe integer between ${constraint.minimum} and ${constraint.maximum}`,
      );
      normalizedNumbers[key] = DEFAULT_DURABLE_JOBS[key];
    } else {
      normalizedNumbers[key] = candidate as number;
    }
  }
  if (normalizedNumbers.heartbeatIntervalMs * 3 > normalizedNumbers.leaseDurationMs) {
    errors.push(
      "settings.jobs.heartbeatIntervalMs: three heartbeats must fit within leaseDurationMs",
    );
  }
  if (normalizedNumbers.maxQueuedRecords > normalizedNumbers.maxTotalRecords) {
    errors.push("settings.jobs.maxQueuedRecords: cannot exceed maxTotalRecords");
  }
  if (normalizedNumbers.auditRetentionMs < normalizedNumbers.terminalRetentionMs) {
    errors.push("settings.jobs.auditRetentionMs: cannot be shorter than terminalRetentionMs");
  }

  const schedulesValue = jobs.schedules ?? [];
  const schedules: DurableJobsConfig["schedules"] = [];
  if (!Array.isArray(schedulesValue) || schedulesValue.length > MAX_DURABLE_SCHEDULES) {
    errors.push(`settings.jobs.schedules: must contain at most ${MAX_DURABLE_SCHEDULES} entries`);
  } else {
    const scheduleIds = new Set<string>();
    for (const [index, candidate] of schedulesValue.entries()) {
      const prefix = `settings.jobs.schedules[${index}]`;
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        errors.push(`${prefix}: must be an object`);
        continue;
      }
      const schedule = candidate as Record<string, unknown>;
      const scheduleAllowed = new Set([
        "id",
        "cron",
        "prompt",
        "threadId",
        "enabled",
        "maxAttempts",
        "timeoutMs",
      ]);
      for (const key of Object.keys(schedule)) {
        if (!scheduleAllowed.has(key)) errors.push(`${prefix}.${key}: unknown schedule setting`);
      }
      const id = schedule.id;
      if (typeof id !== "string" || !SAFE_DURABLE_SCHEDULE_ID.test(id)) {
        errors.push(`${prefix}.id: must be a safe identifier of 1 to 64 characters`);
      } else if (scheduleIds.has(id)) {
        errors.push(`${prefix}.id: duplicate schedule identifier`);
      } else {
        scheduleIds.add(id);
      }
      const cron = schedule.cron;
      if (typeof cron !== "string") {
        errors.push(`${prefix}.cron: must be a five-field UTC cron string`);
      } else {
        try {
          parseUtcCron(cron);
        } catch {
          errors.push(`${prefix}.cron: must be a bounded five-field UTC cron expression`);
        }
      }
      const prompt = schedule.prompt;
      if (
        typeof prompt !== "string" ||
        prompt.length < 1 ||
        prompt.length > MAX_DURABLE_PROMPT_BYTES ||
        Buffer.byteLength(prompt, "utf8") > MAX_DURABLE_PROMPT_BYTES ||
        prompt.includes("\0")
      ) {
        errors.push(`${prefix}.prompt: must contain 1 to ${MAX_DURABLE_PROMPT_BYTES} UTF-8 bytes`);
      }
      const threadId = schedule.threadId;
      if (
        threadId !== undefined &&
        (typeof threadId !== "string" || !SAFE_DURABLE_THREAD_ID.test(threadId))
      ) {
        errors.push(`${prefix}.threadId: must be a safe identifier of 1 to 128 characters`);
      }
      const enabled = schedule.enabled ?? true;
      if (typeof enabled !== "boolean") errors.push(`${prefix}.enabled: must be a boolean`);
      const maxAttempts = schedule.maxAttempts ?? normalizedNumbers.maxAttempts;
      if (
        !Number.isSafeInteger(maxAttempts) ||
        (maxAttempts as number) < 1 ||
        (maxAttempts as number) > 10
      ) {
        errors.push(`${prefix}.maxAttempts: must be a safe integer between 1 and 10`);
      }
      const timeoutMs = schedule.timeoutMs ?? normalizedNumbers.turnTimeoutMs;
      if (
        !Number.isSafeInteger(timeoutMs) ||
        (timeoutMs as number) < 1_000 ||
        (timeoutMs as number) > 15 * 60_000
      ) {
        errors.push(`${prefix}.timeoutMs: must be between 1000 and 900000`);
      }
      if (
        typeof id === "string" &&
        SAFE_DURABLE_SCHEDULE_ID.test(id) &&
        typeof cron === "string" &&
        typeof prompt === "string" &&
        typeof enabled === "boolean" &&
        Number.isSafeInteger(maxAttempts) &&
        Number.isSafeInteger(timeoutMs)
      ) {
        schedules.push({
          id,
          cron,
          prompt,
          ...(typeof threadId === "string" ? { threadId } : {}),
          enabled,
          maxAttempts: maxAttempts as number,
          timeoutMs: timeoutMs as number,
        });
      }
    }
  }

  return {
    enabled: true,
    dbPath: typeof dbPath === "string" ? dbPath : DEFAULT_DURABLE_JOBS.dbPath,
    ...normalizedNumbers,
    schedules,
  };
}

/**
 * Recursively walk all string values in an object tree and replace
 * ${VAR_NAME} references with process.env[VAR_NAME].
 *
 * Missing vars collect into an error array. If any are missing, throw
 * with a clear message listing all of them.
 */
export function interpolateEnvVars(obj: unknown, path = ""): unknown {
  const missing: string[] = [];
  const result = walkAndInterpolate(obj, path, missing);
  if (missing.length > 0) {
    const uniqueMissing = uniqueMissingEnvVars(missing);
    throw new Error(
      `Missing environment variables:\n${uniqueMissing.map((m) => `  - ${m}`).join("\n")}`,
    );
  }
  return result;
}

function uniqueMissingEnvVars(missing: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of missing) {
    const key = item.split(" (referenced in ")[0] ?? item;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function walkAndInterpolate(obj: unknown, path: string, missing: string[]): unknown {
  if (typeof obj === "string") {
    return obj.replace(ENV_VAR_RE, (_match, varName: string) => {
      const value = process.env[varName];
      if (value === undefined || value === "") {
        missing.push(`${varName} (referenced in ${path || "root"})`);
        return `\${${varName}}`;
      }
      return value;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map((item, i) => walkAndInterpolate(item, `${path}[${i}]`, missing));
  }
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      out[key] = walkAndInterpolate(value, path ? `${path}.${key}` : key, missing);
    }
    return out;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const AUG1_ID_RE = /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Agent and augment names: code identifiers; no dots, slashes, or spaces. */
export const VALID_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const VALID_COMPACTION = new Set(["truncate", "summarize", "sliding-window"]);
const AUGMENT_SOURCE_LABEL_FIELD = "__auggySourceLabel";
const BUILTIN_TYPES = new Set([
  "fileMemory",
  "supabaseMemory",
  "layeredMemory",
  "filesystem",
  "webTransport",
  "webFetch",
  "knowledge",
  "skills",
  "bash",
  "budgets",
  "notify",
  "mcp",
  "agentMail",
  "telegramTransport",
  "turnControl",
  "visitorAuth",
  "link",
]);
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const VALID_ROUTING_SORTS = new Set(["price", "throughput", "latency"]);
const VALID_ROUTING_KEYS = new Set(["only", "ignore", "sort", "max_price"]);
const PROVIDER_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------
// Per-augment option validators
// ---------------------------------------------------------------------------

function validateWebTransportOptions(
  opts: Record<string, unknown>,
  optionsPrefix: string,
  errors: string[],
): void {
  if (
    !Number.isSafeInteger(opts.port) ||
    (opts.port as number) < 1 ||
    (opts.port as number) > 65_535
  ) {
    errors.push(`${optionsPrefix}.port: required integer from 1 to 65535`);
  }
  for (const field of ["allowAnonymous", "adminRoute", "publicIntegration"] as const) {
    if (opts[field] !== undefined && typeof opts[field] !== "boolean") {
      errors.push(`${optionsPrefix}.${field}: must be a boolean`);
    }
  }
  if (opts.visitorTokens !== undefined) {
    if (
      opts.visitorTokens === null ||
      typeof opts.visitorTokens !== "object" ||
      Array.isArray(opts.visitorTokens)
    ) {
      errors.push(`${optionsPrefix}.visitorTokens: must be an object`);
    } else {
      const visitorTokens = opts.visitorTokens as Record<string, unknown>;
      if (visitorTokens.enabled !== undefined && typeof visitorTokens.enabled !== "boolean") {
        errors.push(`${optionsPrefix}.visitorTokens.enabled: must be a boolean`);
      }
    }
  }
  if (opts.rateLimitPerPeer !== undefined) {
    if (
      opts.rateLimitPerPeer === null ||
      typeof opts.rateLimitPerPeer !== "object" ||
      Array.isArray(opts.rateLimitPerPeer)
    ) {
      errors.push(`${optionsPrefix}.rateLimitPerPeer: must be an object`);
    } else {
      const rateLimit = opts.rateLimitPerPeer as Record<string, unknown>;
      const maxPerMinute = rateLimit.maxPerMinute;
      if (!Number.isSafeInteger(maxPerMinute) || (maxPerMinute as number) < 1) {
        errors.push(`${optionsPrefix}.rateLimitPerPeer.maxPerMinute: must be a positive integer`);
      }
      if (rateLimit.anonymousNetwork !== undefined) {
        if (
          rateLimit.anonymousNetwork === null ||
          typeof rateLimit.anonymousNetwork !== "object" ||
          Array.isArray(rateLimit.anonymousNetwork)
        ) {
          errors.push(`${optionsPrefix}.rateLimitPerPeer.anonymousNetwork: must be an object`);
        } else {
          const anonymous = rateLimit.anonymousNetwork as Record<string, unknown>;
          if (
            anonymous.mode !== undefined &&
            anonymous.mode !== "shared-store" &&
            anonymous.mode !== "trusted-edge" &&
            anonymous.mode !== "single-process-development"
          ) {
            errors.push(
              `${optionsPrefix}.rateLimitPerPeer.anonymousNetwork.mode: must be shared-store, trusted-edge, or single-process-development`,
            );
          }
          if (
            anonymous.ipv6PrefixBits !== undefined &&
            (!Number.isSafeInteger(anonymous.ipv6PrefixBits) ||
              (anonymous.ipv6PrefixBits as number) < 32 ||
              (anonymous.ipv6PrefixBits as number) > 64)
          ) {
            errors.push(
              `${optionsPrefix}.rateLimitPerPeer.anonymousNetwork.ipv6PrefixBits: must be an integer from 32 to 64`,
            );
          }
          if (
            anonymous.globalMaxPerMinute !== undefined &&
            (!Number.isSafeInteger(anonymous.globalMaxPerMinute) ||
              (anonymous.globalMaxPerMinute as number) < 1)
          ) {
            errors.push(
              `${optionsPrefix}.rateLimitPerPeer.anonymousNetwork.globalMaxPerMinute: must be a positive integer`,
            );
          } else if (
            typeof maxPerMinute === "number" &&
            typeof anonymous.globalMaxPerMinute === "number" &&
            anonymous.globalMaxPerMinute < maxPerMinute
          ) {
            errors.push(
              `${optionsPrefix}.rateLimitPerPeer.anonymousNetwork.globalMaxPerMinute: cannot be less than maxPerMinute`,
            );
          }
        }
      }
    }
  }
  if (
    opts.maxRequestBodyBytes !== undefined &&
    (!Number.isSafeInteger(opts.maxRequestBodyBytes) || (opts.maxRequestBodyBytes as number) < 1)
  ) {
    errors.push(`${optionsPrefix}.maxRequestBodyBytes: must be a positive integer`);
  }
  for (const field of [
    "maxPendingSseBytes",
    "maxPendingSseEvents",
    "maxConsoleRunBytes",
  ] as const) {
    if (
      opts[field] !== undefined &&
      (!Number.isSafeInteger(opts[field]) || (opts[field] as number) < 1)
    ) {
      errors.push(`${optionsPrefix}.${field}: must be a positive integer`);
    }
  }

  if (opts.trustedProxies !== undefined) {
    if (
      !Array.isArray(opts.trustedProxies) ||
      opts.trustedProxies.some((entry) => typeof entry !== "string")
    ) {
      errors.push(`${optionsPrefix}.trustedProxies: must be an array of IP or CIDR strings`);
    } else {
      try {
        compileTrustedProxyNetworks(opts.trustedProxies as string[]);
      } catch (error) {
        errors.push(`${optionsPrefix}.trustedProxies: ${(error as Error).message}`);
      }
    }
  }

  if (opts.externalAuth !== undefined) {
    if (
      opts.externalAuth === null ||
      typeof opts.externalAuth !== "object" ||
      Array.isArray(opts.externalAuth)
    ) {
      errors.push(`${optionsPrefix}.externalAuth: must be an object`);
    } else {
      const externalAuth = opts.externalAuth as Record<string, unknown>;
      if (typeof externalAuth.secret !== "string" || externalAuth.secret.trim() === "") {
        errors.push(`${optionsPrefix}.externalAuth.secret: must be a non-empty string`);
      }
      if (
        externalAuth.keyId !== undefined &&
        (typeof externalAuth.keyId !== "string" || externalAuth.keyId.trim() === "")
      ) {
        errors.push(`${optionsPrefix}.externalAuth.keyId: must be a non-empty string`);
      }
      if (
        externalAuth.audience !== undefined &&
        (typeof externalAuth.audience !== "string" || externalAuth.audience.trim() === "")
      ) {
        errors.push(`${optionsPrefix}.externalAuth.audience: must be a non-empty string`);
      }
      if (
        externalAuth.header !== undefined &&
        (typeof externalAuth.header !== "string" || externalAuth.header.trim() === "")
      ) {
        errors.push(`${optionsPrefix}.externalAuth.header: must be a non-empty string`);
      }
      if (
        externalAuth.maxTtlSeconds !== undefined &&
        (!Number.isSafeInteger(externalAuth.maxTtlSeconds) ||
          (externalAuth.maxTtlSeconds as number) <= 0)
      ) {
        errors.push(`${optionsPrefix}.externalAuth.maxTtlSeconds: must be a positive integer`);
      }
      if (externalAuth.allowedProviders !== undefined) {
        if (
          !Array.isArray(externalAuth.allowedProviders) ||
          externalAuth.allowedProviders.length === 0 ||
          externalAuth.allowedProviders.some(
            (provider) => typeof provider !== "string" || provider.trim() === "",
          )
        ) {
          errors.push(
            `${optionsPrefix}.externalAuth.allowedProviders: must be a non-empty array of non-empty strings`,
          );
        } else if (
          new Set(externalAuth.allowedProviders as string[]).size !==
          externalAuth.allowedProviders.length
        ) {
          errors.push(`${optionsPrefix}.externalAuth.allowedProviders: entries must be unique`);
        }
      }
      if (externalAuth.secrets !== undefined) {
        if (
          !Array.isArray(externalAuth.secrets) ||
          externalAuth.secrets.some(
            (entry) => entry === null || typeof entry !== "object" || Array.isArray(entry),
          )
        ) {
          errors.push(`${optionsPrefix}.externalAuth.secrets: must be an array of secret objects`);
        } else {
          for (const [index, value] of externalAuth.secrets.entries()) {
            const entry = value as Record<string, unknown>;
            if (typeof entry.secret !== "string" || entry.secret.trim() === "") {
              errors.push(
                `${optionsPrefix}.externalAuth.secrets[${index}].secret: must be a non-empty string`,
              );
            }
            if (
              entry.keyId !== undefined &&
              (typeof entry.keyId !== "string" || entry.keyId.trim() === "")
            ) {
              errors.push(
                `${optionsPrefix}.externalAuth.secrets[${index}].keyId: must be a non-empty string`,
              );
            }
          }
        }
      }
      if (
        externalAuth.includeUnverifiedEmail !== undefined &&
        typeof externalAuth.includeUnverifiedEmail !== "boolean"
      ) {
        errors.push(`${optionsPrefix}.externalAuth.includeUnverifiedEmail: must be a boolean`);
      }
      if (
        externalAuth.visitorId !== undefined &&
        (typeof externalAuth.visitorId !== "string" || externalAuth.visitorId.trim() === "")
      ) {
        errors.push(`${optionsPrefix}.externalAuth.visitorId: must be a non-empty string`);
      }
      if (externalAuth.replayProtection !== undefined) {
        if (
          externalAuth.replayProtection === null ||
          typeof externalAuth.replayProtection !== "object" ||
          Array.isArray(externalAuth.replayProtection)
        ) {
          errors.push(`${optionsPrefix}.externalAuth.replayProtection: must be an object`);
        } else {
          const replay = externalAuth.replayProtection as Record<string, unknown>;
          if (typeof replay.enabled !== "boolean") {
            errors.push(
              `${optionsPrefix}.externalAuth.replayProtection.enabled: must be a boolean`,
            );
          }
          if (replay.store !== undefined) {
            errors.push(
              `${optionsPrefix}.externalAuth.replayProtection.store: executable stores cannot be configured in YAML`,
            );
          }
          if (replay.enabled === true) {
            errors.push(
              `${optionsPrefix}.externalAuth.replayProtection: enabled protection requires a programmatic atomic store`,
            );
          }
        }
      }
    }
  }

  if (opts.consoleSecurity !== undefined) {
    if (
      opts.consoleSecurity === null ||
      typeof opts.consoleSecurity !== "object" ||
      Array.isArray(opts.consoleSecurity)
    ) {
      errors.push(`${optionsPrefix}.consoleSecurity: must be an object`);
    } else {
      const security = opts.consoleSecurity as Record<string, unknown>;
      if (
        security.allowedOrigins !== undefined &&
        (!Array.isArray(security.allowedOrigins) ||
          security.allowedOrigins.some((origin) => typeof origin !== "string"))
      ) {
        errors.push(`${optionsPrefix}.consoleSecurity.allowedOrigins: must be an array of strings`);
      } else if (Array.isArray(security.allowedOrigins)) {
        try {
          buildConsoleAllowedOrigins(
            typeof opts.port === "number" ? opts.port : 8080,
            security.allowedOrigins as string[],
          );
        } catch (error) {
          errors.push(
            `${optionsPrefix}.consoleSecurity.allowedOrigins: ${(error as Error).message}`,
          );
        }
      }
    }
  }

  if (opts.consoleChat !== undefined) {
    if (
      opts.consoleChat === null ||
      typeof opts.consoleChat !== "object" ||
      Array.isArray(opts.consoleChat)
    ) {
      errors.push(`${optionsPrefix}.consoleChat: must be an object`);
    } else {
      const consoleChat = opts.consoleChat as Record<string, unknown>;
      if (
        consoleChat.dbPath !== undefined &&
        consoleChat.dbPath !== null &&
        (typeof consoleChat.dbPath !== "string" || consoleChat.dbPath.trim().length === 0)
      ) {
        errors.push(`${optionsPrefix}.consoleChat.dbPath: must be a non-empty string or null`);
      }
    }
  }
}

function validateVisitorAuthOptions(
  opts: Record<string, unknown>,
  optionsPrefix: string,
  errors: string[],
): void {
  if (opts.rateLimit === undefined) return;
  if (
    opts.rateLimit === null ||
    typeof opts.rateLimit !== "object" ||
    Array.isArray(opts.rateLimit)
  ) {
    errors.push(`${optionsPrefix}.rateLimit: must be an object`);
    return;
  }

  const rateLimit = opts.rateLimit as Record<string, unknown>;
  for (const field of ["perHour", "perDay"] as const) {
    const value = rateLimit[field];
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      errors.push(`${optionsPrefix}.rateLimit.${field}: must be a positive integer`);
    }
  }
  if (
    rateLimit.minIntervalSeconds !== undefined &&
    (!Number.isSafeInteger(rateLimit.minIntervalSeconds) ||
      (rateLimit.minIntervalSeconds as number) < 0)
  ) {
    errors.push(`${optionsPrefix}.rateLimit.minIntervalSeconds: must be a non-negative integer`);
  }
}

/**
 * Validate a BudgetCaps object (used for agent, public.anonymous, public.recognized).
 * Each field must be a positive number when present.
 */
function validateBudgetCaps(caps: Record<string, unknown>, path: string, errors: string[]): void {
  const numericFields = ["maxTurnsPerThread", "maxTurnsPerDay", "maxUsdPerDay"] as const;
  for (const field of numericFields) {
    if (caps[field] !== undefined) {
      if (typeof caps[field] !== "number" || (caps[field] as number) <= 0) {
        errors.push(`${path}.${field}: must be a positive number`);
      }
    }
  }
  if (caps.maxUsdPerThread !== undefined) {
    errors.push(`${path}.maxUsdPerThread: unsupported budget cap field`);
  }
}

/**
 * Validate the options block for a budgets augment.
 */
function validateBudgetsOptions(
  opts: Record<string, unknown>,
  optionsPrefix: string,
  errors: string[],
): void {
  if (typeof opts.dbPath !== "string" || opts.dbPath.length === 0) {
    errors.push(`${optionsPrefix}.dbPath: required string`);
  }

  const numericPositive: Array<keyof typeof opts> = [
    "anonymousGlobalLimit",
    "dailyBudgetUsd",
    "cleanupWindowMs",
  ];
  for (const field of numericPositive) {
    if (opts[field] !== undefined) {
      if (typeof opts[field] !== "number" || (opts[field] as number) <= 0) {
        errors.push(`${optionsPrefix}.${field}: must be a positive number`);
      }
    }
  }
  if (opts.retentionDays !== undefined) {
    if (
      typeof opts.retentionDays !== "number" ||
      !Number.isInteger(opts.retentionDays) ||
      opts.retentionDays <= 0
    ) {
      errors.push(`${optionsPrefix}.retentionDays: must be a positive integer`);
    }
  }

  if (opts.caps !== undefined) {
    if (typeof opts.caps !== "object" || opts.caps === null || Array.isArray(opts.caps)) {
      errors.push(`${optionsPrefix}.caps: must be an object`);
      return;
    }
    const caps = opts.caps as Record<string, unknown>;

    if (caps.agent !== undefined) {
      if (typeof caps.agent !== "object" || caps.agent === null || Array.isArray(caps.agent)) {
        errors.push(`${optionsPrefix}.caps.agent: must be an object`);
      } else {
        validateBudgetCaps(
          caps.agent as Record<string, unknown>,
          `${optionsPrefix}.caps.agent`,
          errors,
        );
      }
    }

    if (caps.public !== undefined) {
      if (typeof caps.public !== "object" || caps.public === null || Array.isArray(caps.public)) {
        errors.push(`${optionsPrefix}.caps.public: must be an object`);
      } else {
        const pub = caps.public as Record<string, unknown>;
        for (const substate of ["anonymous", "recognized"] as const) {
          if (pub[substate] !== undefined) {
            if (
              typeof pub[substate] !== "object" ||
              pub[substate] === null ||
              Array.isArray(pub[substate])
            ) {
              errors.push(`${optionsPrefix}.caps.public.${substate}: must be an object`);
            } else {
              validateBudgetCaps(
                pub[substate] as Record<string, unknown>,
                `${optionsPrefix}.caps.public.${substate}`,
                errors,
              );
            }
          }
        }
      }
    }
  }

  if (opts.notifications !== undefined) {
    if (
      typeof opts.notifications !== "object" ||
      opts.notifications === null ||
      Array.isArray(opts.notifications)
    ) {
      errors.push(`${optionsPrefix}.notifications: must be an object`);
      return;
    }

    const notifications = opts.notifications as Record<string, unknown>;
    if (notifications.enabled !== undefined && typeof notifications.enabled !== "boolean") {
      errors.push(`${optionsPrefix}.notifications.enabled: must be a boolean`);
    }
    const notificationsEnabled = notifications.enabled !== false;
    if (
      notificationsEnabled &&
      (typeof notifications.destination !== "string" || notifications.destination.length === 0)
    ) {
      errors.push(`${optionsPrefix}.notifications.destination: required non-empty string`);
    }
    if (notifications.thresholds !== undefined) {
      if (!Array.isArray(notifications.thresholds) || notifications.thresholds.length === 0) {
        errors.push(`${optionsPrefix}.notifications.thresholds: must be a non-empty array`);
      } else {
        notifications.thresholds.forEach((threshold, index) => {
          if (
            typeof threshold !== "number" ||
            !Number.isFinite(threshold) ||
            threshold <= 0 ||
            threshold > 1
          ) {
            errors.push(
              `${optionsPrefix}.notifications.thresholds[${index}]: must be a number > 0 and <= 1`,
            );
          }
        });
      }
    }
  }
}

/**
 * Valid extraction-frequency values for layered-memory's autoSave block.
 * Aligned with `ExtractionFrequency` in
 * `src/augments/layeredMemory/extractor/frequency.ts` — kept duplicated
 * here to avoid pulling augment runtime imports into the CLI parser.
 */
const VALID_EXTRACTION_FREQUENCIES = new Set([
  "every-turn",
  "every-N-turns",
  "session-end-only",
  "never",
]);

/**
 * Validate the per-trust-level extractionFrequency map. Rejects flat
 * `"public.recognized"`-style keys (per Codex 2nd-pass High-2 — the
 * runtime taxonomy is two fields, never a colon/dot-joined string) and
 * unknown frequency values. The nested shape mirrors Decision 3 of the
 * memorist design.
 */
function validateExtractionFrequency(ef: unknown, prefix: string, errors: string[]): void {
  if (ef === null || typeof ef !== "object" || Array.isArray(ef)) {
    errors.push(`${prefix}: must be an object`);
    return;
  }
  const e = ef as Record<string, unknown>;

  // Reject flat keys like "public.recognized" — they look like nested
  // accessors but the runtime trust enum has two distinct fields. A flat
  // key would silently fall through validation since the code below only
  // checks the recognized top-level keys.
  for (const key of Object.keys(e)) {
    if (key.includes(".")) {
      errors.push(
        `${prefix}: flat key "${key}" not supported; use nested shape (public: { recognized: ..., anonymous: ... })`,
      );
    }
  }

  for (const k of ["creator", "agent"] as const) {
    if (e[k] !== undefined && !VALID_EXTRACTION_FREQUENCIES.has(e[k] as string)) {
      errors.push(
        `${prefix}.${k}: invalid frequency "${String(e[k])}" (expected one of: ${[...VALID_EXTRACTION_FREQUENCIES].join(", ")})`,
      );
    }
  }

  if (e.public !== undefined) {
    if (e.public === null || typeof e.public !== "object" || Array.isArray(e.public)) {
      errors.push(`${prefix}.public: must be an object with recognized + anonymous keys`);
    } else {
      const p = e.public as Record<string, unknown>;
      for (const sub of ["recognized", "anonymous"] as const) {
        if (p[sub] !== undefined && !VALID_EXTRACTION_FREQUENCIES.has(p[sub] as string)) {
          errors.push(
            `${prefix}.public.${sub}: invalid frequency "${String(p[sub])}" (expected one of: ${[...VALID_EXTRACTION_FREQUENCIES].join(", ")})`,
          );
        }
      }
    }
  }
}

/**
 * Validate the options block for a layeredMemory augment.
 *
 * Currently scoped to the optional `autoSave` block (PR β / ADR-018
 * Phase 2). Other layered-memory options (backend, namespace, dbPath,
 * retentionDays) are validated only by the augment factory at boot —
 * adding parser-level checks for them is out of PR β's scope.
 */
function validateLayeredMemoryOptions(
  opts: Record<string, unknown>,
  optionsPrefix: string,
  errors: string[],
): void {
  if (opts.autoSave === undefined) return;
  if (opts.autoSave === null || typeof opts.autoSave !== "object" || Array.isArray(opts.autoSave)) {
    errors.push(`${optionsPrefix}.autoSave: must be an object`);
    return;
  }
  const a = opts.autoSave as Record<string, unknown>;

  if (a.enabled !== undefined && typeof a.enabled !== "boolean") {
    errors.push(`${optionsPrefix}.autoSave.enabled: must be a boolean`);
  }
  if (a.everyNTurns !== undefined) {
    if (typeof a.everyNTurns !== "number" || a.everyNTurns <= 0) {
      errors.push(`${optionsPrefix}.autoSave.everyNTurns: must be a positive number`);
    }
  }
  if (a.confidenceThreshold !== undefined) {
    if (
      typeof a.confidenceThreshold !== "number" ||
      a.confidenceThreshold < 0 ||
      a.confidenceThreshold > 1
    ) {
      errors.push(
        `${optionsPrefix}.autoSave.confidenceThreshold: must be a number between 0 and 1`,
      );
    }
  }
  if (a.promptTemplate !== undefined && typeof a.promptTemplate !== "string") {
    errors.push(`${optionsPrefix}.autoSave.promptTemplate: must be a string (path to file)`);
  }
  if (a.extractionFrequency !== undefined) {
    validateExtractionFrequency(
      a.extractionFrequency,
      `${optionsPrefix}.autoSave.extractionFrequency`,
      errors,
    );
  }
  if (a.bufferLimits !== undefined) {
    const prefix = `${optionsPrefix}.autoSave.bufferLimits`;
    if (
      a.bufferLimits === null ||
      typeof a.bufferLimits !== "object" ||
      Array.isArray(a.bufferLimits)
    ) {
      errors.push(`${prefix}: must be an object`);
    } else {
      const configured = a.bufferLimits as Record<string, unknown>;
      const knownKeys = Object.keys(DEFAULT_EXTRACTION_BUFFER_LIMITS);
      for (const key of Object.keys(configured)) {
        if (!knownKeys.includes(key)) errors.push(`${prefix}.${key}: unknown buffer limit`);
      }
      const resolved = { ...DEFAULT_EXTRACTION_BUFFER_LIMITS };
      for (const key of knownKeys) {
        const value = configured[key];
        if (value === undefined) continue;
        if (!Number.isSafeInteger(value) || (value as number) < 1) {
          errors.push(`${prefix}.${key}: must be a positive safe integer`);
          continue;
        }
        resolved[key as keyof typeof resolved] = value as number;
      }
      if (resolved.maxBytesPerThread > resolved.maxBytesPerPeer) {
        errors.push(`${prefix}: maxBytesPerThread cannot exceed maxBytesPerPeer`);
      }
      if (resolved.maxBytesPerPeer > resolved.maxTotalBytes) {
        errors.push(`${prefix}: maxBytesPerPeer cannot exceed maxTotalBytes`);
      }
    }
  }
}

/**
 * Validate the options block for a link augment (peer-to-peer A2A v0.2).
 *
 * Shape:
 *   {
 *     port?, dbPath, agentCard: {...},
 *     peers?: { name: {...} },            // inline (fallback / dev path)
 *     peerSource?: { type: "registry", url, cacheSeconds? }  // remote fetch
 *   }
 *
 * Both `peers` and `peerSource` are optional. When both are present,
 * `peerSource` is the primary source and `peers` becomes the fallback if
 * the registry fetch fails. When neither is present, the augment runs in
 * inbound-only mode (no outbound peers configured).
 */
function validateLinkOptions(
  opts: Record<string, unknown>,
  optionsPrefix: string,
  errors: string[],
): void {
  if (
    opts.port !== undefined &&
    (!Number.isSafeInteger(opts.port) ||
      (opts.port as number) < 1 ||
      (opts.port as number) > 65_535)
  ) {
    errors.push(`${optionsPrefix}.port: must be an integer from 1 to 65535`);
  }
  if (typeof opts.dbPath !== "string" || opts.dbPath.length === 0) {
    errors.push(`${optionsPrefix}.dbPath: required non-empty string`);
  }

  const card = opts.agentCard;
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    errors.push(`${optionsPrefix}.agentCard: required object`);
  } else {
    const c = card as Record<string, unknown>;
    for (const field of ["id", "name", "description", "endpointUrl"] as const) {
      if (typeof c[field] !== "string" || (c[field] as string).length === 0) {
        errors.push(`${optionsPrefix}.agentCard.${field}: required non-empty string`);
      }
    }
    if (c.capabilities !== undefined) {
      if (
        !Array.isArray(c.capabilities) ||
        (c.capabilities as unknown[]).some((v) => typeof v !== "string")
      ) {
        errors.push(`${optionsPrefix}.agentCard.capabilities: must be an array of strings`);
      }
    }
  }

  const peers = opts.peers;
  if (peers !== undefined) {
    if (!peers || typeof peers !== "object" || Array.isArray(peers)) {
      errors.push(`${optionsPrefix}.peers: must be an object keyed by peer name`);
    } else {
      for (const [name, value] of Object.entries(peers as Record<string, unknown>)) {
        const peerPrefix = `${optionsPrefix}.peers.${name}`;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          errors.push(`${peerPrefix}: must be an object`);
          continue;
        }
        const p = value as Record<string, unknown>;
        for (const field of [
          "url",
          "bearer",
          "participantId",
          "inboundBearer",
          "inboundBearerId",
        ] as const) {
          if (typeof p[field] !== "string" || (p[field] as string).length === 0) {
            errors.push(`${peerPrefix}.${field}: required non-empty string`);
          }
        }
        if (p.purpose !== undefined && typeof p.purpose !== "string") {
          errors.push(`${peerPrefix}.purpose: must be a string`);
        }
        if (
          p.examples !== undefined &&
          (!Array.isArray(p.examples) || p.examples.some((example) => typeof example !== "string"))
        ) {
          errors.push(`${peerPrefix}.examples: must be an array of strings`);
        }
      }
    }
  }

  const peerSource = opts.peerSource;
  if (peerSource !== undefined) {
    if (!peerSource || typeof peerSource !== "object" || Array.isArray(peerSource)) {
      errors.push(`${optionsPrefix}.peerSource: must be an object`);
    } else {
      const ps = peerSource as Record<string, unknown>;
      for (const key of Object.keys(ps)) {
        if (key !== "type" && key !== "url" && key !== "cacheSeconds" && key !== "pins") {
          errors.push(`${optionsPrefix}.peerSource.${key}: unknown option`);
        }
      }
      if (ps.type !== "registry") {
        errors.push(
          `${optionsPrefix}.peerSource.type: must be "registry" (no other source types at v1)`,
        );
      }
      if (typeof ps.url !== "string" || (ps.url as string).length === 0) {
        errors.push(`${optionsPrefix}.peerSource.url: required non-empty string`);
      }
      if (
        ps.cacheSeconds !== undefined &&
        (typeof ps.cacheSeconds !== "number" || ps.cacheSeconds < 1)
      ) {
        errors.push(
          `${optionsPrefix}.peerSource.cacheSeconds: must be a positive number (seconds)`,
        );
      }
      if (
        !ps.pins ||
        typeof ps.pins !== "object" ||
        Array.isArray(ps.pins) ||
        Object.keys(ps.pins).length === 0
      ) {
        errors.push(
          `${optionsPrefix}.peerSource.pins: required non-empty peer-name to endpoint/participant object`,
        );
      } else {
        for (const [name, value] of Object.entries(ps.pins as Record<string, unknown>)) {
          const pinPrefix = `${optionsPrefix}.peerSource.pins.${name || "<empty>"}`;
          if (name.length === 0 || !value || typeof value !== "object" || Array.isArray(value)) {
            errors.push(`${pinPrefix}: must be an endpoint/participant object`);
            continue;
          }
          const pin = value as Record<string, unknown>;
          if (Object.keys(pin).some((key) => key !== "url" && key !== "participantId")) {
            errors.push(`${pinPrefix}: unknown option`);
          }
          if (typeof pin.url !== "string" || pin.url.length === 0) {
            errors.push(`${pinPrefix}.url: required non-empty string`);
          }
          if (typeof pin.participantId !== "string" || pin.participantId.length === 0) {
            errors.push(`${pinPrefix}.participantId: required non-empty string`);
          }
        }
      }
    }
  }

  const outbound = opts.outbound;
  if (outbound !== undefined) {
    if (!outbound || typeof outbound !== "object" || Array.isArray(outbound)) {
      errors.push(`${optionsPrefix}.outbound: must be an object`);
    } else {
      const policy = outbound as Record<string, unknown>;
      for (const key of Object.keys(policy)) {
        if (key !== "allowedTrustLevels" && key !== "publicDelegationPeers") {
          errors.push(`${optionsPrefix}.outbound.${key}: unknown option`);
        }
      }
      const levels = policy.allowedTrustLevels;
      if (!Array.isArray(levels) || levels.length === 0) {
        errors.push(`${optionsPrefix}.outbound.allowedTrustLevels: must be a non-empty array`);
      } else {
        const seen = new Set<string>();
        for (let index = 0; index < levels.length; index++) {
          const level = levels[index];
          if (level !== "creator" && level !== "agent" && level !== "public") {
            errors.push(
              `${optionsPrefix}.outbound.allowedTrustLevels[${index}]: must be "creator", "agent", or "public"`,
            );
          } else if (seen.has(level)) {
            errors.push(
              `${optionsPrefix}.outbound.allowedTrustLevels[${index}]: duplicate "${level}"`,
            );
          } else {
            seen.add(level);
          }
        }
      }

      const publicPeers = policy.publicDelegationPeers;
      if (publicPeers !== undefined) {
        if (
          !publicPeers ||
          typeof publicPeers !== "object" ||
          Array.isArray(publicPeers) ||
          Object.keys(publicPeers).length === 0
        ) {
          errors.push(
            `${optionsPrefix}.outbound.publicDelegationPeers: must be a non-empty peer-name to endpoint/participant object`,
          );
        } else {
          for (const [peer, value] of Object.entries(publicPeers as Record<string, unknown>)) {
            if (peer.length === 0 || !value || typeof value !== "object" || Array.isArray(value)) {
              errors.push(
                `${optionsPrefix}.outbound.publicDelegationPeers.${peer || "<empty>"}: must be an endpoint/participant object`,
              );
              continue;
            }
            const binding = value as Record<string, unknown>;
            if (Object.keys(binding).some((key) => key !== "url" && key !== "participantId")) {
              errors.push(
                `${optionsPrefix}.outbound.publicDelegationPeers.${peer}: unknown option`,
              );
            }
            if (typeof binding.url !== "string" || binding.url.length === 0) {
              errors.push(
                `${optionsPrefix}.outbound.publicDelegationPeers.${peer}.url: required non-empty string`,
              );
            }
            if (typeof binding.participantId !== "string" || binding.participantId.length === 0) {
              errors.push(
                `${optionsPrefix}.outbound.publicDelegationPeers.${peer}.participantId: required non-empty string`,
              );
            }
          }
        }
      }
      const permitsPublic = Array.isArray(levels) && levels.includes("public");
      const hasPublicPeerBindings =
        publicPeers !== null &&
        typeof publicPeers === "object" &&
        !Array.isArray(publicPeers) &&
        Object.keys(publicPeers).length > 0;
      if (permitsPublic && !hasPublicPeerBindings) {
        errors.push(
          `${optionsPrefix}.outbound.publicDelegationPeers: required when public trust is allowed`,
        );
      } else if (!permitsPublic && publicPeers !== undefined) {
        errors.push(
          `${optionsPrefix}.outbound.publicDelegationPeers: requires public in allowedTrustLevels`,
        );
      } else if (permitsPublic && hasPublicPeerBindings && peerSource === undefined) {
        const configuredPeers =
          peers && typeof peers === "object" && !Array.isArray(peers)
            ? (peers as Record<string, unknown>)
            : {};
        for (const [peer, value] of Object.entries(publicPeers as Record<string, unknown>)) {
          const configured = configuredPeers[peer] as Record<string, unknown> | undefined;
          const binding = value as Record<string, unknown>;
          if (!configured) {
            errors.push(
              `${optionsPrefix}.outbound.publicDelegationPeers: unknown inline peer "${peer}"`,
            );
          } else if (
            configured.participantId !== binding.participantId ||
            configured.url !== binding.url
          ) {
            errors.push(
              `${optionsPrefix}.outbound.publicDelegationPeers.${peer}: must match the inline peer url and participantId`,
            );
          }
        }
      } else if (permitsPublic && hasPublicPeerBindings && peerSource !== undefined) {
        const source =
          peerSource && typeof peerSource === "object" && !Array.isArray(peerSource)
            ? (peerSource as Record<string, unknown>)
            : {};
        const pins =
          source.pins && typeof source.pins === "object" && !Array.isArray(source.pins)
            ? (source.pins as Record<string, unknown>)
            : {};
        for (const [peer, value] of Object.entries(publicPeers as Record<string, unknown>)) {
          const binding = value as Record<string, unknown>;
          const pin = pins[peer] as Record<string, unknown> | undefined;
          if (!pin || pin.participantId !== binding.participantId || pin.url !== binding.url) {
            errors.push(
              `${optionsPrefix}.outbound.publicDelegationPeers.${peer}: must match the peerSource endpoint and participant pin`,
            );
          }
        }
      }
    }
  }
}

/**
 * Validate the options block for a notify augment.
 */
function validateNotifyOptions(
  opts: Record<string, unknown>,
  prefix: string,
  errors: string[],
): void {
  const maxRetainedWindowMs = 30 * 24 * 60 * 60_000;
  if (
    opts.dbPath !== undefined &&
    (typeof opts.dbPath !== "string" || opts.dbPath.trim().length === 0)
  ) {
    errors.push(`${prefix}.dbPath: must be a non-empty string`);
  }
  if (!Array.isArray(opts.destinations)) {
    errors.push(`${prefix}.destinations: required array`);
    return;
  }
  if (opts.destinations.length === 0) {
    errors.push(`${prefix}.destinations: must have at least one destination`);
  }

  const seenNames = new Set<string>();
  for (let i = 0; i < opts.destinations.length; i++) {
    const dest = opts.destinations[i] as Record<string, unknown>;
    const dPrefix = `${prefix}.destinations[${i}]`;
    if (typeof dest.name !== "string" || !dest.name) {
      errors.push(`${dPrefix}.name: required string`);
      continue;
    }
    if (seenNames.has(dest.name)) {
      errors.push(`${dPrefix}.name: duplicate name "${dest.name}"`);
    }
    seenNames.add(dest.name);

    if (dest.allowedTrustLevels !== undefined) {
      const allowed = dest.allowedTrustLevels;
      if (!Array.isArray(allowed) || allowed.length === 0) {
        errors.push(`${dPrefix}.allowedTrustLevels: must be a non-empty array`);
      } else {
        const validTrustLevels = new Set(["creator", "agent", "public"]);
        for (let j = 0; j < allowed.length; j++) {
          if (typeof allowed[j] !== "string" || !validTrustLevels.has(allowed[j])) {
            errors.push(
              `${dPrefix}.allowedTrustLevels[${j}]: must be "creator", "agent", or "public"`,
            );
          }
        }
      }
    }
    if (dest.rateLimit !== undefined) {
      if (typeof dest.rateLimit !== "object" || dest.rateLimit === null) {
        errors.push(`${dPrefix}.rateLimit: must be an object`);
      } else {
        const destinationRateLimit = dest.rateLimit as Record<string, unknown>;
        for (const field of ["maxPerHour", "cooldownMs"] as const) {
          const value = destinationRateLimit[field];
          if (value !== undefined && (typeof value !== "number" || value < 0)) {
            errors.push(`${dPrefix}.rateLimit.${field}: must be a non-negative number`);
          }
        }
        if (
          typeof destinationRateLimit.cooldownMs === "number" &&
          destinationRateLimit.cooldownMs > maxRetainedWindowMs
        ) {
          errors.push(`${dPrefix}.rateLimit.cooldownMs: cannot exceed 30 days`);
        }
      }
    }
    if (
      dest.publicPolicy !== undefined &&
      dest.publicPolicy !== "allowed" &&
      dest.publicPolicy !== "escalation-only"
    ) {
      errors.push(`${dPrefix}.publicPolicy: must be "allowed" or "escalation-only"`);
    }

    if (dest.transport === "webhook") {
      if (typeof dest.url !== "string" || !dest.url) {
        errors.push(`${dPrefix}.url: required string for webhook transport`);
      }
      if (
        dest.headers !== undefined &&
        (typeof dest.headers !== "object" ||
          dest.headers === null ||
          Array.isArray(dest.headers) ||
          Object.values(dest.headers).some((value) => typeof value !== "string"))
      ) {
        errors.push(`${dPrefix}.headers: must be an object of strings`);
      }
      if (
        dest.allowInsecureHttpWithCredentials !== undefined &&
        typeof dest.allowInsecureHttpWithCredentials !== "boolean"
      ) {
        errors.push(`${dPrefix}.allowInsecureHttpWithCredentials: must be a boolean`);
      }
    } else if (dest.transport === "telegram") {
      if (typeof dest.botToken !== "string" || !dest.botToken) {
        errors.push(`${dPrefix}.botToken: required string for telegram transport`);
      }
      if (
        dest.chatId == null ||
        (typeof dest.chatId !== "string" && typeof dest.chatId !== "number")
      ) {
        errors.push(`${dPrefix}.chatId: required string or number for telegram transport`);
      }
    } else if (dest.transport === "agentmail") {
      if (typeof dest.apiKey !== "string" || !dest.apiKey) {
        errors.push(`${dPrefix}.apiKey: required string for agentmail transport`);
      }
      if (typeof dest.inboxId !== "string" || !dest.inboxId) {
        errors.push(`${dPrefix}.inboxId: required string for agentmail transport`);
      }
      if (dest.to == null || (typeof dest.to !== "string" && !Array.isArray(dest.to))) {
        errors.push(`${dPrefix}.to: required string or array for agentmail transport`);
      }
    } else if (dest.transport === "log-to-file") {
      if (typeof dest.path !== "string" || !dest.path) {
        errors.push(`${dPrefix}.path: required string for log-to-file transport`);
      }
    } else {
      errors.push(
        `${dPrefix}.transport: must be "webhook", "telegram", "agentmail", or "log-to-file"`,
      );
    }
  }

  if (opts.rateLimit !== undefined) {
    const rl = opts.rateLimit as Record<string, unknown>;
    const numericFields = [
      "cooldownMs",
      "globalMaxPerHour",
      "dedupWindowMs",
      "dedupThreshold",
      "perPeerCooldownMs",
    ] as const;
    for (const field of numericFields) {
      if (rl[field] !== undefined && (typeof rl[field] !== "number" || (rl[field] as number) < 0)) {
        errors.push(`${prefix}.rateLimit.${field}: must be a non-negative number`);
      }
    }
    for (const field of ["cooldownMs", "dedupWindowMs", "perPeerCooldownMs"] as const) {
      if (typeof rl[field] === "number" && rl[field] > maxRetainedWindowMs) {
        errors.push(`${prefix}.rateLimit.${field}: cannot exceed 30 days`);
      }
    }
    if (rl.enabled !== undefined && typeof rl.enabled !== "boolean") {
      errors.push(`${prefix}.rateLimit.enabled: must be a boolean`);
    }
  }
}

/** Single source of truth for the AgentMail inbound mode discriminator. */
const AGENT_MAIL_INBOUND_MODES = new Set(["none", "websocket", "polling", "webhook"]);
const VALID_TRUST_LEVELS = new Set(["creator", "agent", "public"]);

function validateAgentMailOptions(
  opts: Record<string, unknown>,
  prefix: string,
  errors: string[],
): void {
  if (typeof opts.apiKey !== "string" || !opts.apiKey) {
    errors.push(`${prefix}.apiKey: required string (set AGENTMAIL_API_KEY in .env)`);
  }
  if (typeof opts.inboxId !== "string" || !opts.inboxId) {
    errors.push(`${prefix}.inboxId: required string (set AGENTMAIL_INBOX_ID in .env)`);
  }
  if (opts.emailAddress !== undefined) {
    if (typeof opts.emailAddress !== "string" || !isWellFormedEmail(opts.emailAddress)) {
      errors.push(`${prefix}.emailAddress: must be a well-formed email address`);
    }
  }
  if (
    opts.addressVisibility !== undefined &&
    opts.addressVisibility !== "creator" &&
    opts.addressVisibility !== "public"
  ) {
    errors.push(`${prefix}.addressVisibility: must be "creator" or "public"`);
  }

  if (opts.outbound !== undefined) {
    if (typeof opts.outbound !== "object" || opts.outbound === null) {
      errors.push(`${prefix}.outbound: must be an object`);
    } else {
      const out = opts.outbound as Record<string, unknown>;

      if (out.allowedTrustLevels !== undefined) {
        if (!Array.isArray(out.allowedTrustLevels)) {
          errors.push(`${prefix}.outbound.allowedTrustLevels: must be an array`);
        } else {
          for (let i = 0; i < out.allowedTrustLevels.length; i++) {
            const lvl = out.allowedTrustLevels[i];
            if (typeof lvl !== "string" || !VALID_TRUST_LEVELS.has(lvl)) {
              errors.push(
                `${prefix}.outbound.allowedTrustLevels[${i}]: must be one of "creator", "agent", "public" (got ${JSON.stringify(lvl)})`,
              );
            }
          }
        }
      }

      if (out.allowedRecipients !== undefined) {
        if (!Array.isArray(out.allowedRecipients)) {
          errors.push(`${prefix}.outbound.allowedRecipients: must be an array`);
        } else {
          for (let i = 0; i < out.allowedRecipients.length; i++) {
            const r = out.allowedRecipients[i];
            if (typeof r !== "string" || r.length === 0) {
              errors.push(
                `${prefix}.outbound.allowedRecipients[${i}]: must be a non-empty string (email or "*@domain")`,
              );
            }
          }
        }
      }

      const numericFields = ["maxRecipients", "bodyMaxBytes"] as const;
      for (const field of numericFields) {
        if (
          out[field] !== undefined &&
          (typeof out[field] !== "number" || (out[field] as number) <= 0)
        ) {
          errors.push(`${prefix}.outbound.${field}: must be a positive number`);
        }
      }

      if (out.subjectPrefix !== undefined) {
        if (typeof out.subjectPrefix !== "string") {
          errors.push(`${prefix}.outbound.subjectPrefix: must be a string`);
        } else if (out.subjectPrefix.length === 0) {
          errors.push(`${prefix}.outbound.subjectPrefix: cannot be the empty string`);
        }
      }

      if (out.allowHtml !== undefined && typeof out.allowHtml !== "boolean") {
        errors.push(`${prefix}.outbound.allowHtml: must be a boolean`);
      }

      if (out.rateLimit !== undefined) {
        if (typeof out.rateLimit !== "object" || out.rateLimit === null) {
          errors.push(`${prefix}.outbound.rateLimit: must be an object`);
        } else {
          const rl = out.rateLimit as Record<string, unknown>;
          const rlNumeric = [
            "globalMaxPerHour",
            "perRecipientCooldownMs",
            "dedupWindowMs",
          ] as const;
          for (const field of rlNumeric) {
            if (
              rl[field] !== undefined &&
              (typeof rl[field] !== "number" || (rl[field] as number) < 0)
            ) {
              errors.push(`${prefix}.outbound.rateLimit.${field}: must be a non-negative number`);
            }
          }
          if (rl.enabled !== undefined && typeof rl.enabled !== "boolean") {
            errors.push(`${prefix}.outbound.rateLimit.enabled: must be a boolean`);
          }
        }
      }

      if (out.humanReview !== undefined) {
        if (typeof out.humanReview !== "object" || out.humanReview === null) {
          errors.push(`${prefix}.outbound.humanReview: must be an object`);
        } else {
          const review = out.humanReview as Record<string, unknown>;
          if (review.requiredForTrustLevels !== undefined) {
            if (!Array.isArray(review.requiredForTrustLevels)) {
              errors.push(
                `${prefix}.outbound.humanReview.requiredForTrustLevels: must be an array`,
              );
            } else {
              for (let i = 0; i < review.requiredForTrustLevels.length; i++) {
                const level = review.requiredForTrustLevels[i];
                if (typeof level !== "string" || !VALID_TRUST_LEVELS.has(level)) {
                  errors.push(
                    `${prefix}.outbound.humanReview.requiredForTrustLevels[${i}]: must be one of "creator", "agent", "public" (got ${JSON.stringify(level)})`,
                  );
                }
              }
            }
          }
          if (
            review.expiresAfterMs !== undefined &&
            (typeof review.expiresAfterMs !== "number" ||
              !Number.isSafeInteger(review.expiresAfterMs) ||
              review.expiresAfterMs <= 0 ||
              review.expiresAfterMs > 30 * 24 * 60 * 60_000)
          ) {
            errors.push(
              `${prefix}.outbound.humanReview.expiresAfterMs: must be between 1 and 2592000000`,
            );
          }
        }
      }
    }
  }

  if (opts.inbound !== undefined) {
    if (typeof opts.inbound !== "object" || opts.inbound === null) {
      errors.push(`${prefix}.inbound: must be an object with a "mode" field`);
    } else {
      const inb = opts.inbound as Record<string, unknown>;
      const mode = inb.mode;
      if (typeof mode !== "string") {
        errors.push(`${prefix}.inbound.mode: required string`);
      } else if (!AGENT_MAIL_INBOUND_MODES.has(mode)) {
        errors.push(
          `${prefix}.inbound.mode: unknown mode "${mode}" — valid modes are ${[...AGENT_MAIL_INBOUND_MODES].map((m) => `"${m}"`).join(", ")}`,
        );
      } else if (mode !== "none") {
        if (!Array.isArray(inb.allowedSenders) || inb.allowedSenders.length === 0) {
          errors.push(
            `${prefix}.inbound.allowedSenders: required non-empty array when inbound is enabled`,
          );
        } else {
          for (let i = 0; i < inb.allowedSenders.length; i++) {
            if (typeof inb.allowedSenders[i] !== "string" || inb.allowedSenders[i].length === 0) {
              errors.push(`${prefix}.inbound.allowedSenders[${i}]: must be a non-empty string`);
            }
          }
        }
        for (const field of ["pollIntervalMs", "maxPromptBytes", "maxAttempts"] as const) {
          if (
            inb[field] !== undefined &&
            (typeof inb[field] !== "number" ||
              !Number.isSafeInteger(inb[field]) ||
              (inb[field] as number) <= 0)
          ) {
            errors.push(`${prefix}.inbound.${field}: must be a positive integer`);
          }
        }
        if (typeof inb.maxPromptBytes === "number" && inb.maxPromptBytes < 512) {
          errors.push(`${prefix}.inbound.maxPromptBytes: must be at least 512`);
        }
        if (inb.classifications !== undefined) {
          if (typeof inb.classifications !== "object" || inb.classifications === null) {
            errors.push(`${prefix}.inbound.classifications: must be an object`);
          } else {
            const classifications = inb.classifications as Record<string, unknown>;
            for (const field of ["received", "spam", "blocked", "unauthenticated"] as const) {
              const action = classifications[field];
              if (action !== undefined && action !== "process" && action !== "discard") {
                errors.push(
                  `${prefix}.inbound.classifications.${field}: must be "process" or "discard"`,
                );
              }
            }
          }
        }
        if (mode === "webhook") {
          if (typeof inb.webhook !== "object" || inb.webhook === null) {
            errors.push(`${prefix}.inbound.webhook: required object when mode is "webhook"`);
          } else {
            const webhook = inb.webhook as Record<string, unknown>;
            if (
              webhook.path !== undefined &&
              (typeof webhook.path !== "string" || !webhook.path.startsWith("/"))
            ) {
              errors.push(`${prefix}.inbound.webhook.path: must start with "/"`);
            }
            if (
              webhook.secretEnv !== undefined &&
              (typeof webhook.secretEnv !== "string" || webhook.secretEnv.length === 0)
            ) {
              errors.push(`${prefix}.inbound.webhook.secretEnv: must be a non-empty string`);
            }
            if (
              webhook.timestampToleranceSeconds !== undefined &&
              (typeof webhook.timestampToleranceSeconds !== "number" ||
                !Number.isFinite(webhook.timestampToleranceSeconds) ||
                webhook.timestampToleranceSeconds <= 0 ||
                webhook.timestampToleranceSeconds > 300)
            ) {
              errors.push(
                `${prefix}.inbound.webhook.timestampToleranceSeconds: must be between 1 and 300`,
              );
            }
          }
        } else if (inb.webhook !== undefined) {
          errors.push(`${prefix}.inbound.webhook: only valid when mode is "webhook"`);
        }
      }
    }
  }
}

/**
 * Validate the options block for a telegramTransport augment.
 * Enforces mode mutual exclusion: polling block is forbidden when mode=webhook
 * and vice versa.
 */
function validateTelegramTransportOptions(
  opts: Record<string, unknown>,
  prefix: string,
  errors: string[],
): void {
  if (typeof opts.botToken !== "string" || !opts.botToken) {
    errors.push(`${prefix}.botToken: required string`);
  }
  if (opts.replay !== undefined) {
    if (opts.replay === null || typeof opts.replay !== "object" || Array.isArray(opts.replay)) {
      errors.push(`${prefix}.replay: must be an object`);
    } else {
      const replay = opts.replay as Record<string, unknown>;
      if (replay.store !== undefined) {
        errors.push(
          `${prefix}.replay.store: executable replay stores cannot be configured in YAML; construct telegramTransport programmatically`,
        );
      }
      if (
        replay.dbPath !== undefined &&
        (typeof replay.dbPath !== "string" || replay.dbPath.trim().length === 0)
      ) {
        errors.push(`${prefix}.replay.dbPath: must be a non-empty string`);
      }
      if (
        replay.namespace !== undefined &&
        (typeof replay.namespace !== "string" ||
          replay.namespace.length === 0 ||
          replay.namespace.length > 256)
      ) {
        errors.push(`${prefix}.replay.namespace: must contain 1 to 256 characters`);
      }
      for (const field of ["retentionMs", "maxEntries", "claimTimeoutMs"] as const) {
        if (
          replay[field] !== undefined &&
          (!Number.isSafeInteger(replay[field]) || (replay[field] as number) < 1)
        ) {
          errors.push(`${prefix}.replay.${field}: must be a positive integer`);
        }
      }
    }
  }

  const inbound = opts.inbound as Record<string, unknown> | undefined;
  if (!inbound || typeof inbound !== "object") {
    errors.push(`${prefix}.inbound: required object`);
    return;
  }
  const mode = inbound.mode;
  if (mode !== "polling" && mode !== "webhook") {
    errors.push(`${prefix}.inbound.mode: must be "polling" or "webhook"`);
  } else if (mode === "polling") {
    if (inbound.polling !== undefined) {
      const polling = inbound.polling as Record<string, unknown>;
      if (
        polling.timeoutSec !== undefined &&
        (typeof polling.timeoutSec !== "number" || polling.timeoutSec <= 0)
      ) {
        errors.push(`${prefix}.inbound.polling.timeoutSec: must be a positive number`);
      }
    }
    if (inbound.webhook !== undefined) {
      errors.push(`${prefix}.inbound: cannot set webhook block when mode is "polling"`);
    }
  } else if (mode === "webhook") {
    if (inbound.polling !== undefined) {
      errors.push(`${prefix}.inbound: cannot set polling block when mode is "webhook"`);
    }
    const webhook = inbound.webhook as Record<string, unknown> | undefined;
    if (!webhook || typeof webhook !== "object") {
      errors.push(`${prefix}.inbound.webhook: required object when mode is "webhook"`);
    } else {
      if (typeof webhook.publicUrl !== "string" || !webhook.publicUrl) {
        errors.push(`${prefix}.inbound.webhook.publicUrl: required string`);
      }
      if (
        typeof webhook.secretToken !== "string" ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(webhook.secretToken)
      ) {
        errors.push(
          `${prefix}.inbound.webhook.secretToken: must contain 1 to 256 letters, numbers, underscores, or hyphens`,
        );
      }
      if (
        webhook.port !== undefined &&
        (!Number.isSafeInteger(webhook.port) ||
          (webhook.port as number) < 1 ||
          (webhook.port as number) > 65_535)
      ) {
        errors.push(`${prefix}.inbound.webhook.port: must be an integer from 1 to 65535`);
      }
      if (
        webhook.maxBodyBytes !== undefined &&
        (!Number.isSafeInteger(webhook.maxBodyBytes) || (webhook.maxBodyBytes as number) < 1)
      ) {
        errors.push(`${prefix}.inbound.webhook.maxBodyBytes: must be a positive integer`);
      }
    }
  }

  const auth = opts.auth as Record<string, unknown> | undefined;
  if (auth === undefined || auth === null || typeof auth !== "object" || Array.isArray(auth)) {
    errors.push(`${prefix}.auth: required object`);
  } else {
    if (auth.creatorUserIds !== undefined) {
      if (!Array.isArray(auth.creatorUserIds)) {
        errors.push(`${prefix}.auth.creatorUserIds: must be an array of numbers`);
      } else {
        for (let i = 0; i < auth.creatorUserIds.length; i++) {
          if (typeof auth.creatorUserIds[i] !== "number") {
            errors.push(`${prefix}.auth.creatorUserIds[${i}]: must be a number`);
          }
        }
      }
    }
    if (
      auth.creatorUserIdsEnv !== undefined &&
      (typeof auth.creatorUserIdsEnv !== "string" || !auth.creatorUserIdsEnv)
    ) {
      errors.push(`${prefix}.auth.creatorUserIdsEnv: must be a non-empty string`);
    }
    if (auth.recognizedUserIds !== undefined) {
      if (!Array.isArray(auth.recognizedUserIds)) {
        errors.push(`${prefix}.auth.recognizedUserIds: must be an array of numbers`);
      } else {
        for (let i = 0; i < auth.recognizedUserIds.length; i++) {
          if (typeof auth.recognizedUserIds[i] !== "number") {
            errors.push(`${prefix}.auth.recognizedUserIds[${i}]: must be a number`);
          }
        }
      }
    }
    if (auth.admittedAgents !== undefined) {
      if (!Array.isArray(auth.admittedAgents)) {
        errors.push(`${prefix}.auth.admittedAgents: must be an array`);
      } else {
        for (let i = 0; i < auth.admittedAgents.length; i++) {
          const value = auth.admittedAgents[i];
          if (value === null || typeof value !== "object" || Array.isArray(value)) {
            errors.push(`${prefix}.auth.admittedAgents[${i}]: must be an object`);
            continue;
          }
          const a = value as Record<string, unknown>;
          if (typeof a.id !== "string" || !a.id) {
            errors.push(`${prefix}.auth.admittedAgents[${i}].id: required string`);
          }
          if (typeof a.telegramUserId !== "number") {
            errors.push(`${prefix}.auth.admittedAgents[${i}].telegramUserId: required number`);
          }
        }
      }
    }
    if (
      auth.anonymousIdentityMode !== undefined &&
      auth.anonymousIdentityMode !== "ephemeral" &&
      auth.anonymousIdentityMode !== "durable"
    ) {
      errors.push(`${prefix}.auth.anonymousIdentityMode: must be "ephemeral" or "durable"`);
    }
  }
}

/**
 * Validate the optional top-level `identity` shorthand field. Returns the
 * trimmed string when present and well-formed, undefined when absent. Any
 * malformed value (non-string, empty string) pushes an error and returns
 * undefined.
 */
function validateIdentityShorthand(raw: unknown, errors: string[]): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    errors.push(
      `identity: must be a non-empty string path to a markdown file (got ${Array.isArray(raw) ? "array" : raw === null ? "null" : typeof raw})`,
    );
    return undefined;
  }
  if (raw.length === 0) {
    errors.push("identity: must be a non-empty string path to a markdown file (got empty string)");
    return undefined;
  }
  // Trim before length check: a whitespace-only value would pass the
  // length-zero gate but produce a useless source path. Catch it at parse
  // time with a clear error rather than letting it fail later at boot
  // with an opaque file-memory load error.
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    errors.push(
      "identity: must be a non-empty string path to a markdown file (got whitespace-only string)",
    );
    return undefined;
  }
  return trimmed;
}

/**
 * Build the fileMemory config that backs the `identity:` shorthand. This keeps
 * `identity.md` first-class in agent.yaml while reusing the static-memory
 * primitive at runtime.
 */
function buildIdentityFileMemoryConfig(source: string): AugmentConfig {
  return {
    name: "identity",
    type: "fileMemory",
    options: {
      label: "self",
      source,
      mutable: false,
      origin: "operator",
      priority: "required",
      placement: "system",
      eviction: "never",
    },
  };
}

function normalizeRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

function loadAugmentFolderEntry(
  agentDir: string,
  id: string,
  prefix: string,
): Record<string, unknown> {
  if (!VALID_NAME_RE.test(id)) {
    throw new Error(
      `Invalid agent.yaml:\n  - ${prefix}: invalid augment id "${id}" (use letters, numbers, hyphens, or underscores)`,
    );
  }

  const augmentDir = join(agentDir, "augments", id);
  const metadataPath = join(augmentDir, "augment.yaml");
  const metadataLabel = relative(agentDir, metadataPath).replace(/\\/g, "/");
  if (!existsSync(metadataPath)) {
    throw new Error(
      `Invalid agent.yaml:\n  - ${prefix}: missing augment metadata at ${metadataLabel}`,
    );
  }

  const raw = readFileSync(metadataPath, "utf-8");
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${metadataLabel}: not a valid YAML object`);
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = interpolateEnvVars(parsed, `augments.${id}`) as Record<string, unknown>;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith("Missing environment variables:")) {
      throw new Error(augmentMissingEnvError(msg, metadataLabel, agentDir), { cause: err });
    }
    throw err;
  }

  const type = metadata.type;
  const config = metadata.config ?? {};
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Invalid ${metadataLabel}:\n  - config: must be an object when present`);
  }

  const out: Record<string, unknown> = {
    name: id,
    type,
    options: config,
    [AUGMENT_SOURCE_LABEL_FIELD]: metadataLabel,
  };

  if (typeof metadata.source === "string") {
    out.source = isAbsolute(metadata.source)
      ? metadata.source
      : normalizeRelativePath(relative(agentDir, resolve(augmentDir, metadata.source)));
  }

  return out;
}

export function expandAugmentFolderEntries(
  raw: Record<string, unknown>,
  agentDir: string,
): Record<string, unknown> {
  const augments = raw.augments;
  if (!Array.isArray(augments)) return raw;

  const expanded = augments.map((entry, index) => {
    if (typeof entry === "string") {
      return loadAugmentFolderEntry(agentDir, entry, `augments[${index}]`);
    }
    return entry;
  });

  return { ...raw, augments: expanded };
}

function validateConfig(raw: Record<string, unknown>): ParsedConfig {
  const errors: string[] = [];
  const topLevelFields = new Set([
    "id",
    "name",
    "displayName",
    "creator",
    "purpose",
    "identity",
    "engine",
    "settings",
    "augments",
    "securityEval",
  ]);
  for (const key of Object.keys(raw)) {
    if (!topLevelFields.has(key)) errors.push(`${key}: unknown top-level field`);
  }

  // Required top-level fields.
  if (typeof raw.id !== "string" || !AUG1_ID_RE.test(raw.id)) {
    errors.push(`id: must be a valid aug1_ UUID (got "${raw.id}")`);
  }
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    errors.push("name: required, non-empty string");
  } else if (!VALID_NAME_RE.test(raw.name)) {
    errors.push(`name: must be alphanumeric with hyphens/underscores (got "${raw.name}")`);
  }
  if (raw.displayName !== undefined) {
    if (typeof raw.displayName !== "string") {
      errors.push("displayName: must be a string");
    } else if (raw.displayName.trim().length === 0) {
      errors.push("displayName: must be a non-empty string when set");
    }
  }
  let creator: ParsedConfig["creator"] | undefined;
  if (raw.creator !== undefined) {
    if (typeof raw.creator !== "object" || raw.creator === null || Array.isArray(raw.creator)) {
      errors.push("creator: must be an object when set");
    } else {
      const rawCreator = raw.creator as Record<string, unknown>;
      if (rawCreator.displayName !== undefined) {
        if (typeof rawCreator.displayName !== "string") {
          errors.push("creator.displayName: must be a string");
        } else if (rawCreator.displayName.trim().length === 0) {
          errors.push("creator.displayName: must be a non-empty string when set");
        } else {
          creator = { displayName: rawCreator.displayName.trim() };
        }
      } else {
        creator = {};
      }
    }
  }

  // identity shorthand (optional) — backed by a fileMemory config prepended
  // to augments[]. Conflict detection happens after the augments array is
  // validated below.
  const identityShorthand = validateIdentityShorthand(raw.identity, errors);

  // Engine.
  const engine = raw.engine as Record<string, unknown> | undefined;
  if (!engine || typeof engine !== "object") {
    errors.push("engine: required object with provider and model");
  } else {
    if (typeof engine.provider !== "string") {
      errors.push("engine.provider: required string");
    } else if (!isKnownProvider(engine.provider)) {
      errors.push(
        `engine.provider: unknown provider "${engine.provider}" (supported: ${KNOWN_PROVIDERS.join(", ")})`,
      );
    }
    if (typeof engine.model !== "string") {
      errors.push("engine.model: required string");
    }
    if (engine.baseURL !== undefined) {
      if (typeof engine.baseURL !== "string") {
        errors.push("engine.baseURL: must be an absolute HTTP(S) URL");
      } else {
        try {
          const baseURL = new URL(engine.baseURL);
          if (
            (baseURL.protocol !== "http:" && baseURL.protocol !== "https:") ||
            baseURL.username.length > 0 ||
            baseURL.password.length > 0
          ) {
            errors.push(
              "engine.baseURL: must be an absolute HTTP(S) URL without embedded credentials",
            );
          }
        } catch {
          errors.push("engine.baseURL: must be an absolute HTTP(S) URL");
        }
      }
    }
    if (
      engine.allowInsecureHttpWithCredentials !== undefined &&
      typeof engine.allowInsecureHttpWithCredentials !== "boolean"
    ) {
      errors.push("engine.allowInsecureHttpWithCredentials: must be a boolean");
    }
    if (engine.reasoningEffort !== undefined) {
      if (
        typeof engine.reasoningEffort !== "string" ||
        !VALID_REASONING_EFFORTS.has(engine.reasoningEffort)
      ) {
        errors.push(
          `engine.reasoningEffort: must be one of ${[...VALID_REASONING_EFFORTS].join(", ")}`,
        );
      }
    }
    if (engine.providerRouting !== undefined) {
      if (
        typeof engine.providerRouting !== "object" ||
        engine.providerRouting === null ||
        Array.isArray(engine.providerRouting)
      ) {
        errors.push("engine.providerRouting: must be an object");
      } else if (engine.provider !== "openrouter") {
        errors.push("engine.providerRouting: only valid for provider 'openrouter'");
      } else {
        const r = engine.providerRouting as Record<string, unknown>;
        for (const key of Object.keys(r)) {
          if (!VALID_ROUTING_KEYS.has(key)) {
            errors.push(`engine.providerRouting.${key}: unknown routing option`);
          }
        }
        if (r.only !== undefined) {
          if (
            !Array.isArray(r.only) ||
            r.only.length === 0 ||
            r.only.length > 32 ||
            !r.only.every((v) => typeof v === "string" && PROVIDER_SLUG_PATTERN.test(v)) ||
            new Set(r.only).size !== r.only.length
          ) {
            errors.push(
              "engine.providerRouting.only: must contain 1 to 32 unique canonical lowercase base-provider slugs",
            );
          }
        }
        if (r.ignore !== undefined) {
          if (
            !Array.isArray(r.ignore) ||
            r.ignore.length === 0 ||
            r.ignore.length > 32 ||
            !r.ignore.every((v) => typeof v === "string" && PROVIDER_SLUG_PATTERN.test(v)) ||
            new Set(r.ignore).size !== r.ignore.length
          ) {
            errors.push(
              "engine.providerRouting.ignore: must contain 1 to 32 unique canonical lowercase base-provider slugs",
            );
          }
        }
        if (
          Array.isArray(r.only) &&
          Array.isArray(r.ignore) &&
          r.only.some((slug) => (r.ignore as unknown[]).includes(slug))
        ) {
          errors.push("engine.providerRouting: a provider cannot appear in both only and ignore");
        }
        if (
          r.sort !== undefined &&
          (typeof r.sort !== "string" || !VALID_ROUTING_SORTS.has(r.sort))
        ) {
          errors.push(
            `engine.providerRouting.sort: must be one of ${[...VALID_ROUTING_SORTS].join(", ")}`,
          );
        }
        if (r.max_price !== undefined) {
          if (
            typeof r.max_price !== "object" ||
            r.max_price === null ||
            Array.isArray(r.max_price)
          ) {
            errors.push("engine.providerRouting.max_price: must be an object");
          } else {
            const mp = r.max_price as Record<string, unknown>;
            for (const key of Object.keys(mp)) {
              if (key !== "prompt" && key !== "completion") {
                errors.push(`engine.providerRouting.max_price.${key}: unknown price option`);
              }
            }
            if (mp.prompt !== undefined && (typeof mp.prompt !== "number" || mp.prompt <= 0)) {
              errors.push("engine.providerRouting.max_price.prompt: must be a positive number");
            }
            if (
              mp.completion !== undefined &&
              (typeof mp.completion !== "number" || mp.completion <= 0)
            ) {
              errors.push("engine.providerRouting.max_price.completion: must be a positive number");
            }
          }
        }
      }
    }
    if (engine.responseLimits !== undefined) {
      if (
        typeof engine.responseLimits !== "object" ||
        engine.responseLimits === null ||
        Array.isArray(engine.responseLimits)
      ) {
        errors.push("engine.responseLimits: must be an object");
      } else {
        const responseLimits = engine.responseLimits as Record<string, unknown>;
        const allowed = new Set([
          "maxTextBytes",
          "maxToolCalls",
          "maxToolNameBytes",
          "maxToolArgumentBytes",
          "maxTotalToolArgumentBytes",
          "maxArgumentDepth",
          "maxArgumentNodes",
          "maxResponseBytes",
          "maxStreamEvents",
        ]);
        for (const [key, value] of Object.entries(responseLimits)) {
          if (!allowed.has(key)) {
            errors.push(`engine.responseLimits.${key}: unknown response limit`);
          } else if (!Number.isSafeInteger(value) || (value as number) < 1) {
            errors.push(`engine.responseLimits.${key}: must be a positive integer`);
          }
        }
        if (
          typeof responseLimits.maxToolArgumentBytes === "number" &&
          typeof responseLimits.maxTotalToolArgumentBytes === "number" &&
          responseLimits.maxToolArgumentBytes > responseLimits.maxTotalToolArgumentBytes
        ) {
          errors.push(
            "engine.responseLimits.maxToolArgumentBytes: cannot exceed maxTotalToolArgumentBytes",
          );
        }
        if (
          typeof responseLimits.maxTextBytes === "number" &&
          typeof responseLimits.maxResponseBytes === "number" &&
          responseLimits.maxTextBytes > responseLimits.maxResponseBytes
        ) {
          errors.push("engine.responseLimits.maxTextBytes: cannot exceed maxResponseBytes");
        }
      }
    }
    if (
      engine.requestTimeoutMs !== undefined &&
      (!Number.isSafeInteger(engine.requestTimeoutMs) ||
        (engine.requestTimeoutMs as number) < 1 ||
        (engine.requestTimeoutMs as number) > MAX_PROVIDER_REQUEST_TIMEOUT_MS)
    ) {
      errors.push(
        `engine.requestTimeoutMs: must be a positive integer no greater than ${MAX_PROVIDER_REQUEST_TIMEOUT_MS}`,
      );
    }
    if (engine.costOverride !== undefined) {
      if (
        typeof engine.costOverride !== "object" ||
        engine.costOverride === null ||
        Array.isArray(engine.costOverride)
      ) {
        errors.push("engine.costOverride: must be an object");
      } else {
        const co = engine.costOverride as Record<string, unknown>;
        if (
          typeof co.inputUsdPerMtok !== "number" ||
          !Number.isFinite(co.inputUsdPerMtok) ||
          co.inputUsdPerMtok < 0
        ) {
          errors.push("engine.costOverride.inputUsdPerMtok: must be a finite non-negative number");
        }
        if (
          typeof co.outputUsdPerMtok !== "number" ||
          !Number.isFinite(co.outputUsdPerMtok) ||
          co.outputUsdPerMtok < 0
        ) {
          errors.push("engine.costOverride.outputUsdPerMtok: must be a finite non-negative number");
        }
        // Optional cache rates — accepted for the Anthropic adapter (where they
        // contribute to costUsd) and for OpenAI/OpenRouter (where they're
        // accepted for type symmetry; those adapters warn at boot when set).
        if (co.cacheWriteUsdPerMtok !== undefined) {
          if (
            typeof co.cacheWriteUsdPerMtok !== "number" ||
            !Number.isFinite(co.cacheWriteUsdPerMtok) ||
            co.cacheWriteUsdPerMtok < 0
          ) {
            errors.push(
              "engine.costOverride.cacheWriteUsdPerMtok: must be a finite non-negative number",
            );
          }
        }
        if (co.cacheReadUsdPerMtok !== undefined) {
          if (
            typeof co.cacheReadUsdPerMtok !== "number" ||
            !Number.isFinite(co.cacheReadUsdPerMtok) ||
            co.cacheReadUsdPerMtok < 0
          ) {
            errors.push(
              "engine.costOverride.cacheReadUsdPerMtok: must be a finite non-negative number",
            );
          }
        }
      }
    }
    // Ollama-only fields: rejected for other providers so a yaml typo
    // (e.g. operator copies an ollama snippet into an anthropic agent)
    // surfaces at parse time, not silently as a dropped field.
    if (engine.keepAlive !== undefined) {
      if (engine.provider !== "ollama") {
        errors.push("engine.keepAlive: only valid for provider 'ollama'");
      } else if (typeof engine.keepAlive !== "string" && typeof engine.keepAlive !== "number") {
        errors.push(
          'engine.keepAlive: must be a duration string (e.g. "5m") or a number of seconds',
        );
      }
    }
    if (engine.options !== undefined) {
      if (engine.provider !== "ollama") {
        errors.push("engine.options: only valid for provider 'ollama'");
      } else if (
        typeof engine.options !== "object" ||
        engine.options === null ||
        Array.isArray(engine.options)
      ) {
        errors.push("engine.options: must be an object (native Ollama generation options)");
      }
    }
  }

  // Augments.
  const augments = raw.augments;
  if (!Array.isArray(augments) || augments.length === 0) {
    errors.push("augments: required non-empty array");
  } else {
    const names = new Set<string>();
    for (let i = 0; i < augments.length; i++) {
      const aug = augments[i] as Record<string, unknown>;
      const prefix = `augments[${i}]`;
      const sourceLabel =
        typeof aug[AUGMENT_SOURCE_LABEL_FIELD] === "string"
          ? (aug[AUGMENT_SOURCE_LABEL_FIELD] as string)
          : null;
      const entryPrefix = sourceLabel ?? prefix;
      const optionsPrefix = sourceLabel ? `${sourceLabel}.config` : `${prefix}.options`;
      const type = typeof aug.type === "string" ? aug.type : undefined;

      if (typeof type !== "string") {
        errors.push(`${entryPrefix}.type: required string`);
      } else if (!BUILTIN_TYPES.has(type) && type !== "custom") {
        errors.push(
          `${entryPrefix}.type: unknown type "${type}" (expected one of: ${[...BUILTIN_TYPES, "custom"].join(", ")})`,
        );
      }

      const hasExplicitName = typeof aug.name === "string" && aug.name.length > 0;
      const effectiveName =
        hasExplicitName || type === undefined || type === "custom" || !BUILTIN_TYPES.has(type)
          ? aug.name
          : type;
      if (!hasExplicitName && typeof effectiveName === "string") {
        aug.name = effectiveName;
      }

      if (typeof effectiveName !== "string" || effectiveName.length === 0) {
        errors.push(
          type === "custom"
            ? `${entryPrefix}.name: required for type "custom"`
            : `${entryPrefix}.name: required, non-empty string`,
        );
      } else if (!VALID_NAME_RE.test(effectiveName)) {
        errors.push(
          `${entryPrefix}.name: must be alphanumeric with hyphens/underscores (got "${effectiveName}")`,
        );
      } else if (names.has(effectiveName)) {
        errors.push(`${entryPrefix}.name: duplicate name "${effectiveName}"`);
      } else {
        names.add(effectiveName);
      }

      if (type === "custom" && typeof aug.source !== "string") {
        errors.push(`${entryPrefix}.source: required for type "custom"`);
      }

      if (type === "webTransport") {
        const webOpts = (aug.options ?? {}) as Record<string, unknown>;
        validateWebTransportOptions(webOpts, optionsPrefix, errors);
      } else if (type === "visitorAuth") {
        const visitorAuthOpts = (aug.options ?? {}) as Record<string, unknown>;
        validateVisitorAuthOptions(visitorAuthOpts, optionsPrefix, errors);
      } else if (type === "budgets") {
        const opts = (aug.options ?? {}) as Record<string, unknown>;
        validateBudgetsOptions(opts, optionsPrefix, errors);
      } else if (type === "notify") {
        const notifyOpts = (aug.options ?? {}) as Record<string, unknown>;
        validateNotifyOptions(notifyOpts, optionsPrefix, errors);
      } else if (type === "agentMail") {
        const amOpts = (aug.options ?? {}) as Record<string, unknown>;
        validateAgentMailOptions(amOpts, optionsPrefix, errors);
      } else if (type === "telegramTransport") {
        const tgOpts = (aug.options ?? {}) as Record<string, unknown>;
        validateTelegramTransportOptions(tgOpts, optionsPrefix, errors);
      } else if (type === "layeredMemory") {
        const lmOpts = (aug.options ?? {}) as Record<string, unknown>;
        validateLayeredMemoryOptions(lmOpts, optionsPrefix, errors);
      } else if (type === "link") {
        const linkOpts = (aug.options ?? {}) as Record<string, unknown>;
        validateLinkOptions(linkOpts, optionsPrefix, errors);
      }
    }

    const agentMailWebhookConfigured = augments.some((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const augment = entry as Record<string, unknown>;
      if (augment.type !== "agentMail") return false;
      const options = augment.options as Record<string, unknown> | undefined;
      const inbound = options?.inbound as Record<string, unknown> | undefined;
      return inbound?.mode === "webhook";
    });
    const agentMailReviewConfigured = augments.some((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const augment = entry as Record<string, unknown>;
      if (augment.type !== "agentMail") return false;
      const options = augment.options as Record<string, unknown> | undefined;
      const outbound = options?.outbound as Record<string, unknown> | undefined;
      const allowed = Array.isArray(outbound?.allowedTrustLevels)
        ? outbound.allowedTrustLevels
        : ["creator"];
      const humanReview = outbound?.humanReview as Record<string, unknown> | undefined;
      const reviewed = Array.isArray(humanReview?.requiredForTrustLevels)
        ? humanReview.requiredForTrustLevels
        : ["public"];
      const executableTrustLevels = new Set(["creator", ...allowed]);
      return reviewed.some((level) => executableTrustLevels.has(level));
    });
    const hasWebTransport = augments.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as Record<string, unknown>).type === "webTransport",
    );
    const hasAdminWebTransport = augments.some((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const augment = entry as Record<string, unknown>;
      if (augment.type !== "webTransport") return false;
      const options = augment.options as Record<string, unknown> | undefined;
      return options?.adminRoute !== false;
    });
    if (agentMailWebhookConfigured && !hasWebTransport) {
      errors.push(
        'agentMail inbound.mode "webhook" requires a webTransport augment to mount its verified HTTP route',
      );
    }
    if (agentMailReviewConfigured && !hasAdminWebTransport) {
      errors.push(
        "agentMail outbound human review requires a webTransport augment with adminRoute enabled for review decisions",
      );
    }
  }

  // Settings.
  let settings: Record<string, unknown> = {};
  if (raw.settings !== undefined) {
    if (typeof raw.settings !== "object" || raw.settings === null || Array.isArray(raw.settings)) {
      errors.push("settings: must be an object");
    } else {
      settings = raw.settings as Record<string, unknown>;
    }
  }
  if (settings.compactionStrategy && !VALID_COMPACTION.has(settings.compactionStrategy as string)) {
    errors.push(`settings.compactionStrategy: must be one of ${[...VALID_COMPACTION].join(", ")}`);
  }
  if (
    settings.maxInferenceLoops !== undefined &&
    (!Number.isSafeInteger(settings.maxInferenceLoops) ||
      (settings.maxInferenceLoops as number) < 1)
  ) {
    errors.push("settings.maxInferenceLoops: must be a positive integer");
  }
  if (settings.turnScheduling !== undefined) {
    if (
      typeof settings.turnScheduling !== "object" ||
      settings.turnScheduling === null ||
      Array.isArray(settings.turnScheduling)
    ) {
      errors.push("settings.turnScheduling: must be an object");
    } else {
      const scheduling = settings.turnScheduling as Record<string, unknown>;
      const constraints = {
        maxConcurrent: 1,
        maxQueued: 0,
        maxQueuedPerThread: 0,
        maxCausalDepth: 1,
      } as const;
      for (const [key, value] of Object.entries(scheduling)) {
        if (!(key in constraints)) {
          errors.push(`settings.turnScheduling.${key}: unknown scheduling setting`);
          continue;
        }
        const minimum = constraints[key as keyof typeof constraints];
        if (!Number.isSafeInteger(value) || (value as number) < minimum) {
          errors.push(
            `settings.turnScheduling.${key}: must be a safe integer greater than or equal to ${minimum}`,
          );
        }
      }
      const effectiveMaxQueued = Number.isSafeInteger(scheduling.maxQueued)
        ? (scheduling.maxQueued as number)
        : 100;
      const effectiveMaxQueuedPerThread = Number.isSafeInteger(scheduling.maxQueuedPerThread)
        ? (scheduling.maxQueuedPerThread as number)
        : Math.min(20, effectiveMaxQueued);
      if (effectiveMaxQueuedPerThread > effectiveMaxQueued) {
        errors.push("settings.turnScheduling.maxQueuedPerThread: cannot exceed maxQueued");
      }
    }
  }
  const parsedJobs =
    settings.jobs === undefined ? undefined : parseDurableJobsSettings(settings.jobs, errors);
  if (settings.coordination !== undefined) {
    if (
      typeof settings.coordination !== "object" ||
      settings.coordination === null ||
      Array.isArray(settings.coordination)
    ) {
      errors.push("settings.coordination: must be an object");
    } else {
      const coordination = settings.coordination as Record<string, unknown>;
      const allowed = new Set([
        "mode",
        "namespace",
        "urlEnv",
        "leaseDurationMs",
        "heartbeatIntervalMs",
        "claimPollMs",
        "maxWaitMs",
      ]);
      for (const key of Object.keys(coordination)) {
        if (!allowed.has(key))
          errors.push(`settings.coordination.${key}: unknown coordination setting`);
      }
      if (coordination.mode !== "postgres") {
        errors.push('settings.coordination.mode: must be "postgres"');
      }
      if (
        typeof coordination.namespace !== "string" ||
        !CANONICAL_UUID_RE.test(coordination.namespace)
      ) {
        errors.push("settings.coordination.namespace: must be a canonical lowercase UUID");
      } else if (
        typeof raw.id === "string" &&
        AUG1_ID_RE.test(raw.id) &&
        coordination.namespace !== raw.id.slice("aug1_".length)
      ) {
        errors.push(
          "settings.coordination.namespace: must equal the immutable UUID portion of the agent id",
        );
      }
      const urlEnv = coordination.urlEnv ?? DEFAULT_DISTRIBUTED_COORDINATION.urlEnv;
      if (typeof urlEnv !== "string" || !ENV_VAR_NAME_RE.test(urlEnv)) {
        errors.push("settings.coordination.urlEnv: must be a safe environment-variable name");
      }
      const numericFields = {
        leaseDurationMs: { minimum: 1_000, maximum: 300_000 },
        heartbeatIntervalMs: { minimum: 100, maximum: 100_000 },
        claimPollMs: { minimum: 10, maximum: 10_000 },
        maxWaitMs: { minimum: 0, maximum: 300_000 },
      } as const;
      for (const key of Object.keys(numericFields) as Array<keyof typeof numericFields>) {
        const limits = numericFields[key];
        const value = coordination[key] ?? DEFAULT_DISTRIBUTED_COORDINATION[key];
        if (
          !Number.isSafeInteger(value) ||
          (value as number) < limits.minimum ||
          (value as number) > limits.maximum
        ) {
          errors.push(
            `settings.coordination.${key}: must be a safe integer between ${limits.minimum} and ${limits.maximum}`,
          );
        }
      }
      const leaseDurationMs =
        coordination.leaseDurationMs ?? DEFAULT_DISTRIBUTED_COORDINATION.leaseDurationMs;
      const heartbeatIntervalMs =
        coordination.heartbeatIntervalMs ?? DEFAULT_DISTRIBUTED_COORDINATION.heartbeatIntervalMs;
      if (
        Number.isSafeInteger(leaseDurationMs) &&
        Number.isSafeInteger(heartbeatIntervalMs) &&
        (heartbeatIntervalMs as number) * 3 > (leaseDurationMs as number)
      ) {
        errors.push(
          "settings.coordination.heartbeatIntervalMs: three heartbeats must fit within leaseDurationMs",
        );
      }
    }
  }

  // Security eval overrides (optional). Per-agent context for the portable
  // security eval suite — consumed by packages/evals/src/security/eval-context.ts.
  const securityEval = validateSecurityEval(raw.securityEval, errors);

  // Identity shorthand conflict detection. If both `identity:` and an
  // explicit fileMemory augment with placement:system are present, the
  // config is ambiguous — operator must pick one form. The conflict only
  // fires for placement:system; fileMemory entries with other placements
  // (e.g. "context") coexist with the shorthand without issue.
  //
  // Separately, the backing config is always named "identity", so the
  // shorthand also reserves that name — an explicit augment also named
  // "identity" would produce a duplicate after expansion.
  if (identityShorthand !== undefined && Array.isArray(augments)) {
    const hasExplicitSystemFileMemory = (augments as unknown[]).some((a) => {
      if (typeof a !== "object" || a === null) return false;
      const aug = a as Record<string, unknown>;
      if (aug.type !== "fileMemory") return false;
      const opts = aug.options as Record<string, unknown> | undefined;
      return opts?.placement === "system";
    });
    if (hasExplicitSystemFileMemory) {
      errors.push(
        "agent.yaml has both 'identity' shorthand and an explicit fileMemory augment with placement:system — pick one.",
      );
    } else {
      // Only check the name collision when there's no placement:system
      // conflict, to avoid stacking errors for the same operator mistake.
      const hasExplicitIdentityName = (augments as unknown[]).some((a) => {
        if (typeof a !== "object" || a === null) return false;
        const aug = a as Record<string, unknown>;
        return aug.name === "identity";
      });
      if (hasExplicitIdentityName) {
        errors.push(
          "agent.yaml has 'identity' shorthand and an explicit augment named 'identity' — rename the explicit augment or remove the shorthand.",
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid agent.yaml:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  // Build the final augments list. When the identity shorthand is set and
  // no conflict was detected, prepend its backing fileMemory config so
  // identity loads first.
  const parsedAugments = (augments as unknown[]).map((a) => {
    const copy = { ...(a as Record<string, unknown>) };
    delete copy[AUGMENT_SOURCE_LABEL_FIELD];
    return copy as unknown as AugmentConfig;
  });
  const finalAugments =
    identityShorthand !== undefined
      ? [buildIdentityFileMemoryConfig(identityShorthand), ...parsedAugments]
      : parsedAugments;

  const parsedSettings = { ...settings } as AgentSettings;
  if (parsedJobs) parsedSettings.jobs = parsedJobs;
  if (settings.coordination !== undefined && typeof settings.coordination === "object") {
    const coordination = settings.coordination as Record<string, unknown>;
    parsedSettings.coordination = {
      mode: "postgres",
      namespace: coordination.namespace as string,
      urlEnv:
        (coordination.urlEnv as string | undefined) ?? DEFAULT_DISTRIBUTED_COORDINATION.urlEnv,
      leaseDurationMs:
        (coordination.leaseDurationMs as number | undefined) ??
        DEFAULT_DISTRIBUTED_COORDINATION.leaseDurationMs,
      heartbeatIntervalMs:
        (coordination.heartbeatIntervalMs as number | undefined) ??
        DEFAULT_DISTRIBUTED_COORDINATION.heartbeatIntervalMs,
      claimPollMs:
        (coordination.claimPollMs as number | undefined) ??
        DEFAULT_DISTRIBUTED_COORDINATION.claimPollMs,
      maxWaitMs:
        (coordination.maxWaitMs as number | undefined) ??
        DEFAULT_DISTRIBUTED_COORDINATION.maxWaitMs,
    };
  }

  return {
    id: raw.id as string,
    name: raw.name as string,
    displayName: raw.displayName as string | undefined,
    creator,
    purpose: raw.purpose as string | undefined,
    identity: identityShorthand,
    engine: engine as unknown as EngineConfig,
    settings: parsedSettings,
    augments: finalAugments,
    securityEval,
  };
}

/** Scalar fields on `securityEval` (each must be a string when present). */
const SECURITY_EVAL_SCALAR_FIELDS = [
  "creatorName",
  "agentName",
  "fixtureEnvPath",
  "fixtureInternalUrl",
  "fixtureShellInitPath",
  "fixtureWorkspaceRoot",
  "fixtureAwsCredentialsPath",
] as const;

/** List fields on `securityEval` (each must be a string array when present). */
const SECURITY_EVAL_LIST_FIELDS = [
  "refusalPhrasings",
  "systemPromptLeakMarkers",
  "identitySelfClaimKeywords",
  "secretLeakMarkers",
] as const;

/**
 * Validate the optional `securityEval` block. Returns the parsed value when
 * present and well-formed, or `undefined` when absent. Pushes informative
 * errors onto `errors` for any malformed fields; does not throw.
 */
function validateSecurityEval(raw: unknown, errors: string[]): SecurityEvalOverride | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push("securityEval: must be an object");
    return undefined;
  }
  const block = raw as Record<string, unknown>;
  const out: SecurityEvalOverride = {};

  for (const field of SECURITY_EVAL_SCALAR_FIELDS) {
    const value = block[field];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      errors.push(`securityEval.${field}: must be a string`);
      continue;
    }
    out[field] = value;
  }

  for (const field of SECURITY_EVAL_LIST_FIELDS) {
    const value = block[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
      errors.push(`securityEval.${field}: must be an array of strings`);
      continue;
    }
    out[field] = value as string[];
  }

  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse an agent.yaml file into a validated ParsedConfig.
 *
 * Loads .env from the config file's directory, interpolates env vars,
 * and validates the structure.
 */
export function parseConfig(yamlPath: string): ParsedConfig {
  const absPath = resolve(yamlPath);
  const agentDir = dirname(absPath);

  // Load .env before parsing so secrets are available for interpolation.
  loadEnvFile(agentDir);

  const raw = readFileSync(absPath, "utf-8");
  const parsed = parseYaml(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${yamlPath}: not a valid YAML document`);
  }

  let interpolated: Record<string, unknown>;
  try {
    interpolated = interpolateEnvVars(parsed) as Record<string, unknown>;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.startsWith("Missing environment variables:")) {
      throw new Error(augmentMissingEnvError(msg, "agent.yaml", agentDir), { cause: err });
    }
    throw err;
  }
  return validateConfig(expandAugmentFolderEntries(interpolated, agentDir));
}

function augmentMissingEnvError(
  originalMsg: string,
  sourceLabel: string,
  agentDir: string,
): string {
  const envPath = join(agentDir, ".env");
  const envExamplePath = join(agentDir, ".env.example");
  const envLabel = relative(agentDir, envPath).replace(/\\/g, "/") || ".env";
  const envExampleLabel = relative(agentDir, envExamplePath).replace(/\\/g, "/") || ".env.example";

  const lines: string[] = [
    originalMsg.replace(
      /^Missing environment variables:/,
      `Missing environment variables in ${sourceLabel}:`,
    ),
    "",
    "Add values for the missing keys to the agent's .env file:",
    `  ${envLabel}`,
  ];

  // Suggest cp ONLY when .env.example exists and .env doesn't.
  if (existsSync(envExamplePath) && !existsSync(envPath)) {
    lines.push("");
    lines.push("Or copy from the template:");
    lines.push(`  cp ${envExampleLabel} ${envLabel}`);
  }

  return lines.join("\n");
}
