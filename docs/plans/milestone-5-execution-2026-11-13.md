# Milestone 5 — portable, independently deployed agents

Status: implementation authorized; preparation packet independently reviewed.
Contracts remain candidates until G0/M5-00 verification. G0 requires
separate authorization to merge M4 PR #229 and verification of resulting main.
No producer implementation starts from the open M4 branch.

## Outcome and preserved boundaries

Each company installs, owns and deploys its own Auggy project. Auggy is the
software, not a managed shared-company backend or provisioning platform.
The deployable unit is an agent. HTTP/AG-UI, Telegram and future channels are
optional communication paths; Next.js is an optional consumer, not a host or
runtime dependency. Preserve channel-specific authentication and the shared
authorization/turn/tool boundaries. Central YAML is the only enabled graph;
application source remains project-owned. Keep SQLite single-replica and
PostgreSQL coordination disabled in ordinary startup.

Deliver pure portable Docker export, platform-neutral storage admission,
channel-aware Railway deployment, durable external-assertion replay, an optional
provider-neutral Next.js integration, and actual installed/container/hosted proof.
No package version bump, npm publication, M5 merge, shared fleet, new identity
provider, or milestone 6 upgrade/DX-study claim is authorized.

Planning source: reviewed M4 head `32d7265d0659d5911755e802d18a9f9077b80196`.
Current remote main at entry: `911fe1682c76208c1d99d4dc6841bfcaa608dd8d`.
The original dirty main checkout and experiment worktrees remain untouched.
Use the isolated `feat/portable-agent-integration` worktree. Record exact accepted
main SHA/tree/lock after G0, and reconcile against the reviewed M4 source.

## Contracts

Root freezes the concrete producer interfaces and ownership map after independent
review of these preparation documents. Drafts cannot certify their own producers.

- C1: [storage and replay](./milestone-5-contracts/storage-replay.md).
- C2: [portable deployment](./milestone-5-contracts/deployment.md).
- C3/C4: [integration and acceptance](./milestone-5-contracts/integration-acceptance.md).

### Runtime, packaging and deployment

`AUGGY_DATA_DIR` is an explicit absolute root admitted through existing identity,
singleton, directory/durability and restore-fence checks before effects, across
direct generated application, local/global CLI and legacy execution. An explicit
missing or unsafe root fails without creation/ephemeral fallback. Unset preserves
local behavior. Railway still requires its advertised `/app/data`; conflicts fail.
Railway-only provisioning may narrow an already existing, pinned, owned, empty
mount to 0700 before ordinary admission; it never repairs nonempty state. Generic
roots are operator-prepared. Test fresh volumes without preconditioning their mode.
Select Railway proxy trust by explicit platform policy, never by storage pathname.
Use the existing foreground mode, not a second container/worker framework.
Retain current image UID compatibility and document volume ownership.

Add `auggy export docker [name] --config <path> --out <new-directory>` with
`--ingress auto|none|http`, optional `--port` and `--health-path`. Export never
installs, starts Docker, accesses a registry, or provisions infrastructure. Refuse
occupied output, preserve source, exclude secrets/state/receipts/dependencies and
checkout links, require a lock, and preserve manifest/lock bytes. Copy contained
ordinary project-relative dependency tarballs unchanged; reject escaping paths,
workspace links and source-directory dependencies. Actual frozen Docker install
certifies dependency freshness; no custom lockfile rewriting or registry fallback.
Retain existing Railway external-tarball compatibility with explicit diagnostics
outside portable certification, using shared staging primitives.

Profiles describe hosting requirements, not enabled channels. Auto inspects known
configuration without running factories. Known HTTP plus polling still needs HTTP;
unknown/custom topology requires an explicit profile. None rejects HTTP flags and
creates no domain, public URL, listener or health probe. Explicit HTTP describes
an existing listener; port conflicts and ambiguous public listeners fail. Custom
health paths are optional and origin-relative. Do not silently rewrite YAML or
enable a web transport. Railway must not silently delete an existing domain when
changing profile. Cloud record v2 persists the profile and nullable URL; v1 HTTP
records remain readable. Audit all console/log/status/redeploy/selection consumers.

Separate platform startup, HTTP health, and verified channel execution. Bound
each readiness request and the entire polling budget; refuse cross-origin health
redirects. Worker deployment may report execution unverified. Acceptance requires
actual channel operation, never process liveness alone. Document Railway volume
redeploy downtime rather than promise uninterrupted service.

### Optional application authentication and streaming

The reference represents one company's application and separate generated agent.
Keep Next.js dependencies in that reference. The browser receives a fresh signed
assertion from its own application and streams directly to its own Auggy endpoint.
A server-only `VerifiedSessionAdapter.verify(Request)` returns an authoritative
verified session or null; a separate company-owned resource policy derives grants.
Missing verifier fails closed as configuration error; invalid session is unauthorized.
POST-only cookie issuance validates exact Origin and CSRF header before session
verification, returns private/no-store responses, and uses 60-second reference TTL,
explicit audience/key ID, unique jti and existing scopes/grants/authzVersion.
Application administrators remain public/recognized with business grants, not creator.
Separate deployments have distinct agent identity/audience and signing credentials.
Expose only the public agent URL through runtime browser configuration.

Use order support to prove per-user record, tool, route, thread and replay access.
Keep private user data out of shared agent guidance and classify enabled memory.
Preserve optional organization identity semantics without adding shared-company tenancy.
A separate test build may use server-only harness identities, never a public
login-as-user route. Production excludes fixture identity code and rejects an
unconfigured verifier. Hosted fixture proof is not real identity-provider proof.

Preserve AG-UI SSE. Client states distinguish connecting, streaming, completed,
failed and interrupted. Browser disconnect is not cancellation of a keyed durable
run. Retry the same operation key with a fresh assertion; altered identity or
authorization cannot retrieve an unauthorized prior response. Ambiguous effects
require existing reconciliation rather than automatic repetition.

### Durable assertion replay and restoration

Add managed SQLite `externalAuth.replayProtection` with enabled protection and
`dbPath: ./data/external-auth-replay.db`. Programmatic store remains supported and
caller-owned; managed dbPath and store are mutually exclusive. Managed dbPath
requires an admitted runtime data root; absent admission fails with a remedy,
without changing project-directory permissions or silently claiming durability.
Managed transport owns opening/closing and runtime-root path resolution. Atomically consume audience
plus jti regardless of rotation key. Prune expired entries only, cap at 100,000
unexpired entries, fail closed on capacity/storage errors, and require finite
positive maximum TTL with safe timestamp arithmetic. Inventory and back up the DB.

Restoring an older DB must not revive consumed assertions. A private non-restorable
guard retains latest restore epoch and wall-clock high-water mark. Commit it before
resuming restored ingress. Deny external-assertion authentication until
`restoredAt + current maximum TTL + 30 seconds`, re-evaluating on each request/startup/config
change. Never erase the epoch after an initial hold; a TTL increase may reopen it.
Serialize validation and advancement, sampling time inside that critical section;
clock rollback fails closed. Return bounded retry information during hold. Keep
downstream-effect reconciliation independent. Fresh-host restoration requires
trusted synchronized time and cannot prove discarded clock history.
The guarantee covers Auggy's state restore protocol, not an unmanaged platform
snapshot that also rolls back the guard. Platform snapshot recovery requires an
explicit recovery/credential procedure before admitting assertions. Check guard
availability during authentication before completed operation replay; leave the
single-use consume operation after existing duplicate-request classification.

## Work packages and orchestration

Root is CTO/orchestrator. At most three specialists work concurrently; producers
cannot accept themselves. Root reserves contracts, public types, config/bootstrap,
shared restore/state interfaces, manifests/locks, CI/common harness, ledger and
status. Give each specialist an exclusive file set at assignment; shared edits
are proposed to root and integrated sequentially.

| ID | Owner / observable deliverable | Dependencies |
| --- | --- | --- |
| M5-00 | Root + architect: accepted main, contract freeze, ownership and fixture matrix | G0 |
| M5-01 | Runtime/storage: generic durable root and launch/lifecycle parity | 00 |
| M5-02 | Packaging: pure profile-aware export and frozen-build artifact | 00; integrate 01 |
| M5-03 | Deployment: Railway profiles, record migration, bounded readiness | 01–02 |
| M5-04 | Security/storage: managed replay and restore/clock guard | 00–01 |
| M5-05 | Integration: verifier adapter, company resource policy, optional Next.js | 00; integrate 04 |
| M5-06 | Channel harness: actual standalone Telegram HTTP/polling/replay path | 00–02 |
| M5-07 | Acceptance: generated/browser/container/recovery/hosted orchestration | prep 00; accept 01–06 and 08 |
| M5-08 | Documentation: portable/channel/auth/recovery/reference teaching | stable 01–06 |
| M5-09 | Independent review: integrated architecture/security/harness attacks | 01–08 |
| M5-10 | Root: final artifacts, required CI, evidence and PR handoff | 07–09 accepted |

Each assignment names baseline/contract revision, write scope, dependencies,
outcome and negative controls, verification commands, evidence and escalation
conditions. Repairs return to their producer; another reviewer rechecks them.
Preparation, scoped acceptance, installed acceptance and final certification are
distinct ledger states. Do not infer completion from plans or unit test counts.

## Acceptance matrix

| ID | Required result and falsifying controls |
| --- | --- |
| A01 | Actual CLI-created projects plus exact installed core/providers outside checkout; snapshot owned source and record allowed dependency materialization |
| A02 | Pure export preserves source/manifest/lock, refuses collisions/aliases/escaping deps, excludes private data; actual frozen build rejects stale lock |
| A03 | Direct/local/global/legacy storage admission parity; missing/unsafe/wrong-ID/restored root and duplicate owner fail before effects |
| A04 | Standalone HTTP agent executes authenticated AG-UI/tool flow without Next.js; source edits change actual execution and wrong markers fail |
| A05 | Optional real Next.js/browser assertion-to-SSE flow; chunks arrive before completion; verifier absent fails; production excludes fixture identity |
| A06 | Per-user resource/thread/tool/route/memory boundaries and separate-deployment wrong-audience/credential rejection with zero unauthorized effects |
| A07 | Atomic replay, duplicate concurrency, expiry, restart persistence, unavailable/capacity failure; no eviction of unexpired assertions |
| A08 | Restore epoch survives reconcile/restart; TTL increase, interrupted guard creation, clock rollback and high-water concurrency cannot revive assertions |
| A09 | Same operation key plus fresh assertion replays safely; disconnect does not cancel implicitly; altered grants fail; interrupted effects remain explicit |
| A10 | Real packed Telegram serialization/polling/identity/tool/reply path without app or HTTP; duplicates/restart/source edits/quarantine/cleanup verified |
| A11 | Worker export/deploy creates no ingress or fabricated URL; v1/v2 cloud readers and console/log/redeploy behavior remain honest |
| A12 | Actual container replacement retains durable state; singleton competition and offline backup/restore/reconcile are exercised |
| A13 | Actual isolated Railway HTTP and worker deployment/redeploy/recovery, source/image identity, channel operation and owned-resource teardown |
| A14 | Docs/help/generated source/registry assets agree; existing required suites/audits/PG17/full-branch CodeQL plus findings pass on final artifact/head |

Use a fixture-only startup network overlay at the existing HTTP fetch boundary,
preserving the actual Telegram adapter, HTTP client, serialization, lifecycle and
durable replay selection. No production hook or arbitrary-origin credential option
is needed. Record the overlay; fail its preflight before channel startup if absent.
Deterministic protocol evidence is not live Telegram-network certification.

Real Docker execution is required. Linux CI may supply it when the local daemon
is unavailable. Generic Docker and actual Railway rows are separate. Preserve
bounded child/request/log/fixture budgets and cleanup on success/failure, redacted
private evidence, exact source/package/image identities and source-edit controls.

## Gates, release limits and evidence

G0 merged/verified M4 main → G1 independently reviewed contracts → G2 reviewed
producers/teaching → G3 installed/browser/container proof → G4 hosted proof → G5
integrated review/final CI/artifact audit/PR handoff. No unresolved blocking finding
may be silently waived; record failures, unavailable platforms and not-run checks.

Before G4, obtain exact isolated Railway target, spending/resource limits, retention,
private fixture connectivity and cleanup ownership. No existing target is selected
by inference; no hosted mutation occurs before concrete approval. Unavailable inputs
block the hosted row, not independent implementation. A container pass cannot finish
the milestone. Deterministic model/channel fixtures are default; paid models, real
IdP and real Telegram canaries require separate explicit authorization.

Record baseline/tree/dirty state/toolchain/locks, accepted contracts, producer and
review dispositions, actual test commands/results, artifact and installed hashes,
source-edit controls, auth/effect counts, replay/restore outcomes, platform evidence,
cleanup, exact CI/CodeQL refs and final PR. Main verification must include full
CodeQL findings, not just a successful analysis job. M5 merging/publication remain
separate gates. M6 stays roadmap work.
