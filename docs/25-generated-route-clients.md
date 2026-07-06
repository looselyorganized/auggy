# Generated Route Clients

Auggy can generate a self-contained TypeScript client for deterministic HTTP
routes declared by augments. The generated file is intended for app frontends,
SSR handlers, jobs, and integration code that call an Auggy app backend without
hand-writing route strings, auth headers, and request-shaping code.

The generated client is not a package export. `createAuggyClient` is emitted
inside each generated file and should stay generated until the app-backend
client shape has survived real templates and examples.

## Generate a Client

```bash
auggy routes [name] --client ts --target browser --out src/auggy-client.ts
auggy routes [name] --client ts --target server --out src/auggy-client.server.ts
```

`--target` defaults to `browser`. Without `--out`, the generated TypeScript is
printed to stdout.

Related route artifact commands:

```bash
auggy routes [name]
auggy routes [name] --json
auggy routes [name] --openapi
```

`--json`, `--openapi`, and `--client` are mutually exclusive.

## Target Split

Generated clients are split by caller environment because route auth modes are
not interchangeable.

| Target | Included routes | Omitted routes | Credential config |
| --- | --- | --- | --- |
| `browser` | `none`, `visitor.optional`, `visitor.required` | `bearer`, `creator`, `agent.required`, webhook-signature policy routes | `visitorToken`, `onVisitorToken`, `authAssertion` |
| `server` | `none`, `bearer`, `creator`, `agent.required`, webhook-policy routes that are otherwise server-callable | visitor-token routes | `bearerToken`, `agentCredentials` |

Do not ship creator bearer tokens or agent credentials to browser code. Browser
clients intentionally do not generate config fields for those credentials.

Webhook-signature policy routes are omitted from browser clients even when their
route auth mode is `none`. These routes are public to provider infrastructure,
not public to arbitrary browser callers.

## Browser Usage

```ts
import { createAuggyClient } from "./auggy-client";

const api = createAuggyClient({
  baseUrl: "https://store.example.com",
  visitorToken: () => localStorage.getItem("auggyVisitorToken") ?? undefined,
  onVisitorToken: (token) => localStorage.setItem("auggyVisitorToken", token),
  authAssertion: async () => sessionStorage.getItem("auggyAuthAssertion") ?? undefined,
});

const services = await api.get("/services");

if (services.ok) {
  services.data;
}
```

Use `authAssertion` for app-signed visitor assertions, such as a normal app
session bridged into Auggy visitor auth. The generated client only forwards the
assertion with `x-auggy-auth-assertion`; it does not create or verify the
assertion. Do not put assertion-signing secrets in browser code. See
[`26-delegated-authorization.md`](./26-delegated-authorization.md) for
copyable Supabase/Clerk assertion recipes and the route `requires` model. See
[`examples/app-auth-bridge`](../examples/app-auth-bridge/README.md) for a
runnable generated-client bridge.

Visitor-token routes can issue a fresh `x-visitor-token` response header. When
that happens, the browser client calls `onVisitorToken` and also returns the
token on the result.

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

const queued = await api.post("/admin/reindex", {
  body: { reason: "manual-refresh" },
});

if (queued.ok) {
  queued.data;
}
```

Use the server target for backend jobs, SSR/server actions, trusted API routes,
and agent-to-agent callers. Do not bundle a server-target generated file into
browser code.

## Calling Routes

Generated clients use route-path literals:

```ts
await api.get("/health");
await api.get("/services", { query: { category: "hair" } });
await api.get("/services/:id", { params: { id: "svc_123" } });
await api.post("/leads/create", { body: { email: "a@example.com" } });
```

No-input routes allow no input argument. Routes whose input only has optional
fields also allow no input argument. Routes with path params, required query
fields, or bodies require input.

Every route also accepts request options:

```ts
await api.get("/health", { signal });
await api.get("/services", { query: { category: "hair" } }, { headers });
```

Generated input types come from the route manifest:

- `params` from route path params and `params` schemas.
- `query` from route query schemas.
- `body` from route body schemas.

Query arrays are encoded as repeated query parameters, not comma-joined values.

## Result Handling

The generated client has fetch-like result behavior. It does not throw for
non-2xx HTTP responses.

```ts
type AuggyClientResult<TData = unknown> =
  | { ok: true; status: number; data: TData; response: Response; visitorToken?: string }
  | { ok: false; status: number; data: unknown; response: Response; visitorToken?: string };
```

Access typed response data only after narrowing on `ok`:

```ts
const result = await api.get("/services/:id", {
  params: { id: "svc_123" },
});

if (result.ok) {
  result.data.name;
} else {
  result.data; // unknown
}
```

The client throws for local/runtime failures such as:

- missing required route params
- missing required credentials for a generated route
- network/fetch failures
- malformed JSON when the response claims to be JSON

## Response Schemas

Routes can declare successful JSON response schemas:

```ts
import { z } from "zod";
import { defineRoute, json } from "auggy";

export const httpRoutes = [
  defineRoute.get("/services/:id", {
    auth: "none",
    params: z.object({ id: z.string() }),
    response: z.object({
      id: z.string(),
      name: z.string(),
      available: z.boolean(),
    }),
    handler: ({ params }) =>
      json({
        id: params.id,
        name: "Haircut",
        available: true,
      }),
  }),
];
```

When a route declares `response`, successful `result.data` is typed from that
schema. Routes without a response schema keep success data as `unknown`.
Non-2xx response data is always `unknown` until Auggy has a stable route error
protocol.

Current JSON Schema-to-TypeScript support intentionally covers the useful
middle:

- object properties and `required`
- strings, numbers, integers, booleans, and null
- arrays
- enums and consts
- nullable fields
- `additionalProperties`
- `anyOf`, `oneOf`, and `allOf`

Unsupported schema constructs degrade to `unknown`; the generator is not trying
to become a full JSON Schema compiler.

## Auth Assertions

`authAssertion` is for browser clients that need to call visitor routes using a
normal app login or an external auth bridge.

```ts
const api = createAuggyClient({
  baseUrl,
  authAssertion: async () => {
    const res = await fetch("/api/auggy-auth-assertion", { credentials: "include" });
    if (!res.ok) return undefined;
    return (await res.json()).assertion;
  },
});
```

The assertion should be short-lived and signed by trusted server-side app code.
The generated browser client sends it as `x-auggy-auth-assertion`. Auggy runtime
verifies it and resolves visitor context. The model never verifies identity from
chat claims.

Generated clients keep failed response `data` typed as `unknown`, but Auggy's
delegated auth HTTP error bodies are stable: visitor auth failures return
`{"error":"visitor-auth-required"}`, and authorization failures return
`{"error":"forbidden","reason":...}`. Narrow those bodies in app code when you
need custom UI for denied access.

Generated route clients only cover deterministic HTTP routes. Protected model
tools use the same external assertion and delegated scopes/grants, but their
resource grants bind through validated tool input rather than route params. See
[`26-delegated-authorization.md`](./26-delegated-authorization.md) for the
shared route/tool authorization contract and
[`examples/app-auth-bridge`](../examples/app-auth-bridge/README.md) for a
runnable route/tool example.

## Headers and Fetch

Both targets accept optional `fetch` and `headers` providers:

```ts
const api = createAuggyClient({
  baseUrl,
  fetch: globalThis.fetch,
  headers: async () => ({
    "x-request-id": crypto.randomUUID(),
  }),
});
```

Per-call headers merge over configured headers:

```ts
await api.get("/health", {
  headers: { "x-request-id": requestId },
});
```

## Regeneration

Regenerate clients when route paths, methods, auth modes, request schemas,
response schemas, or route policies change.

Do not edit generated files manually. The generated header includes the client
generator version and target, and lists routes omitted for the chosen target.

Commit generated clients only when they are part of an example, app template, or
application source tree that intentionally vendors generated artifacts.
