# Foundation execution evidence — 2026-11-12

Status: in progress; milestones are not accepted by this report.
Baseline: `29147dfc7af0de59c3631c34a164ed3f3f6f4d5c` (committed main).
Implementation is isolated from the original dirty main checkout and experimental
worktrees. No runtime API or generated architecture change belongs to this run.

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
restricted environment rejected binding. Their successful results are recorded
separately from restricted attempts. Installed local PostgreSQL 18 is not a
substitute for the repository's PostgreSQL 17 CI job.

## Repairs and added acceptance

Pending final verification. No failing baseline gate is waived by the new
fixture. Preserve the before/after command results, lockfile hashes, source
identity and tarball hashes in local evidence; CI collects sanitized rehearsal
evidence for each future PR.

## Independent review and acceptance

Pending. A green fixture unit test is not a green packed release; a green local
suite is not Linux/PostgreSQL certification. Future project-local launch and
editable execution-file promises remain assigned to milestone 3.
