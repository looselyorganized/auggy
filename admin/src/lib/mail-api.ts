import {
  adminFetch,
  postAction,
  type ActionPostResult,
  type AdminFetchDependencies,
} from "./api";
import type { CsrfToken } from "./types";
import { isSafeMailDetailPath } from "./mail-path";

export const MAX_MAIL_BODY_CHARS = 1024 * 1024;
const MAX_MAIL_LABELS = 100;
const MAX_MAIL_LABEL_CHARS = 200;

interface MailQueuedActionBase {
  text: string;
  html?: string;
  labels: string[];
}

export type MailQueuedAction =
  | (MailQueuedActionBase & {
      kind: "send";
    })
  | (MailQueuedActionBase & {
      kind: "reply";
      messageId: string;
      replyAll?: boolean;
    })
  | (MailQueuedActionBase & {
      kind: "forward";
      messageId: string;
    });

export interface MailReviewDetail {
  kind: "review";
  reviewId: string;
  fingerprint: string;
  state: "pending" | "sending";
  trustLevel: string;
  expiresAt: string;
  recipients: string[];
  subject: string;
  request: MailQueuedAction;
}

export interface MailMessageDetail {
  kind: "message";
  messageId: string;
  sender: string;
  subject: string;
  receivedAt: string;
  text?: string;
  html?: string;
}

export type MailDetail = MailReviewDetail | MailMessageDetail;

export class MailDetailError extends Error {
  constructor(
    readonly code: "not-found" | "stale" | "invalid" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "MailDetailError";
  }
}

export async function fetchMailDetail(
  path: string,
  dependencies: AdminFetchDependencies = {},
): Promise<MailDetail> {
  if (!isSafeMailDetailPath(path)) {
    throw new MailDetailError("invalid", "The mail detail path is invalid.");
  }
  let response: Response;
  try {
    response = await adminFetch(
      `/console/api/mail-detail?path=${encodeURIComponent(path)}`,
      {
        headers: { accept: "application/json" },
        cache: "no-store",
      },
      dependencies,
    );
  } catch {
    throw new MailDetailError("unavailable", "Mail details are temporarily unavailable.");
  }
  if (response.status === 404) {
    throw new MailDetailError("not-found", "This mail item no longer exists.");
  }
  if (response.status === 409 || response.status === 410) {
    throw new MailDetailError("stale", "This mail item changed. Refresh the action center.");
  }
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    throw new MailDetailError(
      "unavailable",
      `Mail details are unavailable (HTTP ${response.status}).`,
    );
  }
  const parsed = parseMailDetail(await response.json());
  if (!parsed) {
    throw new MailDetailError("invalid", "The mail detail response was invalid.");
  }
  return parsed;
}

export interface PostMailActionInput {
  tokens: CsrfToken[];
  augmentName: string;
  actionId: string;
  rowKey: string;
  values?: Record<string, string>;
}

export async function postMailAction(
  input: PostMailActionInput,
  dependencies: AdminFetchDependencies = {},
): Promise<ActionPostResult> {
  const matches = input.tokens.filter(
    (token) =>
      token.augmentName === input.augmentName &&
      token.actionId === input.actionId &&
      token.rowKey === input.rowKey &&
      token.token.length > 0,
  );
  if (matches.length !== 1) {
    return {
      ok: false,
      csrfExpired: false,
      conflict: true,
      status: 409,
      message: "This action is stale or unavailable. Refresh the action center.",
    };
  }
  return postAction(
    input.actionId,
    matches[0]!.token,
    input.values,
    input.rowKey,
    input.augmentName,
    dependencies,
  );
}

export function isStaleMailActionResult(result: ActionPostResult): boolean {
  if (result.conflict || result.status === 409 || result.status === 410) return true;
  if (result.ok) return false;
  return /\b(stale|changed|no longer|not found|unknown review|does not match|expired)\b/i.test(
    result.message,
  );
}

function parseMailDetail(value: unknown): MailDetail | null {
  if (!isRecord(value)) return null;
  if (typeof value.fingerprint === "string") return parseReviewDetail(value);
  const message = isRecord(value.message) ? value.message : value;
  return parseMessageDetail(message);
}

function parseReviewDetail(value: Record<string, unknown>): MailReviewDetail | null {
  if (
    !isBoundedString(value.reviewId, 128) ||
    !isBoundedString(value.fingerprint, 256) ||
    (value.state !== "pending" && value.state !== "sending") ||
    !isBoundedString(value.trustLevel, 64) ||
    !isBoundedString(value.expiresAt, 64) ||
    !Array.isArray(value.recipients) ||
    value.recipients.length > 50 ||
    !value.recipients.every((recipient) => isBoundedString(recipient, 320)) ||
    !isBoundedString(value.subject, 1_000, true) ||
    !isRecord(value.request) ||
    value.request.kind !== "send" &&
    value.request.kind !== "reply" &&
    value.request.kind !== "forward"
  ) {
    return null;
  }
  const requestText =
    value.request.text === undefined && value.request.kind === "forward"
      ? ""
      : value.request.text;
  if (typeof requestText !== "string" || requestText.length > MAX_MAIL_BODY_CHARS) return null;
  if (
    value.request.html !== undefined &&
    (typeof value.request.html !== "string" ||
      value.request.html.length > MAX_MAIL_BODY_CHARS)
  ) {
    return null;
  }
  const html = typeof value.request.html === "string" ? value.request.html : undefined;
  if (
    value.request.labels !== undefined &&
    (!Array.isArray(value.request.labels) ||
      value.request.labels.length > MAX_MAIL_LABELS ||
      !value.request.labels.every(
        (label) => isBoundedString(label, MAX_MAIL_LABEL_CHARS),
      ))
  ) {
    return null;
  }
  const labels = Array.isArray(value.request.labels)
    ? (value.request.labels as string[])
    : [];
  const messageId =
    value.request.kind === "send"
      ? undefined
      : isBoundedString(value.request.messageId, 256)
        ? value.request.messageId
        : null;
  if (messageId === null) return null;
  if (
    value.request.kind === "reply" &&
    value.request.replyAll !== undefined &&
    typeof value.request.replyAll !== "boolean"
  ) {
    return null;
  }
  return {
    kind: "review",
    reviewId: value.reviewId,
    fingerprint: value.fingerprint,
    state: value.state,
    trustLevel: value.trustLevel,
    expiresAt: value.expiresAt,
    recipients: value.recipients,
    subject: value.subject,
    request:
      value.request.kind === "send"
        ? {
            kind: "send",
            text: requestText,
            ...(html !== undefined ? { html } : {}),
            labels,
          }
        : value.request.kind === "reply"
          ? {
              kind: "reply",
              messageId: messageId!,
              text: requestText,
              ...(html !== undefined ? { html } : {}),
              ...(typeof value.request.replyAll === "boolean"
                ? { replyAll: value.request.replyAll }
                : {}),
              labels,
            }
          : {
              kind: "forward",
              messageId: messageId!,
              text: requestText,
              ...(html !== undefined ? { html } : {}),
              labels,
            },
  };
}

function parseMessageDetail(value: Record<string, unknown>): MailMessageDetail | null {
  const sender = typeof value.sender === "string" ? value.sender : value.from;
  const receivedAt =
    typeof value.receivedAt === "string" ? value.receivedAt : value.timestamp;
  if (
    !isBoundedString(value.messageId, 256) ||
    !isBoundedString(sender, 320) ||
    !isBoundedString(value.subject, 1_000) ||
    !isBoundedString(receivedAt, 64)
  ) {
    return null;
  }
  const text = optionalBoundedString(value.text, MAX_MAIL_BODY_CHARS);
  const html = optionalBoundedString(value.html, MAX_MAIL_BODY_CHARS);
  return {
    kind: "message",
    messageId: value.messageId,
    sender,
    subject: value.subject,
    receivedAt,
    ...(text ? { text } : {}),
    ...(html ? { html } : {}),
  };
}

function optionalBoundedString(value: unknown, max: number): string | undefined {
  return value === undefined ? undefined : isBoundedString(value, max) ? value : undefined;
}

function isBoundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= max
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
