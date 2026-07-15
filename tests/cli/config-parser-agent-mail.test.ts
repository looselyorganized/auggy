/**
 * Config-parser validation for the agentMail augment.
 *
 * Mirrors the writeYaml + minimalConfig pattern from config-parser.test.ts
 * but scoped to agentMail-specific assertions so the file stays focused.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { parseConfig } from "../../src/cli/config-parser";

const TMP = join(import.meta.dir, ".tmp-config-am-test");

function writeYaml(content: string): string {
  const path = join(TMP, "agent.yaml");
  writeFileSync(path, content);
  return path;
}

function configWithAgentMail(opts: Record<string, unknown>): string {
  const base = {
    id: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
    name: "test-agent",
    engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
    augments: [
      {
        name: "identity",
        type: "fileMemory",
        options: {
          label: "self",
          source: "./identity.md",
          mutable: false,
          origin: "operator",
          priority: "required",
          placement: "system",
          eviction: "never",
        },
      },
      { name: "agentmail", type: "agentMail", options: opts },
    ],
  };
  return stringify(base);
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, "identity.md"), "# Test Identity");
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("config-parser: agentMail validation", () => {
  test("accepts a minimal valid agentMail block", () => {
    const path = writeYaml(configWithAgentMail({ apiKey: "am_x", inboxId: "inb_x" }));
    const config = parseConfig(path);
    const am = config.augments.find((a) => a.type === "agentMail");
    expect(am).toBeDefined();
    expect((am!.options as Record<string, unknown>).apiKey).toBe("am_x");
  });

  test("rejects missing apiKey", () => {
    const path = writeYaml(configWithAgentMail({ inboxId: "inb_x" }));
    expect(() => parseConfig(path)).toThrow(/apiKey/);
  });

  test("rejects missing inboxId", () => {
    const path = writeYaml(configWithAgentMail({ apiKey: "am_x" }));
    expect(() => parseConfig(path)).toThrow(/inboxId/);
  });

  test("rejects empty subjectPrefix", () => {
    const path = writeYaml(
      configWithAgentMail({
        apiKey: "am_x",
        inboxId: "inb_x",
        outbound: { subjectPrefix: "" },
      }),
    );
    expect(() => parseConfig(path)).toThrow(/subjectPrefix/);
  });

  test("rejects invalid trust level", () => {
    const path = writeYaml(
      configWithAgentMail({
        apiKey: "am_x",
        inboxId: "inb_x",
        outbound: { allowedTrustLevels: ["mystery"] },
      }),
    );
    expect(() => parseConfig(path)).toThrow(/allowedTrustLevels/);
  });

  test("rejects unknown inbound.mode", () => {
    const path = writeYaml(
      configWithAgentMail({ apiKey: "am_x", inboxId: "inb_x", inbound: { mode: "bogus" } }),
    );
    expect(() => parseConfig(path)).toThrow(/unknown mode/);
  });

  test("requires an explicit sender allowlist for enabled inbound modes", () => {
    const path = writeYaml(
      configWithAgentMail({ apiKey: "am_x", inboxId: "inb_x", inbound: { mode: "websocket" } }),
    );
    expect(() => parseConfig(path)).toThrow(/allowedSenders/);
  });

  test("accepts enabled inbound modes with policy configuration", () => {
    for (const inbound of [
      { mode: "websocket", allowedSenders: ["*@example.com"] },
      { mode: "polling", allowedSenders: ["customer@example.com"], pollIntervalMs: 60_000 },
      {
        mode: "webhook",
        allowedSenders: ["customer@example.com"],
        webhook: { secretEnv: "AGENTMAIL_WEBHOOK_SECRET" },
      },
    ]) {
      const path = writeYaml(configWithAgentMail({ apiKey: "am_x", inboxId: "inb_x", inbound }));
      expect(() => parseConfig(path)).not.toThrow();
    }
  });

  test("accepts inbound.mode = 'none'", () => {
    const path = writeYaml(
      configWithAgentMail({ apiKey: "am_x", inboxId: "inb_x", inbound: { mode: "none" } }),
    );
    expect(() => parseConfig(path)).not.toThrow();
  });

  test("rejects non-positive maxRecipients", () => {
    const path = writeYaml(
      configWithAgentMail({
        apiKey: "am_x",
        inboxId: "inb_x",
        outbound: { maxRecipients: 0 },
      }),
    );
    expect(() => parseConfig(path)).toThrow(/maxRecipients/);
  });

  test("accepts explicit outbound human-review policy", () => {
    const path = writeYaml(
      configWithAgentMail({
        apiKey: "am_x",
        inboxId: "inb_x",
        outbound: {
          allowedTrustLevels: ["public"],
          humanReview: { requiredForTrustLevels: ["public"], expiresAfterMs: 60_000 },
        },
      }),
    );
    expect(() => parseConfig(path)).not.toThrow();
  });

  test("rejects malformed outbound human-review policy", () => {
    const invalidLevel = writeYaml(
      configWithAgentMail({
        apiKey: "am_x",
        inboxId: "inb_x",
        outbound: { humanReview: { requiredForTrustLevels: ["mystery"] } },
      }),
    );
    expect(() => parseConfig(invalidLevel)).toThrow(/humanReview.requiredForTrustLevels/);

    const invalidExpiry = writeYaml(
      configWithAgentMail({
        apiKey: "am_x",
        inboxId: "inb_x",
        outbound: { humanReview: { expiresAfterMs: 0 } },
      }),
    );
    expect(() => parseConfig(invalidExpiry)).toThrow(/humanReview.expiresAfterMs/);

    const excessiveExpiry = writeYaml(
      configWithAgentMail({
        apiKey: "am_x",
        inboxId: "inb_x",
        outbound: { humanReview: { expiresAfterMs: 31 * 24 * 60 * 60_000 } },
      }),
    );
    expect(() => parseConfig(excessiveExpiry)).toThrow(/humanReview.expiresAfterMs/);
  });
});
