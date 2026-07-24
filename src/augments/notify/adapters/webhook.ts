import { createHttpClient } from "../../../http";
import type { HttpClient } from "../../../http";
import { assertSecureCredentialTransport } from "../../../engines/_shared/credential-transport";
import {
  isAmbiguousMutationStatus,
  isOutcomeUnknownError,
  OutcomeUnknownError,
} from "../../../outcome-unknown";
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
    opts.client ??
    createHttpClient({
      timeoutMs: 10_000,
      maxRedirects: 0,
      userAgent: "auggy-notify-webhook/0.1",
      urlPolicy: "operator-configured",
    });

  return {
    async deliver(
      destination: NotifyDestination,
      payload: NotifyPayload,
      options?: { signal?: AbortSignal },
    ): Promise<NotifyDeliveryResult> {
      if (destination.transport !== "webhook") {
        return {
          status: "failed",
          detail: `webhookAdapter received non-webhook destination: ${destination.transport}`,
        };
      }
      const dest = destination as WebhookNotifyDestination;
      try {
        assertSecureCredentialTransport({
          provider: "notify webhook",
          baseURL: dest.url,
          credential: "<webhook-payload>",
          allowInsecureHttpWithCredentials: dest.allowInsecureHttpWithCredentials,
        });
      } catch {
        return {
          status: "failed",
          detail: "webhook destination failed secure transport validation",
        };
      }
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
          signal: options?.signal,
        });
        if (res.status < 200 || res.status >= 300) {
          if (isAmbiguousMutationStatus(res.status)) {
            throw new OutcomeUnknownError(
              `Webhook returned HTTP ${res.status} after dispatch; delivery outcome is unknown`,
            );
          }
          return {
            status: "failed",
            detail: `webhook delivery returned HTTP ${res.status}`,
          };
        }
        return { status: "sent" };
      } catch (err) {
        if (options?.signal?.aborted || isOutcomeUnknownError(err)) throw err;
        return { status: "failed", detail: "webhook delivery failed" };
      }
    },
  };
}
