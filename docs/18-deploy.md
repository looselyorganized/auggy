# Deploying an Auggy agent to Railway

This page covers `auggy deploy` — the CLI path for shipping a single agent to Railway, the v1.0 cloud deployment target.

If you're deploying locally as a launchd service (macOS), see [`auggy start`](./07-built-in-augments.md) instead.

---

## Prerequisites

| | Why |
|---|---|
| **Bun** ≥ 1.2.0 ([install](https://bun.sh/install)) | The runtime; `auggy` is a TypeScript CLI executed by Bun. |
| **Railway CLI** ([install](https://docs.railway.com/develop/cli)) | The deploy command shells out to `railway`. Same trust pattern as `git push` trusts `git`. |
| `railway login` completed | Authenticates the Railway CLI session. `auggy deploy` does not store API tokens. |
| A Railway workspace | Personal/team workspace that will own the project. `auggy deploy` can create the Railway project for you, or link an existing one. |
| `auggy create <name>` already run | Deploy operates on an agent project. |

---

## First deploy

```bash
# 1. Make sure the agent runs locally
cd zip
auggy run
# (Ctrl-C to stop)

# 2. Deploy to Railway
auggy deploy
```

The CLI walks you through:

1. **Local preflight** — runs doctor-style checks for config, env placeholders, package manifest, and agent-local dependencies before touching Railway.
2. **Presence + auth checks** — confirms `railway` is installed and logged in.
3. **Project selection** — create a new Railway project, or use an existing project via prompt / `--project <project-id>`. When creating a project, Auggy selects from Railway workspaces discovered by `railway list --json`; pass `--workspace <workspace-id-or-name>` for scripted deploys.
4. **Bundle staging** — copies your agent directory minus `.env`, `*.db*`, `workspace/`, `node_modules/`, `.git/`, `.worktrees/`, `.claude/`, `.DS_Store`, `*.tmp` into a temp dir. The agent's `package.json` + `bun.lock` are included so the image can install your pinned deps.
5. **Dockerfile + entrypoint generation** — written into the staging dir. Static; not operator-tunable at v1.0. The image copies `package.json` + `bun.lock` first, runs `bun install` to materialize `node_modules/` inside the image, then COPYs the rest of the agent dir; the entrypoint invokes `bunx auggy dev` so it uses the per-agent install rather than a global `auggy`.
6. **Secrets diff + confirm** — shows what's about to be pushed to Railway (with values redacted). Decline aborts the deploy. Pass `--yes` to skip.
7. **Railway service selection** — by default Auggy creates a new service named `<name>` in the selected project. Pass `--service <name-or-id>` to deploy into an existing Railway service instead.
8. **`railway volume add --mount-path /app/data`** — provisions a persistent volume mounted at `/app/data`. Holds SQLite-backed state across redeploys.
9. **`railway domain`** — assigns a `<name>-production-xxxx.up.railway.app` URL.
10. **Push env vars** — your `.env` entries + `AUGGY_PUBLIC_URL` (the just-generated URL) are pushed via `railway variables --set`.
11. **`railway up --detach`** — uploads the bundle, kicks off the build and deploy.
12. **Health verification** — polls `${url}/health` for a bounded window. Timeout is non-destructive; Railway may still finish booting.
13. **Metadata write** — the cloud record lands in `<agent-dir>/.auggy-cloud.json` so subsequent `auggy deploy` runs are idempotent redeploys.

Successful deploy output includes the public URL, `/health`, `/console`, and `/console/chat`. Follow later builds in the [Railway dashboard](https://railway.com) or with `auggy logs`.

---

## Redeploy

A re-run of the same command IS the redeploy. There's no separate `redeploy` verb.

```bash
auggy deploy
```

For scripted deploys into an existing project:

```bash
auggy deploy --project <project-id>
```

To deploy into an existing Railway service instead of creating a new one:

```bash
auggy deploy --project <project-id> --service my-existing-service
```

Railway terms:

- **Workspace**: the personal/team Railway account that owns projects.
- **Project**: the Railway project Auggy creates or links.
- **Service**: the deployable app inside the project.

Auggy helps select an existing workspace. It does not create Railway workspaces; create one in Railway first, then rerun `auggy deploy`.

What changes vs. first deploy:

- Project ID is read from the existing `cloud` record — no prompt.
- Volume is not re-added; the existing one is preserved.
- Secrets are re-pushed (so updating `.env` and redeploying is the workflow).
- `/health` is checked again after the build is queued.
- `deployedAt` in the index is refreshed.

---

## Logs and recovery

```bash
auggy logs
```

`auggy logs` reads the stored Railway cloud record, links a temporary Railway workspace to the saved project/service, and streams `railway logs`.

Use it when:

- Deploy health verification times out.
- Railway reports a crash loop.
- You changed `.env` or `agent.yaml` and need boot diagnostics.

If the agent has not been deployed yet, `auggy logs` fails with a local message and points you back to `auggy deploy`.

---

## Cost surface

The CLI installs `layeredMemory` with explicit memory writes enabled and
auto-extraction disabled:

```yaml
# augments/layeredMemory/augment.yaml
type: layeredMemory
config:
  backend: sqlite
  dbPath: ./data/memory.db
  autoSave:
    enabled: false
```

If you enable auto-save programmatically with an extraction engine,
`layeredMemory` uses this per-trust-level cadence by default:

| Trust level | Cadence | Implication |
|---|---|---|
| `creator` | every-turn | One extraction LLM call per turn |
| `agent` | every-N-turns (N=3) | One extraction call every 3 turns |
| `public.recognized` | every-turn | One extraction call per turn |
| `public.anonymous` | session-end-only | One extraction call at session end |

Each extraction call hits the configured extraction engine. Auggy does not
silently reuse the user-facing model for extraction, because that would make
spend harder to reason about. The autoSave eval suite (see
`evals/layered-memory/`) measures per-call cost for real extraction engines.

**Recommendation:** set a daily ceiling via the `budgets` augment:

```yaml
# agent.yaml
augments:
  - budgets

# augments/budgets/augment.yaml
type: budgets
config:
  dailyBudgetUsd: 5.00
```

This caps total daily spend (user-facing + extraction). If the cap is hit, the kernel's 2PC turn-gate refuses new turns until the next day. See [ADR-027](../../lo/docs/solutions/architecture/adr-027-internal-turn-admission.md) for how internal extraction turns flow through the same budget.

---

## Persistent state

Railway mounts a volume at `/app/data`. Agent-local mutable paths default to
`./data/*`, so SQLite-backed augments persist across redeploys without extra
configuration:

- `/app/data/memory.db` (`layeredMemory` augment)
- `/app/data/budgets.db` (`budgets` augment)
- `/app/data/visitor-auth.db` (`visitorAuth` augment)
- `/app/data/link.db` (`link` augment, when present)

For manual configs that still use root-level DB paths, the entrypoint script
also symlinks these paths into the volume:

- `/app/memory.db` → `/app/data/memory.db` (`layeredMemory` augment)
- `/app/budgets.db` → `/app/data/budgets.db` (`budgets` augment)
- `/app/visitor-auth.db` → `/app/data/visitor-auth.db` (`visitorAuth` augment)
- `/app/link.db` → `/app/data/link.db` (`link` augment, when present)

Augment config paths such as `dbPath: ./data/memory.db` work directly on the
mounted volume. Root paths such as `dbPath: ./memory.db` also work through the
symlinks.

**Drift risk:** if a future augment ships with a different SQLite path, update `SQLITE_DB_NAMES` in `src/cli/deploy/dockerfile.ts` (and add it to this doc). The `cross-session-recall` grader in the layered-memory eval suite catches data loss empirically.

---

## visitorAuth on Railway

The `visitorAuth` augment requires a `publicUrl` for magic-link email
rendering. On Railway, the deploy command sets `AUGGY_PUBLIC_URL` to the
generated domain BEFORE the first boot. In `augments/visitorAuth/augment.yaml`:

```yaml
type: visitorAuth
config:
  publicUrl: ${AUGGY_PUBLIC_URL}
```

The interpolation resolves at boot. First deploys work because the deploy command provisions the domain → sets the env var → triggers `railway up` in that order ([D7 of the deploy plan](../../../docs/superpowers/plans/2026-05-06-aug1-deploy-railway.md)).

For production magic-link email, run:

```bash
auggy agentmail setup visitorAuth
```

This provisions or configures the AgentMail inbox used by `visitorAuth`, writes
`AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID` to `.env`, and updates
`augments/visitorAuth/augment.yaml` to use `agentMail.transport: agentmail`.

Console magic links are local-only. Deploy preflight fails if `visitorAuth` is
still configured with `agentMail.transport: console`, unless
`allowConsoleInProduction: true` is set under the `visitorAuth` config block to
explicitly acknowledge that verification links will appear in Railway logs.

## MCP on Railway

MCP config lives in `.mcp.json`. `auggy deploy` runs cloud preflight before it
touches Railway:

- Remote MCP servers must use HTTPS (`streamable-http`, `sse`, or `http`).
- Enabled `stdio` servers fail cloud preflight because they are local
  development processes.
- Local-only `stdio` servers can stay in `.mcp.json` if marked
  `cloud: "disabled"` or `cloud: "localOnly"` under `auggy.servers`.
- Missing `${ENV_VAR}` references and literal secret-looking values fail
  preflight.

Run `auggy mcp doctor --cloud` before deploy when adding or changing MCP
servers.

---

## Tear-down

```bash
# Remove from your local index AND destroy the Railway service
auggy remove --cloud --yes
```

What `--cloud` does:

1. Local agent dir + index entry cleared (same as `auggy remove`).
2. Railway service is deleted via `railway service delete --yes`.
3. If Railway destruction fails, the warning is logged but local cleanup still proceeds — you may need to delete the service manually via the Railway dashboard.

The Railway volume is **NOT** automatically deleted (Railway retains it as a safety measure). Delete it explicitly from the dashboard if you don't need the data.

---

## What you should NOT expect at v1.0

- **Auto-rollback** on failed deploys. If `railway up` succeeds but the agent crashes at boot, Railway's auto-restart loop kicks in but doesn't roll back to the previous build. Use `railway logs` to diagnose.
- **Multi-instance / horizontal scaling.** One Railway service runs one Auggy instance. The SQLite-on-volume design assumes a single writer.
- **Plugin abstraction for other providers.** `--to fly` / `--to render` are deferred until concrete demand ([ADR-021](../../../docs/solutions/architecture/adr-021-agent-storage-and-deployment-locations.md)).
- **Cross-machine cloud-record sync.** Each checkout has its own `<agent-dir>/.auggy-cloud.json`. Cloud deployment doesn't sync state back.
- **Built-in observability.** Use Railway's metrics dashboard and `railway logs`. Long-term observability is a v2 concern.

---

## Troubleshooting

| Symptom | Diagnosis + fix |
|---|---|
| `railway: command not found` | Install the Railway CLI: https://docs.railway.com/develop/cli |
| `Unauthorized. Run \`railway login\` first.` | Re-run `railway login` and follow the browser flow. |
| `Agent "X" not registered` | Run `auggy create X` first, then `cd X && auggy deploy`. |
| First-deploy fails at `railway volume add` | The Railway project may not support volumes on the free tier. Upgrade or pick a different project. |
| Deploy preflight fails before Railway work | Run `auggy doctor` and fix the reported config/env/dependency issue. |
| Health check does not pass after deploy | Run `auggy logs` and inspect the boot error. The cloud record is still written, so redeploy with `auggy deploy --yes` after fixing. |
| visitorAuth refuses to boot — "publicUrl required" | Check that `augments/visitorAuth/augment.yaml` has `publicUrl: ${AUGGY_PUBLIC_URL}` and the deploy actually generated a domain. Re-run `auggy deploy` to refresh. |
| Deploy preflight fails because visitorAuth uses console mail | Run `auggy agentmail setup visitorAuth`, or set `allowConsoleInProduction: true` only for smoke tests where log-visible magic links are acceptable. |
| Deploy preflight fails because MCP has an enabled `stdio` server | Use a remote HTTPS MCP server for cloud, or mark the local server `cloud: "disabled"` in `.mcp.json`. |
| Memory disappears after redeploy | Check the volume is mounted (Railway dashboard → service → Volumes). If empty, the symlink list in the Dockerfile may be missing your dbPath — check `src/cli/deploy/dockerfile.ts`'s `SQLITE_DB_NAMES`. |
| Daily budget cap hit unexpectedly | If you enabled autoSave with an extraction engine, extraction calls count against the cap. Run `evals/layered-memory/run.ts --smoke` to measure your per-extraction cost; lower the cadence in `augments/layeredMemory/augment.yaml` if needed. |
