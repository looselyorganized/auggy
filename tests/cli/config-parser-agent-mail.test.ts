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

function configWithAgentMail(
  opts: Record<string, unknown>,
  extraAugments: Record<string, unknown>[] = [],
): string {
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
      ...extraAugments,
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

  test("accepts canonical inbox identity settings", () => {
    const path = writeYaml(
      configWithAgentMail({
        apiKey: "am_x",
        inboxId: "inb_x",
        emailAddress: "agent@example.com",
        addressVisibility: "public",
      }),
    );
    expect(() => parseConfig(path)).not.toThrow();
  });

  test("rejects malformed inbox identity settings", () => {
    for (const options of [{ emailAddress: "not-email" }, { addressVisibility: "everyone" }]) {
      const path = writeYaml(configWithAgentMail({ apiKey: "am_x", inboxId: "inb_x", ...options }));
      expect(() => parseConfig(path)).toThrow(/emailAddress|addressVisibility/);
    }
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
    expect(() => parseConfig(path)).toThrow(/inbound\.mode/);
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
      const path = writeYaml(
        configWithAgentMail({ apiKey: "am_x", inboxId: "inb_x", inbound }, [
          { name: "web", type: "webTransport", options: { port: 18_080 } },
        ]),
      );
      expect(() => parseConfig(path)).not.toThrow();
    }
  });

  test("accepts action-specific disabled, reviewed, and bounded automatic replies", () => {
    for (const testCase of [
      {
        options: {
          inbound: {
            mode: "polling",
            allowedSenders: ["sender@example.com"],
            replies: { mode: "disabled", allowReplyAll: false },
          },
        },
        needsAdmin: false,
      },
      {
        options: {
          inbound: {
            mode: "websocket",
            allowedSenders: ["sender@example.com"],
            replies: { mode: "review", allowReplyAll: true },
          },
        },
        needsAdmin: true,
      },
      {
        options: {
          inbound: {
            mode: "polling",
            allowedSenders: ["sender@example.com"],
            replies: { mode: "automatic" },
          },
          outbound: { rateLimit: { enabled: true, globalMaxPerHour: 25 } },
        },
        needsAdmin: true,
      },
    ]) {
      const path = writeYaml(
        configWithAgentMail(
          { apiKey: "am_x", inboxId: "inb_x", ...testCase.options },
          testCase.needsAdmin
            ? [{ name: "web", type: "webTransport", options: { port: 18_080 } }]
            : [],
        ),
      );
      expect(() => parseConfig(path)).not.toThrow();
    }
  });

  test("requires creator admin review for default review and automatic sensitive fallback", () => {
    for (const replies of [undefined, { mode: "review" }, { mode: "automatic" }] as const) {
      const options = {
        apiKey: "am_x",
        inboxId: "inb_x",
        inbound: {
          mode: "websocket",
          allowedSenders: ["sender@example.com"],
          ...(replies ? { replies } : {}),
        },
        ...(replies?.mode === "automatic"
          ? { outbound: { rateLimit: { enabled: true, globalMaxPerHour: 10 } } }
          : {}),
      };
      const missing = writeYaml(configWithAgentMail(options));
      expect(() => parseConfig(missing)).toThrow(/human review requires a webTransport/);

      const disabledAdmin = writeYaml(
        configWithAgentMail(options, [
          {
            name: "web",
            type: "webTransport",
            options: { port: 18_080, adminRoute: false },
          },
        ]),
      );
      expect(() => parseConfig(disabledAdmin)).toThrow(/adminRoute enabled/);
    }
  });

  test("rejects unsafe or malformed inbound reply policy", () => {
    for (const options of [
      {
        inbound: {
          mode: "polling",
          allowedSenders: ["sender@example.com"],
          replies: { mode: "sometimes" },
        },
      },
      {
        inbound: {
          mode: "polling",
          allowedSenders: ["sender@example.com"],
          autoReply: true,
        },
      },
      {
        inbound: {
          mode: "none",
          replies: { mode: "review" },
        },
      },
      {
        inbound: {
          mode: "polling",
          allowedSenders: ["sender@example.com"],
          replies: { mode: "disabled", allowReplyAll: true },
        },
      },
      {
        inbound: {
          mode: "polling",
          allowedSenders: ["sender@example.com"],
          replies: { mode: "automatic" },
        },
        outbound: { rateLimit: { enabled: false } },
      },
      {
        inbound: {
          mode: "polling",
          allowedSenders: ["sender@example.com"],
          replies: { mode: "automatic" },
        },
        outbound: { rateLimit: [] },
      },
      {
        inbound: {
          mode: "polling",
          allowedSenders: ["sender@example.com"],
          replies: { mode: "automatic" },
        },
        outbound: { rateLimit: { globalMaxPerHour: 101 } },
      },
    ]) {
      const path = writeYaml(configWithAgentMail({ apiKey: "am_x", inboxId: "inb_x", ...options }));
      expect(() => parseConfig(path)).toThrow(
        /inbound\.replies|automatic inbound replies|unsupported inbound field/,
      );
    }
  });

  test("rejects malformed and duplicate inbound sender patterns", () => {
    for (const allowedSenders of [
      ["*"],
      ["foo*"],
      ["*@example"],
      ["sender@example.com "],
      ["Sender@Example.com", "sender@example.com"],
    ]) {
      const path = writeYaml(
        configWithAgentMail({
          apiKey: "am_x",
          inboxId: "inb_x",
          inbound: { mode: "websocket", allowedSenders },
        }),
      );
      expect(() => parseConfig(path)).toThrow(/allowedSenders/);
    }
  });

  test("enforces bounded inbound polling, prompt, and attempt settings", () => {
    for (const setting of [
      { pollIntervalMs: 999 },
      { pollIntervalMs: 86_400_001 },
      { maxPromptBytes: 511 },
      { maxPromptBytes: 1_048_577 },
      { maxAttempts: 0 },
      { maxAttempts: 21 },
    ]) {
      const path = writeYaml(
        configWithAgentMail({
          apiKey: "am_x",
          inboxId: "inb_x",
          inbound: {
            mode: "polling",
            allowedSenders: ["sender@example.com"],
            ...setting,
          },
        }),
      );
      expect(() => parseConfig(path)).toThrow(/pollIntervalMs|maxPromptBytes|maxAttempts/);
    }
  });

  test("requires an enabled inbox to process at least one classification", () => {
    const path = writeYaml(
      configWithAgentMail({
        apiKey: "am_x",
        inboxId: "inb_x",
        inbound: {
          mode: "websocket",
          allowedSenders: ["sender@example.com"],
          classifications: {
            received: "discard",
            spam: "discard",
            blocked: "discard",
            unauthenticated: "discard",
          },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow(/at least one message classification/);
  });

  test("validates dormant inbound policy instead of accepting a dangerous future toggle", () => {
    const invalidSender = writeYaml(
      configWithAgentMail({
        apiKey: "am_x",
        inboxId: "inb_x",
        inbound: { mode: "none", allowedSenders: ["foo*"] },
      }),
    );
    expect(() => parseConfig(invalidSender)).toThrow(/allowedSenders/);

    const invalidClassification = writeYaml(
      configWithAgentMail({
        apiKey: "am_x",
        inboxId: "inb_x",
        inbound: { mode: "none", classifications: { received: "maybe" } },
      }),
    );
    expect(() => parseConfig(invalidClassification)).toThrow(/classifications.received/);

    const unknownClassification = writeYaml(
      configWithAgentMail({
        apiKey: "am_x",
        inboxId: "inb_x",
        inbound: { mode: "none", classifications: { received: "process", typo: "discard" } },
      }),
    );
    expect(() => parseConfig(unknownClassification)).toThrow(/classifications.*typo/);
  });

  test("rejects array-shaped inbound and webhook objects", () => {
    const inboundArray = writeYaml(
      configWithAgentMail({ apiKey: "am_x", inboxId: "inb_x", inbound: [] }),
    );
    expect(() => parseConfig(inboundArray)).toThrow(/inbound.*object/);

    const webhookArray = writeYaml(
      configWithAgentMail({
        apiKey: "am_x",
        inboxId: "inb_x",
        inbound: {
          mode: "webhook",
          allowedSenders: ["sender@example.com"],
          webhook: [],
        },
      }),
    );
    expect(() => parseConfig(webhookArray)).toThrow(/webhook.*required/);
  });

  test("rejects malformed or credential-bearing WebSocket override URLs", () => {
    for (const websocketBaseUrl of [
      "https://ws.example.com",
      "wss://user:secret@ws.example.com",
      "not-a-url",
    ]) {
      const path = writeYaml(
        configWithAgentMail({
          apiKey: "am_x",
          inboxId: "inb_x",
          inbound: {
            mode: "websocket",
            allowedSenders: ["sender@example.com"],
            websocketBaseUrl,
          },
        }),
      );
      expect(() => parseConfig(path)).toThrow(/websocketBaseUrl/);
    }
  });

  test("rejects webhook mode without an HTTP transport to mount the route", () => {
    const path = writeYaml(
      configWithAgentMail({
        apiKey: "am_x",
        inboxId: "inb_x",
        inbound: {
          mode: "webhook",
          allowedSenders: ["customer@example.com"],
          webhook: { secretEnv: "AGENTMAIL_WEBHOOK_SECRET" },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow(/requires a webTransport/);
  });

  test("accepts inbound.mode = 'none'", () => {
    const path = writeYaml(
      configWithAgentMail({ apiKey: "am_x", inboxId: "inb_x", inbound: { mode: "none" } }),
    );
    expect(() => parseConfig(path)).not.toThrow();
  });

  test("keeps creator digest default-off without a Notify dependency", () => {
    const omitted = writeYaml(
      configWithAgentMail({
        apiKey: "am_x",
        inboxId: "inb_x",
        inbound: { mode: "none" },
      }),
    );
    expect(() => parseConfig(omitted)).not.toThrow();

    const disabled = writeYaml(
      configWithAgentMail({
        apiKey: "am_x",
        inboxId: "inb_x",
        inbound: {
          mode: "none",
          creatorDigest: { enabled: false, destination: "creator" },
        },
      }),
    );
    expect(() => parseConfig(disabled)).not.toThrow();
  });

  test("resolves an enabled creator digest to a bounded creator Notify destination", () => {
    const agentMail = {
      apiKey: "am_x",
      inboxId: "inb_x",
      inbound: {
        mode: "polling",
        allowedSenders: ["sender@example.com"],
        replies: { mode: "disabled" },
        creatorDigest: { enabled: true, destination: "creator" },
      },
    };
    const validNotify = {
      name: "notify",
      type: "notify",
      options: {
        destinations: [
          {
            name: "creator",
            transport: "log-to-file",
            path: "./notifications.jsonl",
          },
        ],
      },
    };
    expect(() =>
      parseConfig(writeYaml(configWithAgentMail(agentMail, [validNotify]))),
    ).not.toThrow();

    for (const notifyOptions of [
      undefined,
      {
        destinations: [
          {
            name: "creator",
            transport: "log-to-file",
            path: "./notifications.jsonl",
            allowedTrustLevels: ["agent"],
          },
        ],
      },
      {
        destinations: [
          {
            name: "creator",
            transport: "log-to-file",
            path: "./notifications.jsonl",
          },
        ],
        rateLimit: { enabled: false },
      },
      {
        destinations: [
          {
            name: "creator",
            transport: "log-to-file",
            path: "./notifications.jsonl",
            rateLimit: { maxPerHour: 0 },
          },
        ],
      },
    ]) {
      const notifyAugments = notifyOptions
        ? [{ name: "notify", type: "notify", options: notifyOptions }]
        : [];
      expect(() => parseConfig(writeYaml(configWithAgentMail(agentMail, notifyAugments)))).toThrow(
        /creator digest destination/,
      );
    }
  });

  test("rejects duplicate Notify destination names across mounted augments", () => {
    const path = writeYaml(
      configWithAgentMail(
        { apiKey: "am_x", inboxId: "inb_x" },
        ["notify-a", "notify-b"].map((name) => ({
          name,
          type: "notify",
          options: {
            destinations: [
              {
                name: "creator",
                transport: "log-to-file",
                path: `./${name}.jsonl`,
              },
            ],
          },
        })),
      ),
    );
    expect(() => parseConfig(path)).toThrow(
      /destination "creator".*declared by both "notify-a" and "notify-b"/,
    );
  });

  test("validates creator digest dependencies after folder augment expansion", () => {
    mkdirSync(join(TMP, "augments", "mail"), { recursive: true });
    mkdirSync(join(TMP, "augments", "notifications"), { recursive: true });
    writeFileSync(
      join(TMP, "augments", "mail", "augment.yaml"),
      stringify({
        type: "agentMail",
        config: {
          apiKey: "am_x",
          inboxId: "inb_x",
          inbound: {
            mode: "polling",
            allowedSenders: ["sender@example.com"],
            replies: { mode: "disabled" },
            creatorDigest: { enabled: true, destination: "creator" },
          },
        },
      }),
    );
    writeFileSync(
      join(TMP, "augments", "notifications", "augment.yaml"),
      stringify({
        type: "notify",
        config: {
          destinations: [
            {
              name: "creator",
              transport: "log-to-file",
              path: "./notifications.jsonl",
            },
          ],
        },
      }),
    );
    const path = writeYaml(
      stringify({
        id: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
        name: "test-agent",
        engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
        augments: ["mail", "notifications"],
      }),
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

  test("rejects non-integer and oversized outbound body limits", () => {
    for (const bodyMaxBytes of [1.5, 1024 * 1024 + 1]) {
      const path = writeYaml(
        configWithAgentMail({
          apiKey: "am_x",
          inboxId: "inb_x",
          outbound: { bodyMaxBytes },
        }),
      );
      expect(() => parseConfig(path)).toThrow(/bodyMaxBytes.*between 1 and 1048576/);
    }
  });

  test("accepts explicit outbound human-review policy", () => {
    const path = writeYaml(
      configWithAgentMail(
        {
          apiKey: "am_x",
          inboxId: "inb_x",
          outbound: {
            allowedTrustLevels: ["public"],
            humanReview: { requiredForTrustLevels: ["public"], expiresAfterMs: 60_000 },
          },
        },
        [{ name: "web", type: "webTransport", options: { port: 18_080 } }],
      ),
    );
    expect(() => parseConfig(path)).not.toThrow();
  });

  test("rejects active human review without a creator-authenticated web route", () => {
    const path = writeYaml(
      configWithAgentMail({
        apiKey: "am_x",
        inboxId: "inb_x",
        outbound: {
          allowedTrustLevels: ["public"],
          humanReview: { requiredForTrustLevels: ["public"] },
        },
      }),
    );
    expect(() => parseConfig(path)).toThrow(/human review requires a webTransport/);

    const disabledAdmin = writeYaml(
      configWithAgentMail(
        {
          apiKey: "am_x",
          inboxId: "inb_x",
          outbound: {
            allowedTrustLevels: ["public"],
            humanReview: { requiredForTrustLevels: ["public"] },
          },
        },
        [
          {
            name: "web",
            type: "webTransport",
            options: { port: 0, adminRoute: false },
          },
        ],
      ),
    );
    expect(() => parseConfig(disabledAdmin)).toThrow(/adminRoute enabled/);
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
