import { describe, expect, test } from "bun:test";
import {
  assertAgentMailDraftIdentity,
  snapshotAgentMailDraft,
} from "../../../src/augments/agentMail/draft-snapshot";
import type { AgentMailDraft } from "../../../src/augments/agentMail/provider";

function draft(overrides: Partial<AgentMailDraft> = {}): AgentMailDraft {
  return {
    inboxId: "support@agentmail.to",
    draftId: "draft_1",
    clientId: "operation_1",
    labels: ["review"],
    replyTo: ["support@example.com"],
    to: ["customer@example.com"],
    cc: [],
    bcc: [],
    subject: "Re: Order",
    text: "We can help.",
    attachments: [
      {
        attachmentId: "attachment_1",
        filename: "invoice.pdf",
        size: 128,
        contentType: "application/pdf",
        contentDisposition: "attachment",
      },
    ],
    inReplyTo: "message_1",
    references: ["message_0"],
    updatedAt: 2_000,
    createdAt: 1_000,
    ...overrides,
  };
}

describe("AgentMail draft snapshots", () => {
  test("hashes every provider-significant value but excludes provider timestamps and previews", () => {
    const baseline = snapshotAgentMailDraft(draft(), "reply");
    const nonMaterial = snapshotAgentMailDraft(
      draft({ createdAt: 9_000, preview: "provider-generated preview" }),
      "reply",
    );
    expect(nonMaterial.materialHash).toBe(baseline.materialHash);
    expect(nonMaterial.providerRevision).toBe(baseline.providerRevision);

    const laterRevision = snapshotAgentMailDraft(draft({ updatedAt: 2_001 }), "reply");
    expect(laterRevision.materialHash).toBe(baseline.materialHash);
    expect(laterRevision.providerRevision).not.toBe(baseline.providerRevision);

    for (const changed of [
      draft({ to: ["other@example.com"] }),
      draft({ cc: ["copy@example.com"] }),
      draft({ subject: "Changed" }),
      draft({ text: "Changed" }),
      draft({ html: "<p>Changed</p>" }),
      draft({ labels: ["changed"] }),
      draft({ replyTo: ["changed@example.com"] }),
      draft({ sendAt: 50_000 }),
      draft({ attachments: [] }),
    ]) {
      expect(snapshotAgentMailDraft(changed, "reply").materialHash).not.toBe(baseline.materialHash);
    }
  });

  test("requires explicit reply-all disambiguation and preserves forward identity", () => {
    const replyAll = snapshotAgentMailDraft(draft(), "reply_all");
    expect(replyAll).toMatchObject({ kind: "reply_all", sourceMessageId: "message_1" });

    const forward = draft({ inReplyTo: undefined, forwardOf: "message_1" });
    expect(snapshotAgentMailDraft(forward, "forward")).toMatchObject({
      kind: "forward",
      sourceMessageId: "message_1",
    });
    expect(() => snapshotAgentMailDraft(forward, "reply")).toThrow(
      "reply draft no longer preserves",
    );
  });

  test("fails closed when the provider changes inbox, draft, kind, or source", () => {
    const identity = {
      inboxId: "support@agentmail.to",
      draftId: "draft_1",
      kind: "reply" as const,
      sourceMessageId: "message_1",
    };
    expect(assertAgentMailDraftIdentity(draft(), identity)).toMatchObject({ kind: "reply" });
    expect(() => assertAgentMailDraftIdentity(draft({ draftId: "draft_2" }), identity)).toThrow(
      "outside the managed inbox",
    );
    expect(() => assertAgentMailDraftIdentity(draft({ inReplyTo: "message_2" }), identity)).toThrow(
      "source identity changed",
    );
  });
});
