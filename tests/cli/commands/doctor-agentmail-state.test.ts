import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkUnsupportedAgentMailState } from "../../../src/cli/commands/doctor";
import type { ParsedConfig } from "../../../src/cli/types";

function config(type: "agentMail" | "notify"): ParsedConfig {
  return {
    id: "aug1_11111111-1111-4111-8111-111111111111",
    name: "mail-test",
    engine: { provider: "openai", model: "test" },
    augments: [{ name: type, type, options: {} }],
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
});
