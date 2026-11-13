# M3-00 project-local launch and installed-path contract

Status: map accepted for M3-00; shared TypeScript declarations and freeze packet govern implementation.
Inspected `feat/inspectable-application` at `e1eadf3`, based on accepted main
`209185d0e7481b4ff5d3b4c87e3447e7583b2fef`. Source references describe that
baseline. The accepted ownership ADR and reconciled M3 execution plan govern
scope. Public host signatures below agree with [host-http-map.md](host-http-map.md).
The CTO owns final shared signatures, manifests, exports, and integration.

## Declaration and application invocation

The opt-in declaration has exactly two fields:

```yaml
application:
  entrypoint: ./src/index.ts
  contractVersion: 1
```

`contractVersion` is an integer execution contract, not the npm version.
`entrypoint` is a nonempty literal relative filesystem path, resolved against the
directory containing the selected `agent.yaml`. Reject absolute paths, URLs,
environment substitutions, missing/non-regular files, and paths whose resolved
real file escapes that project directory. An explicit dependency workspace link
is supported separately; it does not authorize an application entry outside its
project. Reject malformed/unknown application fields rather than ignoring them.
Absence of the block selects the existing legacy program. An invalid present
block must never fall back to legacy startup.

For CLI startup, declaration/path/capability rejection precedes importing the
application, configured providers or augment factories, acquiring runtime claims,
or opening resources. A missing/non-callable named `main` can only be discovered
after importing the entry module; reject it before invoking main or configured
factories. That case cannot truthfully promise zero entry-module evaluation.
The full selected configuration is still compiled and validated once by the
managed host; this small declaration reader is not a second full config parser.

Use the host owner's exact public contract:

```ts
export type ApplicationMain = (launch: ApplicationLaunch) => Promise<void>;

export function runApplication(
  main: ApplicationMain,
  direct: { config: URL; entrypoint: string },
): Promise<void>;

export interface ApplicationLaunch {
  readonly configPath: string;
  readonly mode: "direct" | "foreground" | "launchd" | "railway";
  createHost(options: { compose: AgentComposer }): ManagedApplicationHost;
}
```

`main` creates exactly one host synchronously registered with the runner's
cleanup owner, awaits `host.prepare()`, maps its configured HTTP capabilities
through the application's `configureHttp`, and awaits `host.start({ http })`.
Returning without a ready host, creating two hosts, or throwing after start is a
startup failure. The runner never supplies an invisible automatic `start()`.
Successful main completion returns control to the runner; `runApplication`
remains pending until managed shutdown. No user-owned signal handler is required.

The reference entry ends with this direct-execution guard:

```ts
if (import.meta.main) {
  await runApplication(main, {
    config: new URL("../agent.yaml", import.meta.url),
    entrypoint: import.meta.url,
  });
}
```

CLI import calls the same named main through the same package runner with an
internal validated launch selection. Importing the entry itself must be inert.
Direct ESM execution necessarily evaluates imports before the helper runs; the
helper then verifies the declaration, selected package, and matching entry URL
before invoking main/configured factories or acquiring resources. This is a
supported-code contract, not a sandbox against trusted TypeScript side effects.
The explicit direct config is a file URL; derive project directory from its
canonical path instead of adding another public authority field.

## Declarative package capability metadata

Add this ASCII-only key to the core package manifest:

```json
{
  "auggyRuntime": {
    "schemaVersion": 1,
    "launcherProtocol": 1,
    "applicationContracts": [1]
  },
  "bin": { "auggy": "src/cli/index.ts" },
  "engines": { "bun": ">=1.3.14" }
}
```

The existing `bin.auggy` remains the single CLI entry authority; do not add a
duplicate executable path to the capability object. `engines.bun` remains the
toolchain requirement. The package also declares `./application` in exports;
metadata inspection verifies the selected manifest exposes the required public
entry without executing it. Runtime compatibility is the intersection of the
requested application contract and advertised capabilities, never equality of
the global and local package versions or source-marker strings.

Parse the capability object strictly for schema/protocol 1. Unknown versions,
malformed values, unsupported contracts, a wrong package name, or an invalid
package bin fail with an actionable local dependency diagnostic. Reject bin paths
that escape the selected package real root. npm version and canonical package
path are useful diagnostics; neither is proof that two artifacts are identical.
Metadata is a capability declaration in trusted installed code, not a signature
or permission grant.

For a config without `application`, an explicitly installed older package with
no capability metadata may run its own legacy CLI. The compatibility fixture is
the accepted pre-M3 artifact, not a claim about every historical Auggy release.
A package that advertises malformed/new unsupported metadata fails rather than
being treated as absent metadata. App mode with an older metadata-free local
package fails before entry/factory imports. An older global CLI cannot be
retroactively repaired: document the minimum launcher and recommend the project's
`bun run start` as the authoritative application command.

`checkAgentRuntimeInstall` currently reads a source marker and reports whether a
created installation resembles the invoking CLI (`runtime-install-check.ts:16`;
tests at `tests/cli/runtime-install-check.test.ts:27`). Keep the legacy marker
check available for legacy scaffolds, but never use it as the new application
compatibility predicate. M3 tests must cover equal npm versions with different
metadata/artifacts and different npm versions with compatible contract 1.

## Bootstrap protocol and internal ownership

`src/cli/index.ts:33-54` currently statically imports runtime-bearing commands.
Delegation in `buildCli()` is too late. `resolve-config.ts:15` also imports the
full config parser for `VALID_NAME_RE`. Move location/name/declaration inspection
behind a small runtime-free layer and load command implementations only after
command classification/local selection. Preserve `buildCli()` and its existing
command grammar; share the relevant command/option declarations or test parser
parity rather than maintaining an independently drifting argument parser.

The protocol is sequential:

1. Parse command intent without importing runtime-bearing handlers. Help,
   version, and invalid-argument reporting do not require an agent install.
   Classify narrow recovery commands before attempting project selection.
2. For startup, resolve the config with the existing explicit-config, local
   project, then named-child ordering. Preserve explicit config resolution
   relative to invocation cwd and the name/config disagreement errors. Read
   only non-secret location/declaration metadata at this stage; the bootstrap
   does not load project `.env` or instantiate augment configuration.
3. Require `<project>/package.json` and the explicit
   `<project>/node_modules/auggy` installation. Accept its real directory or an
   explicit symlink/workspace link and resolve its canonical package root.
   Reject ancestor/global fallback, even when generic module resolution could
   find one. Validate package name, bin, capability, application path and Bun
   floor. Provider, Link, and doctor selection retain this same explicit-local
   policy; general hoisted-monorepo support remains outside M3.
4. Compare this process's package real root with the selected package real root.
   If they match, continue with that package's lazy command implementation. If
   they differ, execute the selected package's declared bin with the current
   Bun executable, inherited stdio/environment, preserved cwd, and unchanged
   command options plus an unambiguous canonical config selection. Do not
   install packages, silently use the global runtime, or select by version.
5. A new-protocol child recomputes steps 1-4. A private delegation envelope can
   carry protocol 1, canonical config/package/bin paths and manifest digest as
   a consistency/loop check. If an envelope is present, inconsistent selection
   or another required delegation fails. The child never treats an environment
   marker alone as proof of locality, capability, process identity or admission.
   A matching canonical current-package root is the decisive terminal check.
   One parent-to-local hop is permitted; no child-to-third-package hop is.
6. Only the selected runtime's managed runner imports/calls application main and
   owns runtime lifecycle. Legacy mode invokes the selected runtime's legacy
   program. A tested older CLI receives the existing command grammar; the new
   launcher does not require an older CLI to understand a new public flag.

The envelope is private process plumbing, never application API. Carry no
secrets in it. For a metadata-free legacy child there is no new protocol to
acknowledge; the updated parent makes exactly one handoff to its verified bin
and the historical-artifact fixture proves this supported case. Do not infer
security against arbitrary user-written replacement binaries.

The internal selected-launch record should contain only canonical config,
project, package and bin paths; application path/contract when present; public
mode; browser-opening intent; and private validated installation-generation /
controller admission references where needed. It is not an exported object
callers can construct. The host validates private receipts against actual
claim/generation state; a TypeScript brand, `--internal-mode`, environment value,
or `lifecycleOwned: true` is insufficient. It exposes no raw model, trusted peer,
mutable identity, resource lease, or arbitrary runtime data root to main.

Full configuration parsing retains `loadEnvFile` shell-environment precedence
(`config-parser.ts:53`, `2486`; `config-parser.test.ts:1440`, especially `1465`).
Production delegation preserves the caller's environment/cwd; the isolated test
harness uses a deliberate allowlist. Never log `.env` contents or inherited
credentials as launch evidence. Parent launchers do not parse full configuration
with the global runtime before handing off to the selected runtime.

## Existing command parity and recovery boundaries

| Path | Required implementation and baseline references |
| --- | --- |
| Direct `bun run start` / `bun src/index.ts` | Named main and direct helper above; helper rejects a selected-core mismatch before host/factory creation. ESM import caveat remains explicit. |
| Local/global `run` | Same application runner after selection; preserve default console opening, `--no-open`, optional name and `--config` (`commands/run.ts`; `tests/cli/commands/run.test.ts:24-59`). |
| Local/global `dev` | Same main, mode `foreground` unless validated launchd/Railway context, existing readiness/browser behavior. Preserve generation checks and durable startup/stop order (`commands/dev.ts:200-315`, `385-457`; formatting tests in `tests/cli/commands/dev.test.ts`). |
| `start` | Selected local operator validates declaration/capability before installing or replacing a service. Generate plist using the selected local CLI, current Bun, explicit config, project cwd and new generation. Do not import application in the installer; the managed child does. Preserve lifecycle fence, generation acknowledgement, KeepAlive rollback and retained ownership (`commands/start.ts:69-249`, `plist-generator.ts`; `tests/cli/start.test.ts:61-276`). |
| `restart` | Resolve immutable identity and exact config under the existing lifecycle fence. Preflight local package, declaration and entry file before stopping the old process. This catches inspectable preflight errors, not exceptions inside future main execution. Preserve generation recovery and no same-name adoption (`commands/restart.ts:48-206`; `tests/cli/restart.test.ts:47-238`). |
| `stop` / `status` | Dispatch narrow operator handlers without importing application, local dependencies, providers or the global runtime graph. Missing/broken app entry, local `node_modules`, or config must not prevent immutable-ID recovery. Continue validating process incarnation, generation and replacement manifests; never signal a numeric PID alone (`commands/stop.ts:42-369`, `commands/status.ts:33`; `tests/cli/stop.test.ts:70-354`, `tests/cli/pid-registry.test.ts`). |
| `doctor` | Inspect selected local paths/capabilities and report missing dependencies without invoking main. A missing install is a diagnostic result, not a reason to prevent the doctor command itself from running (`commands/doctor.ts:492-511`; `tests/cli/commands/doctor.test.ts`). |
| Routes / other read-only inspection | Never invoke application main merely to inspect it. Current route inspection still executes configured augment lifecycle code; do not claim static inspection. Preserve that current command contract until M4, with selected-runtime ownership wherever it executes an agent graph. |
| `create` / `init` / unrelated management | Do not require an existing local project. Generalized new scaffolding/migration is M4. Recovery's narrow global code path is not permission for global-runtime startup. |

The installed recovery test must launch an actual child, then remove/rename its
entrypoint and make its local dependencies unavailable before invoking the
updated global `status <immutable-id>` and `stop <immutable-id>`. Assert zero
application/factory sentinel imports during both commands, correct target
incarnation, completed shutdown or truthful retained-ownership diagnostics, and
no deletion of a replacement manifest. Restore fixture files in `finally`.

### Signals and exit propagation

Only the runtime runner registers host SIGINT/SIGTERM handlers. A delegating
parent has a small child-signal forwarder, not its own host cleanup. Relay each
requested signal to the owned child, await its termination, and preserve its
exit code; do not turn a failed child into exit 0. If the child terminates by an
unhandled signal, preserve that termination signal where supported, otherwise
use the platform's conventional `128 + signal` exit status. Test both signals,
startup exit 1, and a nonzero sentinel child exit. Launchd plist points directly
to the selected local CLI, avoiding an extra global proxy as service owner.

Register runner cleanup before `main` and before any managed resource can open.
Host cleanup joins one idempotent operation; signal, startup exception, explicit
stop and process-exit handling cannot race separate disposal paths. The CTO
freezes the runner's signal/startup cleanup observation budget at 15,000 ms:

- Confirmed clean signal-driven shutdown exits 0.
- Startup failure always exits 1, even when cleanup succeeds.
- Cleanup that confirms release but reports settled cleanup failures exits 1.
- Retained/live/unknown cleanup at the deadline forces process exit 1. Do not
  manually remove retained claims or quarantine before termination; durable
  owner records remain for verified dead-incarnation recovery.

Public `host.stop()` does not exit the process. Its default observation deadline
is 15,000 ms; an override must be a positive safe integer at most 900,000 ms.
Repeated/concurrent calls observe the same cleanup task with their own deadlines;
they cannot rerun effects or release unproven ownership. A synchronous `exit`
hook cannot certify asynchronous cleanup or erase retained records. These bounds
observe asynchronous work; they do not preempt a synchronous loop in trusted
application TypeScript.

## Deployment and toolchain parity

The current generated image installs dependencies locally, preserves the optional
lockfile and explicit cloud config, but uses Bun `1.2.14-alpine` and executes
`bunx auggy` (`deploy/dockerfile.ts:10`, `32`, `68`). M3 should pin the image to
`1.3.14-alpine` and execute the verified installed local CLI directly, e.g.
`exec bun /app/node_modules/.bin/auggy dev "$1" --config /app/agent.yaml --internal-mode railway`.
Validate the installed `auggy` package/bin association; a missing bin must fail
instead of allowing `bunx` to download another package. Preserve positional name,
`--config`, internal mode, exact `/app/data` mount checks, private modes, Link's
existing compatibility symlink, and direct core SQLite paths. This changes no
hosted deployment infrastructure or secret-push authorization.

`commands/deploy.ts:178-237` currently discovers a nearby
`auggy-${getAuggyVersion()}.tgz` and can replace a semver dependency by filename.
That can substitute a different artifact with the same version. The agreed
narrow M3 correction is to retain explicit `file:` tarball rebasing and secure
copy boundaries, but stop opportunistic nearby-tarball substitution. Ordinary
deploy uses the project's declared dependency/lock selection; explicit tarball
deploy uses that declared artifact. A linked development tree is not a deployable
tarball: fail with guidance to pack/materialize it, without silently substituting
a nearby file or publishing anything. Update tests at `tests/cli/deploy.test.ts:1831`
for the intentional behavior change, retain secure-copy coverage at `1866`, and
preserve explicit `file:` coverage at `1886`.

Align `engines.bun` to `>=1.3.14` in core and the four providers plus evals. All
six are the currently published/tested package family; continuing a lower
support claim for one requires a separate certification matrix. Keep their
package versions unchanged in M3. CI and core `packageManager` already pin
1.3.14. Root alone edits manifests/lock; the CLI owner edits Docker generator
and its exact-version fixture (`tests/cli/deploy/dockerfile.test.ts:5`). Add a
manifest-floor parity assertion, require the floor in the new reference app,
and cover an injected older Bun version in the pure preflight unit tests.
Do not execute a known-unsupported Bun binary to claim runtime certification.
Historical retained-lock fixture manifests/locks remain historical evidence;
do not rewrite them to make new-policy checks pass. Unrelated example migrations
and the independent Temporal graph remain outside this manifest change.

## Installed-path assertion matrix

Every runtime row uses the packed core/provider artifacts in a temporary consumer
outside repository/ancestor dependency resolution. Keep workspace-link tests as
separate development-policy evidence. Use the existing real adapter plus local
HTTP provider fixture; do not substitute a mock kernel, source import, fabricated
runtime output, or test-only environment path into the repository.

| ID / acceptance | Concrete assertion | Required evidence |
| --- | --- | --- |
| L01 / A01 | Direct start, local CLI `run`/`dev`, and updated global CLI all execute the same project main, host and selected local core. | Canonical selected paths, packed hashes, real request/result and main invocation count; each path run independently. |
| L02 / A01,A13 | Edit installed project's `index.ts` startup marker, with unchanged YAML/dependencies. | Changed marker appears once in the actual launched child for each supported launch path; no copied dummy main. |
| L03 / A02 | Edit `http.ts` to wrap the real managed handler with a harmless response header. | Authenticated request has header; unauthenticated request remains rejected with zero model/tool calls. |
| L04 / A03,A04 | Execute real local tool and change only `turn.ts` ceiling from two managed inferences to one. | Adapter request counts, tool count, terminal reason, accounting/history evidence and unchanged dependency hashes. |
| L05 / A10 | Missing explicit core, ancestor-only core, malformed/unsupported capability, invalid app block/path, incompatible app contract or older Bun. | Actionable rejection with zero entry/factory sentinel imports, claims, listeners and provider calls. Missing named main is separately labeled post-module-import rejection. |
| L06 / A10 | Explicit local workspace symlink accepted; ancestor-only workspace package rejected; provider and Link obey the same policy. | Canonical linked paths and correct selection; this row never counts as packed artifact proof. |
| L07 / A01,A10 | Global A and local B have equal npm version but distinct packed hashes; another pair has differing versions with compatible contract. | Local B code actually executes; version inequality does not reject compatible metadata. Same-version artifacts are test fixtures, not published releases. |
| L08 / A10 | Corrupt/forged/inherited delegation envelope and selected-package replacement between parent and child. | Recomputed selection rejects inconsistent state; no second hop and no ownership granted by marker. |
| L09 / A11 | Updated global launcher runs accepted older local legacy artifact, absent app block. Same artifact with app block rejects. | Historical artifact hash, legacy real request, one handoff, and zero app imports in rejected case. |
| L10 / A09,A11 | Actual app startup throws during prepare/after start; SIGINT and SIGTERM; child nonzero/signal exit. | Bounded shutdown, exit propagation, no duplicate cleanup, truthful release/retention and next-start behavior. |
| L11 / A11 | Break entrypoint and local install after actual boot; run global status and stop by immutable ID; preflight a broken restart. | Recovery import sentinels remain absent; matching incarnation only; rejected restart leaves old process untouched; replacement manifest safety. |
| L12 / A11 | Actual macOS launchd start, ready acknowledgement, restart and stop of isolated fixture. | Installed plist/bin/config/generation, child PID and main marker, actual HTTP request, verified unload/cleanup. Injected launchctl unit tests alone do not satisfy this row. |
| L13 / A11 | Generated Linux Docker/entrypoint retains volume guards, local CLI, current Bun floor, source files and dependency selection. | Exact generated files plus unit tests; if container execution is unavailable, record it as unavailable. No hosted Railway deployment claim. |
| L14 / A11 | Deploy semver project with unrelated nearby same-version tarball; then explicit `file:` tarball case. | Nearby artifact never replaces declared selection; explicit artifact bytes/hash copied and reference rebased; secrets/state still excluded. |
| L15 / A01,A11 | Explicit `--config`, wrong cwd/name, optional name, shell-over-.env precedence, browser flags and launch modes. | Child receives intended canonical project, preserved options, dummy environment value outcome and correct ready callback; no secret-bearing logs. |
| L16 / A12 | Existing retained-lock upgrade and real Link traffic on final candidate. | Unchanged historical fixture hashes and final graph/audit/install evidence; new launch support does not replace foundation gates. |

For L12, use a unique immutable ID, isolated project/data/control state, ephemeral
listener and deterministic provider. Record the actual launchctl domain and the
minimal real user's LaunchAgents location needed by macOS, and remove only that
fixture's label/plist. Never touch an existing agent service. A sandbox/OS refusal
is an unavailable gate, not a passed mock equivalent. Linux CI can validate the
generated plist and existing injected controller cases; it cannot certify macOS
launchd. Similarly, generated Docker text is not an executed image or hosted
Railway service.

Reuse isolation, output redaction, provider counters and timeout/cleanup patterns
from `scripts/release-smoke/packed-turn.ts:98`, `packed-link.ts:109`, and
`upgrade-consumer.ts:449`. Record scenario command, cwd, mode, platform, Bun
version, exit/signal, package/lock/source hashes, bounded logs, request/turn IDs,
counts and cleanup outcome. Use dummy secrets and allowlisted environment. Keep
the accepted 60 s readiness, 120 s scenario and 15 s shutdown bounds; cleanup
failures remain failures. No fixed provider ports, live credentials or external
model services belong in these deterministic rows.

## Implementation seams and ownership

M3-03 owns a minimal bootstrap/selection module, its tests, launch command
integration and deployment parity changes. Reuse config-location and local
dependency policy rather than implementing another resolver. Preserve source
regressions in `tests/cli/resolve-config.test.ts:21-83`,
`import-from-agent.test.ts:105-272`, start/restart/stop/PID registry suites,
and the config `.env` tests. Add explicit workspace-link coverage, which the
current importer tests do not supply. Update runtime-install/doctor diagnostics
with capability checks instead of global/local semver or marker equality.

M3-05 owns the new packed reference runner and scenario fixtures. Extend the
current release harness; do not replace packed turn/Link/upgrade gates or add a
parallel documentation-only harness. M3-04 owns the independently typechecked
reference app with its direct start script and source-edit points. The host owner
owns runner cleanup semantics and opaque launch-admission validation; this map
does not create a second host or HTTP entry protocol.

Root serializes edits to `src/cli/index.ts`, shared config/name types,
`commands/dev.ts`, public types/exports, package metadata/manifests/lock,
tracked-test inventory, CI and the release-smoke shell. CLI and host owners must
agree the internal selection/receipt interface before touching their common
boundary. No dependency install, version bump, release, runtime edit or service
launch was performed to produce this contract map.
