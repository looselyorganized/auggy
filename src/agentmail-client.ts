/**
 * AgentMail HTTP client — stateless infrastructure shared by the notify
 * agentmail adapter and (future) the agentMail augment.
 *
 * Pattern matches src/telegram-client.ts: env-var or constructor-arg keyed,
 * no SQLite state, no augment-system coupling.
 */

import { createHttpClient } from "./http";
import type { HttpClient } from "./http";
import {
  isAmbiguousMutationStatus,
  isOutcomeUnknownError,
  OutcomeUnknownError,
} from "./outcome-unknown";
import { assertSecureCredentialTransport } from "./engines/_shared/credential-transport";

const DEFAULT_BASE_URL = "https://api.agentmail.to/v0";
const MAX_RECIPIENTS = 50;
const MAX_PROVIDER_ID_CHARS = 256;

function isBoundedProviderId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PROVIDER_ID_CHARS;
}

export interface AgentMailClientOptions {
  apiKey: string;
  /** Override AgentMail API base URL (testing/sandbox). */
  apiBaseUrl?: string;
  /** Development-only escape hatch for credentialed non-loopback HTTP. */
  allowInsecureHttpWithCredentials?: boolean;
  /** Timeout per request. Default 15s. */
  timeoutMs?: number;
  /** Test-only HTTP client override. */
  http?: Pick<HttpClient, "post" | "get">;
}

export interface AgentMailInboxInfo {
  /** Canonical provider identity; the returned inbox ID must match the request. */
  inboxId: string;
  email: string;
  displayName?: string;
  status: "ok";
}

export interface AgentMailInboxError {
  status: "failed";
  detail: string;
  /** HTTP status if the failure originated from AgentMail (vs. network). */
  httpStatus?: number;
  /** Distinguishes provider rejection, transport failure, and invalid successful identity data. */
  failureKind?: "provider" | "network" | "invalid-response";
}

export interface SendMessageInput {
  inboxId: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  labels?: string[];
  signal?: AbortSignal;
}

export interface ReplyMessageInput {
  inboxId: string;
  /** AgentMail message_id of the inbound message being replied to. */
  messageId: string;
  text: string;
  html?: string;
  labels?: string[];
  /** Override recipients (default: original sender via In-Reply-To). */
  to?: string[];
  /** Reply to all recipients of the original (default false). */
  replyAll?: boolean;
  signal?: AbortSignal;
}

export interface ForwardMessageInput {
  inboxId: string;
  /** AgentMail message_id of the inbound message being forwarded. */
  messageId: string;
  to: string[];
  text?: string;
  html?: string;
  /** Subject override; AgentMail prepends "Fwd: " to the original when omitted. */
  subject?: string;
  labels?: string[];
  signal?: AbortSignal;
}

export interface SendMessageResult {
  status: "sent";
  messageId: string;
  threadId: string;
}

export interface SendMessageError {
  status: "failed";
  detail: string;
  /**
   * HTTP status if AgentMail definitively rejected the request. When absent,
   * delivery may be ambiguous (for example, the connection was lost after
   * AgentMail accepted the message), so reviewed sends must remain fail-closed.
   */
  httpStatus?: number;
  /** AgentMail-returned Retry-After if 429. */
  retryAfterSec?: number;
}

export interface AgentMailClient {
  send(input: SendMessageInput): Promise<SendMessageResult | SendMessageError>;
  /** Reply to an existing message in its thread. POST /inboxes/{id}/messages/{messageId}/reply. */
  reply(input: ReplyMessageInput): Promise<SendMessageResult | SendMessageError>;
  /** Forward an existing message. POST /inboxes/{id}/messages/{messageId}/forward. */
  forward(input: ForwardMessageInput): Promise<SendMessageResult | SendMessageError>;
  /**
   * Best-effort healthcheck. Pings AgentMail's `inboxes.get` endpoint to
   * confirm the inbox exists and the API key has access. Used by visitorAuth
   * and agentMail during boot. Callers fail closed on deterministic identity
   * or configuration errors, while transient provider and network failures
   * may degrade without blocking startup.
   */
  getInbox(inboxId: string): Promise<AgentMailInboxInfo | AgentMailInboxError>;
}

export function createAgentMailClient(opts: AgentMailClientOptions): AgentMailClient {
  const baseUrl = opts.apiBaseUrl ?? DEFAULT_BASE_URL;
  assertSecureCredentialTransport({
    provider: "AgentMail",
    baseURL: baseUrl,
    credential: opts.apiKey,
    allowInsecureHttpWithCredentials: opts.allowInsecureHttpWithCredentials,
  });
  const http =
    opts.http ??
    createHttpClient({
      timeoutMs: opts.timeoutMs ?? 15_000,
      userAgent: "auggy-agentmail-client/0.1",
      urlPolicy: "operator-configured",
    });
  async function postSend(
    url: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<SendMessageResult | SendMessageError> {
    try {
      const res = await http.post(url, {
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body,
        signal,
      });
      if (res.status < 200 || res.status >= 300) {
        if (isAmbiguousMutationStatus(res.status)) {
          throw new OutcomeUnknownError(
            `AgentMail returned HTTP ${res.status} after send dispatch; delivery outcome is unknown`,
          );
        }
        const result: SendMessageError = {
          status: "failed",
          detail: `agentmail returned HTTP ${res.status}`,
          httpStatus: res.status,
        };
        if (res.status === 429) {
          const retry = res.headers.get("retry-after");
          if (retry) result.retryAfterSec = Number(retry) || undefined;
        }
        return result;
      }
      let parsed: { message_id?: unknown; thread_id?: unknown };
      try {
        parsed = JSON.parse(res.body) as { message_id?: unknown; thread_id?: unknown };
      } catch {
        throw new OutcomeUnknownError(
          "AgentMail accepted a send request but returned an unreadable response; delivery outcome is unknown",
        );
      }
      if (!isBoundedProviderId(parsed.message_id) || !isBoundedProviderId(parsed.thread_id)) {
        throw new OutcomeUnknownError(
          "AgentMail accepted a send request but returned invalid message identity data; delivery outcome is unknown",
        );
      }
      return { status: "sent", messageId: parsed.message_id, threadId: parsed.thread_id };
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      if (isOutcomeUnknownError(err)) throw err;
      throw new OutcomeUnknownError(
        "AgentMail send ended without a trustworthy response after dispatch",
      );
    }
  }

  function recipientError(to: string[] | undefined): SendMessageError | null {
    if (to === undefined) return null;
    if (to.length === 0) {
      return { status: "failed", detail: "agentmail requires at least one recipient" };
    }
    if (to.length > MAX_RECIPIENTS) {
      return {
        status: "failed",
        detail: `agentmail supports at most ${MAX_RECIPIENTS} recipients per send/reply/forward`,
      };
    }
    return null;
  }

  return {
    async send(input) {
      const invalidRecipients = recipientError(input.to);
      if (invalidRecipients) return invalidRecipients;
      const url = `${baseUrl}/inboxes/${input.inboxId}/messages/send`;
      const body = JSON.stringify({
        to: input.to,
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
      });
      return postSend(url, body, input.signal);
    },
    async reply(input) {
      const invalidRecipients = recipientError(input.to);
      if (invalidRecipients) return invalidRecipients;
      const url = `${baseUrl}/inboxes/${input.inboxId}/messages/${input.messageId}/reply`;
      const body = JSON.stringify({
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        ...(input.to ? { to: input.to } : {}),
        ...(input.replyAll ? { reply_all: true } : {}),
        ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
      });
      return postSend(url, body, input.signal);
    },
    async forward(input) {
      const invalidRecipients = recipientError(input.to);
      if (invalidRecipients) return invalidRecipients;
      const url = `${baseUrl}/inboxes/${input.inboxId}/messages/${input.messageId}/forward`;
      const body = JSON.stringify({
        to: input.to,
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.text ? { text: input.text } : {}),
        ...(input.html ? { html: input.html } : {}),
        ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
      });
      return postSend(url, body, input.signal);
    },
    async getInbox(inboxId: string) {
      const url = `${baseUrl}/inboxes/${encodeURIComponent(inboxId)}`;
      try {
        const res = await http.get(url, {
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
          },
        });
        if (res.status < 200 || res.status >= 300) {
          return {
            status: "failed" as const,
            detail: `agentmail returned HTTP ${res.status}`,
            httpStatus: res.status,
            failureKind: "provider" as const,
          };
        }
        const parsed = parseInboxResponse(res.body, inboxId);
        if (!parsed) {
          return {
            status: "failed" as const,
            detail: "agentmail returned an invalid inbox response",
            httpStatus: res.status,
            failureKind: "invalid-response" as const,
          };
        }
        return { ...parsed, status: "ok" as const };
      } catch {
        return {
          status: "failed" as const,
          detail: "agentmail request failed",
          failureKind: "network" as const,
        };
      }
    },
  };
}

function parseInboxResponse(
  body: string,
  expectedInboxId: string,
): Omit<AgentMailInboxInfo, "status"> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const inboxId = strictString(parsed.inbox_id);
  const email = strictEmail(parsed.email);
  const displayName = optionalDisplayName(parsed.display_name);
  if (inboxId !== expectedInboxId || !email || displayName === null) return null;

  return {
    inboxId,
    email,
    ...(displayName === undefined ? {} : { displayName }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictString(value: unknown): string | null {
  if (typeof value !== "string" || !value || value !== value.trim()) return null;
  if (/\p{Cc}/u.test(value)) return null;
  return value;
}

function strictEmail(value: unknown): string | null {
  const email = strictString(value);
  if (!email || email.length > 254 || /\s/u.test(email)) return null;

  const at = email.lastIndexOf("@");
  if (at <= 0 || at !== email.indexOf("@") || at === email.length - 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || domain.length > 253) return null;
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;

  const labels = domain.split(".");
  if (labels.length < 2) return null;
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[A-Za-z0-9-]+$/.test(label) ||
        label.startsWith("-") ||
        label.endsWith("-"),
    )
  ) {
    return null;
  }
  return email;
}

function optionalDisplayName(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  const displayName = strictString(value);
  if (!displayName || displayName.length > 256) return null;
  return displayName;
}
