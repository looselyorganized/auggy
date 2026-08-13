import type { ValidatedAgentMailConfig } from "../augments/agentMail/config";

/** AgentMail permission names used by the provider-native augment. */
export type AgentMailPermissionName =
  | "inbox_read"
  | "message_read"
  | "message_send"
  | "message_update"
  | "message_delete"
  | "draft_read"
  | "draft_create"
  | "draft_update"
  | "draft_delete"
  | "draft_send"
  | "label_trash_read";

export type AgentMailRequiredPermissions = Partial<Record<AgentMailPermissionName, true>> & {
  inbox_read: true;
};

export interface AgentMailCapabilityRequirements {
  inboundEnabled: boolean;
  reviewReplies: boolean;
  allowNewDraft: boolean;
  allowReplyDraft: boolean;
  allowReplyAllDraft: boolean;
  allowForwardDraft: boolean;
  allowLabelMutation: boolean;
  allowTrashRestore: boolean;
  allowAttachmentAccess: boolean;
  allowPermanentDelete: boolean;
  allowDirectDelivery: boolean;
}

export function agentMailCapabilityRequirements(
  config: ValidatedAgentMailConfig,
): AgentMailCapabilityRequirements {
  return {
    inboundEnabled: config.inbound.mode === "websocket",
    reviewReplies: config.replies.mode === "review",
    allowNewDraft: config.drafts.allowNew,
    allowReplyDraft: config.drafts.allowReply,
    allowReplyAllDraft: config.drafts.allowReplyAll,
    allowForwardDraft: config.drafts.allowForward,
    allowLabelMutation: config.mailbox.allowLabelMutation,
    allowTrashRestore: config.mailbox.allowTrashRestore,
    allowAttachmentAccess: config.mailbox.allowAttachmentAccess,
    allowPermanentDelete: config.destructive.allowPermanentDelete,
    allowDirectDelivery: config.outbound.allowDirectDelivery,
  };
}

export function buildAgentMailRequiredPermissions(
  requirements: AgentMailCapabilityRequirements,
): AgentMailRequiredPermissions {
  const draftCompositionEnabled =
    requirements.reviewReplies ||
    requirements.allowNewDraft ||
    requirements.allowReplyDraft ||
    requirements.allowReplyAllDraft ||
    requirements.allowForwardDraft;
  return {
    // The provider-native augment always exposes bounded creator-only mailbox
    // and draft inspection. Threads and attachments use message_read too.
    inbox_read: true,
    message_read: true,
    draft_read: true,
    ...(requirements.allowDirectDelivery ? { message_send: true as const } : {}),
    ...(requirements.allowLabelMutation || requirements.allowTrashRestore
      ? { message_update: true as const }
      : {}),
    ...(requirements.allowPermanentDelete ? { message_delete: true as const } : {}),
    ...(requirements.allowTrashRestore ? { label_trash_read: true as const } : {}),
    ...(draftCompositionEnabled
      ? {
          draft_create: true as const,
          draft_update: true as const,
          draft_send: true as const,
        }
      : {}),
    ...(requirements.allowPermanentDelete ? { draft_delete: true as const } : {}),
  };
}

export function describeAgentMailCapabilities(
  requirements: AgentMailCapabilityRequirements,
): string[] {
  const capabilities = ["read and search messages, threads, and drafts"];
  if (requirements.inboundEnabled) capabilities.push("receive and triage incoming mail");
  if (requirements.reviewReplies) capabilities.push("prepare creator-reviewed reply drafts");
  if (requirements.allowNewDraft) capabilities.push("create, revise, and send new drafts");
  if (requirements.allowReplyDraft) capabilities.push("create, revise, and send reply drafts");
  if (requirements.allowReplyAllDraft)
    capabilities.push("create, revise, and send reply-all drafts");
  if (requirements.allowForwardDraft) capabilities.push("create, revise, and send forward drafts");
  if (requirements.allowLabelMutation) capabilities.push("update allowed mailbox labels");
  if (requirements.allowTrashRestore) capabilities.push("trash and restore mail");
  if (requirements.allowAttachmentAccess) capabilities.push("inspect allowed attachments");
  if (requirements.allowPermanentDelete) capabilities.push("permanently delete mail and drafts");
  if (requirements.allowDirectDelivery) {
    capabilities.push(
      requirements.allowForwardDraft
        ? "send, reply, and forward directly"
        : "send and reply directly",
    );
  }
  if (
    requirements.allowDirectDelivery ||
    requirements.reviewReplies ||
    requirements.allowNewDraft ||
    requirements.allowReplyDraft ||
    requirements.allowReplyAllDraft ||
    requirements.allowForwardDraft
  ) {
    capabilities.push("retry definite delivery failures and reconcile ambiguous outcomes");
  }
  return capabilities;
}
