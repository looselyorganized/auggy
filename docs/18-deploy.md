# Portable deployment and Railway

Deploy one agent project as one service with its own identity, credentials and
private volume. Each company owns its deployment. A Next.js application can run
beside it and call its HTTP endpoint; Telegram polling can run without an HTTP
listener or frontend. See the [company application reference](../examples/company-app/README.md)
for the separate application/agent boundary.

These commands describe the unreleased implementation in this checkout. Use
matching candidate packages when evaluating it; the published 0.5 scaffold does
not acquire these features by following this page.

## Export a Docker build context

From an installed agent project:

```bash
auggy export docker --config agent.yaml --out ../support-agent-image
```

The destination must be new and outside the source project. Export reads the
configuration without expanding `.env`, importing application code, installing
dependencies, running Docker, or contacting a registry. It preserves the selected
configuration, application source, `package.json` and `bun.lock` bytes. The context
contains:

```text
support-agent-image/
  Dockerfile
  auggy-entrypoint.sh
  auggy-deployment.json       # profile, toolchain and input hashes
  agent.yaml                 # selected config at its original relative path
  package.json
  bun.lock
  src/                       # your startup, HTTP, turn and custom augment code
  ...                        # retained project source and contained dependency archives
```

The generated image pins Bun 1.3.14 and its base-image digest. Its build runs
`bun install --frozen-lockfile`; a stale lock fails the build. Export reports that
it has **not** built or run the image. The manifest describes inputs and the
selected ingress profile; it is not an artifact signature or an additional
augment graph.

Export requires ordinary project-contained inputs. It supports contained `file:`
dependency tarballs, including their contained archive dependencies. Materialize
workspace links, source-directory dependencies, and archives outside the project
before exporting. It refuses collisions with its three generated files and
existing output directories; there is no overwrite mode.

Private `.env` files, `.auggy/` receipts, cloud metadata, dependencies, known
runtime state and database sidecars are excluded. Required files that would be
excluded cause an error. Keep secrets out of ordinary source and `.env.example`:
a file filter cannot identify a secret hidden in an arbitrary filename.

### Select ingress explicitly when needed

`--ingress auto` is the default. Profiles describe listeners already present in
configuration; they do not enable an augment or rewrite its port.

| Configuration | Profile |
| --- | --- |
| Known augments with no listener, including Telegram polling | `none` |
| One `webTransport` | Its configured port, `/health`, and `/console` when enabled |
| One Telegram webhook or Link listener | Its port; no inferred health or Console path |
| Multiple known listeners, even on the same port | Refused; one port does not explain routing |
| Custom augment or unresolved listener configuration | Requires explicit `none` or `http` |

```bash
# A custom augment alongside one web transport: confirm its single HTTP surface.
auggy export docker --config agent.yaml --out ../support-agent-image \
  --ingress http --port 8080

# A worker whose custom code does not open a listener.
auggy export docker --config agent.yaml --out ../worker-image --ingress none
```

For a custom HTTP listener, supply `--port` and optionally
`--health-path /ready` for an endpoint the application actually serves. A health
path must be an origin-relative path without a query or fragment. `none` rejects
port/health options and known HTTP listeners. Explicit ports must match known
listeners; startup checks resolved built-in configuration against the exported
profile before constructing the runtime. An explicit profile for custom code is
an operator declaration, not proof that arbitrary TypeScript obeys it.

### Build and provision durable storage

```bash
docker build -t support-agent:local ../support-agent-image

docker volume create support-agent-data
# Initialize this NEW, EMPTY, dedicated volume once as the image's runtime user.
docker run --rm --entrypoint sh \
  --mount type=volume,src=support-agent-data,dst=/app/data \
  support-agent:local \
  -c 'test -z "$(ls -A /app/data)" && chmod 0700 /app/data'

docker run --rm --name support-agent \
  --env-file .env -e AUGGY_DATA_DIR=/app/data \
  --mount type=volume,src=support-agent-data,dst=/app/data \
  -p 127.0.0.1:8080:8080 \
  support-agent:local
```

The port mapping above assumes the agent declares port 8080. For a worker,
export `none` and omit the port mapping. Keep production secrets in the hosting
platform's secret manager rather than in the image.

The pinned image currently runs as UID/GID `0:0`. A custom non-root image needs
its own ownership and admission verification; changing the UID alone is not a
certified deployment profile. Generic startup requires `AUGGY_DATA_DIR` to name
an existing absolute, ordinary directory owned by the runtime user with mode
`0700`. It refuses missing, unsafe, symlinked, wrong-agent or unreconciled roots;
it does not create or repair them. Do not run the initialization command on an
existing state volume. The admitted root holds the singleton lease for the sole
replica. See [storage layout](./16-storage-layout.md#explicit-runtime-data-root)
and [recovery](./27-runtime-state-recovery.md).

The entrypoint resolves the installed local Auggy executable and launches your
application through it. It does not copy runtime internals into your project,
fall back to a global package, or download a missing runtime at startup. Generic
Docker does not automatically trust Railway forwarding headers.

## Deploy to Railway

Install the Railway CLI and complete `railway login`. Run `auggy doctor` and
verify your agent locally before deploying:

```bash
auggy deploy --to railway
# The same ingress options are available here.
auggy deploy --to railway --ingress none
```

Use only one of those commands for the project's actual profile. The CLI can
select a workspace and create a project/service, or use explicit targets:

```bash
auggy deploy --project <project-id> --service <service-name-or-id>
auggy deploy --yes --project-name support-agent --workspace "My Workspace"
```

The ordinary Railway path starts from the portable context, then substitutes the
Railway entrypoint. It uses the same pinned image and frozen install. An explicitly
declared external core tarball retains a legacy compatibility path with an
**unfrozen** install and a warning; that path is outside portable export guarantees.
A nearby unrelated tarball never changes the project's dependency selection.

Before creating hosted resources, the command checks selected configuration,
local dependencies, ingress, secret variables and the confirmation to push them.
An alternate `--config production.yaml` must retain the adjacent `agent.yaml`'s
immutable agent ID: one project directory owns one deployment record. Unset
inherited `RAILWAY_PROJECT_ID`, `RAILWAY_SERVICE_ID` and
`RAILWAY_ENVIRONMENT_ID`; targets must come from the explicit linked selection.
The deployment `.env` must not override the platform mount, `AUGGY_DATA_DIR` or
`AUGGY_DEPLOYMENT_MANIFEST`; the image and Railway supply those values. Worker
deployments also reject HTTP-only variables such as `PORT` and `AUGGY_PUBLIC_URL`.

Managed deployment refuses configuration that can replace the selected profile:
root `railway.json`/`railway.toml`, custom service config paths, build/start/root/
Dockerfile overrides, pre-deploy or cron commands, conflicting build variables,
and unsupported replica/ingress settings. It also refuses upload ignore files
that could hide its generated inputs, and uploads with `--no-gitignore`. Resolve
the reported override explicitly; Auggy does not delete it or silently deploy a
different command.

The selected service must have one verified `/app/data` volume. Auggy creates one
when appropriate and verifies its actual binding before upload and metadata
write. Redeploy refuses a missing or changed saved volume rather than silently
starting with empty state. HTTP deployments create a domain targeting the selected
port and set `PORT` and `AUGGY_PUBLIC_URL`. A worker creates neither a domain nor
those HTTP variables. Secret values travel to Railway over subprocess stdin.

After upload, output distinguishes three observations:

- **Platform:** the selected Railway deployment's status, with bounded polling.
- **HTTP:** the configured health endpoint, or explicitly not applicable/not configured.
- **Channel:** unverified. A running process or successful health response does
  not prove a Telegram exchange, AG-UI turn, tool effect, or provider connection.

A timeout is not a readiness success. Ordinary pending readiness can still leave
a saved target for diagnosis; deployment failure, uncertain subprocess cleanup,
or target-policy changes can stop the command without writing new metadata.
The CLI does not roll back hosted mutations automatically. Inspect Railway and
`auggy logs` before retrying a partially completed deploy.

## Redeploy, Console and logs

Plain `auggy deploy` offers the saved target, recreation, another target, metadata
reset or cancellation. `auggy deploy --yes` intentionally reuses the saved target
without prompts. Redeploy preserves and verifies the volume, pushes current
secrets, uploads the new image inputs and repeats readiness observations.

```bash
auggy logs
auggy console --cloud
```

Logs work for HTTP and worker deployments. The Console command requires a saved
HTTP profile with a Console path; a worker has no URL to open. HTTP without a
Console does not acquire one through this command.

For a Console-enabled service, the CLI exchanges the configured bearer at the
saved HTTPS origin for a short-lived single-use login. It never puts the permanent
bearer in the browser URL. If automatic login is unavailable, use the service's
`AUGGY_WEB_TOKEN` on its password screen. Keep this operator credential out of
application browsers; app users use delegated assertions instead.

`.auggy-cloud.json` version 2 records the immutable agent ID, real project/service/
volume IDs and profile; a worker's URL is `null`. Valid version 1 records remain
readable as the historical port-8080 HTTP profile. Reading does not rewrite them;
a successful explicit deployment writes version 2. Treat invalid records as an
operator error, not an invitation to select another service implicitly.

## Cost surface

The CLI installs `layeredMemory` with explicit memory writes enabled and
auto-extraction disabled:

```yaml
# agent.yaml
augments:
  - name: layeredMemory
    type: layeredMemory
    options:
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
  - name: budgets
    type: budgets
    options:
      dailyBudgetUsd: 5.00
```

This caps total daily spend (user-facing + extraction). If the cap is hit,
the kernel's transactional turn gate refuses new turns until the next day. Internal
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
Only explicit Railway startup may narrow the permissions of an already existing,
owned, empty advertised mount to `0700`. A nonempty unsafe mount is refused;
generic Docker and local startup never perform this initialization. If
`AUGGY_DATA_DIR` is also set on Railway, it must equal `/app/data`.
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
- the configured managed external-assertion replay database (`EARP/v1`)
- `/app/data/.auggy-auth-replay-guard.json` (local replay control state;
  excluded from backup payload and recreated by the restore protocol)
- `/app/data/console-chat.db` (`webTransport` operator conversations)
- `/app/data/telegram-replay.db` (`telegramTransport` update-claim ledger)
- `/app/data/durable-jobs.sqlite` (optional `DJOB/v2` jobs, schedules, leases,
  and incident history)
- `/app/data/agent-mail/<augment-name>/orchestration.db` (`agentMail`; provider
  references, catch-up cursor, review state, and operator audit)
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

When `settings.jobs` is enabled, `durable-jobs.sqlite` is equally
replay-critical and contains private prompts and bindings in plaintext. Keep
the service at one replica, include the database and live WAL state in the
stopped runtime-volume bundle, and reconcile every `outcome_unknown` job before
resuming schedules or ingress after restore. See [Durable Jobs](./33-durable-jobs.md).

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

The operator console requires proxy trust for the forwarding headers Railway's
edge adds. On a standard `auggy deploy` this is configured for you: the
generated entrypoint starts the runtime in Railway mode, which defaults
`webTransport.config.trustedProxies` to Railway's internal ingress network
(`100.64.0.0/10` — the address the container sees as its TCP peer) and logs
one line at boot saying so, and `AUGGY_PUBLIC_URL` (set by `auggy deploy`)
contributes the console origin. Railway's edge overwrites client-supplied
`X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Host`, and `X-Forwarded-Proto`,
so those headers are authoritative from that network. Railway environment
markers alone never grant trust; only the deploy entrypoint's explicit Railway
mode does. To narrow or override the default, set
`webTransport.config.trustedProxies` explicitly; to disable the console in the
cloud entirely, set `adminRoute: false` and use a local or SSH-tunneled console.

---

## visitorAuth on Railway

The `visitorAuth` augment requires a `publicUrl` for magic-link email
rendering. On Railway, the deploy command sets `AUGGY_PUBLIC_URL` to the
generated domain BEFORE the first boot. In the `visitorAuth` entry in `agent.yaml`:

```yaml
# agent.yaml (augment entry)
augments:
  - name: visitorAuth
    type: visitorAuth
    options:
      publicUrl: ${AUGGY_PUBLIC_URL}
```

The interpolation resolves at boot. First deploys work because the deploy
command provisions the domain, sets the environment variable, and only then
triggers `railway up`.

For production magic-link email, run:

```bash
auggy augment setup visitorAuth --mode connect
```

Create the inbox and API key in AgentMail first. Setup verifies that exact key
against that exact inbox, writes `AGENTMAIL_API_KEY` and
`AGENTMAIL_INBOX_ID` to `.env`, and updates
the `visitorAuth` entry in `agent.yaml` to use `agentMail.transport: agentmail`.
This manual connection path retains the supplied key unchanged and performs
provider reads only. Guided setup also offers account/inbox creation; see
[AgentMail setup](./19-visitor-auth.md#agentmail-setup). Auggy never exchanges
a selected key for a narrower key, rotates it, or revokes it.

When the agent also mounts `agentMail`, both augments share one inbox and
API key. A single interactive add coordinates that topology with one setup
confirmation and credential flow:

```bash
auggy augment add agentMail visitorAuth
```

It connects `agentMail` first and attaches `visitorAuth` through environment
reuse, independent of selection order. If setup was skipped or the augments
were added separately, connect them explicitly before deploy:

```bash
auggy augment setup agentMail --mode connect
auggy augment setup visitorAuth --mode env
```

Removing either augment leaves provider resources and shared runtime values
intact. Confirm every consumer before deleting the local or Railway value;
Auggy never revokes the provider key.

`visitorAuth` only sends magic links; it does not depend on `agentMail` inbound
processing. The visitor's click returns to Auggy's public verification route.
Enabling mailbox inbound or changing reply policy is a YAML edit plus
restart/redeploy, not another setup run. If the selected key lacks a required
permission, update it in AgentMail or intentionally connect a different exact
key.

Run one live Auggy replica per logical AgentMail inbox. A live WebSocket wakes
the agent for new mail, while paginated provider catch-up reconciles messages
missed during disconnects and restarts. The orchestration database must stay on
the Railway volume. Provider delivery-lifecycle events missed while the agent
is offline cannot be reconstructed per message; see
[AgentMail](./22-agent-mail.md#recovery-and-limits) for the complete recovery
boundary.

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
# Delete this local agent project and request deletion of its Railway service
auggy remove --cloud --yes
```

What `--cloud` does:

1. Validate the bound saved target and refuse removal while the local agent is running.
2. Request Railway service deletion before removing the local project.
3. If Railway destruction fails, log a warning and continue local cleanup; the operator must inspect and remove any remaining service separately.

The command does not explicitly delete the volume. Inspect retained platform
resources and remove data only after applying your retention and recovery policy.

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
| First-deploy fails at `railway volume add` | Inspect the Railway error and the selected project's permissions and volume support before retrying. |
| Deploy preflight fails before Railway work | Run `auggy doctor` and fix the reported config/env/dependency issue. |
| Ingress profile cannot be inferred | Choose `--ingress none`, or `--ingress http --port <actual-port>` for custom code. Resolve multiple known listeners explicitly in the application topology. |
| Health check does not pass after deploy | Inspect platform and HTTP readiness separately, then use `auggy logs`. A health timeout can preserve a target; do not assume every failed deploy wrote metadata. |
| visitorAuth refuses to boot — "publicUrl required" | Check that the `visitorAuth` entry in `agent.yaml` has `publicUrl: ${AUGGY_PUBLIC_URL}` and the deploy actually generated a domain. Re-run `auggy deploy` to refresh. |
| Deploy preflight fails because visitorAuth uses console mail | If `agentMail` is installed, run `auggy augment setup agentMail --mode connect` followed by `auggy augment setup visitorAuth --mode env`; otherwise run `auggy augment setup visitorAuth --mode connect`. Set `allowConsoleInProduction: true` only for smoke tests where log-visible magic links are acceptable. |
| Deploy preflight fails because MCP has an enabled `stdio` server | Use a remote HTTPS MCP server for cloud, or mark the local server `cloud: "disabled"` in `.mcp.json`. |
| Runtime refuses to start with a volume-admission error | Confirm the advertised `/app/data` mount, runtime ownership, mode `0700`, matching agent ID and reconciled restore fence. Railway may initialize only an empty owned mount; inspect existing state before repairing it offline. |
| Memory disappears after redeploy | Check Railway dashboard → service → Volumes and confirm the mount is `/app/data`. Core SQLite augments resolve directly to that root; do not repair this by adding an `/app/*.db` symlink. |
| Console chats disappear after restart | Confirm the database exists at `/app/data/console-chat.db`, the service still has the `/app/data` volume attached, `webTransport.consoleChat.dbPath` is not `null`, and the service is configured for one replica. An explicit custom path must remain below `/app/data`. |
| Daily budget cap hit unexpectedly | If you enabled autoSave with an extraction engine, extraction calls count against the cap. Run `bun run packages/evals/src/layered-memory/smoke.ts` to measure your per-extraction cost; lower the cadence in the `layeredMemory` entry in `agent.yaml` if needed. |
