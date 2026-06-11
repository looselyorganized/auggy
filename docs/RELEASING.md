# Releasing auggy

This is the explicit checklist for cutting a release of the `auggy` npm package. Anything you do that deviates from this list is improvisation; codify the new step here before doing it twice.

## The core principle: PRs ≠ releases

**Feature PRs do not bump the version.** `package.json.version` always reflects the *last published* release. The handful of commits between releases land on `main` without version bumps. When you decide it's time to ship, *that* is a deliberate "release PR" — a separate, intentional PR whose entire job is to bump the version, update the changelog, and merge.

This separation is enforced by `release-rehearsal.yml`: the npm-version-conflict gate and tarball-packaging gate **only run when the PR bumps the version**. Feature PRs see lint/typecheck/test (defense-in-depth, also covered by `ci.yml`) — and that's it.

Pre-1.0 (semver §4: *"Anything MAY change at any time"*), this lets us ship at high velocity. When we go 1.0, the same workflow shape will accommodate stricter cadence (RC tags, dist-tags) without redesign.

## TL;DR

```bash
# On main, version-bumped and CHANGELOG-updated PR already merged:
git checkout main && git pull
git tag v0.3.2                   # tag MUST match package.json version
git push origin v0.3.2
# CI publishes to npm + creates GitHub Release; watch the workflow run.
```

## The invariant

**Every npm version maps to an inspectable git tag.** No exceptions going forward. The `0.3.0` release predates this rule and is documented as a name-claim publish with a synthetic backfill tag pointing at the closest matching source — see *§ Historical gaps* below.

Concrete checks the workflows enforce:

| Check | Where | When it fires | What it gates |
|---|---|---|---|
| Lint / typecheck / tests | `ci.yml` + `release-rehearsal.yml` | Every PR to main | Code regressions |
| `package.json.version` not already on npm | `release-rehearsal.yml` | **Only when the PR bumps the version** | Catches conflicts on release PRs |
| Tarball packaging dry-run (`npm pack --dry-run`) | `release-rehearsal.yml` | **Only when the PR bumps the version** | Catches missing files / broken bin paths on release PRs |
| Tag suffix matches `package.json.version` | `publish.yml` (on tag push) | Tag push only | Catches version/tag drift |
| Tag is `v<major>.<minor>.<patch>` | `publish.yml` (regex `v*.*.*`) | Tag push only | Only releases trigger publishes |
| Version already on npm? | `publish.yml` (idempotency gate) | Tag push only | Retroactive tags don't republish |

## Cutting a new release

### 0. Between releases (feature PRs)

Just merge them. Don't touch `package.json.version`. Don't touch `CHANGELOG.md`'s released sections. Optionally append to `CHANGELOG.md`'s `[Unreleased]` section so the next release PR has the entries ready to harvest.

`release-rehearsal.yml`'s version-conflict + tarball gates **skip automatically** on no-version-bump PRs. Lint/typecheck/test still run.

### 1. Release PR (the deliberate act)

In a dedicated branch off `main` (name suggestion: `release/X.Y.Z`):

- [ ] Run the cold-machine DX walkthrough below and paste the result into the PR description
- [ ] Bump `package.json.version` (semver: patch for fixes, minor for additive features, major for breaking changes; pre-1.0 we treat minor bumps liberally for shipped features)
- [ ] Update `CHANGELOG.md`:
  - Move `[Unreleased]` items into a new `[X.Y.Z] - YYYY-MM-DD` section
  - Group entries under `### Added` / `### Changed` / `### Fixed` / `### Architecture` / `### Process` per [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
- [ ] Push, open PR. The PR's title should be `release: vX.Y.Z` so it's obvious in history.
- [ ] **Wait for `release-rehearsal` workflow to pass** — for this PR (because the version bumped) it runs ALL gates: lint/typecheck/test + version-vs-npm + `npm pack --dry-run`. If any is red, the real publish will fail too. Fix before merging.
- [ ] Merge to `main` (squash; matches repo convention)

### Cold-machine DX walkthrough

This is the v1.0 release gate. Run it from a shell/profile that does not have an existing Auggy state directory. Do not skip the manual browser checks; this gate exists to catch first-run and packaging failures that unit tests miss.

First run the automated release smoke:

```bash
bun run smoke:release
```

This packs the local CLI, verifies the tarball contents, installs it into an
isolated prefix, scaffolds a fresh agent through a PTY, boots `/health`, and
checks the MCP cloud-preflight failure path.

```bash
mv ~/.auggy ~/.auggy.backup-$(date +%Y%m%d%H%M%S) 2>/dev/null || true
npm i -g auggy
auggy --version

auggy create dx-smoke
cd dx-smoke
# Add the selected provider key to .env
auggy doctor
auggy run
```

Manual checks:

- [ ] `/console/chat` opens in the browser
- [ ] Sending a message returns a model response
- [ ] Missing-provider-key failure, if reproduced, names the exact `.env` path and key

Package artifact checks are covered by `bun run smoke:release`:

- [ ] Tarball includes CLI source, `README.md`, `CHANGELOG.md`, `LICENSE`, and `admin/dist/index.html`
- [ ] Tarball includes built console JS/CSS
- [ ] Tarball excludes source maps and local-only state (`.env`, `.git/`, `.auggy/`, `node_modules/`, `docs/`, `tests/`)

Augment checks:

```bash
auggy add visitorAuth
auggy doctor

auggy augment create weather --dir augments/weather
auggy augment test augments/weather
auggy augment install dx-smoke augments/weather
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
git tag v<major>.<minor>.<patch>          # MUST match package.json
git push origin v<major>.<minor>.<patch>
```

### 3. Watch the publish workflow

The `publish.yml` workflow fires on tag push. It runs:
1. Already-published check (read `npm view auggy@<ver>`)
2. If new version: typecheck + tests + version-matches-tag + `npm publish`
3. If already on npm: skip the rest, succeed (this is the retroactive-tag path)

Find the run at `https://github.com/looselyorganized/augment-1/actions/workflows/publish.yml`.

### 4. Verify

```bash
npm view auggy versions     # confirm the new version appears
npm i -g auggy              # confirm install works on a fresh shell
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

The publish workflow's idempotency gate means a repeat push to the same version is safe even if the first attempt half-succeeded (e.g., npm published but the workflow then failed at a later step).

## Provenance gate

**Provenance is currently OFF.** `npm publish --provenance` requires the source repo be **public** (sigstore can only attest from public repos).

To turn provenance back on (when augment-1 goes OSS-public):

1. Set repo visibility to Public in GitHub Settings
2. In `.github/workflows/publish.yml`, change the publish command to:
   ```yaml
   run: npm publish --provenance --access public
   ```
3. Cut a release and verify the npm package page shows the green "Provenance" badge with a sigstore transparency-log link
4. Update this doc — remove the gate, note the date provenance went live

The supply-chain integrity signal is meaningful for OSS adopters. Don't ship v1.0 without it.

## Historical gaps

### `auggy@0.3.0` — name-claim publish, no clean git tag

`auggy@0.3.0` was published manually on 2026-05-12 to claim the unscoped `auggy` package name on npm (the name had been unpublished by a prior occupant). The publish came from a working tree based on commit `c15d3cb` (the then-current main) with `package.json.version` manually bumped to `0.3.0` in the local working copy, never committed to a branch.

The synthetic backfill tag `v0.3.0` (pushed retroactively) points at a dangling commit that exactly matches the published tarball: `c15d3cb` + the package.json bump. It's not on any branch — it's only reachable via the tag — and its sole purpose is `git checkout v0.3.0` reproducibility.

From `v0.3.1` onward, every release follows the cut-from-main flow above. No more dangling commits.

## Things this checklist does NOT cover (yet)

- **Pre-release tags (`v1.0.0-rc.1`).** The workflow regex `v*.*.*` doesn't match these. When we need prerelease, update the regex AND add an npm dist-tag step (`--tag next`) so prereleases don't replace `latest`.
- **Cherry-pick / hotfix releases.** When we have a `release/X.Y` branch alongside `main` and need to ship a patch from there without dragging in main. We'll codify it when we hit the case.
- **Cross-package monorepo releases.** Not relevant until we have more than one publishable package in this repo.

When you do one of the above for the first time, add a section here.
