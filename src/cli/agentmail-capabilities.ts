/** AgentMail permissions required by an active Auggy configuration. */
export type AgentMailRequiredPermissions = Record<string, boolean> & {
  inbox_read: true;
  message_send: true;
  message_read?: true;
  draft_read?: true;
  draft_create?: true;
  draft_update?: true;
  draft_send?: true;
  label_spam_read?: true;
  label_blocked_read?: true;
};

export interface AgentMailCapabilityRequirements {
  inboundEnabled: boolean;
  reviewReplies?: boolean;
  processSpam?: boolean;
  processBlocked?: boolean;
}

export function buildAgentMailRequiredPermissions(
  requirements: AgentMailCapabilityRequirements,
): AgentMailRequiredPermissions {
  if (!requirements.inboundEnabled && (requirements.processSpam || requirements.processBlocked)) {
    throw new Error("AgentMail label-read permissions require inbound delivery to be enabled.");
  }
  if (!requirements.inboundEnabled && requirements.reviewReplies) {
    throw new Error("AgentMail reply-draft permissions require inbound delivery to be enabled.");
  }
  return {
    inbox_read: true,
    message_send: true,
    ...(requirements.inboundEnabled ? { message_read: true as const } : {}),
    ...(requirements.reviewReplies
      ? {
          draft_read: true as const,
          draft_create: true as const,
          draft_update: true as const,
          draft_send: true as const,
        }
      : {}),
    ...(requirements.processSpam ? { label_spam_read: true as const } : {}),
    ...(requirements.processBlocked ? { label_blocked_read: true as const } : {}),
  };
}

export const AGENTMAIL_REQUIRED_PERMISSIONS = buildAgentMailRequiredPermissions({
  inboundEnabled: false,
});
