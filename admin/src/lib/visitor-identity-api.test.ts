import { describe, expect, it } from "bun:test";

import { resolveConsoleVisitorIdentity } from "./visitor-identity-api";

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
