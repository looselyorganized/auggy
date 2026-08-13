import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAgentMailPolicy,
  checkUnsupportedAgentMailState,
} from "../../../src/cli/commands/doctor";
import type { ParsedConfig } from "../../../src/cli/types";

function config(type: "agentMail" | "notify"): ParsedConfig {
  return {
    id: "aug1_11111111-1111-4111-8111-111111111111",
    name: "mail-test",
    engine: { provider: "openai", model: "test" },
    augments: [
      {
        name: type,
        type,
        options:
          type === "agentMail"
            ? {
                apiKey: "${AGENTMAIL_API_KEY}",
                inboxId: "${AGENTMAIL_INBOX_ID}",
              }
            : {},
      },
    ],
    settings: {},
  };
}

describe("doctor AgentMail replacement state boundary", () => {
  test("fails with archive guidance without touching old state", () => {
    const root = mkdtempSync(join(tmpdir(), "auggy-old-agentmail-"));
    const path = join(root, "agent-mail.db");
    writeFileSync(path, "legacy");

    expect(checkUnsupportedAgentMailState(root, config("agentMail"))).toEqual([
      expect.objectContaining({
        status: "fail",
        message: expect.stringContaining("agent-mail.db"),
        fix: expect.stringContaining("will not read, migrate, or delete"),
      }),
    ]);
    expect(Bun.file(path).size).toBe(6);
  });

  test("does not report AgentMail state to unrelated consumers", () => {
    const root = mkdtempSync(join(tmpdir(), "auggy-old-agentmail-"));
    writeFileSync(join(root, "agent-mail.db"), "legacy");
    expect(checkUnsupportedAgentMailState(root, config("notify"))).toEqual([]);
  });

  test("accepts the replacement runtime's owned data directory", () => {
    const root = mkdtempSync(join(tmpdir(), "auggy-current-agentmail-"));
    mkdirSync(join(root, "data", "agent-mail", "agentMail"), { recursive: true });
    writeFileSync(join(root, "data", "agent-mail", "agentMail", "orchestration.db"), "current");
    expect(checkUnsupportedAgentMailState(root, config("agentMail"))).toEqual([]);
  });

  test("reports old per-instance state without flagging the replacement database", () => {
    const root = mkdtempSync(join(tmpdir(), "auggy-old-agentmail-instance-"));
    const stateDir = join(root, "data", "agent-mail", "agentMail");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "orchestration.db"), "current");
    writeFileSync(join(stateDir, "agent-mail-state.json"), "legacy");

    const checks = checkUnsupportedAgentMailState(root, config("agentMail"));
    expect(checks).toEqual([
      expect.objectContaining({
        status: "fail",
        message: expect.stringContaining(
          join("data", "agent-mail", "agentMail", "agent-mail-state.json"),
        ),
      }),
    ]);
    expect(checks[0]!.message).not.toContain("orchestration.db");
  });

  test("reports old state in the deployment runtime volume", () => {
    const root = mkdtempSync(join(tmpdir(), "auggy-old-agentmail-cloud-"));
    const runtimeRoot = join(root, "runtime");
    const oldState = join(runtimeRoot, "agent-mail", "agentMail", "agent-mail.db");
    mkdirSync(join(runtimeRoot, "agent-mail", "agentMail"), { recursive: true });
    writeFileSync(oldState, "legacy");

    const checks = checkUnsupportedAgentMailState(root, config("agentMail"), runtimeRoot);
    expect(checks).toEqual([
      expect.objectContaining({
        status: "fail",
        message: expect.stringContaining(oldState),
      }),
    ]);
    expect(Bun.file(oldState).size).toBe(6);
  });

  test("reports the exact reviewed-reply permission set without exposing credentials", () => {
    const parsed = config("agentMail");
    parsed.augments[0]!.options = {
      apiKey: "am_secret",
      inboxId: "support@agentmail.to",
      inbound: { mode: "websocket", allowAnySender: true },
      replies: { mode: "review" },
      outbound: { allowDirectDelivery: true },
    };
    const checks = checkAgentMailPolicy(parsed);
    expect(checks[0]).toMatchObject({
      status: "pass",
      message: expect.stringContaining("draft_send"),
      fix: expect.stringContaining("exact key"),
    });
    expect(JSON.stringify(checks)).not.toContain("am_secret");
  });
});
