import { describe, expect, it } from "bun:test";

import {
  isVisitorIdentityAuthorizationError,
  resolveConsoleVisitorIdentity,
} from "./visitor-identity-api";

describe("resolveConsoleVisitorIdentity", () => {
  it("returns only a strictly validated verified identity", async () => {
    let submitted: Record<string, unknown> | undefined;
    const identity = await resolveConsoleVisitorIdentity("token", "csrf", {
      locationHref: "http://localhost:8080/console/chat",
      fetchImpl: async (_input, init) => {
        submitted = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({
          identity: {
            status: "verified",
            email: "visitor@example.com",
            expiresAt: 1_800_000_000_000,
          },
        });
      },
    });

    expect(submitted).toEqual({ csrf: "csrf", visitorToken: "token" });
    expect(identity).toEqual({
      status: "verified",
      email: "visitor@example.com",
      expiresAt: 1_800_000_000_000,
    });
  });

  it("accepts a stable invalid identity without treating it as verified", async () => {
    const identity = await resolveConsoleVisitorIdentity("token", "csrf", {
      locationHref: "http://localhost:8080/console/chat",
      fetchImpl: async () => json({ identity: { status: "invalid", error: "Identity expired." } }),
    });
    expect(identity).toEqual({ status: "invalid", error: "Identity expired." });
  });

  it("maps an authoritative credential rejection to invalid instead of unavailable", async () => {
    const identity = await resolveConsoleVisitorIdentity("token", "csrf", {
      locationHref: "http://localhost:8080/console/chat",
      fetchImpl: async () =>
        json(
          {
            error: "This visitor credential is expired or revoked.",
            code: "visitor_credential_rejected",
          },
          401,
        ),
    });
    expect(identity).toEqual({
      status: "invalid",
      error: "Visitor credential was rejected.",
    });
  });

  it("maps an unconfigured resolver to a terminal state", async () => {
    const identity = await resolveConsoleVisitorIdentity("private-token", "csrf", {
      locationHref: "http://localhost:8080/console/chat",
      fetchImpl: async () =>
        json(
          {
            error: "Visitor identity resolution is not configured.",
            code: "visitor_identity_not_configured",
          },
          501,
        ),
    });

    expect(identity).toEqual({
      status: "not-configured",
      error: "Verified visitor identity is not configured for this agent.",
    });
  });

  it("keeps Console authorization failures distinct from service availability", async () => {
    const request = resolveConsoleVisitorIdentity("private-token", "expired-csrf", {
      locationHref: "http://localhost:8080/console/chat",
      fetchImpl: async () =>
        json({ error: "CSRF check failed.", code: "csrf_rejected" }, 403),
    });

    let failure: unknown;
    try {
      await request;
    } catch (error) {
      failure = error;
    }
    expect(isVisitorIdentityAuthorizationError(failure)).toBe(true);

    let transientFailure: unknown;
    try {
      await resolveConsoleVisitorIdentity("private-token", "csrf", {
        locationHref: "http://localhost:8080/console/chat",
        fetchImpl: async () =>
          json(
            {
              error: "Visitor identity resolution is temporarily unavailable.",
              code: "visitor_identity_unavailable",
            },
            503,
          ),
      });
    } catch (error) {
      transientFailure = error;
    }
    expect(isVisitorIdentityAuthorizationError(transientFailure)).toBe(false);
  });

  it("fails closed on extra fields and malformed expiry values", async () => {
    await expect(
      resolveConsoleVisitorIdentity("token", "csrf", {
        locationHref: "http://localhost:8080/console/chat",
        fetchImpl: async () =>
          json({
            identity: {
              status: "verified",
              email: "visitor@example.com",
              expiresAt: "tomorrow",
              visitorId: "must-not-be-trusted",
            },
          }),
      }),
    ).rejects.toThrow(/malformed/i);
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
