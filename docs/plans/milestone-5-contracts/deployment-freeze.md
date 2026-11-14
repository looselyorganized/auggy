# M5-00 deployment interface freeze candidate

Status: ready for root compilation and independent acceptance. This document
does not accept itself or release M5-02/M5-03. The only source addition is
[`src/cli/deploy/contracts.ts`](../../../src/cli/deploy/contracts.ts): types and
constants, with no export, deployment, filesystem or network behavior.

Baseline is accepted main `c39b746b4b743e5c29dab61a677026c10626d8b8`, on the
isolated M5 preparation branch at `13da885`. This records concrete decisions
from [C2](./deployment.md), reconciled against the existing bundle, Dockerfile,
health, Railway CLI, deploy orchestration, cloud readers and passive authoring
contracts. Root owns acceptance, shared integration and later amendments.

## Producer seams and ownership

| Contract | Implementation owner and exact handoff |
| --- | --- |
| `DeploymentProfileOperations` | M5-02 implements `resolveDeploymentProfile` and `reconcileDeploymentProfile` in new `src/cli/deploy/profile.ts`. Root consumes reconciliation in runtime preflight; M5-03 consumes it before hosted mutation. |
| `StageBundleOptions`, `PortableExportOperations` | M5-02 updates `bundle.ts` to import the shared option type, retaining synchronous `stageBundle(options): string`. New `portable-export.ts` exports asynchronous `exportDocker(options)` so bounded streaming archive inspection does not require buffering an expanded archive. |
| `ExportDockerOptions` / result | M5-02 owns new `commands/export.ts`. Root owns CLI registration/flags. The CLI supplies default `ingress: "auto"`; `out` remains required. Async local I/O does not authorize a child, registry or Docker call. |
| `DeploymentManifestV1` and file/limit constants | M5-02 writes generated context and manifest. Root owns the contained manifest reader and host hook. No package export or new public runtime graph is added. |
| Strict `CloudRecordV1` / `CloudRecordV2`, normalization | Root changes `src/cli/types.ts` to reuse the shared union, adds validation/normalization in `agent-index.ts`, and updates every writer before M5-03 consumers land. Unknown JSON remains `unknown` until validation. |
| `HealthCheckOptions` / result / operation | M5-03 imports these types in `health.ts` and re-exports them there, preserving existing import paths. New optional `healthPath` and `requestTimeoutMs` extend the old options; the result's existing fields remain. Do not leave two independent declarations after implementation. |
| `DeploymentReadiness`, `ProfileAwareDeployResult` | M5-03 makes the deploy result profile-aware, retaining target IDs and an explicit nullable `health`. Root updates CLI formatting; worker output must never manufacture a health URL or console link. |
| Built-in classification / limits | M5-02 consumes the shared constants. Their exhaustive `BuiltinAugmentType` record forces a decision when a built-in type is added. Tests compare passive/raw and effective runtime classification. |

M5-02 owns `profile.ts`, `portable-export.ts`, `commands/export.ts`, `bundle.ts`,
`dockerfile.ts` and matching focused tests. M5-03 owns `commands/deploy.ts`,
`console.ts`, `logs.ts`, `deploy/health.ts`, `railway-cli.ts`, and their focused
tests; `secrets.ts` changes require an explicit scoped handoff. Root retains
`cli/types.ts`, `agent-index.ts`, `cli-program.ts`, config/parser/resolver/host,
`commands/remove.ts`, public runtime types, shared test fixtures, manifests,
locks, CI, status and the integrated acceptance harness. These exact assignments
still need root's ledger release; the producer cannot accept its own result.

## Listener classification and profile semantics

`BUILTIN_INGRESS` classifies the built-in's own inbound listener, not every
possible socket opened by operator code, a shell command or an MCP subprocess.
It imports no factory or package implementation. Unknown/custom declarations
require explicit `none` or `http`; adding a type is never a worker-safe default.

| Class | Frozen interpretation |
| --- | --- |
| `webTransport` | One known listener; port is required by current YAML validation and has no implied default here. A literal valid port resolves directly; an environment expression needs explicit selection/port and launch reconciliation. Missing or malformed required listener fields cannot be repaired by profile flags. Default known health is `/health`; console is `/console` only for omitted/true `adminRoute`. False or unresolved console settings never advertise it. |
| `telegramTransport` | Explicit `inbound.mode: polling` has no listener. Webhook owns its configured listener, default 8081, with no inferred health/console. Missing/malformed mode is invalid; unresolved mode requires an operator profile and effective recheck. |
| `link` | Owns a listener, default 8081. Outbound usage does not remove it. No inferred health or console. |
| Other currently known built-ins | No own inbound listener; visitor-auth routes still need a separately declared web transport. |
| Multiple known listeners | Reject even when ports match, and even with an explicit single-port profile. |

`none` rejects HTTP flags and known HTTP listeners. `auto` cannot resolve unknown
ingress by accepting a `--port`; explicit `http` must describe an existing known
or operator-declared listener, with a literal port conflict rejected. Passive
selection never expands environment values, reads `.env` or executes factories.
Use declaration `options` from `AuthoringDocument` for both inline and referenced
formats; do not invent a second YAML interpretation.

Profile validation rejects a port outside integer 1–65535. Health paths have
exactly one leading slash, a 2,048-byte UTF-8 limit, and no query, fragment,
backslash, controls, malformed escapes or encoded controls/backslashes. Resolution
must preserve the origin. The runtime classifier consumes resolved
`readonly AugmentConfig[]` and rejects known topology/port mismatch; it does not
claim arbitrary custom code honors the operator's declared profile.

## Export manifest and launch binding

The version-1 artifact schema is now concrete:

- Identity: literal valid `agentId`, agent name and canonical selected
  project-relative config path. Export cannot resolve an interpolated identity.
- Hosting: profile, ingress selection and `known-config`/`operator-declared`
  evidence. `auto` cannot claim operator-declared evidence. A `none` profile
  cannot have `http` selection, and conversely for explicit `none`.
- Toolchain: supported Bun version, image identifier and verified multi-architecture
  index digest from the constant. Render `FROM <image>@<imageDigest>`; the exporter
  does not contact a registry to discover a digest.
- Integrity: exact package/lock SHA-256 values, plus separately sorted
  `sourceFiles`, `dependencyTarballs` and `generatedFiles` arrays. Each entry has
  normalized relative path, lowercase 64-digit SHA-256, safe nonnegative byte
  length and ordinary output permission bits (0..0777).

Source files include the unchanged package manifest, text lock and selected
config; dependency archives are in their own array, not duplicated in source.
Generated files contain exactly Dockerfile and entrypoint. The manifest excludes
its own digest. Paths are unique across all arrays; all three arrays share the
same aggregate entry budget. Top-level package/lock hashes must match their
source entries. No absolute source path, secret, environment value, registry
credential or raw diagnostic is serialized. Runtime validation rejects unknown
schema versions and malformed/cross-group duplicate paths.

Root approved `AUGGY_DEPLOYMENT_MANIFEST` as image-set metadata discovery, with
value `/app/auggy-deployment.json` in generated images. Unset preserves ordinary
local startup. Root's host preflight, before provider/augment construction, reads
an ordinary contained file under the selected project with a 4 MiB bound; verifies
immutable identity and selected relative config; then reconciles resolved known
listeners against the profile through the shared classifier. It cannot enable
channels, rewrite YAML, grant proxy trust or select an alternative graph. Source
hashes are build/evidence metadata, not a cryptographic authority or proof of an
executed image. Runtime profile reconciliation does not substitute for the later
installed/container hash and behavior checks.

Preserve the existing `stageBundle` containment/no-follow/inode checks and share
its copier. Portable export adds required-input validation, secret/state exclusions,
contained dependency-tarball inspection, source-snapshot recheck and exclusive
destination publication. The three generated filenames are reserved: existing
source collisions fail. Package and lock bytes remain unchanged. Unknown lock
syntax, escaping dependency sources and unsupported local directory/workspace
dependencies fail; there is no Bun lock writer or unfrozen retry. Actual frozen
image installation remains the authority for manifest/lock semantic compatibility.

Local dependency closure inspection needs a visited canonical-path set and
bounded archive parsing; cycles or repeated references must not cause repeated
unbounded traversal. The implementation must prove resolution with actual Bun
1.3.14 contained-tarball fixtures rather than assuming a nested archive's relative
specifier has the same base as the root manifest. Unsupported resolution is an
actionable refusal, never an absolute-path rewrite or registry fallback.

## Cloud record compatibility

Both persisted versions require immutable identity, Railway provider, project,
service and volume identifiers, and a finite timestamp. Identifiers are strings,
nonempty after trim, at most 256 UTF-8 bytes, and contain no controls/NUL; readers
must not accept truthy numbers or objects as IDs. Do not impose a new UUID-only
rule on historically valid service names. The existing 64 KiB record bound stays.

V1 is read as historical HTTP: port 8080, `/health`, `/console`, with its existing
HTTP(S) origin. URL validation rejects credentials, query, fragment and paths
other than `/`; normalization may use `URL.origin` in the in-memory view but does
not rewrite disk. `NormalizedCloudDeployment.recordVersion` preserves provenance.
A read never stamps v2 onto v1. Explicit successful new deployment writes v2.

V2 has a correlated profile/URL union: worker means `url: null`; HTTP means a
valid origin string, with independent nullable health/console capabilities.
Unknown, unversioned, mismatched-ID or malformed data cannot authorize mutation.
Display-only index reads may retain their existing unreadable-as-absent behavior,
but deploy/remove/console/log target authority must use the rejecting bound reader.
This distinction must be explicit in tests, not hidden behind a type assertion.

Before consumers compile, root updates all `writeCloud`, `setCloud`,
`setCloudForDir`, registration, `readCloud`, `readBoundCloudRecord`, and index
paths together. `writeCloud` currently overwrites every record with `version: 1`;
that must stop. Console/log/CLI formatters must narrow profile and null URL before
constructing links. Existing identity-bound destructive removal stays intact.

## Readiness and processing bounds

Root accepted three extra unverified states because existing programmatic options
can skip checks and platform failure can prevent a probe:

- `platform: unverified` requires `wait-disabled` or `status-unavailable`.
- HTTP `not-checked` means explicit `healthCheck: false`; `not-attempted` means
  platform failure prevented the request. Neither means healthy.
- Worker HTTP is `not-applicable`/`no-ingress`; an HTTP profile without a health
  path is `not-configured`/`no-health-path`. `health` is null when no probe ran.
- HTTP ready/failed/timed-out carries the actual bounded result. Channel remains
  unverified for ordinary deploy regardless of platform or HTTP success.

Defaults are 90 seconds total health, 5 seconds per request and 3 seconds between
attempts; Railway platform wait remains 10 minutes / 5 seconds. Freeze each status
subprocess at 15 seconds and 1 MiB combined captured output, further capped by the
remaining overall deadline. M5-03 must add a cancellation/termination-capable
handle to the real CLI wrapper: its current injected `SpawnHandle` only exposes
`exited` and output streams, so a Promise race alone cannot reap a real hung child.
The status call needs the remaining deadline/abort signal; root's outer harness
owns build/deploy/cleanup budgets. Do not silently weaken these bounds to preserve
an unbounded fake spawn interface.

Health uses a monotonic production clock, safe finite positive durations,
manual redirects (every redirect is not ready), request/body cleanup bounded by
the remaining deadline, and a settling deadline even for a defective never-ending
fetch/sleep. No raw fetch error or response body appears in output. Test delayed
headers, slow bodies, ignored aborts, clock/option errors, failed statuses and
cleanup. Do not interpret HTTP health as authenticated channel execution.

`DEPLOYMENT_LIMITS` carries C2's existing finite values, reusing the authoring
document/metadata/aggregate/diagnostic bounds instead of redefining them. Count
excluded directory roots once and prune their contents. The 10,000 visited-entry
budget includes excluded entries; archive entries have a separate 10,000 total
budget. Source copies and archive inspection keep cumulative byte counts. No new
CLI limit override is exposed in M5.

## Image and storage handoff

Root accepted the separate M5-00 image inspector's evidence: both Linux amd64
and arm64 configurations omit `User` and inherit UID 0/GID 0, verified against
all twelve layers and account files. Root chose to pin the observed multi-architecture
index digest `sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0`
while preserving `oven/bun:1.3.14-alpine`. This binds the manifest and generator
to the inspected image; it is not a toolchain version change. The generator adds
no `USER` directive, recursive ownership mutation or new Docker launch mode and
makes no arbitrary-UID compatibility promise. Root attaches the evidence before
acceptance. Local Docker is unavailable; actual image execution remains a later
Linux CI gate, and fresh Railway mount ownership remains a G4 hosted check.
Export itself performs no network access.

Generic roots remain operator-provisioned; only explicit Railway mode can use
C1/C2's empty, pinned, current-owner advertised-mount first-use initialization.
Root owns that admission and proxy-policy separation. M5-02 owns entrypoint text;
M5-03 requests changes through that owner. Runtime admission may create its own
identity/lock/probe files, but compatibility-state and augment construction wait
for successful admission. Real fresh-volume and replacement tests remain required;
this interface file cannot certify UID compatibility, durability or hosting.
