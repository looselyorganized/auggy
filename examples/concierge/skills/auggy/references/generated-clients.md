# Generated Route Clients

Generated clients let app code call deterministic Auggy routes without
hand-writing paths, params, query strings, bodies, or auth headers.

Generate both targets when an app consumes Auggy routes:

```bash
auggy routes --client ts --target browser --out src/auggy-client.ts
auggy routes --client ts --target server --out src/auggy-client.server.ts
```

`--target` defaults to `browser`.

## Import Boundary

`createAuggyClient` is emitted inside each generated file. It is not exported
from the `auggy` package yet.

Correct:

```ts
import { createAuggyClient } from "./auggy-client";
```

Incorrect:

```ts
import { createAuggyClient } from "auggy";
```

Do not edit generated files manually. Regenerate after route paths, methods,
auth modes, request schemas, response schemas, or route policies change.

For copyable Next.js usage files, inspect
`skills/auggy/assets/templates/nextjs-browser-client/` and
`skills/auggy/assets/templates/nextjs-server-client/`.

## Target Split

| Target | Includes | Omits | Credentials |
| --- | --- | --- | --- |
| browser | `none`, `visitor.optional`, `visitor.required` | `bearer`, `creator`, `agent.required`, webhook-policy routes | `visitorToken`, `onVisitorToken`, `authAssertion`, `authAssertionHeader` |
| server | `none`, `bearer`, `creator`, `agent.required`, server-callable webhook-policy routes | visitor-token routes | `bearerToken`, `agentCredentials` |

Never ship creator bearer tokens, agent credentials, provider API keys, or
external auth signing secrets to browser code.

## Browser Usage

```ts
import { createAuggyClient } from "./auggy-client";

const api = createAuggyClient({
  baseUrl: "https://agent.example.com",
  visitorToken: () => localStorage.getItem("auggyVisitorToken") ?? undefined,
  onVisitorToken: (token) => localStorage.setItem("auggyVisitorToken", token),
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
  // Match webTransport.externalAuth.header when it is customized.
  authAssertionHeader: "x-auggy-auth-assertion",
});

const services = await api.get("/services");
if (services.ok) {
  services.data;
}
```

`authAssertion` is for app-signed visitor assertions from a normal app login.
The browser client forwards the assertion with `x-auggy-auth-assertion` by
default; set `authAssertionHeader` to the same non-reserved `x-*` header as
`webTransport.externalAuth.header` when customized. It does not create or
verify assertions.

## Server Usage

```ts
import { createAuggyClient } from "./auggy-client.server";

const api = createAuggyClient({
  baseUrl: process.env.AUGGY_BASE_URL!,
  bearerToken: () => process.env.AUGGY_BEARER_TOKEN,
  agentCredentials: () => ({
    agentId: process.env.AUGGY_AGENT_ID!,
    agentSecret: process.env.AUGGY_AGENT_SECRET!,
  }),
});

const result = await api.post("/admin/reindex", {
  body: { reason: "manual-refresh" },
});
```

This direct call is for a trusted backend job, not a public pass-through route.
Keep server clients in server-only code. If a publicly reachable route handler
uses one, it must independently verify the host application's session, require
an explicit operator/admin role, compare `Origin` to a fixed configured
application origin, and validate a session-bound CSRF token before resolving
credentials or calling Auggy. Middleware, CORS, `SameSite`, and Auggy's bearer
check do not authorize the browser caller to the host application.

The fail-closed Next.js example is
`assets/templates/nextjs-server-client/admin-reindex-route.ts.txt`. Its session
and CSRF stubs deny until replaced with the application's server-side
implementations. Trusted cron and queue workers should call the generated
server client directly rather than invoke that HTTP route.

## Calling Routes

```ts
await api.get("/health");
await api.get("/services", { query: { category: "hair" } });
await api.get("/services/:id", { params: { id: "svc_123" } });
await api.post("/leads/create", { body: { email: "a@example.com", need: "quote" } });
```

No-input routes allow no input argument. Routes whose input only has optional
fields also allow no input argument. Routes with path params, required query
fields, or bodies require input.

Every route also accepts request options:

```ts
await api.get("/health", { signal });
await api.get("/services", { query: { category: "hair" } }, { headers });
```

## Results

The generated client does not throw for non-2xx HTTP responses:

```ts
const result = await api.get("/services/:id", { params: { id: "svc_123" } });

if (result.ok) {
  result.data.name;
} else {
  result.data; // unknown
}
```

It can throw for local/runtime failures such as missing required params,
missing required credentials, network failures, or malformed JSON responses.
