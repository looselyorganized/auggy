import { createHttpClient } from "../../../http";
import type { HttpClient } from "../../../http";
import type {
  NotifyAdapter,
  NotifyDestination,
  NotifyPayload,
  NotifyDeliveryResult,
  WebhookNotifyDestination,
} from "../../../types";

export interface CreateWebhookAdapterOptions {
  client?: Pick<HttpClient, "post">;
}

export function createWebhookAdapter(opts: CreateWebhookAdapterOptions = {}): NotifyAdapter {
  const http =
    opts.client ?? createHttpClient({ timeoutMs: 10_000, userAgent: "auggy-notify-webhook/0.1" });

  return {
    async deliver(
      destination: NotifyDestination,
      payload: NotifyPayload,
    ): Promise<NotifyDeliveryResult> {
      if (destination.transport !== "webhook") {
        return {
          status: "failed",
          detail: `webhookAdapter received non-webhook destination: ${destination.transport}`,
        };
      }
      const dest = destination as WebhookNotifyDestination;
      const body = JSON.stringify({
        summary: payload.summary,
        ...(payload.reason ? { reason: payload.reason } : {}),
        ...(payload.visitor ? { visitor: payload.visitor } : {}),
        channel: "notify",
      });

      try {
        const res = await http.post(dest.url, {
          headers: { "content-type": "application/json", ...(dest.headers ?? {}) },
          body,
        });
        if (res.status < 200 || res.status >= 300) {
          return {
            status: "failed",
            detail: `webhook ${dest.url} returned ${res.status}: ${res.body.slice(0, 200)}`,
          };
        }
        return { status: "sent" };
      } catch (err) {
        return { status: "failed", detail: `webhook ${dest.url} error: ${(err as Error).message}` };
      }
    },
  };
}
