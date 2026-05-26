/**
 * AgentMail HTTP client — stateless infrastructure shared by the notify
 * agentmail adapter and (future) the agentMail augment.
 *
 * Pattern matches src/telegram-client.ts: env-var or constructor-arg keyed,
 * no SQLite state, no augment-system coupling.
 */

import { createHttpClient } from "./http";
import type { HttpClient } from "./http";

const DEFAULT_BASE_URL = "https://api.agentmail.to/v0";

export interface AgentMailClientOptions {
  apiKey: string;
  /** Override AgentMail API base URL (testing/sandbox). */
  apiBaseUrl?: string;
  /** Timeout per request. Default 15s. */
  timeoutMs?: number;
  /** Test-only HTTP client override. */
  http?: Pick<HttpClient, "post" | "get">;
}

export interface AgentMailInboxInfo {
  inboxId: string;
  /** Echoed back when the inbox exists. */
  status: "ok";
}

export interface AgentMailInboxError {
  status: "failed";
  detail: string;
  /** HTTP status if the failure originated from AgentMail (vs. network). */
  httpStatus?: number;
}

export interface SendMessageInput {
  inboxId: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  labels?: string[];
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
}

export interface SendMessageResult {
  status: "sent";
  messageId: string;
  threadId: string;
}

export interface SendMessageError {
  status: "failed";
  detail: string;
  /** HTTP status if the failure originated from AgentMail (vs. network). */
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
   * onBoot. Caller should warn-and-continue on failure: a transient AgentMail
   * outage shouldn't block agent startup; the first real send will surface
   * the same error.
   */
  getInbox(inboxId: string): Promise<AgentMailInboxInfo | AgentMailInboxError>;
}

export function createAgentMailClient(opts: AgentMailClientOptions): AgentMailClient {
  const baseUrl = opts.apiBaseUrl ?? DEFAULT_BASE_URL;
  const http =
    opts.http ??
    createHttpClient({
      timeoutMs: opts.timeoutMs ?? 15_000,
      userAgent: "auggy-agentmail-client/0.1",
    });
  async function postSend(
    url: string,
    body: string,
  ): Promise<SendMessageResult | SendMessageError> {
    try {
      const res = await http.post(url, {
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body,
      });
      if (res.status < 200 || res.status >= 300) {
        const result: SendMessageError = {
          status: "failed",
          detail: `agentmail returned ${res.status}: ${res.body.slice(0, 200)}`,
          httpStatus: res.status,
        };
        if (res.status === 429) {
          const retry = res.headers.get("retry-after");
          if (retry) result.retryAfterSec = Number(retry) || undefined;
        }
        return result;
      }
      const parsed = JSON.parse(res.body) as { message_id: string; thread_id: string };
      return { status: "sent", messageId: parsed.message_id, threadId: parsed.thread_id };
    } catch (err) {
      return { status: "failed", detail: `agentmail error: ${(err as Error).message}` };
    }
  }

  return {
    async send(input) {
      const url = `${baseUrl}/inboxes/${input.inboxId}/messages`;
      const body = JSON.stringify({
        to: input.to,
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
      });
      return postSend(url, body);
    },
    async reply(input) {
      const url = `${baseUrl}/inboxes/${input.inboxId}/messages/${input.messageId}/reply`;
      const body = JSON.stringify({
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        ...(input.to ? { to: input.to } : {}),
        ...(input.replyAll ? { reply_all: true } : {}),
        ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
      });
      return postSend(url, body);
    },
    async forward(input) {
      const url = `${baseUrl}/inboxes/${input.inboxId}/messages/${input.messageId}/forward`;
      const body = JSON.stringify({
        to: input.to,
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.text ? { text: input.text } : {}),
        ...(input.html ? { html: input.html } : {}),
        ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
      });
      return postSend(url, body);
    },
    async getInbox(inboxId: string) {
      const url = `${baseUrl}/inboxes/${inboxId}`;
      try {
        const res = await http.get(url, {
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
          },
        });
        if (res.status < 200 || res.status >= 300) {
          return {
            status: "failed" as const,
            detail: `agentmail returned ${res.status}: ${res.body.slice(0, 200)}`,
            httpStatus: res.status,
          };
        }
        return { inboxId, status: "ok" as const };
      } catch (err) {
        return { status: "failed" as const, detail: `agentmail error: ${(err as Error).message}` };
      }
    },
  };
}
