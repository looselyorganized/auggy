# Runtime State Recovery

Auggy owns a recovery contract for the state its runtime writes. It does not
operate a backup service. The deploying team still chooses the backup
scheduler, storage provider, encryption and key custody, retention, regional
replication, and recovery objectives.

The currently supported recovery topology is one stopped Auggy replica and one
private runtime volume. Horizontal replicas remain unsupported.

## State planes

An agent has several distinct recovery planes. Do not call one of them a full
agent backup.

| Plane | Examples | Owner |
| --- | --- | --- |
| Project/source | `agent.yaml`, identity, skills, immutable knowledge, package lock | Source control and deploy pipeline |
| Secrets | provider keys, console credentials, signing keys | Deployment secret manager |
| Runtime volume | SQLite stores, admin overrides, mutable file memory, workspace artifacts, AgentMail orchestration state, local notification log | Auggy defines the format; deployer stores backups |
| External systems | Supabase, optional PostgreSQL coordination, provider mailboxes, downstream side effects | Deployer and provider |
| Process-local | queues, waiters, counters, in-memory throttles | Not recoverable; reset on restart |

The runtime-volume tooling copies the complete admitted runtime volume. It
excludes project source and secrets only because those must not be placed on
that dedicated volume. Do not co-locate secret files, another agent's state,
or unrelated application data under the runtime root. A source checkout plus
restored secrets plus a compatible runtime-volume bundle are all required to
reconstruct a deployed agent.

## Runtime-owned inventory

`auggy state inventory` derives a versioned, secret-free inventory from the
parsed agent configuration. Every entry identifies its owner, server-minted
agent namespace, storage kind, schema/version, retention behavior, backup
plane, restore order, and replay sensitivity. Explicit `null` and `:memory:`
stores remain visible as non-restorable opt-outs.

The initial catalog covers:

| State | Schema/version | Default retention | Recovery significance |
| --- | --- | --- | --- |
| Runtime identity | `runtime-state-identity/v1` | Lifetime of the logical agent volume | Binds the bundle to one server-minted agent id |
| Runtime singleton anchor | `posix-flock-anchor/v1` | Lifetime of the logical agent volume | Content-free lock inode; authority exists only while a live process holds the kernel lock |
| Admin overrides | `admin-overrides/v2` | Until operator replacement | Runtime security and budget policy, including per-AgentMail-instance caps |
| Mutable file memory | `utf8-text/v1` | Until creator replacement | Creator-approved learned behavior |
| Layered memory SQLite | `LMEM/v1` | Configured expiry, 30 days by default | Peer memory and erasure state |
| Budgets | `BUDG/v1` | Unbounded unless `retentionDays` is set | Reservations, counts, and cost |
| Visitor auth | `VAUT/v1` | Until explicit deletion | Identities, consumed tokens, revocations |
| Web idempotency | `AUID/v2` | Configured replay window | Completed and outcome-unknown execution fence |
| Managed external-assertion replay | `EARP/v1` | Until assertion expiry; at most 100,000 unexpired claims | Consumed audience/jti pairs; restored ingress also requires local replay control state |
| Durable jobs and schedules | `DJOB/v2` | 30-day terminal jobs and 90-day reconciliation audit by default | Job leases, attempt history, schedule occurrences, cancellation, and outcome-unknown incidents |
| Console chat/history | `CCHT/v4` | Until authenticated deletion | Ownership, history, runs, tombstones |
| Telegram replay | `TGRP/v2` | 30 days and configured entry cap | Claims, conflicts, discard decisions |
| AgentMail orchestration | `AMOR/v1` | Orchestration identifiers and replay evidence until operator maintenance | Inbound checkpoints and claims, rate evidence, provider-native draft references, send idempotency, ambiguity fences, and creator-attention delivery; message and draft bodies remain in AgentMail |
| Notify delivery | `NTFY/v2` | Ordinary terminals up to 30 days; unresolved protected operations consume the 10,000-record active cap; source-acknowledged operations retain replay evidence without consuming that cap | Atomic quota and payload reservations, bounded internal retries, source-settlement acknowledgements, delivery ambiguity, canonical thread fences, evidence hashes, and recovery decisions |
| Link task store | Package-owned | Package-owned | External package state; semantically opaque to core |
| Writable filesystem mounts | `opaque-files/v1` | Operator/application managed | Durable agent-created artifacts |
| Log-to-file notify | `jsonl/v1` | Unbounded | Operational delivery record, not a send ledger |

Supabase memory, PostgreSQL coordination, provider mailboxes, custom augment
state, and downstream services appear as external prerequisites. A runtime
volume bundle cannot claim to contain them.

## Runtime root and Railway path behavior

`AUGGY_DATA_DIR` enables the same volume admission on supported local and generic
container launches. An explicitly selected root must already exist, be owned by
the runtime user, and have mode `0700`. Unset retains local project paths.
Inventory, backup and restore accept `--root` to select the physical volume;
without it, they use `AUGGY_DATA_DIR` or the advertised Railway volume. A new
root does not automatically migrate old project-local state.

Railway runtime state is rooted at `/app/data`. In addition to SQLite-backed
AgentMail orchestration state, mutable `fileMemory` is seeded once from the deployed project
and then written under `/app/data/file-memory/<augment-name>.md`. A
`log-to-file` notification destination with a relative path is also rooted
under `/app/data`. Redeploying a new image does not overwrite either durable
file.

The volume contains `.auggy-state-identity.json`, which binds it to the
server-minted `aug1_...` agent id. Startup creates this identity on first
admission and rejects a volume belonging to another agent.

The volume may also contain `.auggy-runtime-singleton.lock`. Backing up or
restoring this regular owner-only file while the sole replica is stopped is
safe because its bytes carry no authority. A restored copy begins unlocked;
the next supported runtime acquires a new kernel lease during admission.

When `settings.jobs.enabled: true`, the durable-jobs database is also rooted on
this volume. It contains plaintext private prompts and bindings, so the same
confidentiality, encryption, and access-control requirements apply to live
volumes and backup bundles. A restored `outcome_unknown` job remains fenced;
restore never converts uncertainty into a retry.

## Offline backup

The command produces a directory bundle rather than extracting an ambient tar
archive. The bundle and every file are owner-only on POSIX systems.

```bash
# Stop and drain the only replica first. Run the backup job with the same
# private volume mounted and an output path outside that volume.
auggy state backup \
  --config /app/agent.yaml \
  --root /app/data \
  --out /secure-backups/agent-2026-07-25.auggy-state \
  --confirm-stopped \
  --runtime-volume-only

auggy state verify /secure-backups/agent-2026-07-25.auggy-state
```

`--confirm-stopped` is a consequential operator assertion. Auggy cannot prove
from a detached recovery job that the platform has stopped every writer. The
command detects files that change while being copied and never publishes a
partially created bundle, but it is not a live multi-store snapshot protocol.

The bundle walker rejects symlinks, hard-linked files, special files, path
escapes, changing files, unsafe ownership, and a destination within the source
volume. It traverses and publishes through pinned, descriptor-relative roots,
preserves empty directories, normalizes private modes, hashes every byte,
checks declared SQLite application/schema identity for self-contained database
files, preserves any stopped database's WAL/journal sidecars byte-for-byte,
writes a versioned manifest, fsyncs it, and atomically publishes the completed
directory. Journaled databases are marked for deferred semantic admission:
core stores check their exact schema and integrity through hardened admission
before the restored runtime can serve traffic. Package-owned opaque stores must
be covered by their package's own startup and restore contract. This avoids
reopening recovery state through an unpinned pathname. SQLite inspection is
bounded to 256 MiB per self-contained database; the format accepts at most 8
GiB per file and 64 GiB in aggregate.
Larger deployments need an explicitly designed external database recovery
plane. The manifest contains no record content or credentials; the payload is
confidential and may contain every non-secret file on the dedicated volume.

`--runtime-volume-only` acknowledges every `externalPrerequisites` entry in
the manifest. Capture matching provider recovery points separately. Checksums
detect corruption; they do not authenticate a malicious backup. Encryption,
signing, access control, and key custody remain platform responsibilities.

## Restore rehearsal

Restore is deliberately narrower than arbitrary in-place replacement. It only
targets a new or empty owner-controlled directory:

```bash
auggy state restore /secure-backups/agent-2026-07-25.auggy-state \
  --config /app/agent.yaml \
  --root /recovery/new-data \
  --runtime-root /app/data \
  --confirm-stopped \
  --runtime-volume-only
```

Restore first rebuilds the current inventory and rejects a different agent id,
configuration shape, replay-critical store mapping, or external-prerequisite
set. Before copying payload bytes, restore writes
`.auggy-restore-fence.json`. It verifies the manifest, paths, modes, hashes,
SQLite integrity, and agent identity, then copies each file while checking the
same digest again. Any interruption leaves the fence in place. Railway startup
refuses a volume with either a `copying` or `requires-reconciliation` fence.

`--root` selects the physical copy destination. When recovery uses a different
mount from the running agent, `--runtime-root` selects the final runtime mount
used to validate the configured store layout. Keep the compatible project at
its runtime path (here `/app/agent.yaml`) in the recovery container. For example,
`./data/web-idempotency.db` maps to `web-idempotency.db` beneath `/app/data`;
restoring under `/recovery/new-data` must preserve that layout. The flag does
not write to the final mount, move stores, or bypass topology checks. If omitted,
the copy destination also supplies the runtime mount for validation.

Resume an interrupted copy only with the same bundle, current config, and
opaque restore id from the fence:

```bash
auggy state restore-resume /secure-backups/agent-2026-07-25.auggy-state \
  --config /app/agent.yaml \
  --root /recovery/new-data \
  --runtime-root /app/data \
  --restore-id <uuid-from-copying-fence> \
  --confirm-stopped \
  --runtime-volume-only
```

Resume verifies that the partial target is an exact subset of the bundle,
never overwrites a mismatched byte, and still ends in
`requires-reconciliation`. If the target is no longer wanted, discard the
entire new recovery directory through the platform's storage controls; never
remove only the fence.

Why reconciliation is mandatory: restoring an older local ledger cannot roll
back an email already sent, a downstream order already created, a Telegram
update already acted on, or a visitor credential already observed elsewhere.
It can also roll back quota accounting, revocations, memory erasure, and local
idempotency terminal rows. No filesystem backup can infer those facts safely.

After comparing the restore timestamp with downstream systems and explicitly
quarantining or reconciling ambiguous effects, clear the exact fence:

```bash
auggy state reconcile \
  --root /recovery/new-data \
  --restore-id <uuid-printed-by-restore> \
  --confirm-downstream-reconciled
```

Then mount the recovered directory as the sole replica's `/app/data`, restore
the matching project/source and secrets, start the agent, and run authenticated
health and application checks. A different agent id, malformed identity,
unfinished fence, corrupt schema, or newer unsupported SQLite schema fails
before traffic is served.

At production startup Auggy checks the restore fence, binds the volume to the
configured agent ID, and probes durability through one pinned root descriptor.
The deployment platform must keep that admitted mountpoint stable for the
process lifetime. Code running with the same OS authority to replace the mount
or mount namespace is inside the trusted host boundary, not an isolated Auggy
capability.

## External-assertion replay after restore

Managed replay stores consumed `audience + jti` claims in the configured SQLite
database. Its local `.auggy-auth-replay-guard.json` contains clock high-water and
restore-epoch control state, not a replayable backup payload. Backup validates
this control state but excludes it; an unresolved pending guard write causes
refusal. Do not copy a guard into a bundle or delete one to bypass a hold.

Before copying a managed replay database, Auggy's restore protocol writes the
destination fence and a new guard bound to that restore ID and time. An exact
interrupted resume preserves the same epoch. Reconciliation removes only the
downstream-effect fence; it does not remove the guard or shorten the assertion
hold. Every restore establishes this control state even when the current config
does not enable managed replay.

External-assertion authentication remains unavailable until:

```text
restore time + current externalAuth.maxTtlSeconds + 30 seconds
```

During the hold, affected requests return `503 external_auth_unavailable` with
bounded retry information. The guard runs before a saved operation response can
be returned, as well as before new assertion consumption. Restarting the agent or
clearing the reconciliation fence does not skip it. Keep the epoch permanently:
increasing the configured maximum TTL can reopen the hold. Normal expiry of replay
claims does not remove the epoch, and a backwards wall clock fails closed.

The destination must have trusted synchronized time. A fresh host cannot prove
clock history that was discarded with the old host. This guarantee applies to
Auggy's offline restore protocol, which creates new destination control state.
An unmanaged full-volume snapshot can roll the guard back with its database.
Keep such a recovery offline until it passes through the Auggy restore/reconcile
protocol, or remove **all** signing keys that could verify pre-recovery assertions
before reopening external-assertion ingress. Keeping a previous key in a rotation
keyring retains that authority. Reconcile downstream effects separately either way;
invalidating assertions cannot undo an already committed business operation.

A caller-owned programmatic replay store has its own persistence and recovery
contract. The managed guard does not extend that guarantee to arbitrary external
stores, raw database copies or concurrent replicas.

## Restore order and rollback

Restore and validate these planes in order:

1. compatible source/runtime image and configuration;
2. secrets and server-minted agent identity;
3. external coordination/auth stores at their chosen recovery point;
4. complete runtime-volume bundle;
5. provider mailboxes and downstream side-effect reconciliation;
6. authenticated startup and application checks;
7. ingress reopening.

The current recovery verifier admits exact supported core SQLite identities.
An older bundle that needs migration must first be rehearsed with a runtime
whose store-owned migrators explicitly support that prior identity. Keep the
original bundle immutable before allowing migration. A newer schema must fail
on an older runtime. Binary rollback therefore also needs the matching
pre-upgrade state bundle; rolling back code alone is not safe.

The runtime-volume tools do not schedule backups, rotate them, delete them,
upload them, or configure a load balancer. Those remain deployment concerns.
If horizontal scaling is added later, the recovery contract must expand to
shared databases, leases, fencing, coordinated recovery points, and mixed
version rollout behavior before multiple replicas can serve one logical Auggy.
