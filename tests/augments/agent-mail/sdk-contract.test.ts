import { describe, expect, test } from "bun:test";
import { AgentMailClient, type AgentMail, type BaseClientOptions } from "agentmail";
import type { AgentMailAugmentOptions } from "../../../src/types";

type Assert<T extends true> = T;
type IsAssignable<Actual, Expected> = Actual extends Expected ? true : false;
type MessageSendRequestOptions = NonNullable<
  Parameters<InstanceType<typeof AgentMailClient>["inboxes"]["messages"]["send"]>[2]
>;

const clientOptions = {
  apiKey: "am_contract_only",
  maxRetries: 0,
  timeoutInSeconds: 30,
} satisfies BaseClientOptions;

const requestOptions = {
  maxRetries: 0,
  abortSignal: new AbortController().signal,
  idempotencyKey: "auggy.contract.send",
} satisfies MessageSendRequestOptions;

const newDraft = {
  to: ["recipient@example.com"],
  subject: "New message",
  text: "Body",
  labels: ["review"],
  attachments: [{ content: "Y29udGVudA==", filename: "note.txt", contentType: "text/plain" }],
  clientId: "auggy.contract.new",
} satisfies AgentMail.CreateDraftRequest;

const replyAllDraft = {
  inReplyTo: "message_1",
  replyAll: true,
  text: "Reply body",
  clientId: "auggy.contract.reply-all",
} satisfies AgentMail.CreateDraftRequest;

const forwardDraft = {
  forwardOf: "message_1",
  to: ["recipient@example.com"],
  text: "Forward note",
  clientId: "auggy.contract.forward",
} satisfies AgentMail.CreateDraftRequest;

const draftUpdate = {
  to: [],
  cc: null,
  text: "Revised",
  html: null,
  addAttachments: [{ content: "Y29udGVudA==", filename: "note.txt" }],
  removeAttachments: ["attachment_1"],
  addLabels: ["review"],
  removeLabels: ["stale"],
} satisfies AgentMail.UpdateDraftRequest;

const messageUpdate = {
  addLabels: ["read"],
  removeLabels: ["unread"],
} satisfies AgentMail.UpdateMessageRequest;

const directSend = {
  to: ["recipient@example.com"],
  subject: "Hello",
  text: "Body",
  attachments: [{ content: "Y29udGVudA==", filename: "note.txt" }],
} satisfies AgentMail.SendMessageRequest;

const reply = {
  text: "Reply",
  to: ["recipient@example.com"],
  cc: ["copy@example.com"],
} satisfies AgentMail.ReplyToMessageRequest;

const replyAll = { text: "Reply all" } satisfies AgentMail.ReplyAllMessageRequest;

const publicAugmentOptions = {
  apiKey: "am_contract_only",
  inboxId: "contract@agentmail.to",
  inbound: { mode: "websocket", allowAnySender: true },
  replies: { mode: "review", allowReplyAll: false },
  mailbox: {
    allowLabelMutation: true,
    allowedLabels: ["reviewed"],
    allowTrashRestore: true,
    allowAttachmentAccess: true,
    maxAttachmentBytes: 1_048_576,
    allowedAttachmentTypes: ["text/plain"],
  },
  drafts: { allowNew: true, allowReply: true, allowReplyAll: true, allowForward: true },
  destructive: { allowPermanentDelete: true },
  outbound: {
    allowDirectDelivery: true,
    allowHtml: true,
    maxAttachments: 1,
    maxAttachmentBytes: 1_048_576,
    maxTotalAttachmentBytes: 2_097_152,
    allowedAttachmentTypes: ["text/plain"],
  },
} satisfies AgentMailAugmentOptions;

type _DraftHasForwardSource = Assert<
  IsAssignable<NonNullable<AgentMail.CreateDraftRequest["forwardOf"]>, string>
>;
type _DraftCanRemoveAttachments = Assert<
  IsAssignable<string[], AgentMail.UpdateDraftRequest["removeAttachments"]>
>;

describe("AgentMail generated SDK contract", () => {
  test("pins the methods and material fields used by the provider adapter", () => {
    const client = new AgentMailClient(clientOptions);
    expect(requestOptions.maxRetries).toBe(0);
    expect(requestOptions.idempotencyKey).toBe("auggy.contract.send");
    expect(newDraft.clientId).toBe("auggy.contract.new");
    expect(replyAllDraft.replyAll).toBe(true);
    expect(forwardDraft.forwardOf).toBe("message_1");
    expect(draftUpdate.removeAttachments).toEqual(["attachment_1"]);
    expect(messageUpdate.addLabels).toEqual(["read"]);
    expect(directSend.attachments).toHaveLength(1);
    expect(reply.to).toEqual(["recipient@example.com"]);
    expect(replyAll.text).toBe("Reply all");
    expect(publicAugmentOptions.mailbox.allowLabelMutation).toBe(true);
    expect(publicAugmentOptions.outbound.allowDirectDelivery).toBe(true);

    expect(typeof client.auth.me).toBe("function");
    expect(typeof client.inboxes.get).toBe("function");
    expect(typeof client.inboxes.messages.list).toBe("function");
    expect(typeof client.inboxes.messages.search).toBe("function");
    expect(typeof client.inboxes.messages.get).toBe("function");
    expect(typeof client.inboxes.messages.getAttachment).toBe("function");
    expect(typeof client.inboxes.messages.update).toBe("function");
    expect(typeof client.inboxes.messages.delete).toBe("function");
    expect(typeof client.inboxes.messages.send).toBe("function");
    expect(typeof client.inboxes.messages.reply).toBe("function");
    expect(typeof client.inboxes.messages.replyAll).toBe("function");
    expect(typeof client.inboxes.messages.forward).toBe("function");
    expect(typeof client.inboxes.threads.list).toBe("function");
    expect(typeof client.inboxes.threads.search).toBe("function");
    expect(typeof client.inboxes.threads.get).toBe("function");
    expect(typeof client.inboxes.threads.getAttachment).toBe("function");
    expect(typeof client.inboxes.threads.update).toBe("function");
    expect(typeof client.inboxes.threads.delete).toBe("function");
    expect(typeof client.inboxes.drafts.list).toBe("function");
    expect(typeof client.inboxes.drafts.get).toBe("function");
    expect(typeof client.inboxes.drafts.getAttachment).toBe("function");
    expect(typeof client.inboxes.drafts.create).toBe("function");
    expect(typeof client.inboxes.drafts.update).toBe("function");
    expect(typeof client.inboxes.drafts.delete).toBe("function");
    expect(typeof client.inboxes.drafts.send).toBe("function");
    expect(typeof client.websockets.connect).toBe("function");
  });
});
