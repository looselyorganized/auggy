import type {
  AdminInfoBlock,
  AdminSection,
  DashboardData,
  MailActionTarget,
  MailAttentionProjection,
  MailAttentionStatus,
  MailDashboardProjection,
  MailInstanceProjection,
  MailReviewProjection,
  MailReviewStatus,
  MailStatusLevel,
} from "./types";
import { isSafeMailDetailPath } from "./mail-path";

const MAX_INSTANCES = 32;
const MAX_QUEUE_ITEMS = 100;
const MAX_METADATA_LENGTH = 1_000;
const MAX_ALLOWED_SENDERS = 1_000;
const MAX_GLOBAL_INBOUND_PER_HOUR = 10_000;
const MAX_INBOUND_PER_SENDER_PER_HOUR = 1_000;
const REVIEW_STATES = new Set<MailReviewStatus>(["pending", "sending"]);
const ATTENTION_STATES = new Set<MailAttentionStatus>([
  "open",
  "pending_review",
  "ambiguous",
]);
const STATUS_LEVELS = new Set<MailStatusLevel>(["ok", "warn", "error"]);
const SENDER_POLICIES = new Set(["disabled", "allowlist", "any"] as const);

/**
 * Select the typed Mail feature envelope without trusting the dashboard cast.
 * A top-level envelope wins; block-local projections fill only missing
 * instances. Older runtimes get a read-only adapter over AgentMail adminInfo.
 */
export function selectMailDashboard(data: DashboardData | null): MailDashboardProjection | null {
  if (!data) return null;
  const byName = new Map<string, MailInstanceProjection>();

  if (data.mail?.schemaVersion === 1 && Array.isArray(data.mail.instances)) {
    for (const candidate of data.mail.instances.slice(0, MAX_INSTANCES)) {
      const instance = parseMailInstance(candidate);
      if (instance && !byName.has(instance.augmentName)) {
        byName.set(instance.augmentName, instance);
      }
    }
  }

  for (const block of data.blocks) {
    const projected = parseBlockProjection(block);
    if (projected && !byName.has(projected.augmentName)) {
      byName.set(projected.augmentName, projected);
    }
  }

  for (const block of data.blocks) {
    if (byName.has(block.augmentName)) continue;
    const adapted = adaptLegacyAgentMailBlock(block);
    if (adapted) byName.set(adapted.augmentName, adapted);
  }

  return byName.size > 0
    ? {
        schemaVersion: 1,
        instances: [...byName.values()],
      }
    : null;
}

export function hasMailDashboard(data: DashboardData | null): boolean {
  return (selectMailDashboard(data)?.instances.length ?? 0) > 0;
}

function parseBlockProjection(block: AdminInfoBlock): MailInstanceProjection | null {
  const projection = block.projection;
  if (!projection || projection.kind !== "mail" || projection.schemaVersion !== 1) return null;
  const parsed = parseMailInstance(projection);
  if (!parsed || parsed.augmentName !== block.augmentName) return null;
  return parsed;
}

function parseMailInstance(value: unknown): MailInstanceProjection | null {
  if (!isRecord(value)) return null;
  const augmentName = requiredText(value.augmentName, 128);
  const inboxId = requiredText(value.inboxId, 256);
  const inboxEmail = optionalText(value.inboxEmail, 320);
  if (!augmentName || !inboxId || !isRecord(value.status) || !isRecord(value.inbound)) {
    return null;
  }
  const level = value.status.level;
  const statusMessage = requiredText(value.status.message);
  const inboundMode = requiredText(value.inbound.mode, 64);
  const inboundState = requiredText(value.inbound.state, 64);
  const senderPolicy = value.inbound.senderPolicy;
  const allowedSenderCount = value.inbound.allowedSenderCount;
  const rateLimit = parseInboundRateLimit(value.inbound.rateLimit);
  const hasInboundPolicyMetadata =
    senderPolicy !== undefined ||
    allowedSenderCount !== undefined ||
    value.inbound.rateLimit !== undefined;
  if (
    typeof level !== "string" ||
    !STATUS_LEVELS.has(level as MailStatusLevel) ||
    !statusMessage ||
    !inboundMode ||
    !inboundState ||
    (senderPolicy !== undefined &&
      (typeof senderPolicy !== "string" ||
        !SENDER_POLICIES.has(senderPolicy as "disabled" | "allowlist" | "any"))) ||
    (allowedSenderCount !== undefined &&
      (!Number.isSafeInteger(allowedSenderCount) ||
        (allowedSenderCount as number) < 0 ||
        (allowedSenderCount as number) > MAX_ALLOWED_SENDERS)) ||
    rateLimit === null ||
    (hasInboundPolicyMetadata &&
      (typeof senderPolicy !== "string" || typeof allowedSenderCount !== "number")) ||
    (senderPolicy === "any" && (allowedSenderCount !== 0 || rateLimit === undefined)) ||
    (senderPolicy === "allowlist" &&
      (typeof allowedSenderCount !== "number" || allowedSenderCount < 1)) ||
    (senderPolicy === "disabled" && (allowedSenderCount !== 0 || rateLimit !== undefined)) ||
    (senderPolicy === "disabled" && inboundMode !== "none") ||
    ((senderPolicy === "allowlist" || senderPolicy === "any") &&
      inboundMode !== "websocket" &&
      inboundMode !== "polling" &&
      inboundMode !== "webhook") ||
    !Array.isArray(value.reviews) ||
    !Array.isArray(value.attention)
  ) {
    return null;
  }

  const reviews = value.reviews
    .slice(0, MAX_QUEUE_ITEMS)
    .map(parseReview)
    .filter((item): item is MailReviewProjection => item !== null);
  const attention = value.attention
    .slice(0, MAX_QUEUE_ITEMS)
    .map(parseAttention)
    .filter((item): item is MailAttentionProjection => item !== null);

  return {
    augmentName,
    inboxId,
    ...(inboxEmail ? { inboxEmail } : {}),
    status: { level: level as MailStatusLevel, message: statusMessage },
    inbound: {
      mode: inboundMode,
      state: inboundState,
      ...(typeof senderPolicy === "string"
        ? { senderPolicy: senderPolicy as "disabled" | "allowlist" | "any" }
        : {}),
      ...(typeof allowedSenderCount === "number" ? { allowedSenderCount } : {}),
      ...(rateLimit ? { rateLimit } : {}),
    },
    reviews,
    attention,
  };
}

function parseReview(value: unknown): MailReviewProjection | null {
  if (!isRecord(value) || !isRecord(value.actions)) return null;
  const rowKey = requiredText(value.rowKey, 512);
  const reviewId = requiredText(value.reviewId, 128);
  const status = value.status;
  const subject =
    typeof value.subject === "string" && value.subject.length <= MAX_METADATA_LENGTH
      ? boundedText(value.subject)
      : null;
  const correspondent = requiredText(value.correspondent);
  const updatedAt = optionalText(value.updatedAt, 64);
  const expiresAt = requiredText(value.expiresAt, 64);
  const detailPath = safeDetailPath(value.detailPath);
  if (
    !rowKey ||
    !reviewId ||
    typeof status !== "string" ||
    !REVIEW_STATES.has(status as MailReviewStatus) ||
    subject === null ||
    !correspondent ||
    !expiresAt ||
    !detailPath
  ) {
    return null;
  }
  return {
    rowKey,
    reviewId,
    status: status as MailReviewStatus,
    subject,
    correspondent,
    ...(updatedAt ? { updatedAt } : {}),
    expiresAt,
    detailPath,
    actions: parseReviewActions(value.actions),
  };
}

function parseAttention(value: unknown): MailAttentionProjection | null {
  if (!isRecord(value) || !isRecord(value.actions)) return null;
  const rowKey = requiredText(value.rowKey, 512);
  const messageId = requiredText(value.messageId, 256);
  const status = value.status;
  const version = value.version;
  const updatedAt = requiredText(value.updatedAt, 64);
  const subject = optionalText(value.subject);
  const sender = optionalText(value.sender, 320);
  const receivedAt = optionalText(value.receivedAt, 64);
  const detailPath =
    value.detailPath === undefined ? undefined : safeDetailPath(value.detailPath) || undefined;
  if (
    !rowKey ||
    !messageId ||
    typeof status !== "string" ||
    !ATTENTION_STATES.has(status as MailAttentionStatus) ||
    !Number.isSafeInteger(version) ||
    (version as number) < 1 ||
    !updatedAt
  ) {
    return null;
  }
  const dismiss = parseAction(value.actions.dismiss, "agentmail-attention-dismiss");
  const reconcileProcessed = parseAction(
    value.actions.reconcileProcessed,
    "agentmail-inbound-reconcile-handled",
  );
  const reconcilePending = parseAction(
    value.actions.reconcilePending,
    "agentmail-inbound-reconcile-no-effect",
  );
  return {
    rowKey,
    messageId,
    status: status as MailAttentionStatus,
    version: version as number,
    ...(subject ? { subject } : {}),
    ...(sender ? { sender } : {}),
    ...(receivedAt ? { receivedAt } : {}),
    updatedAt,
    ...(detailPath ? { detailPath } : {}),
    actions: {
      ...(dismiss ? { dismiss } : {}),
      ...(reconcileProcessed ? { reconcileProcessed } : {}),
      ...(reconcilePending ? { reconcilePending } : {}),
    },
  };
}

function parseReviewActions(value: Record<string, unknown>): MailReviewProjection["actions"] {
  const approve = parseAction(value.approve, "agentmail-review-approve");
  const revise = parseAction(value.revise, "agentmail-review-revise");
  const reject = parseAction(value.reject, "agentmail-review-reject");
  const reconcileSent = parseAction(
    value.reconcileSent,
    "agentmail-review-reconcile-sent",
  );
  const reconcileFailed = parseAction(
    value.reconcileFailed,
    "agentmail-review-reconcile-failed",
  );
  return {
    ...(approve ? { approve } : {}),
    ...(revise ? { revise } : {}),
    ...(reject ? { reject } : {}),
    ...(reconcileSent ? { reconcileSent } : {}),
    ...(reconcileFailed ? { reconcileFailed } : {}),
  };
}

function parseAction(value: unknown, expectedActionId: string): MailActionTarget | null {
  if (!isRecord(value)) return null;
  const actionId = requiredText(value.actionId, 128);
  return actionId === expectedActionId ? { actionId } : null;
}

function adaptLegacyAgentMailBlock(block: AdminInfoBlock): MailInstanceProjection | null {
  if (block.title !== "AgentMail") return null;
  const keyValues = new Map<string, string>();
  let status: MailInstanceProjection["status"] = {
    level: "warn",
    message: "AgentMail status is unavailable.",
  };
  let reviewTable: Extract<AdminSection, { kind: "table" }> | undefined;
  let attentionTable: Extract<AdminSection, { kind: "table" }> | undefined;

  for (const section of block.sections) {
    if (section.kind === "status") {
      status = { level: section.level, message: boundedText(section.message) };
    } else if (section.kind === "keyValue") {
      for (const row of section.rows) keyValues.set(row.label, boundedText(row.value));
    } else if (section.kind === "table") {
      if (section.columns.includes("Review ID") && section.columns.includes("Inspect")) {
        reviewTable = section;
      }
      if (section.columns.includes("Message") && section.columns.includes("Version")) {
        attentionTable = section;
      }
    }
  }

  const inboxId = keyValues.get("Inbox ID");
  if (!inboxId) return null;
  const rawEmail = keyValues.get("Inbox email");
  const inboxEmail =
    rawEmail && !rawEmail.startsWith("(") && rawEmail.includes("@") ? rawEmail : undefined;
  return {
    augmentName: block.augmentName,
    inboxId,
    ...(inboxEmail ? { inboxEmail } : {}),
    status,
    inbound: {
      mode: keyValues.get("Inbound mode") || "unknown",
      state: keyValues.get("Inbound runtime") || "unknown",
    },
    reviews: reviewTable ? adaptLegacyReviews(reviewTable) : [],
    attention: attentionTable ? adaptLegacyAttention(attentionTable) : [],
  };
}

function adaptLegacyReviews(
  section: Extract<AdminSection, { kind: "table" }>,
): MailReviewProjection[] {
  const column = columnReader(section.columns);
  if (!column) return [];
  const items: MailReviewProjection[] = [];
  for (const row of section.rows.slice(0, MAX_QUEUE_ITEMS)) {
    const status = column(row, "State");
    const detailPath = safeDetailPath(column(row, "Inspect"));
    const reviewId = boundedText(column(row, "Review ID"), 128);
    if (!REVIEW_STATES.has(status as MailReviewStatus) || !detailPath || !reviewId) continue;
    items.push({
      rowKey: reviewId,
      reviewId,
      status: status as MailReviewStatus,
      subject: boundedText(column(row, "Subject")) || "(no subject)",
      correspondent: boundedText(column(row, "Recipients")) || "(recipient unavailable)",
      expiresAt: boundedText(column(row, "Expires"), 64) || "(unknown)",
      detailPath,
      actions: {},
    });
  }
  return items;
}

function adaptLegacyAttention(
  section: Extract<AdminSection, { kind: "table" }>,
): MailAttentionProjection[] {
  const column = columnReader(section.columns);
  if (!column) return [];
  const items: MailAttentionProjection[] = [];
  for (const row of section.rows.slice(0, MAX_QUEUE_ITEMS)) {
    const status = column(row, "State");
    const messageId = boundedText(column(row, "Message"), 256);
    const version = Number(column(row, "Version"));
    const updatedAt = boundedText(column(row, "Updated"), 64);
    if (
      !ATTENTION_STATES.has(status as MailAttentionStatus) ||
      !messageId ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !updatedAt
    ) {
      continue;
    }
    const reviewPath = safeDetailPath(column(row, "Review"));
    items.push({
      rowKey: messageId,
      messageId,
      status: status as MailAttentionStatus,
      version,
      updatedAt,
      ...(reviewPath ? { detailPath: reviewPath } : {}),
      actions: {},
    });
  }
  return items;
}

function columnReader(columns: string[]) {
  const indices = new Map(columns.map((name, index) => [name, index]));
  return (row: string[], name: string): string => {
    const index = indices.get(name);
    return index === undefined ? "" : (row[index] ?? "");
  };
}

function safeDetailPath(value: unknown): string | null {
  return isSafeMailDetailPath(value) ? value : null;
}

function parseInboundRateLimit(
  value: unknown,
): MailInstanceProjection["inbound"]["rateLimit"] | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const numericFields = [
    "globalMaxPerHour",
    "perSenderMaxPerHour",
    "rollingGlobalUsage",
    "globalRejections",
    "perSenderRejections",
  ] as const;
  for (const field of numericFields) {
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) return null;
  }
  if (
    (value.globalMaxPerHour as number) < 1 ||
    (value.globalMaxPerHour as number) > MAX_GLOBAL_INBOUND_PER_HOUR ||
    (value.perSenderMaxPerHour as number) < 1 ||
    (value.perSenderMaxPerHour as number) > MAX_INBOUND_PER_SENDER_PER_HOUR ||
    (value.perSenderMaxPerHour as number) > (value.globalMaxPerHour as number)
  ) {
    return null;
  }
  const lastRejectedAt = optionalIsoTimestamp(value.lastRejectedAt);
  if (lastRejectedAt === null) return null;
  return {
    globalMaxPerHour: value.globalMaxPerHour as number,
    perSenderMaxPerHour: value.perSenderMaxPerHour as number,
    rollingGlobalUsage: value.rollingGlobalUsage as number,
    globalRejections: value.globalRejections as number,
    perSenderRejections: value.perSenderRejections as number,
    ...(lastRejectedAt ? { lastRejectedAt } : {}),
  };
}

function optionalIsoTimestamp(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 64) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const normalized = new Date(timestamp).toISOString();
  return normalized === value ? normalized : null;
}

function optionalText(value: unknown, max = MAX_METADATA_LENGTH): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredText(value, max) || undefined;
}

function requiredText(value: unknown, max = MAX_METADATA_LENGTH): string {
  return typeof value === "string" ? boundedText(value, max) : "";
}

function boundedText(value: string, max = MAX_METADATA_LENGTH): string {
  return value
    .trim()
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "�")
    .slice(0, max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
