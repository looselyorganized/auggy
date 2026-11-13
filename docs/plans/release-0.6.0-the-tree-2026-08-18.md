# Release 0.6.0 — inspectable agent applications

Status: implementation in progress; no milestone accepted yet.
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
| Preservation | In progress |
| Original-main baseline | In progress |
| Scoped baseline repairs | Awaiting findings |
| Ownership decision | Adopted; implementation guarantees remain future |
| Packed execution scenarios | In progress |
| Independent review | Pending |
| M1 acceptance | Pending |
| M2 acceptance | Pending |

## Milestones 3–6: roadmap only

The [roadmap](../ROADMAP.md) records outcomes and exit gates for the reference
application, authoring/scaffold, standalone-service integration, and upgrade/DX
certification. Detail milestone 3 only after M1–M2 acceptance. Do not implement
managed host/turn APIs, Central YAML migration, public client packages, or the
new generated tree as incidental harness work.

## Measurable developer experience

Capture the current task outcomes before the new scaffold ships: locating the
HTTP endpoint, following a request into the turn loop, tracing an augment call,
first authenticated response, and a safe customization. M6 repeats those tasks
with unfamiliar engineers. Five minutes to trace endpoint through augment is a
proposed target, not a result established by this tranche.
