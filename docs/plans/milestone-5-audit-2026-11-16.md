# M5 change and validation audit — November 16, 2026 (Vancouver)

Audit recorded November 17 UTC. Status: findings and recommendations; no new
hosted execution, runtime change, merge, version bump or publication in this audit.

## Decision

Railway HTTP hosting is already demonstrated on candidate `13bf80df`: deployment
and HTTP readiness, an authenticated streaming/tool operation, safe completed-run
replay, zero duplicate/unauthorized effects, fixture quiescence and exact-instance
STOPPED observation all passed. The subsequent backup-transfer failure does not
invalidate those observations. It also does not establish full M5 acceptance.

Preserve the working runtime and the populated-volume compatibility correction.
Repair demonstrated harness defects locally, retain useful phase evidence and
execute only the outstanding hosted assertions. Do not start another full
four-service rehearsal simply to re-prove HTTP startup.

## Baseline and review scope

- GitHub `main`, read through the API: `c39b746b4b743e5c29dab61a677026c10626d8b8`
  (merged M4, PR #229). The root checkout's local `main` is stale (`29147dfc`);
  it is not the comparison baseline. No experimental worktree is a baseline.
- M5 branch/PR: `feat/portable-agent-integration`, draft [PR #230](https://github.com/looselyorganized/auggy/pull/230),
  head `13bf80df4ead1bbf0b53ee0cc1b221df10868999`.
- All 28 reported PR checks were completed successfully at that exact head,
  including release rehearsal, portable integration, PostgreSQL and CodeQL.
  Successful CodeQL execution is not a fresh review of its findings database.
- Two inherited uncommitted files contain proposed recovery-fixture changes:
  `scripts/release-smoke/integration-fixtures/hosted/maintenance-command.ts` and
  its test. CI for the committed head does not cover those edits.
- Review examined the whole changed-path inventory and targeted storage,
  deployment, recovery, lifecycle, security-contract and harness diffs; this is
  not a claim of independent line-by-line security approval of the entire PR.

Committed delta from accepted M4 main:

| Area | Files | Added lines | Removed lines |
|---|---:|---:|---:|
| Product `src/` | 49 | 5,997 | 836 |
| Tests | 68 | 15,027 | 100 |
| Harness/scripts | 42 | 14,408 | 214 |
| Plans/evidence | 15 | 5,931 | 0 |
| Examples | 42 | 4,030 | 8 |
| CI | 2 | 77 | 114 |
| Other docs/configuration | 17 | 562 | 215 |

Kernel and PostgreSQL coordination source are unchanged. Root dependency lock is
unchanged. Package changes add `auggy/auth` and verification scripts; there is no
package version bump. The optional company application has its own dependencies.

## Product changes and disposition

| Change | Architectural purpose and failure boundary | Disposition |
|---|---|---|
| Explicit `AUGGY_DATA_DIR`, shared storage admission and ownership capability | Portable durable storage with the existing identity, singleton and restore fences; missing/unsafe roots fail before effects | In M5 scope. Preserve; do not redesign while finishing certification |
| Pure Docker export, lock/source/dependency manifest and deployment profiles | Reproducible consumer build; excludes credentials/state; HTTP and polling have honest ingress requirements | In scope. Preserve frozen-install and containment checks |
| Railway deployment/readiness and cloud-record v2 | Target/profile continuity, bounded platform and health waits, worker without fabricated URL | In scope. Keep platform, health and channel results separate |
| Managed SQLite assertion replay and restore epoch | Prevent consumed credentials becoming reusable after restart/restore; fail closed on unavailable state | In scope. Retain restoration/security tests; a generic snapshot is not equivalent to this protocol |
| Optional application/session-policy/assertion example | Company-owned identity and grants; independent Auggy deployment; browser streaming | In scope. Does not turn Auggy into a shared managed platform |
| Scaffold diagnostics and Alpine atomic publication | Controlled diagnostics and supported Linux no-replace operation after concrete create failures | Evidence-backed fixes. Keep scoped regression coverage |
| Console state declaration removed from disabled-console example | Inventory had required a database that the example never creates | Evidence-backed reference correction; not a reason to relax required-store checks |
| CI execution consolidation | Canonical test inventory replaces duplicate invocations; packed/browser/container and required check identities retained | Retain with inventory/aggregate contract checks |

### Volume rollback: what actually changed

Accepted M4's generated Railway shell entrypoint checked the advertised mount,
then ran `chmod 0700 /app/data` regardless of existing contents. Runtime admission
subsequently required 0700. M5's portability refactor moved initialization into
shared TypeScript admission and introduced an empty-only condition. A provider
mount containing `lost+found` at mode 0755 therefore failed before startup.

`f1392501` removes that empty-only condition. It narrows the already-existing,
owned, pinned Railway root to 0700 and retains physical identity checks. It does
not create the mount, move data, change ownership or recursively alter contents.
Generic roots remain operator-prepared. This restores the relevant observable
Railway behavior, **not** the entire previous implementation: the shared admission
refactor remains. The earlier descriptions of a complete architecture rollback
were too broad. There is no evidence supporting another volume-layout change.

### `auggy state` provenance

The command group, including inventory/backup/verify/restore/reconcile/resume,
exists on accepted `main`; its original commit is `8911993e`. M5 extends the
existing recovery protocol for portable roots and durable assertion replay.
Git history establishes provenance, not evidence of an explicit user approval
conversation. Basic hosting does not require executing backup or restore.

## Today's evidence

The two full-run attempts below occurred on November 16 Vancouver / November 17
UTC. Durations come from their immutable journals, not estimates of engineering
time or total token consumption. Raw results remain incomplete and unmodified.

| Run | UTC interval / duration | Verified outcome | Failure and attribution |
|---|---|---|---|
| `EP37Hh` | 02:41:20–02:43:33 / 133.373 s | Local exports, isolated allocation/volume binding, complete cleanup | Before upload: preparation script serialized manifest keys differently from managed CLI; exact-byte guard rejected it. Harness defect |
| `E3abkD` | 02:51:46–02:56:42 / 296.025 s | HTTP deploy/health, streaming/tool operation, completed replay, stop, maintenance startup; complete cleanup | Backup command succeeded in the Linux reproduction, but wrapper transfer index rejected `+` in `lost+found`. Harness defect; live raw receipt retained only generic rejection |

For `E3abkD`, the deployment CLI exited 0 after 80.186 s and reported platform and
HTTP readiness `ready`. The channel produced nine streaming events, one effect,
zero duplicate effects and zero unauthorized effects. Completed replay returned
the same response digest. The stopped receipt binds the same deployment/image/
instance/volume and reports one STOPPED instance. A hash-verified returned log
window contains the fixture quiescence marker and no watchdog-expiry marker.
Railway does not expose a process exit code in this proof; a successful stop
command is not a fabricated exit-0 claim. This is quiescent-fixture plus stopped-
instance evidence, not an in-flight shutdown/load test or an availability SLA.

Both attempts report project and temporary key absent, no cleanup failures and
no unknown allocations. Resource deletion did not leave an active deployment
that can be resumed. There was no live paid model, Telegram network or real IdP
certification; deterministic fixtures exercised the installed execution paths.

Local diagnosis already completed before this audit:

- Exact candidate start/stop/backup passed on macOS with `lost+found` present.
- Network-isolated Linux runtime started and exited 0; original maintenance
  wrapper failed in `safePath` while indexing the completed bundle.
- With only the test path-validator correction, the same Linux backup passed:
  four files, 49,219 payload bytes, root still mode 0700.
- The expanded Linux backup-to-restore driver was prepared but **not executed**
  before interruption. Do not describe it as passed recovery evidence.

Audit verification: 67 tests / 261 assertions across runtime-volume and hosted
maintenance passed; root typecheck and lint passed. Lint retains the known
informational Biome schema-version notice. A read-only Docker listing confirmed
the two owned backup diagnostic containers absent. No full suite or hosted run
was repeated for this audit.

Sanitized, hash-bound evidence inventory: [audit evidence](./milestone-5-audit-evidence-2026-11-16.json).
The original private artifacts remain in the recorded `/private/tmp` locations;
their hashes establish identity, not a replacement for preserving useful content.

## Findings and narrow recommendations

1. **High — test results are conflated and status records are stale.** The current
   evidence header still identifies r9 as latest, and the G4 checklist still
   requests a fresh build that has already been performed. Keep per-scenario
   status. Accept recorded HTTP evidence at its exact candidate while recovery
   and polling stay open. Update current summaries without rewriting history.
2. **High — the hosted executor is an oversized, fragile certification dependency.**
   Its three private directories contain 29 non-test TypeScript files and about
   10,211 lines, with absolute temp paths, frozen run pins and manual preparation
   steps. Four services and 90 logical actions link basic hosting to both recovery
   sequences; a recovery failure prevents the later polling check. Retain resource
   ownership, bounds and cleanup helpers. Retire this private executor in favor
   of one small tracked scenario entrypoint and record independent outcomes; do
   not build a new framework, polling service or provider-specific product hook.
3. **High — evidence handling hides root causes.** The root/controller replaces
   exceptions with generic unknown outcomes, and remote failures discard their
   redacted receipts. The live backup reason could only be narrowed through an
   exact digest reconstruction, then a local reproduction. Retain bounded,
   redacted error codes and structured receipts before cleanup. Do not relax
   secret handling or claim an unknown operation completed; no retry on ambiguity.
4. **High — a product compatibility regression was introduced during refactoring.**
   The populated-volume restriction was real and has been corrected. Preserve
   `f1392501` and existing nonempty-volume tests. Do not revert all portable
   storage work or introduce a new subdirectory/migration to solve a test issue.
5. **Medium — the recovery fixture is stricter than the working backup format.**
   Retain the one-character allowlist correction plus traversal/symlink coverage.
   Its Linux before/after reproduction is sufficient to diagnose this defect;
   another cloud deployment is not needed to establish the cause.
6. **Medium — uncommitted fresh-volume cleanup is unvalidated expansion.** The
   second draft edit removes a sole empty `lost+found` during test-only restore
   preparation. It is not needed for hosting and its Linux restore proof has not
   run. Keep it provisional. Decide explicit offline recovery preparation against
   the existing empty-destination contract before accepting or deploying it;
   startup must continue preserving provider metadata and populated volumes.
7. **Medium — portability claims need honest boundaries.** Real fixtures prove
   installed transport/tool paths, not external provider service availability.
   Generic Docker and Railway are separate adapters and acceptance rows. Do not
   make runtime storage/auth/lifecycle depend on a Railway webhook or runner.

## Completion sequence

The written [M5 acceptance matrix](./milestone-5-execution-2026-11-13.md#acceptance-matrix)
includes hosted deployment, replacement **and recovery** for HTTP and polling.
Calling the current task only startup/shutdown would silently drop agreed scope.
Splitting execution is recommended; removing assertions requires an explicit scope
decision and is not done by this audit.

1. Reconcile the recorded passed HTTP row, candidate identity and green CI into
   the current ledger. Stop retesting this row without a changed runtime boundary.
2. Finish the demonstrated fixture correction and diagnostics locally. Accept a
   deterministic generated-export comparison before any allocation. Keep private
   run snapshots immutable and preserve only the small reusable runner correction
   needed for a reproducible next run.
3. Execute bounded outstanding rows independently: HTTP replacement/persistence;
   polling startup/operation/replacement/stop without ingress; separately, HTTP
   and polling offline recovery/reconciliation. Reuse local/container coverage for
   exhaustive negatives. Retain the required hosted recovery boundary once; do
   not repeat every local negative in the cloud. Cleanup each owned allocation
   even on a failed assertion. One failure produces one diagnosis, not a chained
   sequence of speculative product changes.
4. Complete M5 integrated review, final revision CI and findings disposition,
   and PR handoff. Committed-head CI is already green; only changed boundaries
   justify additional local tests. Do not call M5 complete at a budget limit.
5. Proceed to M6's existing outcome: dependency upgrades preserve customized
   project source, and unfamiliar engineers can trace startup → ingress → turn →
   augment/tool → shutdown. Start with an upgrade compatibility matrix and one
   recorded before/after source-preservation exercise. Measure usability with
   real engineers; automated checks cannot invent that evidence. No updater
   service, runtime copy/fork or new deployment architecture is needed.

This audit recommends a smaller execution plan, not abandonment of production
coverage. Draft PR #230 remains open; M5-07/09/10 and M6 remain incomplete.

## Simpler test machinery

Retire the private executor/controller/generated-guard combination after recording
its useful results. Do not copy its 10,211 lines into the repository. Keep the
existing Bun tests, six-row packed/browser/container suite, bounded child helper,
channel assertions and the resource API/SSH helpers actually needed by the next row.
An explicit list of helpers replaces wholesale import of the old orchestration.

Use one repository-owned TypeScript entrypoint with three selectable scenarios:

| Scenario | Assertions | Resources |
|---|---|---|
| HTTP lifecycle | Installed CLI deploy/health, authenticated operation, one redeploy preserving state, stop | One isolated service and its volume |
| Polling lifecycle | Deploy without ingress, synthetic delivery/tool/reply, replacement/duplicate protection, stop | One isolated service and its volume |
| Recovery, selected channel | Stopped backup, fresh destination restore/reconcile, replay protection and return to operation | Only the original and recovery resources needed by that channel |

Each invocation follows `prepare → allocate → deploy → assert → stop → cleanup`.
Cleanup runs in `finally` and verifies the exact created IDs. Preserve unknown
outcome handling and record a failed assertion before cleanup begins. A scenario
reports pass/fail/not-run independently; a recovery failure cannot consume or
erase polling/HTTP lifecycle results. Full M5 acceptance still requires every
specified row and the final integrated review.

Preparation uses the real exporter and installed CLI, not a manually reproduced
manifest serializer. Record source revision, package digests and resulting exact
deployment/image/resource identities. Keep bounds, redaction and retained logs.
Remove generated CLI intercept shims, callback bundles, repeated recursive
inventories of every transitive dependency, giant source-closure rebuilds and the
90-action approval protocol. Those are test implementation choices, not the
agent's authentication or authorization controls. The smaller runner still
operates only on its explicitly owned isolated project and retains the approved
resource/time/cost limits.

Run exhaustive error/security permutations in the existing local tests and
containers. Hosted runs prove the actual provider boundary and state continuity.
Before the first hosted use, run the entrypoint against stubbed provisioning and
force an assertion failure to verify cleanup and useful error reporting. Then
exercise only the outstanding live row; no full CI/browser/recovery cycle is
needed to fix a startup probe. This is a proposed harness replacement, not an
implemented or validated runner in this audit.
