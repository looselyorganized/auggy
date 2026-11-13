# Milestone 4 — planning review and disposition

Status: approved by independent plan review, with no unresolved planning blockers.
This approves the execution packet's design and sequencing, not implementation,
M3 merge or publication. The [ledger](./milestone-4-tasks.json) keeps every
implementation task blocked by G0.

## Review scope and roles

Frozen source inspected: `ba16ce3a8be1f5ef8ec36e43c79889c3feecc250`, M3 candidate
in [PR #227](https://github.com/looselyorganized/auggy/pull/227). Main at planning
verification is `209185d0e7481b4ff5d3b4c87e3447e7583b2fef`; PR #227 remains an
implementation entry gate, not an accepted main baseline.

Root acted as CTO / AI Engineering Lead and wrote the integrated packet.
Three specialists independently inspected authoring/application architecture,
CLI/configuration/migration, and installed acceptance/harness design:
`m4_authoring_architect`, `m4_cli_migration_planner`, `m4_harness_planner`.
Their source-backed findings informed the contract decisions and exclusive tasks.

A fresh `m4_plan_adversarial_review` agent then reviewed the complete packet and
relevant source read-only. Root corrected its findings; the same independent
reviewer rechecked those corrections. Review was of planning feasibility,
preservation/security boundaries and evidence design. No product source was
changed and no runtime test result is claimed by this review.

## Findings and dispositions

| ID | Severity | Finding | Final contract and verification requirement |
| --- | --- | --- | --- |
| R1 | P1 | Legacy custom-source environment expansion happens before absolute/relative resolution, so passive rebasing can change meaning | C2 rejects env-derived legacy source conversion before writes; retains inline placeholders; relative/absolute possible-value controls and manual literal-path guidance |
| R2 | P1 | Interrupted init may have no `agent.yaml`, making normal config-selected rollback unreachable | C2 adds rollback-only directory selection and validates private receipts without config. Init can remove only its unchanged owned new `.env`; later credential edits are protected. Installed kill/recovery/clean-retry fixture |
| R3 | P2 | Restoring an old ignore file could expose raw inline-secret backups to Git | C2 restores ignore protection last, after sensitive cleanup; keeps the rule with a disclosed exception if any sensitive receipt remains. Git canary, another receipt and cleanup-failure controls |
| R4 | P2 | Existing config/package helpers can bypass bounded reads before passive report generation | C3 requires bounded selector snapshots and missing-versus-corrupt classification; actual binary FIFO/oversize/path controls. Shared helper integration reserved to root |
| R5 | P2 | Producer acceptance could imply full installed certification, creating a hidden dependency cycle | Plan/ledger distinguish scoped producer contributions, M4-07 installed evidence and M4-10 final certification. M4-07 final acceptance also depends on completed documentation |

All five findings were independently rechecked and resolved. The reviewer found
the single configuration authority, real owned execution, maintained safeguards,
installed-source navigation and actual generated-artifact acceptance coherent.

The reviewer also checked these deliberate limitations: init refuses collisions;
migration activates on the next managed launch without claiming a live process
lock; source metadata remains separate from the strict launcher protocol;
passive commands bypass eager implementation imports; Bun's automatic `.env`
startup read is distinguished from inspection code using/loading secrets.

## Remaining gates, not architectural omissions

Implementation requires explicit authorization, the reviewed M3 merge and
verified resulting main. M4-00 then freezes exact small interfaces, JSON fixture
shapes, bounded-read limits and mutation-lease details against that main. These
are assigned contract-freeze deliverables, not permission for each worker to
invent incompatible APIs during implementation.

Plan verification covers local Markdown links, source landmark existence,
machine-readable ledger validity, acyclic preparation/acceptance dependencies,
all 17 acceptance rows and planning-only gate consistency, plus whitespace checks.
Product tests are intentionally not run for this documentation-only change.
