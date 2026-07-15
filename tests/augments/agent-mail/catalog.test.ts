import { describe, test, expect } from "bun:test";
import { AUGMENT_CATALOG } from "../../../src/cli/augment-catalog";

describe("agentMail catalog entry", () => {
  const entry = AUGMENT_CATALOG.find((e) => e.type === "agentMail");

  test("is registered in the catalog", () => {
    expect(entry).toBeDefined();
  });

  test("uses the conventional defaultName", () => {
    expect(entry!.defaultName).toBe("agentMail");
  });

  test("declares AgentMail API, inbox, and optional webhook secret env vars", () => {
    expect(entry!.envVars).toEqual([
      "AGENTMAIL_API_KEY",
      "AGENTMAIL_INBOX_ID",
      "AGENTMAIL_WEBHOOK_SECRET",
    ]);
  });

  test("ships with a bundled skill", () => {
    expect(entry!.hasSkill).toBe(true);
  });

  test("default options match the plan-A shape", () => {
    const opts = entry!.defaultOptions as Record<string, unknown>;
    expect(opts.apiKey).toBe("${AGENTMAIL_API_KEY}");
    expect(opts.inboxId).toBe("${AGENTMAIL_INBOX_ID}");
    const inbound = opts.inbound as Record<string, unknown>;
    expect(inbound.mode).toBe("none");
    const outbound = opts.outbound as Record<string, unknown>;
    expect(outbound.allowedTrustLevels).toEqual(["creator"]);
    expect(outbound.subjectPrefix).toBe("[Auggy] ");
    expect(outbound.allowHtml).toBe(false);
  });

  test("is not required (operators opt in)", () => {
    expect(entry!.required).toBe(false);
  });
});
