import { expect, test } from "bun:test";
import { verifyExternalAuthAssertion } from "auggy/auth";
import {
  createAssertionHandler,
  type AssertionConfiguration,
} from "../src/server/assertion-handler";
import { createCompanyPolicy } from "../src/server/company-policy";
import type { VerifiedAppSession } from "../src/server/contracts";

const config: AssertionConfiguration = {
  appOrigin: "https://company.example",
  audience: "company-agent",
  keyId: "company-key",
  secret: "synthetic-private-signing-key",
};
const session: VerifiedAppSession = {
  provider: "company-session-provider",
  userId: "customer-a",
  orgId: "company",
  roles: ["admin"],
};
const authorization = {
  scopes: ["orders.read"],
  grants: [{ action: "orders.read", resource: "order-a" }],
  authzVersion: "policy-v1",
};
const request = (headers: Record<string, string> = {}, method = "POST") =>
  new Request("https://company.example/api/auggy-auth-assertion", {
    method,
    headers: {
      origin: "https://company.example",
      "x-auggy-csrf-request": "1",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    ...(method === "POST"
      ? {
          body: JSON.stringify({
            userId: "support-agent",
            roles: ["creator"],
            grants: [{ action: "*" }],
          }),
        }
      : {}),
  });

function guarded(
  overrides: {
    configuration?: () => AssertionConfiguration;
    session?: VerifiedAppSession | null;
    disabled?: boolean;
    failVerifier?: boolean;
    failPolicy?: boolean;
  } = {},
) {
  let verifications = 0;
  let policyReads = 0;
  const handler = createAssertionHandler({
    configuration: overrides.configuration ?? (() => config),
    adapter: overrides.disabled
      ? null
      : {
          async verify() {
            verifications++;
            if (overrides.failVerifier) throw new Error("private-session-secret");
            return overrides.session === undefined ? session : overrides.session;
          },
        },
    policy: createCompanyPolicy({
      async authorizationFor(verified) {
        policyReads++;
        expect(verified).toBe(overrides.session ?? session);
        if (overrides.failPolicy) throw new Error("private-policy-secret");
        return authorization;
      },
    }),
  });
  return { handler, calls: () => ({ verifications, policyReads }) };
}

async function privateResponse(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("vary")).toBe("Cookie, Authorization, Origin");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  return (await response.json()) as Record<string, unknown>;
}

test("method, exact origin and CSRF reject before verifier or policy effects", async () => {
  const item = guarded();
  for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
    const response = await item.handler(request({}, method));
    await privateResponse(response, 405);
    expect(response.headers.get("allow")).toBe("POST");
  }
  const rejectedHeaders: Record<string, string>[] = [
    { origin: "https://attacker.example" },
    { origin: "https://company.example/" },
    { origin: "null" },
    { "x-auggy-csrf-request": "0" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ];
  for (const headers of rejectedHeaders)
    await privateResponse(await item.handler(request(headers)), 403);
  for (const appOrigin of [
    undefined,
    "",
    "https://company.example/path",
    "https://company.example?query",
    "https://user:password@company.example",
  ]) {
    const invalid = guarded({ configuration: () => ({ ...config, appOrigin }) });
    await privateResponse(await invalid.handler(request()), 503);
    expect(invalid.calls()).toEqual({ verifications: 0, policyReads: 0 });
  }
  expect(item.calls()).toEqual({ verifications: 0, policyReads: 0 });
});

test("unconfigured, invalid and failing verifiers fail closed with sanitized responses", async () => {
  for (const [options, status] of [
    [{ disabled: true }, 503],
    [{ session: null }, 401],
    [{ failVerifier: true }, 503],
    [{ failPolicy: true }, 503],
  ] as const) {
    const item = guarded(options);
    const body = await privateResponse(await item.handler(request()), status);
    expect(JSON.stringify(body)).not.toContain("private-");
    expect(body).not.toHaveProperty("assertion");
    if ("disabled" in options && options.disabled)
      expect(item.calls()).toEqual({ verifications: 0, policyReads: 0 });
  }
  for (const field of ["secret", "keyId", "audience"] as const) {
    const item = guarded({ configuration: () => ({ ...config, [field]: "" }) });
    await privateResponse(await item.handler(request()), 503);
    expect(item.calls()).toEqual({ verifications: 0, policyReads: 0 });
  }
});

test("fresh 60-second assertions bind verified identity and company policy, ignoring request-supplied authority", async () => {
  const item = guarded();
  const first = await privateResponse(await item.handler(request()), 200);
  const second = await privateResponse(await item.handler(request()), 200);
  if (typeof first.assertion !== "string" || typeof second.assertion !== "string")
    throw new Error("expected assertions");
  const verify = (assertion: string) =>
    verifyExternalAuthAssertion(assertion, {
      secret: config.secret,
      keyId: config.keyId,
      audience: config.audience!,
      maxTtlSeconds: 60,
      allowedProviders: [session.provider],
    });
  const a = verify(first.assertion);
  const b = verify(second.assertion);
  expect(a.ok).toBe(true);
  expect(b.ok).toBe(true);
  if (!a.ok || !b.ok) throw new Error("expected verified assertions");
  expect(a.claims.subject).toBe("customer-a");
  expect(a.claims.roles).toEqual(["admin"]);
  expect(a.claims.grants).toEqual(authorization.grants);
  expect(a.claims.authzVersion).toBe("policy-v1");
  expect(a.claims.expiresAt - a.claims.issuedAt).toBe(60_000);
  expect(a.claims.jti).not.toBe(b.claims.jti);
  expect(a.claims).not.toHaveProperty("trustLevel");
  expect(item.calls()).toEqual({ verifications: 2, policyReads: 2 });
});
