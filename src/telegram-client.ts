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

export interface SendMessageOptions {
  parseMode?: "Markdown" | "HTML" | "MarkdownV2";
  replyToMessageId?: number;
  disableNotification?: boolean;
}

export interface SendMessageResult {
  messageId: number;
  chatId: number | string;
}

export interface GetUpdatesOptions {
  offset?: number;
  timeoutSec?: number;
  allowedUpdates?: string[];
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
}

interface BotApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export function createTelegramBotClient(opts: CreateTelegramBotClientOptions): TelegramBotClient {
  const baseUrl = opts.baseUrl ?? "https://api.telegram.org";
  const url = (method: string) => `${baseUrl}/bot${opts.botToken}/${method}`;
  const http =
    opts.client ?? createHttpClient({ timeoutMs: 60_000, userAgent: "auggy-telegram/0.1" });

  async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await http.post(url(method), {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let parsed: BotApiResponse<T>;
    try {
      parsed = JSON.parse(res.body) as BotApiResponse<T>;
    } catch {
      throw new Error(`Telegram bot API ${method}: non-JSON response (${res.status})`);
    }
    if (!parsed.ok) {
      throw new Error(
        `Telegram bot API ${method}: ${parsed.description ?? "unknown error"} (${res.status})`,
      );
    }
    return parsed.result as T;
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
      );
      return { messageId: result.message_id, chatId: result.chat.id };
    },

    async getUpdates(getOpts) {
      const body: Record<string, unknown> = {};
      if (getOpts.offset != null) body.offset = getOpts.offset;
      if (getOpts.timeoutSec != null) body.timeout = getOpts.timeoutSec;
      if (getOpts.allowedUpdates) body.allowed_updates = getOpts.allowedUpdates;
      return await call<TelegramUpdate[]>("getUpdates", body);
    },

    async setWebhook(webhookUrl, secretToken, webhookOpts) {
      const body: Record<string, unknown> = { url: webhookUrl, secret_token: secretToken };
      if (webhookOpts?.allowedUpdates) body.allowed_updates = webhookOpts.allowedUpdates;
      if (webhookOpts?.dropPendingUpdates) body.drop_pending_updates = true;
      await call<true>("setWebhook", body);
    },

    async deleteWebhook() {
      await call<true>("deleteWebhook", {});
    },

    async getChat(chatId) {
      return await call<TelegramChat>("getChat", { chat_id: chatId });
    },
  };
}
