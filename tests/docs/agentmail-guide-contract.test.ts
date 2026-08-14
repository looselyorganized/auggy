import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateAgentMailConfig } from "../../src/augments/agentMail/config";

const guide = readFileSync(join(import.meta.dir, "../../docs/22-agent-mail.md"), "utf8");

describe("AgentMail operator guide", () => {
  test("documents every accepted public YAML leaf in grouped key tables", () => {
    const keys = [
      "apiKey",
      "inboxId",
      "emailAddress",
      "addressVisibility",
      "apiBaseUrl",
      "websocketBaseUrl",
      "allowInsecureHttpWithCredentials",
      "dbPath",
      "inbound.mode",
      "inbound.allowedSenders",
      "inbound.allowAnySender",
      "inbound.rateLimit.globalMaxPerHour",
      "inbound.rateLimit.perSenderMaxPerHour",
      "replies.mode",
      "replies.allowReplyAll",
      "mailbox.maxListResults",
      "mailbox.maxSearchQueryBytes",
      "mailbox.allowLabelMutation",
      "mailbox.allowedLabels",
      "mailbox.allowTrashRestore",
      "mailbox.allowAttachmentAccess",
      "mailbox.maxAttachmentBytes",
      "mailbox.allowedAttachmentTypes",
      "drafts.allowNew",
      "drafts.allowReply",
      "drafts.allowReplyAll",
      "drafts.allowForward",
      "destructive.allowPermanentDelete",
      "outbound.allowedTrustLevels",
      "outbound.allowedRecipients",
      "outbound.maxRecipients",
      "outbound.bodyMaxBytes",
      "outbound.subjectPrefix",
      "outbound.allowDirectDelivery",
      "outbound.allowHtml",
      "outbound.maxAttachments",
      "outbound.maxAttachmentBytes",
      "outbound.maxTotalAttachmentBytes",
      "outbound.allowedAttachmentTypes",
      "outbound.rateLimit.globalMaxPerHour",
      "outbound.rateLimit.perRecipientCooldownMs",
      "outbound.rateLimit.dedupWindowMs",
      "notifications.destination",
      "notifications.maxAttempts",
    ];
    for (const key of keys) expect(guide).toContain(`| \`${key}\` |`);
  });

  test("keeps the generated base configuration executable and direct-delivery ready", () => {
    const match = guide.match(/## Base configuration[\s\S]*?```yaml\n([\s\S]*?)\n```/);
    expect(match?.[1]).toBeDefined();
    const document = parseYaml(match![1]!) as { type: string; config: Record<string, unknown> };
    expect(document.type).toBe("agentMail");
    expect(validateAgentMailConfig(document.config)).toMatchObject({
      addressVisibility: "creator",
      inbound: { mode: "none", senderPolicy: "disabled" },
      replies: { mode: "disabled", allowReplyAll: false },
      drafts: {
        allowNew: false,
        allowReply: false,
        allowReplyAll: false,
        allowForward: true,
      },
      outbound: {
        allowedTrustLevels: ["creator"],
        allowDirectDelivery: true,
        subjectPrefix: "[Auggy] ",
        maxRecipients: 10,
        bodyMaxBytes: 102400,
        rateLimit: {
          globalMaxPerHour: 10,
          perRecipientCooldownMs: 300000,
          dedupWindowMs: 300000,
        },
      },
    });
  });

  test("provides copyable task flows for inbound review, direct delivery, and magic links", () => {
    expect(guide).toContain("inbound:\n    mode: websocket");
    expect(guide).toContain("allowAnySender: true");
    expect(guide).toContain("replies:\n    mode: review");
    expect(guide).toContain("Send draft <draft-id>.");
    expect(guide).toContain("Reply to message <message-id>.");
    expect(guide).toContain("Forward message <message-id> to owner@example.com.");
    expect(guide).toContain('subjectPrefix: "[Mikes Store] "');
    expect(guide).toContain("agentMail:\n    transport: agentmail");
  });

  test("documents exact-key, provider-native, and recovery boundaries", () => {
    expect(guide).toContain("auggy augment setup agentMail");
    expect(guide).toContain("auggy augment setup agentMail --mode env");
    expect(guide).toContain("Create an AgentMail account");
    expect(guide).toContain("Create a new inbox in an existing account");
    expect(guide).toContain("Manually connect an existing AgentMail inbox");
    expect(guide).toContain("Saves that exact same key");
    expect(guide).toContain("never exchanges your selected key");
    expect(guide).toContain("same draft");
    expect(guide).toContain("Open in AgentMail");
    expect(guide).toContain("No magic wording is required");
    expect(guide).toContain("reconcile delivery <operation-id> as sent");
    expect(guide).toContain("does not create, change, cancel, or send scheduled drafts");
    expect(guide).toContain("delivery failures missed while Auggy is offline");
  });

  test("does not teach removed configuration or key replacement commands", () => {
    for (const removed of [
      "schemaVersion",
      "humanReview",
      "creatorDigest",
      "expiresAfterMs",
      "allowScheduling",
      "maxScheduleDelayMs",
      "--replace-key",
    ]) {
      expect(guide).not.toContain(removed);
    }
  });

  test("states identity and creator authority without implying email authentication", () => {
    expect(guide).toContain("Incoming email is always untrusted");
    expect(guide).toContain("public and anonymous");
    expect(guide).toContain("cannot authorize a send");
    expect(guide).toContain("no automatic reply sending");
    expect(guide).toMatch(/Magic-link\s+verification does not require inbound email/);
  });
});
