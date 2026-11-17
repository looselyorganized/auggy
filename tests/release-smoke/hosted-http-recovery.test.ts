import { expect, test } from "bun:test";
import {
  assertHostedAuthHold,
  assertHostedExpiredAssertion,
  assertHostedHttpFixture,
  observeHostedHttpHold,
} from "../../scripts/release-smoke/hosted-http-recovery";
import { createHostedHttpFixture } from "../../scripts/release-smoke/integration-fixtures/http-container/startup";
import { parseHostedHttpSnapshot } from "../../scripts/release-smoke/integration-hosted-http";
import { createSyntheticOrdersStore } from "../../examples/company-app/fixtures/synthetic-orders";

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

test("restored and restarted real fixtures require checkpoint initialization before hold/seal", async () => {
  const store = createSyntheticOrdersStore(":memory:");
  let saved: ReturnType<typeof store.checkpoint>;
  try {
    const provider = "fixture-app",
      orgId = "synthetic-company",
      subject = "support-agent";
    store.simulateRefund(
      {
        provider,
        orgId,
        subject,
        ...store.authorizationFor({ provider, orgId, userId: subject, roles: [] }),
      },
      {
        orderId: "order-a",
        amountCents: 1250,
        reason: "hold-proof",
        operationId: "preserved-effect",
      },
    );
    saved = store.checkpoint();
  } finally {
    store.close();
  }
  for (const generationId of ["restored", "restarted"]) {
    const controlToken = "1".repeat(64);
    const peer = await createHostedHttpFixture({
      controlToken,
      serviceToken: "2".repeat(64),
      expectedCheckpointSHA256: saved.sha256,
      ports: { model: 0, domain: 0, control: 0 },
    });
    const call = (input: unknown) =>
      fetch(`${peer.controlOrigin}/control`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-fixture-control": controlToken },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(2000),
      });
    try {
      // Reproduce the hosted failure before using the corrected runner operation.
      const premature = await call({ operation: "seal" });
      expect(premature.status).toBe(400);
      expect(await premature.json()).toEqual({ error: "http-fixture-control-rejected" });
      const held = await observeHostedHttpHold({
        generationId,
        checkpoint: saved.checkpoint,
        control: async (input) => {
          const response = await call(input);
          expect(response.status).toBe(200);
          return { generationId, snapshot: await response.text() };
        },
        request: async () => {
          const current = await call({ operation: "snapshot" });
          const snapshot = parseHostedHttpSnapshot(await current.text());
          expect(snapshot.state).toBe("active");
          expect(snapshot.initialEffects).toBe(1);
          return { status: 503, retryAfter: "120", body: { error: "external_auth_unavailable" } };
        },
      });
      const sealed = parseHostedHttpSnapshot(held.sealedSnapshot);
      expect(sealed.state).toBe("sealed");
      expect(sealed.checkpointSHA256).toBe(saved.sha256);
      expect(sealed.checkpoint.effects).toHaveLength(1);
      expect(sealed.domain.calls).toBe(0);
      expect(sealed.model.totalRequests).toBe(0);
    } finally {
      await peer.stop();
    }
  }
});
