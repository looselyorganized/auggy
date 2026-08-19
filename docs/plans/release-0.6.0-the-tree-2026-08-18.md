# Release 0.6.0 — "the tree"

**Status:** Scoped, not started
**Date:** 2026-08-18
**Governing direction:** [`docs/ROADMAP.md`](../ROADMAP.md) — this plan implements the
0.6.0 entry there. If this plan and the roadmap disagree, the roadmap wins.
**Delete this file when 0.6.0 ships** (roadmap rule 1).

## Goal and exit criterion

**Goal.** A new user scaffolds a project, understands the tree, runs it in
Docker or on Railway, and the docs match.

**Exit criterion.** Release smoke is green on a fresh machine, including a
scaffolded project that typechecks, boots in Docker, and matches the published
docs. When that is true, 0.6.0 ships. Release candidates exist only to find
regressions against this criterion; they do not admit scope.

**Scope freeze.** The work items below are the release. Anything discovered
after work starts goes to 0.7.0 or `docs/todos.md`.

## Entry conditions

- `0.5.0` published to npm `latest` from PR #221 (`release/0.5.0`, verified
  2026-08-18: 4,530 tests / 0 fail, lint, typecheck, inventory, audit clean).
- `main` clean: the uncommitted `scripts/release-smoke.sh` rewrite from
  2026-08-18 is either finished and committed or reverted.
- The `feat/typescript-agent-project-definition` worktree is removed. It is
  superseded by the 2026-08-16 ADR and is salvage only. Its stray scaffolded
  `test-agent/` directory goes with it.

## Work items

### 1. Central YAML v2 authoring (branch `feat/central-yaml-v2`, worktree B)

The release. Design and phase ledger live in the branch's own documents, which
must be committed with it:

- ADR: `docs/adr/2026-08-16-central-yaml-agent-project-authoring.md`
- Plan: `docs/plans/central-yaml-agent-project-migration-2026-08-16.md`
  (phases 0–10 complete; phase 11 "implemented; external gates pending")

State on 2026-08-18 (verified in the worktree, nothing committed):

- 476 files, +64k/−16k, all staged. Typecheck 0 errors; Biome clean;
  `test:inventory` 334 runtime + 34 admin + 3 external; `test:runtime`
  4,623 pass / 0 fail; `test:admin` 362 pass / 0 fail.
- `bun run smoke:release` **fails** at B's own new gate
  (`scripts/release-smoke-central-yaml.ts`, "generated custom augment did not
  typecheck"): the fresh scaffold emits `tsconfig` `lib: ["ESNext"]` with no
  `types: ["bun"]` and adds only `typescript` to devDependencies — 1,059
  `Cannot find name 'Bun'/'process'/'Response'/'AbortSignal'`,
  `Cannot find module 'bun:test'`. Fix in `src/cli/scaffold-custom-augment.ts`
  and `src/cli/scaffold-package-json.ts` (add `@types/bun` devDep and
  `types: ["bun"]`); worktree A's scaffold does this and its smoke passes.
- Test-run artifacts to revert before commit:
  `packages/evals/src/security/fixtures/memory.sqlite{,-shm,-wal}` (modified)
  and `packages/evals/src/security/fixtures/data/notify-notify.db{,-shm,-wal}`
  (untracked).
- Remaining B ledger gates: full `bun run test`, `smoke:release` green, live
  console capture.

Then: open as a PR against `main` for a real review pass. It is a breaking
authoring change and ships as `0.6.0`, never as `0.5.x`.

### 2. Public docs rewritten for the new tree

Everything that shows `augments/<name>/augment.yaml` today. Known surfaces:

- auggy.dev (separate repo `auggy-site`): homepage file-tree diagram, docs
  pages, `llms.txt`, `llms-full.txt`, `api-reference.json`.
- This repo: `README.md`, `docs/*.md` (73 pages), `examples/*`,
  `packages/auggy-builder-skill`, `src/scaffold-starter-skills`.
- While in the docs: remove LORF/Zip/spine/brain language left in
  `docs/02-architecture-overview.md:131`, `07-built-in-augments.md:287,675,1530,1646`,
  `08-agent-lifecycle.md:40`, `10-system-diagrams.md:275-475`,
  `14-telegram-transport.md:298`; and the LORF byline in
  `src/cli/commands/create.ts:952`.

Docs are part of the exit criterion ("matches the published docs"), not a
follow-up.

### 3. Generic Docker path

The generator already exists (`src/cli/deploy/dockerfile.ts`, `FROM
oven/bun:1.2.14-alpine`; B already touches this file). Today the entrypoint
hard-fails without `RAILWAY_VOLUME_MOUNT_PATH=/app/data` and launches
`auggy dev --internal-mode railway`.

- Decouple the data-root contract from Railway: an `AUGGY_DATA_DIR` (or
  equivalent) that Railway sets to `/app/data` and any container operator can
  set themselves; keep the fail-closed check that the directory is a real
  mount.
- Expose it: either `auggy dockerfile` (writes the Dockerfile + entrypoint into
  the project) or ship a `Dockerfile` in the scaffold. Pick one; document
  `docker build` / `docker run -v` in `docs/18-deploy.md`.
- Railway path must remain byte-for-byte equivalent in behavior.

### 4. `create` / `init` DX

Findings from the 2026-08-18 black-box run of `auggy@0.5.0-rc.12`:

- `create`/`init` are interactive-only ("auggy create is interactive and needs
  a terminal"); no `--provider`, `--model`, `--yes`. Add them; keep the
  interactive path as the default when flags are absent.
- Ollama shortlist ignores installed models (`llama3.2:latest` present →
  "No tool-capable Ollama model found"; "Custom" buried last; unpriced confirm
  defaults to abort). Honor what `ollama list` reports; put installed models
  first.
- `augment remove --yes` → "unknown option" (add has it). Make add/remove
  symmetric.
- Anonymous `POST /agent/run` returns `428 anonymous_session_required` with no
  hint how to obtain a session. Add the hint to the error body.
- An invalid/revoked provider API key passes `auggy doctor` and
  `auggy models doctor` (presence-only checks) and then every turn fails as
  `RUN_ERROR {"message":"Internal error.","code":"INTERNAL"}` with **no line
  in the dev log** (observed 2026-08-18 with Anthropic
  `authentication_error`). Surface provider auth failures as a distinct error
  code with an operator log line, and have `models doctor` (or `doctor`
  behind a flag) probe the provider once.

B rewrites `src/cli/commands/create.ts`; do these in the same pass, not after.

### 5. Metadata honesty (carried from the 0.5.0 audit, deferred there as
runtime-touching)

- `package.json` `engines.node: ">=20"` while `bin` is a `#!/usr/bin/env bun`
  `.ts` file and 27 core files use `Bun.`/`bun:sqlite`; under Node 26 the CLI
  fails with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Reconcile with
  README §Requirements ("Bun >= 1.2 required at runtime").
- `settings.coordination` present → `src/agent.ts:803` refuses to start
  without saying "remove `settings.coordination`". Add the remedy to the error
  (test pinned at `tests/agent.test.ts:55`).
- README CLI table vs `auggy --help`: add `skill list/remove`,
  `augment remove/test`, `models doctor`, `jobs prune-audit`,
  `coordination migrate`; document `create/init --skip-install --refresh-models`,
  `run --no-open`, `augment create --force/--with-skill`.
- `CHANGELOG.md` rc.11 entry claims `--replace-key`; the flag does not exist
  and tests assert its absence — remove the claim if not already fixed on
  `release/0.5.0`.

## Order of work

1. Entry conditions (0.5.0 published; `main` clean; worktree A removed).
2. B: scaffold fix → revert artifacts → `smoke:release` green → PR → review →
   merge to `main` as the 0.6.0 base. Version bump to `0.6.0-rc.1` only after
   merge.
3. Items 3–5 as small PRs on top of B (they touch files B rewrites; do them
   after, not in parallel).
4. Docs rewrite (item 2) — repo docs alongside items 3–5; site rewrite last,
   against the final CLI/tree.
5. Exit-criterion run on a fresh machine: `bun add -g auggy@0.6.0-rc.N` →
   `auggy create --provider … --yes` → typecheck → `docker build/run` →
   `/health` → one turn → compare tree to published docs. Green → `0.6.0`.

## Explicitly not in 0.6.0

Visitor chat widget/example, embeddings-backed knowledge, the concierge
end-to-end demo, public launch — all **0.7.0**. New providers, channels,
deploy targets, multi-replica/PostgreSQL coordination, OpenTelemetry —
demand-driven, per the roadmap. AgentMail changes of any kind — only if a
user reports a defect.

## Ledger

Update after each substantial step with exact commands and results.

| Step | Status | Evidence | Remaining risk |
| --- | --- | --- | --- |
| Entry: 0.5.0 published | Pending | | |
| Entry: `main` clean | Pending | | |
| Entry: worktree A removed | Pending | | |
| 1. B scaffold fix + smoke green | Pending | | |
| 1. B merged to `main` | Pending | | |
| 3. Docker path | Pending | | |
| 4. create/init DX | Pending | | |
| 5. Metadata honesty | Pending | | |
| 2. Repo docs rewritten | Pending | | |
| 2. Site docs rewritten | Pending | | |
| Exit-criterion run (fresh machine) | Pending | | |
