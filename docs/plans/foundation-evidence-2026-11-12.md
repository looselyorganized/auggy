# Foundation execution evidence — 2026-11-12

Status: implementation delivered; local M2 acceptance independently approved.
Formal M1/M2 acceptance remains pending supported Linux/security/PostgreSQL CI
and preservation-exclusion review. No milestone 3 implementation has started.

Baseline: `29147dfc7af0de59c3631c34a164ed3f3f6f4d5c` (committed main).
Verified implementation: `307ac09c7322e008fd2c300f1484d3c4f8d9ad89`.
The implementation was isolated from the original dirty main checkout and all
experimental authoring worktrees. No runtime API or generated execution-layout
change was made. Package versions were not bumped and nothing was published.

## Original-main results

| Gate | Result |
|---|---|
| Frozen install, lint, typecheck, inventory | Passed |
| Runtime suite | 4,192 passed; 13 PostgreSQL-related skips; no failures |
| Console suite | 360 passed; no failures |
| Console lint/build | Passed |
| Temporal example | 64 tests and typecheck passed; live dependency audit failed |
| Packed release | Failed isolated provider-consumer audit before agent creation |
| Pricing freshness | Failed: provider verification dates older than 90 days |
| Linux / PostgreSQL 17 CI | Unavailable locally; Docker daemon unavailable |

Listener tests were retried with the required sandbox permission after the
restricted environment rejected binding. Successful results are separate from
restricted attempts. Local PostgreSQL 18 is not the pinned PostgreSQL 17 CI job.

## Repairs and verification

Updated existing audited dependency pins and the Temporal example lockfile;
smoke consumers now derive overrides from the root manifest. Corrected five
existing rate records using official provider pages and refreshed their
verification dates; updated affected assertions. No model catalog expansion or
pricing-algorithm changes were made.

Pricing sources: [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing),
[GPT-5](https://developers.openai.com/api/docs/models/gpt-5),
[GPT-5 mini](https://developers.openai.com/api/docs/models/gpt-5-mini).
Captured verification details are in the local repair evidence.

| Gate | Repaired result |
|---|---|
| Frozen install, lint, typecheck, inventory, pricing freshness | Passed |
| Runtime suite | 4,210 passed, 13 PostgreSQL skips, no failures |
| Late isolation test | 3 passed separately; final inventory covers 296 runtime files |
| Console | 360 passed; lint/build passed |
| Temporal | 64 passed; typecheck passed; audit returned an empty object |
| Focused harness review | 19 passed / 78 assertions |
| Shell cleanup/exit contract probes | 3 passed, including export and cleanup failure propagation |
| Full packed release rehearsal | Exit 0 from clean implementation commit 307ac09 |
| Packed scenarios | All 7 passed in 1,232 ms; two graceful shutdowns; no cleanup errors |

A diagnostic workspace audit still reports additional stale-lock advisories.
These original findings are recorded in `repairs/workspace-audit-final.log`.
That earlier deferral is superseded by the dependency-closure work below; no
claim is made that the whole developer workspace audit is clean.

## Packed evidence and independent review

The installed CLI, installed provider adapter, actual HTTP transport and kernel
execute the test. Only the external model service is a loopback protocol fixture.
The fixture requests fs_read, verifies the real file sentinel in the returned
tool result, and then emits the final answer. Missing/invalid auth, schema
rejection, provider failure, duplicate replay and replay after restart pass.

Independent review verified all 28 exported record hashes, six tarball hashes,
matching lockfile hash, clean source fingerprint, installed provenance outside
the repository, and no detected credential/login-ticket leakage. Successful,
replayed and restart-replayed streams have identical hashes; replay causes no
additional inference or tool execution. Both process shutdowns exited 0 without
a terminating signal or forced kill.

Failed integration attempts remain in the evidence: an early attempt was
invalidated by editing a running Bash script; a later assertion incorrectly
expected rejected tools in the executed-tool list. The final run used immutable
committed source and corrected assertions grounded in current main behavior.

Current observability limitation: a generic provider error throws before
runPostTurn, so onTurnEnd does not receive its failure trace. The harness requires
a failed terminal SSE, one classified provider failure and zero tool execution,
and explicitly records traceObserved:false. Milestone 3 must address failure-path
observability when designing the managed lifecycle. No kernel change was made
to manufacture evidence for this milestone.

## Preservation and handoff

Local evidence is retained under the original repository's ignored
`.worktrees/foundation-evidence-2026-11-12/` directory. It contains `preservation/`
(manifests, archives, patches and AgentMail bundle) and `evidence/` (original
baseline, repaired checks, failed attempts and accepted-release artifacts).
CI now uploads sanitized release evidence on every rehearsal, including failures.

Archives were hash-verified and tracked patches reconstructed against their
original commits. Main's source changes, both authoring experiments and all five
unique AgentMail commits remain recoverable. The Central YAML workspace README
has a supplemental archive entry.

Worktrees were retained. The TypeScript worktree's modified security marker
fixture triggered the credential scanner and was excluded; review it before
retirement. No excluded unique state was silently destroyed. AgentMail remains
a separate maintenance branch; only the independently reviewed smoke override
hunk was reused here. Main's existing local changes were not merged or modified.

## Remaining acceptance gates

- Run existing Linux/security and pinned PostgreSQL 17 CI jobs on the branch.
- Review the preservation exclusion before removing experimental worktrees.
- Keep additional workspace dependency advisories visible in maintenance work.
- Before milestone 3, capture human baseline task timings. Source-path discovery
  was documented, but no unfamiliar-engineer usability timing was measured here.

Project-local runtime delegation, editable execution-file assertions, new host
and turn APIs, Central YAML migration and upgrade certification remain roadmap
milestones 3–6. No claim is made that this tranche implements those promises.

## Dependency closure follow-up

The closure work starts from foundation `dc03a00`. Compatible runtime dependency
floors, affected transitive pins and the console build graph were updated; the
exact previously locked shadcn stylesheet and MIT notice are preserved locally.
The generator is no longer a normal-build dependency and its unreviewed use is
explicitly quarantined. No package version or runtime execution API changed.

See [all advisory dispositions](./foundation-dependency-closure-2026-11-12.md).
The original 23 findings and five newly reported Hono findings have been
investigated. **The full workspace audit remains blocked by Link's nested Zod
v3 advisory.** It is not accepted as an exception; core/evals Zod v4 updates do
not fix that distinct optional runtime dependency.

Local current-graph verification: 4,253 runtime tests passed, no failures, with
13 optional PostgreSQL skips; 360 console tests/build and 64 Temporal tests,
typecheck and isolated audit passed. Nine retained-lock harness tests passed
separately from the canonical tracked runtime inventory. Final packed
and remote candidate results must be read from their own source revision, not
inferred from these local results.

The new workspace audit rejects all findings and verification failures. Dedicated
PostgreSQL CI requires its URL, PostgreSQL 17 and completion of every registered
case. Existing local optional skips remain available. Dependency upgrades preserve
the old consumer lock and installed tree, detect stale application overrides,
and exercise the upgraded consumer's own installed runtime.

Closure evidence is retained in the original repository's ignored
`.worktrees/foundation-evidence-2026-11-12/closure/` directory. PR checks will
record candidate head, base and tested merge revisions. The PR stays unmerged
until the remaining dependency finding is resolved, required checks pass and
final review is complete. Worktree retirement remains separately deferred.

Console stylesheet review: [actual built Integrations screenshot](./assets/foundation-console-closure.png), using isolated mocked API data and no credentials. The exact upstream CSS/license hashes are preserved in the vendor provenance; this image is visual build evidence, not a live-agent test.

Closure PR: [#226](https://github.com/looselyorganized/auggy/pull/226) remains a
draft and must not merge while the Link advisory is unresolved. On candidate
`e4cd41d`, remote CI passed CodeQL, all Linux boundary jobs and the PostgreSQL 17
job; its execution record was registered=13, completed=13, serverVersion=170010.
The workspace audit and aggregate correctly failed. Later candidate checks are
tracked separately on the PR; these results are not transferred across revisions.

Actual retained-lock rehearsal subsequently passed baseline reconstruction, the
specific stale-override negative control, dependency migration with an empty core
audit, preserved application-source checks and all seven request/replay scenarios
through the upgraded consumer's own installed CLI. Link selection alone failed
with GHSA-mrhx-c7xc-m3w5 on Zod 3.25.76. The harness reports overall failure and
retains that finding rather than treating the known vulnerability as a pass.
Metadata resolution fixes were verified with eleven focused tests and typecheck;
actual dependency entrypoints need not be executed to inspect package versions.
The immutable full local rehearsal at `76c0912` passed all core package checks
and those upgrade phases; its sole failure was the selected Link audit. Final
review additionally tightened canonical metadata-path checks before reading,
including escaping manifest symlinks. That correction is covered by the focused
regressions and the final candidate's upgrade replay and remote checks.
Immutable rehearsal and exact revision records are retained under
`closure/` alongside the PR's downloadable CI artifacts.
