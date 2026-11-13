# M4-00 — shared contract freeze

**Accepted after verified main G0 and independent compiled-contract review.**

This document records the configuration architect's read-only preparation for
the [execution plan](../milestone-4-execution-2026-11-13.md). Root owns the final
`contracts.ts`, compile fixtures, integration boundaries and acceptance decision.
The implementation types are `src/cli/authoring/contracts.ts`; compile fixtures
are `tests/fixtures/authoring-contract.ts`. Only root changes ledger acceptance.

The inspected implementation is M3 candidate `ba16ce3a8be1f5ef8ec36e43c79889c3feecc250`.
Its tree matches merged main `d8d0072cd334834bc62e8270b40edd2a2a7a94e9` exactly.
The test-only CodeQL repair is merged and verified on main `911fe168`, with zero
open full-main findings. Production source is unchanged. Independent review of
the actual compiled contracts found one path-limit mismatch, corrected to 1,024
bytes before acceptance. Existing C1–C4 preservation/security requirements apply.

## Producer split and import boundary

| Owner | Files and responsibilities |
| --- | --- |
| Root | `src/cli/authoring/contracts.ts`, compile fixtures, bounded shared metadata integration, command grammar/bootstrap and pure built-in type extraction |
| Document producer | `document-io.ts`, `document.ts`, `mutation.ts`, matching focused tests; bounded reads, raw YAML, provenance, AST-preserving plans |
| Publication producer | `publication.ts`, `publication-lease.ts`, `publication-receipt.ts`, `publication-recovery.ts`, matching focused tests; contained writes, private receipts, lease, guarded recovery |
| Application producer | `scaffold-application.ts`, packaged templates and manifest requirements consumed by fresh create and migration |

`contracts.ts` contains only types and literal constants. Passive document readers
must not import the publication module, FFI, config-parser, provider/augment
implementations, PID registry or the full CLI. Use `agent-name.ts` for the existing
name grammar. The publication module may load the existing POSIX helpers when an
apply operation begins. No kernel or public runtime type change is needed.

`publication-receipt.ts` remains pure: receipt reads and rollback planning import
bounded document I/O only. `publication-recovery.ts` owns apply. Migration preview
must not import lease/FFI modules through a barrel or a shared command handler.
Use lazy effectful imports only after the validated command selects apply.

## Shared private data types

Raw document values and bytes may contain inline secrets. They are process-private
inputs, never a JSON inspection result, log record or public evidence object.
Only the separate safe summaries/diagnostics may be rendered. Do not serialize a
whole `AuthoringDocument`, `MutationPlan` or rollback plan into a receipt.

```ts
export type RawValue =
  | null
  | boolean
  | number
  | string
  | readonly RawValue[]
  | RawRecord;

export interface RawRecord {
  readonly [key: string]: RawValue;
}

export interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: number;
  readonly mode: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

export interface MissingFileSnapshot {
  readonly path: string;
  readonly exists: false;
}

export interface ExistingFileSnapshot {
  readonly path: string;
  readonly exists: true;
  readonly identity: FileIdentity;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export type FileSnapshot = MissingFileSnapshot | ExistingFileSnapshot;

export interface AuthoringDeclaration {
  readonly index: number;
  readonly name: string | null;
  readonly type: string;
  readonly raw: RawRecord;
  readonly source?: string;
  readonly options?: RawValue;
  readonly origin: {
    readonly kind: "inline" | "referenced";
    readonly path: string;
    readonly pointer: string;
    readonly sourceBaseDir: string;
  };
  readonly environmentNames: readonly string[];
}

export interface AuthoringDocument {
  readonly projectDir: string;
  readonly configPath: string;
  readonly format: "inline" | "referenced" | "mixed";
  readonly config: ExistingFileSnapshot;
  readonly inputs: readonly FileSnapshot[];
  readonly value: RawRecord;
  readonly declarations: readonly AuthoringDeclaration[];
}

export interface PlannedFile {
  readonly relativePath: string;
  readonly before: FileSnapshot;
  readonly bytes: Uint8Array;
  readonly mode: number;
  readonly role: "support" | "activation" | "ignore" | "new-env";
}

export type MutationKind =
  | "init"
  | "augment-add"
  | "augment-create"
  | "augment-install"
  | "augment-remove"
  | "agentmail-config"
  | "migrate";

export interface SafeChangeSummary {
  readonly path: string;
  readonly operation: "create" | "replace";
  /** Controlled explanation, never arbitrary option/credential values. */
  readonly reason: string;
}

export interface SafeDiagnostic {
  readonly code: string;
  readonly path?: string;
  readonly field?: string;
  /** Controlled, bounded message; no original parser error/cause. */
  readonly message: string;
}

export interface MutationPlanInput {
  readonly kind: MutationKind;
  readonly projectDir: string;
  readonly configRelativePath: string;
  readonly inputs: readonly FileSnapshot[];
  readonly files: readonly PlannedFile[];
  readonly summary: readonly SafeChangeSummary[];
}

export interface MutationPlan extends MutationPlanInput {
  readonly schemaVersion: 1;
  readonly fingerprint: string;
}

export interface ApplicationDeclaration {
  readonly entrypoint: string;
  readonly contractVersion: 1;
}

export type DocumentEdit =
  | { readonly kind: "append-augment"; readonly entry: RawRecord }
  | { readonly kind: "remove-augment"; readonly name: string }
  | {
      readonly kind: "set-augment-options";
      readonly name: string;
      readonly options: RawValue;
    }
  | {
      readonly kind: "set-application";
      readonly application: ApplicationDeclaration;
    }
  | { readonly kind: "inline-references" };
```

Snapshot paths are absolute; planned write paths are normalized, project-relative
paths. The planner verifies those representations identify the same destination.
Project-directory identity and each parent chain are validated by descriptor
traversal at publication; absence of a leaf does not authorize a path through an
unverified ancestor. Inputs may include read-only package/metadata preconditions;
they do not authorize writes outside the project.

Keep the YAML AST private in `document.ts`, for example in a WeakMap keyed by the
returned document. Edits operate on a clone and retain unchanged nodes/comments.
Mutation consumers do not get an arbitrary JSON-patch engine or write callback.
`inline-references` is the one narrowly scoped legacy conversion operation,
including C2's custom-source basis and environment-derived-source refusal.

Preserve absence versus explicit null. In current `loadAugmentFolderEntry`,
`metadata.config ?? {}` treats absent/null alike at runtime, but the raw authoring
layer must not silently erase their textual distinction. Nested false, zero,
null and arrays retain their values/order. Known built-ins without an explicit
name use the existing type-derived name; custom declarations require a name.
Unknown or environment-derived structure may remain unresolved for inspection.
Graph mutations reject unresolved name/type where target classification or
uniqueness cannot be established without interpolation. Config-only conversion
may leave unrelated existing inline placeholders untouched.

## Function signatures and behavior

These declarations are the proposed producer seam. Root should compile example
consumers against the accepted form before starting either implementation lane.

```ts
export declare function readFileSnapshot(
  path: string,
  maxBytes: number,
  options?: { readonly allowMissing?: boolean },
): FileSnapshot;

export declare function readAuthoringDocument(
  configPath: string,
): AuthoringDocument;

export declare function assertInlineAuthoring(
  document: AuthoringDocument,
): void;

export declare function editAuthoringDocument(
  document: AuthoringDocument,
  edits: readonly DocumentEdit[],
): PlannedFile;

export declare function createMutationPlan(
  input: MutationPlanInput,
): MutationPlan;

declare const projectMutationLeaseBrand: unique symbol;

export interface ProjectMutationLease {
  readonly projectDir: string;
  readonly [projectMutationLeaseBrand]: true;
  release(): void;
}

export type PublicationBoundary =
  | "before-ignore"
  | "after-ignore"
  | "before-first-backup"
  | "prepared"
  | "before-file"
  | "after-file"
  | "after-activation"
  | "before-complete"
  | "before-rollback-file"
  | "after-rollback-file"
  | "before-sensitive-cleanup"
  | "after-sensitive-cleanup";

export type PublicationFaultHook = (event: {
  readonly boundary: PublicationBoundary;
  readonly operationId: string;
  readonly path?: string;
}) => void;

export interface PublicationOptions {
  readonly lease?: ProjectMutationLease;
  /** Explicit test injection only; never selected by env or CLI flags. */
  readonly fault?: PublicationFaultHook;
}

export interface PublicationResult {
  readonly status: "complete" | "rolled-back" | "recovery-required";
  /** Guarded observation of central YAML, independent of overall cleanup status. */
  readonly activation: "original" | "output" | "unknown";
  readonly operationId: string;
  readonly changedPaths: readonly string[];
  readonly diagnostics: readonly SafeDiagnostic[];
}

export declare function acquireProjectMutationLease(
  projectDir: string,
): ProjectMutationLease;

export declare function publishMutationPlan(
  plan: MutationPlan,
  options?: PublicationOptions,
): PublicationResult;

export declare function readOperationReceipt(
  projectDir: string,
  operationId: string,
): OperationReceipt;

export declare function planRollback(
  projectDir: string,
  operationId: string,
): RollbackPlan;

export declare function applyRollback(
  plan: RollbackPlan,
  options?: PublicationOptions,
): PublicationResult;
```

`assertInlineAuthoring` refuses referenced/mixed mutating graphs with the exact
migration remedy; it does not perform runtime configuration validation.
`editAuthoringDocument` returns only the central activation write. Other file
plans come from the application/custom/skill/package planners and are combined by
`createMutationPlan`. That function rejects duplicate/case-colliding destinations,
escaping paths, invalid roles and multiple activation files before publication.

The fingerprint covers operation kind, canonical project, sorted input
preconditions and output paths/hashes/modes/roles. It excludes timestamps and
operation IDs so a no-change preview/apply pair is comparable. It is not a secret
disclosure mechanism or a substitute for precondition revalidation.

Reads and file publication are synchronous; AgentMail may retain a lease while
awaiting provider verification. If a caller supplies a lease, publication verifies
the live opaque token and project and does not reacquire/release caller ownership.
Without one, publication acquires/releases its own lease in `finally`.

Preflight failures throw sanitized classified errors before mutation. After an
operation starts, ordinary failure attempts guarded rollback and returns
`rolled-back` or `recovery-required`; neither result is CLI success. A successful
explicit rollback also returns `rolled-back`, which its command interprets as
successful recovery. Unexpected errors cannot serialize private plans or parser
causes. A failed install is outside these APIs and never triggers file rollback.

`complete` requires confirmed desired central YAML (`activation: "output"`,
including identical no-op bytes). Completed rollback confirms `original`.
Partial cleanup independently verifies the activation snapshot and reports
`unknown` when it cannot prove either state; a receipt phase is not that proof.
AgentMail may have already written verified credentials outside the publication
plan. It reports setup success only for `complete`, and restores prior env only
when activation is confirmed original and its env postimage still matches under
both leases. If activation is output/unknown, retain credentials and report
recovery explicitly; a returned failure is not equivalent to the old thrown
pre-activation YAML write error. Test both returned failures and exceptions,
including after-activation failure and unsuccessful cleanup. No generic secret
backup/rollback mechanism is added.

Fresh `create` can retain its separate new-directory staging path; it consumes
the same pure file planners. Its final publication must refuse a concurrently
created target too. Plain POSIX rename may replace an empty target directory, so
a preflight `exists` check alone is insufficient proof of exclusive publication.
The create producer must demonstrate the no-replacement property; directory
publication is not added to this file-mutation API as an arbitrary move operation.
The preferred narrow implementation reserves the destination with exclusive
`mkdir`, then publishes the staged file plan using the same initialization
publisher and YAML-last activation. A visible, not-yet-ready directory is allowed;
do not claim the whole tree appears atomically. Never remove an unrelated target
on failure. Interrupted owned initialization uses directory-selected recovery.

## Private receipt and rollback schema 1

Receipts live at `.auggy/operations/<UUID>/`, directories 0700 and sensitive files
0600. Stage/backup paths below are generated names relative to that receipt
directory, never user-controlled filesystem references. Input/output hashes and
identity are checked independently of recorded progress after a crash.

```ts
export type ReceiptPhase =
  | "preparing"
  | "prepared"
  | "publishing"
  | "activated"
  | "complete"
  | "rolling-back"
  | "rolled-back"
  | "conflicted";

export interface ReceiptFileVersion {
  readonly sha256: string;
  readonly size: number;
  readonly mode: number;
}

export interface ReceiptStep {
  readonly relativePath: string;
  readonly role: PlannedFile["role"];
  readonly before: (ReceiptFileVersion & { readonly backupPath: string }) | null;
  readonly after: ReceiptFileVersion & { readonly stagePath: string };
  readonly published: boolean;
  readonly rollbackComplete: boolean;
  /** Where known, used alongside bytes to verify created-file ownership. */
  readonly outputIdentity?: FileIdentity;
}

export interface OperationReceipt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: MutationKind;
  readonly project: {
    readonly canonicalPath: string;
    readonly dev: string;
    readonly ino: string;
  };
  readonly configRelativePath: string;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly phase: ReceiptPhase;
  readonly ignoreBootstrap?: {
    readonly relativePath: ".gitignore";
    readonly before: ReceiptFileVersion | null;
    /** Only the known generated ignore suffix, never original file contents. */
    readonly appendedSuffix: string;
    readonly after: ReceiptFileVersion;
    readonly published: boolean;
  };
  readonly steps: readonly ReceiptStep[];
}

export type RollbackFile =
  | {
      readonly kind: "restore";
      readonly relativePath: string;
      readonly expected: ExistingFileSnapshot;
      readonly bytes: Uint8Array;
      readonly mode: number;
    }
  | {
      readonly kind: "remove-owned";
      readonly relativePath: string;
      readonly expected: ExistingFileSnapshot;
    };

export interface SafeRollbackSummary {
  readonly path: string;
  readonly operation: "restore" | "remove-owned";
  readonly reason: string;
}

export interface RollbackPlan {
  readonly projectDir: string;
  readonly operationId: string;
  readonly receipt: ExistingFileSnapshot;
  readonly inputs: readonly FileSnapshot[];
  readonly files: readonly RollbackFile[];
  readonly summary: readonly SafeRollbackSummary[];
  readonly diagnostics: readonly SafeDiagnostic[];
}
```

`RollbackFile` is an internal result of validated receipt recovery, not a general
delete request accepted from JSON/CLI. Revalidate the receipt snapshot and complete
affected set before writes. An interrupted operation with a never-published step
needs no deletion; the planner confirms the current preimage/absence. A changed,
missing expected output or corrupt backup is a preservation conflict, not license
to force restore. Recovery can use `--project-dir` without reading `agent.yaml`.

New `.env` creation is init-only: before is null, no env backup, only an ownership
and output-hash record; raw temporary env staging is cleared when no longer needed.
Never archive that staging or receipt backups as model-visible/public evidence.
Restore/remove introduced ignore protection last, after sensitive cleanup; retain
it with an explicit exception while any sensitive receipt remains. Do not unlink
the stable project lock during rollback or receipt cleanup.

Bootstrap the ignore rule without an unprotected secret-backup window. First
persist a metadata-only `preparing` receipt, including original ignore size/hash
and the known suffix/output hash; no raw preimage or stage bytes yet. Append the
ignore protection safely, verify its output, then store raw backups/stages. A
crash before the ignore backup exists can reconstruct the original prefix only
when the entire current ignore output, prefix length and original hash match the
receipt. Otherwise retain the rule with a disclosed conflict/exception. Once any
sensitive staging exists, remove ignore protection only after verified cleanup.
Test before-ignore, after-ignore and before-first-backup interruptions, including
an originally absent ignore file. Receipt decoding must not require future backup
files to exist in the `preparing` phase.

## Fixed bounds and YAML policy

| Resource | Fixed maximum |
| --- | ---: |
| Central YAML, project/runtime package JSON, source index | 1,048,576 bytes each |
| Referenced augment metadata | 262,144 bytes each |
| Aggregate raw document input | 8,388,608 bytes |
| YAML nesting depth | 64 |
| YAML nodes | 50,000 |
| Alias nodes | 0 |
| Declared augments | 256 |
| Planned file writes | 256 |
| One output file | 4,194,304 bytes |
| Aggregate output bytes | 16,777,216 bytes |
| Receipt JSON | 1,048,576 bytes |
| Receipt-directory enumeration | 1,024 entries |
| One normalized relative path | 1,024 UTF-8 bytes |
| Diagnostic records | 100 |
| Diagnostic message | 1,024 UTF-8 bytes |
| Nonblocking mutation-lease wait | 0 milliseconds |

Reject excess with actionable diagnostics. Tests may use smaller injected limits
where needed, but CLI/environment flags cannot disable bounds. Reading uses
`O_NOFOLLOW | O_NONBLOCK`, regular-file checks, bounded complete reads and stable
before/after fstat identity. Invalid UTF-8 must not be silently replaced. Passive
selection itself observes the bounds; it cannot call an unbounded existing helper
before reaching the reader.

Use the installed YAML library's document API with source-token retention, strict
unique scalar string keys, YAML 1.2 core behavior and `prettyErrors: false`.
Disable known non-core tag resolution. Reject alias nodes, merge constructs and
unsupported explicit tags; `toJS({ maxAliasCount: 0 })` is defense in depth, not a
replacement for AST validation. Bound depth/nodes with iterative traversal before
materializing values. Catch parser exceptions without printing their source
excerpts or causes. Only finite safe numeric values are accepted for automatic
editing; unsupported scalars receive a manual-preservation remedy.

Preserve arbitrary supported option keys without prototype-polluting merges:
use AST operations or safe own-property/null-prototype maps, not unchecked
assignment to a normal object. Do not add an option-key blacklist that silently
changes legitimate domain data.

## Lease and credential interaction

Use existing `openAbsoluteDirectoryNoFollow`, `openAt` and
`tryLockFileExclusive` in `src/lib/posix-at.ts` for a distinct stable private
`.auggy/authoring.lock` inode. Validate directory/file ownership, modes, regular
file type and no-follow containment. Maintain a same-process ownership guard and
an opaque token. The OS descriptor lock is the authority; closing the descriptor
releases it after normal exit or process termination. PID reuse cannot grant a
lease, so no heartbeat, PID-file stealing or expiry protocol is needed.

Existing `env-mutation-lock.ts` locks the canonical project directory descriptor.
Do not use that same inode for the new project lock, which would self-conflict.
All operations needing both acquire **project lease, then env lease** and release
in reverse order. Revalidate config snapshots after awaited provider work.

Admin credential endpoints mutate only env and retain their existing env lock;
they never acquire a project lease in reverse order. Add's optional post-add
AgentMail setup must run after publication/install and release of both leases.
Do not retain a publication lease while recursively invoking another authoring
command. No process registry/state-store access is required for this lease.

## Application template seam

```ts
export interface GeneratedApplicationFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly mode: number;
}

export interface ApplicationScaffoldPlan {
  readonly application: {
    readonly entrypoint: "./src/index.ts";
    readonly contractVersion: 1;
  };
  readonly files: readonly GeneratedApplicationFile[];
  readonly packageFields: {
    readonly type: "module";
    readonly scripts: Readonly<Record<string, string>>;
    readonly devDependencies: Readonly<Record<string, string>>;
  };
}

export declare function planApplicationScaffold(input: {
  readonly configFileName: string;
}): ApplicationScaffoldPlan;
```

Pass `agent.yaml` for fresh creation. Migration of `--config custom-name.yaml`
passes that selected basename so direct startup and package scripts target the
same configuration. Validate the basename and safely encode TypeScript/URL data
and shell arguments; no provider/model/name interpolation into executable source
is necessary. Fresh creation owns the full manifest. Adoption merges only absent
or identical fields and rejects conflicts. Core/provider dependencies and consumer
security overrides remain with `scaffold-package-json.ts`.

Templates ship in the package. The four execution files use public application
contract 1 and the actual default recipe with `finishAtLimit`. Do not copy the
reference's demo inference cap, timeout, observability module or tool fixture.
The planner performs no install, write, package import or runtime startup.

## Pure built-in type set and consumers

Extract the existing declarable type set from `config-parser.ts` into a pure
data-only module shared by effective validation and raw authoring. Keep this root
integration scoped: the installed source index is navigation metadata, not a new
configuration registry or substitute for runtime validation. The current set is:

```text
fileMemory, supabaseMemory, layeredMemory, filesystem, webTransport,
webFetch, knowledge, skills, bash, budgets, notify, mcp, agentMail,
telegramTransport, turnControl, visitorAuth, link
```

`custom` is handled separately. Verify resolver dispatch parity against this set;
the catalog picker omits some supported types. Inspection still reads source
mappings from the selected installed package, not this invoking CLI's catalog.

Root's passive command grammar is separate from `PROJECT_COMMANDS`: inspection
must not delegate into a local CLI or require one to be installed. Dispatch it
before ordinary bootstrap/full-program imports. Prefer `runInspect`/`runMigrate`
returning an exit code; handlers do not call `process.exit`. Root separately
freezes inspection/report metadata types. Invalid-graph JSON remains
schema-shaped and sanitized, with no raw YAML parser excerpts or nested causes.

| Surface | Integration or preservation |
| --- | --- |
| `commands/create.ts` | Inline generation, shared template plan, collision-safe init, complete dependency verification |
| `commands/add.ts` | Central planned mutation, package/missing-asset staging, project→env order; optional setup after lease release |
| `commands/augment.ts` | Central remove/create/install; no destructive source/skill cleanup or force overwrite |
| `commands/agentmail.ts` | Canonical inline topology/options; preserve credential checks, env lock, shared consumers and post-network CAS |
| `scaffold-skills.ts`, `scaffold-knowledge.ts` | Planned missing assets when called by authoring; retain existing owned content |
| `commands/add-skill.ts` | Explicit skill repair semantics; coordinate overlapping writes and report intentional behavior |
| `mcp-config.ts` | Domain `.mcp.json` writer, not graph authority; retain legacy mounted detection and domain ownership |
| `transports/admin/admin-credentials.ts` | Existing env-only mutation and lock; no reverse acquisition |
| `yaml-helpers.ts` | Effective env-loading reader; excluded from passive authoring/inspection |
| `application-definition.ts`, `project-runtime.ts`, config selection | Root integrates bounded snapshot-based passive paths without weakening launch checks |
| Builder skills, `auggy-self-augment.ts`, public/generated docs | Align actual execution/custom source paths; preserve explicitly labeled legacy examples |

## Acceptance seam and driver notes

The existing `resolveScaffoldPackageSpecifiersForCreate` accepts
`AUGGY_SCAFFOLD_AUGGY_SPEC` and `AUGGY_SCAFFOLD_ENGINE_SPEC`, but those two values
alone do not cover an installed OpenRouter consumer's OpenAI prerequisite. Root's
reviewed draft direction adds `AUGGY_SCAFFOLD_PACKAGE_SPECS`: bounded JSON of at
most 16,384 bytes mapping core, selected provider and OpenAI only when required by
OpenRouter to exact file tarballs. Reject unknown package keys, malformed values
and conflicts with the existing seams. Generate the required OpenAI override in
the manifest before installation; the harness cannot repair it afterward.

Invoke the installed CLI outside the checkout, record the seam and generated
manifest before install, and separately prove ordinary generation emits no
temporary or checkout references. The companion `harness-freeze.md` records the
exact artifact mapping and generated-driver contract under the harness owner's
separate draft scope.

`application-install.ts` currently calls `prepareApplicationConsumer` and copies
the reference. Retain that oracle separately. The authoring suite must adopt the
actual generated directory; it cannot overwrite files with the example afterward.
Although `application-runner.ts` already accepts a consumer, recipe and artifact
evidence, its behavior is too coupled to the reference's observability JSONL and
demo constants. Use a dedicated `authoring-application.ts` driver composing shared
M3 low-level artifact/process/HTTP primitives. Do not force reference observability
into the product or duplicate the runtime to satisfy the old verifier.

Freeze the generated recipe/adoption adapter after the template owner confirms
actual output. Observe startup/HTTP/turn behavior through maintained operations,
real HTTP/provider/tool effects and explicit source edits. Keep the five launch
paths and 15 edit observations, restore baseline after edits, and include a wrong
expected-marker control. Add custom business fixtures through the actual authoring
command and record edits separately from untouched scaffold hashes.

The turn edit stops only after `preparePrompt` has succeeded and its terminal
result has been handled, immediately before the ordinary inference `while` loop.
It must preserve the internal-turn/terminal branches. The companion harness freeze
defines the exact edit and public-behavior assertions; do not copy the reference's
two-inference demo cap or use an early stop before managed preparation.

Use explicit fault-hook injection for boundary tests, never a product environment
variable that can alter publication. Required boundary controls include current
preimage changes, exclusive creation, central activation, receipt persistence,
interrupted init without YAML, modified env preservation, protected backup cleanup
and rollback ignore ordering. Harness test-driver code stays static; pass fixture
paths/values as argv or data files, not interpolated executable JavaScript.

No new harness implementation was reviewed in this draft. These notes derive from
C4 and inspected current helper APIs. The harness specialist's accepted adapter
and evidence schema remain a separate root-reviewed preparation deliverable.
