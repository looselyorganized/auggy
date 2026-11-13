# C2 — explicit migration and recoverable publication

Proposed contract for the [M4 execution plan](../milestone-4-execution-2026-11-13.md).
This is a bounded authoring migration, not a runtime-state or arbitrary code
migration framework. It uses accepted main semantics, never an experiment tree.

## Commands and scope

```sh
auggy migrate [name] --config <path>                       # preview, no writes
auggy migrate [name] --config <path> --apply               # config-only conversion
auggy migrate [name] --config <path> --application         # adoption preview
auggy migrate [name] --config <path> --application --apply # explicit application adoption
auggy migrate [name] --config <path> --rollback <id>       # rollback preview
auggy migrate [name] --config <path> --rollback <id> --apply
auggy migrate --project-dir <dir> --rollback <id>         # recovery without agent.yaml
auggy migrate --project-dir <dir> --rollback <id> --apply
```

Name/config selection follows existing conventions; omit either selector when
using `./agent.yaml`. Rollback and application flags cannot be combined. Invalid
flags fail before reads/writes. Preview exits 0 for a valid supported plan/no-op,
1 for unsupported/conflicting input; CLI syntax errors use the established error
convention. No prompts, package installs, app boot, provider calls or secrets in
output. `--apply` recomputes and revalidates a current plan; it does not blindly
trust a previous preview. Print a plan fingerprint so changes are visible.

`--project-dir` is rollback-only and mutually exclusive with name, `--config`
and `--application`. It resolves a canonical directory and validates its private
receipt directly, without requiring `agent.yaml` to exist or parse. This is the
recovery path for interrupted `init` before central YAML was created, and for
truthful conflict reporting when an operator changed/deleted that file. Never
bypass receipt identity, containment, preimage/output or ownership checks. The
same rollback handler supports recorded init/custom-authoring operations; it is
not a new arbitrary directory restore command.

Supported input is ordinary main-supported referenced, inline or mixed YAML plus
the corresponding bounded metadata files. Malformed/ambiguous/unsupported YAML
fails with locations and remedy, not raw values. Existing valid legacy projects
continue running without migration. Already-inline config-only migration is a
read-only no-op. Existing application declarations are preserved; adoption never
replaces an existing application or edited source.

The preview lists affected paths, operation kinds, declared instance IDs/types,
required environment names, preserved state, collisions and manual actions. It
does not print arbitrary option values, raw YAML or whole-file diffs. A local
operator can inspect original files directly; public evidence remains redacted.

## Semantic preservation

For each referenced declaration, read `augments/<id>/augment.yaml` without env
interpolation. Preserve name/type/options and declaration order. Only a custom
metadata `source` changes textual basis: resolve from its metadata directory and
represent the same effective source relative to the central config/project root.
An existing outside-project path remains an explicit external reference; report
its deployment portability limitation, do not relocate or copy it.

Environment-derived legacy custom `source` is not automatically convertible:
the current loader interpolates it before deciding whether it is absolute or
relative. Preserving `${CUSTOM_SOURCE}` while changing its path basis cannot
preserve both possible meanings without evaluating the environment. Reject any
such referenced custom source before writes, with guidance to review and replace
it with a literal equivalent source path first. Also reject environment-derived
referenced IDs/types when they prevent passive metadata lookup or classification.
Do not freeze the current environment's secret value into YAML. Inline source
placeholders whose basis is already central remain untouched; inspection can
report unresolved references. Fixtures must include both relative and absolute
possible environment values and assert preview/apply leave all bytes unchanged.

All option paths already use the agent-root basis and remain literal unchanged.
Do not reuse create's mutable-path rewriting. Do not serialize `parseConfig`
output: it would include expanded secrets, defaults and normalized values.

Preserve immutable ID, provider/model, authorization, budgets/limits, transport,
settings and unknown supported option values. Preserve false, zero, null, array
order and `${ENV}` references. Do not move or edit legacy metadata, source, relative
imports, root skills, `.env`, databases/WALs, history, registry identity or locks.
No application-state migration is needed. Verify semantic equality under a
controlled fixture environment, and byte hashes for untouched files.

For alias/merge constructs that the raw document layer cannot preserve exactly,
reject with manual guidance before writes; do not silently flatten ambiguous YAML.
Legacy custom code may remain under root `augments/` after migration. The new
`src/augments/` convention applies to newly created modules, not a forced relocation.

## Application adoption is a separate choice

`--application` additionally plans C1's executable files and application block.
Preflight every file, existing package script/dependency, TypeScript config and
test destination. Absent package fields can be added, identical fields retained;
conflicting scripts/dependency requirements or existing source are reported,
never overwritten. Config-only migration remains available if adoption conflicts.

Require an already installed, compatible local runtime advertising application
contract 1 and the needed public exports; no automatic package upgrade/install
inside migration. Missing tooling can be an explicit follow-up installation
requirement, distinct from ability to start the selected runtime. No registry
lookup is needed. Recheck relevant package metadata before activation.

Adoption preserves configuration limits and uses the ordinary recipe, not the
demo caps. Preview and result disclose the application deadline contract: omitted
timeout currently means 15 minutes, whereas legacy mode has no app deadline.
Config-only conversion preserves execution mode. Do not call the opt-in mode
exact execution parity across that difference.

## Publication and active process semantics

Configuration edits take effect on the next managed launch. M4 neither hot-reloads
nor stops/restarts running agents. Existing managed runtimes retain the configuration
and application they already loaded. Config-only migration does not change its
effective meaning; application adoption explicitly changes the next launch.

Activation is one atomic central YAML replacement, performed last. Before it,
legacy metadata/source remain valid and untouched; after it, all new referenced
files and required compatible runtime are present. Test a managed launch before
and after activation and an existing in-flight turn. A custom user-provided file
watcher is outside this guarantee. Do not claim an exclusive runtime shutdown
lock or global multi-file atomicity. If implementation discovers a managed live
reload consumer, stop and revise this contract before implementing its writer.

The project mutation lease serializes cooperating Auggy authoring writers on the
same canonical project, independently of credential locks. It has bounded wait,
process-incarnation ownership and safe stale recovery; a reused/unverifiable PID
does not grant permission to steal it. Keep it private and local to the project.
This protects CLI writers, not arbitrary editors or malicious same-user processes.
Revalidate all preimages and destination identities immediately before publishing;
observed outside edits fail closed. Do not claim filesystem compare-and-swap
atomicity against an uncooperative editor between the final check and rename.

The shared publisher is limited to known contained project-file creates/replaces
and guarded rollback. It never follows destination symlinks or deletes arbitrary
directories. Bounded descriptor-based reads, regular-file checks, canonical parent
identity, traversal/case-collision rejection, exclusive new-file creation, private
staging, complete writes and same-filesystem atomic replacement are required.
Maintain permissions; `.env` is outside migration. Reuse existing safe-write
primitives where adequate, adding only the missing guarantees with tests.

The shared init publisher may exclusively create a new private `.env`; it never
backs up or replaces an existing one. Its receipt records only ownership and the
created-output hash, never raw env values. Guarded init rollback may remove that
new file only if its bytes still match and this operation owns it. Later credential
edits cause a conflict rather than deletion. Remove temporary secret staging when
it is no longer needed; it is not retained as a backup or public evidence.

Use a private `.auggy/operations/<id>/` receipt for migration and other multi-file
authoring operations. `.auggy/` is ignored
and deployment-excluded. Preserve `.gitignore` content; append the ignore rule
transactionally before storing raw backups. Directories use 0700 and sensitive
backups/journals 0600. Backups may contain inline user secrets even without `.env`;
never archive them as public evidence or model-visible content.

Apply can narrow the owned historical `.auggy` directory from 0755 to 0700;
preview leaves permissions unchanged. Verified staging files receive their final
mode inside the private operation directory immediately before atomic rename,
so a new or replaced YAML is always complete with its intended permissions when
it appears. New paths use an atomic no-replace primitive. The precise stage-mode,
model-snapshot exception and bounded recovery rules are in [the freeze](./freeze.md).

Before creating raw backups/staging, persist a metadata-only bootstrap receipt
that records the original ignore file size/hash and known appended suffix/output
hash. Publish and verify ignore protection first. If interrupted before its
backup exists, recovery can restore the original prefix only from an unchanged
verified appended postimage; otherwise retain the rule explicitly. This closes
the crash window between ignore publication and backup creation without writing
secret-bearing files before protection. Test each of those boundaries.

Receipt schema 1 records operation kind, canonical project identity, preimage and
planned output hashes, operation order, private backup locations, publication
progress and completion. It does not include environment values. Keep receipt
paths strictly relative and contained; validate IDs, size, schema and ownership
before recovery. Raw file bytes reside only in protected backups/staging, not
redacted progress reports. Root freezes exact schema and limits in M4-00.

State transitions and observable recovery:

| State | Guarantee and next action |
| --- | --- |
| Planned | All inputs/destinations checked; preview creates no files/lease/receipt |
| Prepared | Lease held, private staging/backups recorded; central YAML unchanged |
| Publishing | New support files published exclusively; each receipt update recorded; old config remains valid |
| Activated | YAML replacement complete; all necessary support files exist; a crash before completion marker is detected by output hashes |
| Complete | Receipt finalized, lease released, next-launch/retry information printed |
| Interrupted/conflicted | No blind replay; validate journal + current hashes; print receipt ID and guarded rollback command |

Ordinary pre-activation failures attempt guarded cleanup, removing only files
created by this operation whose bytes still match its outputs. Preserve unrelated
or subsequently edited files. If cleanup cannot complete, return nonzero with
the exact recovery location. A killed process leaves a recoverable receipt;
future mutators refuse to proceed over an unresolved operation. Read/inspect/run
may still use whichever valid central config is active. Recovery reconciles
preimage/output hashes instead of trusting the last persisted phase alone.

For a committed rollback, restore central YAML first so it no longer references
new files; then restore other originals/remove unchanged created files. Preflight
the complete rollback set before touching anything. Refuse rollback if any
affected file has changed, if an intervening operation conflicts, or if backup
integrity/ownership cannot be established. Do not delete pre-existing directories.
Interrupted rollback has its own progress recorded and can be retried under the
same guards. Migration never restores `.env`; init may only remove its unchanged,
newly created private file as specified above. Never restore durable state or
dependency installation.
For a previously absent central file (init), guarded rollback removes only its
unchanged created output; it does not invent an original configuration.

Restore/remove an introduced `.gitignore` rule last, after safely clearing all
raw sensitive backups/staging from this rolled-back operation. If any operation
still retains sensitive receipt data, keep `.auggy/` ignored and disclose that
exception to byte-exact rollback. A cleanup failure keeps the ignore protection
and a recoverable status; never leave secret backups eligible for `git add`.
Receipt-only progress/hashes may remain after sensitive bytes are removed.
Test rollback in a Git repository with an inline-secret canary, including another
retained receipt and failed cleanup. Private file permissions alone do not stop
the owner's Git from tracking a file.

This contract targets process interruption and ordinary filesystem errors on
supported local macOS/Linux filesystems. Flush critical staged data and journal
ordering where supported; do not advertise distributed-filesystem or arbitrary
hardware-power-loss durability. No new platform support is implied.

## Acceptance and escalation

Fault-inject each publication/receipt boundary, including final YAML rename and
completion marking. Exercise stale preimages, concurrent cooperative writers,
changed user files, incomplete writes, insufficient permissions, disk/write
failure, malformed receipts, symlink swaps, case collisions and PID reuse.
For each case assert old or new valid config, preserved unrelated/state hashes,
clear non-ready/recovery status and no orphaned lease/process.

Include an installed `init` killed before YAML activation: ordinary initialization
reports the unresolved operation, directory-selected rollback works without a
config file, and a clean retry then succeeds. A changed/deleted config receives
an explicit receipt-based conflict report, not an unrelated config-not-found
error or a blind restore.
The init fixture also proves its unchanged newly generated `.env` is removed
without leaking it, while an operator-modified `.env` causes a preservation
conflict. A successful clean rollback removes its introduced ignore file only
after secret cleanup, allowing ordinary init retry without a collision.

Rollback must restore exact original managed bytes only when safe; a subsequent
user edit is a required rejection control. Apply, reapply and config-only no-op
are deterministic. The harness migrates a legacy fixture on accepted safe runtime
artifacts, then proves startup/restart/durable replay without executing an old
vulnerable package. Scope problems go to root; do not build an arbitrary file
migration system or rewrite customer TypeScript to make a fixture pass.
