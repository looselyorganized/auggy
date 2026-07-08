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

## Target Split

| Target | Includes | Omits | Credentials |
| --- | --- | --- | --- |
| browser | `none`, `visitor.optional`, `visitor.required` | `bearer`, `creator`, `agent.required`, webhook-policy routes | `visitorToken`, `onVisitorToken`, `authAssertion` |
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
    const res = await fetch("/api/auggy-auth-assertion", { credentials: "include" });
    if (!res.ok) return undefined;
    return (await res.json()).assertion;
  },
});

const services = await api.get("/services");
if (services.ok) {
  services.data;
}
```

`authAssertion` is for app-signed visitor assertions from a normal app login.
The browser client forwards the assertion with `x-auggy-auth-assertion`; it
does not create or verify assertions.

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

Keep server clients in server-only code: backend jobs, SSR/server actions,
trusted API routes, and agent-to-agent callers.

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
