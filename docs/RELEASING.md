# Releasing auggy

This is the explicit checklist for cutting a release of the `auggy` npm package. Anything you do that deviates from this list is improvisation; codify the new step here before doing it twice.

## The core principle: PRs ≠ releases

**Feature PRs do not bump the version.** Ordinarily, `package.json.version`
reflects the last published release. The handful of commits between releases
land on `main` without version bumps. When you decide it is time to ship, that
is a deliberate release PR whose job is to set the version, update the
changelog, and merge.

This separation is enforced by `release-rehearsal.yml`: the npm-version-conflict
and tarball gates run when the PR bumps the version **or** when its head branch
uses the explicit `release/*` namespace. The explicit branch rule prevents a
release candidate from bypassing admission checks through an unusual version
or retry path; ordinary feature PRs still run the full test and packed-release
smoke without contacting npm for release admission.

Pre-1.0 (semver §4: *"Anything MAY change at any time"*), this lets us ship at high velocity. When we go 1.0, the same workflow shape will accommodate stricter cadence (RC tags, dist-tags) without redesign.

## TL;DR

```bash
# After the release/X.Y.Z PR and all release gates pass:
git checkout main && git pull
git tag vX.Y.Z                  # tag MUST match all six package versions
git push origin vX.Y.Z
# CI uses next + a GitHub prerelease for prerelease SemVer, otherwise latest.
```

## Current release state

As of 2026-08-05, npm's stable `latest` version for all six packages is `0.4.4`
and `next` is `0.5.0-rc.6` for all six. The `v0.5.0-rc.1` through
`v0.5.0-rc.6` tags are published, immutable release candidates. The RC.6
GitHub prerelease contains all six verified package tarballs and `SHA256SUMS`.
Registry metadata and the corresponding Git tag—not a working-tree version—
remain the authority for release state.

The next release follows the
[OSS Production Release Plan](./plans/production-readiness-roadmap-2026-07-24.md).
On 2026-07-28, the repository became public after the full-history secret and
artifact audit passed. The protected GitHub Environments, environment-only
evaluation secret, six npm trusted-publisher connections, and package-level
token restrictions are configured. All six `0.5.0-rc.6` packages expose npm's
SLSA provenance attestation. Final `0.5.0` remains a separate release PR and
requires fresh verification and attestations for its exact six artifacts; prior
candidates are not evidence for stable. It must publish under `latest` only
after every remaining RC gate passes.

All publishable package manifests contain the exact public GitHub `repository`
URL required by npm trusted publishing. Reconfirm each attestation on the exact
candidate before a stable release rather than treating the prior RC as proof of
future workflow configuration.

## The invariant

**Every npm version maps to an inspectable git tag.** No exceptions going forward. The `0.3.0` release predates this rule and is documented as a name-claim publish with a synthetic backfill tag pointing at the closest matching source — see *§ Historical gaps* below.

Concrete checks the workflows enforce:

| Check | Where | When it fires | What it gates |
|---|---|---|---|
| Lint / typecheck / tests | `ci.yml` + `release-rehearsal.yml` | Every PR to main | Code regressions |
| All six versions not already on npm | `release-rehearsal.yml` | Version change or explicit `release/*` PR | Catches registry conflicts before merge |
| Tarball packaging dry-run (`npm pack --dry-run`) | `release-rehearsal.yml` | Version change or explicit `release/*` PR | Catches missing files and broken package entry points |
| Tag suffix matches `package.json.version` | `publish.yml` (on tag push) | Tag push only | Catches version/tag drift |
| Tag is exact stable or prerelease SemVer | `scripts/release-metadata.ts` + `publish.yml` | Tag push only | Rejects malformed, ambiguous, and build-metadata tags |
| Prerelease uses `next`; stable uses `latest` | `scripts/release-metadata.ts` + `publish.yml` | Tag push only | Prevents an RC from replacing npm `latest` |
| Existing version has identical tarball integrity | `publish.yml` (idempotency gate) | Tag push only | Safe retries skip only byte-identical artifacts and reject mixed-commit releases |
| GitHub release matches tag posture | `publish.yml` | After npm publication | Publishes the six verified tarballs and `SHA256SUMS` as a prerelease or stable release |

### Tracked test-surface inventory

`tests/ci/test-surface-manifest.json` is the canonical bounded test inventory
for both primary CI and release rehearsal. The validator derives exact test
paths from Git's tracked tree, rejects unassigned or multiply assigned tests,
and executes each shard sequentially with exact `./` argv entries. Run:

```bash
bun run test:inventory
bun run test
```

Tests added under an existing selector enter its shard automatically. A new
area within a declared suite root must be assigned explicitly in the manifest.
A new repository-level test root requires deliberate expansion of both the
suite-root policy and manifest; otherwise its test-shaped files fail closed.
Stale selectors and exclusions also fail. Untracked local tests are
intentionally not part of release evidence until they are added to Git. The
inventory requires a complete checkout, so source archives and sparse
checkouts should use direct `bun test` commands for local exploration rather
than claiming the release gate passed.

### AgentMail provider canary gate

The manual `agentmail-provider-canary.yml` workflow verifies the real
existing-account provisioning contract without making a PR check depend on an
external paid service. Before its first use:

1. Create the protected `agentmail-provider-canary` GitHub Environment.
2. Allow deployments from `main` only and require a reviewer.
3. Add `AGENTMAIL_CANARY_ACCOUNT_API_KEY_ENV_ONLY` to that Environment only.
   Use a dedicated AgentMail account key capable of creating the canary inbox
   and listing, creating, and deleting that inbox's API keys; do not add a
   repository-level secret with the same or unsuffixed name.

Dispatch the workflow manually from canonical `looselyorganized/auggy` `main`
only. Never run it from a PR or fork. The first approved run creates one
persistent canary inbox; later runs submit the same stable `client_id` twice and
must resolve that same inbox. Each run first reconciles stale keys under the
reserved canary prefix, creates one least-privilege inbox-scoped key with a
bounded name derived from `GITHUB_RUN_ID`, validates the same create response
used by CLI setup, and reconciles the key through AgentMail's official
inbox-scoped list/delete endpoints. The persistent inbox is intentional; the
runtime key is disposable. The canary sends no mail, retains no scoped key, and
logs neither credentials, key identifiers, nor provider response data. A
cleanup failure is a hard failure and requires inspecting the protected canary
inbox before retrying.

When a release changes AgentMail provisioning requests or responses, the
provisioning client, or CLI setup behavior, this canary is mandatory pre-tag
evidence. After the release PR merges to `main`, dispatch it for that exact main
SHA, wait for the protected-Environment approval and green result, and record
the Actions run URL **and its `headSha`** in the merged release PR or release
record. The release tag must point to that same SHA. If the intended tag commit
changes, rerun the canary for the replacement SHA and replace the recorded
evidence before tagging. For releases unrelated to AgentMail provisioning, the
canary remains optional. It never publishes packages or replaces the normal
release gates.

## Cutting a new release

### 0. Between releases (feature PRs)

Just merge them. Don't touch `package.json.version`. Don't touch `CHANGELOG.md`'s released sections. Optionally append to `CHANGELOG.md`'s `[Unreleased]` section so the next release PR has the entries ready to harvest.

`release-rehearsal.yml`'s registry-conflict and dry-pack gates skip automatically
on unchanged non-release PRs. Full tests and packed-release smoke still run.

### 1. Release PR (the deliberate act)

In a dedicated branch off `main` (name suggestion: `release/X.Y.Z`):

- [ ] Run the cold-machine DX walkthrough below and paste the result into the PR description
- [ ] Set the same exact version in all six publishable package manifests. For
  an RC, use the exact prerelease `X.Y.Z-rc.N` and update internal `auggy` /
  `@auggy/openai` ranges to `^X.Y.Z-rc.N`; final `X.Y.Z` restores `^X.Y.Z`.
- [ ] Update `CHANGELOG.md`:
  - Move `[Unreleased]` items into a new `[X.Y.Z[-prerelease]] - YYYY-MM-DD` section
  - Group entries under `### Added` / `### Changed` / `### Fixed` / `### Architecture` / `### Process` per [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
- [ ] Push, open PR. The PR's title should be `release: vX.Y.Z` so it's obvious in history.
- [ ] **Wait for `release-rehearsal` to pass.** Every `release/*` PR runs all
  gates even when its version already matches `main`.
- [ ] Merge to `main` (squash; matches repo convention)

### Cold-machine DX walkthrough

This is mandatory for `1.0.0` and strongly recommended for substantial pre-1.0
minor releases such as `0.5.0`. Run it from a shell/profile that does not have an
existing Auggy state directory. Do not skip the manual browser checks; this gate
exists to catch first-run and packaging failures that unit tests miss.

First run the automated release smoke:

```bash
bun run smoke:release
```

This packs all six local packages, verifies the tarball contents, installs the
CLI and providers into isolated consumers, scaffolds a fresh agent through a
PTY, and boots the packed runtime. It proves `/health`, the authenticated
Console SPA, the fixed no-JavaScript password variants and stylesheet,
password/session behavior, one-time CLI ticket consumption and replay
rejection, pre-auth asset confinement, and the MCP cloud-preflight failure
path.

`bun run smoke:release` is the authoritative pre-publish agent-install smoke. It
packs local `auggy` and the default Anthropic adapter into temp tarballs so the
test does not require the new version to already exist on npm.

If you manually test only the local CLI tarball before publishing, pin generated
agents to that same core tarball:

```bash
bun install --frozen-lockfile
npm pack
PACK="$(ls -t auggy-*.tgz | head -1)"
npm i -g "$PWD/$PACK"
export AUGGY_SCAFFOLD_AUGGY_SPEC="file:$PWD/$PACK"
```

The root package's `prepack` lifecycle rebuilds and independently verifies the
authenticated Console SPA plus the three fixed no-JavaScript login variants
before npm creates the tarball. Do not pass `--ignore-scripts` when packing from
a source checkout; that bypasses this stale/missing-artifact guard. The publish
workflow uses `--ignore-scripts` only when publishing the already-built,
smoke-verified tarball artifact.

From the repository checkout, `auggy create` automatically pairs that local
core tarball with the matching local provider adapter under `packages/`. For a
smoke test outside the checkout, also pack the selected adapter and set
`AUGGY_SCAFFOLD_ENGINE_SPEC=file:/absolute/path/to/adapter.tgz`.

Outside an Auggy source checkout, omitting `AUGGY_SCAFFOLD_AUGGY_SPEC` makes
`auggy create` write the normal npm range (`^X.Y.Z`), so a pre-release smoke can
accidentally install an older published package with the same version. Before
the matching engine adapters are published, a full isolated agent dependency
install also needs local adapter tarballs; use `bun run smoke:release` for that
path.

For the RC post-publish walkthrough, use the `next` package:

```bash
mv ~/.auggy ~/.auggy.backup-$(date +%Y%m%d%H%M%S) 2>/dev/null || true
npm i -g auggy@next
auggy --version

auggy create dx-smoke
cd dx-smoke
# Add the selected provider key to .env
auggy doctor
auggy run
```

Manual checks:

- [ ] `auggy run` opens `/console/chat` through a one-time local sign-in
- [ ] `auggy console` opens the running local Console; `auggy console --cloud` opens the saved Railway target when present
- [ ] If automatic sign-in is unavailable, `/console/login` works without JavaScript and the CLI points to `AUGGY_WEB_TOKEN` without printing its value
- [ ] Sending a message returns a model response
- [ ] Missing-provider-key failure, if reproduced, names the exact `.env` path and key

Package artifact checks are covered by `bun run smoke:release`:

- [ ] Tarball includes CLI source, `README.md`, `CHANGELOG.md`, `LICENSE`, `SECURITY.md`, and `admin/dist/index.html`
- [ ] Tarball includes built Console JS/CSS plus the login manifest, three fixed HTML variants, and one fingerprinted login stylesheet
- [ ] Tarball contains no login JavaScript or source maps
- [ ] Tarball excludes source maps and local-only state (`.env`, `.git/`, `.auggy/`, `node_modules/`, `docs/`, `tests/`)

Augment checks:

```bash
auggy augment add visitorAuth
auggy doctor

cd dx-smoke
auggy augment create weather --without-skill
auggy augment test augments/weather
auggy doctor
```

Deploy checks:

```bash
railway login
auggy deploy
auggy logs
```

Manual checks:

- [ ] Deploy output includes public URL, `/health`, `/console`, and `/console/chat`
- [ ] Public `/health` returns success or `auggy logs` gives actionable boot errors
- [ ] Public `/console/chat` opens
- [ ] `auggy deploy --yes` works as a redeploy

Cleanup:

```bash
auggy remove --cloud --yes
cd ..
```

### 2. Tag

```bash
git checkout main && git pull
# For an AgentMail-provisioning release, this must equal the recorded green
# canary run's `headSha` (inspect it with `gh run view <run-id> --json headSha`).
git rev-parse HEAD
git tag v<major>.<minor>.<patch>[-<prerelease>] # MUST match all package versions
git push origin v<major>.<minor>.<patch>[-<prerelease>]
```

### 3. Watch the publish workflow

The `publish.yml` workflow fires on a matching tag push. It:

1. proves the tag commit belongs to `main` and parses exact release metadata;
2. runs the complete suite and packs all six artifacts without credentials;
3. publishes only those verified artifacts through npm OIDC, using `next` for
   prereleases and `latest` for stable versions; and
4. creates the corresponding GitHub prerelease/release with the tarballs and a
   sorted `SHA256SUMS` file.

Find the run at `https://github.com/looselyorganized/auggy/actions/workflows/publish.yml`.

### 4. Verify

```bash
npm view auggy@next version # RC; use `npm view auggy version` for stable
npm i -g auggy@next         # RC; omit @next for stable
auggy --version             # should print the new version (auggy reads from package.json)
```

## Rollback

**npm doesn't allow re-publishing the same version once it's on the registry.** If a publish lands and you regret it:

- Within 72h: `npm unpublish auggy@X.Y.Z` removes it (and tombstones the version number — that exact version can never be republished by anyone)
- After 72h: only `npm deprecate auggy@X.Y.Z "<reason>"` is available; the artifact stays but warns on install

Treat both as last-resort. The discipline is to catch issues in `release-rehearsal` (a free PR check) before they hit a tag.

If a tag push fails halfway (publish errored after the tag was created):

```bash
# Delete the tag locally + remotely so retrying is clean
git tag -d v<X.Y.Z>
git push --delete origin v<X.Y.Z>
# Fix the issue, then re-tag and push
```

The publish workflow's idempotency gate makes a repeat push safe only when every
already-published package has the same registry `dist.integrity` as the locally
verified tarball. A same-version artifact from a different commit fails closed;
the workflow will not assemble a release from mixed package bytes.

## Provenance gate

The source repository is public and the release workflow is configured for npm
trusted publishing. npm's generated SLSA provenance attestation is present for
all six `0.5.0-rc.6` packages, so the RC.6 provenance gate is complete. Stable
`0.5.0` requires fresh attestation checks on its own exact package artifacts.

The publish workflow separates uncredentialed verification from publication.
Repository and dependency code runs in `verify`, which has neither
`id-token: write` nor an npm token. Only the dependent `publish` job receives
OIDC permission, and it consumes the already-packed artifacts with fixed
workflow commands. Publication is OIDC-only: the workflow accepts no npm
token. It uses Node 24 and requires npm 11.5.1 or newer.

Required external publishing configuration:

1. Create an `npm-publish` GitHub Environment. Allow deployments only from
   protected release tags matching `v*.*.*`; require a reviewer if repository
   policy permits.
2. Configure npm trusted publishers for all six packages (`auggy`, the four
   provider adapters, and `@auggy/evals`) with these exact claims:
   organization `looselyorganized`, repository `auggy`, workflow filename
   `publish.yml` (npm expects the filename, not the path), Environment
   `npm-publish`, and allowed action `npm publish` only. Do not allow
   `npm stage publish` for this workflow.
3. Review every package's npm Trusted Publisher settings to confirm all five
   claims above.
4. Revoke the legacy npm token, delete the repository-level `NPM_TOKEN`, and
   disallow token-based publishing in npm once the publishers are configured.
5. Create the protected `security-eval` Environment, migrate the paid-eval key
   to `ANTHROPIC_API_KEY_SECURITY_EVAL_ENV_ONLY`, then delete the legacy
   repository-level evaluation secret.

For `0.5.0-rc.1`, the Environments, trusted-publisher connections,
environment-only evaluation key, package-level token restrictions, and GitHub
secret migration were completed on 2026-07-28. The `0.5.0-rc.2` publication
then produced attestations for all six packages, providing the authoritative
end-to-end OIDC proof. The `0.5.0-rc.3` publication repeated exact-candidate
verification and produced fresh attestations for all six packages. The
`0.5.0-rc.4` publication repeated that verification and produced fresh
attestations for all six packages. The `0.5.0-rc.5` publication repeated exact
candidate verification, published six verified tarballs plus `SHA256SUMS` in
the GitHub prerelease, and produced fresh attestations for all six packages.
The `0.5.0-rc.6` publication repeated exact-candidate verification, published
six checksum-verified tarballs plus `SHA256SUMS`, and produced fresh
attestations for all six packages.
Confirm the obsolete npm account token remains revoked and recheck
configuration before every tag; configuration drift makes publication fail
closed. Stable `0.5.0` requires fresh attestations for its exact six artifacts;
prerelease candidates are not evidence for it.

Current npm trusted publishing automatically generates provenance for public
packages published from public GitHub repositories; no `--provenance` flag is
required. Exact package `repository` metadata, the public repository, a
GitHub-hosted runner, and `id-token: write` remain required. Verify every RC
package page shows its provenance attestation before publishing final `0.5.0`.

The supply-chain integrity signal is meaningful for OSS adopters. Don't ship v1.0 without it.

## Historical gaps

### `auggy@0.3.0` — name-claim publish, no clean git tag

`auggy@0.3.0` was published manually on 2026-05-12 to claim the unscoped `auggy` package name on npm (the name had been unpublished by a prior occupant). The publish came from a working tree based on commit `c15d3cb` (the then-current main) with `package.json.version` manually bumped to `0.3.0` in the local working copy, never committed to a branch.

The synthetic backfill tag `v0.3.0` (pushed retroactively) points at a dangling commit that exactly matches the published tarball: `c15d3cb` + the package.json bump. It's not on any branch — it's only reachable via the tag — and its sole purpose is `git checkout v0.3.0` reproducibility.

From `v0.3.1` onward, every release follows the cut-from-main flow above. No more dangling commits.

## Things this checklist does NOT cover (yet)

- **Cherry-pick / hotfix releases.** When we have a `release/X.Y` branch alongside `main` and need to ship a patch from there without dragging in main. We'll codify it when we hit the case.
- **Independent package versioning.** Core, all four provider adapters, and
  `@auggy/evals` currently release in lockstep. Independent version lines need
  a separate design before use.

When you do one of the above for the first time, add a section here.
