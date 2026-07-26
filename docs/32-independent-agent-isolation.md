# Independent Agents on One Platform

Auggy supports running several **different logical agents** on one host or
platform. An order-support Auggy, a concierge Auggy, and an internal operations
Auggy can run side by side when each has its own immutable identity, ingress,
credentials, and state.

This is not horizontal scaling. One logical Auggy still runs as exactly one
process and one replica. Do not put multiple replicas of the same `agent.yaml`
behind a load balancer, attach them to one runtime volume, or rely on sticky
sessions for correctness.

## Identity is the isolation root

Every CLI-created `agent.yaml` has a server-minted `aug1_` UUID. The CLI writes
that exact value to `AUGGY_AGENT_ID`, refreshes it when augments are added, and
pushes it during Railway deployment. Display names are labels: they may change
and they need not be globally unique.

The immutable ID binds Auggy-owned memory namespaces, visitor-token audiences,
Link identity, runtime-volume identity, process manifests, launchd service
labels, and local state paths. A request, peer, thread, display name, or working
directory cannot select a different agent's authority or state domain.

Telegram replay is intentionally scoped by the stable provider bot ID, not by
the Auggy ID. This preserves deduplication history across the identity upgrade.
The replay database path remains agent-owned and the CLI claims exclusive local
ownership of that Telegram bot before polling or webhook startup.

## Required separation

| Resource | Same OS user / CLI registry | Separate service/container |
| --- | --- | --- |
| `agent.yaml` identity | Unique `id`; do not copy one identity to another logical agent | Unique `id` per logical agent |
| Process | One CLI-managed agent per process | One agent process per service/container |
| HTTP and Link listeners | Unique TCP ports | The same container port is safe when services have separate network namespaces |
| Runtime data | Separate agent directories and SQLite files | Separate dedicated volumes; never mount one agent's volume into another |
| Layered/Supabase memory | Immutable-ID-prefixed namespace | Immutable-ID-prefixed namespace; separate database credentials are stronger isolation |
| Visitor and Link authority | Immutable-ID audience/identity | Route each public origin to the matching agent only |
| Telegram inbound | One bot token may be owned by only one local live agent | The operator must enforce one logical owner across services and hosts |
| AgentMail inbound | One inbox may be consumed by only one local live agent | The operator must enforce one logical owner across services and hosts |
| Secrets | Separate `.env` files with owner-only permissions | Separate service secret sets and least-privilege provider credentials |
| Backup/restore/delete | Operate on one identity-bound state root | Operate on one dedicated volume and its matching external recovery points |

Local `auggy dev` acquires atomic, owner-only resource claims before transports
start. Within one OS user's `~/.auggy` registry, it rejects duplicate immutable
IDs, ports, Telegram bots, and inbound AgentMail inboxes. Claims use non-secret
identifiers; a Telegram token without a numeric bot prefix is represented by a
domain-separated SHA-256 fingerprint, never by the token itself. Claim
takeover and release are serialized by an owner-only, schema-validated SQLite
registry. Transactions roll back automatically if a claimant crashes during a
mutation, so restart does not depend on deleting an abandoned lock directory.
PID incarnation markers prevent an unrelated reused PID from being signaled or
treated as the old owner. Malformed claims and ambiguous display-name lookups
fail closed.

These claims are local to one OS user's registry, not the whole host. Separate
service accounts, containers, hosts, Railway services, Kubernetes, Nomad, and
other schedulers must prevent the same exclusive inbound identity from being
configured twice. A database, volume, or load balancer does not make duplicate
Telegram pollers or AgentMail consumers safe.

## Load-balancer ownership

For **different agents**, the deploying team may use an ordinary reverse proxy
or platform router:

```text
support.example.com   -> order-support service (one replica)
concierge.example.com -> concierge service (one replica)
ops.example.com       -> operations service (one replica)
```

The deployer owns DNS, TLS termination, host/path routing, network policy,
health-check configuration, capacity policy, and the load-balancer service.
Auggy owns the application boundary that makes that routing safe: deterministic
authentication, trusted-proxy configuration, Host/Origin validation, immutable
agent audiences, isolated state, bounded admission, and graceful drain.

`GET /health` is liveness only. It does not prove provider availability,
migration completion, queue capacity, or readiness for multi-replica traffic.
Configure `trustedProxies` with the ingress CIDRs that actually terminate the
connection and configure console allowed origins for the agent's exact public
origin. Never trust all private addresses merely because a platform proxy is
present.

## Capability boundary, not a sandbox

Independent state does not make two agents mutually untrusted operating-system
tenants. The `bash` augment and operator-configured filesystem mounts are host
capabilities. An agent granted them can access whatever its OS identity and
container mounts permit. Run mutually untrusted or differently privileged
agents under separate OS users or, preferably, separate containers/services
with distinct credentials and minimal mounts. Because separate OS users do not
share the CLI claim registry, the platform must also enforce unique Telegram
bots and inbound AgentMail inboxes across those users.

Configuration loading also reads `.env` values into `process.env`. The CLI runs
one agent per process. Applications embedding `defineAgent` more than once own
process and environment isolation; separate processes are the supported choice
when secrets or authority differ.

## Upgrade from name-keyed local runtimes

This isolation release changes several boundaries. Perform a stopped upgrade:

1. stop every old CLI-managed process before starting the new runtime;
2. retain each `agent.yaml`, `.env`, exact package/tarball, and offline state
   bundle;
3. verify `AUGGY_AGENT_ID` exactly equals the `id` in `agent.yaml`;
4. ensure every agent has unique local ports, Telegram bot, inbound AgentMail
   inbox, state root, and service/volume;
5. start one agent at a time and verify its immutable-ID status and routes; and
6. remove legacy launchd services only after the identity-keyed service is
   healthy.

Startup rejects every live process whose manifest predates the transactional
claim registry, including identity-keyed prerelease manifests. Do not delete a
PID manifest or legacy claim file to bypass this check; stop all old processes
first. Committed stale claims are reclaimed only after the recorded PID and
process incarnation are gone or reused.

Existing visitor tokens whose audience used a mutable display name are
invalidated and must be reissued. Existing layered-memory rows use the previous
namespace label and are not silently adopted into the new immutable-ID
namespace. If that memory must be retained, keep the agent stopped and perform
an operator-reviewed export/relabel/import under a matching backup and rollback
plan. Never configure the old shared namespace as a compatibility escape.

Telegram's default `telegram:bot-<botId>` replay namespace is unchanged, so its
deduplication and conflict history remains visible after upgrade. An explicitly
configured replay namespace also remains unchanged.

## What remains unsupported

- two replicas serving one logical agent;
- mixed-version or rolling deployment of one logical agent;
- shared SQLite files or a shared runtime volume across live processes;
- cross-host resource-claim arbitration;
- a managed Auggy control plane, tenant provisioner, backup service, or load
  balancer; and
- treating Auggy capability policy as an OS/container sandbox.

Horizontal scaling requires shared coordination, fencing, replay, budgets,
history, session, delivery, readiness, drain, and migration contracts. Until
those exist, scale by running different agents for different operations and by
measuring each single replica with the bounded load harness.
