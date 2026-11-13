# Milestone 3 implementation and acceptance evidence

The implementation is on [PR #227](https://github.com/looselyorganized/auggy/pull/227),
based on accepted main `209185d0e7481b4ff5d3b4c87e3447e7583b2fef`.
This is a feature PR, not a release. No versions were bumped and no packages were
published. Original worktrees remain preserved.

## What engineers can inspect

The executable [reference application](../../examples/inspectable-agent/README.md)
exposes startup in `src/index.ts`, composition in `src/agent.ts`, the actual
`POST /agent/run` mount in `src/http.ts`, orchestration in `src/turn.ts`, and a
custom capability in `src/augments/example/`. Central YAML remains the enabled
augment graph. Runtime guards and built-ins remain project-local dependencies.

Direct execution, local CLI and compatible global CLI launches use the same main.
Application ceilings can lower package limits; managed operations retain
authorization, validation, phase/receipt ownership, accounting and finalization.
The host owns preparation, readiness, admission closure and resource settlement.
Unknown construction or shutdown outcomes retain runtime ownership.

Milestone 4 owns the new CLI scaffold, authoring and migration. Milestone 5 owns
the standalone-service Next.js integration. Milestone 6 owns measured usability
and broader upgrade certification. The current `auggy create` template has not
been replaced. Technical traceability is verified here; a measured developer
experience improvement is not yet claimed.

## Frozen implementation

| Identity | Value |
| --- | --- |
| Product commit | `1604dcd6e81a72a27930a246b91154f809e2e8c2` |
| Product tree | `fd24cfe4097e1a20f3e017f0fbe0b2e59bf86071` |
| Harness security repair | `866e8d144cd51dce577fda5fa5149f039a4ed50e` |
| First tested PR merge | `c75a524223e44ebdd1b0a02cbcc58bb728b07cb9` |
| Root lock SHA-256, unchanged from accepted main | `cd4b421883d2874dba117e9410acae08207f352d99b74fcd6a9872d35afde3f7` |
| Local core tarball SHA-256 | `2234e3ec9d13ec41c98308ae658322b40491638f901a82dda1d13048f2681e76` |
| Local Anthropic tarball SHA-256 | `293d662d72b8dc2820daee5e0a6d65695fbd71210fcc0899ac181b22ffb15c5d` |

The local rehearsal ran from a clean commit: its source-change digest is SHA-256
of empty input. Toolchain: Bun 1.3.14, Node 26.0.0, npm 11.12.1, macOS arm64.
Linux CI uses Bun 1.3.14 and Node 24 for the release rehearsal. Later acceptance
documentation commits do not change product, test, manifest, lock or harness bytes;
the PR's required checks still apply to its final merge candidate.

## Verification

| Gate | Observed result |
| --- | --- |
| `bun run test:full` | 4,884 passed, zero failures; 13 local PostgreSQL skips |
| PostgreSQL service | Required CI integration gate passed against PostgreSQL 17.10 |
| Typecheck and lint | Passed; existing Biome schema-version informational notice remains |
| Standalone reference | Frozen installation, typecheck, six tests and strict audit passed |
| Workspace and consumer dependency audits | Passed, zero advisories in audited graphs |
| Clean installed-package rehearsal | Passed; all 16 application acceptance rows |
| macOS launchd | Real service start, request, restart, request and stop; cleanup confirmed |
| Installed upgrade | Retained node_modules and project manifest except the two intended runtime bindings; owned source unchanged; actual installed runtime hashes transitioned |
| Independent review | Runtime and launch reviewers clear after repairs |

The installed harness executes five launch paths, fifteen source-edit controls,
real provider-adapter/tool/provider round trips against a deterministic loopback
provider, authorization denials, durable replay across restart, failure recovery,
startup/shutdown faults and dependency-selection checks. The application baseline
is `73233db23bb1dc17d9a795b19881c79a09266a18`; A/B packages share version 0.5.0
and are explicitly artifact experiments, not published-version upgrades.

The accepted legacy baseline is `209185d0`. The vulnerable historical dependency
fixture is installed without lifecycle scripts and upgraded before its runtime
is executed. Existing Link and legacy HTTP scenarios remain in the release gate.

## Adversarial findings and repairs

- Constructor ownership: a custom factory allocated a real listener and threw;
  rollback incorrectly reported closure and released ownership. The repair tracks
  incomplete imports/factories and returned objects before normalization. The
  unchanged independent reproduction now retains the manifest; competing hosts
  are denied. Positive controls prove known cleanup still releases exactly once.
  Producer checks: 102 tests; independent repair checks: 27 tests, 173 assertions.
- Conditional package exports: an unmatched nested Bun/Node condition prevented
  a valid outer fallback. The resolver now distinguishes no-match from explicit
  null. Actual Bun resolution and rejection controls pass independently: 17 tests,
  82 assertions. Realpath comparison handles macOS path aliases.
- Full-suite isolation: an existing browser test mocked Node's process launcher
  for the remainder of the test process. The new real-process harness now has its
  own inventoried shard; no tests were dropped.
- Packed type declarations: the public application facade no longer forces an
  Anthropic-only consumer to install optional adapters. Fresh packed typecheck
  verifies the real consumer boundary.
- CodeQL's separate findings check reported nine filesystem race patterns and
  two generated-code sanitization warnings in the verification harness, despite
  the analysis workflow itself succeeding. Reads now use bounded, nonblocking,
  no-follow descriptors with metadata checks and guaranteed close. Live logs
  allow three bounded retries; evidence updates replace entries atomically.
  The legacy observer uses static source and reads fixture values as data.
  Independent review exercised a real concurrent JSONL writer and caught a
  duplicate variable declaration in the repair; that import regression is fixed
  and covered. Production runtime bytes are unchanged by these harness repairs.
  Remote CodeQL then reported zero open PR findings, and the repaired harness
  passed all 16 installed-application rows again using the same certified packs.
- PostgreSQL test timing: a pre-existing 80 ms lease could expire during capacity
  assertions, requeueing active work and correctly changing the rejection from
  thread capacity to global capacity. Two fixture leases now exceed the test's
  30-second timeout. Exact assertions and dedicated DB-forced expiry tests remain;
  coordinator code is unchanged. Independent review accepted the diagnosis and
  scoped change; the final required service job verifies execution.

Earlier failed attempts are retained alongside successful results. The final
runtime and launch reviewers inspected their respective implementations and
independently reproduced fixes; neither reviewed their own production repair.

## Evidence and remaining boundaries

Local evidence is under the original repository's ignored
`.worktrees/milestone-3-evidence-2026-11-13/`: `final-candidate-tests.{json,log}`,
`final-release/`, `final-release-packs/` and `final-review/`. All 267 exported
release-record hashes were independently checked. The final application matrix
reports `executionStatus: passed`, `matrixStatus: complete`, no failure and no
retained temporary workspace.

Remote evidence is attached to the
[release rehearsal](https://github.com/looselyorganized/auggy/actions/runs/43368519247).
The [CI run](https://github.com/looselyorganized/auggy/actions/runs/43368519330) and
[CodeQL run](https://github.com/looselyorganized/auggy/actions/runs/43368519324)
cover the frozen implementation's PR merge. Final PR status is authoritative for
later documentation-only commits.

Linux cannot execute macOS launchd; that row is unavailable there and passed on
macOS. The local Docker daemon is unavailable. Generated deployment files and
command boundaries are covered; this is not a hosted Railway or container
deployment certification. No production data or live provider credentials were
used. The trusted default-branch security canary must evaluate merged code;
repository eval keys are never supplied to branch-controlled code.
