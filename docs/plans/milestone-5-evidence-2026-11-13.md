# Milestone 5 execution evidence

Current status: G0/G1/G3 and M5-00/01/02/03/04/05/06/08 are accepted for their
recorded scopes. Approved hosted execution on 2026-11-15 did not pass; M5-07,
M5-09 and M5-10 remain open. Earlier entries record historical gate states.

## Hosted execution on 2026-11-15

The operator explicitly approved the isolated Railway proposal. The first
attempt stopped after a successful account read: Railway refreshed its OAuth
credentials, changing a file the private executor had incorrectly frozen by raw
bytes. No hosted resource was allocated in that attempt. A narrow private harness
repair binds the stable account ID while allowing token refresh; six focused
synthetic tests and the compiled executable's preflight passed. Live API identity
readback matched the pinned account. Product source and release artifacts were
unchanged.

One retry retained the same target, artifacts, resource limits, key and relay
trust, with a shorter runtime within the original deadline. It created the
isolated project and its first HTTP service, successfully applied cap and policy
mutations, then failed service admission. No workload, volume or SSH registration
was reached. The failure receipt retained only a generic readback/binding error,
so the exact rejected field is unknown; no service-compatibility fix is claimed.

The executor confirmed project deletion. Its absence oracle then failed because
it queried deleted projects and rejected Railway's retained tombstone. Independent
complete inventory readback confirms the project is absent from active projects,
its history record has a deletion timestamp, and the temporary key is absent.
No additional hosted retry is active. Preserve service-read diagnostics and fix
the deleted-project oracle before another rehearsal; hosted acceptance remains
failed, not waived.

Private evidence: `/private/tmp/m5-g4-current-status.json`,
`/private/tmp/auggy-m5-token-refresh-review.json`, and
`/private/tmp/auggy-m5-retry1-cleanup-readback.json`. Both attempt directories and
receipts are retained. The failed frozen attempt was not rewritten or replayed.

## Focused hosted-harness repairs on 2026-11-15

The Railway adapter now retains bounded, allowlisted structural diagnostics for
service-read failures, including complete native exit-one GraphQL responses.
Failed responses remain failed. The private controller preserves service readback
before binding and records the specific failed admission predicates. CPU, memory,
replica, region, restart and identity checks remain strict. The original provider
mismatch is still unknown because its readback was discarded by the old code.

Cleanup now queries the complete active-project inventory and rejects deleted
records in that response. Preallocation continues to include project history;
workspace, owned-ID/name, pagination and unknown-allocation checks remain intact.
A separate reviewer found no blockers in these changes or the native identity
repair. Focused verification passed 44 tests/348 assertions; repository lint and
typecheck and private-controller typecheck passed. Lint retained the existing
Biome schema-version informational notice.

The exact compiled replacement passed local preflight. Its proposal uses new
project `auggy-m5-g4-2ae0a736`, the same six release artifacts, four-service/four-
volume limits, $5 monitored threshold and two-hour execution plus ten-minute
cleanup allowance. Read-only preparation verified the account and absence of the
proposed project/key. The earlier approval window expired; this candidate is
prepared, not approved or executed. No hosted acceptance is claimed.

Frozen proposal: `/private/tmp/auggy-m5-run-2ae0a736/approval-proposal.md`.
Plan SHA-256: `de51e95d827c34deaba7098ab042184a65cd3edbc76ef5f1e6b00801ff1268a9`.
Focused review: `/private/tmp/m5-g4-diagnostics-repair-acceptance.json`.
Execution handoff: `/private/tmp/m5-g4-ready-2ae0a736.json`.

## Live placement verification and volume gate

The explicitly approved `2ae0a736` run stopped before deployment because the
legacy `serviceInstance.region` readback was null; all other settings matched.
Automatic cleanup completed with project/key absence verified. Official Railway
CLI/configuration sources and live schema inspection identified explicit
`multiRegionConfig` and encrypted environment-config readback as the current
placement representation.

The focused repair sets exactly one approved region/replica, projects only the
owned service's placement from `config(decryptVariables:false)`, and applies a
shared assertion at service admission, volume preflight, upload admission and
platform checks. Missing/conflicting placement is rejected; no null-only fallback
or weaker physical-volume region check was introduced. Independent review found
no blockers; 104 focused tests/1,087 assertions, repository lint/typecheck and
both private typechecks passed.

Corrective attempt `2ae0a736-r1` retained the original execution deadline and
resource/cost/key limits. All four actual service bindings passed. It then stopped
at the first volume binding before workloads or SSH registration. Automatic
cleanup completed without failures or unknown allocations. The initial volume
readback was not retained. A later cleanup snapshot followed service deletion,
so its missing service attachment does not establish the initial failure cause.
The next narrow repair retains the initial volume readback and rejected
predicates without weakening admission or inferring a timing/attachment fix.

Evidence remains in the two attempt directories under `/private/tmp`; focused
placement review is `/private/tmp/m5-g4-placement-repair-acceptance.json` and the
current handoff is `/private/tmp/m5-g4-current-status.json`. G4 remains unaccepted.

## Volume provisioning and deployment admission

Attempt `2ae0a736-r2` retained the initial volume readback: the newly created,
owned volume had no instances after 1.15 seconds. A read before service deletion
showed its expected attached READY instance within 6.51 seconds. The private
controller now permits at most six read-only observations, with five one-second
pauses, only for that exact zero-instance provisioning state. It performs one
creation and retains every observation; the original strict binder remains the
only acceptance path. Independent review and 34 tests / 242 assertions passed.
Both original volumes subsequently passed after two observations in `r3`.

The first deployment then stopped before native domain creation or upload. The
private guard now retains separate pre-native refusal receipts and bounded,
sanitized observations before assertions. Raw errors, environment config,
variables and unfiltered deployment metadata are excluded. Independent review,
40 focused tests / 388 assertions and private typecheck passed.

Attempt `r4` identified the exact refusal: the service remained on restart policy
`NEVER`, but its inactive retry count changed from 0 to 10. Earlier native calls
only read provider state or linked local CLI configuration; none wrote this
value. The provider-side trigger for the change is unproven. Railway documents
that [NEVER disables automatic restarts](https://docs.railway.com/deployments/restart-policy).
The shared admission helper now requires strict `NEVER` without treating its
inactive retry count as enabled restarts. The setter still requests zero;
ownership, placement, replica, CPU, memory and sleep checks remain unchanged.
Regressions accept NEVER with 0 or 10 and reject ON_FAILURE and ALWAYS with either
count. Independent review, 18 focused tests / 250 assertions, repository lint and
typecheck, and both private typechecks passed.

All attempts through `r4` ended with complete automatic cleanup: owned projects
and temporary key registrations absent, no cleanup failures or unknown
allocations. No workload action completed. These repairs do not certify G4.
Corrective attempts remain inside the original 2026-11-15T23:24:39.437Z execution
deadline and 23:34:39.437Z cleanup deadline; no new two-hour window is granted.
The release artifacts remain those recorded for `3a15bb4`.

Private focused receipts are `m5-g4-volume-provisioning-acceptance.json`,
`m5-g4-pre-native-diagnostics-acceptance.json`, and
`m5-g4-effective-restart-policy-acceptance.json` under `/private/tmp`.

Attempt `r5` passed native domain creation and source upload. The public CLI was
then killed by the harness at 120,029 ms before its managed deployment record
completed. Its native status reads retained hashes, so the evidence does not
establish whether it was still building or waiting for HTTP health. Cleanup
completed with project/key absence and no unknown allocations.

The harness timing was inconsistent with the public CLI's supported 600-second
Railway wait plus 90-second HTTP readiness wait. Its separate 60-second readiness
and 105-second stop checks also started at upload, incorrectly consuming fixture
time during provider build. The focused correction gives managed deployments a
780-second supervision ceiling clipped to the original normal execution and
approval deadlines, including reap reserve. Ordinary child commands retain their
120-second ceiling. The earliest hash-bound exact-deployment SUCCESS observation
anchors a separate 105-second scheduling budget, never a guarantee of stopping
before the watchdog. The unchanged 110-second artifact watchdog remains the
runtime limit; expiry still invalidates evidence. Upload provenance and complete
upload-to-confirmed-stop log coverage are preserved with bounded output.

Upload-only maintenance readiness permits at most 120 read-only observations,
five seconds apart, within the same deployment/global deadlines. This avoids
consuming fixture time during a cold build; managed post-CLI observation retains
its existing bounds. The native CLI's 128-call limit is unchanged and exhaustion
is explicitly diagnosed. Independent review, 53 focused tests / 584 assertions,
repository lint/typecheck and both private typechecks passed. Four existing
build/process tests were intentionally not repeated. Private acceptance is
`/private/tmp/m5-g4-deployment-timing-acceptance.json`.

Only one further hosted attempt is permitted within the original deadline. On a
further failure, stop the rehearsal and report the exact blocker. No subsequent
hosted acceptance is claimed.

## Preservation and entry checks

The user authorized implementation of the approved M5 plan. Root preserved the
dirty original main checkout and all prior worktrees. New isolated worktree:
`.worktrees/portable-agent-integration`, branch `feat/portable-agent-integration`,
initially based on remote main `911fe1682c76208c1d99d4dc6841bfcaa608dd8d`.
Bun is 1.3.14. No version bump, publication, hosted resource creation or M5 merge.

Read-only GitHub verification found [PR #229](https://github.com/looselyorganized/auggy/pull/229)
open, ready for review and conflict-free at exact reviewed head
`32d7265d0659d5911755e802d18a9f9077b80196`, with all 31 checks passing.
Main remains `911fe168`, tree `d901475a9afb7a9d24dc70c21ac2480bfab78439`.
Root requested the separate merge authorization expressly required by the plan.
Three specialists produced exclusive contract documents. An independent reviewer
checked them against M4 source; root integrated the dispositions below. No product
source, package manifest, lockfile, CI configuration or hosted resource changed.
All M5-00 through M5-10 tasks remain blocked in the ledger. Preparation review is
not G0/G1 acceptance, interface compilation, or product certification.

## Preparation handoffs and independent review

| Specialist | Exclusive output |
| --- | --- |
| `m5_storage_contract` | C1 `storage-replay.md`: generic admission, managed replay, restore guard, bounded inputs, compatibility and falsifying cases |
| `m5_container_contract` | C2 `deployment.md`: pure export, ingress profiles, bounded staging/readiness, Railway records and image lifecycle |
| `m5_integration_contract` | C3/C4 `integration-acceptance.md`: optional app verifier/policy, browser flow, channel protocol proof and evidence |
| `m5_contract_review` | Read-only independent review of the packet against exact M4 source; no producer edits |

Root recorded these source-driven decisions:

- Managed replay requires the runtime's admitted, lease-backed storage capability.
  Caller-owned programmatic stores retain their existing behavior and ownership.
- The restore guard runs before a saved operation response is authorized, as well
  as before new consumption. The existing duplicate-request ordering is retained.
- The non-restored guard guarantee covers Auggy state tools. An out-of-band full
  volume snapshot can roll it back and needs explicit offline recovery or complete
  old-key removal; downstream reconciliation remains separate.
- Railway proxy defaults must follow explicit platform policy. The current
  `resolveTrustedProxies` path-equality heuristic cannot carry over to generic
  `/app/data` roots.
- Public AG-UI operation replay does not imply durable conversation history.
  The reference makes no new transcript-persistence claim or kernel change.

Independent findings and root dispositions:

| Finding | Resolution for preparation | Remaining proof |
| --- | --- | --- |
| R1: proposed Telegram option hook cannot reach the built-in resolved before agent composition | Use a fixture-only startup fetch overlay at the existing HTTP boundary. Keep normal YAML/resolver/client/SQLite behavior; no production hook or custom transport. Reviewer verified the dynamic fetch path and accepted the disposition. | Freeze exact overlay paths after G0; prove packed HTTP traversal, normal SQLite namespace/persistence, production exclusion and safe missing-overlay failure. |
| R2: strict private-root admission omitted first-use Railway volume initialization | Railway-only bootstrap may narrow the mode of an existing, pinned, owned, empty advertised mount using descriptor-based fchmod. Existing nonempty roots receive no repair; generic roots remain operator-provisioned. Reviewer accepted this bounded disposition. | Verify actual base-image UID/GID and platform mount behavior; test fresh default-mode volume and nonempty unsafe/wrong-owner/symlink refusal. |

The independent reviewer re-read the corrected passages and found no remaining
preparation blocker. Root also clarified that ordinary admission may create its
own identity/lock/probe control files before any augment or compatibility state.

Interface compilation, exact accepted-main reconciliation, image UID/GID evidence,
SQLite brand uniqueness and final ownership/path freeze remain M5-00 work. A
source review cannot substitute for those execution checks.

## Preparation validation

- `bun run lint`: passed, 641 files checked, no fixes. Existing informational
  Biome schema mismatch (config 2.5.0 versus CLI 2.5.5) remains unchanged.
- Local packet validation: six files readable as UTF-8 with final newlines and
  no trailing whitespace; relative Markdown links resolve; ledger JSON parses;
  eleven task IDs/dependencies are valid and acyclic; no accepted task/main is
  recorded while G0 is blocked.
- A repeat read-only PR check still found PR #229 open at reviewed `32d7265`,
  conflict-free, with all 31 checks passing and no merge commit.
- Product tests, typecheck, package/container/browser/hosted execution and M5
  certification were not run for these documentation-only changes.

The preparation above preceded explicit merge authorization; no elapsed time,
completed draft or available credentials was treated as approval.

## Authorized M4 merge and repaired baseline

The user authorized: “merge if no standing issues with the codebase.” Root and
`m4_merge_gate_audit` rechecked the exact PR, its required checks, review threads,
main security findings and prior certification. The retained custom-tool alias
follow-up was reproduced: `crm-lookup` and `crm_lookup` generated the same tool
name; runtime owner/dispatch maps silently selected the last owner while timeout
lookup selected the first. Merge was held until the ambiguity was repaired.

The isolated `fix/m4-custom-tool-collision` worktree produced commit
`56de4e380ffe1e39b7392eb7066c367766368321`. Specialized CLI and runtime engineers
implemented a passive canonical-name preflight and per-turn duplicate-tool
rejection. Root shared the existing scaffold normalization without changing
generated output, updated public teaching and orchestrated independent review.
The concrete ownership/dispatch bug justified the narrow kernel boundary change.

Independent repair review passed 86 tests / 332 assertions. New regression cases
failed against old behavior and passed with the repair. Strict typecheck, lint,
tracked inventory and whitespace checks passed. Forty-four generated file outputs
were byte-identical after extracting the shared naming helper. A test-only typing
failure found by full typecheck was corrected before certification.

Repaired-head certification:

- [CI](https://github.com/looselyorganized/auggy/actions/runs/43515921164) passed;
  PostgreSQL 17 registered/completed 13/13 cases on version 170010. The separate
  reference-application gate passed six tests / 62 assertions, typecheck and audit.
- [Linux release rehearsal](https://github.com/looselyorganized/auggy/actions/runs/43515921228)
  passed; artifact `14080569183` was downloaded to
  `/private/tmp/m4-collision-linux-evidence` for independent verification.
- [Full-branch CodeQL](https://github.com/looselyorganized/auggy/actions/runs/43515956526)
  passed at exact source `56de4e3`. Analysis `2164832777` reports zero open findings;
  the five inherited dismissals remain unchanged, with no new suppression.
- macOS full aggregate exited zero; manifest
  `/private/tmp/m4-collision-release.b4xqpI/evidence/release.json`, artifacts in its
  sibling `artifacts/`, and log `/private/tmp/m4-collision-release.b4xqpI/run.log`.
- The independent auditor recomputed all 427 evidence hashes on each platform
  and all six local macOS archive hashes without mismatch. All 342 packaged
  source files plus README matched the repaired checkout; 284 recorded installed
  package-file hashes across four provider adoptions matched across platforms.
  Linux candidate archives were not included in the downloaded artifact; their
  archive hashes remain CI-recorded evidence rather than locally rehashed proof.
- Seven generated consumers, all 15 source edits, 37 starts/37 clean stops,
  upgrade/recovery and owned-workspace cleanup passed. Actual macOS service
  evidence supplies the platform-specific row unavailable on Linux. Each aggregate
  has 25 clean audits; only the intentional retained-override negative control
  reports its expected two vulnerable packages.
- Core macOS archive SHA-256:
  `0b420e76b6302a29aabf1f6725d75e2fb79fb99a36f6a07361918f5f3c0cd936`.
  Root lock remains `cd4b421883d2874dba117e9410acae08207f352d99b74fcd6a9872d35afde3f7`.

All 31 final PR checks passed, with no unresolved review threads or change request.
The final independent audit recommended merging exact head `56de4e3` with no
remaining merge blocker. The PR description records the repaired-head evidence;
no documentation-only change was added to that certified source head.

Root merged [PR #229](https://github.com/looselyorganized/auggy/pull/229) at
`2026-11-13T22:13:15Z`, producing main
`c39b746b4b743e5c29dab61a677026c10626d8b8`. Its tree
`d56d32c6c4bf4b975419a37ff839587bdde35292` exactly equals the repaired head and
tested PR merge `4c3834b8e1812417e199dab7e3e75e6ea777fb4e`.
This supersedes the older M4 evidence's deferred naming-issue note.

The isolated M5 preparation commit was rebased cleanly onto that merged main
(preparation commit now `810167e`). Original dirty main and prior worktrees remain
untouched. No package version bump, npm publication, hosted mutation or M5 merge.

Resulting-main [CI](https://github.com/looselyorganized/auggy/actions/runs/43517469604)
and [CodeQL](https://github.com/looselyorganized/auggy/actions/runs/43517469468) both
passed at exact merge commit `c39b746`. Main's required PostgreSQL lane again
registered/completed 13/13 cases on version 170010 (log retained at
`/private/tmp/m4-merged-main-pg17.log`). Full-main analysis `2164894539` matches
that commit, has no analysis error and reports zero open findings.

Root accepted G0 and released only M5-00 to `ready`. No implementation task is
marked accepted; dependent producers still await compiled contracts and ownership
freeze. The six-document packet passes link, whitespace, JSON, dependency-graph
and hash validation; lint passes on the rebased tree. M5 remains unmerged and
unpublished, with hosted approval still a later gate.

The independent entry audit (`m4_merge_gate_audit`) accepted G0 after checking
ancestry/tree identity, main PostgreSQL evidence, contract hashes and truthful
task states. It confirmed no premature product acceptance or remaining entry
blocker. Main's source tree and the preparation branch's added documents are
explicitly distinguished.

## M5-00 compiled contract freeze

On 2026-11-14, main still resolved to accepted `c39b746`; frozen dependency install
completed without a lock change. Storage, deployment and image specialists worked
in exclusive files. Actual producer interfaces now live in
`src/runtime-data-contracts.ts`, `src/auth/external-auth-replay-contracts.ts`,
`src/cli/deploy/contracts.ts`, `examples/company-app/src/server/contracts.ts`, and
`scripts/release-smoke/integration-contracts.ts`. These additions contain types
and constants, not product behavior.

The checked-in compile fixture imports the actual C1–C4 modules, including the
reference/harness files outside ordinary root includes. It checks existing copier,
health and caller-owned replay compatibility; rejects forged storage capabilities,
async descriptor callbacks and worker HTTP claims; and checks new host/store/app
call shapes. Strict `bun run typecheck` passed. `bun run lint` passed 713 files
after a concurrent final-format check was rerun; only the inherited Biome schema
informational message remains. Whitespace validation passed.

The storage freeze requires a retained pinned-root descriptor, a live private
capability registry, complete configured replay-path inventory before first-use
guard creation, exact reserved pending-file recovery, and separate ordinary versus
copying-fence recovery rules. EARP identity `0x45415250` is unused in accepted
source. The deployment freeze binds bounded manifest preflight to the existing
host and distinguishes skipped/unavailable platform or HTTP checks from success.
The real Railway subprocess wrapper must support termination/reaping for deadlines.

The image specialist verified both registry image configurations and all 12 layers
without execution or extraction. Both architectures default to container UID/GID
0:0; the generator will preserve that behavior using the verified multiarch index
digest `sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0`.
See [image evidence](./milestone-5-contracts/image-baseline.md) for manifest,
configuration and layer identities and bounded methods. Local Docker's configured
socket is absent; A12 requires actual Linux CI execution. Railway mount ownership
and arbitrary-UID support are not established by image inspection.

Independent `m5_freeze_review` accepted the concrete freeze after source/API,
capability/recovery, fixture reachability, bounds, image evidence and compile-fixture
review, with no blocking findings. Root will record the immutable freeze commit
before releasing dependent producers. Product, installed/container, hosted and
final certification remain unaccepted.

### M5-00 acceptance and first producer release

Root accepted freeze commit `e0ecbf767a8c4c26a022f8a59d59c257d7a217a2` after independent review,
strict typecheck and the completed repository lint check (713 files). G1 is
accepted. M5-01 portable storage implementation and M5-07 harness preparation
are released with exclusive file ownership. No runtime behavior or installed,
container or hosted acceptance is implied by this contract acceptance.

### M5-01 portable storage producer and integration review

Implemented generic `AUGGY_DATA_DIR` admission and explicit Railway policy before
provider/augment construction. Retained root and singleton descriptors back a
private live capability; forged, copied, revoked and physically replaced roots or
lock anchors fail closed. Generic roots remain operator-prepared; only existing,
owned, empty Railway mounts may be narrowed to 0700.

Independent review found and resolved launchd shell-environment loss, restart
storage relocation, state/jobs operator root mismatch, singleton-leaf replacement,
and directory enumeration errors being mistaken for empty EOF. Runtime manifests
now record admitted storage policy; restart preserves it and refuses an unintended
change before stop. State commands load the selected project's `.env` before root
selection. Existing pre-upgrade manifests remain readable; ambiguous restarts with
a new explicit environment require an explicit stop/start. Durability probe
failures clean only their own partial files.

Verification: 113 lifecycle tests /471 assertions; 76 resolver tests /212 assertions;
91 storage, state bundle/inventory and POSIX tests /290 assertions. Total 280 tests
and 973 assertions, all passed. Strict TypeScript and scoped Biome (25 source/test
files) passed, as did whitespace checks. Lifecycle/resolver suites required local
listener access unavailable in the default sandbox and passed with that access.
The directory-read regression injects a null result with actual nonzero native
errno; ordinary empty/bounded directory reads use libc.

`m5_freeze_review` independently accepted the final candidate without blockers.
M5-07 preparation remains separate: its three evidence-validator tests are excluded
from these M5-01 totals, and its in-progress lint findings do not claim acceptance.
Actual installed/container/Railway evidence is still required.

### M5-04 managed authentication replay and offline restore candidate

The managed EARP/v1 store uses atomic audience/assertion-ID claims, a bounded
unexpired-claim capacity, complete configured database inventory, and a shared
durable guard. Guard clock sampling is serialized across handles. Restore epochs
remain permanent after downstream reconciliation, and the current TTL determines
the hold. YAML configuration requires an explicit data path and TTL; caller-owned
programmatic replay stores retain their existing lifetime and interface.

Host preflight resolves every managed replay path before factories. The transport
checks availability before authenticated saved responses and after asynchronous
waits, consumes fresh claims only after keyed operation classification, and never
downgrades a managed authentication failure to anonymous access. Backup validates
but excludes local guard state. Restore installs destination control state before
payload copy; verified interrupted resumes repair only the exact pending leaf and
preserve the original epoch. Empty and populated EARP databases pass actual bundle
inspection using the existing bounded private SQLite snapshot path.

Independent review found and resolved original SQLite URI/reserved-path handling,
statement-preparation cleanup, invalid assertions causing durable writes before
authentication, and untracked asynchronous cancellation of a denied private stream.
The final independent pass accepted the candidate, with 121 tests /592 assertions.
Root separately materialized the exact staged M5-04 snapshot, excluding concurrent
packaging edits. That snapshot passed 531 tests /1994 assertions across ten suites,
strict typecheck, and repository lint (722 files; inherited schema-version info
only). Independent and root counts overlap and are not additive. Immutable commit
capture precedes dependent release. Installed, browser, container and hosted
certification remain open.

### M5-02 portable Docker export candidate

The passive `auggy export docker` path reads bounded project inputs, classifies
known listeners, preserves manifest/lock/source bytes and contained dependency
archives, and publishes a new context exclusively. The generated image pins the
reviewed Bun image and uses generic explicit storage admission. The manifest
records source/generated/archive hashes and an identity-bound deployment profile;
runtime preflight reconciles known listeners before provider/augment effects.

Independent review resolved case-aliased private files, relocated runtime roots,
both Docker ignore filenames, Docker environment expansion in archive operands,
explicit empty configuration selection, and project preload execution before CLI
validation. The declared executable now disables Bun dotenv, project config and
automatic installation before loading CLI source. Real executable and bin-symlink
tests exercise hostile project preload configuration. Direct caller-controlled
`bun path/to/index.ts` invocation is distinct from the declared executable.

The exact staged snapshot passed 96 tests /685 assertions, strict typecheck and
repository lint (736 files; inherited schema-version info only). Independent
review passed 75 tests /527 assertions plus host preflight; these counts overlap.
The nested local-tarball fixture performs a real offline frozen Bun install and
preserves lock bytes. Export truthfully reports `buildVerified: false`; actual
Linux image, container and Railway acceptance remain open.

### M5-07 preparation mechanics and integration review

The bounded consumer, browser, Docker, hosted-plan and evidence helpers passed
31 tests /146 assertions. Independent review repaired and rechecked Docker work
cancellation, in-flight resource reservations and a separate cleanup quota. Browser
ownership uses a directly supervised Chromium group and a separate CDP driver.
These mechanics do not certify an application or platform.

Actual CLI-created Telegram acceptance then exercised the packed HTTP client,
Anthropic adapter, tool execution and durable SQLite replay. Independent adversarial
review demonstrated that the first harness could miss an anonymous-to-recognized
identity mutation and count stale polls during replacement. Root repaired full
identity/substate/thread assertions and correlated replacement delivery with a
subsequent acknowledgement poll. The independent reviewer reran a normal packed
worker (two authorized effects, zero duplicates/unauthorized effects), the broken
identity runtime (correct failure), and the stale-history control (correct failure).
All process groups were reaped. Evidence remains provisional against recorded
snapshot artifacts; the final committed-artifact run is still required.

The optional application passed independent source/security review, 14 tests /264
assertions, strict checks, a real Node production build and method/origin/verifier
HTTP checks. Fixture identities were absent from emitted production JavaScript.
Two isolated application consumers now use the exact packed pure `auggy/auth`
entrypoint, generated locks, frozen installs and clean audits. Their 77 selected
installed-file hashes per copy and lock hashes were independently verified.
Actual browser and generic-container acceptance are in progress, not accepted.

Docker Desktop was already installed but stopped. Root started it for authorized
local verification; its real server reports29.1.3. This updates the initial daemon
unavailability observation without claiming image, container or Railway success.

### Reviewed deployment and recovery checkpoints

M5-03 is committed at `e35cafb`. Independent review reproduced and required repairs
for effective Railway config overrides, validation occurring after project creation,
native descendants surviving npm-wrapper timeouts, inherited target selectors, and
alternate config identity differing from the directory's canonical identity. The
final review accepted 349 tests /1441 assertions; root's exact staged snapshot passed
375 tests /1613 assertions and strict typecheck. Repository lint passed (765 files).
Counts overlap. A final help-only clarification removed stale version language and
passed its focused regression. No Railway mutations or hosted proof were performed.

Actual Docker recovery exposed default `./data/*` paths being interpreted against
the temporary recovery mount. The additive `--runtime-root` repair, committed at
`d82af27`, separates pure final-mount topology checks from the physical `--root`
destination. Runtime mapping, stored schemas and copy/fence authority are unchanged.
Two independent reviewers accepted it. Twenty command/bundle tests /107 assertions
include real default-path backup, restore and interrupted resume. The final packed
container fixture now uses that repair; its previous root-relative run is provisional.

### Provisional execution and adversarial harness repairs

The reviewed Telegram harness is checkpointed at `214bef2`. Normal installed runs
and the identity/stale-history counterexamples described above remain valid scoped
evidence, not a final committed-artifact gate.

The optional application implementation is checkpointed at `714db5e`. Its isolated
frozen dependency installation, 14 tests /264 assertions, both TypeScript checks,
actual Node webpack production build and dependency audit passed. A clean lock
regeneration removed a stale nested Zod selection; the root lock remains unchanged.

Independent application rerun `http-8743a40a` passed standalone HTTP policy,
production reference, and actual Chromium browser rows. The authoritative journal
records production 0, HTTP 1 committed unknown effect, browser 1 support effect,
and zero duplicate or unauthorized effects. All ten diagnostic process groups were
cleaned. The browser sends three fresh assertions directly to the agent, streams
before completion and retries the same operation without a second effect. Private
fixture credentials and SQLite now remain in the workspace, outside uploaded
evidence; all 22 evidence files were checked against actual cookie/control bytes.
The deliberate crash oracle now requires the completed injection observation and
rejects real supervisor timeouts even with a false completion marker.

The directly owned Chromium launcher uses Playwright's password-store and mock
keychain flags. The earlier launcher triggered a macOS keychain prompt; root stopped
that browser and advised Cancel. No keychain reset or repair was performed. An actual startup/cleanup probe and
subsequent browser run passed. The CDP driver uses a verified Node executable;
Chromium and driver process groups remain independently supervised. Settled mobile
layout measurements show 16 px gutters without overflow; viewport screenshots
avoid Playwright's full-page scrollbar/reflow clipping artifact.

Actual provisional Docker run `container-403bebc2` passed 23 checks: frozen image
build and stale-lock rejection, private-root refusals, worker startup without
ingress, singleton competition, atomic assertion reuse, durable SQLite replacement,
offline backup/verify/restore/reconcile, and restore holds surviving replacement,
expiring, then reopening after a TTL increase. Four actual effects, zero duplicate
or unauthorized effects and complete owned-resource cleanup were observed.
Independent review then required complete bounded logs, the durability image's
actual identity, and redacted bounded diagnostics. All repairs passed 24 tests /124
assertions and independent recheck. Fresh current-artifact execution remains required.

The aggregate now verifies every packaged owned source file, including helpers
outside the selected installed-file subset, against the committed source inventory.
Generated console output is identified separately and compared with build output.
Before/after archive hashes bind that proof to the installed package. Independent
same-size mutation, missing-file and extra-file controls all fail. Exact scenario
stage, build kind, profile, observed effects, cleanup and platform identities prevent
a renamed local row from satisfying container acceptance. No hosted stage is invoked
by the local/container runner.

The repaired integration runner and CI gate are checkpointed at `69ca967`.
Root verification passed 69 harness/CI tests /433 assertions, strict typecheck
and repository lint. M5-08's eleven teaching files passed independent source
parity review; 134 local links/anchors, five actual CLI help surfaces, Markdown
structure and diff checks passed. Root clarified separate capability/provider
package upgrade ownership. These checkpoints enable the clean committed run;
they do not pre-accept its result.


### Artifact checks and integrated review after the first checkpoint

The tracked runtime/console run on `fcfd194` passed 5,755 tests with zero
failures; its 13 local PostgreSQL skips were covered by actual PostgreSQL 17 CI.
On `74249c1`, all 13 registered database cases completed against server 170010
(14 tests /60 assertions including the registration check). The separate company
app CI gate passed after the narrow browser-fetch typing repair `157132a`.

CI run 43560679799 failed and is not accepted. Its operator shard exposed two
scheduler assumptions: health polling could begin a second attempt before timer
rounding exhausted the wall deadline, and a wrapper timeout could legitimately
expire before its native child wrote a PID. `fe97c60` makes the former assertion
use an injected clock advanced by the real abort, and checks every actually
started process in the timeout case. Abort and overflow variants still require
both processes. Production deadlines and process-group cleanup remain unchanged.
Root's related focused run passed 117 tests /296 assertions; independent review
accepted these changes.

Generic storage-recovery containers passed on macOS and Linux, including the
physical recovery directory versus final runtime mount fix. The aggregate's
canonical scenario identity was corrected in `74249c1`; historical artifacts
were not rewritten. App/browser certification remains open. A local diagnostic
rerun passed all three application rows, but did not explain away the earlier
failure. New bounded sanitized diagnostics identified Linux's subsequent failure
as the browser driver's shared writable Node executable. Runtime selection repair `c7e56c2` is independently accepted: safe native
installations retain their relative library layout, while shared writable
executables are copied into the private workspace with the same verified hash.
Actual native Node execution and the focused controls passed. A fresh complete artifact run is still required.

`eaa76e5` adds the separately required actual polling-container row to A12.
Independent real Docker runs observed the normal result (two authorized effects,
zero duplicates/unauthorized effects), a rejected replay-bypass mutation with one
duplicate effect, and a rejected recognized-user-to-creator mutation with one
unauthorized effect. All owned images, containers and volumes were cleaned.
Replacement uses a new protocol journal and must observe actual duplicate delivery
followed by a later acknowledgement; persisted TGRP identity, claims and namespace
are read after writer shutdown. Violation counters use the independently expected
delivery phase, not runtime-reported trust or a successful-run total. This scoped
acceptance does not substitute for the final aggregate or hosted run.

Preliminary integrated product review found a private-state leak in the explicitly
unfrozen external-runtime-archive deployment branch. Custom extensionless managed
replay/idempotency stores and nonempty mutable memory could enter its upload
context. The repair shares portable export's raw declaration inventory and staged
source checks; focused regressions cover stores, sidecars, logs, writable mounts,
empty/nonempty seeds and changes during staging. Independent review accepted the repair after 166 tests /1,085 assertions and
a separate actual `runDeploy` counterexample: the mocked upload contains no
extensionless idempotency database or sidecars, original files remain unchanged,
and nonempty mutable memory refuses before any Railway access. No hosted upload
was used in reproduction. This integrated source finding is closed.

`39ee525` repairs stale passive-inspection teaching in the public docs, generated
README and all three starter-skill copies. The shell helper disables Bun local
configuration preloads as well as environment loading and automatic installation.
A real CLI preload trap passes. The cloud-record example now validates as version2
with immutable agent identity and explicit ingress profile. Independent review
accepted this teaching/test repair (21 tests /215 assertions including cloud-record
checks).

Full branch CodeQL run 43560734516 on `74249c1` completed analysis 2166381175:
103 rules, five results, no analysis errors or warnings. Four previously dismissed
findings remain unchanged. New alert130 (`js/insecure-temporary-file`) flags the
source read in `src/cli/deploy/bundle.ts`: it uses `O_RDONLY | O_NOFOLLOW |
O_NONBLOCK`, with no creation/truncation/write flag. Destination creation separately
uses `O_WRONLY | O_CREAT | O_EXCL` and0600. Root and independent review triage this
as a false positive; no flag was weakened and no alert was dismissed. Final-head
analysis remains required. See [alert130](https://github.com/looselyorganized/auggy/security/code-scanning/130).

### Hosted gate remains open

Read-only Railway discovery failed because the existing login expired. Root asked
the operator to renew login without sharing credentials; authentication does not
authorize hosted changes. No project/environment target has been selected and no
hosted resource was changed. Independent preparation also identified real remaining
engineering: private fixture/control connectivity, exact environment binding,
quiescent backup/restore maintenance, ancillary-resource approval binding, and
recording the actual remote image identity when Railway builds approved source.
The current hosted helper validates proposals/approval; it is not a hosted executor.

The final proposal must bind exact target IDs, source and artifact hashes, named
resources, verified CPU/memory/volume limits, deadlines, cost enforcement, retention
and cleanup. A monitored project spending target is not a provider hard cap;
workspace-wide billing limits cannot be changed under project-only approval.
Accepted local/container evidence and a reviewable concrete action manifest must
precede the separate hosted approval request. A13, M5-07, M5-09 and M5-10 remain
unaccepted. Draft [PR230](https://github.com/looselyorganized/auggy/pull/230) is not
ready to merge or publish.

Root strict typecheck, repository lint (767 files) and tracked test inventory
(372 runtime, 34 console, 8 isolated external tests across 17 shards) pass on
the settled repair source. No dependency lock or package version changed.


### Committed 3363581 execution and second harness repair pass

Clean macOS run `7942034e-792d-4005-9d8a-8ab27d9c2376` used revision
`3363581bc95d72ce22e33a3c5e6e03650412f502`, tree
`8d95774b3a40551d5b42eefda0c85415fcf247f7`. It remains failed. Installed Telegram
and generic storage recovery passed with complete cleanup. Actual Chromium driver
execution and browser observations completed, but the supervisor marked lingering
children as orphaned immediately after an intentional graceful stop. The three
application rows therefore failed before the later unknown-outcome phase. The
polling-container row was unavailable because its default Docker lookup ran under
the deliberately minimal child PATH. All scenario artifact hashes were checked;
independent review found no private configs, SQLite or actual cookie/control
credentials among the 102 evidence files. Failed workspace inputs are retained
privately for diagnosis.

The corresponding Linux run also passed installed Telegram and both actual
container rows. Its app stopped before Chromium launch because the pinned Linux
executable exceeds the inherited 256 MiB bound. Primary archive central-directory
inspection established `chrome-linux64/chrome` is 311,672,136 bytes in the
[pinned official Linux archive](https://cdn.playwright.dev/builds/cft/159.0.8154.6/linux64/chrome-linux64.zip).
`89cbf00` gives only Chromium executable verification a documented 512 MiB limit,
retaining stable no-follow reads, exact hash and executable/private mode checks.
Node, source, archive, output and process bounds remain unchanged. Independent
13 tests /60 assertions cover the observed size, hash mismatch and excess; actual
Linux execution remains required.

`d99b53c` repairs intentional shutdown supervision. Descendants receive the
existing 15-second graceful deadline, followed when necessary by forced termination
and the existing 5-second reap. Lifetime expiry and output overflow override grace;
unexpected orphaning and unknown cleanup still fail. Independent ownership tests
include real delayed descendants, a process surviving until forced termination,
and inherited-pipe uncertainty. Producer verification passed 50 tests /251
assertions; independent focused verification passed 9 tests /35 assertions.

`59a5f3d` resolves Docker before isolating PATH and carries only an explicitly
selected local Unix socket, matching the generic container runner. Independent
fresh default-binary execution passed all polling replacement/effect checks with
complete cleanup; no explicit dockerBinary option was supplied.

Release rehearsal on the earlier head exposed a stale expectation that the
bundler embeds the agent name in its temporary directory. `fc3d6b3` instead owns
an explicit private staging parent, validates the returned direct child and its
device/inode, and removes only that identity-checked owned parent. Independent
10 tests /33 assertions reject outside, linked, nonprivate and replaced paths.
Actual packed336 generated consumer proof passed 25 source files, changed/missing
source negative controls, private exclusions and cleanup.

Root accepts M5-06's standalone-channel scope on committed336 artifacts after
macOS/Linux results and independent evidence review. The separate aggregate and
hosted gates are still open. Updated tracked operator and harness shards passed
1,904 and 288 tests respectively. PostgreSQL17 CI completed all 13 required cases.
Full CodeQL run43561767380 completed analysis2166413523 on336 with 103 rules and
the same five triaged results; no alert states changed. Fresh settled-head CI and
release certification remain required after these harness repairs.

Hosted preparation now recommends two agent services plus an optional temporary
recovery target, using bounded control over exact Railway SSH instances to the
existing loopback fixtures. A third fixture service/private DNS rewrite is not
required. This still needs a real HTTP/model/tool sibling fixture, durable sealed
per-generation journals, remote command termination proof, exact environment
admission and quiescent maintenance. The action annex must count distinct created
volumes honestly when restoring both profiles. Login, exact target discovery and
concrete approval remain outstanding; no hosted work has been executed.


### G3 and M5-05 acceptance on 515cf79

The clean committed run `eafe3cff-7f9e-49f0-b751-6c78ef012d0b` passed all six
local/container rows on `515cf793526f18f5355fc31015b3b9cfe075e881`, tree
`0c638856689de20a6b593c9cf43182ee2ee13400`. Root accepts G3 and M5-05 after
independent evidence review. This accepts actual local execution and does not
waive the required Linux CI, release rehearsal or hosted G4 gates.

Independent audit verified 1,469 tracked source files, all five archives and 431
packed files, 792 installed-file claims, 21 artifact hashes and the source-edit/
lock chains. Exact stage/profile, deadline, effect and platform identities match.
Underlying journals prove Telegram trust and replay behavior, direct browser SSE
with fresh assertions, the expected post-effect crash and recovery, root/volume
admission, durable state replacement and restore guards. Production, standalone
HTTP and browser phases recorded zero, one and one effects respectively; duplicate
and unauthorized effects were zero. All 27 owned Docker resources (five images,
18 containers, four volumes) and the runtime/browser build workspaces were removed.
The source checkout stayed clean. No raw private configuration/SQLite/environment
files or any of the three actual captured credential values appeared among the
102 evidence files.

Exact evidence identities:

- Aggregate: `c16192039bc645d244b57cf2e88d607e5773da5c5def0d2bddc8554385338665`.
- Source inventory: `54e7bc8818bc75847258ee90e23f4abd78ede472a41ed096d7431ce0c972a1d3`.
- Packed source inventory: `bf0f10bac0b52713eb21bd2367bfd83c279461bff6741382884f4662cfd22662`.
- Independent digest report: `0d540ad158de10f7d01379d7a2dd237e0dc2f656ee4592e0d5a460d8c618a2dc`.

Linux CI run 43562375625 passed every constituent except portable browser execution.
It now reaches actual Chromium startup, which fails with `No usable sandbox` under
Ubuntu's AppArmor restriction on unprivileged user namespaces. Both actual Linux
container rows still pass with cleanup. The narrow CI remedy is under independent
review: a temporary uniquely owned profile for the exact pinned browser executable,
with bounded load/unload and cleanup; no global sysctl change or `--no-sandbox`.
Chromium documents [per-executable AppArmor permission](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).

PostgreSQL 17 again completed all 13 required cases (server 170010). Full CodeQL
run 43562421107 completed analysis2166435521 on this exact head with 103 rules,
five unchanged triaged results and no analysis errors or warnings. No alert states
were changed. Release rehearsal and the repaired Linux browser gate remain under
verification. Read-only Railway discovery was rechecked and still lacks valid
login; no hosted target or resource was selected or mutated.


The targeted Linux CI AppArmor setup is committed at `f4b0e21` after independent
17 tests /83 assertions, shell syntax, strict typecheck and lint. A bounded-profile
inventory edge case was corrected before acceptance. Commands are add-only for a
new unique profile, explicitly time limited, use no persistent policy/cache file,
and verify removal on success, failure and interruption. Tests mock privileged
commands; no local kernel policy was changed. Actual Linux execution is pending.

Release rehearsal43562375614 failed before deployment verification while creating
`generated-ownership`: the CLI reported a controlled publication rollback after
618 ms, with confirmed process cleanup and no timeout/output/orphan flag. The
current CLI omits existing safe publication diagnostics, and sanitized artifacts
correctly exclude private receipts. An authoring specialist is investigating the
cause and bounded failure visibility; no retry or waiver is being counted as
acceptance. The earlier staging-prefix repair remains independently accepted.

### Linux certification on a5aa966 and scaffold diagnostics

All required checks passed on `a5aa966c031211dbce0ececb168856f2a1ad65d8`:
[CI 43563713875](https://github.com/looselyorganized/auggy/actions/runs/43563713875),
[release rehearsal 43563713863](https://github.com/looselyorganized/auggy/actions/runs/43563713863),
and PR CodeQL 43563713860. Independent review accepted the actual Linux artifacts
from merge revision `6dacd1dcbb6bf97dbd9c2e99b60279f6b209e80d`, tree
`3e85a33cbbe62047a155214accb79aa44123beea`. All six integration rows passed with
complete scenario and workspace cleanup. Nine distinct scenario artifact hashes
and all five archive hashes matched. Aggregate SHA-256 is
`459a318926228e5cb8eae1b92c81bb940acf0d0632e6e3f830614978e8efaf2c`.

Actual Chromium and its driver exited successfully without timeout, overflow,
orphan or forced-termination flags. Direct streaming, fresh assertions, same-key
retry and interruption completion passed; no application cookie or creator
credential was sent to the agent. Desktop and mobile layouts had no overflow.
Effects were production 0, HTTP 1, browser 1, installed Telegram 2, generic
container 4 and Telegram container 2, with zero duplicate or unauthorized effects.
The CI AppArmor opt-in was active, and the successful shell result requires both
profile installation and removal confirmation. No separate named profile receipt
was emitted. PostgreSQL 17 completed all 13 registered required cases, server
170010 (14 tests / 60 assertions, zero failures).

Release rehearsal passed every provider plus application, inspection, migration,
ownership and deployment checks. Generated ownership creation exited successfully
in 619 ms with cleanup confirmed. Actual deployment staging verified 25 sources,
changed/missing-source controls and private-state canaries. Linux launchd remained
truthfully unavailable. Full branch
[CodeQL 43563741606](https://github.com/looselyorganized/auggy/actions/runs/43563741606)
produced analysis 2166475521 on the exact head: 103 rules, five previously triaged
results and no analysis errors or warnings. Alert states remain unchanged.

The older `515cf79` Ubuntu publication rollback remains unexplained. The successful
`a5aa966` release predates both diagnostic and Alpine repairs; neither repair is
claimed to explain it. Bounded reproduction passed 30 fresh native macOS creates
and 30 fresh Debian/glibc Linux amd64 creates from verified package bytes. That
investigation is closed without a causal claim, waiver or broader retry campaign.

`c1c991f` adds the existing controlled publication diagnostic code and message to
create/init failures, preserving operation identity and recovery instructions.
It bounds diagnostic count and text, and excludes paths, private receipts and raw
native exceptions. Producer verification passed 57 tests / 476 assertions;
independent diagnostic review passed 5 tests / 29 assertions. Strict typecheck and
repository lint passed. New-head certification is still required.

The same Linux investigation found a separate reproducible Alpine/musl defect:
libc does not export `renameat2`, so atomic scaffold publication always refuses.
`eb9b362` adds an independently accepted fallback for the verified Linux x64 and
arm64 syscall ABIs, preserving atomic no-replace behavior and refusal on unsupported
platforms, filesystems and errors. Native bindings remain first, and native errors
are never retried through the fallback. It uses neither overwrite nor check-then-
rename. Independent verification passed 21 tests / 119 assertions, including
collisions, symlinks and competing publishers. Producer verification passed 65
Darwin publication/POSIX tests. Root strict typecheck and repository lint passed.

Actual pinned Alpine execution passed nine tests / 72 assertions on each of arm64
and amd64; amd64 ran under Docker Desktop emulation. The arm64 experiment also
passed 30 fresh CLI creates. It verified all 415 original archive files before
applying only the explicitly recorded create/POSIX overlays. This is scoped repair
proof, not final-package certification. The amd64 member was verified against the
frozen image index. Owned containers and diagnostic image references were removed;
the shared base was preserved. Source SHA-256 is
`fa4c98eab981a05d605978a424fc7e0d1088ab06edaed2c7c72269dcfc1813e8`; test SHA-256 is
`332e9d7fa3b5b84c50325402478af6a396da3b1f326b64faf86ee8bb2f3e17cd`.
Final-head CI, release and one actual final-archive Alpine create remain required.
No dependency lock or package version changed.

## 2026-11-14: final 83dca71 verification and G4 preparation

The pending diagnostic/Alpine certification above completed on `83dca71`:
[CI 43565040948](https://github.com/looselyorganized/auggy/actions/runs/43565040948),
[release 43565040946](https://github.com/looselyorganized/auggy/actions/runs/43565040946)
and [full CodeQL 43565060850](https://github.com/looselyorganized/auggy/actions/runs/43565060850)
passed. The tested merge tree matched the head. All six integration rows, 13
registered PostgreSQL 17 cases, source/packed/installed inventories and owned
cleanup passed. The final unmodified archive also created an agent successfully
in pinned Alpine arm64; its owned container/image were removed. Full CodeQL
reported eight results without analysis errors/warnings: the previously reviewed
results and three private test-directory assertions were independently triaged;
no alerts were dismissed or checks weakened. The private final summary SHA256 is
`b83249e8d0a8b9ede520ddd40fbc8f8a303b807ac2c7eaa016a3943505263e14`.

Railway authentication was renewed and verified read-only. No isolated rehearsal
project exists, and no hosted mutation, SSH authentication or key registration
has occurred. The [G4 amendment](./milestone-5-contracts/hosted-rehearsal.md)
describes new-project allocation, observed volume defaults, verified service-cap
requirements, monitored spending, workspace-key scope, explicit first-use relay
pinning and owned immediate cleanup. Final approval remains pending.

The following local preparation has independent acceptance:

| Change | Evidence scope |
| --- | --- |
| `ecb21a7` child supervision | Bounded stdin delivery and side-effect-free reusable supervisor; writing input alone never proves consumption. |
| `13a302b` Telegram sealing | Real pinned-container exchanges, immutable generation receipts, admitted-body drain and owned cleanup. |
| `4a69e88` approval gate | Exact new allocation, source inputs, resource/SSH identity and remaining-time bindings; wrong maintenance profile refuses. |
| `a8616fe` HTTP checkpoint | Actual local/packed/Docker execution; complete sealed domain/provider journals and independent current downstream checkpoint. |
| `19db679` remote envelope | Exclusive durable claims/receipts, independent deadline, disconnect/reap controls and strict private-token forwarding; 37 final-run containers confirmed absent. |
| `7e7385f`, `3a36a3b` SSH transport | Isolated identity/pin, fresh instance binding and two exact envelope paths; no remote connection in these tests. |
| `81c0bed`, `1849c92` journal/API | Immutable run start, no replay of uncertain mutations, fixed bounded API vocabulary and cleanup-only reserve. |

Adversarial review found and repaired hidden effects completing during HTTP seal,
omitted provider generations, short/escaped token disclosure, inappropriate
maintenance profiles, orphan outcomes at action admission and allocation using
the cleanup reserve. Each repair returned to independent acceptance. These are
local harness findings; they are not claims of hosted vulnerabilities or hosted
certification.

Exact selected HTTP and polling contexts retain the accepted core archive
`779c806ac00ef2962671019c3d93f7a3b34ed88db89d944c151b06059e30e648`
and explicitly recorded source overlays. Fresh local application execution passed
real model/tool/transport paths, replay, denials, owned-source markers and sealing.
Independent artifact reviews checked all context files and installed package
bytes. A separate fixed watchdog exited after 115036 ms despite ignored SIGTERM,
with no local supervisor timeout and confirmed cleanup. It is test-only source;
its deadline marker invalidates an experiment regardless of runtime exit status.

Actual backup testing found an unused Console database declaration in the company
application reference while `adminRoute` was false. `78f64a9` removes only that
declaration, preserving conservative state inventory. Relevant suites passed
44 tests / 753 assertions, and actual installed inventory confirms the corrected
reference no longer requires the nonexistent store. Corrected HTTP contexts were
regenerated and rerun; their evidence SHA256 is
`4abc652591ecb922e98c7e50fd7b71e5539f331325d356de0fee68e8987e4a51`.
Earlier HTTP artifacts with the unused declaration are superseded.

The exact worker artifact/proof hashes and independent review hashes are recorded
in the task ledger. Integration of the finite hosted executor, concrete approval,
actual hosted execution/teardown and new-candidate CI remain outstanding. The accepted
`83dca71` checks do not certify these later source changes. M5 remains incomplete;
no merge, version bump or npm publication has occurred.

## 2026-11-14: recovery prerequisites accepted

`f8a15e7` gives HTTP and polling recovery separate service slots and rejects reused
service IDs and crossed profiles. Independent gate/API/SSH/journal verification
passed 45 tests / 383 assertions. No service conversion or new provider mutation
was added. The proposed allocation is four services and four distinct volumes.

`29c782e` adds the finite offline maintenance commands and bounded backup transfer.
The real public CLI performs backup, verification, restore and reconciliation;
the fixture acquires the runtime singleton lease around offline operations. The
accepted HTTP Docker row restores older Auggy state while preserving a newer
downstream checkpoint. It verifies the startup fence, unchanged assertion guard,
actual 503 responses across restart, expired assertion rejection, completed replay
without another effect and one new effect after the real hold. All 13 owned Docker
resources were independently confirmed absent.

The separate worker Docker row restores the exact Telegram namespace and claims
1, 2 and 3. Reconciliation preserves the guard, duplicate delivery 1 performs no
model or domain work, and new delivery 4 performs exactly one effect. All 11 owned
Docker resources were independently confirmed absent. Telegram is not claimed to
use the HTTP assertion TTL hold.

A small additive Docker proof verifies that the fixed `prepare-empty-volume`
operation changes a fresh owned directory from 0755 to 0700, enables actual CLI
restore, and refuses a nonempty directory without changing its guard. All three
owned resources were independently confirmed absent. The final maintenance suite
passes 12 tests / 97 assertions. Railway stopped observations have an explicit
provider shape; they never fabricate a process exit code that Railway does not
expose. Actual hosted parent, instance, volume and quiescence binding remains an
executor responsibility.

Private controller review caught a confirmed-create/failed-read cleanup gap. The
repair can recover a cleanup binding from the recorded successful creation and
fresh exact-ID readback. Unknown creations remain unresolved and are never
adopted by name. Independent controller verification passes 13 tests / 71
assertions, including process lease contention and crash release. The candidate
combined sequence has 90 logical actions; it is not yet a frozen, approved run.

The bounded public CLI runner also has independent local acceptance: four fake
platform scenarios exercise initial and saved-target deployment, incomplete CLI
completion after an upload acknowledgement, and the separate maintenance upload.
The root remote/channel observers were independently reviewed and repaired for
receipt completeness, decoded secret disclosure, generation identity, omitted
provider work and rewritten terminal journal entries. These local results do not
substitute for actual Railway acceptance. Remaining preparation includes the
guard's complete process lifetime, attached callback supervision, exact hosted
TTL artifacts and final executor integration/review.
