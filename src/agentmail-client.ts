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
  http?: Pick<HttpClient, "post">;
}

export interface SendMessageInput {
  inboxId: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
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
}

export function createAgentMailClient(opts: AgentMailClientOptions): AgentMailClient {
  const baseUrl = opts.apiBaseUrl ?? DEFAULT_BASE_URL;
  const http =
    opts.http ??
    createHttpClient({
      timeoutMs: opts.timeoutMs ?? 15_000,
      userAgent: "auggy-agentmail-client/0.1",
    });
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
    },
  };
}
