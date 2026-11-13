# M5 C2 — portable deployment contract

Status: **draft for root and independent review; not an accepted producer
contract**. Preparation only. G0 is accepted; M5-00 contract freeze remains
pending. Do not interpret this document as approval for hosted
resource creation or release producers before those gates.

Source inspected: M4 `32d7265d0659d5911755e802d18a9f9077b80196`.
Draft worktree base: main `911fe1682c76208c1d99d4dc6841bfcaa608dd8d`.
Rebased onto merged M4 main `c39b746b4b743e5c29dab61a677026c10626d8b8`, including
reviewed collision repair `56de4e3`; its deployment interfaces are unchanged.
The root-owned execution/evidence documents determine gate disposition.

## 1. Ownership and product boundary

Each company owns an independently installed agent project, deployment,
immutable agent identity, credentials and durable state. The deployable unit
is the agent. HTTP/AG-UI, Telegram polling, Telegram webhooks and future
channels describe ways to communicate with it. An application such as Next.js
is an optional consumer. This contract creates no shared-company backend,
tenant provisioning service or new worker runtime.

Project `index.ts`, `agent.ts`, enabled Central YAML and custom augment source
remain project-owned. The image executes that application through its locally
installed Auggy CLI and the existing foreground launch path. It must not
substitute a generated runtime, copy package internals into owned source, or
resolve a missing local runtime from a global install or a package runner.

Storage admission, identity/singleton/restore checks, and external-assertion
replay are governed by C1. This contract consumes that admission before
listeners, polling, factories with effects, or database initialization. It
does not add a Docker runtime mode or weaken single-replica SQLite semantics.

## 2. CLI and public behavior

```text
auggy export docker [name] --config <path> --out <new-directory>
  [--ingress auto|none|http] [--port <integer>] [--health-path <path>]

auggy deploy [name] --to railway
  [--ingress auto|none|http] [--port <integer>] [--health-path <path>]
```

Existing deployment selection flags remain supported. Export `--config` is
optional when the existing passive project-selection rules select a document;
it is shown above to make explicit selection discoverable. `--out` is required.
Default ingress is `auto`. Unknown flags, duplicate conflicting flags, malformed
numbers and ambiguous selections fail before staging or external effects.

Export uses M4 `selectInspectionDocument` and bounded raw document reads.
Explicit config selection wins under that existing contract. It never runs
effective config expansion, reads `.env`, imports project/runtime factories,
calls `doctor`, starts a child process, contacts a registry, installs packages,
starts Docker, or calls a hosting API. It emits controlled diagnostics with
relative paths and option names, never raw YAML, dependency credentials or
environment values. Deployment may resolve secrets through its existing
execution path after passive checks; that is a separate operation.

Output is a new build-context directory. Export refuses an existing destination,
including an empty directory or symlink. There is no `--force` in M5. Refuse a
destination that aliases, contains, or is contained by the selected project;
do not recursively copy the output into itself. A failure removes only temporary
or destination files exclusively created by that invocation. Source files,
ownership receipts, manifest and lock bytes never change.

## 3. CLI-private interfaces

These are concrete producer seams, not public runtime API. Root accepts names
before producers start; equivalent internals may be changed only through a
recorded contract amendment. Shared public/runtime types remain root-owned.

```ts
type IngressSelection = "auto" | "none" | "http";

type DeploymentProfile =
  | { kind: "none" }
  | {
      kind: "http";
      port: number;
      healthPath: string | null;
      consolePath: "/console" | null;
    };

interface ProfileSelection {
  ingress: IngressSelection;
  port?: number;
  healthPath?: string;
}

interface ResolvedDeploymentProfile {
  profile: DeploymentProfile;
  selection: IngressSelection;
  evidence: "known-config" | "operator-declared";
  // Bounded, non-secret diagnostics; no raw document/options.
  diagnostics: readonly { code: string; message: string }[];
}

function resolveDeploymentProfile(
  document: AuthoringDocument,
  selection: ProfileSelection,
): ResolvedDeploymentProfile;

interface StageBundleOptions {
  agentDir: string;
  agentName: string;
  excludedPaths?: readonly string[];
}

interface ExportDockerOptions extends ProfileSelection {
  name?: string;
  config?: string;
  cwd?: string;
  out: string;
}

interface ExportDockerResult {
  outputDir: string;
  profile: DeploymentProfile;
  manifestPath: string;
  fileCount: number;
  sourceBytes: number;
  buildVerified: false;
}
```

Keep the existing `stageBundle(options): string` compatibility seam for Railway;
it gains common finite staging bounds. Export's additional dependency-closure
and publication checks belong to a CLI-local export module. Avoid a second
parallel tree copier. Expose dependency injection only at narrow filesystem,
clock/fetch and Railway adapter boundaries; never make production purity depend
on a caller remembering to pass a no-op installer.

## 4. Profile resolution

Profiles describe an existing listener requirement, not which channels are
enabled. They never mutate YAML or enable a web transport.

| Selected configuration | `auto` result |
| --- | --- |
| Known augments with no listener; Telegram polling allowed | `none` |
| One `webTransport` with a literal valid port | HTTP with that port, `/health`, and `/console` only when `adminRoute` is known enabled |
| One Telegram webhook listener | HTTP on its configured port, default 8081; no inferred health or console |
| One built-in Link listener | HTTP on its configured port, default 8081; no inferred health or console |
| HTTP listener plus Telegram polling | The HTTP profile |
| Multiple known listeners, including Link/webhook beside webTransport | Refuse the ambiguous public topology, even when ports happen to match |
| Custom/unknown declarations or unresolved values affecting ingress | Require explicit selection |

Maintain an explicit data-only classification for every known built-in type.
Adding a type does not make it worker-safe by default. Link's existing factory
creates a listener; an outbound usage label alone must not hide that listener.
Telegram webhook and Link profiles are compatibility behavior, not M5 hosted
certification rows. Custom hosting can support other topologies outside this
single-public-listener exporter. Do not import factories to classify them.

`none` rejects `--port` and `--health-path`, and rejects any known HTTP listener.
For unknown/custom declarations, explicit `none` is the operator's assertion
that the application does not need public ingress. Record that declaration;
do not claim passive source inspection proves arbitrary code opens no socket.

Explicit `http` uses a known single listener's port or requires `--port` when
the listener is custom/unresolved. An explicit port conflicting with any known
listener fails. A known multiple-listener topology fails even with an explicit
selection; a single `--port` does not explain routing for the other listener.
Port must be an integer 1–65535. `--port` in `auto` may confirm a known HTTP
port; it cannot silently turn a known worker into HTTP or resolve unknown code.

For a known web transport, omitted health path means `/health`; an explicit
path may select another existing unauthenticated readiness endpoint. For
custom HTTP, Link and Telegram webhook, omitted health path means `null`,
not an invented `/health`. `--health-path` is invalid without an HTTP profile.
Health paths must have exactly one leading slash, be at most 2,048 UTF-8 bytes,
and contain no backslash, control character, query or fragment. URL resolution
must preserve the deployment origin. Never accept a full URL or scheme-relative
URL. Reject malformed percent escapes and encoded control/backslash characters.

Console presence is a separate observed capability. Known `webTransport`
`adminRoute` omitted/true permits `/console`; false or unresolved yields null.
Custom HTTP does not advertise a console simply because it serves HTTP.
No new console-presence flag is needed for M5.

Unresolved environment expressions are not secretly evaluated during export.
An explicit HTTP port is an operator assertion, not a config override. Before
Railway effects, effective config must reconcile resolved known listeners with
that assertion. At container launch, shared runtime preflight must likewise
reject any known resolved listener/profile mismatch before opening listeners.
The image sets `PORT` for hosting convention only; a literal YAML port is not
rewritten. Arbitrary custom code remains responsible for honoring its declared
profile; actual runtime acceptance is the evidence for that responsibility.

## 5. Build-context contents and dependency closure

Export writes these reserved generated files:

```text
<out>/
  Dockerfile
  auggy-entrypoint.sh
  auggy-deployment.json
  package.json                 # identical source bytes
  bun.lock                     # identical source bytes; required
  <selected config and application source at original relative paths>
  <project-contained relative dependency tarballs at original paths>
```

Refuse a source collision with a generated reserved file rather than silently
overwriting user files. Preserve the selected config's project-relative path;
do not assume its filename is always `agent.yaml`. JSON/exec-array or correctly
escaped shell construction must keep agent name and paths as data. Do not
interpolate them into executable shell fragments.

The existing secret/state exclusions remain the minimum: `.env` and private
`.env.*` except `.env.example`, `.git`, `.worktrees`, `.auggy`, `node_modules`,
runtime data/workspace roots, cloud metadata, ownership/mutation receipts,
database files and WAL/SHM/journal siblings, CLI auth/session state, checkout
links and temporary files. Exclude bounded raw-config-declared durable paths
when safely statically resolvable. If an unresolved declared durable path could
put private state into the source tree, fail with an actionable diagnostic;
do not evaluate its environment value to make export appear pure. An approved
producer inventory must cover every built-in durable-path declaration.

Do not copy secrets embedded in custom filenames by claiming a generic file
filter detects all secrets. Documentation states that project source and
`.env.example` are the operator's responsibility. Never copy `.env.example`
values into metadata or logs. Required config/source/dependency inputs that
would be excluded produce a failure, not a success with a broken image.

Only ordinary contained directories and regular files are supported. Skip
unreferenced symlinks/special files using the existing staging policy; fail
when one is a required config, source entry, manifest, lock or dependency.
Containment uses normalized lexical paths and realpath/lstat checks, not
string-prefix checks. Relative paths are normalized to portable slash form.
Preserve the existing `O_NOFOLLOW`, inode and before/after file checks. This is
an owned-local-tree boundary, not a guarantee against a malicious same-user
process concurrently replacing ancestor directories. Do not expand that claim.

Dependency rules apply to dependencies, dev/optional dependencies, overrides,
resolutions and recursively referenced local tarball dependencies that can
enter the install graph. Ordinary peer dependency range declarations remain
declarations; a file dependency used to satisfy them is still checked.

- Require regular UTF-8 `package.json` and text `bun.lock`; missing/binary-only
  lock fails with a local-install instruction. Require locally declared `auggy`.
- Registry dependency metadata and lock bytes remain unchanged. Reject
  dependency URLs containing credentials, workspace/link dependencies, local
  directory dependencies, Git/remote archive sources outside the certified
  registry/file-tarball profile, and absolute or escaping `file:` paths.
- Admit ordinary `file:./relative.tgz` dependencies only when their complete
  local closure is inside the selected project. Copy each unchanged at its
  original path, record SHA-256, and bound archive inspection. Never extract
  an archive into source/staging to discover metadata. Reject unsafe archive
  paths, links and duplicate/ambiguous package manifests during inspection.
- Require any local file reference in the lock to correspond to admitted,
  contained ordinary tarballs. Do not build a custom Bun lockfile writer or
  claim static graph inspection proves lock freshness. Use a versioned reader
  only for supported syntax; unknown constructs fail clearly.
- The image copies the manifest, lock and admitted tarballs before install,
  then runs `bun install --frozen-lockfile`. It never retries unfrozen or
  silently falls back to registry packages. The actual frozen image build
  decides manifest/lock semantic compatibility and dependency integrity.

`auggy-deployment.json` has `version: 1`, immutable `agentId`, agent name,
relative config path, resolved profile and selection evidence, pinned Bun
image/toolchain identifier, SHA-256 of manifest and lock, and sorted relative
source/tarball file hashes. It contains no absolute checkout paths, secret
values, environment values, cloud credentials or registry tokens. It is
descriptive build input, not a signature or an assertion that the image ran.
The manifest excludes its own hash and identifies generated file hashes
separately from unmodified source hashes. Unknown versions fail closed at
consumption. Actual image digest belongs in acceptance/deploy evidence later.

Stage in an invocation-owned private temporary directory and publish only
after all validation/writes succeed. Destination acquisition must be exclusive;
do not rely on a check-then-overwriting rename. On races/collisions, preserve
the other writer's files. Check source snapshots again before publication so
a changed manifest/config/tarball does not get a misleading source hash.

## 6. Finite processing limits

Defaults below are draft frozen values for review. Do not expose arbitrary CLI
limit overrides in M5. Count entries/bytes before allocating or copying them;
stream regular files and tar archives with cumulative counters. Over-budget
input fails with an actionable controlled diagnostic and owned cleanup.

| Resource | Maximum |
| --- | --- |
| Raw YAML document, metadata, aggregate inputs | Existing M4 `AUTHORING_LIMITS` (1 MiB / 256 KiB / 8 MiB) |
| Package manifest / lock | 1 MiB / 16 MiB |
| Path / directory depth | 1,024 UTF-8 bytes / 64 levels |
| File/directory entries visited | 10,000, including excluded entries |
| One regular file or compressed dependency tarball | 256 MiB |
| Staged source bytes, cumulative | 1 GiB |
| Decompressed archive bytes inspected | 512 MiB per archive, 1 GiB cumulative |
| Tar entries inspected | 10,000 cumulative |
| Dependency archive package manifest | 1 MiB |
| Generated deployment manifest | 4 MiB |
| Cloud record | Existing 64 KiB |
| Health path / controlled error text | 2,048 / 1,024 UTF-8 bytes |

Do not recurse into excluded roots to count their contents. Count their root
entry, then prune. A lock or tarball larger than these limits needs an explicit
contract revision; the exporter must not silently truncate or certify it.

## 7. Image launch and lifecycle

Pin the current supported Bun image (`oven/bun:1.3.14-alpine`) until root records
an intentional toolchain change. Use frozen install for the portable path.
The inspected generator has no `USER` override; the effective inherited UID
has **not** been verified from the base image configuration in preparation.
M5-00 must record a bounded read-only image configuration inspection and the
actual baseline UID/GID before changing the generator. Preserve that exact
behavior; do not assume root from the absence of a Dockerfile `USER` command.
Arbitrary-UID compatibility and a new unprivileged-user migration are not M5
promises. Document expected volume ownership and private modes instead of
recursively chowning unknown volumes.

Generated entrypoint selects the locally installed `auggy` package's declared
ordinary executable, verifies package identity and containment, then `exec`s
the existing foreground launch. SIGTERM reaches that process; normal runtime
cleanup closes transports, polling, managed databases and ownership handles.
No background daemon, extra supervisor, HTTP probe server or invisible global
runtime is introduced. Missing local runtime fails without installation.

The image declares `AUGGY_DATA_DIR=/app/data`, and startup requires an already
existing admitted durable root. Do not add Dockerfile `VOLUME` or create the
root as a workaround: neither proves durable storage. Unset behavior outside
the generated image remains the existing local-development behavior. A worker
image has no `EXPOSE`, `PORT`, public URL, HTTP probe or console announcement.
An HTTP image exposes only its declared port. No Docker `HEALTHCHECK` is
generated for a profile without an actual health path.

Generic Docker startup does not require Railway variables. The Railway adapter
adds its existing advertised-volume check: `RAILWAY_VOLUME_MOUNT_PATH` must be
`/app/data`, that directory must exist safely, and conflicting `AUGGY_DATA_DIR`
fails. Storage pathname equality must not select Railway trusted-proxy policy;
root threads the explicit platform policy through the existing resolver.

Root's reviewed first-use disposition separates provisioning from C1 admission.
Generic Docker/local roots are operator-provisioned with expected ownership and
0700 permissions; their startup never changes an unsafe root into an admitted one.
For the explicit Railway launch only, retain a narrow initialization step for a
fresh advertised mount. Verify the existing `/app/data` directory's physical
identity, current-owner UID and absence of symlinks; pin its descriptor and
inspect emptiness with a finite entry bound. Only an empty directory may have
its own mode narrowed to 0700 through descriptor-based `fchmod`. Recheck identity
and emptiness before creating any state. No mount creation, recursive chmod,
chown, permission repair of unexpected contents, or subdirectory/link mutation
belongs in this step. A nonempty existing root must already satisfy C1's private
ownership, identity and restore-fence rules. If a new platform mount contains
metadata, fail with an explicit operator preparation remedy rather than broaden
the definition of empty. Confirm actual UID/mode behavior at M5-00 and A13.

Then run common runtime admission and acquire its lease before augment or
compatibility-state creation. Admission itself retains its identity/lock/probe
control-file operations.
Test a fresh default-mode volume as well as reused admitted state; nonempty
unsafe, wrong-owner and symlink roots must fail. Do not precondition every fixture
to 0700 and claim first deployment works. Root owns admission integration;
M5-02/03 propose the bounded bootstrap and M5-07 independently verifies it.

Retain explicit Link compatibility-state handling where still needed;
new core state uses C1 admission directly. Runtime-owned state and restore
fences must pass before compatibility directory/symlink mutation or listeners.

## 8. Railway adaptation and compatibility path

Railway consumes the same profile resolution, staging exclusion/bounds, image
generation and runtime launch contracts. It retains secret transfer through
the existing secure adapter, immutable identity binding, saved-target checks,
volume reuse, deployment status inspection and invocation-owned cleanup.

The existing explicit external Auggy tarball development/deploy path remains
available with a visible diagnostic: **Railway compatibility packaging; outside
portable frozen-build certification**. Its staged manifest materialization and
install behavior must not mutate source or be represented as the portable
export result. It must never select a nearby unrelated tarball. Do not remove
it merely to make portable tests pass, and do not create a second preparation
CLI to maintain it. Ordinary relative contained tarballs use the portable path.

For HTTP: use the selected listener port, request/reuse the intended domain,
and set `AUGGY_PUBLIC_URL` only after obtaining that origin. Keep external
authentication/console origins explicit under their existing policy. HTTP
does not prove that `/console` or `/health` exists.

For none: do not request/reuse a public domain or set/inject `PORT`,
`AUGGY_PUBLIC_URL` or healthcheck paths. Write `url: null`. Do not start an HTTP
server to improve platform visibility. A saved HTTP target or a selected
existing target with domains/HTTP variables is a profile conflict, requiring
explicit operator reconfiguration or a new target before deploy; never delete
the domain or variables silently. Provider-supplied variables that cannot be
removed must be distinguished from Auggy-injected configuration and must not
cause a listener to be created.

Before remote mutation, reconcile passive and effective known listener
requirements, requested profile, saved identity/target, actual target ingress
metadata, and required storage. `--yes` is not permission to erase unrelated
target ingress. New worker-to-HTTP deployment may create ingress when explicitly
selected, while preserving the target/identity checks. Document platform volume
redeploy downtime; never promise uninterrupted single-replica redeploys.

## 9. Cloud-record v2 and every reader/writer

The durable file remains `.auggy-cloud.json`, private and identity-bound.
Canonical v2 schema:

```ts
interface CloudRecordV2 {
  version: 2;
  agentId: string;
  provider: "railway";
  projectId: string;
  serviceId: string;
  volumeId: string;
  deployedAt: string;
  profile: DeploymentProfile;
  url: string | null;
}

// Existing valid version-1 record remains accepted without disk rewrite.
// version: 1; agentId; provider; IDs; deployedAt; url: nonempty HTTP(S) origin.
type CloudRecord = CloudRecordV1 | CloudRecordV2 | null;
```

Validate safe nonempty IDs, valid immutable agentId, finite timestamp and
profile schema. `none` requires null URL; HTTP requires a valid HTTP(S) origin
without userinfo, query or fragment. Unknown/malformed versions, mismatched
identity, incompatible profile/URL, and unversioned legacy metadata remain
fail-closed for cloud operations. Do not weaken existing refusal by treating
invalid saved metadata as a new target.

Read v1 as the legacy HTTP deployment contract (port 8080, `/health`, historical
console behavior). Do not rewrite it on reads. A successful explicit new
deployment writes v2; metadata is not evidence that a channel turn occurred.
All writers must preserve the specified version instead of hardcoding v1.

| Existing owner | Required change |
| --- | --- |
| `src/cli/types.ts` | Versioned union and nullable URL; root integrates |
| `src/cli/agent-index.ts` `readCloud`, `readBoundCloudRecord` | Shared bounded shape validation; v1/v2 reads; malformed records cannot become mutation authority |
| `agent-index.ts` `writeCloud`, `setCloud`, `setCloudForDir`, registration with `opts.cloud` | Stop stamping v1 over v2; bind identity and validate before durable write |
| `src/cli/commands/deploy.ts` | Profile-aware preflight, mutation/result, successful v2 write and redeploy transition checks |
| `src/cli/commands/console.ts` | Worker or HTTP-without-console gives actionable unavailable result; never constructs null URL or starts a server |
| `src/cli/commands/logs.ts` | Dashboard/log access by target IDs; omit public URL when absent, explain worker profile |
| `src/cli/commands/remove.ts` | Continue identity-bound destructive target selection with both versions |
| `src/cli/cli-program.ts` | Export/deploy flags; result/help/status/target presentation; print console/login instructions only when capability exists |
| List/status/index JSON and any new consumer | Preserve profile and null URL, do not fabricate endpoint or assume a cloud record implies HTTP |

Audit call sites again after G0, including fixtures and command output snapshots.
Direct string substitutions of `cloud.url` are insufficient. Existing remove
authorization, saved target prompts and malformed-record handling remain intact.

## 10. Platform readiness, HTTP readiness and channel evidence

Keep three separate observations in deployment output/evidence:

```ts
interface DeploymentReadiness {
  platform: "ready" | "failed" | "timed-out";
  http:
    | { state: "not-applicable" | "not-configured" }
    | { state: "ready" | "failed" | "timed-out"; result: HealthCheckResult };
  channel: { state: "unverified" };
}
```

Ordinary deploy does not assert a business-channel turn. A worker may report
platform-ready and channel-unverified. An HTTP success means only that its
configured readiness endpoint answered. A failed configured readiness check
must not be formatted as a fully healthy deployment. Actual HTTP/AG-UI or
polling request, authenticated execution, tool effect and correlated reply
belong to acceptance with explicit observed IDs/markers.

Extend `HealthCheckOptions` with `healthPath` and `requestTimeoutMs`; preserve
the narrow fetch/sleep/clock seam. Defaults: total 90 seconds, request 5 seconds,
interval 3 seconds. Validate finite positive options and safe deadline math.
Use a monotonic production clock; cap each request and sleep to the remaining
overall budget. The overall timer covers DNS/connect/headers and cleanup, not
just time between requests. Abort outstanding fetches on timeout and settle
the waiter even if an injected/defective fetch never resolves. Clear timers,
consume/cancel response resources without waiting on unbounded bodies, and
never log response bodies or credentials. Bound cleanup within the deadline.

Set `redirect: "manual"`; any redirect is not ready. Never follow a redirect
outside the deployment origin. This stricter no-follow policy avoids credential
forwarding and hidden readiness on an unrelated site. Test a never-resolving
fetch, delayed headers, slow body, cross-origin redirect, repeated failure,
clock/option invalidity, success and resource cleanup.

Retain Railway's existing 10-minute platform wait default, but bound each CLI
status subprocess and its output as well as the overall wait. Poll loops must
not be called bounded merely because a deadline is checked after an unbounded
child. Root/acceptance owns whole build/deploy/cleanup budgets and external
resource authorization.

## 11. Exclusive implementation file assignments proposed for root

Assignments are proposals until root freezes them. No shared-file edits by a
producer without root assigning that exact file. Focused test files follow
their source owner; integrated harness/CI/fixtures stay root-coordinated.

| Work package | Exclusive source scope | Focused test scope |
| --- | --- | --- |
| M5-02 packaging | New `src/cli/deploy/profile.ts`, `portable-export.ts`; new `src/cli/commands/export.ts`; existing `src/cli/deploy/bundle.ts`, `dockerfile.ts` | `tests/cli/deploy/bundle.test.ts`, `dockerfile.test.ts`; new profile/export tests |
| M5-03 Railway | `src/cli/commands/deploy.ts`, `console.ts`, `logs.ts`; `src/cli/deploy/health.ts`, `railway-cli.ts`, `secrets.ts` only if needed | `tests/cli/deploy.test.ts`, `tests/cli/commands/console.test.ts`, `logs.test.ts`, deploy health/Railway/secrets tests |
| Root shared integration | `src/cli/types.ts`, `agent-index.ts`, `cli-program.ts`, CLI/bootstrap/dispatch; config/parser/resolver and launch seams; `src/cli/commands/remove.ts`; all public runtime types | Agent-index/CLI dispatch/formatting/config/shared lifecycle contract tests |
| M5-01 storage + root integration | C1-owned storage modules; proposes runtime admission/entrypoint changes to owning producer/root | C1 launch/storage acceptance |
| M5-07 acceptance | Dedicated new container/hosted harness modules after root assigns paths | Installed, container and hosted rows; no producer self-certification |

Packaging owns generated entrypoint text, while runtime/storage owns admission
semantics. Railway requests generator/profile changes from packaging rather
than editing those files concurrently. Shared `CloudRecord` and CLI formatter
changes land sequentially through root before consumers compile against them.
Package manifests, lockfiles, CI, release/version changes, contract/ledger/status
documents and global harness files are never implicitly delegated.

## 12. Required evidence and root review decisions

Acceptance must falsify: output overwrite/source mutation, environment or
factory execution during export, credentials/state in image context, escaping
tarballs/symlinks, oversized archives, stale-lock fallback, dynamic-port
mismatch, worker HTTP/domain creation, ambiguous listeners, malformed/other-agent
cloud metadata, lost v1 reader behavior, hanging health/subprocess work, and
false channel-ready claims. Record exact source/installed package/context/image
hashes. Test real image builds and replacement with durable state, not generated
Dockerfile strings alone. Generic Docker and actual Railway acceptance are
separate rows; hosted execution requires its own explicit target/spend/cleanup
authorization.

Before G1, root/independent reviewer must explicitly accept or amend:

1. Link and Telegram webhook listener classification and refusal of multiple
   known listeners; neither compatibility profile gains certified-hosting status.
2. Artifact filenames/schema, collision behavior and finite bounds above.
3. The conservative registry/contained-tarball dependency profile and bounded
   local-closure reader; actual frozen install remains dependency authority.
4. `consolePath` capability independent of HTTP, v1 normalization and every
   format writer/reader change.
5. Shared launch reconciliation for unresolved known listener settings and
   operator-declared custom profiles, without importing code during export.
6. Exclusive producer file scopes and the root-owned shared integration queue.

This draft does not certify an implementation, amend main, authorize publication,
or satisfy any installed/container/hosted acceptance row.
