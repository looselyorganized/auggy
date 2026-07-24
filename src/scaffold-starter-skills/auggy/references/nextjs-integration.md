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

For copyable starter files, inspect:

- `skills/auggy/assets/templates/nextjs-browser-client/`
- `skills/auggy/assets/templates/nextjs-server-client/`
- `skills/auggy/assets/templates/app-auth-bridge/`

## Browser Components

Browser components may import only the browser target:

```ts
import { createAuggyClient } from "@/src/auggy-client";

const api = createAuggyClient({
  baseUrl: process.env.NEXT_PUBLIC_AUGGY_BASE_URL!,
  authAssertion: async () => {
    const res = await fetch("/api/auggy-auth-assertion", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "x-auggy-csrf-request": "1" },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { assertion?: unknown };
    return typeof body.assertion === "string" ? body.assertion : undefined;
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

Use a server client directly from trusted backend jobs, cron tasks, queue
workers, and server-only code that has already completed authorization.

A route handler is not trusted merely because it runs on the server. Before a
public handler resolves `AUGGY_BEARER_TOKEN`, it must verify the host
application's session, require an explicit operator/admin role, compare the
browser `Origin` to a fixed configured application origin, and validate a
session-bound CSRF token. Do not derive the trusted origin from `Host`,
forwarded headers, or `request.url`.

Copy
`assets/templates/nextjs-server-client/admin-reindex-route.ts.txt` for a
fail-closed example. It returns no authority until its session and CSRF stubs
are replaced. Existing applications must audit routes they copied previously;
refreshing this skill does not rewrite application route files.

## App Auth Assertion Route

A Next.js route handler can bridge existing app auth into Auggy. Copy these
files together instead of hand-rolling the security boundary:

- `assets/templates/app-auth-bridge/next-route.ts.txt`
- `assets/templates/app-auth-bridge/assertion-response.ts.txt`
- `assets/templates/app-auth-bridge/app-policy.ts.txt`

The route is POST-only. It checks the exact configured `Origin` and custom
CSRF request header before session verification, and every success or failure
response is private and `no-store`. Replace the session stub with the app's
real Clerk, Supabase, Auth0, SSO, or custom verifier without changing that
ordering.

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
