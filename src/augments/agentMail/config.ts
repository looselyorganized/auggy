import type {
  AgentMailInboundConfig,
  AgentMailInboundMode,
  AgentMailInboundReplyMode,
  AgentMailOutboundOptions,
} from "../../types";

const INBOUND_MODES = new Set<AgentMailInboundMode>(["none", "websocket", "polling", "webhook"]);
const REPLY_MODES = new Set<AgentMailInboundReplyMode>(["disabled", "review", "automatic"]);
const RECEIVED_EVENT_TYPES = [
  "message.received",
  "message.received.spam",
  "message.received.blocked",
  "message.received.unauthenticated",
] as const;

export interface ValidatedAgentMailInboundConfig {
  config: AgentMailInboundConfig;
  processedEventTypes: Array<(typeof RECEIVED_EVENT_TYPES)[number]>;
  replies: {
    mode: AgentMailInboundReplyMode;
    allowReplyAll: boolean;
  };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`agentMail: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Transitional validator for the replacement mount. It deliberately accepts
 * only the retained public fields; deleted creator-digest/review-store fields
 * fail instead of silently reviving the previous runtime.
 */
export function validateAgentMailInboundConfig(
  value: unknown,
  _outbound?: AgentMailOutboundOptions,
): ValidatedAgentMailInboundConfig {
  const inbound = objectValue(value, "inbound");
  const supported = new Set([
    "mode",
    "allowedSenders",
    "allowAnySender",
    "rateLimit",
    "classifications",
    "replies",
    "pollIntervalMs",
    "maxPromptBytes",
    "maxAttempts",
    "websocketBaseUrl",
    "webhook",
  ]);
  for (const key of Object.keys(inbound)) {
    if (!supported.has(key)) {
      throw new Error(`agentMail: unsupported inbound field ${JSON.stringify(key)}`);
    }
  }

  const mode = inbound.mode ?? "none";
  if (typeof mode !== "string" || !INBOUND_MODES.has(mode as AgentMailInboundMode)) {
    throw new Error('agentMail: inbound.mode must be "none", "websocket", "polling", or "webhook"');
  }
  if (inbound.allowAnySender !== undefined && typeof inbound.allowAnySender !== "boolean") {
    throw new Error("agentMail: inbound.allowAnySender must be a boolean");
  }
  if (inbound.allowedSenders !== undefined) {
    if (
      !Array.isArray(inbound.allowedSenders) ||
      inbound.allowedSenders.length === 0 ||
      inbound.allowedSenders.some((sender) => typeof sender !== "string" || sender.trim() === "")
    ) {
      throw new Error("agentMail: inbound.allowedSenders must be a non-empty string array");
    }
  }
  if (inbound.allowAnySender === true && inbound.allowedSenders !== undefined) {
    throw new Error(
      "agentMail: inbound.allowedSenders and inbound.allowAnySender cannot be combined",
    );
  }
  if (mode !== "none" && inbound.allowAnySender !== true && inbound.allowedSenders === undefined) {
    throw new Error(
      "agentMail: enabled inbound requires allowedSenders or explicit allowAnySender: true",
    );
  }

  const replies =
    inbound.replies === undefined ? {} : objectValue(inbound.replies, "inbound.replies");
  const replyMode = replies.mode ?? "disabled";
  if (typeof replyMode !== "string" || !REPLY_MODES.has(replyMode as AgentMailInboundReplyMode)) {
    throw new Error('agentMail: inbound.replies.mode must be "disabled", "review", or "automatic"');
  }
  if (replies.allowReplyAll !== undefined && typeof replies.allowReplyAll !== "boolean") {
    throw new Error("agentMail: inbound.replies.allowReplyAll must be a boolean");
  }
  if (mode === "none" && replyMode !== "disabled") {
    throw new Error('agentMail: inbound.replies.mode must be "disabled" when inbound is disabled');
  }

  const classifications =
    inbound.classifications === undefined
      ? {}
      : objectValue(inbound.classifications, "inbound.classifications");
  const eventByField = {
    received: "message.received",
    spam: "message.received.spam",
    blocked: "message.received.blocked",
    unauthenticated: "message.received.unauthenticated",
  } as const;
  const processedEventTypes = Object.entries(eventByField).flatMap(([field, eventType]) => {
    const configured = classifications[field] ?? (field === "received" ? "process" : "discard");
    if (configured !== "process" && configured !== "discard") {
      throw new Error(`agentMail: inbound.classifications.${field} must be "process" or "discard"`);
    }
    return configured === "process" ? [eventType] : [];
  });

  return {
    config: inbound as unknown as AgentMailInboundConfig,
    processedEventTypes,
    replies: {
      mode: replyMode as AgentMailInboundReplyMode,
      allowReplyAll: replies.allowReplyAll === true,
    },
  };
}

export function agentMailInboundRequiresAdminRoute(
  config: ValidatedAgentMailInboundConfig,
): boolean {
  return config.replies.mode === "review";
}
