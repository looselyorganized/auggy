import { createHash } from "node:crypto";
import type {
  AgentMailAugmentOptions,
  AgentMailInboundMode,
  AgentMailReplyMode,
  TrustLevel,
} from "../../types";
import { isWellFormedEmail } from "../visitorAuth/email-validation";

const TOP_LEVEL_FIELDS = new Set([
  "apiKey",
  "inboxId",
  "emailAddress",
  "addressVisibility",
  "apiBaseUrl",
  "websocketBaseUrl",
  "allowInsecureHttpWithCredentials",
  "dbPath",
  "inbound",
  "replies",
  "mailbox",
  "drafts",
  "destructive",
  "outbound",
  "notifications",
]);
const INBOUND_FIELDS = new Set(["mode", "allowedSenders", "allowAnySender", "rateLimit"]);
const REPLY_FIELDS = new Set(["mode", "allowReplyAll"]);
const MAILBOX_FIELDS = new Set([
  "maxListResults",
  "maxSearchQueryBytes",
  "allowLabelMutation",
  "allowedLabels",
  "allowTrashRestore",
  "allowAttachmentAccess",
  "maxAttachmentBytes",
  "allowedAttachmentTypes",
]);
const DRAFT_FIELDS = new Set([
  "allowNew",
  "allowReply",
  "allowReplyAll",
  "allowForward",
  "allowScheduling",
  "maxScheduleDelayMs",
]);
const DESTRUCTIVE_FIELDS = new Set(["allowPermanentDelete"]);
const OUTBOUND_FIELDS = new Set([
  "allowedTrustLevels",
  "allowedRecipients",
  "maxRecipients",
  "bodyMaxBytes",
  "subjectPrefix",
  "allowDirectDelivery",
  "allowHtml",
  "maxAttachments",
  "maxAttachmentBytes",
  "maxTotalAttachmentBytes",
  "allowedAttachmentTypes",
  "rateLimit",
]);
const INBOUND_RATE_FIELDS = new Set(["globalMaxPerHour", "perSenderMaxPerHour"]);
const OUTBOUND_RATE_FIELDS = new Set([
  "globalMaxPerHour",
  "perRecipientCooldownMs",
  "dedupWindowMs",
]);
const NOTIFICATION_FIELDS = new Set(["destination", "maxAttempts"]);
const TRUST_LEVELS = new Set<TrustLevel>(["creator", "agent", "public"]);
const SENDER_PATTERN = /^\*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const CONTENT_TYPE_PATTERN = /^(?:[a-z0-9!#$&^_.+-]+|\*)\/(?:[a-z0-9!#$&^_.+-]+|\*)$/;
const SYSTEM_LABELS = new Set([
  "blocked",
  "bounced",
  "complained",
  "delivered",
  "failed",
  "received",
  "rejected",
  "scheduled",
  "sending",
  "sent",
  "spam",
  "trash",
  "unauthenticated",
]);

export interface ValidatedAgentMailConfig {
  apiKey: string;
  inboxId: string;
  emailAddress?: string;
  addressVisibility: "creator" | "public";
  apiBaseUrl?: string;
  websocketBaseUrl?: string;
  allowInsecureHttpWithCredentials: boolean;
  dbPath: string;
  inbound: {
    mode: AgentMailInboundMode;
    senderPolicy: "disabled" | "allowlist" | "any";
    allowedSenders: string[];
    rateLimit: {
      globalMaxPerHour: number;
      perSenderMaxPerHour: number;
    };
  };
  replies: {
    mode: AgentMailReplyMode;
    allowReplyAll: boolean;
  };
  mailbox: {
    maxListResults: number;
    maxSearchQueryBytes: number;
    allowLabelMutation: boolean;
    allowedLabels: string[];
    allowTrashRestore: boolean;
    allowAttachmentAccess: boolean;
    maxAttachmentBytes: number;
    allowedAttachmentTypes: string[];
  };
  drafts: {
    allowNew: boolean;
    allowReply: boolean;
    allowReplyAll: boolean;
    allowForward: boolean;
    allowScheduling: boolean;
    maxScheduleDelayMs: number;
  };
  destructive: {
    allowPermanentDelete: boolean;
  };
  outbound: {
    allowedTrustLevels: TrustLevel[];
    allowedRecipients?: string[];
    maxRecipients: number;
    bodyMaxBytes: number;
    subjectPrefix: string;
    allowDirectDelivery: boolean;
    allowHtml: boolean;
    maxAttachments: number;
    maxAttachmentBytes: number;
    maxTotalAttachmentBytes: number;
    allowedAttachmentTypes: string[];
    rateLimit: {
      globalMaxPerHour: number;
      perRecipientCooldownMs: number;
      dedupWindowMs: number;
    };
  };
  notifications?: {
    destination: string;
    maxAttempts: number;
  };
  /** Hash of authorization-relevant validated policy, excluding credentials. */
  policyGeneration: string;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`agentMail: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !fields.has(key));
  if (unknown) throw new Error(`agentMail: unsupported ${label} field ${JSON.stringify(unknown)}`);
}

function requiredString(value: unknown, field: string, env?: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `agentMail: ${field} is required${env === undefined ? "" : ` (set ${env} in .env)`}`,
    );
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`agentMail: ${field} must be a non-empty string`);
  }
  return value;
}

function notificationDestination(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value !== value.trim() ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(
      "agentMail: notifications.destination must be a non-empty Notify destination name without surrounding whitespace or control characters",
    );
  }
  return value;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const candidate = value ?? fallback;
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new Error(`agentMail: ${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return candidate;
}

function senderPattern(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`agentMail: ${field} must be an email address or *@domain pattern`);
  }
  const normalized = value.trim().toLowerCase();
  if (!isWellFormedEmail(normalized) && !SENDER_PATTERN.test(normalized)) {
    throw new Error(`agentMail: ${field} must be an email address or *@domain pattern`);
  }
  return normalized;
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) {
    throw new Error(`agentMail: ${field} must be a non-empty array with at most 1000 entries`);
  }
  const normalized = value.map((entry, index) => senderPattern(entry, `${field}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`agentMail: ${field} must not contain duplicate entries`);
  }
  return normalized;
}

function optionalBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`agentMail: ${field} must be a boolean`);
  return value;
}

function strictStringList(
  value: unknown,
  field: string,
  normalize: (entry: string, index: number) => string,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) {
    throw new Error(`agentMail: ${field} must be a non-empty array with at most 1000 entries`);
  }
  const result = value.map((entry, index) => {
    if (typeof entry !== "string")
      throw new Error(`agentMail: ${field}[${index}] must be a string`);
    return normalize(entry, index);
  });
  if (new Set(result).size !== result.length) {
    throw new Error(`agentMail: ${field} must not contain duplicate entries`);
  }
  return result;
}

function labelList(value: unknown, enabled: boolean): string[] {
  const labels = strictStringList(value, "mailbox.allowedLabels", (entry, index) => {
    const normalized = entry.trim().toLowerCase();
    if (!LABEL_PATTERN.test(normalized) || SYSTEM_LABELS.has(normalized)) {
      throw new Error(
        `agentMail: mailbox.allowedLabels[${index}] must be a non-system label using letters, numbers, dot, underscore, colon, slash, or hyphen`,
      );
    }
    return normalized;
  });
  if (enabled && labels.length === 0) {
    throw new Error(
      "agentMail: mailbox.allowLabelMutation requires a non-empty mailbox.allowedLabels allowlist",
    );
  }
  if (!enabled && labels.length > 0) {
    throw new Error("agentMail: mailbox.allowedLabels requires mailbox.allowLabelMutation: true");
  }
  return labels;
}

function contentTypeList(value: unknown, maxAttachments: number): string[] {
  const types = strictStringList(value, "outbound.allowedAttachmentTypes", (entry, index) => {
    const normalized = entry.trim().toLowerCase();
    if (
      !CONTENT_TYPE_PATTERN.test(normalized) ||
      normalized === "*/*" ||
      normalized.startsWith("*/")
    ) {
      throw new Error(
        `agentMail: outbound.allowedAttachmentTypes[${index}] must be an exact MIME type or a bounded type/* pattern`,
      );
    }
    return normalized;
  });
  if (maxAttachments > 0 && types.length === 0) {
    throw new Error(
      "agentMail: outbound.maxAttachments above zero requires outbound.allowedAttachmentTypes",
    );
  }
  if (maxAttachments === 0 && types.length > 0) {
    throw new Error(
      "agentMail: outbound.allowedAttachmentTypes requires outbound.maxAttachments above zero",
    );
  }
  return types;
}

function mailboxContentTypeList(value: unknown, enabled: boolean): string[] {
  const types = strictStringList(value, "mailbox.allowedAttachmentTypes", (entry, index) => {
    const normalized = entry.trim().toLowerCase();
    if (
      !CONTENT_TYPE_PATTERN.test(normalized) ||
      normalized === "*/*" ||
      normalized.startsWith("*/")
    ) {
      throw new Error(
        `agentMail: mailbox.allowedAttachmentTypes[${index}] must be an exact MIME type or a bounded type/* pattern`,
      );
    }
    return normalized;
  });
  if (enabled && types.length === 0) {
    return ["text/plain", "text/csv", "application/json", "application/xml", "text/xml"];
  }
  if (!enabled && types.length > 0) {
    throw new Error(
      "agentMail: mailbox.allowedAttachmentTypes requires mailbox.allowAttachmentAccess: true",
    );
  }
  return types;
}

function policyGeneration(value: object): string {
  return createHash("sha256")
    .update("agentmail-policy-generation/v1\0", "utf8")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

/**
 * Compile the only supported AgentMail configuration contract. The returned
 * object is normalized and safe for runtime policy decisions; callers must not
 * read policy directly from the unvalidated YAML object.
 */
export function validateAgentMailConfig(value: unknown): ValidatedAgentMailConfig {
  const config = objectValue(value, "config");
  rejectUnknownFields(config, TOP_LEVEL_FIELDS, "config");

  const apiKey = requiredString(config.apiKey, "apiKey", "AGENTMAIL_API_KEY");
  const inboxId = requiredString(config.inboxId, "inboxId", "AGENTMAIL_INBOX_ID");
  const emailAddress = optionalString(config.emailAddress, "emailAddress");
  if (emailAddress !== undefined && !/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(emailAddress)) {
    if (!isWellFormedEmail(emailAddress)) {
      throw new Error("agentMail: emailAddress must be a well-formed email address");
    }
  }
  if (
    config.addressVisibility !== undefined &&
    config.addressVisibility !== "creator" &&
    config.addressVisibility !== "public"
  ) {
    throw new Error('agentMail: addressVisibility must be "creator" or "public"');
  }
  if (
    config.allowInsecureHttpWithCredentials !== undefined &&
    typeof config.allowInsecureHttpWithCredentials !== "boolean"
  ) {
    throw new Error("agentMail: allowInsecureHttpWithCredentials must be a boolean");
  }

  const inbound =
    config.inbound === undefined ? { mode: "none" } : objectValue(config.inbound, "inbound");
  rejectUnknownFields(inbound, INBOUND_FIELDS, "inbound");
  const mode = inbound.mode ?? "none";
  if (mode !== "none" && mode !== "websocket") {
    throw new Error('agentMail: inbound.mode must be "none" or "websocket"');
  }
  if (inbound.allowAnySender !== undefined && typeof inbound.allowAnySender !== "boolean") {
    throw new Error("agentMail: inbound.allowAnySender must be a boolean");
  }
  const allowedSenders = stringArray(inbound.allowedSenders, "inbound.allowedSenders");
  if (inbound.allowAnySender === true && allowedSenders !== undefined) {
    throw new Error(
      "agentMail: inbound.allowedSenders and inbound.allowAnySender cannot be combined",
    );
  }
  if (mode === "none" && (inbound.allowAnySender === true || allowedSenders !== undefined)) {
    throw new Error("agentMail: sender admission cannot be configured while inbound.mode is none");
  }
  if (mode === "websocket" && inbound.allowAnySender !== true && allowedSenders === undefined) {
    throw new Error(
      "agentMail: websocket inbound requires allowedSenders or explicit allowAnySender: true",
    );
  }
  const inboundRate =
    inbound.rateLimit === undefined ? {} : objectValue(inbound.rateLimit, "inbound.rateLimit");
  rejectUnknownFields(inboundRate, INBOUND_RATE_FIELDS, "inbound.rateLimit");
  if (mode === "none" && inbound.rateLimit !== undefined) {
    throw new Error("agentMail: inbound.rateLimit cannot be configured while inbound.mode is none");
  }

  const notifications =
    config.notifications === undefined
      ? undefined
      : objectValue(config.notifications, "notifications");
  if (notifications !== undefined) {
    rejectUnknownFields(notifications, NOTIFICATION_FIELDS, "notifications");
    if (mode !== "websocket") {
      throw new Error(
        'agentMail: notifications require inbound.mode "websocket" so AgentMail events can be observed',
      );
    }
  }

  const replies = config.replies === undefined ? {} : objectValue(config.replies, "replies");
  rejectUnknownFields(replies, REPLY_FIELDS, "replies");
  const replyMode = replies.mode ?? "disabled";
  if (replyMode !== "disabled" && replyMode !== "review") {
    throw new Error('agentMail: replies.mode must be "disabled" or "review"');
  }
  if (replies.allowReplyAll !== undefined && typeof replies.allowReplyAll !== "boolean") {
    throw new Error("agentMail: replies.allowReplyAll must be a boolean");
  }
  if (mode === "none" && replyMode !== "disabled") {
    throw new Error('agentMail: replies.mode must be "disabled" when inbound is disabled');
  }
  if (replyMode === "disabled" && replies.allowReplyAll === true) {
    throw new Error("agentMail: replies.allowReplyAll requires replies.mode review");
  }

  const mailbox = config.mailbox === undefined ? {} : objectValue(config.mailbox, "mailbox");
  rejectUnknownFields(mailbox, MAILBOX_FIELDS, "mailbox");
  const allowLabelMutation = optionalBoolean(
    mailbox.allowLabelMutation,
    false,
    "mailbox.allowLabelMutation",
  );
  const allowedLabels = labelList(mailbox.allowedLabels, allowLabelMutation);
  const allowTrashRestore = optionalBoolean(
    mailbox.allowTrashRestore,
    false,
    "mailbox.allowTrashRestore",
  );
  const allowAttachmentAccess = optionalBoolean(
    mailbox.allowAttachmentAccess,
    false,
    "mailbox.allowAttachmentAccess",
  );
  const mailboxMaxAttachmentBytes = boundedInteger(
    mailbox.maxAttachmentBytes,
    1_048_576,
    "mailbox.maxAttachmentBytes",
    1,
    1_048_576,
  );
  const mailboxAllowedAttachmentTypes = mailboxContentTypeList(
    mailbox.allowedAttachmentTypes,
    allowAttachmentAccess,
  );

  const drafts = config.drafts === undefined ? {} : objectValue(config.drafts, "drafts");
  rejectUnknownFields(drafts, DRAFT_FIELDS, "drafts");
  const allowNewDraft = optionalBoolean(drafts.allowNew, false, "drafts.allowNew");
  const allowReplyDraft = optionalBoolean(drafts.allowReply, false, "drafts.allowReply");
  const allowReplyAllDraft = optionalBoolean(drafts.allowReplyAll, false, "drafts.allowReplyAll");
  const allowForwardDraft = optionalBoolean(drafts.allowForward, false, "drafts.allowForward");
  const allowScheduling = optionalBoolean(drafts.allowScheduling, false, "drafts.allowScheduling");
  const maxScheduleDelayMs = boundedInteger(
    drafts.maxScheduleDelayMs,
    2_592_000_000,
    "drafts.maxScheduleDelayMs",
    60_000,
    31_536_000_000,
  );
  if (!allowScheduling && drafts.maxScheduleDelayMs !== undefined) {
    throw new Error("agentMail: drafts.maxScheduleDelayMs requires drafts.allowScheduling: true");
  }
  if (allowReplyAllDraft && !allowReplyDraft) {
    throw new Error("agentMail: drafts.allowReplyAll requires drafts.allowReply: true");
  }

  const destructive =
    config.destructive === undefined ? {} : objectValue(config.destructive, "destructive");
  rejectUnknownFields(destructive, DESTRUCTIVE_FIELDS, "destructive");
  const allowPermanentDelete = optionalBoolean(
    destructive.allowPermanentDelete,
    false,
    "destructive.allowPermanentDelete",
  );

  const outbound = config.outbound === undefined ? {} : objectValue(config.outbound, "outbound");
  rejectUnknownFields(outbound, OUTBOUND_FIELDS, "outbound");
  let allowedTrustLevels: TrustLevel[] = ["creator"];
  if (outbound.allowedTrustLevels !== undefined) {
    if (!Array.isArray(outbound.allowedTrustLevels) || outbound.allowedTrustLevels.length === 0) {
      throw new Error("agentMail: outbound.allowedTrustLevels must be a non-empty array");
    }
    allowedTrustLevels = outbound.allowedTrustLevels.map((entry, index) => {
      if (typeof entry !== "string" || !TRUST_LEVELS.has(entry as TrustLevel)) {
        throw new Error(
          `agentMail: outbound.allowedTrustLevels[${index}] must be creator, agent, or public`,
        );
      }
      return entry as TrustLevel;
    });
    if (new Set(allowedTrustLevels).size !== allowedTrustLevels.length) {
      throw new Error("agentMail: outbound.allowedTrustLevels must not contain duplicates");
    }
  }
  const allowedRecipients = stringArray(outbound.allowedRecipients, "outbound.allowedRecipients");
  const subjectPrefix = outbound.subjectPrefix ?? "[Auggy] ";
  if (
    typeof subjectPrefix !== "string" ||
    subjectPrefix.length === 0 ||
    subjectPrefix.length > 200
  ) {
    throw new Error("agentMail: outbound.subjectPrefix must be a string from 1 to 200 characters");
  }
  if (/[\r\n\0]/.test(subjectPrefix)) {
    throw new Error("agentMail: outbound.subjectPrefix must not contain control characters");
  }
  const outboundRate =
    outbound.rateLimit === undefined ? {} : objectValue(outbound.rateLimit, "outbound.rateLimit");
  rejectUnknownFields(outboundRate, OUTBOUND_RATE_FIELDS, "outbound.rateLimit");

  const allowDirectDelivery = optionalBoolean(
    outbound.allowDirectDelivery,
    false,
    "outbound.allowDirectDelivery",
  );
  const allowHtml = optionalBoolean(outbound.allowHtml, false, "outbound.allowHtml");
  const maxAttachments = boundedInteger(
    outbound.maxAttachments,
    0,
    "outbound.maxAttachments",
    0,
    50,
  );
  const maxAttachmentBytes = boundedInteger(
    outbound.maxAttachmentBytes,
    10_485_760,
    "outbound.maxAttachmentBytes",
    1,
    25_165_824,
  );
  const maxTotalAttachmentBytes = boundedInteger(
    outbound.maxTotalAttachmentBytes,
    26_214_400,
    "outbound.maxTotalAttachmentBytes",
    1,
    52_428_800,
  );
  if (maxAttachmentBytes > maxTotalAttachmentBytes) {
    throw new Error(
      "agentMail: outbound.maxAttachmentBytes cannot exceed outbound.maxTotalAttachmentBytes",
    );
  }
  const allowedAttachmentTypes = contentTypeList(outbound.allowedAttachmentTypes, maxAttachments);

  const validated = {
    apiKey,
    inboxId,
    ...(emailAddress === undefined ? {} : { emailAddress }),
    addressVisibility: config.addressVisibility === "public" ? "public" : "creator",
    ...(optionalString(config.apiBaseUrl, "apiBaseUrl") === undefined
      ? {}
      : { apiBaseUrl: config.apiBaseUrl as string }),
    ...(optionalString(config.websocketBaseUrl, "websocketBaseUrl") === undefined
      ? {}
      : { websocketBaseUrl: config.websocketBaseUrl as string }),
    allowInsecureHttpWithCredentials: config.allowInsecureHttpWithCredentials === true,
    dbPath:
      optionalString(config.dbPath, "dbPath") ?? "./data/agent-mail/agentMail/orchestration.db",
    inbound: {
      mode,
      senderPolicy:
        mode === "none" ? "disabled" : inbound.allowAnySender === true ? "any" : "allowlist",
      allowedSenders: allowedSenders ?? [],
      rateLimit: {
        globalMaxPerHour: boundedInteger(
          inboundRate.globalMaxPerHour,
          100,
          "inbound.rateLimit.globalMaxPerHour",
          1,
          100_000,
        ),
        perSenderMaxPerHour: boundedInteger(
          inboundRate.perSenderMaxPerHour,
          5,
          "inbound.rateLimit.perSenderMaxPerHour",
          1,
          10_000,
        ),
      },
    },
    replies: {
      mode: replyMode,
      allowReplyAll: replies.allowReplyAll === true,
    },
    mailbox: {
      maxListResults: boundedInteger(mailbox.maxListResults, 50, "mailbox.maxListResults", 1, 100),
      maxSearchQueryBytes: boundedInteger(
        mailbox.maxSearchQueryBytes,
        1_024,
        "mailbox.maxSearchQueryBytes",
        1,
        8_192,
      ),
      allowLabelMutation,
      allowedLabels,
      allowTrashRestore,
      allowAttachmentAccess,
      maxAttachmentBytes: mailboxMaxAttachmentBytes,
      allowedAttachmentTypes: mailboxAllowedAttachmentTypes,
    },
    drafts: {
      allowNew: allowNewDraft,
      allowReply: allowReplyDraft,
      allowReplyAll: allowReplyAllDraft,
      allowForward: allowForwardDraft,
      allowScheduling,
      maxScheduleDelayMs,
    },
    destructive: { allowPermanentDelete },
    outbound: {
      allowedTrustLevels,
      ...(allowedRecipients === undefined ? {} : { allowedRecipients }),
      maxRecipients: boundedInteger(outbound.maxRecipients, 10, "outbound.maxRecipients", 1, 50),
      bodyMaxBytes: boundedInteger(
        outbound.bodyMaxBytes,
        102_400,
        "outbound.bodyMaxBytes",
        1,
        1_048_576,
      ),
      subjectPrefix,
      allowDirectDelivery,
      allowHtml,
      maxAttachments,
      maxAttachmentBytes,
      maxTotalAttachmentBytes,
      allowedAttachmentTypes,
      rateLimit: {
        globalMaxPerHour: boundedInteger(
          outboundRate.globalMaxPerHour,
          10,
          "outbound.rateLimit.globalMaxPerHour",
          1,
          10_000,
        ),
        perRecipientCooldownMs: boundedInteger(
          outboundRate.perRecipientCooldownMs,
          300_000,
          "outbound.rateLimit.perRecipientCooldownMs",
          0,
          2_592_000_000,
        ),
        dedupWindowMs: boundedInteger(
          outboundRate.dedupWindowMs,
          300_000,
          "outbound.rateLimit.dedupWindowMs",
          0,
          2_592_000_000,
        ),
      },
    },
    ...(notifications === undefined
      ? {}
      : {
          notifications: {
            destination: notificationDestination(notifications.destination),
            maxAttempts: boundedInteger(
              notifications.maxAttempts,
              3,
              "notifications.maxAttempts",
              1,
              20,
            ),
          },
        }),
  } satisfies Omit<ValidatedAgentMailConfig, "policyGeneration">;
  return {
    ...validated,
    policyGeneration: policyGeneration({
      inboxId: validated.inboxId,
      inbound: validated.inbound,
      replies: validated.replies,
      mailbox: validated.mailbox,
      drafts: validated.drafts,
      destructive: validated.destructive,
      outbound: validated.outbound,
    }),
  };
}

export function agentMailRequiresAdminRoute(config: ValidatedAgentMailConfig): boolean {
  return config.replies.mode === "review";
}

/** Convert the public options type without weakening runtime validation. */
export function validateTypedAgentMailConfig(
  value: AgentMailAugmentOptions,
): ValidatedAgentMailConfig {
  return validateAgentMailConfig(value);
}
