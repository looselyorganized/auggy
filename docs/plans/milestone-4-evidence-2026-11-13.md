# Milestone 4 — execution evidence

Status: M4-00 through M4-10 accepted for PR review on `4fd2fff`. All required
macOS/Linux execution, CI, independent review and full CodeQL gates passed.
The implementation remains unmerged and unreleased in PR #229.

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

## M4-01 document and passive integration review

The document producer delivered bounded snapshots, raw YAML declarations and AST
edits, and private preconditioned mutation plans. Root corrected two reviewed
edges before handoff: central output cannot exceed its next reader's 1 MiB bound,
and application paths must reject controls and nonliteral forms. Independent
review additionally caught a quoted `"<<"` domain key being treated as merge
syntax; quoted input and generated output now preserve this literal key. Main's
model snapshot remains an init-only absent/private exception inside `.auggy`.

Root added bounded passive runtime metadata selection and shared passive command
grammar without changing ordinary launch resolution. The independent reviewer
reran 91 tests / 491 assertions across documents, mutation, grammar, and new and
existing runtime metadata selection. A separate probe compared converted legacy
custom declarations through the actual existing runtime loader and confirmed
equivalent resolved source/options with literal environment placeholders. This
accepts these scoped components, not M4-01 publication or installed acceptance.

Publication review remains in progress. It has already reproduced partial new
YAML exposure under a short-write/process-kill, stale restored-output success,
historical directory-mode incompatibility, sequential ignore-rule rollback, and
receipt allocation bounds. Repairs and narrow implementation refinements are
recorded in the contract freeze; each needs independent recheck before M4-01
acceptance and downstream producer execution.

## M4-01 accepted foundation

The independent reviewer accepted the final publication and native no-replace
implementation after 61 tests / 295 assertions and separate adversarial probes.
New and replacement activation now exposes a complete inode with final mode;
concurrent destinations are preserved. Rollback rechecks restored files before
sensitive cleanup, retains backups on later edits, supports reverse-order recovery
of successive operations, and bounds both recorded sizes and actual reads before
allocation. Final-mode staging remains under verified private directories.
Interrupted partial private staging conservatively requires preservation review;
the original activation remains intact.

Late review also verified shell-escaped migration guidance stays below 1,024
bytes, and passive package JSON has iterative depth/node limits before recursive
export selection. Final document/runtime checks passed 64 tests / 354 assertions;
the previously reviewed I/O, mutation and grammar checks remain passing. Root's
final combined regression passed 154 tests / 798
assertions, full typecheck and full lint (existing Biome schema informational
notice only). All concrete review findings are closed. Native execution was
verified on macOS arm64; Linux remains a required CI check. This is scoped
foundation acceptance, not installed-artifact or milestone certification.


## M4-02/03/06 producer review checkpoint

The scaffold and custom-capability producers delivered the visible execution
recipe, central inline authoring and shared-service starter. Passive inspection
now pre-dispatches from the actual CLI ahead of the ordinary command graph and
uses the selected installed package's source index. Root added serialized skill
asset repair/removal and MCP domain writes, plus source-index packaging checks.

The independent reviewer accepted M4-06 and that command integration after 111
tests / 506 assertions. The final index-bound correction passed 26 tests / 58
assertions and the generator check: installed index input permits exactly 1 MiB,
then rejects larger files. Copied real-binary import traps, environment FIFO and
redaction cases are scoped command evidence, not final tarball certification.

Review found that augment addition could rewrite invalid UTF-8 or oversized
package metadata, leak malformed JSON tokens, or hang on an unrelated `.env`
FIFO. The producer corrected bounded/fatal reads, sanitized diagnostics and
readiness preflight. Independent reproducers confirmed byte preservation,
redaction and nonblocking behavior; focused independent checks passed 70 tests /
341 assertions plus 46 tests / 239 assertions. M4-03 scoped review is accepted.

M4-02 review separately found init consulted an occupied package.json FIFO before
collision preflight. The producer moved package selection after collision checks
and bounded workspace metadata/artifact discovery. Final recheck is pending at
this checkpoint. No installed milestone row is accepted yet. Root's preliminary
source-index/prepack/console build and artifact verification passed, and the
shared application-artifact helper regression passed 17 tests / 95 assertions.


Independent M4-02 final recheck passed 142 tests / 669 assertions and confirmed
immediate, mutation-free rejection of the original FIFO probe. All three scoped
producers and root command/packaging integration were accepted and recorded in
`9e56b80`. The review found no remaining blocker in those scopes. This advances
M4-04 migration and M4-05 AgentMail implementation; M4-07 now implements actual
installed generation and execution rather than only helper preparation.


## Migration and credential integration accepted in scope

Independent M4-04 review passed 69 tests / 700 assertions, including a real copied
binary with no environment, writer, FFI, selected runtime or provider execution in
preview. Raw declarations, source bases and values survive conversion; adoption
rejects existing owned files and incompatible manifest fields. SIGKILL recovery
covers eight publication boundaries and preserves changed outputs.

Independent M4-05 review passed 60 tests / 200 assertions. Inline canonical setup
selects raw declarations before network/credentials, holds project then env leases,
revalidates after provider verification, and compensates credentials only for a
verified original activation with an unchanged env postimage. Output or unknown
activation retains verified credentials and recovery guidance. Legacy visitor
listing/revocation remains operational. Fresh packed execution is still required.

Root replaced remaining graph-command name selection with the same bounded raw
selector, preserving catalog listing outside a project. The independent product
regression passed 106 tests / 501 assertions. Follow-up bounded actual-CLI FIFO
controls replace eval-based probes and passed 29 tests / 160 assertions. These
product changes are recorded in `1667e21`.

Preliminary checkpoint `9e56b80` artifacts passed installed generation, dependency
installation, generated typecheck/tests, strict audit and frozen reinstall for all
four providers. The untouched Anthropic application answered through the real
adapter. Its tool/route shared-service fixture, all 15 source-edit observations
across five launch paths, restorations, denial and durable replay passed with
confirmed cleanup. Passive local/synthetic-version global inspection also passed
strict import traps and restored exact bytes. These results are iterative harness
evidence; docs and final artifacts have not yet been certified.

Independent review caught a generated-service harness assumption that rejected
create's own `data/workspace/README.md`. The repaired bounded freshness check
permits exactly that ordinary documentation leaf and rejects other state, aliases
and FIFO files; 5 tests / 17 assertions and an actual generated-output probe pass.
A subsequent real service setup attempt exposed a missing fixture agent-ID env
reference; the test environment now carries the same explicit ID as its config.
Actual macOS service lifecycle remains pending the rerun; no rendered plist is
counted as service proof.

The preliminary generated macOS service rerun passed with confirmed cleanup in
`/private/tmp/auggy-m4-authoring-service-5/authoring-launchd.json`: actual start,
status, restart and stop, untouched answer-only execution, observed HTTP-source
edit, durable restart replay, generation/PID replacement and released claims.
This used the earlier `9e56b80` artifact; final-source certification will rerun it.

Wave-two product artifact `1667e21` (core SHA-256
`dd1330b8d196dd08ad18e26364c467b310cc6a79fe90f926b10ed3714b251e55`)
passed the actual packed AgentMail CLI script, including inline configuration,
credential verification/failure preservation and legacy visitor operations.
The script exited zero after closing its loopback provider. Evidence is private
at `/tmp/m4-wave2-agentmail-packed.log`; no live provider credentials were used.


## Installed harness review

The combined wave-two suite passed every generated-project stage, including
actual macOS service execution, active-turn migration, unequal-version passive
inspection, ownership replacement and deployment staging. Its private report is
`/private/tmp/auggy-m4-combined-wave2/authoring-suite.json`. The successful suite
removed its isolated workspace only after component cleanup succeeded.

Independent reviewer `m4_harness_review` accepted the scoped harness after 36
tests / 171 assertions and inspection of the actual scenario evidence. Two
coverage gaps were closed before checkpoint `4693ee0`: a bounded whole-tree
inventory now rejects unexpected legacy metadata/duplicate definitions before
installation, and a detached-service log watchdog checks ordinary owned log
files, records maximum observed bytes, and initiates failure cleanup on excess.
The watchdog preserves cleanup control processes. Its 100 ms polling bounds
observation latency, not instantaneous disk writes; logs may overshoot between
observations, and this limitation is recorded rather than called a hard byte cap.
Service log contents are not archived.

All four actual provider creations passed the added inventory gate (79 entries
each); private env/receipt/state entries have no public byte hashes. The latest
installed migration rerun also passed active-turn conversion/adoption and exact
recovery after preview/cleanup hardening. These follow-up reports live under
`/private/tmp/auggy-m4-inventory-wave2` and
`/private/tmp/auggy-m4-migration-iteration-4`. Final rebuilt artifacts must rerun
all gates together after documentation acceptance.


## Teaching alignment accepted

Independent M4-08 review accepted public documentation, generated READMEs,
self-guidance, canonical builder assets and both byte-identical mirrors after
63 tests / 704 assertions. Review repaired real stale helper/eval test contracts,
distinguished dedicated AgentMail automation commands, separated repository-only
subtrees from installed package paths, and made execution arrows and single-entry
configuration teaching unambiguous. The README explicitly identifies the
unreleased 0.6 direction; no current npm publication is implied. Accepted source
checkpoint: `a5f2ba0`. Final rebuilt-artifact and repository-wide certification
now follows; historical plans and valid legacy fixture source remain preserved.


## Final certification attempt and adversarial repair

Candidate `4b856ed` passed strict typecheck, lint, source-index and inventory
checks, strict workspace dependency audit (zero advisories), and the console
suite. The full runtime run stopped with 13 failures in the isolated
`command-bootstrap` fixture: it copied the updated entrypoint without its new
static passive-authoring dependencies. This is a fixture assembly failure; its
launch assertions did not run and are not counted as passing.

Independent integrated preparation also reproduced a product regression:
AgentMail setup rejects unrelated `options: null`, although the runtime accepts
it and migration preserves legacy `config: null` that way. The producer must
normalize only the private descriptor, preserve raw YAML, and prove the full
migration-to-setup path with malformed-value controls. Both repairs and their
independent rechecks precede the final frozen artifact run.

Both scoped repairs passed independent recheck by
`m4_final_architecture_review`: 93 tests / 479 assertions across AgentMail,
migration and launch bootstrap. The setup repair changes only null validation
in its private descriptor; malformed false/zero/string/array options still
fail before provider or credential changes. The bootstrap fixture now includes
its passive static dependencies and verifies authoring help bypasses the launch
graph even with invalid config and absent local runtime. The complete operator
shard passed 1,641 tests / 6,581 assertions; the console suite passed 360 tests /
1,474 assertions. The original failed run remains recorded.


The next clean candidate, `c1902f8`, passed the full local runtime suite:
4,929 tests / 18,533 assertions, zero failures; 13 PostgreSQL service cases
were skipped locally and still require zero-skip CI. The full packed rehearsal
passed provider imports/audits, AgentMail CLI, interactive creation, packed
HTTP/tool/replay, dependency policy migration and selected/fresh Link 0.2.0
runtime/audits. It then failed the historical retained-lock candidate-turn
fixture because the new observer path assumed `src/augments/` already existed.
That old fixture has no `src/` tree. No scenario ran in that phase; cleanup
reported no errors, and the generated-authoring suite was not reached.

The failed report is retained at
`/private/tmp/m4-final-release-evidence/release.json`; all six artifact hashes
and 64 evidence-record hashes were independently checked. Core SHA-256 is
`b288d35053e6c52a867d4de6a0824f3066e158ba693586ab5c1d174df1da3a25`.
A narrow harness repair must preserve both historical and generated ownership
and remove only its own fixture files/directories before fresh certification.
Draft [PR #229](https://github.com/looselyorganized/auggy/pull/229) carries the
review handoff; no merge or publication is authorized.

Independent CI audit confirmed [CI 43387007773](https://github.com/looselyorganized/auggy/actions/runs/43387007773)
passed on `c1902f8`, tested merge `dfed2a6d7dcb60ce6bada9e914a4ba1c105dd45d`.
Required PostgreSQL evidence registered/completed 13/13 on server 170010 with
zero skipped cases; Linux operator tests exercised native no-replace publication
and interrupted migration. Source tree: `94a22c2892bfd65877a9062e4c0d04d6a4ea6523`.

[Full manual CodeQL](https://github.com/looselyorganized/auggy/actions/runs/43387008977)
explicitly ran without PR diff analysis. Analysis `2159155933` reports two new
open test-fixture findings: alert 128 logs an environment sentinel in the command
fixture; alert 129 uses a path metadata check followed by a separate read in the
migration snapshot helper. Both require repair and fresh full analysis. Five
other results are inherited dismissed findings whose files are byte-unchanged
from accepted main; M4 introduces no dismissal or suppression. A successful
analysis job is not recorded as clearance.

The two scanner repairs passed independent source/test review by
`m4_final_architecture_review`: 81 tests / 781 assertions. Ambient isolation now
reports only presence, with a positive control and filtered negative. Migration
fixture snapshots/hash maps open with no-follow/nonblocking flags, inspect and
read the same descriptor within an 8 MiB bound, detect changes, and avoid link
target/FIFO reads. Binary, same-length edit, link, FIFO and oversized-file controls
pass. These changes are confined to tests; fresh full analysis must confirm
alerts 128/129 are fixed.

While the separate historical-fixture repair proceeded, the unchanged generated
authoring harness ran directly against the same frozen `c1902f8` artifacts.
`smoke:authoring` exited zero with every stage passed, including all four provider
creations, 59 application scenarios / 74 lifecycle observations, 15 source edits,
active-turn migration, passive inspection, ownership, deployment and actual macOS
service lifecycle with the reviewed log watchdog. Cleanup is confirmed. Report:
`/private/tmp/m4-generated-c190-evidence/authoring-suite.json`. This isolates
actual generated-product evidence; it does not turn the failed aggregate release
attempt into a pass. The final clean-candidate aggregate still must run.

Independent harness review accepted the historical/inline fixture repair after
28 tests / 87 assertions. Historical consumers keep referenced metadata and
legacy execution during the actual scenario; inline consumers keep their
application declaration and source layout. Observer creation is exclusive under
existing ordinary parents; no parent directory is created or removed. Before
restoring original bytes, the helper checks every affected postimage and mode,
and removes only owned observer files and the empty observer directory. Changed
or partial outputs remain for inspection and fail cleanup rather than claiming
automatic restoration. `fixture.json` records the selected representation,
reversible changes, no migration, and actual restoration outcome.

Final strict typecheck, lint, inventory and source-index checks pass after both
repairs. The root dependency lock remains unchanged. The next aggregate run
uses a new clean revision and separate evidence destination so the failed
`c1902f8` report remains intact.


## Final certification accepted

Certification source: `4fd2fffa3e927986dc632d084fec592ea36279f9`; clean source
tree `64a968e8ba95edfec1c80051c882b32dcd1f8ab1`. Tested PR merge
`5f8953eaafc6f5592de1917a78aaceb4e6bc441a` has the identical tree. Bun 1.3.14,
unchanged root lock
`cd4b421883d2874dba117e9410acae08207f352d99b74fcd6a9872d35afde3f7`,
and empty source-diff SHA
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
are recorded in both platform manifests. This closing documentation change
records that verified implementation; it changes no packaged source or harness.

Independent reviewers accepted installed authoring (`m4_harness_review`),
integrated architecture/security/inspectability (`m4_final_architecture_review`)
and final certification (`m4_certification_auditor`). No unresolved M4-blocking
findings remain. The final architecture review compared all 342 packaged source
files with the frozen checkout and verified all 20 indexed entrypoints.

- [CI](https://github.com/looselyorganized/auggy/actions/runs/43388365523): all required gates passed; PostgreSQL registered/completed 13/13 on 170010 with zero skips. Native Linux publication and interruption recovery actually executed.
- [Linux release rehearsal](https://github.com/looselyorganized/auggy/actions/runs/43388365574): full aggregate passed; sanitized evidence artifact `14019409302`, downloaded for independent audit. All 31 PR checks passed.
- [Full manual CodeQL](https://github.com/looselyorganized/auggy/actions/runs/43388389592): analysis `2159213461` ran without PR diff filtering; zero open exact-branch findings. Alerts 128/129 are fixed without dismissal. The five inherited dismissals are unchanged from main.
- macOS aggregate: `AUGGY_RELEASE_EVIDENCE_DIR=/private/tmp/m4-final-release-evidence-2 AUGGY_RELEASE_ARTIFACT_DIR=/private/tmp/m4-final-release-artifacts-2 bun run smoke:release` exited zero on arm64. Manifest: `/private/tmp/m4-final-release-evidence-2/release.json`; log: `/private/tmp/m4-final-release-2.log`.

The auditor independently recomputed all 427 evidence-record hashes on each
platform and all six macOS tarball hashes with zero mismatches. Linux and macOS
archives can differ by build platform; all 576 compared installed file hashes
across the four provider adoptions matched. Each successful platform aggregate
includes 25 clean dependency audits; the old retained-override negative control
intentionally reports two vulnerable packages, followed by a clean migrated
consumer. No vulnerable historical runtime was executed.

The actual generated suite passed all four provider creation/install/public-API
typecheck/test/frozen-install/audit paths; seven fresh consumers each had an
80-entry pre-install inventory and 19 selected owned-source hashes. It passed
59 application scenarios, 15 startup/HTTP/turn edits across five launch paths,
and 74 lifecycle observations (37 ready/37 stopped). Untouched answer-only
execution used one provider call; the authorized tool scenario used two calls
and one effect; invalid input and provider failures produced zero tool effects.

Active-turn config conversion and explicit application adoption passed with
durable replay, 12 migration reports and guarded rollback controls. Six passive
import traps remained unexecuted and were restored; a different-version global
CLI selected the local runtime's metadata. Ownership replacement retained 24
source and three state hashes plus private env data, while 14 artifact members
changed. This is explicitly a same-version artifact experiment. Deployment
staging verified 25 source files and exclusion/negative controls; it does not
claim container execution or hosted Railway deployment.

Actual macOS service start/status/restart/stop passed with two owned generations,
source sensitivity and exact restart replay. Cleanup confirmed no remaining
claims/active service and removed the successful suite workspace. The log
watchdog observed a maximum 1,062 stdout bytes and zero stderr bytes, with no
errors; its 100 ms polling and possible between-poll overshoot remain explicit.
Linux correctly records macOS service evidence as unavailable; the actual
macOS aggregate supplies that required row. Reference-application and historical
upgrade suites also passed, with exact fixture restoration and no retained
successful workspaces.

Final macOS candidate archive SHA-256 values:

| Archive | SHA-256 |
| --- | --- |
| `auggy-0.5.0.tgz` | `b288d35053e6c52a867d4de6a0824f3066e158ba693586ab5c1d174df1da3a25` |
| `auggy-anthropic-0.5.0.tgz` | `293d662d72b8dc2820daee5e0a6d65695fbd71210fcc0899ac181b22ffb15c5d` |
| `auggy-evals-0.5.0.tgz` | `9eee63f4034f0cc1a6b46d7ec70ea61fdf1e0cfa452999db03975811ca619942` |
| `auggy-ollama-0.5.0.tgz` | `56122840cc3773ee2c80183cb999cde251cd254ab1bbdd81fc17b6990ccf39df` |
| `auggy-openai-0.5.0.tgz` | `3b6d40297001421d2281b2d4bf8b947995b6cfe6645f3385ec2b6e9da5421fcd` |
| `auggy-openrouter-0.5.0.tgz` | `483ac6d7343d7c6a7249eafb857856b8cb11a13a8eb004aec02fdb6495c1b15b` |

The local full runtime run passed 4,929 tests / 18,533 assertions before the
subsequent test-only repairs; final CI and aggregate rehearsal reran the updated
tracked suites. The console suite passed 360 tests / 1,474 assertions. Final
strict typecheck, lint, source-index and inventory checks passed. Failed attempts
above remain recorded rather than relabeled.

[PR #229](https://github.com/looselyorganized/auggy/pull/229) is the review handoff.
There is no package version change, npm publication or merge authorization. M5
owns hosted Next.js/Auggy integration; M6 owns supported published-version
upgrades and measurement with unfamiliar engineers. The pre-existing
hyphen/underscore custom-tool name alias remains follow-up work, not an M4
regression. The original dirty checkout and experiment worktrees remain untouched.
