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
  "outbound",
  "notifications",
]);
const INBOUND_FIELDS = new Set(["mode", "allowedSenders", "allowAnySender", "rateLimit"]);
const REPLY_FIELDS = new Set(["mode", "allowReplyAll"]);
const OUTBOUND_FIELDS = new Set([
  "allowedTrustLevels",
  "allowedRecipients",
  "maxRecipients",
  "bodyMaxBytes",
  "subjectPrefix",
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
  outbound: {
    allowedTrustLevels: TrustLevel[];
    allowedRecipients?: string[];
    maxRecipients: number;
    bodyMaxBytes: number;
    subjectPrefix: string;
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

  return {
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
