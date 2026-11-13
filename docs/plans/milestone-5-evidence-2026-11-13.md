# Milestone 5 execution evidence

Status: M4 merge and resulting-main verification complete; G0 accepted. M5-00 is
ready for interface/ownership freeze. No M5 product acceptance is claimed.

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
