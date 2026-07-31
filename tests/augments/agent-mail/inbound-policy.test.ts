import { describe, expect, test } from "bun:test";
import {
  AGENTMAIL_MAX_ALLOWED_SENDERS,
  AGENTMAIL_MAX_ATTEMPTS,
  AGENTMAIL_MAX_POLL_INTERVAL_MS,
  AGENTMAIL_MAX_PROMPT_BYTES,
  AGENTMAIL_MIN_POLL_INTERVAL_MS,
  AGENTMAIL_MIN_PROMPT_BYTES,
  normalizeAgentMailAllowedSenders,
  processedAgentMailEventTypes,
  validateAgentMailClassificationActions,
  validateAgentMailInboundConfig,
  validateAgentMailInboundBounds,
} from "../../../src/augments/agentMail/inbound-policy";

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
