# Delegated Authorization Bridge

Auggy can accept short-lived, app-signed auth assertions from an existing app
session and use them to authorize `visitor.required` routes and protected model
tools. This lets a frontend backed by Supabase Auth, Clerk, Auth0, or custom
session middleware call Auggy app-backend surfaces without making Auggy a
general-purpose identity provider.

The split is deliberate:

- The app verifies the user session and decides what the user may do.
- The app mints a compact, short-lived Auggy assertion.
- Auggy verifies the assertion signature, audience, provider, and TTL.
- Auggy enforces route-local and tool-local `requires` rules against assertion
  `scopes` / `grants` before the route handler or tool runs.

Auggy does not run the app's RBAC system. It does not infer permissions from
roles. Roles can be preserved as context, but `requires` is satisfied only by
explicit delegated scopes or grants minted by the app backend.

## Flow

1. Browser has a normal app login session.
2. Browser asks the app backend for an Auggy auth assertion.
3. App backend verifies the session with Clerk, Supabase, or custom auth.
4. App backend derives a minimal set of scopes/grants for the current user.
5. App backend signs a short-lived Auggy assertion.
6. Browser calls Auggy with `x-auggy-auth-assertion`.
7. Auggy resolves the caller as `public` + `recognized` and enforces route/tool
   `requires`.

```text
browser -> app backend: "give me an Auggy assertion"
app backend -> app auth provider: verify session
app backend -> browser: signed short-lived assertion
browser -> Auggy route or run endpoint: x-auggy-auth-assertion
Auggy runtime: verify assertion, enforce route/tool requires, call handler/tool
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
    keyId: "2026-07",
    secrets: [
      {
        keyId: "2026-06",
        secret: process.env.AUGGY_EXTERNAL_AUTH_SECRET_PREVIOUS!,
      },
    ],
    audience: "storefront-agent",
    allowedProviders: ["supabase", "clerk", "custom"],
    maxTtlSeconds: 60,
    replayProtection: { enabled: true },
  },
});
```

The default assertion header is `x-auggy-auth-assertion`. Override
`externalAuth.header` only when an app gateway requires a different header.

The `audience` should be stable for the agent. If omitted, Auggy falls back to
the web transport security namespace: `securityNamespace`, then
`visitorTokens.agentBinding`, then the registered agent-card provider name.
Use an explicit audience when assertions are minted outside the Auggy process.

`externalAuth.secret` is the current signing secret. `externalAuth.keyId`
labels that current secret when minted assertions include a `keyId`.
`externalAuth.secrets` adds previous or alternate secrets for rotation.
Entries can include `keyId`, so assertions with `kid` only try the matching
key; assertions without `kid` remain compatible and are tried against the
configured keyring.

`externalAuth.replayProtection.enabled` rejects reused assertions before they
can establish external app auth for `visitor.required` routes and `/agent/run`.
When enabled, every accepted assertion must carry a unique `jti`; assertions
without `jti` and assertions whose `jti` has already been seen are treated like
invalid external assertions. The public route response remains the generic
`visitor-auth-required` body when the assertion is required, so replay internals
are not exposed to browsers.

If no replay store is supplied, `webTransport` uses a process-local in-memory
cache. That is useful for single-process deployments and local development. For
multi-process, multi-region, or restart-resilient deployments, pass a shared
store:

```ts
const web = webTransport({
  // ...
  externalAuth: {
    secret: process.env.AUGGY_EXTERNAL_AUTH_SECRET!,
    audience: "storefront-agent",
    replayProtection: {
      enabled: true,
      store: {
        async consume(jti, expiresAt, now) {
          const ttlMs = Math.max(0, expiresAt - now);
          // Atomically SET jti if absent with ttlMs. Return false when present.
          return redisSetOnce(`auggy:external-auth:jti:${jti}`, "1", ttlMs);
        },
      },
    },
  },
});
```

Replay stores must be atomic and keyed by `jti`. They should retain each key no
longer than the assertion expiry (`expiresAt - now`), and they should be shared
by every Auggy process that accepts the same external auth audience and secrets.

For `/agent/run`, a valid external auth assertion admits the request as
`public` + `recognized` even when `allowAnonymous` is `false`. That keeps normal
app-login chat separate from public anonymous chat.

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
    keyId: "2026-07",
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
    jti: crypto.randomUUID(),
  });
}
```

Keep assertions short-lived. The app can mint a fresh assertion when the
browser needs to call Auggy. Do not put `AUGGY_EXTERNAL_AUTH_SECRET` in browser
code.

`createExternalAuthAssertion` is the supported server-side helper for this
contract. The app chooses the assertion `audience` to match the Auggy agent,
sets `provider` to the app identity source (`"supabase"`, `"clerk"`, or a
custom provider name), sets `keyId` when using rotation, and uses short TTLs.
Auggy verifies the signature, key id, audience, provider allowlist, expiry, and
max TTL before any route handler or protected tool receives the claims.

## App Builder Recipes

The recipes below all have the same boundary:

- The browser keeps using the app's normal Supabase or Clerk login.
- The app backend verifies that session and computes minimal `scopes` /
  `grants`.
- The app backend signs the Auggy assertion with `createExternalAuthAssertion`.
- The browser sends the assertion to Auggy, but never sees
  `AUGGY_EXTERNAL_AUTH_SECRET`.

Roles can still be copied into the assertion for audit or lookup context, but
Auggy receives narrow scopes/grants for enforcement. It does not interpret raw
app roles as route or tool permissions.

For a runnable version of this pattern, see
[`examples/app-auth-bridge`](../examples/app-auth-bridge/README.md). It includes
structural Supabase/Clerk adapters, a shared assertion helper, generated browser
client usage, protected routes, protected tools, key ids, `jti`, and replay
protection.

### Supabase

```ts
// app/api/auggy-auth-assertion/route.ts
import { createClient } from "@supabase/supabase-js";
import { createExternalAuthAssertion, type AuthorizationGrant } from "auggy";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);

export async function GET(req: Request) {
  // This variant verifies the user's Supabase access token. Cookie-backed
  // Supabase apps can instead read the server session and call getUser().
  const accessToken = req.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "");
  if (!accessToken) return Response.json({ error: "unauthorized" }, { status: 401 });

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(accessToken);
  if (error || !user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const orgId =
    typeof user.app_metadata.org_id === "string" ? user.app_metadata.org_id : undefined;
  const canReadOrders = await appPolicy.canReadOrders({ userId: user.id, orgId });
  const grants = await refundGrantsForUser(user.id, orgId);

  const assertion = createExternalAuthAssertion({
    secret: process.env.AUGGY_EXTERNAL_AUTH_SECRET!,
    keyId: "2026-07",
    audience: "storefront-agent",
    provider: "supabase",
    subject: user.id,
    ttlSeconds: 60,
    email: user.email,
    emailVerified: user.email_confirmed_at !== null,
    orgId,
    roles: stringArray(user.app_metadata.roles),
    scopes: canReadOrders ? ["orders.read"] : [],
    grants,
    authzVersion: "orders-v1",
    jti: crypto.randomUUID(),
  });

  return Response.json({ assertion });
}

async function refundGrantsForUser(
  userId: string,
  orgId: string | undefined,
): Promise<AuthorizationGrant[]> {
  const orderIds = await appPolicy.refundableOrderIds({ userId, orgId });
  return orderIds.map((orderId) => ({ action: "refund.issue", resource: orderId }));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
```

The important part is the server-side verification and translation step:
Supabase session and app roles go into `appPolicy`; only the derived
`orders.read` scope and per-order refund grants go to Auggy.

### Clerk

```ts
// app/api/auggy-auth-assertion/route.ts
import { auth, currentUser } from "@clerk/nextjs/server";
import { createExternalAuthAssertion, type AuthorizationGrant } from "auggy";

export async function GET() {
  const { isAuthenticated, userId, orgId, orgRole } = await auth();
  if (!isAuthenticated || !userId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const user = await currentUser();
  const canReadOrders = await appPolicy.canReadOrders({ userId, orgId });
  const grants = await refundGrantsForClerkUser({ userId, orgId, orgRole });

  const assertion = createExternalAuthAssertion({
    secret: process.env.AUGGY_EXTERNAL_AUTH_SECRET!,
    keyId: "2026-07",
    audience: "storefront-agent",
    provider: "clerk",
    subject: userId,
    ttlSeconds: 60,
    email: user?.primaryEmailAddress?.emailAddress,
    emailVerified: user?.primaryEmailAddress?.verification?.status === "verified",
    orgId: orgId ?? undefined,
    roles: orgRole ? [orgRole] : [],
    scopes: canReadOrders ? ["orders.read"] : [],
    grants,
    authzVersion: "orders-v1",
    jti: crypto.randomUUID(),
  });

  return Response.json({ assertion });
}

async function refundGrantsForClerkUser(session: {
  userId: string;
  orgId: string | null | undefined;
  orgRole: string | null | undefined;
}): Promise<AuthorizationGrant[]> {
  const orderIds = await appPolicy.refundableOrderIds(session);
  return orderIds.map((orderId) => ({ action: "refund.issue", resource: orderId }));
}
```

Use the Clerk server API your app already trusts. Clerk organization context is
input to `appPolicy`; the assertion carries the narrow result.

### Generated Browser Client

Generated browser clients can provide assertions through `authAssertion`:

```ts
import { createAuggyClient } from "./auggy-client";

const api = createAuggyClient({
  baseUrl: "https://store.example.com",
  authAssertion: async () => {
    const headers = new Headers();
    const appAccessToken = await currentAppAccessToken();
    if (appAccessToken) headers.set("authorization", `Bearer ${appAccessToken}`);

    const res = await fetch("/api/auggy-auth-assertion", {
      credentials: "include",
      headers,
    });
    if (!res.ok) return undefined;
    return (await res.json()).assertion;
  },
});

const result = await api.get("/orders");

if (result.ok) {
  renderOrders(result.data.orders);
} else if (result.status === 403) {
  renderForbidden();
}
```

The generated client sends the assertion as `x-auggy-auth-assertion` by default,
or as the same custom header configured in `webTransport.externalAuth.header`.
It does not create the assertion, verify the app session, or know the assertion secret.
`currentAppAccessToken` is only needed for token-backed sessions such as the
Supabase bearer example above; cookie-backed Clerk/Supabase apps can return
`undefined`.

For chat or `/agent/run` flows, carry the same assertion with the inbound
request. Tool authorization uses the turn's resolved auth context; the model
does not get to assert identity or permissions in tool arguments.

## Route Requirements

`requires` is route-local delegated authorization. It only works with
`public` + `recognized` context that has verified external auth claims.

Scope requirement:

```ts
import { defineRoute, json } from "auggy";
import { z } from "zod";

export const httpRoutes = [
  defineRoute.get("/orders", {
    auth: "visitor.required",
    requires: { scope: "orders.read" },
    response: z.object({
      orders: z.array(z.object({ id: z.string(), status: z.string() })),
    }),
    handler: async ({ auth }) => {
      if (auth.mode !== "visitor" || auth.state !== "recognized") {
        return json({ error: "visitor-auth-required" }, 401);
      }
      return json({
        orders: await ordersForUser(auth.externalAuth?.subject),
      });
    },
  }),
];
```

Allowed behavior: an assertion with `scopes: ["orders.read"]` reaches the
handler. Denied behavior: a valid assertion without that scope returns
`403 {"error":"forbidden","reason":"authorization-scope-missing"}` before the
handler runs.

Multiple requirements are ANDed:

```ts
requires: [
  { scope: "orders.read" },
  { action: "refund.issue", resource: { param: "id" } },
]
```

Routes can bind grant resources from path params with `{ param: "id" }`.
Route requirements cannot bind resources from request bodies or arbitrary model
input.

Constraints are exact JSON-value matches. If a route requires
`{ maxAmountCents: 5000 }`, a grant with `{ maxAmountCents: 10000 }` does not
satisfy it. Keep constraints compact and deterministic.

## Tool Requirements

Tools can also declare delegated authorization requirements. This is the
important app-builder case: the model may decide to call a tool, but the
runtime decides whether that specific user may perform that specific action on
that specific resource.

```ts
import { defineTool } from "auggy";
import { z } from "zod";

export const refundOrder = defineTool({
  name: "refund_order",
  description: "Refund a customer's order.",
  category: "commerce",
  input: z.object({
    orderId: z.string(),
    reason: z.string(),
  }),
  requires: {
    action: "refund.issue",
    resource: { input: "orderId" },
  },
  execute: async ({ orderId, reason }, context) => {
    await refunds.issue({ orderId, reason, actor: context?.auth?.principal.id });
    return `Refunded ${orderId}.`;
  },
});
```

The matching assertion must include a grant for the resolved resource:

```ts
{
  action: "refund.issue",
  resource: "order_123",
}
```

Allowed behavior: if the model calls `refund_order` with
`{ "orderId": "order_123" }` and the assertion has the grant above, the tool
executes. Denied behavior: a grant for `order_999`, or no grant, prevents tool
execution and returns a deterministic denial such as
`authorization-grant-missing` to the turn.

Tool resource binding rules are intentionally narrow:

- `{ input: "orderId" }` reads a top-level string field from the validated tool
  input.
- Nested paths such as `{ input: "order.id" }` are not traversed and fail
  closed with `authorization-resource-unresolved`.
- Non-string, missing, or empty values fail closed.
- Tool requirements cannot use `{ param }`; route requirements use `{ param }`,
  tool requirements use `{ input }`.

The runtime validates the tool's Zod input before resolving `{ input }`. That
means authorization is checked against typed, schema-validated data, not raw
model JSON.

### How App Permissions Become Tool Grants

The app backend should translate its own permissions into minimal scopes and
grants when minting the assertion:

```ts
async function refundGrantForSupabaseUser(userId: string, orderId: string) {
  const canRefund = await appPolicy.canRefundOrder(userId, orderId);
  return canRefund ? [{ action: "refund.issue", resource: orderId }] : [];
}
```

For broad permissions, use a scope:

```ts
scopes: ["orders.read"]
```

If a tool declares a broad action requirement with no resource, use an unscoped
grant:

```ts
grants: [{ action: "refund.issue" }]
```

For resource-specific permissions, use a grant:

```ts
grants: [{ action: "refund.issue", resource: "order_123" }]
```

Resource grants are not wildcards. A grant for `order_123` satisfies a
requirement for `order_123`; it does not satisfy a broad
`{ action: "refund.issue" }` requirement. If the app cannot know the resource
at assertion mint time, it should either mint grants for the bounded resources
visible in the current workflow, use a deliberately broad scope or unscoped
grant only when the app policy says that is safe, or keep an additional
domain-layer authorization check inside the tool before side effects.

Do not pass raw roles and ask Auggy to interpret them. A Supabase role,
Clerk organization membership, Stripe customer id, or custom entitlement can
all be useful inputs to the app's policy engine, but the assertion should carry
the narrow result Auggy needs to enforce: scopes and grants.

## Runtime Outcomes

For `auth: "visitor.required"` routes, these HTTP response bodies are the
public contract:

| Status | Body | Meaning |
| --- | --- | --- |
| `401` | `{"error":"visitor-auth-required"}` | The request did not resolve to `public` + `recognized`. Missing visitor credentials, invalid visitor tokens, and invalid external assertions all use this body. Assertion verification internals such as expiry, provider mismatch, or signature failure are not exposed to the browser. |
| `403` | `{"error":"forbidden","reason":"authorization-claims-required"}` | The request is `public` + `recognized`, but the route declares `requires` and the context has no verified external auth claims. |
| `403` | `{"error":"forbidden","reason":"authorization-scope-missing"}` | The assertion did not include the required scope. |
| `403` | `{"error":"forbidden","reason":"authorization-grant-missing"}` | The assertion did not include a grant matching the required action/resource/constraints. |
| `403` | `{"error":"forbidden","reason":"authorization-resource-unresolved"}` | The route requirement could not resolve its declared path-param resource. |

Route authorization is enforced before the handler runs.

For protected tools, the tool does not execute when authorization is missing,
invalid, or denied. The turn continues with a deterministic tool-denial result
visible to the model, such as `authorization-scope-missing`,
`authorization-grant-missing`, or `authorization-resource-unresolved`.
Those tool-denial strings intentionally match the route `reason` values, but
they are model-loop results rather than HTTP response bodies.

## Audit Semantics

`webTransport` can receive delegated authorization denial audit events with
`onDelegatedAuthorizationDenied`. The event fires when a route `requires` check
returns `403` and when a protected tool is denied before execution. The payload
includes the denial `reason`, the failed `requirement`, a route or tool target,
and verified external-auth `keyId`, `provider`, `subject`, and `orgId` when
those claims are available.

Audit events are sanitized. They never include assertion tokens, signing
secrets, raw request headers, visitor tokens, or bearer/agent credentials.
Missing visitor credentials and invalid external assertions fail before
delegated authorization evaluation and do not emit these events. Protected-tool
audit events are kernel events, but the web transport does not translate them
to AG-UI/SSE client events.

## What Claims Mean

Verified external auth claims are available on route context and protected tool
execution context:

```ts
auth.externalAuth // keyId?, provider, subject, orgId?, roles?, scopes?, grants?, authzVersion?, jti?
auth.principal.externalAuth
```

Use this for audit, app-specific lookup, and route-handler or tool context. Do
not treat `roles` as route or tool permissions. Permissions should be expressed as
`requires` scopes or grants so Auggy can enforce them consistently before
handler or tool code runs.

In TypeScript, `auth.principal.kind` is the typed identity payload for the
resolved caller (`anonymous`, `visitor`, `creator`, or `agent`). It is not a
second permission system. For authorization, reason from `trustLevel`,
`publicSubstate`, and explicit `requires` scopes/grants.

If a request supplies both an Auggy visitor token and an external auth
assertion, Auggy keeps the visitor-token identity and merges external claims
only when the assertion maps to the same visitor id. Mismatched app claims are
not attached to the visitor context.

## Team and Internal Users

Auggy does not ship a separate `team`, `internal`, or `trusted` trust level in
`0.5.0`. The runtime trust levels remain `creator`, `agent`, and `public`.

For product-facing teammates, employees, customers, or staff members, use the
delegated authorization bridge: the app verifies the user through Clerk,
Supabase, Auth0, SSO, or custom middleware, then mints explicit Auggy
`scopes` / `grants`. Auggy receives that caller as `public` + `recognized` with
app-owned authorization claims.

For teammates who operate the Auggy instance itself, use creator access today:
protect `/console` behind HTTPS plus the creator bearer, ideally behind company
VPN/SSO/reverse proxy. Per-teammate operator identity, scoped console powers,
and audit attribution are future multi-operator/team auth work.

## Security Rules

- Verify Clerk/Supabase/custom sessions on the app server, not in browser code.
- Keep assertion TTLs short, usually 30-120 seconds.
- Use `allowedProviders` and a stable `audience`.
- Rotate `AUGGY_EXTERNAL_AUTH_SECRET` like any app signing secret: mint new
  assertions with a new `keyId`, keep the previous key in
  `externalAuth.secrets` until its assertions expire, then remove it.
- Enable replay protection for high-risk routes, tool-enabled app sessions, or
  any deployment where a captured assertion should not be usable twice. Use a
  shared atomic store when more than one Auggy process can receive assertions.
- Do not put app RBAC policy, broad role interpretation, or provider secrets in
  Auggy route handlers.
- Do not let the model decide whether a user is authorized.
- Prefer narrow scopes and resource grants over broad roles.
- Bind tool grants to top-level validated input fields only; avoid nested paths
  or authorization decisions based on model-written prose.
- Use `authzVersion` for policy-version tracking and `jti` for audit
  correlation, revocation, and replay protection.

## Production Checklist

- **Session verification:** Use the app server's trusted Clerk, Supabase, or
  custom session API. Never mint Auggy assertions from browser code.
- **Assertion shape:** Set stable `audience`, provider allowlist, short
  `ttlSeconds`, `keyId`, `authzVersion`, and unique `jti`.
- **Permissions:** Convert app roles, org membership, and entitlements into
  explicit `scopes` and `grants`. Treat `roles` as context only.
- **Key rotation:** Sign new assertions with the current `keyId`; keep the
  previous key in `externalAuth.secrets` until old assertions expire.
- **Replay protection:** Enable `externalAuth.replayProtection` for
  tool-enabled sessions and high-risk routes. Mint a fresh assertion per Auggy
  request when replay protection is enabled, and use a shared atomic store
  outside single-process local deployments.
- **Audit:** Register `onDelegatedAuthorizationDenied` when denied route/tool
  attempts need to land in app logs or security telemetry.
- **Client boundary:** Generate a browser client for public/visitor routes and
  a server client for bearer, creator, agent, and webhook-policy routes.

## Relationship to Visitor Auth

This bridge complements `visitorAuth`; it does not replace it.

- `visitorAuth` verifies visitors through Auggy-owned flows such as magic links
  and visitor tokens.
- External auth assertions let an existing app session become recognized Auggy
  visitor context for a short-lived request.
- Delegated authorization lets app-owned permissions travel with that request
  as explicit scopes/grants for routes and tools.

The common invariant remains: the runtime verifies identity and authorization;
the model never does.

## Executable Pattern

The end-to-end pattern is covered by
`tests/integration/delegated-authz-agent-run.test.ts`:

- app code mints an external auth assertion
- `/agent/run` receives `x-auggy-auth-assertion`
- the turn carries verified external auth claims
- a protected tool declares `requires` with `{ input: "orderId" }`
- allowed and denied grant paths are both tested

The generated-client app bridge is covered by
`tests/integration/app-auth-bridge-generated-client.test.ts`:

- app backend code verifies a Supabase/Clerk-style session
- the app backend mints `x-auggy-auth-assertion`
- a generated browser client uses `authAssertion` for a `visitor.required`
  route
- Auggy enforces route `requires` and tool `requires`
- allowed and denied route/tool paths are both tested
