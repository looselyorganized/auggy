import type {
  AdminInfoBlock,
  DashboardData,
  MailDashboardProjection,
  MailDraftProjection,
  MailDraftState,
  MailInstanceProjection,
  MailStatusLevel,
} from "./types";

const MAX_INSTANCES = 32;
const MAX_DRAFTS = 100;
const MAX_TEXT_LENGTH = 1_000;
const MAX_ALLOWED_SENDERS = 1_000;
const MAX_RATE_LIMIT = 10_000;
const AGENTMAIL_CONSOLE_ORIGIN = "https://console.agentmail.to";
const STATUS_LEVELS = new Set<MailStatusLevel>(["ok", "warn", "error"]);
const INBOUND_MODES = new Set(["none", "websocket"] as const);
const INBOUND_STATES = new Set([
  "idle",
  "connecting",
  "catching_up",
  "ready",
  "degraded",
  "stopped",
] as const);
const SENDER_POLICIES = new Set(["disabled", "allowlist", "any"] as const);
const REPLY_MODES = new Set(["disabled", "review"] as const);
const DRAFT_STATES = new Set<MailDraftState>([
  "ready",
  "stale",
  "approved",
  "sending",
  "sent",
  "ambiguous",
  "failed",
]);

/**
 * Select provider-native AgentMail projections from mounted augment blocks.
 * Unknown or malformed projections fail closed and never become Mail UI state.
 */
export function selectMailDashboard(data: DashboardData | null): MailDashboardProjection | null {
  if (!data) return null;
  const byName = new Map<string, MailInstanceProjection>();

  for (const block of data.blocks.slice(0, MAX_INSTANCES)) {
    const instance = parseBlockProjection(block);
    if (instance && !byName.has(instance.augmentName)) {
      byName.set(instance.augmentName, instance);
    }
  }

  return byName.size > 0 ? { instances: [...byName.values()] } : null;
}

export function hasMailDashboard(data: DashboardData | null): boolean {
  return (selectMailDashboard(data)?.instances.length ?? 0) > 0;
}

function parseBlockProjection(block: AdminInfoBlock): MailInstanceProjection | null {
  const projection = block.projection;
  if (!projection || projection.kind !== "mail") return null;
  const parsed = parseMailInstance(projection);
  if (!parsed || parsed.augmentName !== block.augmentName) return null;
  return parsed;
}

function parseMailInstance(value: unknown): MailInstanceProjection | null {
  if (!isRecord(value) || !isRecord(value.status) || !isRecord(value.inbound)) return null;
  if (!isRecord(value.replies) || !Array.isArray(value.drafts)) return null;

  const augmentName = requiredText(value.augmentName, 128);
  const inboxId = requiredText(value.inboxId, 256);
  const inboxEmail = optionalText(value.inboxEmail, 320);
  const externalConsoleUrl = parseExternalConsoleUrl(value.externalConsoleUrl);
  const level = value.status.level;
  const statusMessage = requiredText(value.status.message);
  const inboundMode = value.inbound.mode;
  const inboundState = value.inbound.state;
  const senderPolicy = value.inbound.senderPolicy;
  const allowedSenderCount = parseInteger(value.inbound.allowedSenderCount, 0, MAX_ALLOWED_SENDERS);
  const globalMaxPerHour = parseOptionalInteger(
    value.inbound.globalMaxPerHour,
    1,
    MAX_RATE_LIMIT,
  );
  const perSenderMaxPerHour = parseOptionalInteger(
    value.inbound.perSenderMaxPerHour,
    1,
    MAX_RATE_LIMIT,
  );
  const lastCatchUpAt = parseOptionalTimestamp(value.inbound.lastCatchUpAt);
  const lastEventAt = parseOptionalTimestamp(value.inbound.lastEventAt);
  const lastErrorCode = optionalText(value.inbound.lastErrorCode, 128);
  const replyMode = value.replies.mode;
  const allowReplyAll = value.replies.allowReplyAll;

  if (
    !augmentName ||
    !inboxId ||
    typeof level !== "string" ||
    !STATUS_LEVELS.has(level as MailStatusLevel) ||
    !statusMessage ||
    typeof inboundMode !== "string" ||
    !INBOUND_MODES.has(inboundMode as "none" | "websocket") ||
    typeof inboundState !== "string" ||
    !INBOUND_STATES.has(inboundState as MailInstanceProjection["inbound"]["state"]) ||
    typeof senderPolicy !== "string" ||
    !SENDER_POLICIES.has(senderPolicy as MailInstanceProjection["inbound"]["senderPolicy"]) ||
    allowedSenderCount === null ||
    globalMaxPerHour === null ||
    perSenderMaxPerHour === null ||
    typeof replyMode !== "string" ||
    !REPLY_MODES.has(replyMode as "disabled" | "review") ||
    typeof allowReplyAll !== "boolean" ||
    (inboundMode === "none" && senderPolicy !== "disabled") ||
    (inboundMode === "none" && (globalMaxPerHour !== undefined || perSenderMaxPerHour !== undefined)) ||
    (inboundMode === "websocket" && senderPolicy === "disabled") ||
    (senderPolicy === "any" && allowedSenderCount !== 0) ||
    (senderPolicy === "allowlist" && allowedSenderCount < 1) ||
    (senderPolicy === "disabled" && allowedSenderCount !== 0) ||
    (senderPolicy !== "disabled" &&
      (globalMaxPerHour === undefined || perSenderMaxPerHour === undefined))
  ) {
    return null;
  }

  const drafts = value.drafts
    .slice(0, MAX_DRAFTS)
    .map(parseDraft)
    .filter((draft): draft is MailDraftProjection => draft !== null);

  return {
    augmentName,
    inboxId,
    ...(inboxEmail ? { inboxEmail } : {}),
    ...(externalConsoleUrl ? { externalConsoleUrl } : {}),
    status: { level: level as MailStatusLevel, message: statusMessage },
    inbound: {
      mode: inboundMode as "none" | "websocket",
      state: inboundState as MailInstanceProjection["inbound"]["state"],
      senderPolicy: senderPolicy as MailInstanceProjection["inbound"]["senderPolicy"],
      allowedSenderCount,
      ...(globalMaxPerHour === undefined ? {} : { globalMaxPerHour }),
      ...(perSenderMaxPerHour === undefined ? {} : { perSenderMaxPerHour }),
      ...(lastCatchUpAt ? { lastCatchUpAt } : {}),
      ...(lastEventAt ? { lastEventAt } : {}),
      ...(lastErrorCode ? { lastErrorCode } : {}),
    },
    replies: {
      mode: replyMode as "disabled" | "review",
      allowReplyAll,
    },
    drafts,
  };
}

function parseDraft(value: unknown): MailDraftProjection | null {
  if (!isRecord(value)) return null;
  const draftId = requiredText(value.draftId, 256);
  const sourceMessageId = requiredText(value.sourceMessageId, 256);
  const threadId = requiredText(value.threadId, 256);
  const state = value.state;
  const providerUpdatedAt = parseTimestamp(value.providerUpdatedAt);
  if (
    !draftId ||
    !sourceMessageId ||
    !threadId ||
    typeof state !== "string" ||
    !DRAFT_STATES.has(state as MailDraftState) ||
    !providerUpdatedAt
  ) {
    return null;
  }
  return {
    draftId,
    sourceMessageId,
    threadId,
    state: state as MailDraftState,
    providerUpdatedAt,
  };
}

function parseExternalConsoleUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (
      url.origin !== AGENTMAIL_CONSOLE_ORIGIN ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return AGENTMAIL_CONSOLE_ORIGIN;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, max = MAX_TEXT_LENGTH): string | null {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) return null;
  return boundedText(value, max);
}

function optionalText(value: unknown, max = MAX_TEXT_LENGTH): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, max) ?? undefined;
}

function boundedText(value: string, max = MAX_TEXT_LENGTH): string {
  return value
    .slice(0, max)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "�")
    .trim();
}

function parseInteger(value: unknown, min: number, max: number): number | null {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
    ? (value as number)
    : null;
}

function parseOptionalInteger(
  value: unknown,
  min: number,
  max: number,
): number | null | undefined {
  return value === undefined ? undefined : parseInteger(value, min, max);
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? value : null;
}

function parseOptionalTimestamp(value: unknown): string | undefined {
  return value === undefined ? undefined : parseTimestamp(value) ?? undefined;
}
