# OSS Production Release Plan

**Originally recorded:** 2026-07-24

**Reconciled:** 2026-07-25

**Status:** engineering hardening, then release preparation

**Immediate target:** `0.5.0` public-source production preview

**Later target:** `1.0.0` OSS GA

## Release decision

The next release is `0.5.0`, not `0.6.0` or `1.0.0`.

The source tree is already versioned as `0.5.0`, but npm still serves `0.4.4`
for `auggy`, all four provider adapters, and `@auggy/evals`. There is no
`v0.5.0` tag. Documentation that described `0.5.0` as published was ahead of
external reality.

`0.5.0` should be the first release whose source repository is public. It is a
public preview that can be used for production work inside the supported
topology below. It is not a claim that every augment is stable, every workload
has a certified capacity, or Auggy supplies managed infrastructure.

Because the delta from `v0.4.4` is unusually large, release one npm candidate
as `0.5.0-rc.1` under the `next` dist-tag before publishing final `0.5.0` under
`latest`. The release candidate validates the public-repository, OIDC,
provenance, packaging, installation, and deployment path without consuming the
final version.

## Supported production contract for 0.5

The production claim is topology-specific.

Supported:

- one Auggy runtime process for each logical agent deployment;
- several independent Auggy deployments that perform different operations;
- a durable POSIX volume for runtime-owned SQLite and file state;
- an operator-owned TLS reverse proxy, secrets system, network policy, backup
  process, monitoring, and deployment platform;
- explicit production authentication, proxy trust, anonymous-admission, and
  transport configuration;
- exact package-version pins during the public preview;
- deterministic application authorization and systems of record outside the
  model;
- bounded process-local concurrency across different threads, with one lane
  per resolved thread; and
- the stable and on-main capabilities identified in `docs/FEATURES.md`, with
  preview augments remaining explicitly opt-in.

Not supported or promised by 0.5:

- multiple replicas serving one logical Auggy deployment;
- a shared volume as a substitute for distributed coordination;
- transparent autoscaling or a managed Auggy control plane;
- a universal requests-per-second or concurrent-user number;
- exactly-once delivery for external systems that do not provide an
  idempotency contract;
- durable multi-hour workflows, compensation, or a persistent job queue;
- tenant provisioning, billing, application databases, or business-state
  ownership; or
- contractual availability, latency, recovery, or support SLAs.

`settings.coordination` must continue to reject startup until every required
shared and fenced runtime boundary is wired. The PostgreSQL coordinator merged
in PR #163 is a disabled foundation, not a supported replica mode.

## Evidence already complete

The following work is release evidence and should not be repeated as an
unbounded new platform program:

- PR #159 completed the repository-wide security audit remediation. Its final
  audit and packed-release gates passed with no unresolved High or Medium
  finding and no known vulnerable locked dependency at that point.
- PR #160 added bounded agent-wide keyed turn scheduling and explicit
  outcome-unknown quarantine.
- PR #161 added Telegram conflict quarantine and compare-and-set operator
  recovery.
- PR #162 made the complete tracked test inventory an executable CI and
  release-rehearsal boundary.
- PR #163 added the fail-closed distributed topology contract and tested
  PostgreSQL coordination foundation while deliberately leaving replicas
  unsupported.
- Main CI and CodeQL passed after PR #163, and no pull request was open when
  this plan was reconciled.

This evidence closes the earlier security and distributed-foundation passes;
it does not make the runtime production-ready by itself. Before the release
candidate, complete the seven engineering gates in
[`production-readiness-engineering-boundary-2026-07-25.md`](./production-readiness-engineering-boundary-2026-07-25.md):

1. runtime observability and capacity signals;
2. runtime-state lifecycle and recovery;
3. delivery and authenticated operator recovery semantics;
4. bounded provider resilience;
5. real runtime load and soak evidence;
6. public contracts, migrations, and rollback; and
7. independent-agent isolation on a shared host.

These gates are Auggy runtime obligations, not managed-platform work.
Horizontal scaling for one logical Auggy remains a separate, deferred product
decision. Release preparation starts after the seven engineering checkpoints
pass; the OSS/supply-chain, packaging, clean-install, public-repository, and
deployment gates below still apply afterward.

## Current release blockers

### P0 — Secret-scanning disposition before public visibility

Closed, 2026-07-28: the detector-shaped synthetic webhook fixture was replaced,
GitHub reports zero open secret-scanning alerts, and the independent
full-history path/signature audit found no real credentials. The repository was
made public only after those checks passed.

### P0 — Public repository and package identity

Update, 2026-07-28: the repository is public and anonymous access returns 200;
the full-history review passed; all six package manifests use the exact public
repository identity; the README, license, contribution, code-of-conduct, and
security paths exist; secret scanning, push protection, Dependabot security
updates, and private vulnerability reporting are enabled; and strict `main`
branch protection survived the visibility change. PR #169's merge ref has zero
open CodeQL alerts. The ten alerts still attached to the older default-branch
analysis must clear when the candidate merges and CodeQL analyzes `main`.

### P0 — Trusted publishing and provenance

Update, 2026-07-28: the repository is public; the protected `npm-publish` and
`security-eval` Environments exist with maintainer approval and exact tag/branch
policies; the evaluation key is environment-scoped; the legacy repository
secrets were deleted; all six npm trusted-publisher connections were
operator-confirmed; and package publishing disallows traditional tokens. The
remaining evidence is confirmation that the obsolete npm account token was
revoked and that the first RC publication displays OIDC provenance for every
package.

Before the RC:

- create the protected `npm-publish` Environment;
- configure npm trusted publishers for `auggy`, the four provider adapters,
  and `@auggy/evals`, bound exactly to this repository, `publish.yml`, and the
  `npm-publish` Environment;
- add an environment-only token fallback only if the initial OIDC migration
  truly requires it;
- create and protect the `security-eval` Environment and migrate its key to the
  environment-only name used by the trusted workflow;
- revoke and delete the legacy repository-level npm and evaluation secrets;
- verify that repository/dependency code runs only in the uncredentialed
  release job and that the credentialed job publishes only verified artifacts;
  and
- confirm npm displays automatically generated provenance for every RC package.

Current npm trusted publishing automatically generates provenance when OIDC
publishes a public package from a public repository. The workflow does not need
to add `--provenance`; it does need exact repository metadata and correct OIDC
claims.

### P0 — Release automation must support the actual release

The current release rehearsal only enables version-specific checks when the
package version differs from the PR base. Since `main` is already versioned
`0.5.0`, a same-version release-preparation PR would skip those checks.

Before the RC:

- make an explicit `release/*` PR invoke version-conflict, package-version
  parity, and pack checks even when the base already has the same version;
- support exact prerelease tags such as `v0.5.0-rc.1`;
- publish prereleases with the `next` dist-tag and stable releases with
  `latest`;
- keep stable and prerelease package versions identical across all six
  publishable packages;
- create a GitHub prerelease/release from the verified tag and attach checksums
  or otherwise document that npm provenance is the artifact identity; and
- add workflow contract tests for stable tags, prerelease tags, dist-tags,
  artifact names, and fail-closed malformed versions.

### P0 — Release truth and compatibility

Before the RC branch is cut:

- land the product north star and make it the canonical ownership boundary;
- correct every claim that `0.5.0` is already published;
- consolidate all changes since `v0.4.4` into the `0.5.0` changelog entry;
- identify breaking changes, including removed compatibility paths and new
  required public interface members;
- publish a stable/preview/unsupported capability matrix;
- ensure generated starter skills, examples, package READMEs, and reference
  docs describe the same 0.5 behavior; and
- state the single-replica and persistent-volume contract in the root README,
  deployment guide, health/operations docs, and release notes.

## Release-candidate gate

Create `release/0.5.0-rc.1` from a frozen `main`. Do not merge new features
after the freeze; accept only release-blocking fixes and documentation truth.

Required automated verification:

```sh
bun install --frozen-lockfile
bun run test:inventory
bun run test
bun run typecheck
bun run lint
bun run build:admin
bun audit --json
bun run smoke:release
git diff --check
```

`bun audit --json` sends dependency and lockfile-derived package metadata to
the advisory service. Obtain explicit operator approval for that egress at the
time the release gate is run and record only advisory results, not unrelated
environment data.

Additional release checks:

- run the PostgreSQL coordination suite against the pinned CI service even
  though replica mode remains disabled;
- run the security-eval trusted harness if its protected Environment is ready;
- inspect all six tarballs and import them in isolated consumer projects;
- install the packed CLI in an isolated prefix and scaffold each provider
  choice against local adapter tarballs;
- verify a generated agent boots, serves health and console assets, and rejects
  missing or unsafe configuration clearly;
- run a real hosted-model conversation with one supported provider;
- run the concierge and order-support examples through their authorized,
  denied, confirmation, restart, and failure paths; and
- confirm no sentinel credential appears in output, artifacts, argv captures,
  fixtures, generated clients, or logs.

Publish `0.5.0-rc.1` to npm under `next`, then verify from a machine or isolated
environment that has no repository checkout and no existing Auggy state:

```sh
npm view auggy@next version
npm i -g auggy@next
auggy --version
auggy create rc-smoke
auggy doctor
auggy run
```

Verify every provider/evals package at the exact RC version, every provenance
attestation, the GitHub prerelease, and the package links back to the public
source repository.

## Operational RC validation

The RC must prove the declared single-replica profile, not a fictional managed
fleet:

- deploy one generated Auggy to Railway using one persistent volume;
- validate health, console authentication, visitor admission, one real model
  turn, one deterministic route, one tool call, restart persistence, logs, and
  removal;
- exercise bounded same-thread and different-thread concurrency without
  claiming a universal traffic limit;
- run a bounded soak that watches memory, file descriptors, queue wait,
  provider latency, rejections, outcome-unknown state, and shutdown drain;
- kill and restart the process during queued and active work and verify the
  documented recovery behavior;
- test backup and restore of runtime-owned state on the supported volume; and
- record machine size, model/provider, limits, duration, and results so the
  evidence is reproducible rather than marketed as a general capacity number.

Any confirmed High or Medium security, data-loss, cross-peer authorization,
packaging, or clean-install failure blocks final `0.5.0`. A documented preview
limitation does not block the release unless the implementation violates its
stated boundary.

## Final 0.5.0 release

After the RC gate passes:

1. Cut `release/0.5.0` from the tested RC line.
2. Apply only confirmed RC fixes.
3. Set all six publishable packages to `0.5.0`.
4. Finalize the changelog date and release notes.
5. Repeat the automated release gate and focused tests for every RC fix.
6. Open the release PR and require CI, CodeQL, and release rehearsal to pass.
7. Merge without publishing from the PR.
8. Tag the exact merge commit `v0.5.0` and push the tag.
9. Verify npm publishes all six packages under `latest` with provenance.
10. Verify the GitHub Release, anonymous clone, clean install, scaffold, doctor,
    boot, docs links, and supported Railway deployment.
11. Deprecate no older version unless there is a concrete security or
    compatibility reason.
12. Monitor installation and issue reports before reopening feature work.

Rollback is a new patch or RC, never republishing the same npm version. A bad
RC can be deprecated without affecting `latest`. A bad stable release should
be deprecated and replaced with `0.5.1`; unpublishing is a last resort.

## Reconciliation of the previous seven workstreams

The previous plan mixed runtime obligations with managed-platform obligations.
They are reclassified as follows.

| Previous workstream | 0.5 OSS release disposition | Long-term owner |
| --- | --- | --- |
| Tenant cell and isolation | Do not build tenant provisioning. Require namespaces for Auggy-owned stores and test cross-peer/cross-agent isolation. | The deployer owns accounts, database roles, object-store prefixes, keys, queues, egress, and tenant infrastructure. |
| Observability, SLOs, and capacity | Ship bounded health, trace, scheduler, quarantine, and safe diagnostic contracts. Do not promise concierge/order-support SLOs. | The deployer defines dashboards, alerts, retention, and service SLOs. |
| Durable delivery and recovery | Keep explicit per-transport dedupe, reconciliation, and outcome-unknown semantics. Do not build a universal transactional outbox for 0.5. | Each augment owns its external delivery contract; applications use a queue/workflow engine when stronger durability is required. |
| Data lifecycle, backup, and DR | Document every runtime-owned state location, retention control, backup boundary, and restore order. Perform one supported-topology restore smoke. | The deployer owns backup infrastructure, legal hold, regional recovery, and RPO/RTO. |
| Provider resilience and routing | Keep bounded timeouts, cancellation, response limits, safe errors, and fail-closed restrictive routing. | Circuit breakers, multi-provider failover, and spend-aware routing remain optional adapters or post-release work. |
| Workload and chaos certification | Run a reproducible single-replica RC soak and publish no universal RPS claim. | Broader platform/machine/provider certification follows adopter demand. |
| Versioned contracts and upgrades | Document 0.5 migrations and breaking changes; exact pins remain recommended. | Stable public contracts, deprecation policy, and migration guarantees are 1.0 obligations. Rolling replica upgrades wait for supported replicas. |

## What remains for 1.0

`1.0.0` is an API and operator-confidence commitment, not completion of a
managed platform.

Before 1.0:

- obtain real adopter feedback from at least one post-0.4 public release;
- define and test the stable public TypeScript, configuration, route/client,
  storage, health, and migration contracts;
- provide a deprecation and upgrade policy;
- make the first-run, custom-augment, auth, deployment, backup, and recovery
  paths understandable without repository archaeology;
- repeat a complete security and dependency review against the public release
  candidate; and
- demonstrate that the release and provenance pipeline has already succeeded
  on the public repository.

Multi-replica support is valuable for high-traffic deployments, but it is not a
prerequisite for Auggy to be a useful OSS runtime or for `1.0.0` unless the
project chooses to advertise replicas as part of the 1.0 support contract.
