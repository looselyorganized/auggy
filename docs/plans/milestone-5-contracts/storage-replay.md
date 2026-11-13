# C1 draft — portable runtime storage and assertion replay

Status: preparation only; **not frozen or accepted**. G0 is accepted; the M5-00
interface/ownership freeze remains pending in root's execution ledger.
This document authorizes no producer edits. Source observations below refer to
reviewed M4 commit `32d7265d0659d5911755e802d18a9f9077b80196`; the preparation
worktree started from main `911fe1682c76208c1d99d4dc6841bfcaa608dd8d`.
The worktree is now rebased onto merged M4 main
`c39b746b4b743e5c29dab61a677026c10626d8b8`, including the reviewed duplicate-tool
repair `56de4e3`. That repair does not change these storage interfaces. Main
verification and M5-00 acceptance remain explicit ledger decisions.

The contract supports one independently owned agent deployment and one active
SQLite runtime. HTTP is optional; root admission also applies to polling workers.
Central YAML remains the single enabled graph. Existing programmatic replay
stores remain caller-owned. This work does not enable PostgreSQL coordination,
introduce a second kernel, add a container launch mode, or publish packages.

## Producer and integration ownership

Root reserves config/bootstrap, public types, shared state/restore interfaces,
manifest/lock changes, common harness, contracts and acceptance decisions. The
following is a proposed assignment map, not permission to edit reserved files.

| Boundary | Existing producer/caller | Proposed writer and handoff |
| --- | --- | --- |
| Root selection and admission | `src/cli/runtime-volume.ts` | M5-01: pure selection plus generic admission implementation; root approves interface |
| All host launches | `src/application/runtime-ownership.ts`, `host.ts`, `runner.ts` | Root integrates M5-01 patch and launch parity tests |
| CLI and local/global routing | `src/cli/commands/dev.ts`, `run.ts`, `start.ts`, `project-runtime.ts` | Root; preserve package selection and existing foreground/launchd paths |
| YAML validation and option plumbing | `src/cli/config-parser.ts`, `augment-resolver.ts`, `types.ts` | Root integrates M5-04's validation table and path contract |
| Managed replay database and guard | New package-private `src/auth/external-auth-replay-store.ts` and `external-auth-replay-guard.ts` | M5-04; exclusive ownership of implementation and matching focused tests |
| Assertion primitive compatibility | `src/auth/external-auth.ts`, `src/index.ts` | Root; retain public `ExternalAuthReplayStore.consume` signature and exports |
| HTTP auth and lifecycle | `src/transports/web-transport.ts` | Root integrates M5-04 handoff; no concurrent transport edits |
| Inventory and SQLite identities | `src/cli/runtime-state-inventory.ts`, `runtime-state-sqlite-identities.ts` | Root integrates M5-04 schema/entry proposal |
| Backup, restore, resume and reconciliation | `src/cli/runtime-state-bundle.ts`, `commands/state.ts` | Root integrates guard state machine and contract tests |
| Installed/container recovery | M5 acceptance harness | M5-07 after M5-01/M5-04 acceptance; producer unit tests do not certify this |

Each handoff includes exact file paths, patch, tests, negative controls and observed
behavior. Root assigns exclusive test paths before implementation. An independent
reviewer checks the integrated code; producers cannot accept themselves.

## Observed execution path and root admission

M4 already converges its launches: project `runApplication` selects the installed
runtime and calls `runManagedApplication`; CLI `runDev` selects the declared
application or `runLegacyApplication`; both use the same application host.
`host.prepare()` parses config, rejects unsupported coordination, acquires runtime
ownership, then resolves the engine and augments. This is the admission seam.
Legacy mode does not need a second storage implementation.

Currently `acquireRuntimeOwnership()` leases a runtime volume only for Railway.
The existing volume admission requires `advertisedMount === runtimeDataRoot`,
pins the root, checks mode/identity/restore fence, claims the singleton lock and
probes durable file operations under `agent-mail`. Generic admission must retain
these guarantees while moving the Railway-specific mount comparison into policy
selection. Passing a fabricated advertised mount to the old helper is not a
generic policy implementation. Existing identity, pinning and lock helpers must
be reused, including cleanup on partially failed preparation.

Proposed package-private interface, frozen by root before M5-01:

```ts
type RuntimeDataSelection =
  | { kind: "local" }
  | { kind: "explicit"; runtimeDataRoot: string }
  | { kind: "railway"; runtimeDataRoot: "/app/data" };

interface RuntimeDataEnvironment {
  auggyDataDir: string | undefined;
  railwayVolumeMountPath: string | undefined;
}

function selectRuntimeDataRoot(
  mode: ApplicationLaunch["mode"],
  env: RuntimeDataEnvironment,
): RuntimeDataSelection;

interface RuntimeVolumeLease {
  readonly runtimeDataRoot: string;
  release(): void;
}
```

Selection is pure. An explicit root must be a nonempty absolute filesystem path,
with no NUL; empty/whitespace-only values are errors, not absence. Do not expand
`~`, interpolate variables, or reinterpret a relative path against CWD. Admission
uses the existing filesystem policy for physical identity and alias rejection;
lexical normalization must not hide symlinks or unsafe components. The existing
root must already exist, be owned/private and admit durability operations. Fail
without creating a missing explicit root or falling back to project storage.
Generic Docker/local admission never repairs permissions. Railway alone has the
narrow first-use provisioning step specified in C2: before ordinary admission,
an already existing, pinned, current-owner, empty advertised mount may have its
own mode narrowed to 0700. Existing nonempty state receives no such repair.

| Launch/configuration | Selection and effect |
| --- | --- |
| Direct application, local/global CLI, legacy, launchd; variable unset | Preserve existing local storage behavior |
| Any of those; `AUGGY_DATA_DIR` set | Admit that root before provider/augment effects; acquire the same singleton lease |
| Railway; generic variable unset | Require advertised `/app/data`, admit `/app/data` |
| Railway; generic variable is `/app/data` | Same checks; no second lease |
| Railway; generic variable differs or advertised mount is missing/wrong | Fail before effects |
| Worker without web transport | Identical storage checks; no port/listener requirement |
| Startup throws or stop completes | Release acquired ownership through existing cleanup once |
| Cleanup cannot prove resources closed | Preserve existing retained-ownership behavior |

Source-owned application module import precedes `host.prepare()` in the CLI path.
Therefore the precise promise is admission before **runtime provider/augment
construction and runtime ingress**, not before arbitrary user-written top-level
module effects. Generated source remains side-effect-free until launch/prepare;
the harness must not claim protection against arbitrary application code that
performs effects before calling the host.

The admitted root reaches `resolveAugments` and the runtime through the existing
host plumbing. Reuse resolver `resolveSqlitePath` and its pure inventory counterpart
`resolveRuntimeStatePath`: configured relative paths map under the admitted root;
absolute paths must remain inside it; traversal/unsafe artifacts fail. Inventory,
export preflight and runtime must agree. No runtime state path is computed in an
example-specific TypeScript graph. Generic root selection must not accidentally
enable Railway trusted-proxy defaults merely because an operator uses `/app/data`
outside Railway; review the existing path-equality heuristic in
`resolveTrustedProxies` when separating platform policy from storage policy.

## Managed assertion replay configuration and bounded inputs

The proposed YAML shape is:

```yaml
externalAuth:
  maxTtlSeconds: 60
  replayProtection:
    enabled: true
    dbPath: ./data/external-auth-replay.db
```

Root adds the optional `dbPath` field to transport options and YAML validation.
Managed mode requires `enabled: true`, one nonempty persistent path, and an
explicit positive safe-integer maximum TTL. Reject `dbPath: null`, `:memory:`,
SQLite URI/connection-string paths, disabled-plus-path, store-plus-path, and
enabled-with-neither-store-nor-path. YAML still rejects executable stores. Do not
silently infer managed storage for existing configurations.

Existing programmatic `consume(jti, expiresAt, now)` and its ownership remain
unchanged: Auggy does not close, wrap into a different namespace, or silently
persist the caller's store. Existing in-memory development helper remains
explicitly programmatic. There is no new exported SQLite factory requirement.

Root's preparation disposition: **managed dbPath requires a currently admitted
runtime data root** obtained through the configured host/CLI (`AUGGY_DATA_DIR` or
Railway). Without it, startup returns an actionable configuration failure before
opening the managed DB. The reference/harness provisions an explicitly owned 0700
root. Unset-variable local behavior remains unchanged for all other cases; Auggy
does not chmod the project, invent a local volume or silently weaken managed replay.

Minimal internal binding, using the existing M4 host factory rather than a new
public escape hatch:

```ts
// Package-private, opaque, issued only by successful runtime-volume admission.
// Its validity is tied to the held lease, not just these readable path fields.
interface RuntimeDataAdmission {
  readonly runtimeDataRoot: string;
  readonly agentId: string;
  // Module-private brand; runtime admission registry also rejects fabricated
  // objects and invalidates the capability when its owning lease is released.
}

function createManagedWebTransport(
  opts: WebTransportOptions,
  owner: {
    name: string;
    canServe(): boolean;
    runtimeDataAdmission?: RuntimeDataAdmission;
  },
): ManagedWebTransport;
```

`RuntimeVolumeLease`/`RuntimeOwnership` carry this package-private capability;
`host.prepare()` passes it through the factory owner argument already used for
both configured and legacy hosts. The resolver still resolves dbPath exactly once
from YAML. A root string in public options is not admission. Public
`webTransport(opts)` has no owner capability and rejects managed dbPath with an
instruction to use the configured host/admitted root or supply a caller-owned
programmatic store. No public `src/types.ts` or package export addition is needed
for this capability. Keep its tiny internal type/registry in a neutral module if
needed to avoid an auth → CLI bundle → auth-store import cycle. Root freezes the
exact module owner and lease invalidation/cleanup before producer work.

Managed-only input bounds proposed for freeze:

| Input | Rule |
| --- | --- |
| Audience | Verified exact configured audience; preserve current 1–256-character identity validation |
| `jti` | Required, nonempty; at most 256 Unicode scalar values and 1,024 UTF-8 bytes, no control characters; validate before hashing/storage |
| Timestamps | Integer milliseconds, nonnegative, at most `8_640_000_000_000_000`; reject non-finite, fractional and out-of-range values in managed mode |
| Maximum TTL | Positive safe integer; multiplication by 1,000 and every addition to observed/restore time must remain within the timestamp bound |
| Assertion timing | `expiresAt > now`, `expiresAt > issuedAt`, TTL within current verifier bound; retain allowed future-issued skew of 30,000 ms |
| Capacity | Exactly 100,000 unexpired entries per physical managed database, across all audiences |
| Busy handling | Bounded existing hardened-SQLite timeout; no unbounded retry queue |
| Retry hint | Whole seconds, `max(1, min(3600, ceil(remainingMs / 1000)))`; never reveal filesystem paths or claims |

These managed bounds must not accidentally narrow existing public programmatic
store behavior. The exact jti and Retry-After limits are draft implementation
choices requiring root freeze; neither is asserted as an existing API contract.

## Database and transport handoff

Proposed package-private operations:

```ts
type ReplayAvailability =
  | { status: "ready"; nowMs: number }
  | { status: "held"; retryAfterSeconds: number }
  | { status: "unavailable"; reason: "clock" | "guard" | "storage" };

type ManagedReplayClaim =
  | { status: "consumed" }
  | { status: "rejected"; reason: "replay" | "expired" | "invalid" }
  | { status: "held"; retryAfterSeconds: number }
  | { status: "unavailable"; reason: "clock" | "guard" | "storage" | "capacity" };

interface ManagedExternalAuthReplay {
  checkAvailability(maxTtlSeconds: number): Promise<ReplayAvailability>;
  consumeVerified(input: {
    audience: string;
    jti: string;
    issuedAt: number;
    expiresAt: number;
    maxTtlSeconds: number;
  }): Promise<ManagedReplayClaim>;
  close(): void;
}
```

No caller supplies `now` to the managed operations. The production clock is
sampled inside the shared serialized guard section; a private injected test clock
is acceptable. Both operations recheck guard integrity/current TTL. A ready result
provides the timestamp for final assertion timing verification. `consumeVerified`
rechecks timing at its own serialized timestamp to cover expiration between auth
and the durable operation claim. Validation/signature failures remain ordinary
unauthorized outcomes; holds/unavailability must not collapse into anonymous access.

Use `openHardenedSqlite`, schema identity admission and exact schema validation.
Proposed brand is `EARP`, application ID `0x45415250`, version 1, inventory schema
`EARP/v1`; root must verify uniqueness against accepted main before freeze. A
primary-key digest of an unambiguous domain-separated tuple `(audience, jti)`
avoids delimiter collisions and bounds stored key size. The signing key/key ID
does not participate, so rotation cannot permit reuse. Retain expiry as integer
milliseconds. No raw assertion, subject, signature or secret belongs in the DB.

One immediate transaction prunes `expires_at <= now`, checks existing key, counts
remaining entries and inserts the new key. Duplicate and capacity decisions are
atomic across handles. At capacity, fail closed; never evict a live entry or turn
the error into a cache miss. Distinct audiences can reuse the same jti without
collision. Same-audience reuse across signing-key rotation remains rejected.

Transport opens managed storage during its existing startup phase before listener
activation; failures roll back construction. It closes the managed DB only after
HTTP quiescence, following existing idempotency/console-store lifecycle. An admitted
root's guard is shared by all managed transports; its ownership/refcount cannot be
one independent mutable JSON instance per transport. Caller-owned programmatic
stores do not enter managed close/guard behavior.

There are **two current consumption sites** in `web-transport.ts`:

1. Ordinary `resolveExternalVisitorAuth` consumes during authentication.
2. Keyed `/agent/run` authenticates in defer mode, claims durable idempotency, then
   consumes only for a newly owned execution. Completed replay, running, conflict,
   capacity and other prior-claim states return earlier.

Keep this ordering and consume once. Add managed availability to authenticated
assertion resolution, including deferred mode, before **any** response authorized
by that assertion, including a stored completed SSE replay. Otherwise restoration
could serve private replay data during the guard hold without calling consume.
Use the existing idempotency failure path when consumption fails after an owned
claim; do not start tools or automatically repeat ambiguous effects. Return 503
with bounded Retry-After during a hold; storage/capacity/clock faults fail closed
with bounded diagnostics, not raw exceptions or fallback identity. Fresh-assertion
retry of the same operation key must continue to retrieve an authorized prior
response without starting another turn.

## Permanent guard and clock serialization

Proposed reserved guard filename: `.auggy-auth-replay-guard.json`. Its on-disk shape
is strictly versioned, bounded to 4 KiB and rejects unknown/invalid fields:

```ts
interface ExternalAuthReplayGuardV1 {
  version: 1;
  agentId: string;
  latestRestore: null | {
    restoreId: string; // UUID matching the restore fence
    restoredAtMs: number;
  };
  highWaterMs: number;
}
```

Guard access uses pinned/descriptor-relative private-file operations, regular
single-link current-owner checks, mode 0600, bounded parsing and atomic durable
replacement (write, fsync file, rename, fsync directory). Never follow a symlink,
silently reset malformed data, or recreate a missing guard beside an existing
managed database. First-use initialization is allowed only with evidence that
this is a new managed store, never as automatic recovery of existing state.
If initialization writes the guard but DB creation fails, retry may reuse that
valid guard; if initialization cannot prove which state exists, it fails closed.

Every gate/claim shares this critical section for the same physical guard:

1. Acquire serialization; sample wall time **after** acquisition.
2. Validate guard, agent binding, arithmetic and current verifier maximum TTL.
3. Reject `now < highWaterMs`; do not move the stored watermark backwards.
4. Durably persist the monotonic high-water before authorizing an assertion or
   committing its claim. A persistence failure authorizes nothing.
5. If an epoch exists, calculate `restoredAtMs + currentMaxTtlSeconds * 1000 +
   30_000`. Hold while `now` is below that value.
6. For a claim, commit the bounded SQLite transaction before returning consumed;
   release serialization in all cases.

The root singleton excludes other active runtimes. In-process coordination must
cover all handles/transports that share the guard, not just one request closure.
Managed programmatic use without the admitted lease is rejected by the frozen
profile proposed above. Do not assume an in-process Promise mutex alone provides
process exclusion. Require the capability to remain active through store close.

Hold responses can advance high-water. Equal timestamps are allowed. Capturing
time before a wait and comparing it afterwards causes false rollback failures;
last-writer-wins JSON writes can also erase a newer watermark. Both need explicit
concurrency tests. No asynchronous work outside the protected sequence may later
overwrite an older guard image.

Keep the restore epoch permanently: pruning records, restart, successful first
hold expiry, config reload and downstream reconciliation do not erase it.
Compute the barrier using the current verifier TTL at startup and each request.
Increasing TTL can legitimately re-enter hold. Validate immutable runtime options
and revalidate on any supported reconfiguration; never persist an initial TTL as
authority for future admission. Clock rollback leaves auth unavailable until
trusted time catches up; there is no automatic reset command in this milestone.

## Inventory, backup, restore and reconciliation

Add one managed DB inventory entry per configured web transport: owner augment,
namespace verified audience, kind SQLite, schema `EARP/v1`, replay-critical true,
required when managed replay is active, restore order beside web idempotency.
Resolve its path through the same helper as runtime; include database/WAL state
under current stopped-and-drained backup rules and verify SQLite branding.

The guard is **not restored payload**. Represent its requirement in inventory's
existing external-prerequisite mechanism with an explicit local-control-state
description, or root may introduce an explicit non-restored control-state field
with a versioned compatibility migration. Do not label a colocated local guard
as remote infrastructure, ordinary backed-up JSON, volatile state or optional.
The narrow prerequisite representation is preferred to silently expanding schema
enums without updating bundle validators/fixtures.

Current bundle code recursively copies all root files. Add a reserved-control
path rule: validate and exclude the guard from payload, reject bundles that try
to supply that reserved path, and account for the rule in listing/count limits.
Do not allow an untrusted guard blob to disappear silently from bundle validation.
Source inventory inspection and backup are read-only; neither resets/advances a
restore epoch. Future guard lock/temp artifacts, if required, need explicit safe
handling too; broad filename-pattern exclusions are unacceptable.

Current restore requires an **empty destination**. Preserve that safety property:

1. Verify bundle, expected agent/config/topology and stopped-and-drained ack;
   establish the empty pinned destination as today.
2. Write and fsync the copying restore fence before copying replay state.
3. Write and fsync a new destination guard bound to the fence's restore ID/time
   and trusted current clock; never load a guard from the backup payload.
4. Copy and verify payload, preserving the existing downstream reconciliation
   fence. Ingress remains blocked if either guard/fence step is incomplete.
5. Resume accepts only the exact bundle subset plus the validated fence and guard.
   It preserves the same restore epoch; it does not set restoredAt to every resume
   attempt. If interrupted before guard creation, reconstruct only from the exact
   validated copying fence before copying can proceed.
6. Reconciliation removes only its current fence. It never removes the guard or
   clears the authentication hold. Runtime readiness and assertion readiness remain
   distinct when an independent downstream reconciliation has completed.

Root must place recovery around the actual atomic-file helper: an interrupted
guard replacement may leave an owned temporary artifact. Either clean it using
exact validated ownership or recognize it in interrupted-restore recovery;
otherwise resume's current strict file-set validation can deadlock recovery.
Do not weaken resume to allow arbitrary additional files.

On a fresh destination, a new trusted restore time plus the complete current TTL
and future-issuance skew covers all still-valid assertions minted before restore.
The destination cannot prove discarded historical clocks. If same-host state is
moved to a different empty root, do not claim the old physical guard is magically
retained; transfer verified high-water through an explicit non-backup handoff or
apply the documented fresh-destination clock assumption. This remains a root
freeze decision, not permission to replace empty-target restore with overlay.

## Required falsifying evidence

M5-01 must prove direct installed application, local/global CLI, legacy and
launchd paths select the same explicit root; worker paths require no web transport.
Wrong ID, duplicate lease, missing root, symlink/replacement, wrong ownership/mode,
failed durability probe and reconciliation fence must stop before provider,
augment, model, tool or channel work. Unset-variable paths preserve local behavior;
Railway requires its advertised mount and rejects conflicts. Check shutdown and
failed preparation for leaked locks or premature release.
Exercise a genuinely fresh default-mode Railway volume and the narrowly bounded
C2 initialization. Nonempty unsafe roots, wrong owner and symlinks must fail;
do not pre-chmod all fixtures and call that first-deploy evidence. Generic roots
remain operator-provisioned and do not inherit Railway initialization or proxy
trust merely by using the `/app/data` pathname.

M5-04 must cover concurrent same-token claims (one winner), audience separation,
signing-key rotation, restart persistence, exact expiry and 100,000-entry boundary,
zero live eviction, invalid timestamps/jti, storage fault and bounded busy failure.
Cover both transport consumption sites, completed idempotency replay during hold,
fresh-assertion duplicate operation replay, and caller-owned store compatibility.

Restore proof needs an assertion consumed after the backup, restoration of that
older DB, blocked use before barrier, and successful fresh authentication after
the complete hold. Also test interrupted fence/guard/payload stages, reconciliation
without guard clearing, restarts without epoch reset, TTL increase after an earlier
hold ended, concurrent clock samples, true rollback, durable watermark persistence
failure, missing/corrupt/symlink/hardlink guard, arithmetic extremes, and rejected
incoming guard payload. Validate inventory/runtime path and SQLite identity parity.

M5-07 repeats meaningful restore/restart/singleton assertions with the actual
installed package and replaced container, recording source/package/image identity
and zero unauthorized effects. Unit mocks alone do not demonstrate durability,
path admission or platform deployment behavior.

## Root dispositions and remaining freeze checks

1. **Local managed guard placement — root disposition recorded.** Require explicit
   admitted-root capability for managed replay; direct factory managed mode without
   that capability fails. Caller-owned stores remain compatible. Root still freezes
   the minimal internal owner binding and validates it against accepted main.
2. **Physical snapshot limits — root disposition recorded.** A guard stored on the
   same volume can be rolled back by an out-of-band full-volume snapshot.
   "Non-restorable" certifies Auggy's state tools only. Raw snapshot recovery must
   remain offline until Auggy's restore/reconcile protocol has established a new
   guard, or use fresh signing credentials with **all old accepted keys removed**
   before ingress. The credential alternative does not resolve downstream effects;
   their reconciliation remains independent. There is no automatic raw-snapshot
   detection/guarantee and no claim that a colocated file survives infrastructure
   rollback. Protection across arbitrary platform snapshots would require an
   independent non-restored trust anchor outside this certified profile.
3. **Empty-target continuity.** Preserve current empty-target restore and identify
   when trusted fresh-destination time is assumed versus an explicitly transferred
   prior high-water. Normal restart must never be confused with a fresh restore.
4. **Authorization versus consumption.** The managed guard must run before stored
   response replay as well as before new consumption; merely replacing the old
   `store.consume` function leaves a confidentiality gap during restoration.
5. **Platform inference.** The current trusted-proxy default is selected by the
   string `/app/data`. Generic roots must not grant Railway proxy trust by pathname.
6. **Durability cost.** Persisting a guard watermark for each authenticated decision
   adds durable writes. Do not coalesce past the accepted guarantee or remove fsync
   to hide latency; measure representative concurrent acceptance. A different
   durable clock mechanism needs separate review.

These are concrete implementation/guarantee boundaries, not requests to broaden
M5 into managed hosting, a new auth protocol, PostgreSQL coordination or a new
workflow engine. Root records each disposition in the contract freeze and only
then releases the dependent producer assignments.
