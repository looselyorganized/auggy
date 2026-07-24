import { createHash, createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  createExternalAuthAssertion,
  createInMemoryExternalAuthReplayStore,
  externalAuthClaimsToRouteContext,
  externalAuthClaimsToRoutePrincipal,
  externalMappedVisitorId,
  externalSubjectVisitorId,
  verifyExternalAuthAssertion,
  type ExternalAuthClaims,
} from "../../src/auth/external-auth";

const now = 1_800_000_000_000;

describe("external auth assertions", () => {
  test("creates and verifies a provider-agnostic app-server assertion", () => {
    const assertion = createExternalAuthAssertion({
      secret: "app-server-secret",
      audience: "agent_zip",
      provider: "fake-provider",
      subject: "user_123",
      now,
      ttlSeconds: 300,
      email: "alice@example.com",
      emailVerified: true,
      verifiedAt: now - 1000,
      orgId: "org_123",
      roles: ["customer", "member"],
      scopes: ["orders.read", "appointments.book"],
      grants: [
        {
          action: "refund.issue",
          resource: "order_123",
          constraints: { maxAmountCents: 5000, currencies: ["USD", "CAD"] },
        },
      ],
      authzVersion: "42",
      jti: "assertion_123",
    });

    const result = verifyExternalAuthAssertion(assertion, {
      secret: "app-server-secret",
      audience: "agent_zip",
      now: now + 1000,
      allowedProviders: ["fake-provider"],
      maxTtlSeconds: 300,
    });

    expect(result).toEqual({
      ok: true,
      claims: {
        provider: "fake-provider",
        subject: "user_123",
        audience: "agent_zip",
        issuedAt: now,
        expiresAt: now + 300_000,
        email: "alice@example.com",
        emailVerified: true,
        verifiedAt: now - 1000,
        orgId: "org_123",
        roles: ["customer", "member"],
        scopes: ["orders.read", "appointments.book"],
        grants: [
          {
            action: "refund.issue",
            resource: "order_123",
            constraints: { maxAmountCents: 5000, currencies: ["USD", "CAD"] },
          },
        ],
        authzVersion: "42",
        jti: "assertion_123",
      },
    });
  });

  test("rejects malformed, tampered, expired, and wrong-audience assertions", () => {
    const assertion = createExternalAuthAssertion({
      secret: "app-server-secret",
      audience: "agent_zip",
      provider: "fake-provider",
      subject: "user_123",
      now,
      ttlSeconds: 60,
    });
    const tampered = assertion.slice(0, -1) + (assertion.endsWith("a") ? "b" : "a");

    expect(
      verifyExternalAuthAssertion("not-a-token", {
        secret: "app-server-secret",
        audience: "agent_zip",
        now,
      }),
    ).toEqual({ ok: false, reason: "malformed" });
    expect(
      verifyExternalAuthAssertion(tampered, {
        secret: "app-server-secret",
        audience: "agent_zip",
        now,
      }),
    ).toEqual({ ok: false, reason: "invalid-signature" });
    expect(
      verifyExternalAuthAssertion(assertion, {
        secret: "app-server-secret",
        audience: "agent_zip",
        now: now + 61_000,
      }),
    ).toEqual({ ok: false, reason: "expired" });
    expect(
      verifyExternalAuthAssertion(assertion, {
        secret: "app-server-secret",
        audience: "other_agent",
        now,
      }),
    ).toEqual({ ok: false, reason: "audience-mismatch" });
  });

  test("in-memory replay store accepts each jti once until assertion expiry", () => {
    const store = createInMemoryExternalAuthReplayStore();

    expect(store.consume("jti_123", now + 1000, now)).toBe(true);
    expect(store.consume("jti_123", now + 1000, now + 500)).toBe(false);
    expect(store.consume("jti_123", now + 1000, now + 1000)).toBe(false);
    expect(store.consume("jti_123", now + 2000, now + 1001)).toBe(true);
  });

  test("rejects disallowed providers and overly long assertion TTLs", () => {
    const assertion = createExternalAuthAssertion({
      secret: "app-server-secret",
      audience: "agent_zip",
      provider: "fake-provider",
      subject: "user_123",
      now,
      ttlSeconds: 600,
    });

    expect(
      verifyExternalAuthAssertion(assertion, {
        secret: "app-server-secret",
        audience: "agent_zip",
        now,
        allowedProviders: ["other-provider"],
      }),
    ).toEqual({ ok: false, reason: "provider-not-allowed" });
    expect(
      verifyExternalAuthAssertion(assertion, {
        secret: "app-server-secret",
        audience: "agent_zip",
        now,
        maxTtlSeconds: 300,
      }),
    ).toEqual({ ok: false, reason: "ttl-too-long" });
  });

  test("fails closed on malformed restrictive verification policies", () => {
    const assertion = createExternalAuthAssertion({
      secret: "app-server-secret",
      audience: "agent_zip",
      provider: "evil",
      subject: "user_123",
      now,
      ttlSeconds: 24 * 60 * 60,
    });
    for (const allowedProviders of ["", "supabase-evil", []] as unknown[]) {
      expect(
        verifyExternalAuthAssertion(assertion, {
          secret: "app-server-secret",
          audience: "agent_zip",
          now,
          allowedProviders: allowedProviders as readonly string[],
        }),
      ).toEqual({ ok: false, reason: "provider-not-allowed" });
    }
    for (const maxTtlSeconds of ["not-a-number", Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      expect(
        verifyExternalAuthAssertion(assertion, {
          secret: "app-server-secret",
          audience: "agent_zip",
          now,
          maxTtlSeconds: maxTtlSeconds as number,
        }),
      ).toEqual({ ok: false, reason: "ttl-too-long" });
    }
  });

  test("rejects non-finite and fractional assertion TTLs when minting", () => {
    for (const ttlSeconds of [Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      expect(() =>
        createExternalAuthAssertion({
          secret: "app-server-secret",
          audience: "agent_zip",
          provider: "fake-provider",
          subject: "user_123",
          now,
          ttlSeconds,
        }),
      ).toThrow(/positive integer/);
    }
  });

  test("rejects empty assertion key ids", () => {
    expect(() =>
      createExternalAuthAssertion({
        secret: "current-secret",
        keyId: "",
        audience: "agent_zip",
        provider: "fake-provider",
        subject: "user_123",
        now,
        ttlSeconds: 60,
      }),
    ).toThrow("external auth assertion keyId must be non-empty when provided");
    expect(() =>
      createExternalAuthAssertion({
        secret: "current-secret",
        keyId: " ",
        audience: "agent_zip",
        provider: "fake-provider",
        subject: "user_123",
        now,
        ttlSeconds: 60,
      }),
    ).toThrow("external auth assertion keyId must be non-empty when provided");
  });

  test("verifies key-id assertions against a rotation keyring", () => {
    const previousAssertion = createExternalAuthAssertion({
      secret: "previous-secret",
      keyId: "2026-06",
      audience: "agent_zip",
      provider: "fake-provider",
      subject: "user_123",
      now,
      ttlSeconds: 60,
    });
    const currentAssertion = createExternalAuthAssertion({
      secret: "current-secret",
      keyId: "2026-07",
      audience: "agent_zip",
      provider: "fake-provider",
      subject: "user_123",
      now,
      ttlSeconds: 60,
    });

    expect(
      verifyExternalAuthAssertion(previousAssertion, {
        audience: "agent_zip",
        now,
        secrets: [
          { keyId: "2026-07", secret: "current-secret" },
          { keyId: "2026-06", secret: "previous-secret" },
        ],
      }),
    ).toMatchObject({
      ok: true,
      claims: {
        keyId: "2026-06",
        provider: "fake-provider",
        subject: "user_123",
      },
    });
    expect(
      verifyExternalAuthAssertion(currentAssertion, {
        audience: "agent_zip",
        now,
        secrets: [
          { keyId: "2026-07", secret: "current-secret" },
          { keyId: "2026-06", secret: "previous-secret" },
        ],
      }),
    ).toMatchObject({
      ok: true,
      claims: {
        keyId: "2026-07",
        provider: "fake-provider",
        subject: "user_123",
      },
    });
  });

  test("verifies key-id assertions against the labelled current secret", () => {
    const assertion = createExternalAuthAssertion({
      secret: "current-secret",
      keyId: "2026-07",
      audience: "agent_zip",
      provider: "fake-provider",
      subject: "user_123",
      now,
      ttlSeconds: 60,
    });

    expect(
      verifyExternalAuthAssertion(assertion, {
        secret: "current-secret",
        keyId: "2026-07",
        audience: "agent_zip",
        now,
      }),
    ).toMatchObject({
      ok: true,
      claims: {
        keyId: "2026-07",
        provider: "fake-provider",
        subject: "user_123",
      },
    });
  });

  test("rejects unknown key ids before trying unrelated rotation secrets", () => {
    const assertion = createExternalAuthAssertion({
      secret: "old-secret",
      keyId: "2026-05",
      audience: "agent_zip",
      provider: "fake-provider",
      subject: "user_123",
      now,
      ttlSeconds: 60,
    });

    expect(
      verifyExternalAuthAssertion(assertion, {
        audience: "agent_zip",
        now,
        secrets: [
          { keyId: "2026-07", secret: "current-secret" },
          { keyId: "2026-06", secret: "previous-secret" },
        ],
      }),
    ).toEqual({ ok: false, reason: "key-not-found" });
  });

  test("keeps existing no-key-id assertions compatible with a rotation keyring", () => {
    const assertion = createExternalAuthAssertion({
      secret: "legacy-secret",
      audience: "agent_zip",
      provider: "fake-provider",
      subject: "user_123",
      now,
      ttlSeconds: 60,
    });

    expect(
      verifyExternalAuthAssertion(assertion, {
        audience: "agent_zip",
        now,
        secrets: [
          { keyId: "2026-07", secret: "current-secret" },
          { keyId: "legacy", secret: "legacy-secret" },
        ],
      }),
    ).toMatchObject({
      ok: true,
      claims: {
        provider: "fake-provider",
        subject: "user_123",
      },
    });
  });

  test("rejects signed assertions with malformed delegated authorization claims", () => {
    const invalidClaims: readonly Record<string, unknown>[] = [
      { kid: "" },
      { kid: " " },
      { scopes: ["orders.read", 42] },
      { scopes: [""] },
      { grants: [null] },
      { grants: [{ action: "", resource: "order_123" }] },
      { grants: [{ action: "refund.issue", resource: "" }] },
      { grants: [{ action: "refund.issue", resource: 123 }] },
      { grants: [{ action: "refund.issue", constraints: "broad" }] },
      { authzVersion: "" },
      { jti: "" },
    ];

    for (const claims of invalidClaims) {
      const assertion = signedAssertion({
        typ: "auggy.external-auth.v1",
        aud: "agent_zip",
        provider: "fake-provider",
        sub: "user_123",
        iat: now,
        exp: now + 60_000,
        ...claims,
      });

      expect(
        verifyExternalAuthAssertion(assertion, {
          secret: "app-server-secret",
          audience: "agent_zip",
          now,
        }),
      ).toEqual({ ok: false, reason: "invalid-payload" });
    }
  });

  test("maps verified external claims to a recognized public route principal", () => {
    const claims: ExternalAuthClaims = {
      keyId: "2026-07",
      provider: "fake-provider",
      subject: "user_123",
      audience: "agent_zip",
      issuedAt: now,
      expiresAt: now + 300_000,
      email: "alice@example.com",
      emailVerified: true,
      verifiedAt: now - 1000,
      orgId: "org_123",
      roles: ["customer", "admin"],
      scopes: ["orders.read"],
      grants: [
        {
          action: "orders.refund",
          resource: "order_123",
          constraints: { maxAmountCents: 5000 },
        },
      ],
      authzVersion: "42",
      jti: "assertion_123",
    };

    expect(externalAuthClaimsToRoutePrincipal(claims)).toEqual({
      kind: "visitor",
      trustLevel: "public",
      publicSubstate: "recognized",
      visitorId: externalSubjectVisitorId(claims),
      agentId: "agent_zip",
      orgId: "org_123",
      email: "alice@example.com",
      verifiedAt: now - 1000,
      externalAuth: {
        keyId: "2026-07",
        provider: "fake-provider",
        subject: "user_123",
        orgId: "org_123",
        roles: ["customer", "admin"],
        scopes: ["orders.read"],
        grants: [
          {
            action: "orders.refund",
            resource: "order_123",
            constraints: { maxAmountCents: 5000 },
          },
        ],
        authzVersion: "42",
        jti: "assertion_123",
      },
    });
    expect(externalAuthClaimsToRouteContext(claims)).toEqual({
      mode: "visitor",
      state: "recognized",
      visitorId: externalSubjectVisitorId(claims),
      agentId: "agent_zip",
      issuedAt: now,
      expiresAt: now + 300_000,
      orgId: "org_123",
      email: "alice@example.com",
      verifiedAt: now - 1000,
      externalAuth: {
        keyId: "2026-07",
        provider: "fake-provider",
        subject: "user_123",
        orgId: "org_123",
        roles: ["customer", "admin"],
        scopes: ["orders.read"],
        grants: [
          {
            action: "orders.refund",
            resource: "order_123",
            constraints: { maxAmountCents: 5000 },
          },
        ],
        authzVersion: "42",
        jti: "assertion_123",
      },
      principal: {
        kind: "visitor",
        trustLevel: "public",
        publicSubstate: "recognized",
        visitorId: externalSubjectVisitorId(claims),
        agentId: "agent_zip",
        orgId: "org_123",
        email: "alice@example.com",
        verifiedAt: now - 1000,
        externalAuth: {
          keyId: "2026-07",
          provider: "fake-provider",
          subject: "user_123",
          orgId: "org_123",
          roles: ["customer", "admin"],
          scopes: ["orders.read"],
          grants: [
            {
              action: "orders.refund",
              resource: "order_123",
              constraints: { maxAmountCents: 5000 },
            },
          ],
          authzVersion: "42",
          jti: "assertion_123",
        },
      },
    });
  });

  test("does not expose unverified email unless explicitly requested", () => {
    const claims: ExternalAuthClaims = {
      provider: "fake-provider",
      subject: "user_123",
      audience: "agent_zip",
      issuedAt: now,
      expiresAt: now + 300_000,
      email: "alice@example.com",
      emailVerified: false,
    };

    expect(externalAuthClaimsToRoutePrincipal(claims)).not.toHaveProperty("email");
    expect(externalAuthClaimsToRoutePrincipal(claims, { includeUnverifiedEmail: true })).toEqual(
      expect.objectContaining({ email: "alice@example.com" }),
    );
  });

  test("binds app-provided visitor-id namespaces to the authenticated subject", () => {
    const claims: ExternalAuthClaims = {
      provider: "fake-provider",
      subject: "user_123",
      audience: "agent_zip",
      issuedAt: now,
      expiresAt: now + 300_000,
    };

    expect(externalAuthClaimsToRoutePrincipal(claims, { visitorId: "vis_existing" })).toEqual(
      expect.objectContaining({
        visitorId: externalMappedVisitorId(claims, "vis_existing"),
      }),
    );
    expect(
      externalAuthClaimsToRoutePrincipal(claims, {
        visitorId: (input) => `vis_${input.provider}_${input.subject}`,
      }),
    ).toEqual(
      expect.objectContaining({
        visitorId: externalMappedVisitorId(claims, "vis_fake-provider_user_123"),
      }),
    );
  });

  test("does not let a constant visitor-id mapper collapse distinct external subjects", () => {
    const first: ExternalAuthClaims = {
      provider: "fake-provider",
      subject: "user_a",
      audience: "agent_zip",
      issuedAt: now,
      expiresAt: now + 300_000,
    };
    const second = { ...first, subject: "user_b" };
    const options = { visitorId: () => "vis_shared_account" };

    expect(externalAuthClaimsToRoutePrincipal(first, options).visitorId).not.toBe(
      externalAuthClaimsToRoutePrincipal(second, options).visitorId,
    );
  });

  test("partitions default visitor identities by verified organization", () => {
    const base = {
      provider: "fake-provider",
      subject: "user_123",
    };
    expect(externalSubjectVisitorId({ ...base, orgId: "org_a" })).not.toBe(
      externalSubjectVisitorId({ ...base, orgId: "org_b" }),
    );
    expect(externalSubjectVisitorId(base)).not.toBe(
      externalSubjectVisitorId({ ...base, orgId: "org_a" }),
    );
  });

  test("preserves legacy no-organization visitor ids and rejects ambiguous control characters", () => {
    const base = {
      provider: "fake-provider",
      subject: "user_123",
    };
    const legacyHash = createHash("sha256")
      .update(base.provider)
      .update("\0")
      .update(base.subject)
      .digest("base64url")
      .slice(0, 32);
    expect(externalSubjectVisitorId(base)).toBe(`vis_ext_${legacyHash}`);
    expect(() => externalSubjectVisitorId({ provider: "fake\0provider", subject: "user" })).toThrow(
      /control characters/,
    );
    expect(
      verifyExternalAuthAssertion(
        signedAssertion({
          typ: "auggy.external-auth.v1",
          aud: "agent_zip",
          provider: "fake-provider",
          sub: "user\0other",
          iat: now,
          exp: now + 60_000,
        }),
        {
          secret: "app-server-secret",
          audience: "agent_zip",
          now,
        },
      ),
    ).toEqual({ ok: false, reason: "invalid-payload" });
  });
});

function signedAssertion(payload: Record<string, unknown>, secret = "app-server-secret"): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", `auggy-external-auth:${secret}`)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}
