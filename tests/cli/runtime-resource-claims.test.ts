import { describe, expect, test } from "bun:test";
import { runtimeResourceClaims } from "../../src/cli/runtime-resource-claims";
import type { ParsedConfig } from "../../src/cli/types";

const AGENT_ID = "aug1_8a3d7828-1597-4db4-bd0e-adc1a1036211";

function config(augments: ParsedConfig["augments"]): ParsedConfig {
  return {
    id: AGENT_ID,
    name: "orders",
    engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
    settings: {},
    augments,
  };
}

describe("runtimeResourceClaims", () => {
  test("claims immutable identity, listeners, and inbound provider identities without secrets", () => {
    const secret = "123456:GROUP7_TELEGRAM_SENTINEL";
    const claims = runtimeResourceClaims(
      config([
        { name: "web", type: "webTransport", options: { port: 8080 } },
        {
          name: "telegram",
          type: "telegramTransport",
          options: { botToken: secret, inbound: { mode: "polling" } },
        },
        {
          name: "mail",
          type: "agentMail",
          options: { inboxId: "inbox_orders", inbound: { mode: "polling" } },
        },
      ]),
    );

    expect(claims).toEqual([
      `agent-id:${AGENT_ID}`,
      "agentmail-inbox:inbox_orders",
      "tcp-port:8080",
      "telegram-bot:123456",
    ]);
    expect(JSON.stringify(claims)).not.toContain("GROUP7_TELEGRAM_SENTINEL");
  });

  test("rejects two augments that declare one host listener", () => {
    expect(() =>
      runtimeResourceClaims(
        config([
          { name: "web", type: "webTransport", options: { port: 8081 } },
          { name: "link", type: "link", options: { port: 8081 } },
        ]),
      ),
    ).toThrow(/tcp-port:8081.*web.*link/i);
  });
});
