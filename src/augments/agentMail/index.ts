import type { AdminInfoBlock, Augment, ContextBlock } from "../../types";
import type { AgentMailAugmentOptions } from "../../types";
import { validateAgentMailConfig } from "./config";

const PLACEHOLDER = /^\$\{[A-Z_][A-Z0-9_]*\}$/;

/**
 * Provider-native AgentMail replacement mount.
 *
 * Slice 1 intentionally exposes no mail tools or inbound listener. Subsequent
 * slices add those surfaces only after their provider and durability contracts
 * exist. Keeping this factory resolvable lets the rest of Auggy remain
 * operational while preventing fallback to the removed implementation.
 */
export function agentMail(opts: AgentMailAugmentOptions): Augment {
  const config = validateAgentMailConfig(opts);

  const unresolved = PLACEHOLDER.test(config.apiKey) || PLACEHOLDER.test(config.inboxId);
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

export { agentMailRequiresAdminRoute, validateAgentMailConfig } from "./config";
export type { ValidatedAgentMailConfig } from "./config";
export {
  evaluateAgentMailInbound,
  evaluateAgentMailOutbound,
  maySendAgentMailDraft,
  type AgentMailAdmissionDecision,
  type AgentMailOutboundPolicyDecision,
} from "./policy";
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
export {
  AGENTMAIL_ORCHESTRATION_APPLICATION_ID,
  AGENTMAIL_ORCHESTRATION_SCHEMA_VERSION,
  createAgentMailOrchestrationStore,
  hashAgentMailOrchestrationValue,
  type AgentMailDraftReference,
  type AgentMailOrchestrationStore,
  type AgentMailWorkItem,
  type AgentMailWorkState,
} from "./store";
export {
  createAgentMailInboundCoordinator,
  type AgentMailInboundCoordinator,
  type AgentMailInboundCoordinatorOptions,
  type AgentMailInboundStatus,
} from "./inbound";
