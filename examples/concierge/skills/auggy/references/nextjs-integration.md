# Next.js Integration

Use Next.js for the frontend and app server. Use Auggy as the agent-native app
backend that owns routes, tools, memory, auth assertions, and agent runtime
policy.

## Common Layout

```text
apps/web/
  app/
  src/
    auggy-client.ts          # generated browser client
    auggy-client.server.ts   # generated server client
    app/api/auggy-auth-assertion/route.ts

agent/
  agent.yaml
  augments/
  skills/
```

Keep the browser and server generated clients separate.

## Browser Components

Browser components may import only the browser target:

```ts
import { createAuggyClient } from "@/src/auggy-client";

const api = createAuggyClient({
  baseUrl: process.env.NEXT_PUBLIC_AUGGY_BASE_URL!,
  authAssertion: async () => {
    const res = await fetch("/api/auggy-auth-assertion", { credentials: "include" });
    if (!res.ok) return undefined;
    return (await res.json()).assertion;
  },
});
```

Only expose `NEXT_PUBLIC_*` values that are safe for every browser visitor.
Never expose creator bearer tokens, agent credentials, provider API keys, or
external auth signing secrets.

## Server Actions Or Route Handlers

Server-only code may import the server target:

```ts
import { createAuggyClient } from "@/src/auggy-client.server";

const api = createAuggyClient({
  baseUrl: process.env.AUGGY_BASE_URL!,
  bearerToken: () => process.env.AUGGY_BEARER_TOKEN,
});
```

Use this for trusted backend jobs, server actions, route handlers, cron tasks,
and admin operations.

## App Auth Assertion Route

A Next.js route handler can bridge existing app auth into Auggy:

```ts
// app/api/auggy-auth-assertion/route.ts
import { createExternalAuthAssertion } from "auggy";

export async function GET() {
  const user = await verifyAppSessionSomehow();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const assertion = createExternalAuthAssertion({
    secret: process.env.AUGGY_EXTERNAL_AUTH_SECRET!,
    audience: "storefront-agent",
    provider: "custom",
    subject: user.id,
    ttlSeconds: 60,
    scopes: ["orders.read"],
    grants: [],
    jti: crypto.randomUUID(),
  });

  return Response.json({ assertion });
}
```

Replace `verifyAppSessionSomehow()` with the app's real Clerk, Supabase, Auth0,
SSO, or custom session verification.

## Regeneration Workflow

After route changes:

```bash
auggy routes
auggy routes --client ts --target browser --out src/auggy-client.ts
auggy routes --client ts --target server --out src/auggy-client.server.ts
```

Commit generated clients only when they are part of app source or examples.

## Deployment Notes

- The Next.js app needs the public Auggy base URL for browser calls.
- The Next.js server needs Auggy server credentials only if it calls privileged
  routes.
- The Auggy service needs provider model keys, visitor/auth signing keys, and
  external auth secrets.
- Browser code never receives server-only Auggy secrets.
