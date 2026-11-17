# M5 hosted scenario runner

User decision: replace the private monolithic rehearsal with a smaller tracked
runner while preserving the required assertions. This supersedes the private
executor/controller/generated-CLI-guard implementation, not M5's acceptance scope.

## Execution

```sh
# Local package verification and export only; no Railway calls or login required.
bun scripts/release-smoke/hosted-runner.ts \
  --scenario polling --input /absolute/fixture-input.json --out /private/tmp/new-preflight

# One authorized isolated hosted scenario; always attempts owned-resource cleanup.
bun scripts/release-smoke/hosted-runner.ts \
  --scenario polling --input /absolute/fixture-input.json --out /private/tmp/new-run --execute
```

Select `http`, `polling`, `recovery-http` or `recovery-polling`. There is no coupled
`all` scenario. A consumed output directory is never reused. Results from separate
scenarios remain independent and identify their selected runtime package digests.
Provider effects require `--execute` and the operator's authorized task context;
credentials alone are not approval. Existing one-hour execution ceiling, ten-minute
cleanup reserve, owned resource caps and $5 monitored target remain ceilings.
For a batch, keep the sum of actual execution time/spend inside the authorized
batch allowance; a new scenario is not permission to reset exhausted budgets.

Inputs describe existing test-only consumers prepared by the installed-CLI
integration fixtures, not an ordinary customer's project:

```json
{
  "version": 1,
  "workspaceId": "00000000-0000-4000-8000-000000000001",
  "revision": "0000000000000000000000000000000000000000",
  "baselineConsumer": "/absolute/http-baseline/consumer",
  "editedConsumer": "/absolute/http-edited/consumer",
  "maintenanceConsumer": "/absolute/http-maintenance/consumer",
  "environmentFile": "/private/fixture.env",
  "knownHostsFile": "/private/known_hosts",
  "packages": [
    { "name": "auggy", "path": "/absolute/core.tgz", "sha256": "0000000000000000000000000000000000000000000000000000000000000000" },
    { "name": "@auggy/anthropic", "path": "/absolute/provider.tgz", "sha256": "0000000000000000000000000000000000000000000000000000000000000000" }
  ],
  "maxSeconds": 1200
}
```

The revision identifies the selected unpublished runtime candidate. The runner
checks package hashes and installed package source against those archives once
during preparation. It copies consumers into its own private work directory and
uses the actual installed CLI's exporter. It does not recursively re-attest every
transitive dependency, rewrite locks, build approval closures or synthesize the
managed deployment manifest. Baseline/edited/restored variants retain agent ID.
Only the known loopback provider fixture model is admitted.

The fixture environment and SSH trust pin stay private. Hosted execution copies
the existing native Railway identity into a private HOME with no project links,
registers a fresh workspace SSH key, creates a new private project and never
selects an existing application project. Native key files and copied dependency
trees are removed when remote cleanup succeeds. Failed cleanup retains the private
recovery inputs and reports it explicitly. Readable redacted evidence remains.

## Ownership and failure policy

- Lifecycle rows allocate one service/volume; recovery allocates original and
  recovery services/volumes for one channel. Workloads run sequentially.
- Existing provider schemas validate responses. Placement, one replica, `NEVER`
  restart policy, disabled sleep, 4 vCPU/4 GB and the observed 50000 MB volume
  default are checked. The default is capacity, not proof of used disk space.
- Volume creation is observed to strict attachment within a bounded wait. Pending
  state is never permission to deploy. Failed creation is not repeated or adopted
  by name. Uncertain mutations remain visible even if parent cleanup succeeds.
- Deletion requires the exact created project/service/volume IDs and a fresh
  complete inventory; foreign attachments block destructive parent cleanup.
- Installed `auggy deploy` is invoked directly. Its platform/HTTP readiness must
  be ready/not-applicable as appropriate. Saved target and actual provider domain
  readbacks must agree; polling must have no public domains.
- Exact-instance SSH uses the existing pinned-host arguments and bounded remote
  command envelope. Receipts bind request/input/source identity. Failed commands
  retain their bounded redacted output before being rejected; they are not retried.
- Every scenario stops and checks fixture quiescence and exact stopped instance.
  Railway does not provide an application exit code; the runner does not invent one.
- `finally` runs cleanup after partial allocation or assertion failure. Execution
  and cleanup outcomes are separate. Logs are captured before deletion where
  available; log capture failure is recorded without preventing resource cleanup.

## Coverage

HTTP: authenticated streaming/tool operation, zero duplicate/unauthorized effects,
owned-source change, state continuity and completed response replay after replacement.
Polling: actual fixture adapter/model/tool/reply, identity denial, no ingress,
source change, duplicate protection after replacement and quiescent stop.

HTTP recovery backs up before the newer downstream effect, restores onto a fresh
owned destination and reconciles that newer effect without replaying it. It checks
the auth hold across restart, no work during hold, real expiry while stopped,
expired assertion rejection and completed replay/new work after the hold.
Polling recovery backs up after confirmed updates 1/2/3, restores the exact replay
namespace and verifies duplicate 1 produces no work while new update 4 does.

The recovery fixture accepts `+` in ordinary contained bundle paths. Its explicit
fresh-destination operation may remove only a sole empty owned `lost+found`
directory; nonempty content, links and unrelated entries are refused. This is
offline test preparation. Runtime startup preserves populated volumes, and the
public restore command still requires an empty destination. No product command
or storage layout has been added by this harness replacement.

## Implementation and verification gates

1. `hosted-runner.ts`: argument handling, local-only default and final result.
2. `hosted-scenarios.ts`: readable lifecycle ordering and unconditional cleanup.
3. `hosted-context.ts`: deadlines, bounded processes, private/redacted evidence.
4. `hosted-railway.ts`: existing wire contracts plus owned allocation/readback/cleanup.
5. `hosted-channels.ts` and `hosted-driver.ts`: reuse existing channel/recovery assertions.

Before hosted use, require typecheck/lint, scenario-order/failure tests, actual
failed-child redaction, stubbed provisioning/deletion/unknown-outcome/foreign-volume
tests and real local exports. The Linux before/after reproduction additionally
verifies the narrow backup and fresh-destination restore correction.

First hosted use is the outstanding polling lifecycle, not another four-service
experiment. Record its failure or success and cleanup once. A failure stops that
row and gets a specific diagnosis before further hosted work. HTTP replacement
and both recovery rows remain distinct required acceptance work. M5 closes only
after those rows, integrated review, final CI and CodeQL findings disposition.

The first hosted polling lifecycle has now passed its operation, replacement and
shutdown assertions with verified owned-resource absence. Its original aggregate
result retains a post-deletion telemetry failure; see the
[evidence assessment](./milestone-5-polling-evidence-2026-11-16.json).
Generated project names are capped at 32 characters before allocation. Usage is
collected before deleting the project; telemetry warnings never prevent cleanup
of resources whose ownership is established. Failed/ambiguous resource deletion
continues to fail cleanup. No more live runs were used to test those corrections.

## Principal adversarial review

The smaller scenario runner is the right boundary. Keep production storage,
authentication, shutdown and deployment architecture unchanged. Three concrete
test defects warranted correction before the outstanding hosted rows:

| Finding | Failure mode | Narrow correction |
|---|---|---|
| High: phase evidence writes could throw outside protected work | Cleanup could be skipped, or a scenario with missing evidence could report success | Protect phase recording; always attempt driver cleanup; retain the original failure and fail acceptance when evidence recording fails |
| High: a rebuild was inside the 210-second restored-auth hold | Build speed could consume the security observation window and produce an inconclusive failure | Use one bounded restart of the existing deployment/image during the hold; require the exact deployment and a new singleton running instance |
| Medium: timing assumptions and auth failures were underspecified | A mismatched fixture or unrelated 503 could be mistaken for the expected recovery behavior | Validate the 180-second fixture TTL and durable stores before allocation; require the auth error JSON and bounded Retry-After, followed by expired-token rejection and successful fresh work |

The restart is a test-only provider operation. Railway's
[CLI source](https://github.com/railwayapp/cli/blob/master/src/commands/restart.rs)
and [restart documentation](https://docs.railway.com/cli/restart) establish reuse
of the existing image. The source also shows that `--json` returns after the
restart request, so its exit status is not readiness evidence. The runner binds
the acknowledged deployment ID, verifies the same image digest and waits for a
different running instance with no other active instance. Terminal historical
instances are permitted; live or duplicate identities still fail. It checks the
old instance's quiescence marker, then uses a fresh signed assertion to observe
the persisted hold. After sealing and stopping, the hold expires with workloads
stopped. Only the later, post-hold deployment may rebuild.

`external_auth_unavailable` is also used for unavailable auth storage. Its body
alone does not prove a restore hold. Evidence must combine the restored guard
epoch, bounded hold observations before/after restart, zero model/domain work,
unchanged epoch, expired assertion rejection, and successful post-hold operation.
Existing local tests cover exhaustive security negatives; do not repeat them all
on Railway. A timeout or wrong image/instance is an inconclusive failed row,
never permission to retry a mutation or change production behavior.

### Remaining hosted execution

Run unaccepted rows independently in this order, preserving accepted lifecycle
observations. All use the already verified runtime candidate and existing
fixtures; a harness-only change does not require repacking the runtime.

| Row | Required proof | Maximum allocated resources | Current result |
|---|---|---|---|
| `http` | Installed CLI readiness, authenticated stream/tool effect, edited-source replacement on the same volume, state/completed replay continuity, quiescent stop | One service and volume | Passed, 229 seconds, verified cleanup |
| `recovery-http` | Baseline stopped backup, newer downstream effect, restore/reconcile on a fresh volume, persisted auth hold across same-image restart, real expiry, replay and new work, quiescent stop | Two services and volumes, workloads sequential | Failed at missing fixture initialization; corrected locally, no retry |
| `recovery-polling` | Back up confirmed deliveries 1/2/3, restore/reconcile the exact namespace, duplicate 1 does no work, delivery 4 succeeds, no ingress, quiescent stop | Two services and volumes, workloads sequential | Not run after HTTP recovery failure |

Each row ends with exact owned-resource deletion and complete absence readbacks.
One failure stops that row, retains diagnostics and triggers a narrow diagnosis;
there is no automatic repeat or new resource batch. Preserve the existing shared
time/spend allowance. After all rows, complete integrated review, final revision
CI and CodeQL findings disposition. M5-07/09/10 remain open until those gates pass.

Review verification: focused fault-injection/provider/auth-contract tests,
repository typecheck and lint, and a real `recovery-http` local preparation/export
with no Railway calls. The new restart path is locally verified, not yet hosted
certified. This review created no hosted resources and changed no product source.

Subsequent execution is recorded in the
[hosted evidence](./milestone-5-hosted-evidence-2026-11-16.json). The recovery run
exposed a missed fixture lifecycle step: every fresh restored/restarted peer must
initialize its current downstream checkpoint before the held probe and seal.
The corrected shared operation checks generation identity and checkpoint
continuity, then rejects any model/domain work. A local regression uses the real
fixture to reproduce the old 400 and prove both corrected process lifetimes.
Local focused suites pass 82 tests / 970 assertions; no product code changed.
The failed hosted result and complete cleanup remain recorded, and both hosted
recovery rows remain open.

### Targeted initialization verification

The approved follow-up retains correction `ea05e7a7` and adds real-fixture negative
controls: wrong generation/checkpoint prevents the probe, and actual model/domain
activity rejects acceptance. The two affected fixture suites passed 23 tests /
462 assertions; repository typecheck and lint passed. All 28 CI checks passed on
the corrective commit. The follow-up changes tests/documentation only; hosted
runner source and the selected runtime archive remain identical to that commit.

Execute one `recovery-http` row with fresh isolated resources and existing limits.
Retain first-hold evidence, verify the same-image restart and real hold expiry,
then require replay/new work and quiescent stop. Always verify exact owned-resource
cleanup. No automatic retry or product change follows a failure. Polling recovery
and final M5 review remain separate work.
