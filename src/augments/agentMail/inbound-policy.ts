import type {
  AgentMailInboundConfig,
  AgentMailInboundReplyMode,
  AgentMailOutboundOptions,
} from "../../types";
import { isWellFormedEmail } from "../visitorAuth/email-validation";
import type { AgentMailReceivedEventType } from "./provider";
import {
  resolveAgentMailCreatorDigestConfig,
  type ResolvedAgentMailCreatorDigestConfig,
} from "./creator-digest-policy";

export const AGENTMAIL_MIN_POLL_INTERVAL_MS = 1_000;
export const AGENTMAIL_MAX_POLL_INTERVAL_MS = 24 * 60 * 60_000;
export const AGENTMAIL_MIN_PROMPT_BYTES = 512;
export const AGENTMAIL_MAX_PROMPT_BYTES = 1024 * 1024;
export const AGENTMAIL_MAX_ATTEMPTS = 20;
export const AGENTMAIL_MAX_ALLOWED_SENDERS = 1_000;
export const AGENTMAIL_MAX_AUTOMATIC_REPLIES_PER_HOUR = 100;

export interface ResolvedAgentMailInboundReplies {
  mode: AgentMailInboundReplyMode;
  allowReplyAll: boolean;
}

export interface ValidatedAgentMailInboundConfig {
  config: AgentMailInboundConfig;
  processedEventTypes: AgentMailReceivedEventType[];
  replies: ResolvedAgentMailInboundReplies;
  creatorDigest: ResolvedAgentMailCreatorDigestConfig;
}

const CLASSIFICATION_FIELDS = ["received", "spam", "blocked", "unauthenticated"] as const;
const CLASSIFICATION_FIELD_SET = new Set<string>(CLASSIFICATION_FIELDS);

const EVENT_TYPES_BY_CLASSIFICATION = {
  received: "message.received",
  spam: "message.received.spam",
  blocked: "message.received.blocked",
  unauthenticated: "message.received.unauthenticated",
} as const satisfies Record<(typeof CLASSIFICATION_FIELDS)[number], AgentMailReceivedEventType>;

const DEFAULT_CLASSIFICATION_ACTIONS = {
  received: "process",
  spam: "discard",
  blocked: "discard",
  unauthenticated: "discard",
} as const satisfies Required<NonNullable<AgentMailInboundConfig["classifications"]>>;

const REPLY_FIELDS = new Set(["mode", "allowReplyAll"]);
const INBOUND_FIELDS = new Set([
  "mode",
  "allowedSenders",
  "classifications",
  "replies",
  "creatorDigest",
  "pollIntervalMs",
  "maxPromptBytes",
  "maxAttempts",
  "websocketBaseUrl",
  "webhook",
]);

/**
 * Validate the effective runtime hourly cap, including mutable admin
 * overrides. Config admission alone is insufficient because an override can
 * replace the YAML value after startup.
 */
export function validateAgentMailEffectiveHourlyCap(
  value: unknown,
  replyMode: AgentMailInboundReplyMode,
  label = "effective outbound.rateLimit.globalMaxPerHour",
): number {
  const maximum =
    replyMode === "automatic" ? AGENTMAIL_MAX_AUTOMATIC_REPLIES_PER_HOUR : Number.MAX_SAFE_INTEGER;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    if (replyMode === "automatic") {
      throw new Error(
        `agentMail: automatic inbound replies require ${label} between 1 and ${AGENTMAIL_MAX_AUTOMATIC_REPLIES_PER_HOUR}`,
      );
    }
    throw new Error(`agentMail: ${label} must be a positive safe integer`);
  }
  return value;
}

/** Whether this validated inbound policy can ever enqueue creator review. */
export function agentMailInboundRequiresAdminRoute(
  inbound: Pick<ValidatedAgentMailInboundConfig, "config" | "replies">,
): boolean {
  return inbound.config.mode !== "none" && inbound.replies.mode !== "disabled";
}

/**
 * Canonicalize the legacy sender allowlist while rejecting patterns that
 * would otherwise fail silently. Domain globs match that exact domain only;
 * subdomains require their own entry.
 */
export function normalizeAgentMailAllowedSenders(values: readonly string[]): string[] {
  if (values.length === 0) {
    throw new Error("agentMail: inbound.allowedSenders must contain at least one sender pattern");
  }
  if (values.length > AGENTMAIL_MAX_ALLOWED_SENDERS) {
    throw new Error(
      `agentMail: inbound.allowedSenders must contain at most ${AGENTMAIL_MAX_ALLOWED_SENDERS} sender patterns`,
    );
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
      throw new Error(
        "agentMail: each inbound.allowedSenders entry must be a non-empty sender pattern without surrounding whitespace",
      );
    }
    if (/\p{Cc}/u.test(value)) {
      throw new Error(
        "agentMail: inbound.allowedSenders entries must not contain control characters",
      );
    }

    const candidate = value.toLowerCase();
    const valid = candidate.startsWith("*@")
      ? isWellFormedEmail(`sender@${candidate.slice(2)}`)
      : isWellFormedEmail(candidate);
    if (!valid) {
      throw new Error(
        `agentMail: invalid inbound.allowedSenders sender pattern ${JSON.stringify(value)}; use an exact email or "*@example.com"`,
      );
    }
    if (seen.has(candidate)) {
      throw new Error(
        `agentMail: duplicate inbound.allowedSenders sender pattern ${JSON.stringify(value)} after case normalization`,
      );
    }
    seen.add(candidate);
    normalized.push(candidate);
  }
  return normalized;
}

function selectedAgentMailEventTypes(
  classifications: AgentMailInboundConfig["classifications"] | undefined,
): AgentMailReceivedEventType[] {
  if (
    classifications !== undefined &&
    (typeof classifications !== "object" ||
      classifications === null ||
      Array.isArray(classifications))
  ) {
    throw new Error("agentMail: inbound.classifications must be an object");
  }
  for (const field of Object.keys(classifications ?? {})) {
    if (!CLASSIFICATION_FIELD_SET.has(field)) {
      throw new Error(
        `agentMail: unsupported inbound.classifications field ${JSON.stringify(field)}`,
      );
    }
  }

  const selected: AgentMailReceivedEventType[] = [];
  for (const field of CLASSIFICATION_FIELDS) {
    const action = classifications?.[field] ?? DEFAULT_CLASSIFICATION_ACTIONS[field];
    if (action !== "process" && action !== "discard") {
      throw new Error(`agentMail: inbound.classifications.${field} must be "process" or "discard"`);
    }
    if (action === "process") selected.push(EVENT_TYPES_BY_CLASSIFICATION[field]);
  }
  return selected;
}

/** Validate classification actions without requiring dormant policy to process mail. */
export function validateAgentMailClassificationActions(
  classifications: AgentMailInboundConfig["classifications"] | undefined,
): void {
  selectedAgentMailEventTypes(classifications);
}

/** Event types that the operator has deliberately chosen to process. */
export function processedAgentMailEventTypes(
  classifications: AgentMailInboundConfig["classifications"] | undefined,
): AgentMailReceivedEventType[] {
  const selected = selectedAgentMailEventTypes(classifications);
  if (selected.length === 0) {
    throw new Error("agentMail: enabled inbound must process at least one message classification");
  }
  return selected;
}

export function validateAgentMailInboundBounds(config: AgentMailInboundConfig): void {
  if (config.pollIntervalMs !== undefined) {
    if (
      !Number.isSafeInteger(config.pollIntervalMs) ||
      config.pollIntervalMs < AGENTMAIL_MIN_POLL_INTERVAL_MS ||
      config.pollIntervalMs > AGENTMAIL_MAX_POLL_INTERVAL_MS
    ) {
      throw new Error(
        `agentMail: inbound.pollIntervalMs must be between ${AGENTMAIL_MIN_POLL_INTERVAL_MS} and ${AGENTMAIL_MAX_POLL_INTERVAL_MS}`,
      );
    }
  }
  if (config.maxPromptBytes !== undefined) {
    if (
      !Number.isSafeInteger(config.maxPromptBytes) ||
      config.maxPromptBytes < AGENTMAIL_MIN_PROMPT_BYTES ||
      config.maxPromptBytes > AGENTMAIL_MAX_PROMPT_BYTES
    ) {
      throw new Error(
        `agentMail: inbound.maxPromptBytes must be between ${AGENTMAIL_MIN_PROMPT_BYTES} and ${AGENTMAIL_MAX_PROMPT_BYTES}`,
      );
    }
  }
  if (
    config.maxAttempts !== undefined &&
    (!Number.isSafeInteger(config.maxAttempts) ||
      config.maxAttempts < 1 ||
      config.maxAttempts > AGENTMAIL_MAX_ATTEMPTS)
  ) {
    throw new Error(
      `agentMail: inbound.maxAttempts must be between 1 and ${AGENTMAIL_MAX_ATTEMPTS}`,
    );
  }
}

/**
 * Resolve action-specific inbound reply authority.
 *
 * Automatic replies fail closed unless the existing outbound rate limiter is
 * enabled with a finite global cap. The default outbound policy resolves to
 * 10/hour; explicit automatic mode permits at most 100/hour.
 */
export function resolveAgentMailInboundReplies(
  inboundMode: AgentMailInboundConfig["mode"],
  value: AgentMailInboundConfig["replies"] | undefined,
  outbound: AgentMailOutboundOptions | undefined,
): ResolvedAgentMailInboundReplies {
  if (
    value !== undefined &&
    (typeof value !== "object" || value === null || Array.isArray(value))
  ) {
    throw new Error("agentMail: inbound.replies must be an object");
  }
  for (const field of Object.keys(value ?? {})) {
    if (!REPLY_FIELDS.has(field)) {
      throw new Error(`agentMail: unsupported inbound.replies field ${JSON.stringify(field)}`);
    }
  }

  const defaultMode: AgentMailInboundReplyMode = inboundMode === "none" ? "disabled" : "review";
  const mode = value?.mode ?? defaultMode;
  if (mode !== "disabled" && mode !== "review" && mode !== "automatic") {
    throw new Error('agentMail: inbound.replies.mode must be "disabled", "review", or "automatic"');
  }
  if (value?.allowReplyAll !== undefined && typeof value.allowReplyAll !== "boolean") {
    throw new Error("agentMail: inbound.replies.allowReplyAll must be a boolean");
  }
  const allowReplyAll = value?.allowReplyAll ?? false;

  if (inboundMode === "none" && mode !== "disabled") {
    throw new Error(
      'agentMail: inbound.replies.mode must be "disabled" when inbound.mode is "none"',
    );
  }
  if (mode === "disabled" && allowReplyAll) {
    throw new Error(
      "agentMail: inbound.replies.allowReplyAll cannot be true when replies are disabled",
    );
  }

  if (mode === "automatic") {
    const rateLimitValue: unknown = outbound?.rateLimit;
    if (
      rateLimitValue !== undefined &&
      (typeof rateLimitValue !== "object" ||
        rateLimitValue === null ||
        Array.isArray(rateLimitValue))
    ) {
      throw new Error(
        "agentMail: automatic inbound replies require outbound.rateLimit to be an object",
      );
    }
    const rateLimit = rateLimitValue as Record<string, unknown> | undefined;
    if (rateLimit?.enabled === false) {
      throw new Error(
        "agentMail: automatic inbound replies require outbound.rateLimit.enabled to remain true",
      );
    }
    if (rateLimit?.enabled !== undefined && rateLimit.enabled !== true) {
      throw new Error(
        "agentMail: automatic inbound replies require outbound.rateLimit.enabled to be a boolean",
      );
    }
    validateAgentMailEffectiveHourlyCap(
      rateLimit?.globalMaxPerHour ?? 10,
      mode,
      "outbound.rateLimit.globalMaxPerHour",
    );
  }

  return { mode, allowReplyAll };
}

/** Shared admission boundary used by YAML parsing, setup, and direct factories. */
export function validateAgentMailInboundConfig(
  value: unknown,
  outbound?: AgentMailOutboundOptions,
): ValidatedAgentMailInboundConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("agentMail: inbound must be an object");
  }
  const inbound = value as Record<string, unknown>;
  for (const field of Object.keys(inbound)) {
    if (!INBOUND_FIELDS.has(field)) {
      throw new Error(`agentMail: unsupported inbound field ${JSON.stringify(field)}`);
    }
  }
  const mode = inbound.mode;
  if (mode !== "none" && mode !== "websocket" && mode !== "polling" && mode !== "webhook") {
    throw new Error('agentMail: inbound.mode must be "none", "websocket", "polling", or "webhook"');
  }

  if (inbound.allowedSenders !== undefined) {
    if (!Array.isArray(inbound.allowedSenders)) {
      throw new Error("agentMail: inbound.allowedSenders must be an array");
    }
    normalizeAgentMailAllowedSenders(inbound.allowedSenders);
  } else if (mode !== "none") {
    throw new Error("agentMail: inbound.allowedSenders must be non-empty when inbound is enabled");
  }

  const config = value as AgentMailInboundConfig;
  validateAgentMailInboundBounds(config);
  validateAgentMailClassificationActions(config.classifications);
  const processedEventTypes =
    mode === "none" ? [] : processedAgentMailEventTypes(config.classifications);
  const replies = resolveAgentMailInboundReplies(mode, config.replies, outbound);
  const creatorDigest = resolveAgentMailCreatorDigestConfig(config.creatorDigest, mode);

  if (config.websocketBaseUrl !== undefined) {
    if (typeof config.websocketBaseUrl !== "string") {
      throw new Error("agentMail: inbound.websocketBaseUrl must be a ws:// or wss:// URL");
    }
    let url: URL;
    try {
      url = new URL(config.websocketBaseUrl);
    } catch {
      throw new Error("agentMail: inbound.websocketBaseUrl must be a ws:// or wss:// URL");
    }
    if ((url.protocol !== "ws:" && url.protocol !== "wss:") || url.username || url.password) {
      throw new Error(
        "agentMail: inbound.websocketBaseUrl must be a ws:// or wss:// URL without credentials",
      );
    }
  }

  if (mode === "webhook") {
    if (
      typeof config.webhook !== "object" ||
      config.webhook === null ||
      Array.isArray(config.webhook)
    ) {
      throw new Error("agentMail: inbound.webhook is required when inbound.mode is webhook");
    }
    if (
      config.webhook.path !== undefined &&
      (typeof config.webhook.path !== "string" || !config.webhook.path.startsWith("/"))
    ) {
      throw new Error('agentMail: inbound.webhook.path must start with "/"');
    }
    if (
      config.webhook.secretEnv !== undefined &&
      (typeof config.webhook.secretEnv !== "string" || config.webhook.secretEnv.length === 0)
    ) {
      throw new Error("agentMail: inbound.webhook.secretEnv must be a non-empty string");
    }
    if (
      config.webhook.timestampToleranceSeconds !== undefined &&
      (typeof config.webhook.timestampToleranceSeconds !== "number" ||
        !Number.isFinite(config.webhook.timestampToleranceSeconds) ||
        config.webhook.timestampToleranceSeconds <= 0 ||
        config.webhook.timestampToleranceSeconds > 300)
    ) {
      throw new Error(
        "agentMail: inbound.webhook.timestampToleranceSeconds must be between 1 and 300",
      );
    }
  } else if (config.webhook !== undefined) {
    throw new Error('agentMail: inbound.webhook is only valid when inbound.mode is "webhook"');
  }

  return { config, processedEventTypes, replies, creatorDigest };
}
