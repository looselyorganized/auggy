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
