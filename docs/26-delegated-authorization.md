# Delegated Authorization Bridge

Auggy can accept short-lived, app-signed auth assertions from an existing app
session and use them to authorize `visitor.required` routes. This lets a
frontend backed by Supabase Auth, Clerk, Auth0, or custom session middleware
call Auggy app-backend routes without making Auggy a general-purpose identity
provider.

The split is deliberate:

- The app verifies the user session and decides what the user may do.
- The app mints a compact, short-lived Auggy assertion.
- Auggy verifies the assertion signature, audience, provider, and TTL.
- Auggy enforces route-local `requires` rules against assertion
  `scopes` / `grants` before the handler runs.

Auggy does not run the app's RBAC system. It does not infer permissions from
roles. Roles can be preserved as context, but `requires` is satisfied only by
explicit delegated scopes or grants.

## Flow

1. Browser has a normal app login session.
2. Browser asks the app backend for an Auggy auth assertion.
3. App backend verifies the session with Clerk, Supabase, or custom auth.
4. App backend derives a minimal set of scopes/grants for the current user.
5. App backend signs a short-lived Auggy assertion.
6. Browser calls Auggy with `x-auggy-auth-assertion`.
7. Auggy resolves recognized visitor context and enforces route `requires`.

```text
browser -> app backend: "give me an Auggy assertion"
app backend -> app auth provider: verify session
app backend -> browser: signed short-lived assertion
browser -> Auggy route: x-auggy-auth-assertion
Auggy runtime: verify assertion, enforce route requires, call handler
```

## Configure Web Transport

Programmatic `webTransport` can verify app-signed assertions:

```ts
import { webTransport } from "auggy";

const web = webTransport({
  port: 8080,
  auth: { type: "bearer", token: process.env.AUGGY_BEARER_TOKEN! },
  visitorTokens: {
    enabled: true,
    signingKey: process.env.AUGGY_VISITOR_TOKEN_SIGNING_KEY!,
    agentBinding: "storefront-agent",
  },
  externalAuth: {
    secret: process.env.AUGGY_EXTERNAL_AUTH_SECRET!,
    audience: "storefront-agent",
    allowedProviders: ["supabase", "clerk", "custom"],
    maxTtlSeconds: 60,
  },
});
```

The default assertion header is `x-auggy-auth-assertion`. Override
`externalAuth.header` only when an app gateway requires a different header.

The `audience` should be stable for the agent. If omitted, Auggy falls back to
`visitorTokens.agentBinding`, then the agent-card provider name, then `"auggy"`.
Use an explicit audience when assertions are minted outside the Auggy process.

## Mint Assertions

The app backend owns session verification and authorization calculation. After
that, it signs an Auggy assertion:

```ts
import { createExternalAuthAssertion } from "auggy";

export async function mintAuggyAssertionForUser(user: {
  id: string;
  email?: string;
  orgId?: string;
  roles: string[];
}) {
  const grants = await delegatedGrantsForUser(user);

  return createExternalAuthAssertion({
    secret: process.env.AUGGY_EXTERNAL_AUTH_SECRET!,
    audience: "storefront-agent",
    provider: "custom",
    subject: user.id,
    ttlSeconds: 60,
    email: user.email,
    emailVerified: true,
    orgId: user.orgId,
    roles: user.roles,
    scopes: ["orders.read"],
    grants,
    authzVersion: "2026-07-03",
  });
}
```

Keep assertions short-lived. The app can mint a fresh assertion when the
browser needs to call Auggy. Do not put `AUGGY_EXTERNAL_AUTH_SECRET` in browser
code.

## Supabase Sketch

```ts
import { createExternalAuthAssertion } from "auggy";

export async function GET(req: Request) {
  const accessToken = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!accessToken) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const scopes = await scopesForSupabaseUser(data.user.id);
  const grants = await grantsForSupabaseUser(data.user.id);

  const assertion = createExternalAuthAssertion({
    secret: process.env.AUGGY_EXTERNAL_AUTH_SECRET!,
    audience: "storefront-agent",
    provider: "supabase",
    subject: data.user.id,
    ttlSeconds: 60,
    email: data.user.email,
    emailVerified: data.user.email_confirmed_at !== null,
    orgId: data.user.app_metadata?.org_id,
    roles: data.user.app_metadata?.roles ?? [],
    scopes,
    grants,
  });

  return Response.json({ assertion });
}
```

The important part is not the exact Supabase SDK call. The invariant is that
the app verifies the Supabase session server-side, then signs only the compact
claims Auggy needs.

## Clerk Sketch

```ts
import { createExternalAuthAssertion } from "auggy";

export async function GET(req: Request) {
  const session = await verifyClerkSession(req);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const assertion = createExternalAuthAssertion({
    secret: process.env.AUGGY_EXTERNAL_AUTH_SECRET!,
    audience: "storefront-agent",
    provider: "clerk",
    subject: session.userId,
    ttlSeconds: 60,
    email: session.email,
    emailVerified: session.emailVerified,
    orgId: session.orgId,
    roles: session.roles,
    scopes: await scopesForClerkUser(session),
    grants: await grantsForClerkUser(session),
  });

  return Response.json({ assertion });
}
```

Use whatever Clerk server API your app already trusts. Auggy should receive the
resulting assertion, not raw Clerk cookies or app secrets.

## Browser Client

Generated browser clients can provide assertions through `authAssertion`:

```ts
import { createAuggyClient } from "./auggy-client";

const api = createAuggyClient({
  baseUrl: "https://store.example.com",
  authAssertion: async () => {
    const res = await fetch("/api/auggy-auth-assertion", {
      credentials: "include",
    });
    if (!res.ok) return undefined;
    return (await res.json()).assertion;
  },
});

const result = await api.get("/orders");
```

The generated client sends the assertion as `x-auggy-auth-assertion`. It does
not verify or refresh the underlying app session.

## Route Requirements

`requires` is route-local delegated authorization. It only works with
recognized visitor context that has verified external auth claims.

Scope requirement:

```ts
import { defineRoute, json } from "auggy";

export const httpRoutes = [
  defineRoute.get("/orders", {
    auth: "visitor.required",
    requires: { scope: "orders.read" },
    handler: async ({ auth }) => {
      if (auth.mode !== "visitor" || auth.state !== "recognized") {
        return json({ error: "visitor-auth-required" }, 401);
      }
      return json({
        visitorId: auth.visitorId,
        orders: [],
      });
    },
  }),
];
```

Grant requirement with a path-param resource:

```ts
import { z } from "zod";
import { defineRoute, json } from "auggy";

export const httpRoutes = [
  defineRoute.post("/orders/:id/refund", {
    auth: "visitor.required",
    params: z.object({ id: z.string() }),
    requires: {
      action: "refund.issue",
      resource: { param: "id" },
      constraints: {
        maxAmountCents: 5000,
        currency: "USD",
      },
    },
    handler: async ({ params, auth }) => {
      if (auth.mode !== "visitor" || auth.state !== "recognized") {
        return json({ error: "visitor-auth-required" }, 401);
      }
      return json({
        refunded: true,
        orderId: params.id,
        authorizedBy: auth.externalAuth?.subject,
      });
    },
  }),
];
```

The matching assertion must include a grant like:

```ts
{
  action: "refund.issue",
  resource: "order_123",
  constraints: {
    maxAmountCents: 5000,
    currency: "USD",
  },
}
```

Constraints are exact JSON-value matches. If a route requires
`{ maxAmountCents: 5000 }`, a grant with `{ maxAmountCents: 10000 }` does not
satisfy it. Keep constraints compact and deterministic.

Multiple requirements are ANDed:

```ts
requires: [
  { scope: "orders.read" },
  { action: "refund.issue", resource: { param: "id" } },
]
```

## Runtime Outcomes

For `auth: "visitor.required"` routes:

- Missing/invalid visitor credentials or external assertion return
  `401 {"error":"visitor-auth-required"}`.
- A valid visitor token without required external auth claims returns
  `403 {"error":"forbidden","reason":"authorization-claims-required"}` when
  the route declares `requires`.
- Missing scope returns
  `403 {"error":"forbidden","reason":"authorization-scope-missing"}`.
- Missing grant returns
  `403 {"error":"forbidden","reason":"authorization-grant-missing"}`.
- A path-param resource binding that cannot resolve returns
  `403 {"error":"forbidden","reason":"authorization-resource-unresolved"}`.

Authorization is enforced before the handler runs.

## What Claims Mean

Verified external auth claims are available on route context:

```ts
auth.externalAuth // provider, subject, orgId?, roles?, scopes?, grants?, authzVersion?, jti?
auth.principal.externalAuth
```

Use this for audit, app-specific lookup, and handler-local context. Do not treat
`roles` as route permissions. Route permissions should be expressed as
`requires` scopes or grants so Auggy can enforce them consistently before
handler code runs.

If a request supplies both an Auggy visitor token and an external auth
assertion, Auggy keeps the visitor-token identity and merges external claims
only when the assertion maps to the same visitor id. Mismatched app claims are
not attached to the visitor context.

## Security Rules

- Verify Clerk/Supabase/custom sessions on the app server, not in browser code.
- Keep assertion TTLs short, usually 30-120 seconds.
- Use `allowedProviders` and a stable `audience`.
- Rotate `AUGGY_EXTERNAL_AUTH_SECRET` like any app signing secret.
- Do not put app RBAC policy, broad role interpretation, or provider secrets in
  Auggy route handlers.
- Do not let the model decide whether a user is authorized.
- Prefer narrow scopes and resource grants over broad roles.
- Use `authzVersion` or `jti` when the app needs audit correlation,
  revocation, or policy-version tracking.

## Relationship to Visitor Auth

This bridge complements `visitorAuth`; it does not replace it.

- `visitorAuth` verifies visitors through Auggy-owned flows such as magic links
  and visitor tokens.
- External auth assertions let an existing app session become recognized Auggy
  visitor context for a short-lived request.
- Delegated authorization lets app-owned permissions travel with that request
  as explicit scopes/grants.

The common invariant remains: the runtime verifies identity and authorization;
the model never does.
