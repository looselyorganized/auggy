# Authorization, Memory, And Trust

Auggy has deterministic caller trust. The model should not decide who is
authorized from chat text.

## Caller Categories

| Trust | Meaning |
| --- | --- |
| `creator` | Runtime-verified creator/operator for this agent |
| `agent` | Admitted machine/agent caller |
| `public` + `anonymous` | Unrecognized public caller |
| `public` + `recognized` | Public caller recognized through visitor token or external auth assertion |

The creator can ask build-out questions and request allowed runtime actions.
Public visitors should not receive internal tools, config, file paths, or
secrets.

## Visitor Auth

Use `visitorAuth` when the agent should recognize a person across sessions:

```bash
auggy augment add visitorAuth
```

Use `layeredMemory` when the agent should store peer-scoped memory:

```bash
auggy augment add layeredMemory
```

Use both when repeat visitors need cross-session memory continuity.

## Learned Behavior Vs Peer Memory

`learned-behaviors.md` is agent-global behavior guidance approved by the
creator. It is not for visitor-specific facts.

Use exact `memory_write({ label: "learned", content })` only for
creator-approved global operating preferences, such as "when greeting visitors,
use this phrase."

Use topic writes for peer-specific memory:

```ts
memory_write({ topic: "preferences", content: "Sam prefers concise replies." })
```

Topic writes require a writable peer memory provider such as `layeredMemory`.
If no writable current-peer provider exists, do not promise cross-session
memory.

## External App Auth

Apps that already use Supabase Auth, Clerk, Auth0, SSO, or custom sessions
should keep that system as the source of truth.

For copyable app-backend bridge files, inspect
`skills/auggy/assets/templates/app-auth-bridge/`.

Flow:

1. Browser has a normal app login.
2. Browser asks the app backend for an Auggy auth assertion.
3. App backend verifies the session.
4. App backend computes narrow scopes/grants.
5. App backend signs a short-lived Auggy assertion.
6. Browser calls Auggy with `x-auggy-auth-assertion`.
7. Auggy verifies the assertion and enforces route/tool `requires`.

Do not put `AUGGY_EXTERNAL_AUTH_SECRET` in browser code.

## Configure Auggy To Verify Assertions

The app backend mints assertions; Auggy must also be configured to verify them.
For a normal agent project, edit `augments/webTransport/augment.yaml`:

```yaml
type: webTransport
config:
  port: 8080
  auth:
    type: bearer
    token: ${AUGGY_WEB_TOKEN}
  visitorTokens:
    agentBinding: ${AUGGY_AGENT_ID}
  externalAuth:
    secret: ${AUGGY_EXTERNAL_AUTH_SECRET}
    keyId: "2026-07"
    audience: ${AUGGY_EXTERNAL_AUTH_AUDIENCE}
    allowedProviders: ["supabase", "clerk", "custom"]
    maxTtlSeconds: 60
```

Use the same `audience`, `keyId`, and secret family that the app backend uses
when calling `createExternalAuthAssertion`. The default assertion header is
`x-auggy-auth-assertion`; override `externalAuth.header` only when a gateway
requires a different header.

Copyable config templates:

- `skills/auggy/assets/templates/app-auth-bridge/webtransport-external-auth.yaml.txt`
- `skills/auggy/assets/templates/app-auth-bridge/webtransport-external-auth.ts.txt`

## Minting Assertions

Server-side app code can use:

```ts
import { createExternalAuthAssertion } from "auggy";

const assertion = createExternalAuthAssertion({
  secret: process.env.AUGGY_EXTERNAL_AUTH_SECRET!,
  keyId: "2026-07",
  audience: "storefront-agent",
  provider: "supabase",
  subject: user.id,
  ttlSeconds: 60,
  email: user.email,
  emailVerified: true,
  orgId,
  roles,
  scopes: ["orders.read"],
  grants,
  authzVersion: "2026-07-03",
  jti: crypto.randomUUID(),
});
```

Roles can be copied into assertions for context/audit, but Auggy enforces only
explicit `scopes` and `grants`.

## Route And Tool Requires

Routes and tools can declare authorization requirements:

```ts
defineRoute.get("/orders/:orderId", {
  auth: "visitor.required",
  params: z.object({ orderId: z.string() }),
  requires: {
    action: "orders.read",
    resource: { param: "orderId" },
  },
  handler: ({ params }) => json({ orderId: params.orderId }),
});

defineTool({
  name: "lookup_order",
  description: "Look up an order the recognized visitor is allowed to read.",
  category: "business",
  input: z.object({ orderId: z.string() }),
  requires: {
    action: "orders.read",
    resource: { input: "orderId" },
  },
  execute: async ({ orderId }) => JSON.stringify({ orderId }),
});
```

Auggy checks the assertion before the route handler or protected tool runs.
Denied paths should not execute business logic.

## Denied Behavior And Audit

When `requires` fails:

- Route handlers do not run. Auggy returns `403` with
  `{ "error": "forbidden", "reason": "authorization-..." }`.
- Protected tools do not run. The model receives a tool error such as
  `authorization-grant-missing` and should explain that the app did not
  delegate that action.
- Denial reasons are one of `authorization-claims-required`,
  `authorization-scope-missing`, `authorization-grant-missing`, or
  `authorization-resource-unresolved`.
- `onDelegatedAuthorizationDenied` receives sanitized metadata: target,
  requirement, reason, and verified external-auth identifiers such as provider,
  subject, orgId, and keyId. It does not receive assertion tokens, signing
  secrets, raw request headers, or broad user profile objects.

Copyable audit hook template:

- `skills/auggy/assets/templates/app-auth-bridge/denial-audit-hook.ts.txt`

## Replay Protection

For high-risk sessions, enable external auth replay protection in
`webTransport.externalAuth.replayProtection`.

```yaml
externalAuth:
  secret: ${AUGGY_EXTERNAL_AUTH_SECRET}
  audience: ${AUGGY_EXTERNAL_AUTH_AUDIENCE}
  replayProtection:
    enabled: true
```

When enabled:

- every accepted assertion needs a unique `jti`
- reused `jti` values are rejected
- the replay store should be shared across every Auggy process accepting the
  same assertion audience and secrets
- TTL should be bounded by assertion expiry

In 0.5, Auggy includes an in-memory replay store for local or single-process
deployments. Multi-process, multi-region, or restart-resilient deployments
should provide a shared atomic store. The store operation must mean "record this
`jti` until expiry only if absent."

Copyable store template:

- `skills/auggy/assets/templates/app-auth-bridge/replay-protection-store.ts.txt`

## Supabase And Clerk

Supabase and Clerk are app auth providers. Auggy should not interpret their raw
roles directly. The app backend should verify the provider session and mint
narrow Auggy scopes/grants.

Use Supabase server APIs or Clerk server APIs only in trusted app backend code:

- Supabase: verify the current user with `supabase.auth.getUser(jwt)` or the
  app's server-side Supabase session helper. Do not authorize from unverified
  client claims.
- Clerk: use server-side `auth()` for identity/session state and `currentUser()`
  only when server code needs user profile fields. Do not pass Clerk's full
  user object to the browser.
- Custom auth: verify the app session with the app's normal backend mechanism,
  then map that user to explicit Auggy scopes/grants.

Copyable provider route-handler recipes:

- `skills/auggy/assets/templates/app-auth-bridge/supabase-next-route.ts.txt`
- `skills/auggy/assets/templates/app-auth-bridge/clerk-next-route.ts.txt`
- `skills/auggy/assets/templates/app-auth-bridge/custom-session-next-route.ts.txt`

Never verify sessions or sign Auggy assertions in browser code.
