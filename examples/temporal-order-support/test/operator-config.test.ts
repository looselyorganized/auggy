import { describe, expect, it } from "bun:test";

import { MAX_BEARER_TOKEN_BYTES, MAX_SSE_BYTES, MAX_SSE_EVENTS } from "../src/auggy-client.ts";
import { readOperatorConfig } from "../src/operator-config.ts";

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TEMPORAL_TASK_QUEUE: "auggy-order-support",
    AUGGY_TARGET: "https://auggy.example.com",
    AUGGY_BEARER_TOKEN: "test-only-secret",
    ...overrides,
  };
}

describe("Temporal example operator configuration", () => {
  it("uses bounded defaults", () => {
    const config = readOperatorConfig(env());
    expect(config.auggy.maxSseBytes).toBe(1_048_576);
    expect(config.auggy.maxSseEvents).toBe(10_000);
  });

  it.each([
    ["AUGGY_MAX_SSE_BYTES", String(MAX_SSE_BYTES + 1)],
    ["AUGGY_MAX_SSE_EVENTS", String(MAX_SSE_EVENTS + 1)],
    ["AUGGY_MAX_SSE_BYTES", "0"],
    ["AUGGY_MAX_SSE_EVENTS", "not-a-number"],
  ])("rejects unsafe %s=%s", (name, value) => {
    expect(() => readOperatorConfig(env({ [name]: value }))).toThrow();
  });

  it("rejects oversized or header-unsafe bearer credentials", () => {
    expect(() =>
      readOperatorConfig(env({ AUGGY_BEARER_TOKEN: "x".repeat(MAX_BEARER_TOKEN_BYTES + 1) })),
    ).toThrow();
    expect(() => readOperatorConfig(env({ AUGGY_BEARER_TOKEN: "first\nsecond" }))).toThrow();
  });
});
