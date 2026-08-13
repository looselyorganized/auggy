import { describe, expect, test } from "bun:test";
import { agentMail } from "../../../src/augments/agentMail";

describe("agentMail replacement boundary", () => {
  test("mounts only the provider-native mailbox operations", async () => {
    const augment = agentMail({
      apiKey: "am_test",
      inboxId: "support@agentmail.to",
      inbound: { mode: "none" },
    });

    expect(augment.type).toBe("agentMail");
    expect(augment.tools?.map((tool) => tool.name)).toEqual([
      "send_message",
      "list_mail_messages",
      "search_mail_messages",
      "get_mail_message",
      "update_mail_message_labels",
      "trash_mail_message",
      "restore_mail_message",
      "delete_mail_message_permanently",
      "list_mail_threads",
      "search_mail_threads",
      "get_mail_thread",
      "update_mail_thread_labels",
      "trash_mail_thread",
      "restore_mail_thread",
      "delete_mail_thread_permanently",
      "read_mail_attachment",
      "list_mail_drafts",
      "create_mail_draft",
      "adopt_mail_draft",
      "show_mail_draft",
      "revise_mail_draft",
      "schedule_mail_draft",
      "unschedule_mail_draft",
      "delete_mail_draft",
      "send_mail_draft",
    ]);
    expect(augment.transport).toBeDefined();
    const admin = await augment.adminInfo?.();
    expect(admin?.sections[0]).toEqual({
      kind: "status",
      level: "warn",
      message: "Mail is starting; provider access has not been verified yet",
    });
    expect(admin?.projection).toMatchObject({
      kind: "mail",
      augmentName: "agentMail",
      inboxId: "support@agentmail.to",
      inbound: {
        mode: "none",
        state: "idle",
        senderPolicy: "disabled",
        allowedSenderCount: 0,
      },
      replies: { mode: "disabled", allowReplyAll: false },
      drafts: [],
    });
  });

  test("rejects deleted workflow fields instead of silently reviving legacy behavior", () => {
    expect(() =>
      agentMail({
        apiKey: "am_test",
        inboxId: "support@agentmail.to",
        inbound: { mode: "none" },
        creatorDigest: { enabled: true, destination: "creator" },
      } as never),
    ).toThrow('unsupported config field "creatorDigest"');
  });

  test("fails with actionable required-credential errors", () => {
    expect(() => agentMail({ apiKey: "", inboxId: "support@agentmail.to" })).toThrow(
      "set AGENTMAIL_API_KEY in .env",
    );
    expect(() => agentMail({ apiKey: "am_test", inboxId: "" })).toThrow(
      "set AGENTMAIL_INBOX_ID in .env",
    );
  });
});
