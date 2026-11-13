# M4-00 draft — generated-project harness interfaces

Status: draft pending G0 and root contract freeze. The user authorized execution,
but main verification and the scoped CodeQL repair in PR #228 remain entry-gate
work. This document is preparation only, not acceptance of M4 implementation.
Root owns final interface decisions, shared changes and ledger state.

This supplements [C4](./acceptance.md) and [C1](./authoring.md). Source inspection
used candidate `ba16ce3a8be1f5ef8ec36e43c79889c3feecc250`, whose tree matches M3
merge `d8d0072cd334834bc62e8270b40edd2a2a7a94e9`. Reconcile with the verified main
after the repair gate; no experiment worktree supplies code or assumptions.

## Exact artifact seam in the real installed CLI

Existing `AUGGY_SCAFFOLD_AUGGY_SPEC` and `AUGGY_SCAFFOLD_ENGINE_SPEC` reach actual
`create`, through `resolveScaffoldPackageSpecifiersForCreate`. They do not expose
OpenRouter's candidate `@auggy/openai` prerequisite outside a checkout. The
existing release smoke already adds an exact prerequisite override to prevent
Bun from resolving a stale same-version registry adapter first.

Add the narrowly scoped `AUGGY_SCAFFOLD_PACKAGE_SPECS` environment input:

```json
{
  "auggy": "file:/private/tmp/artifacts/auggy-0.5.0.tgz",
  "@auggy/openrouter": "file:/private/tmp/artifacts/auggy-openrouter-0.5.0.tgz",
  "@auggy/openai": "file:/private/tmp/artifacts/auggy-openai-0.5.0.tgz"
}
```

```ts
type Provider = "anthropic" | "openai" | "openrouter" | "ollama";
type ScaffoldArtifactPackage = "auggy" | `@auggy/${Provider}`;
type ScaffoldArtifactSpecifiers =
  Partial<Record<ScaffoldArtifactPackage, string>>;

interface ScaffoldArtifactSelection {
  dependencies: ScaffoldArtifactSpecifiers;
  prerequisiteOverrides: Partial<Record<"@auggy/openai", string>>;
}

declare function resolveScaffoldArtifactSelection(input: {
  provider: Provider;
  env: Readonly<Record<string, string | undefined>>;
}): ScaffoldArtifactSelection;
```

This is a pure selection/validation helper, not an installer or shell runner.
The existing manifest builder receives its result. The exact exported name can
be folded into existing resolver interfaces at root freeze; behavior is fixed:

- Bound JSON input to 16 KiB UTF-8; require a plain mapping with at most three
  entries and nonempty string values of at most 4,096 characters, without NUL.
- Accept only `auggy`, the selected provider and, for OpenRouter, `@auggy/openai`.
  Reject unknown/prototype keys, arrays, invalid shapes and unrelated providers.
- New mapping values use explicit `file:` plus an absolute filesystem tarball
  path. Do not interpret values as executable code or shell fragments. Existing
  legacy single-package variables retain their existing supported behavior.
- Matching legacy/core/engine values can coexist; conflicting selections fail
  before writing the project. Never silently choose a different artifact.
- The generator writes selected exact dependencies itself. For OpenRouter, also
  emit its exact OpenAI prerequisite override, merging the existing security
  overrides. No post-generation manifest repair is allowed.
- With the seam absent, ordinary generated dependencies remain semver-based and
  no test prerequisite override or incidental provider dependency appears.
- The installed harness validates tarball package identities/hashes and installed
  direct and transitive resolution. The seam alone is not evidence of provenance.

Required tests: mapping bounds/types/unknown keys/conflicts; ordinary output
without seam; real installed CLI OpenRouter creation; exact OpenAI prerequisite
resolution from both consumer and OpenRouter context; wrong/missing prerequisite
negative case; frozen lock stability. Use a matching installed CLI outside any
workspace fallback. Paths and configuration enter child processes as argv/env or
data files, never interpolated JavaScript or shell commands.

## Creation and adoption interface

Reuse `PackedArtifactInput`, `PackedArtifactEvidence` and the bounded helpers from
`application-consumer.ts`. Do not call `prepareApplicationConsumer` on a generated
project: it deliberately copies the reference and rewrites its manifest.

```ts
type FileHashes = Readonly<Record<string, string>>;

interface AuthoringArtifactSet {
  core: PackedArtifactInput;
  providers: Readonly<Record<Provider, PackedArtifactInput>>;
}

interface InstalledAuthoringCli {
  entry: string;
  packageRoot: string;
  core: PackedArtifactEvidence;
}

interface CreateAuthoringConsumerOptions {
  repoRoot: string;
  workspace: string;
  evidenceDirectory: string;
  cli: InstalledAuthoringCli;
  artifacts: AuthoringArtifactSet;
  provider: Provider;
  model: string;
  name: string;
}

interface GeneratedAuthoringConsumer {
  consumer: string;
  core: PackedArtifactEvidence;
  provider: PackedArtifactEvidence;
  prerequisites: readonly PackedArtifactEvidence[];
  sourceFiles: readonly string[];
  generatedSources: FileHashes;
  installedSources: FileHashes;
  lockSHA256: string;
}

declare function createAuthoringConsumer(
  options: CreateAuthoringConsumerOptions,
): Promise<GeneratedAuthoringConsumer>;
```

The function creates an isolated HOME/cache/tmp context, invokes the actual
installed `create --provider ... --model ... --yes --skip-install` with exact
artifact selections, and records output before modifications. It then installs
that manifest, verifies selected package paths/bytes, runs project typecheck and
Bun tests, audits, performs frozen reinstall and checks the retained lock. The
model is supplied explicitly; unknown-price fixtures use the documented explicit
acknowledgement. The generator is never repaired by the harness.

Fresh installation success and failure of the ordinary automatic-install path
also need focused CLI coverage. The split `--skip-install` acceptance path does
not alone certify its success message or runtime capability postcheck.

Source snapshots use a fixed reviewed allowlist for the application, manifest,
configuration, tests and selected authoring assets, never recursive copying of
an arbitrary customer directory. At most 128 selected files, 2 MiB each and
16 MiB total; reject symbolic-link traversal and nonregular files. Record a
separate bounded path inventory if needed to detect unexpected generated files.
Do not include `.env`, private receipts, dependencies, stores or caches in public
snapshots. Check secret-file ownership/permissions without archiving their bytes.

## Dedicated generated-application driver

Root approved a narrow deviation from generalizing the reference runner: add
`authoring-application.ts`, composing the existing low-level helpers. The reference
runner remains a separate regression oracle; it requires demo-only startup and
finalization records, fixed labels/header, two-call override and memory-only
history. Generated projects must not acquire those features solely for testing.

```ts
interface GeneratedApplicationRecipe {
  schemaVersion: 1;
  entrypoint: "src/index.ts";
  sourceFiles: readonly string[];
  capability: {
    slug: string;
    tool: ProviderFixtureTool;
    expectedOutput: string;
    route: string;
    toolJournal: string;
  };
  edits: {
    startup: ApplicationSourceEdit;
    http: ApplicationSourceEdit;
    turn: ApplicationSourceEdit;
  };
  observations: {
    startupRejection: string;
    httpHeader: { name: string; value: string };
    baselineProviderCalls: 2;
    baselineToolEffects: 1;
    stoppedProviderCalls: 0;
    stoppedToolEffects: 0;
  };
}

interface GeneratedApplicationRunOptions {
  repoRoot: string;
  consumer: GeneratedAuthoringConsumer;
  global: { consumer: string; core: PackedArtifactEvidence };
  home: string;
  temporaryDirectory: string;
  evidenceDirectory: string;
  recipe: GeneratedApplicationRecipe;
}

declare function runGeneratedApplication(
  options: GeneratedApplicationRunOptions,
): Promise<void>;
```

The custom capability is added through actual `augment create` before the tool
scenario. Record any fixture business logic/journal edits as changes to that
owned custom module. Do not add fixture logging to the generated startup,
composition, HTTP or turn files merely to make baseline execution measurable.
Freeze the starter's real tool/route/sample result with M4-02/03; the recipe records
those values, not a competing augment registry.

Use the public SSE result, real provider request/result counts and an independently
observed custom tool-effect journal. The journal is bounded and private, has
fixed fixture-owned destinations, and correlates effects to the request/thread.
Raw prompts and credentials do not enter it. Route activity and tool activity
must be distinguishable so a route request cannot manufacture tool evidence.
Internal accounting/finalization remains covered by M3's actual reference suite;
do not fabricate missing finalization observations or claim they were collected
from an uninstrumented generated app.

Reused helpers: `startApplicationChild`, `applicationEnvironment`,
`applicationHttp`, `waitForApplicationReady`, `parseApplicationStream`,
`assertInstalledApplicationArtifact`, `withApplicationEdit`,
`assertOnlyApplicationEdits`, artifact hashing and bounded file readers.
Reuse readiness/scenario/shutdown/reap budgets of 60/120/15/5 seconds and 2 MiB
response/output bounds. The driver owns every started child through failure
cleanup. No unbounded polling, subprocess output or unsupervised detached work.

Existing denial/replay assertions require exactly four reference counters.
Root may extract a narrow named-counter comparison for the generated driver;
do not pass fabricated trace/finalization zeros to satisfy the old signature.
Keep old reference assertions unchanged in meaning.

## Fifteen source-edit controls

Run startup, HTTP and turn sensitivity through direct execution, local `run`,
local `dev`, global `run` and global `dev`. Every path first proves baseline
readiness and an authenticated request with the selected local runtime. Global
and local artifacts intentionally differ; inspect selected installed provenance.

| File | Exact placement and edit behavior | Observable result |
| --- | --- | --- |
| `src/index.ts` | Insert a unique throw inside `main`, before `createHost` | All five launches reject with the exact diagnostic, never become ready, produce zero provider/tool effects and clean up |
| `src/http.ts` | Wrap the response returned by the real `web.agentRun(request)` delegate; preserve original body, status/statusText and headers, adding one test header | Authorized and missing/invalid-auth responses carry the header; denied calls still produce zero provider/tool effects |
| `src/turn.ts` | After the successful `preparePrompt` terminal check and before the inference loop, insert `return turn.stop("application-limit")` | Valid terminal response, zero provider/tool calls, and no tool side effects |

The turn stop must not be inserted at run-entry: `stop` accepts ready/refresh/final
phases only. `finishAtLimit` additionally requires exhausted remaining inferences.
Do not reuse the reference's `maxInferences: 2 → 1` edit or its premature stop
ordering. The ordinary generated recipe preserves final-answer-required behavior.

Each `before` anchor must occur exactly once in the frozen template, with bounded
static replacement source. The producer and harness agree these anchors before
implementation acceptance. Record original/edited hashes, require the expected
behavior, restore only after child cleanup, and require restored baseline behavior.
A wrong expected marker and an unchanged-source control must fail verification.
Startup rejection is an edit sensitivity result, not a replacement for successful
untouched startup proof.

## Snapshots and allowed mutations

Record these phases separately: original generated output; installed output;
custom capability added by CLI; explicit fixture setup; one source sensitivity
edit; restored source. Installation must not change the four owned execution
files. Custom authoring must not change them either.

After original snapshots, allow only documented dummy credentials, loopback
provider URL, temporary port, isolated supported state paths, explicit fixture
model/pricing values, supported authoring commands, recorded custom business
fixture changes and the source edits being tested. Every config field changed
for fixture setup is enumerated in evidence and restored where applicable.
Never change application declaration, scripts, dependency mappings or execution
files to repair broken generator output.

Before adding a custom capability, prove the untouched application can run using
an answer-only provider response. This needs a small explicit extension of the
existing provider fixture: one valid authenticated Messages request, one final
answer, zero tool requests and bounded accounting. Keep the existing success,
invalid-arguments and provider-failure modes and their assertions. Root owns the
fixture extension and tests; it is not a new production provider abstraction.

Durable replay proves identical public stream plus unchanged provider and actual
tool-effect counts before and after restart. Auth denial uses the same real
effect counts. Do not call read-only routes and equate their result to a tool run.

## Ownership and root-only integration

M4-07 owns new `authoring-suite.ts`, `authoring-consumer.ts`,
`authoring-application.ts`, `authoring-inspection.ts`, `authoring-migration.ts`
under `scripts/release-smoke/`, and corresponding `tests/scripts/authoring-*`.
Root serializes changes to shared M3 harness modules, provider fixture, package
scripts, artifact selection, release shell, CI and inventory.

Root integration must:

- Register `smoke:authoring` with exact candidate core/four-provider artifacts,
  installed CLI and evidence-directory inputs, and call it from release rehearsal.
- Extend artifact evidence to cover the source index, relevant authoring handlers
  and packaged templates; current `application-artifacts.ts` selected sources do
  not cover those new bytes. Validate all navigation paths inside the tarball.
- Update fresh-scaffold folder-backed assertions and old non-TTY-only expectations
  in release smoke. Keep deliberate legacy fixtures and their regression cases.
- Preserve the harness shard, separate CodeQL analysis/findings, required PG17,
  console, reference and release gates. Root source typecheck excludes `scripts/`;
  explicitly typecheck/import the real new harness entrypoints.
- Record macOS actual service lifecycle separately from Linux-generated artifacts.
  Unavailable evidence is not a pass. No live provider keys or model downloads.

## Baseline trace observations

These are static source observations, not timed human usability results:

1. Current `create` emits referenced configuration and no owned startup, HTTP or
   turn source. Finding the endpoint/loop requires entering installed package code.
2. Per-built-in `augment.yaml` identifies configuration, not implementation.
3. Existing custom creation uses root `augments/<slug>` and an echo tool; it does
   not show the planned schema/service/route separation.
4. The M3 reference exposes real execution, but its copied-consumer setup certifies
   the reference rather than the generator.
5. Runtime selection, bounded HTTP/process supervision, artifact validation and
   source edit/restoration primitives already exist. M4 composes them.

No claim of measured DX improvement, installed acceptance or completed execution
is made by this preparation document. Root freezes its exact revision after G0.
