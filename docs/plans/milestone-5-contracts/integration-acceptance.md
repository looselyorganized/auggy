# M5 contract C3/C4 — application integration and execution evidence

Status: contract candidate, prepared before G0. This document does not authorize
producer implementation, hosted resources, credentials, or acceptance of its own
author. Root freezes the contract after independent review.

Planning evidence is reviewed M4 commit
`32d7265d0659d5911755e802d18a9f9077b80196` in the `inspectable-authoring`
worktree. The M5 preparation worktree started at main
`911fe1682c76208c1d99d4dc6841bfcaa608dd8d` and is now rebased onto merged M4 main
`c39b746b4b743e5c29dab61a677026c10626d8b8`. Its reviewed repair `56de4e3` rejects
ambiguous tool names before inference/dispatch without changing these integration
interfaces. G0 is accepted; M5-00 interface/ownership freeze remains pending
before producer work.
See [execution plan](../milestone-5-execution-2026-11-13.md),
[deployment contract](./deployment.md), and
[storage/replay contract](./storage-replay.md).

## 1. Product boundary and execution paths

One company owns one independently installed agent project, deployment, secrets,
durable state, and upgrade decision. A second company owns a separate installation.
There is no shared-company backend, customer provisioning service, tenant router,
or managed agent platform in this milestone.

The agent is the deployable unit. It may expose HTTP/AG-UI, run Telegram polling,
use both, or use a future channel. Next.js is an optional application consumer.
A Telegram-only worker requires neither a Next.js application nor an HTTP listener.
Deployment profiles describe required ingress; they do not enable channels or
replace their authentication. Unknown/custom channel topology requires an explicit
profile under C2. Do not infer a listener from the mere existence of an agent.

The two required paths are inspectable from owned project source:

```text
Optional company application
browser -> application assertion route -> existing session verifier + company policy
browser -> own Auggy POST /agent/run -> transport authentication -> shared turn/tool path
                                               -> owned augment/domain adapter

Standalone polling agent
Telegram protocol -> telegramTransport polling -> existing Telegram identity mapping
                   -> shared turn/tool path -> owned augment/domain adapter
                   -> actual Telegram client serialization -> protocol response
```

Generated `src/index.ts`, `src/agent.ts`, HTTP configuration, turn program, and
custom augment source retain the M4 ownership model. The installed Auggy runtime
continues to own protocol validation, turn machinery, and security enforcement.
Do not copy the runtime into the generated project or introduce a second worker
bootstrap. The existing generated host can start with an empty HTTP configuration.

## 2. Source inventory and existing constraints

| Existing owner | Reuse and boundary |
| --- | --- |
| `examples/app-auth-bridge/{auth-assertions,app-policy,assertion-response,provider-routes,browser-client}.ts` | Assertion issuer, POST/Origin/CSRF guard, verified-session adapters, and generated-route client teaching. The new reference is provider-neutral; the existing vendor union is not a core restriction. |
| `examples/app-auth-bridge/orders-augment.ts` | Existing scopes/grants vocabulary and route/tool authorization. Its static order map and synthetic refund response are not proof of an authoritative business system. |
| `src/auth/external-auth.ts` | Existing assertion signing/verification, audience/key rotation, principal derivation, scopes/grants/authzVersion, and replay-store interfaces. |
| `src/transports/web-transport.ts` | Existing `POST /agent/run`, AG-UI SSE, assertion header, idempotency binding, cancellation and console history behavior. Preserve this wire contract. |
| `src/augments/telegramTransport/index.ts` and sibling polling/replay modules | Actual channel lifecycle, identity mapping, durable update claim, conflict quarantine, polling offset and shutdown. |
| `src/telegram-client.ts` | Actual Bot API serialization and HTTP boundary; already accepts an HTTP client in `createTelegramBotClient`. |
| `src/scaffold-templates/application/` | Actual M4 generated bootstrap/composition/turn/HTTP source. Files become available on the accepted M4 baseline. |
| `scripts/release-smoke/application-consumer.ts` and `authoring-*` | Bounded consumer lifecycle, package/source identity, source edit observations and installed artifact acceptance. Extend these primitives instead of creating an unbounded parallel harness. |

Two traps must remain explicit:

1. Telegram's existing `_clientFactory` test hook selects an in-memory replay
   store when a replay store was not supplied. Replacing the client through that
   hook cannot prove normal production SQLite persistence.
2. Public AG-UI durable operation/effect replay is not automatically durable
   conversation history. In the reviewed source, `runHistoryPersistence` is
   selected only for console metadata. The reference's ephemeral UI history is
   not durable operation replay. Record the exact persisted stores for each
   scenario. Test thread binding and denial of prior responses separately.
   Public transcript restoration is outside M5; a future persistent application
   transcript would need an app-owned store and a separate contract. Do not add
   kernel history persistence to satisfy this acceptance matrix.

## 3. Optional application-owned verifier and policy

M5-05 owns a small reference under `examples/company-app/`. This path contains
the optional Next.js app, its own manifest/lock, browser client, and README; it is
not a runtime dependency of Auggy. Root integrates new manifests and locks.
Agent-side owned augment source is a separate reference ingredient consumed by
an actual CLI-generated project in acceptance, not a hand-written replacement
scaffold.

The app-local integration contract is:

```ts
import type { AuthorizationGrant, AuthorizationScope } from "auggy";

export interface VerifiedAppSession {
  provider: string;
  userId: string;
  email?: string;
  emailVerified?: boolean;
  orgId?: string;
  roles: readonly string[];
}

export interface VerifiedSessionAdapter {
  verify(request: Request): Promise<VerifiedAppSession | null>;
}

export interface DerivedAuggyAuthorization {
  scopes: readonly AuthorizationScope[];
  grants: readonly AuthorizationGrant[];
  authzVersion: string;
}
```

`verify` runs only on the application server. Its implementation must call the
application's existing trusted verifier/session lookup and return canonical
server-verified identity and roles. It must not accept identity, roles, resource
ownership, grants, or trust from request JSON, browser state, unsigned cookies,
or model output. `null` means an invalid/missing/expired session. An unavailable
verifier or configuration error must not be treated as anonymous authorization.
The reference's default verifier is deliberately unconfigured.

A separate company-owned `deriveAuggyAuthorization(session)` consults the
company's authoritative record/permission adapter. It derives narrow actions,
resources, constraints, and a policy version. Reuse Auggy's existing types rather
than creating another grant format. No default wildcard grant or role-to-creator
mapping is allowed. `orgId`, when present, retains existing identity semantics;
it is not a new shared-company tenancy scheme.

Application principals become Auggy `public` / `recognized` principals.
Application administrators/support staff receive explicit business grants and
remain `public` / `recognized`. Auggy creator credentials remain an operator
boundary and must never be returned to the browser.

### Assertion route behavior

Use `POST /api/auggy-auth-assertion` in the optional app and the existing signing
helper. Reference TTL is 60 seconds; audience, key ID and signing material are
explicit server configuration. Generate a fresh `jti` for each issuance and
carry existing scopes, grants and authzVersion. Never log the assertion.

| Condition | Required behavior |
| --- | --- |
| Non-POST | 405 with `Allow: POST`; no verification, policy lookup or signing. |
| Missing/invalid application-origin configuration | Configuration failure, 503; no assertion. |
| Cookie issuance without exact allowed Origin or required `x-auggy-csrf-request: 1`, or with disallowed fetch-site | 403 before session verification; no assertion. |
| Verifier unconfigured | 503; no assertion, model call, tool call or fallback identity. |
| Verifier returns null | 401; no assertion. |
| Verifier/policy throws | Sanitized failure; no assertion. Do not disclose session or signing data. |
| Valid verified session + successful policy | Short-lived assertion only; no application session secret or creator credential. |

All route responses, including denials, use private/no-store caching, legacy
no-cache defense, `Vary: Cookie, Authorization, Origin`, and nosniff, consistent
with the existing guard helper. Reject an origin with credentials or malformed
syntax. Identity verification and policy lookup remain separate so engineers can
trace exactly where application trust becomes Auggy authorization.

### Production and deterministic fixture separation

The checked-in reference must build with the unconfigured verifier and fail
closed. There is no environment variable that enables a production demo login,
no public `login-as-user` endpoint, and no browser identity selector.

Browser acceptance builds a separate, isolated source copy. The harness may
replace exactly the designated server-only session-adapter composition module
with a static fixture adapter and supply a server-only identity registry. The
registry maps random opaque test session cookies to deterministic principals;
the harness seeds cookies out of band through browser contexts. Fixture identity
is never derived from client-supplied user IDs or roles. No fixture route issues
cookies to arbitrary callers.

Record the checked-in source hash, exact allowed overlay path, fixture source
hash, lock hash, and build kind (`production-reference` or `fixture-auth`). This
overlay is an explicit test input, not an unrecorded modification to a supposedly
unchanged production artifact. Production dependency/import/bundle checks must
exclude the fixture identity module and marker. Verify the unconfigured
production build's issuance failure separately from fixture-auth success.

The hosted browser test may use only the explicitly approved isolated fixture
build and private fixtures. Its result certifies the adapter contract and protocol
path; it does not certify a real identity provider. Wiring a company's actual
verifier is a clearly documented application responsibility. A live IdP canary
is separately authorized and cannot be inferred from M5 implementation approval.

## 4. Direct browser AG-UI and the one-company policy example

The application exposes only the public agent URL needed by its browser through
runtime configuration. Keep the URL deployable without rebuilding a frontend
bundle for each hostname. Signing secrets, session-verifier configuration and
fixture registry stay server-only. Validate the configured URL; never accept a
browser-provided destination for assertions.

The browser requests an assertion from its own app with its ordinary app session,
then calls the independently deployed Auggy `/agent/run` directly with
`x-auggy-auth-assertion`. Do not send app cookies to Auggy, put assertions in URLs,
persist them in localStorage, or put them in browser telemetry. Configure Auggy's
existing CORS boundary for the exact app origin and required headers. Exercise
preflight, allowed origin, rejected origin, and absence of unsafe reflection.
The generated custom-route client is not assumed to implement AG-UI streaming;
reuse the actual run/SSE protocol explicitly.

Client states are `connecting`, `streaming`, `completed`, `failed`, and
`interrupted`. The first content chunk must be observed before completion in a
real browser. Handle HTTP auth/config errors before SSE, streamed failures,
malformed/truncated streams, disconnect, and component cleanup without leaving
unbounded readers or issuing repeated effects.

One user action owns one operation key. A delivery retry obtains a fresh
single-use assertion and reuses that operation key. Browser disconnection is
not cancellation of an already admitted keyed durable run. Do not silently
create a new operation for a retry or automatically repeat an outcome-unknown
effect. Existing reconciliation remains explicit. Reuse must respect the
existing identity, content and authorization binding; changed grants or another
principal cannot retrieve a previously authorized response.

The reference demonstrates synthetic orders owned by customer A and customer B
within one company, plus an explicitly authorized support principal. The owned
augment contains schemas, tools, routes and explicit authorization; shared domain
logic sits behind its narrow order-service adapter. The test backend keeps an
effect journal and authoritative synthetic record ownership. No real refund is
performed, and the README must not present this backend as a system of record.

Required controls cover:

- A may read A's order; B may read B's. Neither may enumerate or retrieve the
  other's private record by route, tool, prompt, supplied thread ID or replay key.
- Support's exact order/action/amount constraint succeeds once; missing grants,
  wrong resource, exceeded amount and forged roles produce zero business effects.
- Tool and route paths invoke the same owned business service with authorization
  enforced for each exposed interface. Tool authorization does not authorize an
  unrelated route automatically.
- App support/admin does not acquire creator-only tools or operator endpoints.
- Shared guidance/memory contains no private customer record. Inventory every
  enabled memory store and its identity partition. Denied records must not enter
  model-visible context or another user's stream. Do not enable shared mutable
  customer memory as a shortcut.
- A second independently configured deployment rejects deployment A's assertion
  using different audience and credentials. Test wrong audience and wrong key
  independently. This is a negative control across installations, not a shared
  service with company tenants.

Use a minimal real application UI with existing Auggy registry primitives and
theme tokens. Follow repository UI guidance when implementing it; a missing
primitive is handled through the registry rather than an ad hoc design system.
Include accessible send/error/interrupted states and a screenshot of synthetic
content. No frontend implementation is part of contract preparation.

## 5. Standalone Telegram protocol fixture

The acceptance seam is beneath the actual Telegram client, at its HTTP boundary.
It must retain the real augment lifecycle, Bot API body serialization, polling,
identity mapping, shared turn/tool execution, reply/error handling and normal
SQLite replay-store selection. Do not replace the augment, kernel, Telegram
client factory or replay store with a fake for this acceptance row.

Root's reviewed disposition: use a fixture-only network overlay, with no new
production option, export, augment wrapper or resolver hook. The original
option-hook proposal was unreachable through ordinary generated composition:
the host resolves built-ins before composing the agent. Source review instead
confirms that Telegram's normal `createHttpClient` uses `operator-configured`
policy and dynamically calls global `fetch` through `src/http.ts`.

The harness adds a static fixture-owned network module and an explicit startup
installation call in the generated `src/index.ts`, before normal
`runApplication`/host preparation. Root freezes the exact allowed overlay paths
at M5-00. In that owned child only, capture native fetch and install a wrapper
that forwards actual requests to the private HTTP protocol fixture. Match the
exact Telegram origin, dummy-token path, allowed Bot API method and HTTP method;
reject every other Telegram destination/token/method. Keep other fixture
destinations explicitly bounded. Preserve the actual body, headers, abort signal,
manual redirect behavior and response/error semantics; do not synthesize Bot API
success in the wrapper. Never supply a live token or log token-bearing paths.
The fixture control plane remains private.

Keep the normal built-in YAML entry, resolver, admitted paths, Telegram client,
HTTP client and SQLite-selection branch unchanged. Do not set `_clientFactory`.
Prove that serialized requests traverse the packed `src/http.ts` implementation
and that ordinary SQLite file/namespace selection persists across restart.
An absent overlay must fail the fixture preflight before launching the channel;
test that negative control without contacting Telegram. Restore captured fetch
on fixture teardown, and terminate/reap the owned child on every exit path.

The installed/generated consumer uses only exact packed packages. Record the
fixture module and startup changes as allowed, hashed source overlays; production
artifacts exclude them and their installation call. Worker export and startup use
the same generated host and durable root as normal execution.
No Next.js process, HTTP transport, public domain or fabricated health URL is
present in this scenario.

Required observations are:

1. Actual `getUpdates` request serialization, successive offsets, delivered
   update, mapped identity, deterministic model/tool request, domain effect,
   and serialized reply are correlated in a bounded fixture journal.
2. The existing configured private-chat creator ID can use an intended
   creator-only fixture tool. A recognized/anonymous noncreator and that creator
   in a group do not gain creator trust. Preserve admitted-agent mapping too;
   do not reuse web assertions as a replacement Telegram identity scheme.
3. Duplicate update delivery and process/container replacement with the same
   durable directory do not duplicate the effect. Prove SQLite files/identity
   and post-restart replay behavior; fake-client counters are insufficient.
4. Same delivery identity with conflicting payload and uncertain downstream
   mutation trigger the existing conflict/quarantine/reconciliation behavior.
   After reconciliation the harness checks the allowed outcome and verifies
   no unapproved repeated effect.
5. Editing the owned turn/domain source changes observable output and its
   source hash after the corresponding restart/rebuild. An unedited/wrong
   marker fails the assertion. Polling has no fabricated HTTP-handler edit row.
6. Shutdown aborts polling and fixture requests, releases local resources,
   closes owned replay storage, and reaps bounded child processes.

This is actual HTTP protocol and lifecycle evidence for the packaged channel.
It is not evidence of connectivity to Telegram's live network. A real bot/model
canary requires separate explicit authorization, credentials and effect bounds.

## 6. Artifact and test matrix

Every scenario consumes actual CLI-created projects outside the checkout and
installs the exact packed core/providers under test. Resolve the CLI entrypoint
from those packages, verify dependency paths and record hashes. No workspace
link, repository import, copied `node_modules`, host bind mount of implementation,
global package fallback or registry fallback may masquerade as the installed
artifact. Record allowed dependency-path materialization separately from owned
source changes; preserve C2's manifest/lock and frozen-build rules.

Maintain the existing M4 15-observation source-edit matrix: startup, HTTP and
turn edits across the five established launch paths. Do not replace it with a
new shallow smoke or multiply every browser/hosted case by all 15 combinations.
M5 adds focused container/hosted source-edit proof for relevant owned HTTP,
turn and domain paths. Container changes require a new exported context/image
identity; hosted changes require a new deployment identity and observed marker.

| Evidence row | Required execution and oracle | Dependencies |
| --- | --- | --- |
| A01/A03 baseline | Actual generated and installed application, retained M4 source-edit matrix, direct/local/global/legacy durable-root admission and no pre-admission effects | M4, M5-01 |
| A02 artifact | Pure export preservation/refusal tests plus real frozen Docker install; altered/stale lock and escaping dependency negative controls | M5-02 |
| A04 standalone HTTP | Agent with no app: assertion-to-AG-UI execution, real owned tool effect, chunk before terminal, targeted source edit | M5-01/02/04 |
| A05 optional app | Real Next production-reference build fails closed; separate fixture-auth build, real browser cookie-to-assertion-to-direct-SSE, error/interruption and production fixture exclusion | M5-04/05 |
| A06 policy | A/B same-company record/thread/tool/route/memory controls, bounded support action, creator boundary, separate-deployment audience/key rejection | M5-04/05 |
| A07–A09 replay/recovery | Fresh assertion for each retry; atomic single-use consumption, persistence, hold/clock tests, grant/identity change, disconnect and outcome-unknown effects | M5-01/04 and C1 |
| A10 polling | Real installed HTTP protocol seam, current trust mapping, SQLite update replay, replacement, conflict, source edit, shutdown | M5-01/02/06 |
| A11 worker | No ingress/domain/URL invented, honest startup versus channel execution, record migration/readers | M5-03/06 |
| A12 real Docker | Both HTTP and polling images execute; replacement retains named state; singleton competition and offline backup/restore/reconcile use exact inventory | M5-01–07 |
| A13 actual Railway | Separate HTTP and worker deployment, redeploy/recovery, source/image/deployment identity, actual channel operation and owned-resource cleanup | M5-03/07, hosted gate |
| A14 final integration | Docs/template parity, registry assets, required suites/build/lint/typecheck/audits, existing PG17 boundaries and full-branch CodeQL/findings | M5-08–10 |

Use `bun:test` for TypeScript unit/integration tests, including browser scenarios
driving the real browser through the Playwright API. Do not introduce a separate
test runner. Browser dependencies remain isolated in the reference/harness; a
mocked fetch or jsdom assertion cannot satisfy A05. Root resolves and audits
Next.js/browser dependency versions at implementation and owns manifest/lock/CI
changes. A real Docker daemon is required for A12; if unavailable locally,
execute on Linux CI and retain actual image/run evidence. `docker --version`,
Dockerfile inspection and a fake process are not container acceptance.

Generic Docker and Railway are independent rows. The app is not a prerequisite
for standalone HTTP or polling acceptance. A successful process start is not
channel execution, and an HTTP health response is not an authenticated turn.
Record startup, health and channel success separately. A worker may truthfully
report `execution-unverified` before its protocol proof.

Restoration scenarios identify every persisted store and claim only tested
semantics: assertion replay, durable run/effect state, Telegram update replay,
configured memory, and any separately supported history store. Use C1's restore
epoch, clock high-water and hold contract without inventing another recovery
API. Inspect state only after quiescence when required by existing backup tools.

## 7. Bounded fixtures, readiness and evidence

Reuse M4 bounded process, file and artifact helpers. The inherited application
defaults are readiness 60 seconds, scenario 120 seconds, shutdown 15 seconds,
reap 5 seconds, captured output 2 MiB, source read 2 MiB, artifact source files
128, and artifact bytes 256 MiB. The authoring limits remain 128 source files,
2 MiB per source / 16 MiB total, 64 KiB manifest, 16 KiB specifiers, 4096
characters per specifier/argument, 32768 per source edit, and 64 argv entries.
Do not quietly loosen these global limits to make a failing integration pass.

Add explicit finite bounds for each new phase:

- Local readiness requests have a 5-second cap within the 60-second readiness
  budget. A slow request cannot reset the whole deadline. Health redirects
  cannot escape the configured origin. Platform deployment budgets are set by
  C2/the approved hosted gate and are distinct from local process readiness.
- Every browser navigation, stream, fixture HTTP call and long-poll operation
  has a timeout and abort path. A scenario never waits indefinitely for a
  response, selector or terminal SSE event. Polling delays/timeouts are fixture
  inputs; do not change production defaults merely to speed up tests.
- Fixture request bodies and journal reads are bounded. Default maximum body is
  256 KiB, event count 1000 and journal bytes 2 MiB per scenario. Overflow fails
  the scenario rather than dropping the earliest events used by the oracle.
- Use temporary directories with private permissions, bounded ordinary-file
  reads and containment checks. No symlink escape, alias or user-supplied code
  interpolation. Keep fixture source static and pass values as data.
- Own child-process groups, abort controllers, browser contexts, fixture server
  handles and resource IDs. Use a `finally` cleanup path for success, assertion
  failure, readiness failure and interruption. Measure deadlines honestly;
  disclose bounded polling overshoot instead of claiming a hard OS deadline.

Each stage (`local`, `container`, `hosted`) is individually runnable and emits a
versioned bounded evidence record. Root owns the shared evidence format and
top-level harness integration. At minimum the record contains:

| Field group | Required content |
| --- | --- |
| Identity | Scenario ID, run ID, source SHA/tree/dirty state, toolchain, lock hashes, packed package hashes, installed package resolution/hashes, profile and build kind. |
| Changes | Baseline source manifest, exact allowed overlay/edit paths, before/after hashes, observed marker and failing wrong-marker control. |
| Execution | Redacted command/argv, phase deadlines, exit/status, first-chunk and terminal observation, principal classification, authorization decision, effect/duplicate counts and replay outcome. |
| Platform | Export-context hash, image identity, platform deployment/service/volume identifiers as applicable, state identity, startup/health/channel results and restore/reconcile observations. |
| Disposition | `passed`, `failed`, `unavailable`, or `not-run`; reason, independent reviewer, teardown result and exact retained-artifact inventory/expiry. |

Evidence must not contain full environment dumps, auth headers, signed assertions,
cookies, bot-token URLs, session registry values, private keys, or raw browser
storage/network captures. Prefer assertions on safe metadata and hashes.
Screenshots use only synthetic content. Keep detailed artifacts private with
0600 records / 0700 directories where supported; sanitize any CI summary.
Disable tracing/HAR capture that would retain credentials unless a separately
reviewed redaction path exists. Report dropped/truncated output explicitly.

Cleanup removes only resources created for the recorded run. No global Docker
prune, wildcard process killing, guessed service deletion or unrelated volume
removal. A cleanup failure is visible evidence, with owned identifiers and a
bounded recovery action. Retaining a failed fixture is an explicit retention
decision, not the default justification for leaving hosted resources running.

## 8. Ownership, tests and dependency handoffs

These are exclusive assignment boundaries for root to freeze after G0/G1.
Existing shared files are not concurrently assigned merely because two packages
need them.

| Owner | Exclusive producer scope | Handoff / required review |
| --- | --- | --- |
| M5-05 app integration | `examples/company-app/` app/server/client/UI source and colocated reference tests; proposed agent-side order fixture source | VerifiedSessionAdapter/policy contract, production fixture exclusion, browser states, route/tool ownership proof. Root integrates manifests/locks and any shared example/template changes. |
| M5-06 channel specialist | Fixture-only network overlay, protocol fixture and focused channel tests; no production Telegram hook | Must demonstrate the packed HTTP/client path and normal SQLite selection. Root approves exact startup overlay paths; M5-07 independently accepts installed behavior. |
| M5-07 acceptance specialist | New bounded integration consumer/browser/Telegram/container/hosted scenario modules and static fixtures under release-smoke/tests | Consumes accepted producers. Root owns common helper edits, script registration, CI, evidence schema and lock integration. |
| M5-04 security/storage | External-auth replay storage/restore implementation and focused security tests | Supplies stable C1 fixtures and recovery operations; does not own browser UI or channel identity mapping. |
| M5-08 documentation | Reference narrative, public guides, generated teaching/template parity after behavior stabilizes | Readme explains exact endpoint → transport → turn → augment path, app verifier responsibility, profile/readiness limits and live-provider exclusions. |
| M5-09 reviewer / root | Independent attacks, integration acceptance and ledger decisions | Producers cannot accept their own work. Root resolves contract/shared-source conflicts and records exact accepted artifacts. |

Relevant regression owners already exist at
`tests/auth/external-auth.test.ts`,
`tests/transports/{web-transport,managed-web-transport}.test.ts`,
`tests/integration/app-auth-bridge-generated-client.test.ts`,
`tests/skills/app-auth-bridge-template.test.ts`,
`tests/telegram-client.test.ts`,
`tests/augments/telegram-transport.test.ts`,
`tests/augments/telegram-transport/{polling,webhook,replay-store}.test.ts`,
`tests/integration/telegram-transport.test.ts`, and M4 `tests/scripts/authoring-*`.
Add focused assertions to the owning tests rather than substituting example-only
coverage for transport authorization or durable-state tests. Shared starter
skill assets and packaged builder templates remain synchronized through their
existing parity tests.

M5-05 and M5-06 may prepare against frozen interfaces in parallel. Their installed
acceptance waits for M5-01/02/04 as indicated above. M5-07 may prepare its scenario
oracles early but may not certify unmerged producer drafts or replace missing
features with permissive fixture behavior. Any need to change kernel behavior,
public trust types, generated bootstrap, restore protocol or package versions
is escalated to root with a concrete boundary reason before editing.

## 9. Hosted gate and completion claims

Before creating, updating or deploying any Railway resource, root must obtain
and record the exact isolated target and authorization envelope:

- Railway project/environment and intended owned service names/IDs; account
  access verified read-only without choosing an existing production target.
- Resource count/size limits, dollar/spend limit, maximum run time, teardown
  owner, and retained artifact/resource duration and location.
- Approved private fixture connectivity, allowed destinations, fixture owner,
  cleanup path and credential handling; no arbitrary public fixture endpoint.
- Which exact image/source/build kind is deployed, which synthetic identities
  and domain effects are allowed, and whether any resource may be reused.

Missing inputs block hosted actions and A13. Continue independent local/container
implementation; do not infer approval from available credentials or an existing
Railway project. Hosted source/deploy/recovery evidence must include the actual
HTTP and polling profiles; a container pass or platform health check cannot
complete this milestone.

No live Telegram, real IdP or paid model call is implied by deterministic fixture
acceptance. No resource is created during this contract preparation. M5 merge,
package version changes and npm publication remain separate release decisions.
Final status must distinguish prepared contracts, reviewed producers, installed
proof, real containers, hosted proof and final certification, including every
failed, unavailable and not-run row.
