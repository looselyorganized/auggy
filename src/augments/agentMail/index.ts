import type { AdminInfoBlock, Augment, ContextBlock } from "../../types";
import type { AgentMailAugmentOptions } from "../../types";
import { validateAgentMailInboundConfig } from "./config";

const PLACEHOLDER = /^\$\{[A-Z_][A-Z0-9_]*\}$/;

function requireCredential(value: unknown, field: "apiKey" | "inboxId"): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    const env = field === "apiKey" ? "AGENTMAIL_API_KEY" : "AGENTMAIL_INBOX_ID";
    throw new Error(`agentMail: ${field} is required (set ${env} in .env)`);
  }
}

/**
 * Provider-native AgentMail replacement mount.
 *
 * Slice 1 intentionally exposes no mail tools or inbound listener. Subsequent
 * slices add those surfaces only after their provider and durability contracts
 * exist. Keeping this factory resolvable lets the rest of Auggy remain
 * operational while preventing fallback to the removed implementation.
 */
export function agentMail(opts: AgentMailAugmentOptions): Augment {
  requireCredential(opts.apiKey, "apiKey");
  requireCredential(opts.inboxId, "inboxId");
  if (opts.inbound !== undefined) validateAgentMailInboundConfig(opts.inbound, opts.outbound);

  const unresolved = PLACEHOLDER.test(opts.apiKey) || PLACEHOLDER.test(opts.inboxId);
  const context: ContextBlock = {
    source: "agentMail",
    content:
      "AgentMail is mounted but its provider-native replacement has no active mailbox operations in this build.",
    placement: "system",
    provenance: "augment",
    priority: "normal",
    eviction: "drop",
    origin: "system",
  };

  const adminInfo = async (): Promise<AdminInfoBlock> => ({
    augmentName: "agentMail",
    title: "AgentMail",
    sections: [
      {
        kind: "status",
        level: "warn",
        message: unresolved ? "Configuration required" : "Replacement runtime not active",
      },
    ],
  });

  return {
    name: "agentMail",
    type: "agentMail",
    context: async () => [context],
    adminInfo,
  };
}

export { validateAgentMailInboundConfig, agentMailInboundRequiresAdminRoute } from "./config";
export type { ValidatedAgentMailInboundConfig } from "./config";
export {
  AgentMailProviderError,
  createAgentMailProvider,
  type AgentMailDraft,
  type AgentMailMessage,
  type AgentMailMessageSummary,
  type AgentMailProvider,
  type AgentMailProviderEvent,
  type AgentMailProviderIdentity,
  type AgentMailProviderOptions,
  type AgentMailProviderSubscription,
  type AgentMailThread,
} from "./provider";
