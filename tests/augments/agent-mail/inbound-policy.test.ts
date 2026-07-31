import { describe, expect, test } from "bun:test";
import {
  AGENTMAIL_MAX_ALLOWED_SENDERS,
  AGENTMAIL_MAX_ATTEMPTS,
  AGENTMAIL_MAX_AUTOMATIC_REPLIES_PER_HOUR,
  AGENTMAIL_MAX_POLL_INTERVAL_MS,
  AGENTMAIL_MAX_PROMPT_BYTES,
  AGENTMAIL_MIN_POLL_INTERVAL_MS,
  AGENTMAIL_MIN_PROMPT_BYTES,
  agentMailInboundRequiresAdminRoute,
  normalizeAgentMailAllowedSenders,
  processedAgentMailEventTypes,
  resolveAgentMailInboundReplies,
  validateAgentMailClassificationActions,
  validateAgentMailEffectiveHourlyCap,
  validateAgentMailInboundConfig,
  validateAgentMailInboundBounds,
} from "../../../src/augments/agentMail/inbound-policy";
import {
  AGENTMAIL_CREATOR_DIGEST_DEFAULT_INTERVAL_MS,
  AGENTMAIL_CREATOR_DIGEST_DEFAULT_MAX_ATTEMPTS,
  AGENTMAIL_CREATOR_DIGEST_DEFAULT_MAX_ITEMS,
  AGENTMAIL_CREATOR_DIGEST_MAX_INTERVAL_MS,
  AGENTMAIL_CREATOR_DIGEST_MAX_ITEMS,
  AGENTMAIL_CREATOR_DIGEST_MIN_INTERVAL_MS,
  collectNotifyDestinationPolicyBindings,
  resolveAgentMailCreatorDigestConfig,
  resolveCreatorDigestNotifyBinding,
  validateUniqueNotifyDestinationNames,
} from "../../../src/augments/agentMail/creator-digest-policy";

describe("AgentMail inbound sender policy", () => {
  test("canonicalizes exact addresses and exact-domain globs", () => {
    expect(normalizeAgentMailAllowedSenders(["Alice@Example.com", "*@Customers.Example"])).toEqual([
      "alice@example.com",
      "*@customers.example",
    ]);
  });

  test("rejects patterns that would otherwise fail silently", () => {
    for (const pattern of [
      "*",
      "foo*",
      "*@example",
      "@example.com",
      "alice@example.com ",
      "alice\n@example.com",
      "*.example.com",
    ]) {
      expect(() => normalizeAgentMailAllowedSenders([pattern])).toThrow(/sender pattern|control/);
    }
  });

  test("rejects empty and duplicate policies after case normalization", () => {
    expect(() => normalizeAgentMailAllowedSenders([])).toThrow(/at least one/);
    expect(() =>
      normalizeAgentMailAllowedSenders(["Alice@Example.com", "alice@example.com"]),
    ).toThrow(/duplicate/);
    expect(() =>
      normalizeAgentMailAllowedSenders(
        Array.from(
          { length: AGENTMAIL_MAX_ALLOWED_SENDERS + 1 },
          (_, index) => `sender-${index}@example.com`,
        ),
      ),
    ).toThrow(/at most/);
  });
});

describe("AgentMail inbound classification policy", () => {
  test("processes ordinary received mail only by default", () => {
    expect(processedAgentMailEventTypes(undefined)).toEqual(["message.received"]);
  });

  test("returns exactly the explicitly processed classification subset", () => {
    expect(
      processedAgentMailEventTypes({
        received: "discard",
        spam: "process",
        blocked: "discard",
        unauthenticated: "process",
      }),
    ).toEqual(["message.received.spam", "message.received.unauthenticated"]);
  });

  test("requires at least one processed classification", () => {
    expect(() =>
      processedAgentMailEventTypes({
        received: "discard",
        spam: "discard",
        blocked: "discard",
        unauthenticated: "discard",
      }),
    ).toThrow(/at least one/);
  });

  test("rejects malformed and unknown classification fields", () => {
    expect(() => validateAgentMailClassificationActions([] as never)).toThrow(/must be an object/);
    expect(() =>
      validateAgentMailClassificationActions({ received: "maybe", typo: "process" } as never),
    ).toThrow(/unsupported.*typo/);
  });
});

describe("AgentMail inbound resource bounds", () => {
  test("accepts every inclusive boundary", () => {
    expect(() =>
      validateAgentMailInboundBounds({
        mode: "polling",
        allowedSenders: ["sender@example.com"],
        pollIntervalMs: AGENTMAIL_MIN_POLL_INTERVAL_MS,
        maxPromptBytes: AGENTMAIL_MIN_PROMPT_BYTES,
        maxAttempts: 1,
      }),
    ).not.toThrow();
    expect(() =>
      validateAgentMailInboundBounds({
        mode: "polling",
        allowedSenders: ["sender@example.com"],
        pollIntervalMs: AGENTMAIL_MAX_POLL_INTERVAL_MS,
        maxPromptBytes: AGENTMAIL_MAX_PROMPT_BYTES,
        maxAttempts: AGENTMAIL_MAX_ATTEMPTS,
      }),
    ).not.toThrow();
  });

  test("rejects provider-hammering and unbounded work settings", () => {
    for (const inbound of [
      { pollIntervalMs: AGENTMAIL_MIN_POLL_INTERVAL_MS - 1 },
      { pollIntervalMs: AGENTMAIL_MAX_POLL_INTERVAL_MS + 1 },
      { maxPromptBytes: AGENTMAIL_MIN_PROMPT_BYTES - 1 },
      { maxPromptBytes: AGENTMAIL_MAX_PROMPT_BYTES + 1 },
      { maxAttempts: 0 },
      { maxAttempts: AGENTMAIL_MAX_ATTEMPTS + 1 },
    ]) {
      expect(() =>
        validateAgentMailInboundBounds({
          mode: "polling",
          allowedSenders: ["sender@example.com"],
          ...inbound,
        }),
      ).toThrow(/inbound\.(pollIntervalMs|maxPromptBytes|maxAttempts)/);
    }
  });

  test("shares complete provider-mode validation across callers", () => {
    for (const inbound of [
      { mode: "websocket", allowedSenders: ["sender@example.com"], websocketBaseUrl: "https://x" },
      { mode: "webhook", allowedSenders: ["sender@example.com"] },
      {
        mode: "polling",
        allowedSenders: ["sender@example.com"],
        webhook: {},
      },
    ]) {
      expect(() => validateAgentMailInboundConfig(inbound)).toThrow();
    }
  });
});

describe("AgentMail creator digest policy", () => {
  test("is default-off and resolves bounded defaults without a destination dependency", () => {
    expect(resolveAgentMailCreatorDigestConfig(undefined, "none")).toEqual({
      enabled: false,
      intervalMs: AGENTMAIL_CREATOR_DIGEST_DEFAULT_INTERVAL_MS,
      maxItems: AGENTMAIL_CREATOR_DIGEST_DEFAULT_MAX_ITEMS,
      maxAttempts: AGENTMAIL_CREATOR_DIGEST_DEFAULT_MAX_ATTEMPTS,
    });
    expect(
      validateAgentMailInboundConfig({
        mode: "none",
        creatorDigest: { enabled: false, destination: "creator" },
      }).creatorDigest.enabled,
    ).toBe(false);
  });

  test("accepts enabled bounded configuration only while inbound is active", () => {
    expect(
      validateAgentMailInboundConfig({
        mode: "polling",
        allowedSenders: ["sender@example.com"],
        creatorDigest: {
          enabled: true,
          destination: "creator",
          intervalMs: AGENTMAIL_CREATOR_DIGEST_MIN_INTERVAL_MS,
          maxItems: AGENTMAIL_CREATOR_DIGEST_MAX_ITEMS,
          maxAttempts: 1,
        },
      }).creatorDigest,
    ).toEqual({
      enabled: true,
      destination: "creator",
      intervalMs: AGENTMAIL_CREATOR_DIGEST_MIN_INTERVAL_MS,
      maxItems: AGENTMAIL_CREATOR_DIGEST_MAX_ITEMS,
      maxAttempts: 1,
    });

    expect(() =>
      validateAgentMailInboundConfig({
        mode: "none",
        creatorDigest: { enabled: true, destination: "creator" },
      }),
    ).toThrow(/cannot be enabled.*inbound\.mode is "none"/);
  });

  test("rejects malformed, unknown, and unbounded creator digest settings", () => {
    for (const creatorDigest of [
      [],
      { enabled: "yes" },
      { enabled: true },
      { enabled: true, destination: " creator " },
      { enabled: true, destination: "creator\nops" },
      { intervalMs: AGENTMAIL_CREATOR_DIGEST_MIN_INTERVAL_MS - 1 },
      { intervalMs: AGENTMAIL_CREATOR_DIGEST_MAX_INTERVAL_MS + 1 },
      { maxItems: 0 },
      { maxItems: AGENTMAIL_CREATOR_DIGEST_MAX_ITEMS + 1 },
      { maxAttempts: 0 },
      { maxAttempts: 21 },
      { typo: true },
    ]) {
      expect(() =>
        validateAgentMailInboundConfig({
          mode: "polling",
          allowedSenders: ["sender@example.com"],
          creatorDigest,
        }),
      ).toThrow(/creatorDigest/);
    }
  });

  test("requires one unique creator-authorized bounded Notify destination", () => {
    const digest = resolveAgentMailCreatorDigestConfig(
      { enabled: true, destination: "creator" },
      "polling",
    );
    const bindings = collectNotifyDestinationPolicyBindings([
      {
        augmentName: "notify",
        destinations: [{ name: "creator", transport: "log-to-file" }],
      },
    ]);
    expect(resolveCreatorDigestNotifyBinding(digest, bindings)).toEqual({
      augmentName: "notify",
      destinationName: "creator",
    });

    expect(() => resolveCreatorDigestNotifyBinding(digest, [])).toThrow(/does not match/);
    expect(() =>
      resolveCreatorDigestNotifyBinding(
        digest,
        collectNotifyDestinationPolicyBindings([
          {
            augmentName: "notify",
            destinations: [
              {
                name: "creator",
                allowedTrustLevels: ["agent"],
              },
            ],
          },
        ]),
      ),
    ).toThrow(/must allow creator trust/);
    expect(() =>
      resolveCreatorDigestNotifyBinding(
        digest,
        collectNotifyDestinationPolicyBindings([
          {
            augmentName: "notify",
            destinations: [
              {
                name: "creator",
                allowedTrustLevels: ["creator", "invalid"],
              },
            ],
          },
        ]),
      ),
    ).toThrow(/invalid Notify authority policy/);

    for (const source of [
      {
        augmentName: "notify",
        destinations: [{ name: "creator" }],
        rateLimit: { enabled: false },
      },
      {
        augmentName: "notify",
        destinations: [{ name: "creator" }],
        rateLimit: { globalMaxPerHour: 0 },
      },
      {
        augmentName: "notify",
        destinations: [{ name: "creator", rateLimit: { maxPerHour: 0 } }],
      },
    ]) {
      expect(() =>
        resolveCreatorDigestNotifyBinding(digest, collectNotifyDestinationPolicyBindings([source])),
      ).toThrow(/requires/);
    }
  });

  test("rejects duplicate destination names across Notify augments", () => {
    const bindings = collectNotifyDestinationPolicyBindings([
      { augmentName: "notify-a", destinations: [{ name: "creator" }] },
      { augmentName: "notify-b", destinations: [{ name: "creator" }] },
    ]);
    expect(() => validateUniqueNotifyDestinationNames(bindings)).toThrow(
      /declared by both "notify-a" and "notify-b"/,
    );
  });
});

describe("AgentMail inbound reply policy", () => {
  test("resolves dormant inbound to disabled and enabled inbound to reviewed replies", () => {
    expect(resolveAgentMailInboundReplies("none", undefined, undefined)).toEqual({
      mode: "disabled",
      allowReplyAll: false,
    });
    expect(resolveAgentMailInboundReplies("websocket", undefined, undefined)).toEqual({
      mode: "review",
      allowReplyAll: false,
    });
    expect(
      validateAgentMailInboundConfig({
        mode: "polling",
        allowedSenders: ["sender@example.com"],
      }).replies,
    ).toEqual({ mode: "review", allowReplyAll: false });
  });

  test("accepts explicit disabled, review, and bounded automatic policies", () => {
    expect(
      resolveAgentMailInboundReplies(
        "polling",
        { mode: "disabled", allowReplyAll: false },
        undefined,
      ),
    ).toEqual({ mode: "disabled", allowReplyAll: false });
    expect(
      resolveAgentMailInboundReplies("polling", { mode: "review", allowReplyAll: true }, undefined),
    ).toEqual({ mode: "review", allowReplyAll: true });
    expect(
      resolveAgentMailInboundReplies(
        "polling",
        { mode: "automatic", allowReplyAll: false },
        {
          rateLimit: {
            enabled: true,
            globalMaxPerHour: AGENTMAIL_MAX_AUTOMATIC_REPLIES_PER_HOUR,
          },
        },
      ),
    ).toEqual({ mode: "automatic", allowReplyAll: false });
  });

  test("rejects malformed, contradictory, and unknown reply policies", () => {
    for (const replies of [
      [],
      { mode: "sometimes" },
      { allowReplyAll: "yes" },
      { mode: "disabled", allowReplyAll: true },
      { mode: "review", typo: false },
    ]) {
      expect(() =>
        validateAgentMailInboundConfig({
          mode: "polling",
          allowedSenders: ["sender@example.com"],
          replies,
        }),
      ).toThrow(/inbound\.replies/);
    }
    expect(() =>
      validateAgentMailInboundConfig({
        mode: "none",
        replies: { mode: "review" },
      }),
    ).toThrow(/must be "disabled".*inbound.mode is "none"/);
  });

  test("rejects unknown top-level fields instead of silently ignoring authority settings", () => {
    expect(() =>
      validateAgentMailInboundConfig({
        mode: "polling",
        allowedSenders: ["sender@example.com"],
        autoReply: true,
      }),
    ).toThrow(/unsupported inbound field "autoReply"/);
  });

  test("fails automatic replies closed without a bounded enabled hourly cap", () => {
    const inbound = {
      mode: "polling",
      allowedSenders: ["sender@example.com"],
      replies: { mode: "automatic" },
    } as const;

    expect(validateAgentMailInboundConfig(inbound).replies.mode).toBe("automatic");
    for (const rateLimit of [
      { enabled: false },
      { enabled: "yes" },
      { globalMaxPerHour: 0 },
      { globalMaxPerHour: AGENTMAIL_MAX_AUTOMATIC_REPLIES_PER_HOUR + 1 },
      { globalMaxPerHour: 1.5 },
      { globalMaxPerHour: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => validateAgentMailInboundConfig(inbound, { rateLimit } as never)).toThrow(
        /automatic inbound replies require outbound\.rateLimit/,
      );
    }
    expect(() => validateAgentMailInboundConfig(inbound, { rateLimit: [] } as never)).toThrow(
      /automatic inbound replies require outbound\.rateLimit/,
    );
  });

  test("bounds the effective automatic cap after mutable overrides are applied", () => {
    expect(validateAgentMailEffectiveHourlyCap(100, "automatic")).toBe(100);
    expect(validateAgentMailEffectiveHourlyCap(101, "review")).toBe(101);

    for (const value of [0, 101, 1.5, Number.POSITIVE_INFINITY, "10"]) {
      expect(() => validateAgentMailEffectiveHourlyCap(value, "automatic")).toThrow(
        /effective outbound\.rateLimit\.globalMaxPerHour between 1 and 100/,
      );
    }
  });

  test("requires an admin route for every enabled policy that can enqueue review", () => {
    const defaultReview = validateAgentMailInboundConfig({
      mode: "websocket",
      allowedSenders: ["sender@example.com"],
    });
    const automatic = validateAgentMailInboundConfig({
      mode: "polling",
      allowedSenders: ["sender@example.com"],
      replies: { mode: "automatic" },
    });
    const disabled = validateAgentMailInboundConfig({
      mode: "polling",
      allowedSenders: ["sender@example.com"],
      replies: { mode: "disabled" },
    });

    expect(agentMailInboundRequiresAdminRoute(defaultReview)).toBe(true);
    expect(agentMailInboundRequiresAdminRoute(automatic)).toBe(true);
    expect(agentMailInboundRequiresAdminRoute(disabled)).toBe(false);
  });
});
