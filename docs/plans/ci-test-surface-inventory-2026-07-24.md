# CI test-surface inventory enforcement

Date: 2026-07-24
Branch: `security/ci-test-inventory`
Base: merged `main` at `e7c8e76`

## Objective

Make the complete tracked Bun test surface a fail-closed, executable CI
contract. A new or renamed test must either enter one canonical bounded shard
automatically or fail inventory validation before the aggregate release gate
can pass.

This addresses the operational residual recorded in
`docs/security-audit/2026-07-23-security-remediation-report.md`: explicit CI
shard lists require maintenance and can silently drift from the repository.

## Revalidation and classification

Confirmed and reachable, but Low / operational.

The repository currently has:

- 252 tracked runtime tests under `tests/`, `examples/`, and `packages/`;
- 29 tracked console tests under `admin/src/`; and
- 281 tracked Bun-discoverable tests in total.

Primary `.github/workflows/ci.yml` assigns 242 runtime tests through directory
shards and omits all ten root `tests/*.test.ts` files. The separate PR release
rehearsal currently compensates by naming those ten files explicitly, so this
is not evidence that current PRs omit them from every workflow. Its own static
path list can nevertheless miss a future root test or new top-level test area.

The existing workflow contract test only searches workflow source for literal
path strings. Moving executable commands into YAML comments leaves its
assertions satisfied, so it does not prove that the named paths execute.

This gap does not directly bypass runtime authorization or create a production
vulnerability. It can produce a false-green CI result whose impact inherits
whatever regression an omitted test would have caught.

## Security invariant

1. Inventory is derived from Git-tracked entries, never untracked/generated
   workspace files.
2. Every Bun-discoverable tracked test under the runtime and console roots has
   exactly one canonical primary shard owner.
3. No test is unassigned, multiply assigned, cross-assigned between runtime and
   console, or reachable through a symlink.
4. Every selector is bounded, canonical, nonempty, and matches at least one
   tracked test after explicit exclusions.
5. Shard IDs are unique safe identifiers; empty runtime or console inventory
   fails closed.
6. CI executes the validator's exact sorted paths as argv entries, never shell
   text, substring filters, or workflow-maintained path lists.
7. Each runtime shard is one sequential Bun process; release rehearsal runs
   shards sequentially in separate processes.
8. The aggregate release gate requires inventory success.
9. Primary inventory ownership is distinct from intentional deterministic and
   Linux boundary reruns.
10. Diagnostics expose paths and stable reasons only, never file contents,
    environment values, or repository secrets.

Bun 1.3.14 is pinned in CI. The inventory recognizes Bun's documented default
patterns:

- `*.test.{js,jsx,ts,tsx}`;
- `*_test.{js,jsx,ts,tsx}`;
- `*.spec.{js,jsx,ts,tsx}`; and
- `*_spec.{js,jsx,ts,tsx}`.

Official discovery reference:
<https://bun.com/docs/test/discovery>

## Threat model and trust boundary

Protected assets are CI signal integrity, complete security-regression
coverage, and bounded execution of port/subprocess-heavy suites.

Expected change paths include adding, renaming, moving, or deleting tests;
adding a new test area; changing shard policy; and editing either PR workflow.
Untracked local files, templates such as `augment.test.ts.txt`, fixtures that
import `bun:test`, and generated artifacts are not executable inventory.

The normal `pull_request` workflow is branch-controlled. A malicious author can
edit a validator, its tests, and the workflow together, just as they can edit
the tests themselves. Repository review, CODEOWNERS, required checks, and
branch protection remain the external authority for those edits. This Low
maintenance finding does not justify a new `pull_request_target` workflow,
which would introduce a higher-risk boundary around untrusted candidate data.

The enforcement added here prevents accidental or isolated path drift and makes
policy changes explicit in review. It does not claim to prove that test
assertions are meaningful or prevent an authorized reviewer from approving
test removal.

## Design

### 1. Structured selector manifest

Add one JSON manifest with schema version, suite, shard ID, and bounded
selectors. Supported selectors are exact file, immediate children of a
directory, and recursive tree. Selectors may contain exact exclusions.
An intentionally predeclared tracked root with no tests must opt into the
literal `allowEmpty: true` policy; exact-file selectors can never be empty.
Wildcards, shell syntax, absolute paths, backslashes, dot segments, duplicate
separators, control characters, and ambiguous overlaps are rejected.

Canonical runtime shards:

- `http`: the isolated root HTTP suite;
- `base`: remaining immediate root tests;
- `capabilities`: augment, auth, config, memory, and skill tests;
- `doctor`: the port-listener-sensitive doctor suite in its own process;
- `operator`: remaining CLI, script, and CI tests;
- `transport`: transport and integration tests;
- `kernel`: kernel and library tests;
- `contracts`: engine, package-contract, public API, type, and eval tests; and
- `workspaces`: example/package workspace tests.

Console tests have one separate `console` shard rooted at `admin/src`.

New tests within a known selector are automatically resolved and executed. A
new area inside a declared suite root fails unassigned until the manifest
explicitly assigns it. A repository-level test root outside the declared
runtime/admin roots fails until both root policy and manifest are deliberately
expanded.

### 2. Tracked inventory validator

Add a dependency-free Bun CLI/library that:

- reads the complete bounded `git ls-files --stage -z` tree;
- admits regular tracked modes `100644` and `100755`;
- rejects test-shaped symlinks and non-stage-zero entries;
- rejects test-shaped files outside every declared runtime/admin suite root;
- validates path normalization, NFC form, case-fold collisions, and duplicate
  input;
- recognizes the pinned Bun filename patterns;
- parses and strictly validates the manifest;
- expands selectors into exact sorted files;
- reports gaps, overlaps, stale selectors/exclusions, suite crossings, and
  empty required suites; and
- can emit validated runtime shard IDs as compact JSON.

Core validation is a pure function over synthetic Git entries and manifest
data so adversarial cases do not require temporary repositories.

### 3. Exact bounded runner

The same CLI runs one shard by spawning:

```text
bun test --max-concurrency=1 --timeout=30000 -- ./exact/path.test.ts ...
```

Arguments are passed as an array. Console files execute from `admin/` with
validated `./src/...` paths. `run-runtime` executes runtime shards one at a time
and stops on the first failure.

### 4. Workflow and local integration

- Add a primary CI inventory job that validates the tree and emits the runtime
  matrix from the manifest.
- Make runtime shard jobs consume that matrix and call the canonical runner.
- Make the aggregate release gate require inventory.
- Replace release rehearsal's inline paths with `check` plus `run-runtime`.
- Make console CI call the canonical console shard after its type/lint check.
- Route `test:runtime`, `test:admin`, and `bun run test` through the same
  validator/runner. Preserve direct `bun test` and watch commands for
  developer discovery.
- Replace substring workflow assertions with parsed YAML contract assertions
  over executable steps and required job dependencies.

## Required regressions

- Current tracked tree assigns all 281 tests exactly once.
- New root, nested new-area, example, package, and console tests classify or
  fail as designed.
- `.test`, `_test`, `.spec`, and `_spec` JS/JSX/TS/TSX names are discovered.
- `.test.ts.txt` templates and non-test helpers are ignored.
- Duplicate input, duplicate assignment, cross-suite assignment, unknown
  shard, stale selector, stale exclusion, and empty suite fail closed.
- Add/rename/delete scenarios update deterministically.
- Symlink mode, absolute/traversal/backslash/control paths, duplicate
  separators, non-NFC aliases, and case-fold collisions fail.
- Spaces and shell metacharacters remain single argv entries.
- The runner uses exact `./` paths, sequential flags, one process per shard,
  deterministic shard order, and stops after failure.
- Parsed workflows invoke the canonical checker/runner, derive the matrix from
  inventory, and require inventory in the aggregate gate.

## Adversarial review

A fresh exact-diff reviewer must look for:

- tracked tests missed by filename or root discovery;
- untracked/generated files admitted accidentally;
- directory, prefix, path-normalization, Unicode, case, or symlink
  differentials;
- longest-prefix or first-match behavior hiding overlaps;
- stale selectors or exclusions passing silently;
- shell interpolation, option injection, workflow-output injection, or log
  control characters;
- CI and release rehearsal consuming different policy;
- supplemental reruns masquerading as canonical coverage;
- empty/dynamic matrices failing open;
- port-heavy suites combined or run concurrently on one runner;
- branch-controlled policy being overstated as a malicious-PR boundary; and
- tests that validate source substrings rather than parsed executable jobs.

Every confirmed High or Medium issue will be fixed and the review repeated.
Low findings will be fixed when they undermine the stated inventory invariant.

## Verification

At minimum:

```text
bun test --max-concurrency=1 tests/ci/test-surface-inventory.test.ts
bun test --max-concurrency=1 tests/ci/security-workflows.test.ts
bun scripts/test-surface-inventory.ts check
bun scripts/test-surface-inventory.ts run http
bun run typecheck
bun run lint
bun run test
bun run smoke:release
git diff --check
```

Port-heavy suites run sequentially. The final PR remains unmerged.

## Compatibility and rollback

- Requires a complete Git checkout for tracked inventory. Source archives and
  sparse checkouts must use direct Bun commands or provide the complete tree.
- Untracked tests are intentionally absent until added to Git.
- New tests under known selectors no longer need workflow edits. New areas
  inside a declared suite root require a manifest change; repository-level
  roots require both suite-root policy and manifest changes.
- Platform-conditional files remain inventoried, but Linux CI cannot prove
  Windows-only branches.
- Rollback is code/workflow-only; there is no persisted data migration.
- This PR is independent of Telegram conflict recovery PR #161.

## Execution outcome

Implemented the inventory, bounded runner, primary-CI matrix integration,
release-rehearsal integration, local scripts, parsed workflow contracts,
release guidance, and residual-risk update. The implementation adds one
inventory regression file, so the final tracked surface is 253 runtime files
plus 29 console files, 282 total, across nine runtime shards and one console
shard.

An initial combined operator run exposed the listener-sensitive doctor suite.
It now has a dedicated sequential shard; the remaining operator shard passed
1,041 tests, and the doctor shard passed all 30 tests when run outside the
socket-restricted sandbox.

The fresh hostile exact-diff review confirmed and closed three Low,
invariant-breaking gaps:

1. Git enumeration was scoped to known roots, so a repository-level
   `src/...test.ts` file was invisible. Enumeration now covers the complete
   bounded tracked tree and rejects test-shaped files outside declared suite
   roots.
2. The parsed primary-workflow test still used substring checks for the
   multiline inventory step, so commented commands could satisfy it. The test
   now requires the exact normalized executable body.
3. A frozen 29-file console assertion rejected legitimate additions under the
   existing console selector. It is now addition-safe while exact ownership
   and total-count parity remain enforced.

No unresolved High or Medium issue remains. The reviewer also confirmed that
`allowEmpty: true` is narrow: only the predeclared `packages` selector uses it,
exact selectors cannot, ownership still fails on gaps or overlaps, and its
containing shard must remain nonempty.

Final verification:

- focused inventory/workflow set: 19 passed, 0 failed, 109 assertions;
- inventory check: 253 runtime + 29 admin files across 10 shards;
- complete `bun run test`: passed every canonical runtime shard and all 243
  console tests across 29 console files;
- `bun run typecheck`: passed;
- `bun run lint`: passed with only the existing Biome schema-version
  informational notice;
- `bun run smoke:release`: passed local workspace install, typecheck, console
  build, all package packs/imports, isolated packed CLI install, scaffold,
  installed-agent audit, doctor, health, console assets, MCP, and cloud
  preflight;
- `git diff --check`: passed.
