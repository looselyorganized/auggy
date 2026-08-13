import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

describe("AgentMail protected live mutation E2E", () => {
  const workflow = readFileSync(
    join(import.meta.dir, "../../.github/workflows/agentmail-live-e2e.yml"),
    "utf8",
  );
  const script = readFileSync(join(import.meta.dir, "../../scripts/agentmail-live-e2e.ts"), "utf8");

  test("is manual, main-only, protected, and uses the established Environment contract", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/\b(push|pull_request|schedule):/);
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("environment: agentmail-provider-canary");
    expect(workflow).toContain("secrets.AGENTMAIL_CANARY_ACCOUNT_API_KEY_ENV_ONLY");
    expect(workflow).toContain("vars.AGENTMAIL_CANARY_INBOX_ID");
    expect(workflow).toContain("vars.AGENTMAIL_CANARY_INBOX_EMAIL");
    expect(workflow).toContain(
      "AGENTMAIL_LIVE_MUTATION_CONFIRM: create-temporary-inbox-and-send-live-email",
    );
  });

  test("exercises Auggy's live runtime and cleans up its temporary fixture", () => {
    expect(script).toContain("senderProvider.sendMessage");
    expect(script).toContain('mode: "websocket"');
    expect(script).toContain('"list_mail_drafts"');
    expect(script).toContain('"revise_mail_draft"');
    expect(script).toContain('"send_mail_draft"');
    expect(script).toContain("senderProvider.listMessages");
    expect(script).toContain("sdk.inboxes.delete(senderInboxId)");
    expect(script).toContain("finally {");
    expect(script).not.toContain("apiKeys.create");
    expect(script).not.toContain("apiKeys.delete");
  });
});
