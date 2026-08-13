import { describe, expect, test } from "bun:test";
import {
  AgentMailClient,
  type AgentMail,
  type BaseClientOptions,
  type BaseRequestOptions,
} from "agentmail";

type Assert<T extends true> = T;
type IsAssignable<Actual, Expected> = Actual extends Expected ? true : false;

const clientOptions = {
  apiKey: "am_contract_only",
  maxRetries: 0,
  timeoutInSeconds: 30,
} satisfies BaseClientOptions;

const requestOptions = {
  maxRetries: 0,
  abortSignal: new AbortController().signal,
} satisfies BaseRequestOptions;

const newDraft = {
  to: ["recipient@example.com"],
  subject: "New message",
  text: "Body",
  labels: ["review"],
  attachments: [{ content: "Y29udGVudA==", filename: "note.txt", contentType: "text/plain" }],
  sendAt: new Date("2026-08-13T20:00:00.000Z"),
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
  sendAt: null,
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

type _DraftHasForwardSource = Assert<
  IsAssignable<NonNullable<AgentMail.CreateDraftRequest["forwardOf"]>, string>
>;
type _DraftCanUnschedule = Assert<IsAssignable<null, AgentMail.UpdateDraftRequest["sendAt"]>>;
type _DraftCanRemoveAttachments = Assert<
  IsAssignable<string[], AgentMail.UpdateDraftRequest["removeAttachments"]>
>;

describe("AgentMail generated SDK contract", () => {
  test("pins the methods and material fields used by the provider adapter", () => {
    const client = new AgentMailClient(clientOptions);
    expect(requestOptions.maxRetries).toBe(0);
    expect(newDraft.clientId).toBe("auggy.contract.new");
    expect(replyAllDraft.replyAll).toBe(true);
    expect(forwardDraft.forwardOf).toBe("message_1");
    expect(draftUpdate.sendAt).toBeNull();
    expect(messageUpdate.addLabels).toEqual(["read"]);
    expect(directSend.attachments).toHaveLength(1);
    expect(reply.to).toEqual(["recipient@example.com"]);
    expect(replyAll.text).toBe("Reply all");

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
