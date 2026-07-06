# App Auth Bridge Example

This example shows how an existing app login can call Auggy routes and tools
without moving app authentication into Auggy.

It demonstrates:

- Supabase-style session verification on the app backend.
- Clerk-style session verification on the app backend.
- A shared `mintAuggyAssertionForUser(...)` helper.
- Generated browser client usage with `authAssertion`.
- Route `requires` enforcement from app-minted scopes/grants.
- Collection route filtering from resource-specific grants.
- Protected tool `requires` enforcement from model-provided, schema-validated
  tool input.
- Production knobs: `keyId`, `jti`, short TTLs, replay protection, and narrow
  grants.

The provider files use small structural adapters instead of importing
`@supabase/supabase-js` or `@clerk/nextjs/server`. In a real app, pass the
provider server APIs you already trust:

- Supabase token-backed route: `supabase.auth.getUser(accessToken)`.
- Cookie-backed Supabase route: read the server session, then call `getUser()`.
- Clerk route: `auth()` and `currentUser()` from `@clerk/nextjs/server`.

## Files

- `app-policy.ts` translates app-owned roles, org membership, and entitlements
  into narrow Auggy `scopes` and `grants`.
- `auth-assertions.ts` contains the provider-neutral
  `mintAuggyAssertionForUser(...)` helper.
- `provider-routes.ts` contains copyable Supabase and Clerk assertion route
  handlers.
- `orders-augment.ts` contains Auggy routes/tools protected by delegated
  authorization.
- `browser-client.ts` shows how a generated browser client supplies
  `authAssertion`.
- `app-auth-bridge.test.ts` runs the pattern end to end.

## Run

```sh
bun test examples/app-auth-bridge/app-auth-bridge.test.ts
```

## Production Checklist

- Keep `AUGGY_EXTERNAL_AUTH_SECRET` on the app server only.
- Mint assertions with a stable `audience` matching the Auggy agent.
- Set `keyId` and keep the previous secret in `externalAuth.secrets` during
  rotation.
- Use short TTLs, usually 30-120 seconds.
- Include a unique `jti` when replay protection is enabled.
- Mint a fresh assertion for each Auggy request when replay protection is
  enabled; do not cache one assertion across calls.
- Use a shared atomic replay store when more than one Auggy process can accept
  assertions.
- Preserve roles only as context; use scopes/grants for enforcement.
- Register `onDelegatedAuthorizationDenied` for audit trails when protected
  routes or tools are denied.
