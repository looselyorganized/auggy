# Milestone 5 execution evidence

Current status: G0/G1 and M5-00/01/02/04 accepted. M5-03/05/06 implementation
continues; M5-07 helper mechanics have independent preparation review. Final
installed/browser/container/hosted acceptance remains open. Earlier entries below
record historical gate states; the task ledger is the current source of status.

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
