# Compatibility, Migrations, and Rollback

Auggy's current production boundary is one process serving one logical agent.
This document defines what an operator may carry across an upgrade of that
single replica and where Auggy deliberately fails closed.

The package is pre-1.0. Source APIs and configuration fields can still change
with an explicit changelog entry, but stored state is never silently reset,
reinterpreted, or accepted merely because an object has a familiar name.

## Contract ledger

| Contract | Current boundary | Compatibility rule |
| --- | --- | --- |
| `agent.yaml` | Structural 0.x contract | Omitted `settings` means defaults. `settings` must otherwise be an object. Unknown top-level fields are rejected so typos cannot silently restore defaults. A breaking field change requires an Unreleased changelog entry and an operator edit; no general config migrator is claimed. |
| `GET /health` | Minimal unversioned liveness probe | HTTP 200 with `status: "healthy"` means only that the web listener is alive. It is not readiness, migration, provider, or queue evidence. Operators must not deserialize it as `AgentHealth`. |
| `AgentHealth` | Package source API | Follows the installed pre-1.0 package version. It is not a persisted or wire schema. |
| Operational snapshot | `schemaVersion: 1`, process scope | Consumers must require the exact schema they understand. The snapshot resets at start and is not restored or merged across processes. |
| `auggy routes --json` | Envelope `schemaVersion: 1` | Consumers must reject unknown envelope versions. Route entries remain derived from the current config and installed augment code. |
| OpenAPI route artifact | OpenAPI 3.1.0 plus `x-auggy.artifactSchemaVersion: 1` | Regenerate when route paths, auth, policies, media types, or schemas change. `info.version` labels the generated API description, not the Auggy package. |
| Generated TypeScript client | Generator `v0` in the file header | Generated files are application-owned snapshots, not package exports. Regenerate and typecheck them during an upgrade; Auggy never rewrites copied clients or templates. |
| Scheduler recovery | Package API plus store-owned incident versions | Process-local `recoverThread()` is valid only after every durable incident authority has been reconciled. AgentMail, Telegram, notify, and console recovery use their own versioned, compare-and-set records. |
| Durable job execution | `auggy/jobs` source API plus `DJOB/v2` | One server-minted job and immutable binding per key. Unstarted work may retry within bounds; post-start ambiguity requires exact incident/version reconciliation. This is not a multi-step workflow-history contract. |
| Runtime inventory and bundle | Inventory v1, bundle v1, volume identity v1, restore fence v1 | Readers require exact supported versions, configuration shape, agent identity, replay-critical mapping, paths, modes, and hashes. Unknown/newer formats fail before restore or startup. |
| PostgreSQL coordination preview | Checksum ledger plus exact catalog validation in the `public` schema | Provisioning is explicit. Every run revalidates owned tables, columns, types, nullability, defaults, sequence ownership, indexes, and checks, including when the ledger already says the migration ran. The runtime still refuses replica mode. |
| Logical-agent identity and local lifecycle | Immutable `agent.yaml` `aug1_` id | State and authority namespaces, local process manifests, launchd labels, and owned runtime paths bind to the immutable id. Display names are non-authoritative aliases and ambiguous aliases fail closed. |
| Local runtime-claim registry | `AUCL/v2` in `~/.auggy/runtime-claims.sqlite` | Exact branded v1 migrates transactionally to v2, which adds the one-row-per-agent launchd generation allowlist. Unknown or lookalike catalogs fail before lifecycle admission. Stop/unload all old launchd jobs before upgrade; rollback requires the matching pre-upgrade local registry or an operator-proven fully stopped rebuild. |
| Railway deployment metadata | `.auggy-cloud.json` version 1 plus immutable agent id | Legacy, malformed, or mismatched records are never adopted automatically. Verify the remote target, remove the local record explicitly, and deploy again to mint a bound record. |

Adding a field to an operational or route artifact is not permission for a
consumer to accept an unknown schema version. Conversely, the unversioned
health probe stays deliberately small so a load balancer does not mistake a
rich diagnostic response for readiness.

## Owned persisted schemas

Core SQLite stores use an application id, `user_version`, exact owned-object
validation, and store-owned migration code. Opening an unrelated, lookalike,
tampered, or newer database fails without stamping or mutating it.

| Store | Current schema | Supported predecessor evidence | Rollback boundary |
| --- | --- | --- | --- |
| Admin overrides | `admin-overrides/v2` | Exact v1 remains readable; a named singleton may inherit the legacy AgentMail cap and rewrites it into its instance namespace on the next AgentMail cap change | Restore the complete matching policy file; v1 code must not read a v2 file |
| Layered memory | `LMEM/v1` | Recognized unstamped legacy facts migrate to v1; migration tests prove preservation and idempotence | Restore the immutable pre-upgrade bundle before running older code |
| Budgets | `BUDG/v1` | Exact recognized legacy shape only | Restore bundle; reconcile quota and downstream usage first |
| Visitor auth | `VAUT/v1` | Exact recognized legacy shape only | Restore bundle plus the matching auth/revocation recovery point |
| Web idempotency and rate limits | `AUID/v2` | Exact v1 migration fixture | Restore bundle; do not roll back terminal request evidence independently |
| Console chat/history | `CCHT/v4` | Exact v2 and v3 fixtures migrate to v4 | Restore bundle with matching thread ownership/history state |
| Telegram replay/conflicts | `TGRP/v2` | Exact prior replay fixture | Restore bundle and reconcile provider offsets/conflicts before ingress |
| AgentMail inbound ledger | `AMIL/v5` | Exact v1, v2, v3, and v4 fixtures | Restore bundle and reconcile mailbox/downstream delivery, inbound quota, and pending digest state |
| Notify delivery incidents/quotas | `NTFY/v2` | Exact v1 migration fixture | Restore bundle and reconcile outcome-unknown notifications and internal retry authorizations |
| Durable jobs and schedules | `DJOB/v2` | Exact branded `DJOB/v1` migrates atomically to v2; lookalikes fail before DDL | Restore the complete pre-upgrade bundle to roll back; reconcile every ambiguous downstream effect before enabling schedules or ingress |
| Local runtime claims and launchd generations | `AUCL/v2` | Exact branded v1 claim table migrates to v2 | Local CLI control state, not runtime-volume state; stop and unload every local agent before restoring the matching registry |

Runtime-state restore intentionally requires an exact replay-critical schema
topology. A bundle declaring `AMIL/v4` can be verified by this release, but it
cannot be restored directly into an inventory that declares `AMIL/v5`. Restore
that bundle with the retained v4 Auggy binary first, then start the v5 binary
against the restored runtime volume so the owned ledger migration runs before
ingress. Do not copy only the ledger around this fence.

Thread-history snapshots (`version: 1`), anonymous-session proofs
(`version: 1`), Link provenance (`version: 1`), and model snapshots
(`schemaVersion: 1`) have local readers that validate their own shape. Model
registry caches are advisory and may be discarded on an unsupported cache
schema; replay, authorization, quota, and delivery stores may not.

Supabase tables, downstream provider state, package-owned Link/AgentMail
files, and custom augment persistence are external prerequisites. Core can
inventory them, but their operator or package owns schema migration and the
matching recovery point. Auggy does not claim a universal database migrator.

## Fail-before-serve ordering

The production CLI validates in this order:

1. parse the current `agent.yaml` and reject malformed or unknown top-level
   configuration;
2. admit the runtime volume, its server-minted agent identity, and any restore
   fence;
3. resolve providers and built-in stores, whose schema admission runs before
   an agent handle exists;
4. boot augment lifecycle hooks;
5. validate route collisions and contracts;
6. register transports behind a closed startup admission barrier; and
7. open traffic only after every transport is ready.

A newer or incompatible core store therefore fails before a listener can
serve a turn. Direct library users and custom augments must preserve the same
ordering for their own external stores; core cannot preflight persistence it
does not own.

The optional PostgreSQL coordination schema is provisioned only by
`auggy coordination migrate`. `CREATE ... IF NOT EXISTS` is not treated as
proof: migration success is recorded transactionally and the complete owned
catalog is checked before commit. A checksum mismatch or catalog mismatch
requires operator inspection; do not drop the ledger or rename objects to
force acceptance.

Provisioning is pinned to the lowercase `public` schema and does not honor a
connection- or role-supplied `search_path`. Use a dedicated coordination
database whose `public` schema is owned for this purpose; do not colocate
unrelated tables, triggers, rules, row-security policies, or replacement
sequences under Auggy's owned object names. The migration API accepts an
explicit validated schema only for controlled embedding and isolated tests;
the CLI and runtime deliberately use `public`.

## Upgrade rehearsal

Before changing the runtime package or image:

1. stop and drain the sole replica and close ingress;
2. retain the exact package/tarball or image digest, `agent.yaml`, augment
   metadata, generated artifacts, and deployment configuration;
3. create and verify an offline runtime bundle using the commands in
   [Runtime State Recovery](./27-runtime-state-recovery.md);
4. capture matching external database, mailbox, and downstream recovery
   points;
5. exercise the new runtime against a restored copy, allowing only the
   explicitly supported store-owned migrations;
6. regenerate and typecheck route clients and OpenAPI artifacts; and
7. run authenticated application, recovery, and delivery checks before
   reopening ingress.

Keep the original bundle immutable. Migration tests demonstrate format
compatibility; they do not replace a backup or downstream reconciliation.

### Identity-isolation upgrade

The immutable-agent isolation release is a stopped boundary change. Stop old
name-keyed local processes before upgrading; the new runtime refuses to overlap
one because the old process has no resource leases. Confirm `AUGGY_AGENT_ID`
equals `agent.yaml` `id` and issue new visitor tokens after startup because old
mutable-name audiences are not accepted.

Layered-memory namespaces are now prefixed by the immutable agent id. Existing
shared labels are intentionally not read through a fallback because doing so
would restore cross-agent access. Retaining old memory requires an offline,
reviewed export/relabel/import with a complete backup. Telegram is different:
its durable replay namespace remains the stable provider bot id so an identity
upgrade does not hide deduplication history. See
[Independent Agents on One Platform](./32-independent-agent-isolation.md).

Namespace authorization now uses a collation-independent exact
`namespace_key` (`v1.` plus base64url-encoded canonical UTF-8), not a label
prefix. `Foo`, `foo`, and `Foo:bar` are different principals even when they
share a database or table. Direct `visitorAuth(...)` callers
must now pass both `layeredMemoryDbPath` and `layeredMemoryNamespace` to enable
anonymous-to-recognized migration. Omitting the path disables migration for
direct callers. The CLI continues to resolve its documented `./memory.db`
default and derives the immutable-ID-scoped namespace from the matching
layered-memory augment.

SQLite layered-memory schema version 3 adds nullable `entries.namespace_key`,
an exact-owner index, and the durable `peer_tombstones` table. New writes set
the owner key internally. Existing rows remain `NULL` and are intentionally
invisible to configured namespaced stores; the runtime never guesses ownership
from `label LIKE 'prefix%'`. Adopt legacy rows only while every writer is
stopped, from a complete backup, and from an authoritative row-ID-to-namespace
mapping. Parent/child prefixes are ambiguous and must never be bulk-backfilled
by prefix.

Supabase-backed memory requires the same `namespace_key` column before the new
runtime starts. The bundled layered-memory migration adds the nullable column
and `(namespace_key, peer_id)` index; `supabaseMemory` uses
`namespaceColumn: "namespace_key"` by default for operator-managed tables.
Backfill only proven rows, include the exact key in RLS, and leave unproven rows
quarantined/`NULL`. A missing column fails through PostgREST; there is no
prefix-only compatibility fallback. Rolling back to a binary that ignores
`namespace_key` can reopen cross-namespace access and is unsafe.

## Rollback

Code-only rollback is unsafe after a persisted migration. Stop the agent,
restore the matching pre-upgrade source/config/secrets and immutable state
bundle, restore compatible external recovery points, reconcile all effects
that may have escaped the local volume, clear only the exact restore fence,
and then reopen ingress.

Never make an older runtime accept a newer `user_version`, delete a migration
ledger row, edit a bundle manifest, or copy one replay-critical database out of
an otherwise consistent bundle. If the preceding reader is not explicitly
tested, remain stopped and restore the complete pre-upgrade set.

Mixed-version rollout and online schema migration are not supported because
multiple replicas for one logical Auggy are not supported. A future horizontal
scaling design must define those contracts separately before a load balancer
can distribute one logical agent across versions.
