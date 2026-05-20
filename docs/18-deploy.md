# Deploying an Auggy agent to Railway

This page covers `auggy deploy <name> --to railway` — the CLI path for shipping a single agent to Railway, the v1.0 cloud deployment target.

If you're deploying locally as a launchd service (macOS), see [`auggy start`](./07-built-in-augments.md) instead.

---

## Prerequisites

| | Why |
|---|---|
| **Bun** ≥ 1.2.0 ([install](https://bun.sh/install)) | The runtime; `auggy` is a TypeScript CLI executed by Bun. |
| **Railway CLI** ([install](https://docs.railway.com/develop/cli)) | The deploy command shells out to `railway`. Same trust pattern as `git push` trusts `git`. |
| `railway login` completed | Authenticates the Railway CLI session. `auggy deploy` does not store API tokens. |
| A Railway project | Create one in the [Railway dashboard](https://railway.com/new). You'll provide the project ID on first deploy. |
| `auggy create <name>` already run | Deploy operates on a registered agent. |

---

## First deploy

```bash
# 1. Make sure the agent runs locally
auggy dev zip
# (Ctrl-C to stop)

# 2. Deploy to Railway
auggy deploy zip --to railway
```

The CLI walks you through:

1. **Presence + auth checks** — confirms `railway` is installed and logged in.
2. **Project ID prompt** — paste the project ID from the Railway dashboard URL (e.g. `proj_abc123`).
3. **Bundle staging** — copies your agent directory minus `.env`, `*.db*`, `workspace/`, `node_modules/`, `.git/`, `.worktrees/`, `.claude/`, `.DS_Store`, `*.tmp` into a temp dir. The agent's `package.json` + `bun.lock` (per-agent manifest from v0.3.2) ARE included so the image can install your pinned deps.
4. **Dockerfile + entrypoint generation** — written into the staging dir. Static; not operator-tunable at v1.0. The image copies `package.json` + `bun.lock` first, runs `bun install` to materialize `node_modules/` inside the image, then COPYs the rest of the agent dir; the entrypoint invokes `bunx auggy dev` so it uses the per-agent install rather than a global `auggy`.
5. **Secrets diff + confirm** — shows what's about to be pushed to Railway (with values redacted). Decline aborts the deploy. Pass `--yes` to skip.
6. **`railway link`** — connects the staging dir to your `<name>` service (auto-created if it doesn't exist in the project).
7. **`railway volume add`** — provisions a persistent volume `<name>-data` mounted at `/app/data`. Holds all SQLite-backed state across redeploys.
8. **`railway domain --generate`** — assigns a `<name>-production-xxxx.up.railway.app` URL.
9. **Push env vars** — your `.env` entries + `AUGGY_PUBLIC_URL` (the just-generated URL) are pushed via `railway variables --set`.
10. **`railway up --detach`** — uploads the bundle, kicks off the build and deploy.
11. **Metadata write** — the cloud record lands in `~/.auggy/agents/zip/.auggy-meta.json` so subsequent `auggy deploy zip` runs are idempotent redeploys.

Follow the build in the [Railway dashboard](https://railway.com) or `railway logs`.

---

## Redeploy

A re-run of the same command IS the redeploy. There's no separate `redeploy` verb.

```bash
auggy deploy zip --to railway
```

What changes vs. first deploy:

- Project ID is read from the existing `cloud` record — no prompt.
- Volume is not re-added; the existing one is preserved.
- Secrets are re-pushed (so updating `.env` and redeploying is the workflow).
- `deployedAt` in the index is refreshed.

---

## Cost surface

Auggy's `layeredMemory` augment ships with `autoSave: true` by default and a per-trust-level cadence:

| Trust level | Cadence | Implication |
|---|---|---|
| `creator` | every-turn | One extraction LLM call per turn |
| `agent` | every-N-turns (N=3) | One extraction call every 3 turns |
| `public.recognized` | every-turn | One extraction call per turn |
| `public.anonymous` | session-end-only | One extraction call at session end |

Each extraction call hits the configured extraction engine (Haiku 4.5 by default, ~$0.0005-0.001 per call). The autoSave eval suite (see `evals/layered-memory/`) measures the per-call cost on real Haiku — typically $0.0001-0.005 per extraction.

**Recommendation:** set a daily ceiling via the `budgets` augment:

```yaml
augments:
  - type: budgets
    options:
      dailyBudgetUsd: 5.00
```

This caps total daily spend (user-facing + extraction). If the cap is hit, the kernel's 2PC turn-gate refuses new turns until the next day. See [ADR-027](../../lo/docs/solutions/architecture/adr-027-internal-turn-admission.md) for how internal extraction turns flow through the same budget.

---

## Persistent state

Railway mounts a volume at `/app/data`. The entrypoint script symlinks four SQLite paths into the volume:

- `/app/memory.db` → `/app/data/memory.db` (`layeredMemory` augment)
- `/app/budgets.db` → `/app/data/budgets.db` (`budgets` augment)
- `/app/visitor-auth.db` → `/app/data/visitor-auth.db` (`visitorAuth` augment)
- `/app/link.db` → `/app/data/link.db` (`link` augment, when present)

agent.yaml's `dbPath: ./memory.db` works unchanged — the symlinks make it transparent.

**Drift risk:** if a future augment ships with a different SQLite path, update `SQLITE_DB_NAMES` in `src/cli/deploy/dockerfile.ts` (and add it to this doc). The `cross-session-recall` grader in the layered-memory eval suite catches data loss empirically.

---

## visitorAuth on Railway

The `visitorAuth` augment requires a `publicUrl` for magic-link email rendering. On Railway, the deploy command sets `AUGGY_PUBLIC_URL` to the generated domain BEFORE the first boot. In your agent.yaml:

```yaml
augments:
  - type: visitorAuth
    options:
      publicUrl: ${AUGGY_PUBLIC_URL}
```

The interpolation resolves at boot. First deploys work because the deploy command provisions the domain → sets the env var → triggers `railway up` in that order ([D7 of the deploy plan](../../../docs/superpowers/plans/2026-05-06-aug1-deploy-railway.md)).

---

## Tear-down

```bash
# Remove from your local index AND destroy the Railway service
auggy remove zip --cloud --yes
```

What `--cloud` does:

1. Local agent dir + index entry cleared (same as `auggy remove zip`).
2. Railway service is deleted via `railway service delete --yes`.
3. If Railway destruction fails, the warning is logged but local cleanup still proceeds — you may need to delete the service manually via the Railway dashboard.

The Railway volume is **NOT** automatically deleted (Railway retains it as a safety measure). Delete it explicitly from the dashboard if you don't need the data.

---

## What you should NOT expect at v1.0

- **Auto-rollback** on failed deploys. If `railway up` succeeds but the agent crashes at boot, Railway's auto-restart loop kicks in but doesn't roll back to the previous build. Use `railway logs` to diagnose.
- **Multi-instance / horizontal scaling.** One Railway service runs one Auggy instance. The SQLite-on-volume design assumes a single writer.
- **Plugin abstraction for other providers.** `--to fly` / `--to render` are deferred until concrete demand ([ADR-021](../../../docs/solutions/architecture/adr-021-agent-storage-and-deployment-locations.md)).
- **Cross-machine cloud-record sync.** Each developer machine has its own `~/.auggy/agents/<name>/.auggy-meta.json`. Cloud deployment doesn't sync state back.
- **Built-in observability.** Use Railway's metrics dashboard and `railway logs`. Long-term observability is a v2 concern.

---

## Troubleshooting

| Symptom | Diagnosis + fix |
|---|---|
| `railway: command not found` | Install the Railway CLI: https://docs.railway.com/develop/cli |
| `Unauthorized. Run \`railway login\` first.` | Re-run `railway login` and follow the browser flow. |
| `Agent "X" not registered` | Run `auggy create X` first, then `auggy deploy X`. |
| First-deploy fails at `railway volume add` | The Railway project may not support volumes on the free tier. Upgrade or pick a different project. |
| visitorAuth refuses to boot — "publicUrl required" | Check that your agent.yaml has `publicUrl: ${AUGGY_PUBLIC_URL}` and the deploy actually generated a domain. Re-run `auggy deploy <name>` to refresh. |
| Memory disappears after redeploy | Check the volume is mounted (Railway dashboard → service → Volumes). If empty, the symlink list in the Dockerfile may be missing your dbPath — check `src/cli/deploy/dockerfile.ts`'s `SQLITE_DB_NAMES`. |
| Daily budget cap hit unexpectedly | autoSave extraction calls count against the cap. Run `evals/layered-memory/run.ts --smoke` to measure your per-extraction cost; lower the cadence in `agent.yaml`'s `layeredMemory.options.autoSave.extractionFrequency` if needed. |
