# Release 0.6.0 — inspectable agent applications

Status: milestones 1–2 implementation delivered; local M2 evidence accepted.
Formal acceptance awaits Link dependency closure, passing required gates and
reviewed merge. Candidate-specific Linux/security/PostgreSQL results are recorded
in the foundation evidence and PR #226; they do not waive the remaining finding.
Worktree retirement remains separately deferred for preservation review.
Revised: 2026-11-12. Governing direction: [Roadmap](../ROADMAP.md).
Delete this implementation plan when 0.6.0 ships; retain accepted ADRs.

This replaces the earlier instruction to merge Central YAML worktree B. Both
experimental authoring implementations are salvage sources only. Historical
worktree test counts are not evidence about main.

## Current tranche: milestones 1 and 2

Baseline: committed main `29147dfc7af0de59c3631c34a164ed3f3f6f4d5c`.
The current main checkout has unrelated local changes. Implement in an isolated
clone; do not reset, stash, overwrite, or silently incorporate those changes.

### Milestone 1: preservation and reproducible baseline

1. Inventory main and all three worktrees, including staged, unstaged and
   untracked source. Preserve verified snapshots, patches, and unique history.
   Exclude secrets, dependencies and generated runtime databases; list exclusions.
2. Preserve the five unique AgentMail commits. Recovery regressions/fixes are
   separate maintenance candidates; pricing and dependency updates need their own
   review. Include only fixes that demonstrably unblock required verification.
3. Retire experimental worktrees only after verifying snapshots and reviewing
   excluded unique state. Preserve recoverable Git history and source archives.
4. Verify clean committed main in a separate checkout using Bun 1.3.14. Record
   SHA, Git status, OS/architecture, tool versions and lockfile hash.
5. Run frozen install; lint/typecheck/inventory; runtime/admin/temporal suites;
   admin lint/build; packed release smoke. Record each command, exit code,
   duration and redacted logs. Record Linux/security/PostgreSQL CI jobs separately
   when their supported environment is unavailable. Keep pricing freshness a
   separately attributed external-data check.
6. Repair narrow blockers in isolated changes. Preserve original failure
   evidence, run focused verification and the affected gate, then perform one
   complete baseline after integration. Do not weaken tests to claim success.

Exit: all mandatory checks pass in supported environments at an identified
accepted commit. Failed and unavailable are distinct from passed. An inventory
or a local macOS-only pass does not satisfy this gate.

### Milestone 2: ownership and packed execution acceptance

Adopt [the ownership decision](../adr/2026-11-12-inspectable-agent-application.md)
with the roadmap. Application-owned startup/request/composition/turn control flow
uses package-maintained operations. Built-ins stay installed dependencies;
central YAML remains the configuration authority. No new host/loop API or
scaffold is implemented in this tranche.

Extend release smoke with the existing real Anthropic adapter pointed at a
loopback protocol fixture through engine.baseURL. Use only dummy provider
credentials. The fixture asks fs_read to read a unique sentinel from the
workspace, checks the real returned result, then produces the final response.
Do not use a fake TransportKernel or introduce a product mock-provider enum.

Required scenarios:

| Scenario | Evidence |
|---|---|
| Successful turn | Authenticated /agent/run, actual provider/tool/provider sequence, validated sentinel, terminal stream and trace |
| Missing/invalid auth | Rejection; no additional provider calls or tool effects |
| Invalid tool arguments | Kernel validation; no tool side effects |
| Provider failure | Controlled terminal failure within deadline |
| Duplicate request | Durable replay; no repeated inference/tool execution |
| Restart | Bounded shutdown/restart; replay remains effective |
| Packed isolation | CLI/core/provider provenance outside source checkout; no source symlinks |

Record current global CLI core ownership honestly. Project-local delegation is
an M3 acceptance target. Continue using existing focused scheduler, quarantine,
authorization and cancellation suites for the broader adversarial matrix.

The harness has finite budgets: readiness 60 seconds, scenario 120 seconds,
graceful shutdown 15 seconds. Isolate HOME, temporary storage and loopback ports;
allowlist child environment, stop all owned processes, and reject unexpected
provider requests. Store only sanitized scenario and trace evidence.

Evidence includes source identity, tarball hashes, installed paths, scenario
outcomes, call counts, run/thread correlations, exit codes and durations. CI
must preserve failure evidence without uploading .env or authentication headers.

Exit: ownership documents agree, packed scenarios pass without live credentials,
required existing checks remain green, and independent review has no unresolved
blockers. Future promises stay pending in the acceptance matrix.

## Subagent execution protocol

The CTO/root owns scope, shared-file integration and milestone acceptance.
Agents receive a baseline, exclusive write scope, dependencies, verification
commands and required evidence. At most three specialists run concurrently.

| Work package | Owner | Write scope / dependency |
|---|---|---|
| Preservation | Repository agent | External archives/manifest; independent of baseline |
| Baseline | Verification agent | Isolated baseline checkout and evidence only |
| Provider fixture | Harness specialist | Fixture and focused unit tests |
| Packed consumer | Integration specialist | Scenario runner and observer; depends on fixture contract |
| Direction and shared integration | CTO | Roadmap/ADR/plan, smoke script, CI workflow |
| Adversarial review | Independent specialist | Read-only findings after integrated evidence |

Use separate checkouts for baseline versus implementation. Disjoint fixture and
consumer files may be developed in the implementation clone concurrently;
shared-file edits are serialized through the integrator. Hand off changed files,
reason, exact test results, artifact references and unresolved risks. Completion
messages are not acceptance; the CTO reviews evidence and independent findings.

## Evidence ledger

See [foundation execution evidence](./foundation-evidence-2026-11-12.md) for the
current run. Preserve original-main results separately from repaired results.
A commit/patch identity must accompany any eventual accepted baseline.

| Gate | State |
|---|---|
| Preservation | Archives verified; retirement deferred for exclusion review |
| Original-main baseline | Captured; initial failures retained in evidence |
| Scoped baseline repairs | Published Link 0.2.0 integrated; current full-workspace audit is clean |
| Ownership decision | Adopted; implementation guarantees remain future |
| Packed execution scenarios | Seven web plus twenty fresh/retained Link scenarios passed local-artifact acceptance; final registry rehearsal required |
| Independent review | Local code and final evidence approved |
| M1 acceptance | Final integrated CI and reviewed merge pending; PR #226 records exact-candidate results |
| M2 acceptance | Core/retained-lock execution verified locally; formal gate follows M1 dependency closure and reviewed merge |

## Foundation closure before milestone 3

Status: implementing from `dc03a00`; original main and retained worktrees remain
unchanged. No dependency exception is approved. Milestone 3 implementation starts
only after this foundation is reviewed, merged and verified on main.

### Remediation

- Refresh and preserve full workspace audit evidence. Classify each advisory by
  version, path, attack prerequisites and actual runtime/tooling reachability.
- Raise compatible MCP SDK and Zod direct dependency floors, including evals;
  update Vite and affected compatible transitives without unrelated upgrades.
- Replace the console's generator-package stylesheet import with the exact
  attributed upstream stylesheet. Remove the generator from normal installs;
  quarantine unreviewed generator invocations in maintenance documentation.
- Resolve Link's separate Zod v3 path through its separately authorized release
  PR. Link 0.2.0 is now published and integrated with its genuine Zod 4 contract;
  no global major override or capability removal is used. Certify the actual
  registry path in both fresh and retained Link-selected agents before merge.

### Harness and CI

- Add a bounded audit helper that requires successful execution and an empty
  advisory object. Findings at every severity, malformed responses, service
  failures and timeouts fail closed. No allowlist or severity filter.
- Add the full workspace audit to the existing CI aggregate. Keep Temporal and
  real packed-consumer audits separately enforced; root overrides are not
  inherited by generated projects.
- Test baseline-to-candidate artifact replacement retaining the existing lockfile
  and installed tree. Include stale application override detection and the
  documented dependency-only migration. Do not execute the vulnerable baseline.
- Verify core, providers, evals, generated agents and Link-selected consumers.
  Record the same-version artifact experiment honestly; it is not an npm release.
- Make dedicated PostgreSQL CI require its URL and executed, zero-skip integration
  suite against the existing pinned PostgreSQL 17 service. Local optional skips
  remain supported; product coordination remains disabled.

### Owners and integration

The dependency owner exclusively changes manifests/locks and installs the shared
graph. The upgrade-harness owner writes isolated migration fixtures/scenarios.
The CI owner writes audit enforcement and the PostgreSQL anti-skip guard. Root
integrates the release script, direction documents, PR and evidence. An independent
reviewer checks the frozen candidate after an implementation slot is free.

Run focused checks, freeze a commit, then full acceptance. Never edit running
rehearsal scripts or their dependency graph. Preserve failure evidence and refresh
results after corrections. Prior foundation evidence does not certify a changed
dependency graph.

### Remote certification and merge

Publish the reviewable foundation branch and open a PR targeting main. Capture
PR head SHA, base SHA and the synthetic merge SHA tested by GitHub. Require the
full CI aggregate, Linux boundary jobs, real PostgreSQL execution, CodeQL and
release rehearsal with hashed artifacts. Trusted-default-branch live evals are
not candidate-runtime certification and retain their existing secret boundary.

Present the concrete PR, diff, compatibility implications and evidence for final
review before merge. No protections are bypassed. Missing, stale, failed, skipped,
canceled or pending required checks do not pass. A remaining finding is a visible
blocker, not an implicit exception. After reviewed merge, verify resulting main
and establish that revision as milestone 3's starting point.

See [dependency closure findings](./foundation-dependency-closure-2026-11-12.md)
and [execution evidence](./foundation-evidence-2026-11-12.md).

## Milestone 3: detailed planning; implementation gated

The user authorized planning milestone 3 while a separate specialist addresses
Link. The [M3 execution plan](./milestone-3-execution-2026-11-12.md) and
[task ledger](./milestone-3-tasks.json) define specialized engineering ownership,
CTO orchestration, contracts, dependency order, adversarial review and acceptance.
This supersedes the earlier restriction on detailing M3 before foundation
acceptance; it does not change the implementation/merge gate. All implementation
tasks remain blocked until the accepted main baseline is recorded.

## Milestones 4–6: roadmap only

The [roadmap](../ROADMAP.md) records outcomes and exit gates for the reference
application, authoring/scaffold, standalone-service integration, and upgrade/DX
certification. Do not implement managed host/turn APIs, Central YAML migration,
public client packages, or the new generated tree as incidental foundation
harness work. M3 runtime implementation follows its separate gated plan.

## Measurable developer experience

Capture the current task outcomes before the new scaffold ships: locating the
HTTP endpoint, following a request into the turn loop, tracing an augment call,
first authenticated response, and a safe customization. M6 repeats those tasks
with unfamiliar engineers. Five minutes to trace endpoint through augment is a
proposed target, not a result established by this tranche.
