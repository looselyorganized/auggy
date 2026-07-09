# App Auth Bridge End To End

Use this recipe when an app already owns login and wants Auggy to enforce what
the logged-in user may do.

The tested pattern is:

1. App backend verifies the app session.
2. App backend derives narrow Auggy scopes/grants.
3. App backend mints a short-lived Auggy assertion.
4. Browser generated client sends `authAssertion`.
5. Auggy verifies the assertion as `public` + `recognized`.
6. A `visitor.required` route enforces `requires` before handler code runs.
7. `/agent/run` carries the same assertion into protected tools.
8. Tool `requires` checks schema-validated input before tool code runs.

Executable coverage lives in
`tests/integration/app-auth-bridge-generated-client.test.ts`.

## App Policy

Convert app-owned roles, org membership, and entitlements into explicit
Auggy scopes/grants:

```ts
import type { AuthorizationGrant, AuthorizationScope } from "auggy";

interface VerifiedAppSession {
  provider: "supabase" | "clerk" | "custom";
  userId: string;
  orgId?: string;
  roles: string[];
  orderIds: string[];
}

function deriveAuggyAuthorization(session: VerifiedAppSession): {
  scopes: AuthorizationScope[];
  grants: AuthorizationGrant[];
} {
  const scopes: AuthorizationScope[] = ["orders.read"];
  const grants = session.orderIds.map((orderId) => ({
    action: "orders.read",
    resource: orderId,
  }));

  if (session.roles.includes("support")) {
    scopes.push("refund.issue");
    for (const orderId of session.orderIds) {
      grants.push({ action: "refund.issue", resource: orderId });
    }
  }

  return { scopes, grants };
}
```

Do not make Auggy infer policy from raw roles. Roles may travel for context or
audit, but `requires` is satisfied by scopes/grants.

## Assertion Route

Browser code calls the app backend, not Auggy, to get an assertion:

```ts
import { createExternalAuthAssertion } from "auggy";

export async function GET(request: Request) {
  const session = await verifyAppSession(request);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const authorization = deriveAuggyAuthorization(session);
  const assertion = createExternalAuthAssertion({
    secret: process.env.AUGGY_EXTERNAL_AUTH_SECRET!,
    keyId: process.env.AUGGY_EXTERNAL_AUTH_KEY_ID ?? "2026-07",
    audience: process.env.AUGGY_EXTERNAL_AUTH_AUDIENCE!,
    provider: session.provider,
    subject: session.userId,
    ttlSeconds: 60,
    orgId: session.orgId,
    roles: session.roles,
    scopes: authorization.scopes,
    grants: authorization.grants,
    authzVersion: "2026-07-08",
    jti: crypto.randomUUID(),
  });

  return Response.json({ assertion });
}
```

Use provider-specific templates when writing `verifyAppSession`.

## Browser Client

Generated browser clients forward assertions:

```ts
import { createAuggyClient } from "@/src/auggy-client";

export const api = createAuggyClient({
  baseUrl: process.env.NEXT_PUBLIC_AUGGY_BASE_URL!,
  authAssertion: async () => {
    const res = await fetch("/api/auggy-auth-assertion", { credentials: "include" });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { assertion?: unknown };
    return typeof body.assertion === "string" ? body.assertion : undefined;
  },
});
```

Browser code never sees `AUGGY_EXTERNAL_AUTH_SECRET`.

## Protected Route

Routes use path params as authorization resources:

```ts
defineRoute.get("/orders/:orderId", {
  auth: "visitor.required",
  params: z.object({ orderId: z.string() }),
  requires: { action: "orders.read", resource: { param: "orderId" } },
  response: z.object({ orderId: z.string(), status: z.string() }),
  handler: ({ params, auth }) =>
    json({
      orderId: params.orderId,
      status: "ready",
      authorizedBy: auth.externalAuth?.subject,
    }),
});
```

Allowed call:

```ts
await api.get("/orders/:orderId", { params: { orderId: "order_123" } });
```

Requires a grant like:

```ts
{ action: "orders.read", resource: "order_123" }
```

Denied call:

```ts
await api.get("/orders/:orderId", { params: { orderId: "order_999" } });
```

Returns `403` with `authorization-grant-missing`; the route handler does not
run.

## Protected Tool

Tools bind grants to schema-validated input:

```ts
defineTool({
  name: "refund_order",
  description: "Refund an order the app has delegated.",
  category: "commerce",
  input: z.object({ orderId: z.string() }),
  requires: { action: "refund.issue", resource: { input: "orderId" } },
  execute: async ({ orderId }) => `refund-started:${orderId}`,
});
```

Allowed tool call requires:

```ts
{ action: "refund.issue", resource: "order_123" }
```

Denied tool call does not run `execute`. The model receives a tool error such
as `Tool "refund_order" authorization denied: authorization-grant-missing` and
should tell the user the app has not delegated that action.

## Files To Inspect

- `skills/auggy/assets/templates/app-auth-bridge/app-policy.ts.txt`
- `skills/auggy/assets/templates/app-auth-bridge/supabase-next-route.ts.txt`
- `skills/auggy/assets/templates/app-auth-bridge/clerk-next-route.ts.txt`
- `skills/auggy/assets/templates/app-auth-bridge/protected-orders-augment.ts.txt`
- `skills/auggy/assets/templates/app-auth-bridge/denial-audit-hook.ts.txt`
