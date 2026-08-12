import { describe, expect, test } from "bun:test";
import { validateAgentMailConfig } from "../../../src/augments/agentMail/config";
import {
  evaluateAgentMailInbound,
  evaluateAgentMailOutbound,
  maySendAgentMailDraft,
} from "../../../src/augments/agentMail/policy";

function config(overrides: Record<string, unknown> = {}) {
  return validateAgentMailConfig({
    apiKey: "am_test",
    inboxId: "support@agentmail.to",
    inbound: {
      mode: "websocket",
      allowAnySender: true,
      rateLimit: { globalMaxPerHour: 100, perSenderMaxPerHour: 5 },
    },
    replies: { mode: "review", allowReplyAll: false },
    outbound: {
      subjectPrefix: "[Mike's Store] ",
      maxRecipients: 10,
      rateLimit: { globalMaxPerHour: 10, perRecipientCooldownMs: 300_000 },
    },
    ...overrides,
  });
}

describe("AgentMail configuration contract", () => {
  test("compiles the documented receive-any/review-replies policy with bounded defaults", () => {
    expect(config()).toMatchObject({
      inbound: {
        mode: "websocket",
        senderPolicy: "any",
        rateLimit: { globalMaxPerHour: 100, perSenderMaxPerHour: 5 },
      },
      replies: { mode: "review", allowReplyAll: false },
      outbound: {
        allowedTrustLevels: ["creator"],
        subjectPrefix: "[Mike's Store] ",
        maxRecipients: 10,
      },
    });
  });

  test("rejects every removed delivery, review, and duplicate-state field", () => {
    for (const invalid of [
      { inbound: { mode: "polling", allowAnySender: true } },
      { inbound: { mode: "webhook", allowAnySender: true } },
      { inbound: { mode: "websocket", allowAnySender: true, creatorDigest: {} } },
      { outbound: { humanReview: {} } },
      { outbound: { allowHtml: true } },
      { schemaVersion: 2 },
    ]) {
      expect(() =>
        validateAgentMailConfig({ apiKey: "am_test", inboxId: "mail@example.com", ...invalid }),
      ).toThrow(/agentMail/);
    }
  });

  test("requires an explicit sender policy and rejects conflicting or malformed patterns", () => {
    expect(() =>
      validateAgentMailConfig({
        apiKey: "am_test",
        inboxId: "mail@example.com",
        inbound: { mode: "websocket" },
      }),
    ).toThrow(/requires allowedSenders or explicit allowAnySender/);
    expect(() =>
      validateAgentMailConfig({
        apiKey: "am_test",
        inboxId: "mail@example.com",
        inbound: {
          mode: "websocket",
          allowAnySender: true,
          allowedSenders: ["*@example.com"],
        },
      }),
    ).toThrow(/cannot be combined/);
    expect(() =>
      validateAgentMailConfig({
        apiKey: "am_test",
        inboxId: "mail@example.com",
        inbound: { mode: "websocket", allowedSenders: ["example.com"] },
      }),
    ).toThrow(/email address or \*@domain/);
  });

  test("rejects unsupported reply automation instead of silently enabling sends", () => {
    expect(() =>
      validateAgentMailConfig({
        apiKey: "am_test",
        inboxId: "mail@example.com",
        inbound: { mode: "websocket", allowAnySender: true },
        replies: { mode: "automatic" },
      }),
    ).toThrow('replies.mode must be "disabled" or "review"');
    expect(() =>
      validateAgentMailConfig({
        apiKey: "am_test",
        inboxId: "mail@example.com",
        replies: { mode: "disabled", allowReplyAll: true },
      }),
    ).toThrow("replies.allowReplyAll requires replies.mode review");
  });
});

describe("AgentMail identity and authorization policy", () => {
  test("admits any well-formed sender as public untrusted identity, never creator", () => {
    const first = evaluateAgentMailInbound(
      { sender: "Person@One.Example", classification: "received" },
      config(),
    );
    const second = evaluateAgentMailInbound(
      { sender: "person@one.example", classification: "received" },
      config(),
    );
    expect(first).toMatchObject({
      admitted: true,
      sender: "person@one.example",
      peer: {
        kind: "human",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "agentMail",
      },
      replyDisposition: "review",
    });
    if (!first.admitted || !second.admitted) throw new Error("expected admitted sender");
    expect(first.peer.id).toBe(second.peer.id);
    expect(first.peer.id).not.toContain("person");
  });

  test("blocks spam-like classifications and non-allowlisted exact domains", () => {
    const allowlisted = config({
      inbound: {
        mode: "websocket",
        allowedSenders: ["owner@example.com", "*@customers.example"],
      },
    });
    expect(
      evaluateAgentMailInbound(
        { sender: "owner@example.com", classification: "spam" },
        allowlisted,
      ),
    ).toEqual({ admitted: false, reason: "classification_blocked" });
    expect(
      evaluateAgentMailInbound(
        { sender: "person@sub.customers.example", classification: "received" },
        allowlisted,
      ),
    ).toEqual({ admitted: false, reason: "sender_not_allowed" });
  });

  test("keeps direct outbound creator-only and applies recipient/body/header constraints", () => {
    const policy = config({
      outbound: {
        allowedTrustLevels: ["creator"],
        allowedRecipients: ["*@customers.example"],
        subjectPrefix: "[Mike's Store] ",
        maxRecipients: 2,
        bodyMaxBytes: 20,
      },
    });
    expect(
      evaluateAgentMailOutbound(
        {
          trustLevel: "creator",
          recipients: ["Buyer@Customers.Example"],
          subject: "Order 42",
          text: "Ready for pickup",
        },
        policy,
      ),
    ).toEqual({
      allowed: true,
      recipients: ["buyer@customers.example"],
      subject: "[Mike's Store] Order 42",
    });
    expect(
      evaluateAgentMailOutbound(
        {
          trustLevel: "public",
          recipients: ["buyer@customers.example"],
          subject: "Order 42",
          text: "Ready for pickup",
        },
        policy,
      ),
    ).toEqual({ allowed: false, reason: "trust_not_allowed" });
    expect(
      evaluateAgentMailOutbound(
        {
          trustLevel: "creator",
          recipients: ["buyer@customers.example"],
          subject: "bad\r\nBcc: victim@example.com",
          text: "Ready",
        },
        policy,
      ),
    ).toEqual({ allowed: false, reason: "subject_invalid" });
  });

  test("requires creator authorization to send a reviewed provider draft", () => {
    expect(maySendAgentMailDraft("creator")).toBe(true);
    expect(maySendAgentMailDraft("agent")).toBe(false);
    expect(maySendAgentMailDraft("public")).toBe(false);
  });
});
