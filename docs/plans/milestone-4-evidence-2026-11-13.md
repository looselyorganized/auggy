# Milestone 4 — execution evidence

Status: execution authorized; G0 accepted on repaired main. No implementation
acceptance is claimed until the corresponding ledger task is accepted.

## Entry gate and preservation

The user authorized execution of the independently reviewed M4 packet. Root
orchestrates specialized producers and independent review. Publication/version
changes are excluded. The original dirty `main` checkout and experiment worktrees
remain untouched.

Independent entry auditor `m4_entry_gate_auditor` accepted exact M3 head
`ba16ce3a8be1f5ef8ec36e43c79889c3feecc250` for merge after verifying all 31 checks,
three branch-protected requirements, separate CodeQL findings (zero open alerts),
13/13 PostgreSQL integration cases on server 170010, release rehearsal and the
recorded independent runtime/harness reviews. Branch protection requires no
separate human PR approval.

[PR #227](https://github.com/looselyorganized/auggy/pull/227) merged at
`2026-11-13T05:48:58Z` as `d8d0072cd334834bc62e8270b40edd2a2a7a94e9`.
Tree: `1986af1001357c48ff7ed1c7feee2ececf3a963f`. `git diff --quiet` against the
reviewed M3 candidate passed: no source reconciliation is needed.

The isolated implementation worktree is `.worktrees/inspectable-authoring`, branch
`feat/inspectable-authoring`. Approved planning commit `82eac3d` was carried onto
main as `02d4e89`. `bun install --frozen-lockfile` passed with Bun 1.3.14, and root
lock SHA-256 remains
`cd4b421883d2874dba117e9410acae08207f352d99b74fcd6a9872d35afde3f7`.

Resulting-main CI and analysis workflows completed:
[CI](https://github.com/looselyorganized/auggy/actions/runs/43374475284) and
[CodeQL](https://github.com/looselyorganized/auggy/actions/runs/43374475262).
CI and PostgreSQL passed (13/13 registered integration cases), but G0 remains
blocked. Full main CodeQL analysis `2158668062` reported ten new open findings
(alerts 118–127), all in test fixtures: five generated-code sanitization findings,
one file-derived outbound address, and four filesystem-race patterns. PR analysis
used a diff-range extension and reported zero; main ran full analysis despite
the identical source tree. A successful analysis job is not a clean findings gate.

The isolated `fix/m3-main-codeql` repair branch addresses the test patterns without
changing runtime behavior or scanner rules. It requires independent review, full
manual branch CodeQL (not just PR diff analysis), normal PR checks and a fresh
merged-main findings audit before G0 can be accepted.

Contract/harness source inspection continues read-only; product producers wait
for accepted G0 and M4-00 contract freeze. The trusted live security evaluation
is not a declared M4 entry check and was not dispatched; its eventual
post-merge/release-readiness obligation remains explicit. AgentMail's live provider
canary is pre-tag evidence for the eventual setup/connectivity-changing release.

## Scoped repair and renewed main verification

The independently reviewed repair landed through
[PR #228](https://github.com/looselyorganized/auggy/pull/228), exact head
`6161ff2c7108c5f1d7e3ecc2c15853799bf23ea0`. Its 31 checks passed, including release
rehearsal and PostgreSQL 13/13. A
[full manual CodeQL run](https://github.com/looselyorganized/auggy/actions/runs/43375239340)
confirmed no diff-informed analysis and zero open alerts on the repair branch
(analysis `2158700808`). Independent focused verification passed 91 tests and
499 assertions with unchanged reviewed hashes and no remaining fixture children.

The repair merged at `2026-11-13T06:02:18Z` as
`911fe1682c76208c1d99d4dc6841bfcaa608dd8d`. Its tree matches the reviewed repair;
production source, package manifests, lock and workflow configuration remain
unchanged from M3. Repaired main CI and full findings verification are pending.

Meanwhile, two specialists recorded precise draft document/publication and
installed-harness interfaces in [freeze.md](./milestone-4-contracts/freeze.md) and
[harness-freeze.md](./milestone-4-contracts/harness-freeze.md). Independent contract
review added explicit config activation outcomes for AgentMail compensation and
an ignore-rule bootstrap recovery protocol. These close concrete cross-producer
failure gaps. At this preparation point, producers were still waiting for G0 and
compiled M4-00 freeze.

## G0 accepted and contract compilation

The entry auditor accepted main `911fe1682c76208c1d99d4dc6841bfcaa608dd8d`, tree
`d901475a9afb7a9d24dc70c21ac2480bfab78439`, matching the reviewed repair exactly.
[Main CI](https://github.com/looselyorganized/auggy/actions/runs/43375919380) passed
all required checks and PostgreSQL 13/13 on 170010. The
[full-main CodeQL run](https://github.com/looselyorganized/auggy/actions/runs/43375919436)
uploaded analysis `2158727887` with zero open main-ref alerts. Alerts 118–127 are
fixed, not dismissed. All 29 resulting-main checks passed.

The implementation branch was rebased onto that main, retaining only M4 planning
and preparation changes. Root translated the independently reviewed draft into
CLI-local shared types and compile-only consumers, and extracted the unchanged
declarable built-in type set into a pure module. Strict typecheck passed; existing
parser regression passed 132 tests / 266 assertions; scoped formatting/lint passed.
The independent final M4-00 recheck accepted the actual compiled files after a
4,096-versus-1,024 relative-path limit mismatch was corrected. Final contracts
SHA-256: `34edd0aae8e24fefa62090de428fd58099537eef428d50b41de0511e46601713`;
compile fixture: `51d229669d2df73672b967cc4e2b8c74ad229072a4c21c0b1d02f2fef4aeaa29`.
No remaining contract blockers. M4-01 document and publication producers can start
with disjoint file scopes, while root retains integration and final acceptance.

## M4-07 bounded harness preparation

The harness specialist delivered artifact selection (including OpenRouter's exact
OpenAI prerequisite), nonmutating source/manifest checks, bounded CLI supervision,
and generated-recipe/public-effect assertions. Root inspected these helpers and
independently reran their 11 tests / 78 assertions. Producer scoped Biome and strict
TypeScript checks passed. Root also added an answer-only loopback provider scenario
for untouched scaffold startup; its existing and new provider controls passed
18 tests / 86 assertions. These are harness preparation results, not installed
CLI acceptance. Full create/install orchestration, five launch paths, source-edit
observations, migration and inspection scenarios remain pending accepted producers.
