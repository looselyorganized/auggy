import { expect, test } from "bun:test";
import {
  assertHostedAuthHold,
  assertHostedExpiredAssertion,
  assertHostedHttpFixture,
  observeHostedHttpHold,
  isFreshHostedHttpFixture,
} from "../../scripts/release-smoke/hosted-http-recovery";
import { createHostedHttpFixture } from "../../scripts/release-smoke/integration-fixtures/http-container/startup";
import { parseHostedHttpSnapshot } from "../../scripts/release-smoke/integration-hosted-http";
import { createSyntheticOrdersStore } from "../../examples/company-app/fixtures/synthetic-orders";
import { PROVIDER_FIXTURE_API_KEY } from "../../scripts/release-smoke/provider-fixture";

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

function savedCheckpoint() {
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
  return saved;
}

test("restored and restarted real fixtures require checkpoint initialization before hold/seal", async () => {
  const saved = savedCheckpoint();
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
      const waiting = {
        generationId,
        snapshot: await (await call({ operation: "snapshot" })).text(),
      };
      expect(isFreshHostedHttpFixture(waiting, generationId)).toBe(true);
      expect(isFreshHostedHttpFixture(null, generationId)).toBe(false);
      expect(() => isFreshHostedHttpFixture(waiting, "wrong-generation")).toThrow(
        "generation changed",
      );
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
          expect(() =>
            isFreshHostedHttpFixture(
              { generationId, snapshot: JSON.stringify(snapshot) },
              generationId,
            ),
          ).toThrow("not a fresh waiting process");
          return { status: 503, retryAfter: "120", body: { error: "external_auth_unavailable" } };
        },
      });
      const sealed = parseHostedHttpSnapshot(held.sealedSnapshot);
      expect(sealed.state).toBe("sealed");
      expect(sealed.checkpointSHA256).toBe(saved.sha256);
      expect(sealed.checkpoint.effects).toHaveLength(1);
      expect(sealed.domain.calls).toBe(0);
      expect(sealed.model.totalRequests).toBe(0);
      expect(
        isFreshHostedHttpFixture({ generationId, snapshot: held.sealedSnapshot }, generationId),
      ).toBe(false);
    } finally {
      await peer.stop();
    }
  }
});

test.each(["generation", "checkpoint"] as const)(
  "wrong %s prevents the hold probe",
  async (mismatch) => {
    const saved = savedCheckpoint();
    const peer = await createHostedHttpFixture({
      controlToken: "1".repeat(64),
      serviceToken: "2".repeat(64),
      expectedCheckpointSHA256: saved.sha256,
      ports: { model: 0, domain: 0, control: 0 },
    });
    let probed = false;
    try {
      await expect(
        observeHostedHttpHold({
          checkpoint:
            mismatch === "checkpoint" ? { ...saved.checkpoint, effects: [] } : saved.checkpoint,
          generationId: "expected",
          control: async () => {
            // Return a valid initialized peer with a different binding, not malformed evidence.
            const response = await fetch(`${peer.controlOrigin}/control`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-fixture-control": "1".repeat(64) },
              body: JSON.stringify({ operation: "initialize", checkpoint: saved.checkpoint }),
              signal: AbortSignal.timeout(2000),
            });
            expect(response.status).toBe(200);
            return {
              generationId: mismatch === "generation" ? "wrong" : "expected",
              snapshot: await response.text(),
            };
          },
          request: async () => {
            probed = true;
            throw Error("Must not probe a different fixture");
          },
        }),
      ).rejects.toThrow(mismatch === "generation" ? "generation changed" : "checkpoint changed");
      expect(probed).toBe(false);
    } finally {
      await peer.stop();
    }
  },
);

test.each(["model", "domain"] as const)("%s work prevents hold acceptance", async (work) => {
  const saved = savedCheckpoint();
  const peer = await createHostedHttpFixture({
    controlToken: "1".repeat(64),
    serviceToken: "2".repeat(64),
    expectedCheckpointSHA256: saved.sha256,
    ports: { model: 0, domain: 0, control: 0 },
  });
  const control = async (input: unknown) => {
    const response = await fetch(`${peer.controlOrigin}/control`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fixture-control": "1".repeat(64) },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(2000),
    });
    expect(response.status).toBe(200);
    return { generationId: "expected", snapshot: await response.text() };
  };
  try {
    await expect(
      observeHostedHttpHold({
        checkpoint: saved.checkpoint,
        generationId: "expected",
        control,
        request: async () => {
          if (work === "model") await control({ operation: "configure", scenario: "read-a" });
          const response = await fetch(
            work === "model"
              ? `${peer.modelOrigin}/v1/messages`
              : `${peer.domainOrigin}/authorization`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-api-key": PROVIDER_FIXTURE_API_KEY,
                authorization: `Bearer ${"2".repeat(64)}`,
              },
              body: JSON.stringify(
                work === "model"
                  ? {
                      model: "fixture-model",
                      stream: true,
                      tools: [{ name: "read_order" }],
                      messages: [{ role: "user", content: "read order" }],
                    }
                  : {
                      provider: "fixture-app",
                      userId: "support-agent",
                      orgId: "synthetic-company",
                      roles: [],
                    },
              ),
              signal: AbortSignal.timeout(5000),
            },
          );
          expect(response.status).toBe(200);
          await response.text();
          return { status: 503, retryAfter: "120", body: { error: "external_auth_unavailable" } };
        },
      }),
    ).rejects.toThrow("Held ingress performed work");
  } finally {
    await peer.stop();
  }
});
