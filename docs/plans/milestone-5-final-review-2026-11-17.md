# M5 final integrated review and handoff

Accepted source: `dfd3bb64bf117ac19d0fdf608323fc5019e45a13`.
Runtime candidate: `13bf80df4ead1bbf0b53ee0cc1b221df10868999`.
Baseline: accepted M4 main `c39b746b4b743e5c29dab61a677026c10626d8b8`.

G4/M5-07 hosted acceptance and M5-09 independent integrated review are accepted.
Root certification records the verified source/artifact/evidence below. Required
checks on the closing documentation-only head must also pass before PR handoff;
the exact current head/checks are authoritative in [PR #230](https://github.com/looselyorganized/auggy/pull/230).
No merge, version bump or publication is authorized by this record.

## Hosted acceptance

| Row | Accepted evidence | Outcome |
|---|---|---|
| HTTP lifecycle/replacement | [HTTP lifecycle assessment](./milestone-5-hosted-evidence-2026-11-16.json) | 229 seconds; stream/tool operation, state/replay continuity, edited source and shutdown passed |
| HTTP recovery | [HTTP recovery assessment](./milestone-5-http-recovery-evidence-2026-11-16.json) | 650 seconds; older backup/newer downstream effect, fresh-volume restore/reconcile, hold across restart, real expiry, replay/new work and shutdown passed |
| Polling lifecycle/replacement | [Original lifecycle assessment](./milestone-5-polling-evidence-2026-11-16.json) and successful recovery row below | No public ingress; operation/identity denial, edited source, duplicate protection and shutdown passed; original aggregate telemetry failure remains preserved |
| Polling recovery | [Polling recovery assessment](./milestone-5-polling-recovery-evidence-2026-11-16.json) | 407 seconds; backup after updates 1/2/3, exact replay namespace restore/reconcile, duplicate 1 causes no work, new update 4 succeeds |

Each accepted recovery row has zero duplicate/unauthorized effects, exact matching
resource creation/deletion IDs, complete project/key absence inventories, no
cleanup warnings/failures and no unknown mutations. Temporary runtime/auth copies
were removed after verified cleanup. No hosted resources remain. Earlier failed
attempts are retained as failures; no missing assertion is waived.

## Independent review

Reviewer: `/root/m5_integrated_review`, separate from the root producer. Verdict:
M5-09 accepted for reviewed source `dfd3bb64`; no blocking findings identified.

The reviewer independently verified both selected package archive hashes and no
production `src/`, provider, manifest, lock, console or README delta since the
runtime candidate. It verified the HTTP assessment and all 83 referenced raw files,
and the polling assessment and all 66 referenced raw files. Polling creation and
deletion identities, complete final absence inventories, replay claims 1/2/3 in
one namespace, duplicate phase zero provider calls, update 4's one effect/two model
calls/one validated tool result, and equal restore/reconcile guard digests agree.

Reviewed boundaries include owned/pinned storage admission, populated Railway
mount compatibility, singleton/released-capability enforcement, durable replay and
restore clock fencing, authorization of completed responses, export exclusions
and frozen builds, worker ingress honesty, application session/policy separation,
and scenario failure/cleanup handling. No architecture change is warranted.

This targeted integrated review supplements the prior accepted specialist reviews.
It does not claim a new line-by-line audit of all 5,997 product additions or live
external-provider availability. Deterministic fixtures exercise installed paths.

## CI and CodeQL disposition

All 28 checks passed on reviewed source `dfd3bb64`, including release rehearsal,
installed/browser/container integration, runtime/console, typecheck/lint, audits
and PostgreSQL 17. The source-equal closing evidence commit must also pass its
required PR checks before handoff; no additional local full-suite rerun is needed
for these documentation/ledger changes.

Independent review confirmed the CodeQL workflow is unchanged from accepted main:
full JS/TS `security-extended`, no path/config exclusions or diff-only narrowing.
Analysis `2183672374` of PR merge commit
`6d0420b128945d5abd53a2a64afd976871086773` used 103 rules, returned two results and
had no error/warning diagnostics. The two results are not relabeled as zero:

- [134](https://github.com/looselyorganized/auggy/security/code-scanning/134): held fixture request targets the exact owned provider domain/port; redirects are disabled and the signing secret is used for HMAC, not sent raw.
- [135](https://github.com/looselyorganized/auggy/security/code-scanning/135): the shared observer validates a credential-free origin and receives the same bound target; requests contain synthetic operations and signed assertions.

Root recorded the independently justified `used in tests` dispositions in GitHub.
No source suppression or product remediation was introduced. Final-head analysis
and current-ref open findings must be checked again at handoff.

## Handoff and follow-up

The PR description now reflects populated-mount support, the tracked scenario
runner, actual hosted acceptance and the current security/compatibility limits.
It no longer claims empty-only volume initialization or outstanding private
executor preparation. The branch remains unmerged and unpublished.

The trusted default-branch paid security canary is a post-merge follow-up: no
contributor-owned paid key was authorized for this deterministic M5 run, and
repository eval keys must not execute branch-controlled code. Resulting-main
verification and publication remain separate release gates. M6 upgrade and
measured engineer inspectability remain separate roadmap work.
