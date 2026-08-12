import type { Augment } from "../../types";
import type { AgentMailAugmentOptions } from "../../types";
import { validateAgentMailConfig } from "./config";
import { createAgentMailRuntime } from "./runtime";

/** Mount the single supported provider-native AgentMail runtime. */
export function agentMail(opts: AgentMailAugmentOptions): Augment {
  return createAgentMailRuntime(validateAgentMailConfig(opts));
}

export { agentMailRequiresAdminRoute, validateAgentMailConfig } from "./config";
export type { ValidatedAgentMailConfig } from "./config";
export {
  evaluateAgentMailInbound,
  evaluateAgentMailOutbound,
  evaluateAgentMailPreparedDraft,
  maySendAgentMailDraft,
  type AgentMailAdmissionDecision,
  type AgentMailOutboundPolicyDecision,
} from "./policy";
export {
  AgentMailProviderError,
  createAgentMailProvider,
  type AgentMailDraft,
  type AgentMailDraftSummary,
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
  type AgentMailOutboundOperation,
  type AgentMailRateReservation,
  type AgentMailWorkItem,
  type AgentMailWorkState,
} from "./store";
export {
  createAgentMailInboundCoordinator,
  type AgentMailInboundCoordinator,
  type AgentMailInboundCoordinatorOptions,
  type AgentMailInboundStatus,
} from "./inbound";
export {
  createAgentMailRuntime,
  type AgentMailRuntimeDependencies,
} from "./runtime";
