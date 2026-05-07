import { createAgentMailClient } from "../../../agentmail-client";
import type { AgentMailClient } from "../../../agentmail-client";
import type {
  NotifyAdapter,
  NotifyDestination,
  NotifyPayload,
  NotifyDeliveryResult,
  AgentMailNotifyDestination,
} from "../../../types";

export interface CreateAgentMailAdapterOptions {
  /** Test-only client override; production constructs from destination's apiKey. */
  clientFactory?: (apiKey: string, baseUrl?: string) => AgentMailClient;
}

export function createAgentMailAdapter(opts: CreateAgentMailAdapterOptions = {}): NotifyAdapter {
  const factory =
    opts.clientFactory ?? ((apiKey, baseUrl) => createAgentMailClient({ apiKey, apiBaseUrl: baseUrl }));
  const cache = new Map<string, AgentMailClient>();

  function getClient(apiKey: string, baseUrl?: string): AgentMailClient {
    const cacheKey = `${apiKey}:${baseUrl ?? ""}`;
    let client = cache.get(cacheKey);
    if (!client) {
      client = factory(apiKey, baseUrl);
      cache.set(cacheKey, client);
    }
    return client;
  }

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
      const client = getClient(dest.apiKey, dest.apiBaseUrl);
      const subject = `${dest.subjectPrefix ?? ""}${payload.summary}`;
      try {
        const result = await client.send({
          inboxId: dest.inboxId,
          to: Array.isArray(dest.to) ? dest.to : [dest.to],
          subject,
          text: formatBody(payload),
          labels: dest.labels,
        });
        if (result.status === "sent") {
          return { status: "sent" };
        }
        return { status: "failed", detail: result.detail };
      } catch (err) {
        return { status: "failed", detail: `agentmail error: ${(err as Error).message}` };
      }
    },
  };
}
