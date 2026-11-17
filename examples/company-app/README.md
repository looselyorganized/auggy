# Company application → independently deployed Auggy agent

This optional Next.js reference shows an application's verified session becoming
narrow business authority in its own Auggy agent. The browser calls that agent
directly through AG-UI. The application and agent are separate services, with
separate deployments and upgrade cycles. Another company installs and configures
another agent with different signing material and audience.

The checked-in app intentionally cannot authenticate a user. Its server-only
session adapter is unconfigured and assertion issuance returns 503. There is no
demo login, identity selector, shared Auggy hosting service, or role-to-creator
mapping. Connect your existing session verifier at the designated boundary.

## Trace a request

```text
company-app/
├── src/app/page.tsx                       UI composition
├── src/components/support-chat.tsx       send, streaming, interrupted, retry
├── src/client/agent-run.ts                fresh assertion → direct /agent/run
├── src/app/api/auggy-config/route.ts      runtime public agent origin only
├── src/app/api/auggy-auth-assertion/route.ts
├── src/server/composition.ts             application-owned wiring
├── src/server/session-adapter.ts         YOUR trusted session verifier
├── src/server/company-policy.ts          YOUR authoritative permission adapter
├── src/server/assertion-handler.ts       Origin/CSRF → verify → policy → sign
├── agent-integration/
│   ├── agent-yaml.fragment.yaml           ingredient for a CLI-created agent
│   └── orders/
│       ├── index.ts                      augment schemas, tools, routes, checks
│       ├── contracts.ts                  narrow company service interface
│       └── service-client.ts             bounded HTTP adapter
├── fixtures/
│   ├── session-adapter.ts.fixture        isolated acceptance overlay only
│   └── synthetic-orders.ts               synthetic records and effect journal
└── tests/                                authorization and failure controls

your-generated-agent/                     created separately by auggy create
├── agent.yaml                            generated composition + orders ingredient
├── src/index.ts                          generated execution entrypoint
├── src/agent.ts                          generated application construction
├── src/http.ts                           visible POST /agent/run dispatch
├── src/turn.ts                           guarded turn orchestration
└── src/augments/orders/                  copied owned ingredient above
```

1. The browser asks its own app for a short-lived assertion. The route checks
   exact configured Origin and CSRF headers before calling the session verifier.
2. `session-adapter.ts` returns canonical identity from your existing trusted
   verifier. `company-policy.ts` consults authoritative company permissions
   separately. Browser JSON, unsigned cookies and model output grant no authority.
3. `auggy/auth` signs a fresh, single-use 60-second assertion carrying explicit
   audience, key ID, scopes, grants, and policy version. The browser sends it only
   to the configured agent in `x-auggy-auth-assertion`, with credentials omitted.
4. The generated agent's HTTP transport admits `POST /agent/run`, derives a
   `public` / `recognized` principal, and submits the turn to the runtime. Trace
   its generated entrypoint into the installed `auggy` source when inspecting
   admission, scheduling, tool dispatch or persistence.
5. The orders augment owns each tool and HTTP route's schema and authorization.
   Both use the same narrow company order-service adapter. That service checks
   current authoritative ownership/permissions again before reading or applying
   a synthetic effect. Application support/admin roles never become Auggy creator
   or gain operator endpoints.

## Run the application

Use the repository's pinned Bun version to install this isolated example. Next's
production server runs on Node.js. This source checkout references the local
Auggy workspace; portable acceptance substitutes the actual packed npm artifact.
When copying the application into another repository, replace the workspace
dependency and local provider overrides with an exact compatible Auggy artifact
or release. The published 0.5 package does not contain this checkout's new
`auggy/auth` entrypoint or managed replay implementation.
Next.js is a dependency of this optional application, not the Auggy runtime.

```sh
cd examples/company-app
bun install --frozen-lockfile
cp .env.example .env.local
bun run dev
```

Set `APP_ORIGIN` to the exact browser origin and `AUGGY_AGENT_URL` to your separate
agent's HTTP(S) origin, without a path, credentials, query or fragment. The browser
loads this URL at runtime from `/api/auggy-config`, so deploying to another hostname
does not require rebuilding the frontend. Keep all signing and service credentials
server-only; do not use `NEXT_PUBLIC_` for them. Use HTTPS for deployed endpoints
and your company's trusted private connection to its order service.

Replace the exported `null` in `src/server/session-adapter.ts` with a
`VerifiedSessionAdapter` that calls your existing server-side session verifier.
Return `null` for invalid/missing/expired sessions; throw for unavailable verifier
infrastructure. Never decode a browser-provided identity into a trusted session.
The policy adapter must derive narrow grants from your company records, separately
from session verification. There is no default wildcard or privileged fallback.

## Add the owned capability to a generated agent

Create the agent using the supported CLI, inspect its generated `src/index.ts`
and `src/agent.ts`, then copy `agent-integration/orders/` to its
`src/augments/orders/`. Merge `agent-yaml.fragment.yaml` into the generated YAML;
it is deliberately not a complete alternative scaffold. Preserve the generated
application contract and engine configuration, and replace its existing web
declaration rather than adding another listener.

Set the same explicit `AUGGY_AUTH_AUDIENCE`, `AUGGY_AUTH_KEY_ID`,
`AUGGY_AUTH_SECRET` and exact `APP_ORIGIN` in the relevant services. Configure the
agent's allowed provider to match your verifier. Set the agent's `AUGGY_AGENT_ID`
to its generated immutable `agent.yaml` ID, as required by the ingredient's
`securityNamespace`; do not reuse another company's identity. Keep `AUGGY_WEB_TOKEN` only with
the agent operator; it is never returned to the browser. The order-service URL
and token are server configuration in both services. Do not put credentials in
agent guidance or model-visible files.

The ingredient enables managed SQLite assertion replay. Before local startup,
prepare an explicit private root and run the generated application through its
managed host:

```sh
# From the generated agent project; choose a NEW dedicated directory once.
mkdir -m 700 ../support-agent-state
export AUGGY_DATA_DIR="$(cd ../support-agent-state && pwd)"
auggy state inventory --config agent.yaml
auggy run --no-open
```

Include the absolute `AUGGY_DATA_DIR` in the agent service's environment on later
starts. Startup does not create or chmod an unsafe generic root. Relative database
paths map beneath this root; inspect the inventory rather than assuming the
database is always the root's direct child. An existing agent needs an explicit
state migration before switching roots. See
[storage admission](../../docs/16-storage-layout.md#explicit-runtime-data-root).

The example uses one single-replica agent with SQLite assertion replay and durable
run state. Its business service owns effect state independently. Persist the agent
volume and use Auggy's [backup and restore procedure](../../docs/27-runtime-state-recovery.md).
Do not clone live databases into a second active replica.
Assertion replay, keyed run state, company effect journal, console history, and
browser transcript are distinct stores; one does not make the others durable.

Enable only immutable, non-private guidance in this reference. Remove any shared
mutable customer memory from the generated composition until it has a verified
identity partition. Private orders stay in the company service and enter a turn
only after deterministic authorization. The UI transcript is ephemeral in this
tab; refreshing clears it. Console persistence is a separate runtime feature and
does not imply a durable history API for this browser.

For Docker export, the custom orders augment requires an explicit profile:

```sh
auggy export docker --config agent.yaml --out ../support-agent-image \
  --ingress http --port 8080
```

Build and provision the dedicated volume using the
[deployment guide](../../docs/18-deploy.md). The app can be deployed separately
with its own Node server and configuration. Upgrading local Auggy updates the
runtime and bundled built-ins. Separately installed capabilities such as
`@auggy/link`, and provider packages, follow their own manifest and lockfile
selections. These updates do not rewrite either service's owned adapters or
execution source.

## Synthetic policy and delivery behavior

The test service owns synthetic customer A/order A and customer B/order B records.
The support principal may read order A and simulate a refund on order A up to
5,000 cents. The app-admin account has an explicit read grant only; a supplied
admin/support role adds no permission. Tools and routes check action, exact order
and amount independently. The SQLite fixture journals simulated effects atomically
and returns the prior receipt for an identical operation after restart. No money
moves. This fixture is not a production refund integration or system of record.

Each user action creates one operation key. If delivery stops, **Retry delivery**
requests a fresh assertion while preserving that key and the original request.
**Stop receiving** stops the browser reader; it does not cancel an admitted agent
operation. An unknown effect outcome requires operator reconciliation, and the UI
does not automatically repeat it. Changed identity, grants or request content
cannot retrieve another operation's authorized result.

After an offline restore, reconciliation and external-assertion readiness are
separate. Managed replay retains a restore epoch and denies assertions until the
current maximum TTL plus 30 seconds have passed from that epoch (90 seconds for
this ingredient). Restart cannot skip the hold, and increasing TTL can reopen it.
The guard applies before returning a saved operation response. Raw volume snapshot
rollback needs the separate offline recovery or old-key-removal procedure.

## Verification and fixtures

```sh
bun test tests
bun run typecheck
bun x tsc -p tsconfig.tests.json --noEmit
bun x next build --webpack
bun run start
```

The Bun-only augment/fixture tests have a separate TypeScript configuration so the
Next server imports only the pure `auggy/auth` entrypoint and narrow HTTP adapter.
Webpack is the production build path used by this reference's verification. Unit tests do not
replace the separate real-browser and packaged-generated-agent checks.

Browser acceptance makes a separate isolated source copy and replaces exactly
`src/server/session-adapter.ts` with the static
`fixtures/session-adapter.ts.fixture`. Record source/overlay/lock hashes and
`buildKind: fixture-auth`; the checked-in app remains `production-reference`.
Production bundle checks must exclude `M5_FIXTURE_AUTH_BUILD_V1`, fixture cookie
and registry identifiers, and synthetic private record markers.

The fixture adapter reads a private ordinary `0600` file from
`AUGGY_FIXTURE_SESSIONS_FILE`. Its format is
`{ "version": 1, "sessions": [{ "cookie": "<random 64 hex characters>", "session":
{ "provider": "fixture-app", "userId": "customer-a", "orgId": "synthetic-company",
"roles": ["customer"] } }] }`. Allowed subjects are `customer-a`, `customer-b`,
`support-agent`, and `app-admin`. The harness seeds the opaque
`auggy_fixture_session` cookie out of band. No route issues sessions and no
production environment flag enables this adapter. A real IdP is not certified
by this fixture.

`createSyntheticOrdersStore(dbPath)` and
`createSyntheticOrdersHandler(store, token)` let the acceptance harness own its
loopback listener, persistent temporary journal, private bearer token and cleanup.
Its fixed POST endpoints are `/authorization`, `/orders/read`,
`/refunds/simulate`, and the test-only `/fixture/journal`. No live provider,
customer data, refund API, or hosted service is required.
