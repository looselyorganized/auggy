import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      process.cwd(),
    );

    expect(claims).toEqual(
      expect.arrayContaining([
        `agent-id:${AGENT_ID}`,
        expect.stringMatching(/^agent-state-path-v1:[A-Za-z0-9_-]+$/),
        expect.stringMatching(/^agent-state-root-sha256:[0-9a-f]{64}$/),
        "agentmail-inbox:inbox_orders",
        "tcp-port:8080",
        "telegram-bot:123456",
      ]),
    );
    expect(JSON.stringify(claims)).not.toContain("GROUP7_TELEGRAM_SENTINEL");
  });

  test("rejects two augments that declare one host listener", () => {
    expect(() =>
      runtimeResourceClaims(
        config([
          { name: "web", type: "webTransport", options: { port: 8081 } },
          { name: "link", type: "link", options: { port: 8081 } },
        ]),
        process.cwd(),
      ),
    ).toThrow(/tcp-port:8081.*web.*link/i);
  });

  test("fails closed when a programmatic webTransport omits or corrupts its port", () => {
    for (const port of [undefined, null, "8080", 0, 65_536, 8080.5]) {
      expect(() =>
        runtimeResourceClaims(
          config([{ name: "web", type: "webTransport", options: { port } }]),
          process.cwd(),
        ),
      ).toThrow(/webTransport.*port.*1 to 65535/i);
    }
  });

  test("rejects noncanonical Link and Telegram webhook listener ports", () => {
    for (const port of [0, -1, 8080.5, Number.NaN, Number.POSITIVE_INFINITY, 65_536]) {
      expect(() =>
        runtimeResourceClaims(
          config([{ name: "link", type: "link", options: { port } }]),
          process.cwd(),
        ),
      ).toThrow(/link.*port.*1 to 65535/i);
      expect(() =>
        runtimeResourceClaims(
          config([
            {
              name: "telegram",
              type: "telegramTransport",
              options: { inbound: { mode: "webhook", webhook: { port } } },
            },
          ]),
          process.cwd(),
        ),
      ).toThrow(/telegram.*port.*1 to 65535/i);
    }
  });

  test("gives different identities the same exclusive claim for one state root", () => {
    const first = runtimeResourceClaims(config([]), process.cwd()).find((claim) =>
      claim.startsWith("agent-state-root-sha256:"),
    );
    const secondConfig = config([]);
    secondConfig.id = "aug1_99999999-9999-4999-8999-999999999999";
    const second = runtimeResourceClaims(secondConfig, process.cwd()).find((claim) =>
      claim.startsWith("agent-state-root-sha256:"),
    );
    expect(first).toBe(second);
  });

  test("retains the pathname claim when a root is replaced and changes the inode claim", () => {
    const temp = mkdtempSync(join(tmpdir(), "auggy-root-claim-"));
    const root = join(temp, "agent");
    const moved = join(temp, "moved");
    mkdirSync(root);
    try {
      const before = runtimeResourceClaims(config([]), root);
      renameSync(root, moved);
      mkdirSync(root);
      const after = runtimeResourceClaims(config([]), root);
      expect(before.find((claim) => claim.startsWith("agent-state-path-v1:"))).toBe(
        after.find((claim) => claim.startsWith("agent-state-path-v1:")),
      );
      expect(before.find((claim) => claim.startsWith("agent-state-root-sha256:"))).not.toBe(
        after.find((claim) => claim.startsWith("agent-state-root-sha256:")),
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
