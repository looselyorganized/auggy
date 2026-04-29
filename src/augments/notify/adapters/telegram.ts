import { createTelegramBotClient } from "../../../telegram-client";
import type { TelegramBotClient } from "../../../telegram-client";
import type {
  NotifyAdapter,
  NotifyDestination,
  NotifyPayload,
  NotifyDeliveryResult,
  TelegramNotifyDestination,
} from "../../../types";

export interface CreateTelegramAdapterOptions {
  /** Override the client factory for testing. */
  clientFactory?: (botToken: string) => TelegramBotClient;
}

export function createTelegramAdapter(opts: CreateTelegramAdapterOptions = {}): NotifyAdapter {
  const factory =
    opts.clientFactory ?? ((botToken: string) => createTelegramBotClient({ botToken }));
  const cache = new Map<string, TelegramBotClient>();

  function getClient(botToken: string): TelegramBotClient {
    let client = cache.get(botToken);
    if (!client) {
      client = factory(botToken);
      cache.set(botToken, client);
    }
    return client;
  }

  function formatText(payload: NotifyPayload): string {
    const lines = [`*${payload.summary}*`];
    if (payload.reason) lines.push(`_Reason:_ ${payload.reason}`);
    if (payload.visitor) lines.push(`_Visitor:_ ${payload.visitor}`);
    return lines.join("\n");
  }

  return {
    async deliver(
      destination: NotifyDestination,
      payload: NotifyPayload,
    ): Promise<NotifyDeliveryResult> {
      if (destination.transport !== "telegram") {
        return {
          status: "failed",
          detail: `telegramAdapter received non-telegram destination: ${destination.transport}`,
        };
      }
      const dest = destination as TelegramNotifyDestination;
      try {
        const client = getClient(dest.botToken);
        await client.sendMessage(dest.chatId, formatText(payload), {
          parseMode: dest.parseMode ?? "Markdown",
        });
        return { status: "sent" };
      } catch (err) {
        return { status: "failed", detail: `telegram error: ${(err as Error).message}` };
      }
    },
  };
}
