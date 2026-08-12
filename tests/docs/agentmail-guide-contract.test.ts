import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateAgentMailConfig } from "../../src/augments/agentMail/config";

const guide = readFileSync(join(import.meta.dir, "../../docs/22-agent-mail.md"), "utf8");

describe("AgentMail operator guide", () => {
  test("documents the complete public YAML surface in grouped key tables", () => {
    const keys = [
      "apiKey",
      "inboxId",
      "emailAddress",
      "addressVisibility",
      "dbPath",
      "apiBaseUrl",
      "websocketBaseUrl",
      "allowInsecureHttpWithCredentials",
      "inbound.mode",
      "inbound.allowedSenders",
      "inbound.allowAnySender",
      "inbound.rateLimit.globalMaxPerHour",
      "inbound.rateLimit.perSenderMaxPerHour",
      "replies.mode",
      "replies.allowReplyAll",
      "outbound.allowedTrustLevels",
      "outbound.allowedRecipients",
      "outbound.subjectPrefix",
      "outbound.maxRecipients",
      "outbound.bodyMaxBytes",
      "outbound.rateLimit.globalMaxPerHour",
      "outbound.rateLimit.perRecipientCooldownMs",
      "outbound.rateLimit.dedupWindowMs",
      "notifications.destination",
      "notifications.maxAttempts",
    ];
    for (const key of keys) {
      expect(guide).toContain(`| \`${key}\` |`);
    }
  });

  test("keeps the primary copyable example executable by the runtime validator", () => {
    const match = guide.match(
      /### 3\. Use this complete configuration[\s\S]*?```yaml\n([\s\S]*?)\n```/,
    );
    expect(match?.[1]).toBeDefined();
    const document = parseYaml(match![1]!) as { type: string; config: Record<string, unknown> };
    expect(document.type).toBe("agentMail");
    expect(validateAgentMailConfig(document.config)).toMatchObject({
      addressVisibility: "creator",
      inbound: {
        mode: "websocket",
        senderPolicy: "any",
        rateLimit: { globalMaxPerHour: 100, perSenderMaxPerHour: 5 },
      },
      replies: { mode: "review", allowReplyAll: false },
      outbound: {
        allowedTrustLevels: ["creator"],
        subjectPrefix: "[Mikes Store] ",
        maxRecipients: 10,
        bodyMaxBytes: 102400,
      },
    });
  });

  test("documents exact-key connect semantics and provider-native review", () => {
    expect(guide).toContain("auggy augment setup agentMail --mode connect");
    expect(guide).toContain("auggy augment setup agentMail --mode env");
    expect(guide).toContain("exact API key Auggy should use");
    expect(guide).toContain("does not create an account, inbox, or another key");
    expect(guide).toContain("The draft body lives in AgentMail");
    expect(guide).toContain("Open in AgentMail");
    expect(guide).toContain("Send draft <draft-id>");
    expect(guide).toMatch(/delivery-failure alerts cover live observed events only/);
  });

  test("does not teach removed configuration or provisioning commands", () => {
    for (const removed of [
      "schemaVersion",
      "humanReview",
      "allowHtml",
      "creatorDigest",
      "expiresAfterMs",
      "--mode signup",
      "--mode existing",
      "--mode manual",
      "--replace-key",
    ]) {
      expect(guide).not.toContain(removed);
    }
  });

  test("states the identity and outbound-review boundaries explicitly", () => {
    expect(guide).toMatch(/every\s+admitted email starts as a public, anonymous peer/);
    expect(guide).toMatch(/it is not a review gate for\s+new outbound messages/);
    expect(guide).toContain("Reply drafts never send automatically");
    expect(guide).toContain("Magic-link verification returns through Auggy's public HTTP route");
  });
});
