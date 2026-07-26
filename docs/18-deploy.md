# Deploying an Auggy agent to Railway

This page covers `auggy deploy` — the CLI path for shipping a single agent to Railway, the current default cloud deployment target.

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
| `webTransport` on port `8080` | The generated Railway Dockerfile exposes `8080`; other ports can boot in-container but return 502 through Railway. |

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
3. **Workspace selection** — Auggy discovers Railway workspaces from your logged-in Railway CLI session and lets you choose where the deploy belongs.
4. **Project selection** — create a new Railway project in that workspace, or use an existing project from that workspace. You can still pass `--project <project-id>` to skip prompts and deploy into a known existing project. For scripted first deploys, pass `--project-name <name>` plus `--workspace <workspace-name-or-id>`.
5. **Bundle staging** — copies your agent directory minus `.env`, `*.db*`, `workspace/`, `node_modules/`, `.git/`, `.worktrees/`, `.claude/`, `.DS_Store`, `*.tmp` into a temp dir. The agent's `package.json` + `bun.lock` are included so the image can install your pinned deps.
6. **Dockerfile + entrypoint generation** — written into the staging dir. Static and intentionally not operator-tunable. The image copies `package.json` + `bun.lock` first, runs `bun install` to materialize `node_modules/` inside the image, then COPYs the rest of the agent dir; the entrypoint invokes `bunx auggy dev` so it uses the per-agent install rather than a global `auggy`.
7. **Secrets diff + confirm** — shows what's about to be pushed to Railway (with values redacted). Decline aborts the deploy. Pass `--yes` to skip.
8. **Railway service selection** — by default Auggy creates a new service named `<name>` in the selected project. Pass `--service <name-or-id>` to deploy into an existing Railway service instead.
9. **`railway volume add --mount-path /app/data`** — provisions a persistent volume mounted at `/app/data`. Holds SQLite-backed state across redeploys.
10. **`railway domain`** — assigns a `<name>-production-xxxx.up.railway.app` URL.
11. **Push env vars** — your `.env` entries + `AUGGY_PUBLIC_URL` (the just-generated URL) are pushed with `railway variable set <KEY> --stdin --skip-deploys`. Secret values travel over subprocess stdin, not argv. This requires a current Railway CLI with `variable set --stdin` support; Auggy fails closed instead of falling back to argv on older releases.
12. **`railway up --detach`** — uploads the bundle, kicks off the build and deploy.
13. **Health verification** — polls `${url}/health` for a bounded window. Timeout is non-destructive; Railway may still finish booting.
14. **Metadata write** — the cloud record lands in `<agent-dir>/.auggy-cloud.json`. Later plain `auggy deploy` runs show the saved target and ask whether to redeploy it, recreate the service, choose another target, or reset metadata.

Successful deploy output includes the public URL, `/health`, `/console`, and `/console/chat`. Follow later builds in the [Railway dashboard](https://railway.com) or with `auggy logs`.

---

## Redeploy

A re-run of the same command opens the saved-target prompt. There's no separate
`redeploy` verb.

```bash
auggy deploy
```

When `<agent-dir>/.auggy-cloud.json` exists, plain `auggy deploy` asks:

```text
Saved Railway service:
  <service>
  <workspace> / <project>

What do you want to do?
  Redeploy <service>
  Recreate <service> in this project
  Choose another Railway project/service
  Remove saved deploy metadata and start over
  Cancel
```

For scripted deploys that intentionally skip prompts and reuse the saved target:

```bash
auggy deploy --yes
```

For scripted deploys into a specific existing project:

```bash
auggy deploy --project <project-id>
```

For scripted first deploys that create a new Railway project:

```bash
auggy deploy --yes --project-name zip --workspace "My Workspace"
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

- Plain `auggy deploy` shows the saved workspace/project/service and asks whether to redeploy, recreate the service, choose another target, reset metadata, or cancel.
- `auggy deploy --yes` reads the saved target and redeploys without prompts.
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
| `public.anonymous` | session-end-only | One bounded batched call if the visitor authenticates before the idle buffer expires; otherwise no extraction |

Each extraction call hits the configured extraction engine. Auggy does not
silently reuse the user-facing model for extraction, because that would make
spend harder to reason about. The autoSave eval suite (see
`packages/evals/src/layered-memory/`) measures per-call cost for real
extraction engines.

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

This caps total daily spend (user-facing + extraction). If the cap is hit,
the kernel's 2PC turn-gate refuses new turns until the next day. Internal
extraction turns flow through the same budget rather than using a separate
spend surface.

---

## Persistent state

Railway mounts a volume at `/app/data`. Before resolving any augment, the
runtime requires `RAILWAY_VOLUME_MOUNT_PATH=/app/data`, rejects symlinked state
roots, requires the runtime-owned root to have mode `0700`, creates
`/app/data/agent-mail` with mode `0700`, and performs an atomic
write/fsync/rename/delete probe through pinned directory descriptors. Startup
fails closed when the advertised mount or durability contract is wrong.
Fence checking, agent/volume identity binding, and that probe share one held
root descriptor. The platform must keep the admitted mountpoint stable for the
process lifetime; a process identity that can replace `/app/data` or its mount
namespace is part of the trusted deployment boundary.

Railway startup also opens `/app/data/.auggy-runtime-singleton.lock` through
that pinned root and holds a non-blocking exclusive `flock(2)` until shutdown
has drained and stopped the agent. A second process seeing the same lock inode
fails before provider or augment startup. The persistent file contains no PID,
timestamp, credential, or ownership authority; the kernel releases the lease
when the process exits or crashes.

The volume is required, not optional container storage. Mount the Railway
volume at the directory `/app/data`—not at an individual `.db` file and not at
a neighboring directory. The generated entrypoint deliberately refuses to
boot if this exact mount contract is absent, preventing an apparently healthy
deploy from silently recreating state on the ephemeral image filesystem.

On Railway, the resolver routes core mutable SQLite paths directly into the
volume even when an agent's portable config uses a project-relative default:

- `/app/data/memory.db` (`layeredMemory` augment)
- `/app/data/budgets.db` (`budgets` augment)
- `/app/data/visitor-auth.db` (`visitorAuth` augment)
- `/app/data/link.db` (`link` augment, when present)
- `/app/data/web-idempotency.db` (`webTransport` execution ledger)
- `/app/data/console-chat.db` (`webTransport` operator conversations)
- `/app/data/telegram-replay.db` (`telegramTransport` update-claim ledger)
- `/app/data/agent-mail/<augment-name>/agent-mail.db` (`agentMail`; each
  instance receives an isolated state namespace)
- `/app/data/file-memory/<augment-name>.md` (mutable `fileMemory`; seeded once
  from the image-owned source)
- `/app/data/notifications.jsonl` (the scaffolded relative `log-to-file`
  notification destination)
- `/app/data/admin-overrides.json` (authenticated runtime policy overrides)
- `/app/data/.auggy-state-identity.json` (server-minted agent/volume binding)
- `/app/data/.auggy-runtime-singleton.lock` (content-free process-lifetime
  singleton anchor)

`/app/data/console-chat.db` contains the operator console's conversation list,
messages, unread markers, and resumable model history. Completed turns survive
redeploys and process restarts. If the process exits during an active turn, the
next boot marks that run interrupted instead of presenting it as still
streaming.

`/app/data/web-idempotency.db` is part of the side-effect safety boundary.
Back it up and restore it together with downstream state: losing the ledger
while retaining completed side effects allows an old caller key to execute
again.

Only Link retains a root-level compatibility symlink:

- `/app/link.db` → `/app/data/link.db` (`link` augment, when present)

Do not add new database symlinks. The hardened SQLite stores reject symlink
paths; core augments resolve their configured relative paths under the durable
root, and AgentMail additionally prevents `dbPath` from escaping its
per-augment namespace. Locally, those same relative paths still resolve from
the agent project.

**Drift risk:** a new stateful augment must use the runtime data root directly,
participate in deploy preflight, and document its recovery contract. Do not add
it to the Link-only compatibility symlink list. The `cross-session-recall`
grader in the layered-memory eval suite catches data loss empirically.

### Replica and backup requirements

Keep each deployed Auggy service at **one Railway replica** while it uses these
SQLite stores. They assume one process and one writer; attaching multiple
replicas to the same volume is not a supported scaling strategy. A shared
database alone is also insufficient: horizontal replicas need shared fencing,
replay, budget, history, session, delivery, drain, and migration contracts.
The volume lock makes accidental same-volume overlap fail closed; it does not
make replicas supported. Every contender must see the same underlying inode on
a filesystem with coherent cross-process/cross-host `flock`. Separate or cloned
volumes cannot observe one another, so the Railway service configuration must
still enforce one replica and one dedicated volume.

Several different logical Auggys may run as separate Railway services. Give
each service its own `agent.yaml` identity, secrets, volume, public route, and
exclusive inbound provider identities. Each service remains at one replica;
using port 8080 in every service is safe because their network namespaces are
separate. See [Independent Agents on One Platform](./32-independent-agent-isolation.md)
for the load-balancer and isolation boundary.

The volume survives container replacement, but it is not an independent
backup. Establish a separate encrypted backup policy for state you cannot
recreate. Auggy provides an offline inventory, integrity-manifested
runtime-volume bundle, verification, empty-target restore rehearsal, and a
fail-closed reconciliation fence:

```bash
auggy state inventory --config /app/agent.yaml --root /app/data
auggy state backup --config /app/agent.yaml --root /app/data \
  --out /secure-backups/agent.auggy-state \
  --confirm-stopped --runtime-volume-only
auggy state verify /secure-backups/agent.auggy-state
```

Stop and drain the only replica before backup. The explicit confirmation is an
operator assertion, not a live-snapshot mechanism. Restore only into a new or
empty volume with the current `--config`; resume an interrupted copy with
`state restore-resume`, the original bundle, and exact restore id. Reconcile
remote/downstream effects, and clear the exact restore fence before startup.
An incomplete restore, mismatched server-minted agent id/configuration shape,
or unresolved fence blocks Railway boot. The bundle contains the complete
dedicated runtime volume, so do not co-locate secrets or another agent's state
under `/app/data`. See
[Runtime State Recovery](./27-runtime-state-recovery.md) for the complete
inventory, commands, limitations, and restore order.

Security-boundary releases require a drained, all-at-once rollout. Do not run
old and new bundles concurrently: an old replica does not enforce the durable
idempotency ledger or public-thread ownership and can re-execute a retry or
serve caller-selected thread history. Before rollback, stop keyed and public
traffic and drain outstanding retries; rollback otherwise deliberately reopens
H-01/H-02.

The operator console also requires explicit proxy trust. Railway environment
markers do not make forwarding headers authoritative. Configure the actual
ingress IPs or CIDRs as `webTransport.config.trustedProxies` and the public
console origin as `webTransport.config.consoleSecurity.allowedOrigins`. If the
deployment cannot provide a stable, reviewable ingress range, leave the console
disabled (`adminRoute: false`) and use a local or SSH-tunneled console instead
of trusting a broad private network.

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

The interpolation resolves at boot. First deploys work because the deploy
command provisions the domain, sets the environment variable, and only then
triggers `railway up`.

For production magic-link email, run:

```bash
auggy augment setup visitorAuth
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

## Runtime observability contract

The authenticated console dashboard and `AgentHandle.operationalSnapshot()`
expose the same versioned, process-local snapshot. It includes:

- scheduler activity, queue age, cumulative queue wait, fixed rejection
  reasons, and quarantine counts;
- turn, inference, tool, kernel response-delivery, hook, thread-quarantine
  recovery, and shutdown counters and timings; shutdown reports in-progress
  elapsed time from the moment admission begins draining;
- priced versus unpriced inference accounting; and
- current process RSS, heap, external, and array-buffer memory.

The snapshot has no peer, thread, turn, request, message, destination, model,
or tool-argument labels. It never includes prompts, responses, headers,
provider error bodies, exception messages, or credentials. Counters reset when
the process starts and are not suitable as a durable audit or billing record.
Sampling must not be used as an authorization or quota boundary.

`GET /health` remains a simple liveness check for deployment compatibility. It
does not mean the scheduler is accepting work. Operators should alert on the
snapshot's explicit readiness state, queue wait/rejections, quarantines,
provider failures, kernel response-delivery failures or in-flight growth, and memory trend.
Thresholds depend on the measured workload; Auggy does not publish a universal
capacity or SLO number.

This first snapshot does not claim to observe notification-provider,
AgentMail, Telegram, or other augment-owned delivery/recovery operations.
Those paths publish their own authenticated status until the Group 3 delivery
contract connects them to a common bounded signal boundary.

---

## What you should NOT expect from the current Railway deploy path

- **Auto-rollback** on failed deploys. If `railway up` succeeds but the agent crashes at boot, Railway's auto-restart loop kicks in but doesn't roll back to the previous build. Use `railway logs` to diagnose.
- **Multi-instance / horizontal scaling.** Configure exactly one Railway replica. The SQLite-on-volume design assumes one process and one writer.
- **Managed backups.** The deploy path provisions durable storage but does not schedule snapshots, export SQLite files, or test restores.
- **Plugin abstraction for other providers.** `--to fly` / `--to render` are deferred until concrete demand.
- **Cross-machine cloud-record sync.** Each checkout has its own `<agent-dir>/.auggy-cloud.json`. Cloud deployment doesn't sync state back.
- **A managed monitoring service.** Auggy exposes a bounded process-local
  operational snapshot; the deploying team still owns collection, dashboards,
  alerts, retention, and SLOs.

---

## Troubleshooting

| Symptom | Diagnosis + fix |
|---|---|
| `railway: command not found` | Install the Railway CLI: https://docs.railway.com/develop/cli |
| `Unauthorized. Run \`railway login\` first.` | Re-run `railway login` and follow the browser flow. |
| `Agent "X" not registered` | Run `auggy create X` first, then `cd X && auggy deploy`. |
| First-deploy fails at `railway volume add` | The Railway project may not support volumes on the free tier. Upgrade or pick a different project. |
| Deploy preflight fails before Railway work | Run `auggy doctor` and fix the reported config/env/dependency issue. |
| Deploy preflight fails because webTransport is not on 8080 | Set `port: 8080` under `config` in `augments/webTransport/augment.yaml`. |
| Health check does not pass after deploy | Run `auggy logs` and inspect the boot error. The cloud record is still written, so redeploy with `auggy deploy --yes` after fixing. |
| visitorAuth refuses to boot — "publicUrl required" | Check that `augments/visitorAuth/augment.yaml` has `publicUrl: ${AUGGY_PUBLIC_URL}` and the deploy actually generated a domain. Re-run `auggy deploy` to refresh. |
| Deploy preflight fails because visitorAuth uses console mail | Run `auggy augment setup visitorAuth`, or set `allowConsoleInProduction: true` only for smoke tests where log-visible magic links are acceptable. |
| Deploy preflight fails because MCP has an enabled `stdio` server | Use a remote HTTPS MCP server for cloud, or mark the local server `cloud: "disabled"` in `.mcp.json`. |
| Runtime refuses to start with a volume-admission error | Confirm Railway mounted a real volume at exactly `/app/data`, exposes `RAILWAY_VOLUME_MOUNT_PATH=/app/data`, and permits the generated entrypoint to set the root to mode `0700`. Remove symlinked state directories; the startup probe intentionally fails before state can fall back to ephemeral disk. |
| Memory disappears after redeploy | Check Railway dashboard → service → Volumes and confirm the mount is `/app/data`. Core SQLite augments resolve directly to that root; do not repair this by adding an `/app/*.db` symlink. |
| Console chats disappear after restart | Confirm the database exists at `/app/data/console-chat.db`, the service still has the `/app/data` volume attached, `webTransport.consoleChat.dbPath` is not `null`, and the service is configured for one replica. An explicit custom path must remain below `/app/data`. |
| Daily budget cap hit unexpectedly | If you enabled autoSave with an extraction engine, extraction calls count against the cap. Run `bun run packages/evals/src/layered-memory/smoke.ts` to measure your per-extraction cost; lower the cadence in `augments/layeredMemory/augment.yaml` if needed. |
