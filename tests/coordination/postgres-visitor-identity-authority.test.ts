import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import {
  PostgresVisitorIdentityAuthority,
  type PostgresVisitorIdentityAuthorityOptions,
} from "../../src/coordination/visitor-identity-authority";

const url = process.env.AUGGY_TEST_POSTGRES_URL;
const postgresTest = url ? test : test.skip;
const namespaces = new Set<string>();

const policy = {
  maxVerificationRequests: 20,
  maxVisitors: 20,
  maxExternalAssertions: 20,
  verificationTokenTtlMs: 900_000,
  verificationRequestRetentionMs: 60_000,
  reverifyAfterMs: 86_400_000,
  maxExternalAssertionTtlMs: 300_000,
  rateLimit: { perHour: 10, perDay: 10, minIntervalMs: 0 },
} as const;

function namespace(): string {
  const value = `visitor-authority-${crypto.randomUUID()}`;
  namespaces.add(value);
  return value;
}

function options(
  authorityNamespace: string,
  audience = "visitor-authority-agent",
  overrides: Partial<PostgresVisitorIdentityAuthorityOptions["policy"]> = {},
): PostgresVisitorIdentityAuthorityOptions {
  return {
    url: url!,
    namespace: authorityNamespace,
    audience,
    policy: {
      ...policy,
      ...overrides,
      rateLimit: { ...policy.rateLimit, ...overrides.rateLimit },
    },
  };
}

function request(
  requestId: string,
  token: string,
  overrides: Partial<
    Parameters<PostgresVisitorIdentityAuthority["issueVerificationRequest"]>[0]
  > = {},
) {
  return {
    requestId,
    bindingHash: new Bun.CryptoHasher("sha256").update(`binding:${requestId}`).digest("hex"),
    token,
    email: "visitor@example.test",
    peerId: "anon_session_11111111-1111-4111-8111-111111111111",
    threadId: "web_thread_exact_authoritative_thread",
    ...overrides,
  };
}

afterEach(async () => {
  if (!url || namespaces.size === 0) return;
  const sql = new SQL(url);
  try {
    for (const value of namespaces) {
      await sql.unsafe(
        "DELETE FROM public.auggy_coordination_external_assertions WHERE namespace = $1",
        [value],
      );
      await sql.unsafe(
        "DELETE FROM public.auggy_coordination_visitor_requests WHERE namespace = $1",
        [value],
      );
      await sql.unsafe("DELETE FROM public.auggy_coordination_visitors WHERE namespace = $1", [
        value,
      ]);
      await sql.unsafe(
        "DELETE FROM public.auggy_coordination_visitor_authorities WHERE namespace = $1",
        [value],
      );
    }
  } finally {
    namespaces.clear();
    await sql.close();
  }
});

describe("PostgresVisitorIdentityAuthority", () => {
  postgresTest("atomically consumes one verification token across two replicas", async () => {
    const scope = namespace();
    const first = new PostgresVisitorIdentityAuthority(options(scope));
    const second = new PostgresVisitorIdentityAuthority(options(scope));
    await first.migrate();
    expect(await first.register()).toEqual({ status: "registered" });
    expect(await second.register()).toEqual({ status: "registered" });

    const token = crypto.randomUUID();
    expect(await first.issueVerificationRequest(request("request-1", token))).toMatchObject({
      status: "issued",
    });
    const results = await Promise.all([first.verify({ token }), second.verify({ token })]);
    expect(results.filter((result) => result.status === "verified")).toHaveLength(1);
    expect(results.filter((result) => result.status === "consumed")).toHaveLength(1);

    const verified = results.find((result) => result.status === "verified");
    if (verified?.status !== "verified") throw new Error("verification did not win");
    expect(await second.resolveVisitor(verified.visitorId, verified.identityVersion)).toMatchObject(
      {
        status: "active",
        visitorId: verified.visitorId,
        identityVersion: 1,
      },
    );
    expect(await second.resolveVisitor(verified.visitorId, verified.identityVersion, 0)).toEqual({
      status: "expired",
    });
    expect(
      await second.canPromote({
        visitorId: verified.visitorId,
        identityVersion: verified.identityVersion,
        peerId: request("request-1", token).peerId,
        threadId: request("request-1", token).threadId,
      }),
    ).toEqual({ status: "allowed" });
    expect(
      await second.canPromote({
        visitorId: verified.visitorId,
        identityVersion: verified.identityVersion,
        peerId: request("request-1", token).peerId,
        threadId: "web_thread_sibling",
      }),
    ).toEqual({ status: "denied" });

    await first.close();
    await second.close();
  });

  postgresTest(
    "fails identity reads and promotion closed on immutable policy disagreement",
    async () => {
      const scope = namespace();
      const owner = new PostgresVisitorIdentityAuthority(options(scope));
      const mismatched = new PostgresVisitorIdentityAuthority(
        options(scope, undefined, { reverifyAfterMs: policy.reverifyAfterMs + 1 }),
      );
      await owner.migrate();
      expect(await owner.register()).toEqual({ status: "registered" });
      expect(await mismatched.register()).toEqual({ status: "conflict" });
      const token = crypto.randomUUID();
      await owner.issueVerificationRequest(request("policy-owner", token));
      const verified = await owner.verify({ token });
      if (verified.status !== "verified") throw new Error("verification failed");

      expect(await mismatched.resolveVisitor(verified.visitorId, verified.identityVersion)).toEqual(
        {
          status: "unavailable",
        },
      );
      expect(
        await mismatched.canPromote({
          visitorId: verified.visitorId,
          identityVersion: verified.identityVersion,
          peerId: verified.priorPeerId,
          threadId: verified.priorThreadId,
        }),
      ).toEqual({ status: "unavailable" });

      await owner.close();
      await mismatched.close();
    },
  );

  postgresTest(
    "makes revocation win over delayed verification and rotates only newer evidence",
    async () => {
      const scope = namespace();
      const first = new PostgresVisitorIdentityAuthority(options(scope));
      const second = new PostgresVisitorIdentityAuthority(options(scope));
      await first.migrate();
      await first.register();
      await second.register();

      const initialToken = crypto.randomUUID();
      await first.issueVerificationRequest(request("initial", initialToken));
      const initial = await first.verify({ token: initialToken });
      expect(initial.status).toBe("verified");

      const delayedToken = crypto.randomUUID();
      await first.issueVerificationRequest(request("delayed", delayedToken));
      expect(await second.revokeByEmail("visitor@example.test", "operator-revoked")).toMatchObject({
        status: "revoked",
        visitorId: initial.status === "verified" ? initial.visitorId : "must-not-match",
      });
      expect(await first.verify({ token: delayedToken })).toMatchObject({ status: "revoked" });
      if (initial.status !== "verified") throw new Error("initial verification failed");
      expect(await second.resolveVisitor(initial.visitorId, 1)).toEqual({ status: "revoked" });

      const freshToken = crypto.randomUUID();
      await second.issueVerificationRequest(request("fresh", freshToken));
      const rotated = await first.verify({ token: freshToken });
      expect(rotated).toMatchObject({
        status: "verified",
        identityVersion: 2,
      });
      expect(await second.resolveVisitor(initial.visitorId, 1)).toEqual({ status: "revoked" });
      if (rotated.status !== "verified") throw new Error("rotation failed");
      expect(rotated.visitorId).not.toBe(initial.visitorId);
      expect(await second.resolveVisitor(rotated.visitorId, 2)).toMatchObject({ status: "active" });

      await first.close();
      await second.close();
    },
  );

  postgresTest("renews an active identity without changing its visitor id or version", async () => {
    const scope = namespace();
    const authority = new PostgresVisitorIdentityAuthority(options(scope));
    await authority.migrate();
    await authority.register();

    const initialToken = crypto.randomUUID();
    await authority.issueVerificationRequest(request("renew-initial", initialToken));
    const initial = await authority.verify({ token: initialToken });
    if (initial.status !== "verified") throw new Error("initial verification failed");

    const renewalToken = crypto.randomUUID();
    await authority.issueVerificationRequest(request("renew-active", renewalToken));
    const renewed = await authority.verify({ token: renewalToken });
    expect(renewed).toMatchObject({
      status: "verified",
      visitorId: initial.visitorId,
      identityVersion: initial.identityVersion,
    });
    if (renewed.status !== "verified") throw new Error("renewal failed");
    expect(renewed.reverifyDueAt).toBeGreaterThan(initial.reverifyDueAt);
    expect(
      await authority.resolveVisitor(initial.visitorId, initial.identityVersion),
    ).toMatchObject({
      status: "active",
      reverifyDueAt: renewed.reverifyDueAt,
    });

    await authority.close();
  });

  postgresTest(
    "expires identity and promotion authority at the database reverify boundary",
    async () => {
      const scope = namespace();
      const authority = new PostgresVisitorIdentityAuthority(options(scope));
      await authority.migrate();
      await authority.register();
      const token = crypto.randomUUID();
      await authority.issueVerificationRequest(request("reverify-boundary", token));
      const verified = await authority.verify({ token });
      if (verified.status !== "verified") throw new Error("verification failed");

      const sql = new SQL(url!);
      try {
        await sql.unsafe(
          "UPDATE public.auggy_coordination_visitors SET verified_at = clock_timestamp() - INTERVAL '2 seconds', reverify_due_at = clock_timestamp() - INTERVAL '1 second' WHERE namespace = $1 AND audience = $2 AND visitor_id = $3",
          [scope, "visitor-authority-agent", verified.visitorId],
        );
        expect(
          await authority.resolveVisitor(
            verified.visitorId,
            verified.identityVersion,
            verified.authoritativeNow + policy.maxExternalAssertionTtlMs,
          ),
        ).toEqual({ status: "expired" });
        expect(
          await authority.canPromote({
            visitorId: verified.visitorId,
            identityVersion: verified.identityVersion,
            peerId: verified.priorPeerId,
            threadId: verified.priorThreadId,
          }),
        ).toEqual({ status: "denied" });
      } finally {
        await sql.close();
        await authority.close();
      }
    },
  );

  postgresTest("shares canonical request rate evidence and rejects altered replays", async () => {
    const scope = namespace();
    const first = new PostgresVisitorIdentityAuthority(
      options(scope, "rate-agent", {
        rateLimit: { perHour: 1, perDay: 1, minIntervalMs: 0 },
      }),
    );
    const second = new PostgresVisitorIdentityAuthority(
      options(scope, "rate-agent", {
        rateLimit: { perHour: 1, perDay: 1, minIntervalMs: 0 },
      }),
    );
    await first.migrate();
    await first.register();
    await second.register();

    const original = request("canonical-request", crypto.randomUUID());
    expect(await first.issueVerificationRequest(original)).toMatchObject({ status: "issued" });
    expect(await second.issueVerificationRequest(original)).toMatchObject({ status: "replayed" });
    expect(
      await second.issueVerificationRequest({ ...original, email: "changed@example.test" }),
    ).toEqual({ status: "conflict" });
    expect(
      await second.issueVerificationRequest(request("second-request", crypto.randomUUID())),
    ).toMatchObject({ status: "rate-limited" });

    await first.close();
    await second.close();
  });

  postgresTest("binds external assertion replay to audience and canonical execution", async () => {
    const scope = namespace();
    const first = new PostgresVisitorIdentityAuthority(options(scope, "audience-a"));
    const second = new PostgresVisitorIdentityAuthority(options(scope, "audience-a"));
    const otherAudience = new PostgresVisitorIdentityAuthority(options(scope, "audience-b"));
    await first.migrate();
    await first.register();
    await second.register();
    await otherAudience.register();

    const claim = {
      provider: "clerk",
      keyId: "current",
      jti: "assertion-jti",
      requestId: "run-id",
      bindingHash: "a".repeat(64),
      expiresAt: Date.now() + 60_000,
    };
    expect(await first.claimExternalAssertion(claim)).toEqual({ status: "claimed" });
    expect(await second.claimExternalAssertion(claim)).toEqual({ status: "replayed" });
    expect(await second.claimExternalAssertion({ ...claim, bindingHash: "b".repeat(64) })).toEqual({
      status: "conflict",
    });
    expect(await otherAudience.claimExternalAssertion(claim)).toEqual({ status: "claimed" });
    expect(
      await first.claimExternalAssertion({ ...claim, jti: "expired-jti", expiresAt: 0 }),
    ).toEqual({ status: "expired" });
    expect(
      await first.claimExternalAssertion({
        ...claim,
        jti: "overlong-jti",
        expiresAt: Date.now() + policy.maxExternalAssertionTtlMs + 60_000,
      }),
    ).toEqual({ status: "invalid" });

    await first.close();
    await second.close();
    await otherAudience.close();
  });

  postgresTest("persists identity and replay authority across process-handle restart", async () => {
    const scope = namespace();
    const first = new PostgresVisitorIdentityAuthority(options(scope, "restart-agent"));
    await first.migrate();
    await first.register();
    const token = crypto.randomUUID();
    await first.issueVerificationRequest(request("restart-request", token));
    const verified = await first.verify({ token });
    expect(verified.status).toBe("verified");
    await first.claimExternalAssertion({
      provider: "auth0",
      keyId: null,
      jti: "restart-jti",
      requestId: "restart-run",
      bindingHash: "c".repeat(64),
      expiresAt: Date.now() + 60_000,
    });
    await first.close();

    const restarted = new PostgresVisitorIdentityAuthority(options(scope, "restart-agent"));
    await restarted.register();
    if (verified.status !== "verified") throw new Error("restart verification failed");
    expect(await restarted.resolveVisitor(verified.visitorId, 1)).toMatchObject({
      status: "active",
    });
    expect(
      await restarted.claimExternalAssertion({
        provider: "auth0",
        keyId: null,
        jti: "restart-jti",
        requestId: "changed-run",
        bindingHash: "d".repeat(64),
        expiresAt: Date.now() + 60_000,
      }),
    ).toEqual({ status: "conflict" });
    await restarted.close();
  });

  postgresTest("stores only one-way verification and assertion credentials", async () => {
    const scope = namespace();
    const authority = new PostgresVisitorIdentityAuthority(options(scope, "credential-storage"));
    await authority.migrate();
    await authority.register();

    const token = `raw-verification-${crypto.randomUUID()}`;
    const jti = `raw-assertion-${crypto.randomUUID()}`;
    await authority.issueVerificationRequest(request("credential-request", token));
    await authority.claimExternalAssertion({
      provider: "test",
      keyId: "current",
      jti,
      requestId: "credential-run",
      bindingHash: "e".repeat(64),
      expiresAt: Date.now() + 60_000,
    });

    const sql = new SQL(url!);
    try {
      const rows = await sql.unsafe<Record<string, unknown>>(
        "SELECT (SELECT row_to_json(request_row)::text FROM (SELECT * FROM public.auggy_coordination_visitor_requests WHERE namespace = $1 AND audience = $2) request_row) AS request_body, (SELECT row_to_json(assertion_row)::text FROM (SELECT * FROM public.auggy_coordination_external_assertions WHERE namespace = $1 AND audience = $2) assertion_row) AS assertion_body",
        [scope, "credential-storage"],
      );
      const stored = JSON.stringify(rows[0]);
      expect(stored).not.toContain(token);
      expect(stored).not.toContain(jti);
    } finally {
      await sql.close();
      await authority.close();
    }
  });
});
