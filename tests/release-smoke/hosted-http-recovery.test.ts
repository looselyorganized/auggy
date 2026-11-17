import { expect, test } from "bun:test";
import {
  assertHostedAuthHold,
  assertHostedExpiredAssertion,
  assertHostedHttpFixture,
} from "../../scripts/release-smoke/hosted-http-recovery";

const fixture = (ttl = 180) => ({
  augments: [
    {
      type: "webTransport",
      options: {
        externalAuth: {
          maxTtlSeconds: ttl,
          replayProtection: { enabled: true, dbPath: "./data/replay.sqlite" },
        },
        idempotency: { dbPath: "./data/runs.sqlite" },
      },
    },
  ],
});

test("HTTP timing assumptions are checked locally before allocating a service", () => {
  expect(() => assertHostedHttpFixture(fixture())).not.toThrow();
  for (const ttl of [20, 0, Infinity, 181])
    expect(() => assertHostedHttpFixture(fixture(ttl))).toThrow();
  expect(() => assertHostedHttpFixture({ augments: [] })).toThrow();
  const disabled = fixture();
  disabled.augments[0]!.options.externalAuth.replayProtection.enabled = false;
  expect(() => assertHostedHttpFixture(disabled)).toThrow();
});

test("generic 503s, malformed retries and unrelated 401s cannot pass recovery", () => {
  const held = { status: 503, retryAfter: "120", body: { error: "external_auth_unavailable" } };
  expect(() => assertHostedAuthHold(held)).not.toThrow();
  for (const change of [
    { body: { error: "busy" } },
    { status: 200 },
    { retryAfter: null },
    { retryAfter: "0" },
    { retryAfter: "1.5" },
    { retryAfter: "211" },
  ])
    expect(() => assertHostedAuthHold({ ...held, ...change })).toThrow();
  expect(() =>
    assertHostedExpiredAssertion({
      status: 401,
      retryAfter: null,
      body: { error: "unauthorized" },
    }),
  ).not.toThrow();
  expect(() =>
    assertHostedExpiredAssertion({
      status: 401,
      retryAfter: null,
      body: { error: "proxy_auth_required" },
    }),
  ).toThrow();
});
