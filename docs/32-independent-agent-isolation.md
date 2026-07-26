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
IDs, canonical agent state roots, ports, Telegram bots, and inbound AgentMail
inboxes. A state root holds both a canonical-path claim and a physical
device/inode claim. Equal, ancestor, descendant, replacement, symlink-alias,
and rename collisions are rejected while either owner is live. Claims use non-secret
identifiers; a Telegram token without a numeric bot prefix is represented by a
domain-separated SHA-256 fingerprint, never by the token itself. Claim
takeover and release are serialized by an owner-only, schema-validated SQLite
registry. Transactions roll back automatically if a claimant crashes during a
mutation, so restart does not depend on deleting an abandoned lock directory.
PID incarnation markers detect ordinary PID reuse before lifecycle commands
signal or clean up an owner. POSIX does not expose a portable pidfd equivalent
on every supported host, so a same-UID exit/reuse exactly between the final
identity check and signal remains an operational race; lifecycle cleanup is
generation-fenced and fails closed whenever reuse is observable. Malformed
claims and ambiguous display-name lookups fail closed.

Runtime manifests are published by durable atomic replacement and their claims
are released only when the captured immutable ID and claim nonce still match.
`start`, `stop`, `restart`, and `remove` serialize fixed launchd and state-root
mutations with a crash-recoverable per-agent lifecycle lease. A launchd child
must acknowledge the random installation generation embedded in its plist and
the local registry's durable active-generation allowlist before resource
claims and again after manifest publication. `start` closes the preceding
generation before unloading or replacing its job. `stop` closes the captured
generation before unload, and an exact-id stop can close and unload an active
generation even when its KeepAlive child has not published a manifest. Thus a
late or manifestless child cannot become active after a successful lifecycle
operation. A display-name stop or restart with no manifest fails explicitly
and requires the immutable ID: mutable project configuration cannot prove
which identity an unpublished start already parsed. An exact-ID restart also
refuses to report "not running" while a manifestless launchd generation is
active; the operator must recover it with `stop <id>` before starting the
intended config. The claim-registry schema migrates the exact version-one catalog to
version two to add this bounded one-row-per-agent generation state;
an unrelated foreground runtime is not accepted as startup success. Failed or
timed-out starts unload the possibly armed KeepAlive job before removing its
artifacts. Rollback also follows the exact admitted generation, waits for its
process to exit, and preserves its artifacts, manifest, and claims with an
explicit recovery error if termination is live or unverifiable. `stop` ignores only missing plist files and preserves manifests and
claims after a failed unload, cleanup error, or unverifiable/non-terminating
process. `remove` holds lifecycle, agent-ID, canonical-path, and physical-root
leases across confirmation and cloud cleanup, atomically renames the captured
root to a private quarantine name, verifies its immutable ID and inode there,
and only then recursively deletes it.

Foreground runtime admission takes the same lifecycle lease transiently while
it publishes resource claims and its manifest. It cannot replace a dev process
between an operator stop's final process check and successful return. Restart
passes its already-owned lease into the successor admission path, and stop
rejects any unexpected replacement manifest rather than reporting success.
The runtime does not hold this lease after admission; normal operator controls
remain available for the process lifetime.

Foreground admission also rejects an active launchd installation under that
lease and again inside the atomic resource-claim transaction. This prevents a
manual dev process from coexisting with an armed KeepAlive generation during a
launchd throttle gap. If an upgrade encounters pre-existing mixed state,
`stop <id>` closes the launchd generation, unloads and removes its control
artifacts, and only then stops the foreground manifest. Failure to unload is
visible and the generation remains closed for recovery.

These claims are local to one OS user's registry, not the whole host. Separate
service accounts, containers, hosts, Railway services, Kubernetes, Nomad, and
other schedulers must prevent the same exclusive inbound identity from being
configured twice. A database, volume, or load balancer does not make duplicate
Telegram pollers or AgentMail consumers safe.

On an admitted Railway volume, Auggy additionally holds an owner-only,
descriptor-relative `flock(2)` anchor for the entire live process. A second
runtime on the same lock inode fails before providers, augments, or transports
start, and a crash releases the lease in the kernel. This protects the
supported one-replica contract; it is not distributed coordination. The
platform must keep the service at one replica, attach one dedicated volume,
and provide coherent file locking. Distinct or cloned volumes cannot detect
one another.

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

Cloud deployment metadata is now `version: 1` and binds the Railway target to
the immutable agent ID. Legacy, malformed, symlinked, or identity-mismatched
`.auggy-cloud.json` files fail before redeploy, log lookup, or `remove --cloud`
can target Railway, and publication uses exclusive random temporary files.
Copying both `agent.yaml` and its cloud record copies the same logical agent;
it is not a way to create an independent agent. Mint a new agent identity and
reset deployment metadata for a clone intended to operate independently.
Verify the remote project/service manually before deleting legacy metadata and
creating a fresh binding.

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
