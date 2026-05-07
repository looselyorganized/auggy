import { createHttpClient } from "../../../http";
import type { HttpClient } from "../../../http";
import type {
  NotifyAdapter,
  NotifyDestination,
  NotifyPayload,
  NotifyDeliveryResult,
  AgentMailNotifyDestination,
} from "../../../types";

const DEFAULT_BASE_URL = "https://api.agentmail.to/v0";

export interface CreateAgentMailAdapterOptions {
  client?: Pick<HttpClient, "post">;
}

export function createAgentMailAdapter(opts: CreateAgentMailAdapterOptions = {}): NotifyAdapter {
  const http =
    opts.client ?? createHttpClient({ timeoutMs: 15_000, userAgent: "auggy-notify-agentmail/0.1" });

  function formatBody(payload: NotifyPayload): string {
    const lines = [payload.summary];
    if (payload.reason) lines.push("", `Reason: ${payload.reason}`);
    if (payload.visitor) lines.push(`Visitor: ${payload.visitor}`);
    return lines.join("\n");
  }

  return {
    async deliver(
      destination: NotifyDestination,
      payload: NotifyPayload,
    ): Promise<NotifyDeliveryResult> {
      if (destination.transport !== "agentmail") {
        return {
          status: "failed",
          detail: `agentMailAdapter received non-agentmail destination: ${destination.transport}`,
        };
      }
      const dest = destination as AgentMailNotifyDestination;
      const baseUrl = dest.apiBaseUrl ?? DEFAULT_BASE_URL;
      const url = `${baseUrl}/inboxes/${dest.inboxId}/messages`;
      const subject = `${dest.subjectPrefix ?? ""}${payload.summary}`;
      const body = JSON.stringify({
        to: Array.isArray(dest.to) ? dest.to : [dest.to],
        subject,
        text: formatBody(payload),
        ...(dest.labels && dest.labels.length > 0 ? { labels: dest.labels } : {}),
      });
      try {
        const res = await http.post(url, {
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${dest.apiKey}`,
          },
          body,
        });
        if (res.status < 200 || res.status >= 300) {
          return {
            status: "failed",
            detail: `agentmail ${url} returned ${res.status}: ${res.body.slice(0, 200)}`,
          };
        }
        return { status: "sent" };
      } catch (err) {
        return {
          status: "failed",
          detail: `agentmail ${url} error: ${(err as Error).message}`,
        };
      }
    },
  };
}
