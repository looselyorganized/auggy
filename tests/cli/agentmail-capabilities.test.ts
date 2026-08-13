import { describe, expect, test } from "bun:test";
import {
  agentMailCapabilityRequirements,
  buildAgentMailRequiredPermissions,
  describeAgentMailCapabilities,
  type AgentMailCapabilityRequirements,
} from "../../src/cli/agentmail-capabilities";
import { validateAgentMailConfig } from "../../src/augments/agentMail/config";

const disabled: AgentMailCapabilityRequirements = {
  inboundEnabled: false,
  reviewReplies: false,
  allowNewDraft: false,
  allowReplyDraft: false,
  allowReplyAllDraft: false,
  allowForwardDraft: false,
  allowLabelMutation: false,
  allowTrashRestore: false,
  allowAttachmentAccess: false,
  allowPermanentDelete: false,
  allowDirectDelivery: false,
};

describe("AgentMail CLI capability guidance", () => {
  test("requires read access for the always-on bounded mailbox and draft tools", () => {
    expect(buildAgentMailRequiredPermissions(disabled)).toEqual({
      inbox_read: true,
      message_read: true,
      draft_read: true,
    });
  });

  test("maps every configurable mutation surface to its provider permission", () => {
    const permissions = buildAgentMailRequiredPermissions({
      ...disabled,
      inboundEnabled: true,
      reviewReplies: true,
      allowNewDraft: true,
      allowReplyDraft: true,
      allowReplyAllDraft: true,
      allowForwardDraft: true,
      allowLabelMutation: true,
      allowTrashRestore: true,
      allowAttachmentAccess: true,
      allowPermanentDelete: true,
      allowDirectDelivery: true,
    });
    expect(permissions).toEqual({
      inbox_read: true,
      message_read: true,
      draft_read: true,
      message_send: true,
      message_update: true,
      message_delete: true,
      label_trash_read: true,
      draft_create: true,
      draft_update: true,
      draft_send: true,
      draft_delete: true,
    });
    expect(Object.keys(permissions).some((name) => name.startsWith("thread_"))).toBe(false);
  });

  test("derives truthful operator capabilities from the validated runtime contract", () => {
    const config = validateAgentMailConfig({
      apiKey: "am_test",
      inboxId: "support@agentmail.to",
      inbound: {
        mode: "websocket",
        allowAnySender: true,
        rateLimit: { globalMaxPerHour: 100, perSenderMaxPerHour: 5 },
      },
      replies: { mode: "review", allowReplyAll: true },
      drafts: { allowNew: true, allowReply: true, allowReplyAll: true, allowForward: true },
      mailbox: {
        allowLabelMutation: true,
        allowedLabels: ["reviewed"],
        allowTrashRestore: true,
      },
      outbound: { allowDirectDelivery: true },
    });
    const descriptions = describeAgentMailCapabilities(agentMailCapabilityRequirements(config));
    expect(descriptions).toEqual(
      expect.arrayContaining([
        "receive and triage incoming mail",
        "prepare creator-reviewed reply drafts",
        "create, revise, and send forward drafts",
        "send, reply, and forward directly",
        "retry definite delivery failures and reconcile ambiguous outcomes",
      ]),
    );
    expect(descriptions.join(" ")).not.toContain("schedul");
  });
});
