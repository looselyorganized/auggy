import { createAgentMailClient } from "../../../agentmail-client";
import type { AgentMailClient } from "../../../agentmail-client";
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
  AgentMailNotifyDestination,
} from "../../../types";

export interface CreateAgentMailAdapterOptions {
  /** Test-only client override; production constructs from destination's apiKey. */
  clientFactory?: (
    apiKey: string,
    baseUrl?: string,
    allowInsecureHttpWithCredentials?: boolean,
  ) => AgentMailClient;
}

export function createAgentMailAdapter(opts: CreateAgentMailAdapterOptions = {}): NotifyAdapter {
  const factory =
    opts.clientFactory ??
    ((apiKey, baseUrl, allowInsecureHttpWithCredentials) =>
      createAgentMailClient({
        apiKey,
        apiBaseUrl: baseUrl,
        allowInsecureHttpWithCredentials,
      }));
  const cache = new Map<string, AgentMailClient>();

  function getClient(
    apiKey: string,
    baseUrl?: string,
    allowInsecureHttpWithCredentials?: boolean,
  ): AgentMailClient {
    const cacheKey = `${apiKey}:${baseUrl ?? ""}:${allowInsecureHttpWithCredentials === true}`;
    let client = cache.get(cacheKey);
    if (!client) {
      client = factory(apiKey, baseUrl, allowInsecureHttpWithCredentials);
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
      options?: { signal?: AbortSignal },
    ): Promise<NotifyDeliveryResult> {
      if (destination.transport !== "agentmail") {
        return {
          status: "failed",
          detail: `agentMailAdapter received non-agentmail destination: ${destination.transport}`,
        };
      }
      const dest = destination as AgentMailNotifyDestination;
      const client = getClient(dest.apiKey, dest.apiBaseUrl, dest.allowInsecureHttpWithCredentials);
      const subject = `${dest.subjectPrefix ?? ""}${payload.summary}`;
      try {
        const result = await client.send({
          inboxId: dest.inboxId,
          to: Array.isArray(dest.to) ? dest.to : [dest.to],
          subject,
          text: formatBody(payload),
          labels: dest.labels,
          signal: options?.signal,
        });
        if (result.status === "sent") {
          return { status: "sent" };
        }
        return {
          status: "failed",
          detail:
            result.httpStatus === undefined || isAmbiguousMutationStatus(result.httpStatus)
              ? "AgentMail delivery ended without a trustworthy response"
              : result.detail,
          ...(result.httpStatus === undefined || isAmbiguousMutationStatus(result.httpStatus)
            ? { outcomeUnknown: true }
            : {}),
        };
      } catch (err) {
        if (options?.signal?.aborted || isOutcomeUnknownError(err)) throw err;
        throw new OutcomeUnknownError(
          "AgentMail delivery ended without a trustworthy response after dispatch",
          { cause: err },
        );
      }
    },
  };
}
