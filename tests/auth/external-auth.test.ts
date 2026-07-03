import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  createExternalAuthAssertion,
  externalAuthClaimsToRouteContext,
  externalAuthClaimsToRoutePrincipal,
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

  test("rejects signed assertions with malformed delegated authorization claims", () => {
    const invalidClaims: readonly Record<string, unknown>[] = [
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
      email: "alice@example.com",
      verifiedAt: now - 1000,
      externalAuth: {
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
      email: "alice@example.com",
      verifiedAt: now - 1000,
      externalAuth: {
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
        email: "alice@example.com",
        verifiedAt: now - 1000,
        externalAuth: {
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

  test("supports app-provided visitor ids for account linking", () => {
    const claims: ExternalAuthClaims = {
      provider: "fake-provider",
      subject: "user_123",
      audience: "agent_zip",
      issuedAt: now,
      expiresAt: now + 300_000,
    };

    expect(externalAuthClaimsToRoutePrincipal(claims, { visitorId: "vis_existing" })).toEqual(
      expect.objectContaining({ visitorId: "vis_existing" }),
    );
    expect(
      externalAuthClaimsToRoutePrincipal(claims, {
        visitorId: (input) => `vis_${input.provider}_${input.subject}`,
      }),
    ).toEqual(expect.objectContaining({ visitorId: "vis_fake-provider_user_123" }));
  });
});

function signedAssertion(payload: Record<string, unknown>, secret = "app-server-secret"): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", `auggy-external-auth:${secret}`)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}
