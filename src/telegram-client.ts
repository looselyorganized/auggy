/**
 * Shared Telegram bot API client.
 *
 * Used by both `notify`'s telegram adapter and `telegramTransport`. NOT a
 * cross-augment dependency — peer library import only. Mirrors the shared-
 * utility pattern of `src/http.ts` and `src/engines/_shared/cost.ts`.
 *
 * Future bot-API surface (file uploads, editMessageText for streaming-edit
 * replies, reactions, inline keyboards) MUST land here, not be duplicated
 * across notify and telegramTransport.
 */

import type { HttpClient } from "./http";
import { createHttpClient } from "./http";
import {
  isAmbiguousMutationStatus,
  isOutcomeUnknownError,
  OutcomeUnknownError,
} from "./outcome-unknown";
import { assertSecureCredentialTransport } from "./engines/_shared/credential-transport";

export interface SendMessageOptions {
  parseMode?: "Markdown" | "HTML" | "MarkdownV2";
  replyToMessageId?: number;
  disableNotification?: boolean;
  signal?: AbortSignal;
}

export interface SendMessageResult {
  messageId: number;
  chatId: number | string;
}

export interface GetUpdatesOptions {
  offset?: number;
  timeoutSec?: number;
  allowedUpdates?: string[];
  signal?: AbortSignal;
}

export interface SetWebhookOptions {
  allowedUpdates?: string[];
  dropPendingUpdates?: boolean;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; is_bot: boolean; first_name?: string; username?: string };
  chat: { id: number; type: string };
  date: number;
  text?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  first_name?: string;
  username?: string;
}

export interface TelegramBotClient {
  sendMessage(
    chatId: number | string,
    text: string,
    opts?: SendMessageOptions,
  ): Promise<SendMessageResult>;
  getUpdates(opts: GetUpdatesOptions): Promise<TelegramUpdate[]>;
  setWebhook(url: string, secretToken: string, opts?: SetWebhookOptions): Promise<void>;
  deleteWebhook(): Promise<void>;
  getChat(chatId: number | string): Promise<TelegramChat>;
}

export interface CreateTelegramBotClientOptions {
  botToken: string;
  client?: Pick<HttpClient, "post">;
  baseUrl?: string;
  /** Development-only escape hatch for token-bearing non-loopback HTTP. */
  allowInsecureHttpWithCredentials?: boolean;
}

interface BotApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export function createTelegramBotClient(opts: CreateTelegramBotClientOptions): TelegramBotClient {
  const baseUrl = opts.baseUrl ?? "https://api.telegram.org";
  assertSecureCredentialTransport({
    provider: "Telegram",
    baseURL: baseUrl,
    credential: opts.botToken,
    allowInsecureHttpWithCredentials: opts.allowInsecureHttpWithCredentials,
  });
  const url = (method: string) => `${baseUrl}/bot${opts.botToken}/${method}`;
  const http =
    opts.client ??
    createHttpClient({
      timeoutMs: 60_000,
      userAgent: "auggy-telegram/0.1",
      urlPolicy: "operator-configured",
    });

  async function call<T>(
    method: string,
    body: Record<string, unknown>,
    opts: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const isReadOnly = method === "getUpdates" || method === "getChat";
    let res: Awaited<ReturnType<HttpClient["post"]>>;
    try {
      res = await http.post(url(method), {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal?.aborted || isOutcomeUnknownError(err) || isReadOnly) throw err;
      throw new OutcomeUnknownError(
        `Telegram bot API ${method} ended without a trustworthy response after dispatch`,
        { cause: err },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch (err) {
      if (isReadOnly) {
        throw new Error(`Telegram bot API ${method}: non-JSON response (${res.status})`);
      }
      throw new OutcomeUnknownError(
        `Telegram bot API ${method} returned an unreadable response after dispatch`,
        { cause: err },
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { ok?: unknown }).ok !== "boolean"
    ) {
      if (!isReadOnly) {
        throw new OutcomeUnknownError(
          `Telegram bot API ${method} returned a malformed response after dispatch`,
        );
      }
      throw new Error(`Telegram bot API ${method}: malformed response (${res.status})`);
    }
    const envelope = parsed as BotApiResponse<T>;
    if (envelope.ok && (envelope.result === undefined || envelope.result === null)) {
      if (!isReadOnly) {
        throw new OutcomeUnknownError(
          `Telegram bot API ${method} returned an incomplete response after dispatch`,
        );
      }
      throw new Error(`Telegram bot API ${method}: non-JSON response (${res.status})`);
    }
    if (!envelope.ok) {
      if (!isReadOnly && isAmbiguousMutationStatus(res.status)) {
        throw new OutcomeUnknownError(
          `Telegram bot API ${method} returned HTTP ${res.status} after dispatch; outcome is unknown`,
        );
      }
      throw new Error(
        `Telegram bot API ${method}: ${envelope.description ?? "unknown error"} (${res.status})`,
      );
    }
    return envelope.result as T;
  }

  return {
    async sendMessage(chatId, text, sendOpts) {
      const body: Record<string, unknown> = { chat_id: chatId, text };
      if (sendOpts?.parseMode) body.parse_mode = sendOpts.parseMode;
      if (sendOpts?.replyToMessageId != null) body.reply_to_message_id = sendOpts.replyToMessageId;
      if (sendOpts?.disableNotification) body.disable_notification = true;
      const result = await call<{ message_id: number; chat: { id: number | string } }>(
        "sendMessage",
        body,
        { signal: sendOpts?.signal },
      );
      if (
        typeof result !== "object" ||
        result === null ||
        typeof result.message_id !== "number" ||
        typeof result.chat !== "object" ||
        result.chat === null ||
        (typeof result.chat.id !== "number" && typeof result.chat.id !== "string")
      ) {
        throw new OutcomeUnknownError(
          "Telegram bot API sendMessage returned an incomplete response after dispatch",
        );
      }
      return { messageId: result.message_id, chatId: result.chat.id };
    },

    async getUpdates(getOpts) {
      const body: Record<string, unknown> = {};
      if (getOpts.offset != null) body.offset = getOpts.offset;
      if (getOpts.timeoutSec != null) body.timeout = getOpts.timeoutSec;
      if (getOpts.allowedUpdates) body.allowed_updates = getOpts.allowedUpdates;
      return await call<TelegramUpdate[]>("getUpdates", body, { signal: getOpts.signal });
    },

    async setWebhook(webhookUrl, secretToken, webhookOpts) {
      const body: Record<string, unknown> = { url: webhookUrl, secret_token: secretToken };
      if (webhookOpts?.allowedUpdates) body.allowed_updates = webhookOpts.allowedUpdates;
      if (webhookOpts?.dropPendingUpdates) body.drop_pending_updates = true;
      const accepted = await call<true>("setWebhook", body);
      if (accepted !== true) {
        throw new OutcomeUnknownError(
          "Telegram bot API setWebhook returned an incomplete response after dispatch",
        );
      }
    },

    async deleteWebhook() {
      const accepted = await call<true>("deleteWebhook", {});
      if (accepted !== true) {
        throw new OutcomeUnknownError(
          "Telegram bot API deleteWebhook returned an incomplete response after dispatch",
        );
      }
    },

    async getChat(chatId) {
      return await call<TelegramChat>("getChat", { chat_id: chatId });
    },
  };
}
