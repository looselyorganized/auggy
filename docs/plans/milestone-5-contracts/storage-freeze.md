# M5-00 storage interface freeze candidate

Status: ready for root compilation and independent acceptance; no runtime behavior
is implemented by this packet. Source baseline is accepted main `c39b746`, with
preparation commit `13da885`. The parent [C1 contract](./storage-replay.md) remains
authoritative for its full acceptance matrix. Root alone accepts M5-00 and releases
producer assignments.

## Concrete modules and interfaces

The type/constant owners are:

- `src/runtime-data-contracts.ts`: selection, explicit platform policy, branded
  admission, admitted lease, host ownership and synchronous descriptor borrowing.
- `src/auth/external-auth-replay-contracts.ts`: managed store options/results,
  guard/restore-epoch shape, SQLite identity and finite processing limits.

They have only type imports and primitive constant initializers. They add no
package export, public `src/types.ts` contract, launcher, registry instance,
filesystem access or database behavior. Producers must consume these definitions
directly instead of maintaining parallel interface copies.

| Production owner | Required signature / use |
| --- | --- |
| M5-01, `src/cli/runtime-volume.ts` | `selectRuntimeDataRoot` satisfies `SelectRuntimeDataRoot`; a new production generic admission helper returns `AdmittedRuntimeVolumeLease` and requires a validated agent ID. Keep existing no-agent-ID inspection/test helpers compatible, without minting managed capabilities. |
| M5-01, new `src/runtime-data-admission.ts` | Own the live capability registry and `withRuntimeDataAdmission`, satisfying `WithRuntimeDataAdmission`. This neutral module imports filesystem helpers, not CLI bundle/inventory or auth store modules. |
| Root, `src/application/runtime-ownership.ts` | Return `RuntimeDataOwnership`; preserve current retained-ownership cleanup. The explicit platform value follows launch policy, not the root pathname. |
| Root, `src/application/host.ts` and `src/cli/augment-resolver.ts` | Pass the same admitted capability into each existing managed-web owner binding. Resolve every configured managed replay path once before any managed store opens; supply the complete path list to each store. |
| Root, `src/transports/web-transport.ts` | Extend its existing private owner object with optional `runtimeDataAdmission`; managed `dbPath` requires it. Public `webTransport(opts)` cannot mint one. Hold/unavailability is checked before ordinary or saved replay responses, while one-use consumption retains current ordering. |
| M5-04, new `src/auth/external-auth-replay-store.ts` | `createManagedExternalAuthReplay(options: ManagedExternalAuthReplayOptions): ManagedExternalAuthReplay`; validate explicit startup TTL and path membership/containment before opening SQLite. |
| M5-04, new `src/auth/external-auth-replay-guard.ts` | Shared live guard serialization/refcount per active admitted physical root; offline `ensureRestoredExternalAuthReplayGuard(rootFd: number, options: ExternalAuthReplayRestoreGuardOptions): void` for root's restore integration. No CLI imports. |
| Root, state inventory/identity/bundle and `commands/state.ts` | Add EARP inventory identity and the exact reserved control paths; integrate guard creation, interrupted resume and independent reconciliation without weakening empty-target restore. |

The new production admission helper must separate platform selection from common
volume validation. Passing a fabricated advertised mount to the old helper is
not acceptable. Root may re-export the neutral Railway root constant from the
existing CLI module so existing internal imports remain compatible.

## Capability lifetime and physical identity

The current runtime-volume implementation closes its pinned root descriptor before
returning a lease; only the singleton descriptor survives. M5-01 must retain both
until release. Issue exactly one frozen `RuntimeDataAdmission` object after valid
agent identity, restore-fence refusal, private directory checks, singleton lock and
durability admission have succeeded. No capability is issued for a probe, for a
no-agent-ID helper, or before the singleton is held.

The declaration's unexported TypeScript brand prevents accidental structural
construction; a private live-lease registry establishes actual authority. A cast,
copied object or matching path string is insufficient. Keep the pinned descriptor,
physical `dev`/`ino`, configured/canonical path and active flag private. Before
managed database admission and each guard operation, validate live registry
membership and ensure current path resolution still names the pinned directory,
with current-owner/private-mode checks. Root replacement or release fails closed;
the guard must not use an old pinned directory while SQLite resolves a new one.

`withRuntimeDataAdmission` lends the descriptor only to a synchronous internal
callback. The callback must not close, retain or asynchronously use it. No root
descriptor field appears on the admission or host ownership object. The shared
guard never creates a replacement capability. Revoke registry membership before
closing owned descriptors during idempotent release; normal host shutdown releases
ownership only after transports and managed stores have quiesced and closed.
The callback type rejects normally inferred PromiseLike returns. The implementation
must also reject returned thenables to catch type erasure/casts; neither check is
a security sandbox for trusted code that already scheduled asynchronous work.

Legacy volume helpers keep their existing return/signature compatibility. Their
use does not establish managed replay authority. `RuntimeDataOwnership.platform`
is `railway` only for the explicit Railway launch policy; generic `/app/data`
must not inherit Railway trusted-proxy defaults. Empty Railway mount provisioning
remains C2's separate bounded step, before common admission.

## Managed store and guard rules

`managedDbPaths` is the complete, bounded configured managed-store inventory,
resolved by the host before constructing any transport. It must contain the
current `dbPath`. Every entry uses the same runtime-root containment policy;
configuration cannot nominate an outside database to influence initialization.
The guard initializer examines all these paths before first-use initialization,
not merely the current transport's possibly new path. Missing or corrupt guard
beside any existing configured managed database fails closed. A previously valid
guard is never reset because another transport or newly configured DB opens.

Changing or deleting a replay DB location is an operator state-migration/security
operation. Ordinary startup never silently migrates or resets old state. A new
path with an old valid guard does not preserve claims discarded with the old DB;
use a reviewed stopped migration or remove every old accepted signing key before
admitting assertions that could replay lost state. This profile inventories
configured stores, not every historical/unconfigured database on the host.

The DB key is SHA-256 of an unambiguous domain-separated tuple of exact audience
and jti. Key ID is excluded. Each physical DB enforces one 100,000-live-row cap
across all audiences in a single immediate prune/check/count/insert transaction.
Prune only entries whose expiry is at or before the sampled time. Expired,
invalid and duplicate claims are rejected; capacity/storage/guard/clock failures
remain unavailable, never anonymous identity or a cache miss.

The managed API does not accept caller-supplied `now`. Guard serialization samples
the production clock after acquiring its critical section and persists the
nondecreasing watermark before any authorized response or committed claim.
`checkAvailability` returns that timestamp for final assertion timing checks;
`consumeVerified` independently rechecks claim timing at its serialized timestamp.
The same root coordinator covers every transport and DB handle. The admitted
singleton supplies process exclusion; the coordinator is not a substitute for it.

The explicit startup TTL is validated, not persisted as future authority. Each
availability/claim call supplies the current verifier TTL. The permanent restore
epoch plus current TTL plus 30,000 ms determines the hold; increasing TTL can
reopen it. `close()` is transport-owned after quiescence, idempotent, and releases
the store's shared-guard reference before the root lease can be released.

Caller-owned `ExternalAuthReplayStore.consume(jti, expiresAt, now)` and its return
type remain unchanged. These stores are not closed, persisted or re-namespaced by
managed mode. Public in-memory development replay remains explicitly programmatic.

## Frozen finite bounds and SQLite identity

| Item | Bound / decision |
| --- | --- |
| SQLite brand | `EARP`, application ID `0x45415250` / `1161908816`, user version 1, inventory label `EARP/v1` |
| Timestamp | Safe integer milliseconds in `[0, 8_640_000_000_000_000]`; check intermediate additions and TTL multiplication before using them |
| TTL | Required positive safe integer seconds; `TTL * 1000`, current-time arithmetic and restore barrier must remain within the timestamp bound |
| Audience | Preserve existing exact verifier validation: nonempty, at most 256 UTF-16 code units, no existing forbidden controls; no normalization or key-ID namespace |
| jti | Nonempty, at most 256 Unicode scalar values and 1,024 UTF-8 bytes; reject unpaired surrogates and Unicode control characters (`Cc`) before hashing; managed mode only |
| Future-issued allowance | 30,000 ms, matching the current assertion verifier |
| DB capacity | 100,000 unexpired entries per physical managed DB, without live eviction |
| Configured managed paths | At most 10,000 entries, matching the existing inventory store-count ceiling; require current-path membership and runtime-root containment |
| SQLite busy timeout | 5,000 ms, matching the current hardened helper default; `synchronous=FULL`, no unbounded retry loop |
| Guard payload | Strict v1 shape, at most 4 KiB, 0600, current owner, singly linked regular file |
| Retry-After | Whole seconds clamped to `[1, 3600]` from remaining hold; no paths, claims or raw exceptions |

Search of accepted source/tests/packages found no `EARP`, `0x45415250`, or decimal
`1161908816` identity in use. Existing brands are `LMEM`, `BUDG`, `VAUT`, `AUID`,
`CCHT`, `TGRP`, `NTFY`, `AMOR`, `DJOB`, and lifecycle `AUCL` (plus test-only `AUGY`).
Root's identity table should import the constants from the behavior-free contract
module, avoiding a volume → bundle → auth-store → volume import cycle.

## Exact control paths and interrupted writes

Only these root leaves are reserved for this profile:

```text
.auggy-auth-replay-guard.json
.auggy-auth-replay-guard.pending
```

Use a guard-specific atomic writer built from the existing anchored/descriptor
helpers with the exact pending leaf. `replacePinnedFile` currently creates random
temporary names; using it unchanged would strand a new unknown file that strict
restore resume cannot account for. No wildcard temp exclusion or broad cleanup is
permitted. The pending leaf is also bounded/private/regular/singly linked and is
published with fsync-file, rename, fsync-directory durability.

| State | Allowed behavior |
| --- | --- |
| Ordinary startup, valid guard, no pending leaf | Validate lease/path/agent/clock and continue under the normal hold. |
| Ordinary startup, valid matching pending image | Recover only after validating both images; preserve the same restore epoch and at least the highest valid watermark. Never silently roll back to the older image. |
| Ordinary startup, malformed pending image | Fail closed; no automatic deletion or guard reset. |
| Ordinary startup, missing/corrupt guard beside any existing configured managed DB | Fail closed, even if the current transport's own dbPath is new. |
| Proven first use, no managed DB exists and no ambiguous control artifact exists | Initialize the shared guard before opening the first managed DB. If DB creation then fails, retry may reuse that valid guard. |
| Validated `copying` restore fence, guard write interrupted | Ingress has never been admitted. Validate exact owned/regular/0600/single-link pending leaf, then clean/rebuild only that leaf from the verified fence and any valid guard's maximum watermark. Retain the fence's original restore ID/time before payload resumes. |
| Backup with unresolved pending leaf | Read-only refusal; do not repair or discard it while taking a backup. |
| Bundle containing either reserved control path | Reject the bundle; neither control leaf is restored payload. |

Under a validated copying fence, a partial pending payload may be incomplete JSON;
strict file ownership/type/path validation plus the verified fence and any valid
guard authorize this narrow interrupted-write repair. This exception does not
apply to ordinary startup. A corrupt final guard is not equivalent to a missing
guard or an incomplete pending leaf and is not silently reset.

## Restore and inventory ownership

Root uses the existing v1 `externalPrerequisites` representation for a single
agent-wide guard requirement with owner `runtime`, explicitly described as local
control state excluded from backup payload. It is not labeled as remote hosting,
volatile data or optional state. Do not add a backup-plane enum solely for this
guard. The DB inventory remains per configured managed transport with its verified
audience namespace and `replayCritical: true`; path/schema parity tests are required.

Every empty-target restore uses the documented trusted fresh-destination clock
assumption, including movement to a different root on the same host. No new
high-water transfer API is introduced. Root commits the existing copying fence,
then `ensureRestoredExternalAuthReplayGuard` uses its exact UUID and parsed
`restoredAt` before any replay DB payload is copied. The helper samples its clock
internally and rejects arithmetic/rollback inconsistencies. Resume preserves the
same epoch, validates the exact allowed file subset including the two control
leaves under the rules above, and never permits arbitrary extra files.

Reconciliation removes only the downstream-effect fence; it never erases the
guard, epoch or hold. A normal restart is never treated as a fresh restore. The
guard cannot guarantee protection from raw platform snapshots that restore it
together with its database; the C1 offline restore/old-key-removal procedure and
downstream reconciliation remain explicit independent requirements.

## Acceptance handoff

Container execution exposed an existing distinction between a temporary recovery
mount and the final runtime mount. For a project at `/app`, `./data/store.db`
maps to the leaf `store.db` under `/app/data`; deriving inventory against a
temporary `/restore` mount changes that layout. The additive `--runtime-root`
option on `state restore` and `state restore-resume` now supplies the final
absolute mount for pure topology validation. `--root` remains the pinned physical
copy destination, and omission preserves the previous behavior. The compatible
project must be available at its runtime path in the recovery container.
This does not remap runtime stores, migrate existing data, bypass inventory
compatibility, or change fence/guard semantics. Wrong topology still refuses
before destination creation. Two independent reviewers accepted the narrow
repair; real bundle relocation and interrupted-resume regressions pass.

Root compiles these production contract modules and a real usage fixture before
accepting M5-00. M5-01 must falsify forged/revoked capability and path replacement,
prove retained descriptors/singleton cleanup, and preserve all launch paths.
M5-04 must falsify cross-transport first-use mistakes, incomplete pending recovery,
clock rollback/concurrent sampling, hold bypass via completed replay, TTL changes,
same-jti rotation reuse, capacity eviction and caller-owned-store takeover.
Root's state integration verifies offline backup/resume/reconciliation against
the exact control-path rules. M5-07 then repeats meaningful installed/container
recovery with accepted artifacts; type compilation and unit mocks do not certify
that behavior.
