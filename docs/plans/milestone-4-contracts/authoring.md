# C1 — authoring and configuration contracts

Proposed contract for the [M4 execution plan](../milestone-4-execution-2026-11-13.md).
No implementation is implied. M4-00 freezes exported CLI-local interfaces and
compile fixtures against verified merged main before consumers start.

## Ownership and generated execution

The engineer owns generated `src/index.ts`, `src/agent.ts`, `src/http.ts`,
`src/turn.ts`, custom augments, tests, skills and package/configuration files.
The installed package owns guarded operations and built-in implementations.
Updating a dependency must not rewrite project-owned source or skills.

Use M3's public `auggy/application` contract 1:

- `index.ts` exports the named `ApplicationMain`; calls `launch.createHost`,
  prepares configured composition, configures HTTP and starts the managed host.
  Its `import.meta.main` guard supports direct execution without import-time boot.
- `agent.ts` calls `configured.compose({ turnProgram })`. It does not select a
  second list of enabled augments or bypass the configuration resolver.
- `http.ts` visibly mounts `POST /agent/run`, passes the original request to
  `web.agentRun`, and delegates remaining managed routes to `web.fallback`.
  No copied authentication implementation, request-body preconsumption, alternate
  transport kernel, or separately owned listener.
- `turn.ts` contains the readable recipe: dispatch internal turn, prepare prompt,
  infer, complete an answer or execute tools, handle terminal/final-answer-required
  outcomes, refresh prompt, and `finishAtLimit` when exhausted.

Match `src/kernel/turn-program.ts` ordering. Do not copy the reference's two-call
cap, 60-second timeout, or premature application-limit stop before final-answer
handling. Omit scaffold overrides of inference limits and timeout. Configured
limits remain effective; application mode's omitted timeout is currently 900,000
milliseconds. Legacy mode has no equivalent application deadline. Explain that
difference for explicit migration (C2); do not silently claim legacy parity.

Templates ship inside the packed `src/scaffold-templates/application/` tree and
are usable without repository examples. Keep substitutions limited to validated
data; do not interpolate arbitrary names/model strings into executable source.
The template planner produces paths/bytes, without installing or writing itself.
Tests compare recipe behavior, including internal/terminal/final-answer/exhaustion
branches, against maintained semantics. Updating a template is a deliberate
change for future creates, never an automatic rewrite of existing projects.

No default demo capability or reference-only observability module is required.
Small startup/source-map instructions must not log prompts, auth headers or tokens.
The generated `tests/application.test.ts` checks meaningful recipe outcomes and
termination, while installed acceptance proves the real managed path.

## Manifest, installation and supported creation

Fresh manifests include `type: module`, the current supported Bun floor (1.3.14
at planning), local core plus the selected provider and selected augment package
dependencies, Zod where generated authoring imports it, and explicit TypeScript
and Bun type tooling. Preserve consumer security overrides. Typecheck imports
public exports and must not require incidental optional providers.

Scripts follow the proven M3 recipe: `start` and `dev` initially run
`bun src/index.ts`, `cli` uses the local Auggy executable with `agent.yaml`,
`typecheck` invokes the local TypeScript project, and `test` runs Bun tests.
Do not advertise watch/hot reload until it is implemented and certified.
No checkout-only `workspace:`/relative provider overrides leak into generated
standalone manifests. Preserve the existing exact-package-specifier test seam.

Installed readiness requires more than a successful install: validate the selected
local package advertises application contract 1 and exposes the required public
entry. Ordinary registry `0.5.0` may differ from the same-version candidate
artifact. During M4, acceptance installs exact packed candidate artifacts; no
version bump is needed or authorized. Incompatible installation reports an
actionable dependency remedy and cannot claim the agent is ready.

| Command | Contract |
| --- | --- |
| `auggy create <name>` | Preserve interactive wizard and selected/default capability semantics; new layout is standard |
| `auggy create <name> --provider <id> --model <id> --yes` | No prompts; provider and model required; supported provider IDs validated before writes |
| `auggy init [name]` with the same flags | Same planned files; target is current directory; refuse any occupied generated-file destination before writing |
| `--skip-install` | Files-only success; no lockfile/runtime-readiness claim; explicit install and capability-verification next steps |
| `--refresh-models` | Interactive discovery option; reject with automated `--yes` to keep that path deterministic |
| `--allow-unpriced-model` | Explicit automation acknowledgement for a model without known pricing, equivalent to existing interactive acknowledgement; never implied by `--yes` |

Non-TTY creation without the required automated choices fails before mutation.
Unpriced automation without the explicit acknowledgement fails; with it, retain
runtime budget validation and display the existing limitation. Do not silently
disable budgets or invent prices. Embedded/cached model metadata can establish
known pricing; the automated path must not require live discovery.

All four current providers remain supported. Interactive Ollama uses the existing
installed-model discovery and secure remote credential rules. Noninteractive
Ollama accepts an explicit model without pulling models or probing the service;
later runtime validation reports unavailable models. No credential values in CLI
arguments or generated README. Preserve private `.env` creation and identity/token
handling, placeholders in `.env.example`, and ignored state/secret files.

Keep current safe capability defaults unless M4-00 records a concrete necessary
change. No new broad shell, public route or untrusted tool permissions. Display
names and descriptions can use deterministic defaults under `--yes`; do not
invent credentials or change the provider when inputs are incomplete.

`create` stages a new directory and publishes without replacing an existing target.
`init` does not merge an existing `package.json`, `.env`, source, README or skills
file: list collisions and suggest a sibling service. Unrelated existing paths
remain unchanged. Parent-directory, symlink and case-collision checks are part
of preflight. Reuse C2's narrow publication contract for multi-file authoring.
Failed installation leaves generated files intact with a non-ready result and
retry command; it is outside file rollback. No false all-or-nothing install claim.

## Single raw configuration authority

Use the parser's existing inline schema, for example:

```yaml
application:
  entrypoint: ./src/index.ts
  contractVersion: 1
augments:
  - name: layeredMemory
    type: layeredMemory
    options:
      dbPath: ./data/memory.sqlite
  - name: orders
    type: custom
    source: ./src/augments/orders/index.ts
    options: {}
```

This is a fragment, not a complete agent configuration. Preserve existing
identity/provider/settings fields and supported shorthand. Generated built-ins
have no new `augments/<name>/augment.yaml`. There is no `definition.ts` or
TypeScript enabled-augment registry.

Introduce CLI-local `authoring/document`, `mutation` and `publication` modules:

- The reader obtains bounded raw YAML documents with declaration provenance,
  source bases and input snapshots. It does not call `parseConfig`, interpolate
  env, apply runtime defaults, import modules or open stores.
- Readers support inline, referenced and mixed legacy graphs. Strictly reject
  duplicate keys, duplicate instance names, unsupported aliases/merge constructs
  that cannot be preserved, invalid metadata and ambiguous declarations. Bound
  YAML size, depth and aliases; do not echo parser excerpts containing values.
- Planners produce redacted descriptions plus private bytes/precondition hashes
  for managed file operations. The writer compares all relevant input snapshots
  immediately before publishing, uses the project mutation lease and activates
  `agent.yaml` last. Unchanged files remain byte-identical.
- Preserve declaration order, names, arbitrary option values, `${ENV}` strings,
  explicit false/zero/null, unrelated fields and option path literals. Use the
  YAML document AST to retain comments/presentation where feasible; formatting
  changes may be disclosed, never semantic substitutions.
- Paths allowed for reading existing external custom source do not authorize
  writes outside the project. Generated destination paths must remain contained
  and cannot traverse symlinks. Reject invalid inputs before secrets/setup calls.

The pure layer does not replace effective runtime validation. Keep sensitive
credential mutation under its existing lock and verification path; do not broaden
the credential lock into a generic filesystem transaction abstraction.

## Augment commands and compatibility

Authoring mutations (`add`, `create`, `install`, `remove`, configuration-changing
setup) on graphs containing referenced string entries fail before any writes,
install or provider calls, with exact `migrate --config ...` preview/apply guidance.
Do not silently normalize, emit mixed graphs or produce more legacy metadata.
Legacy `run`, read/list/doctor and operational security actions remain supported.
Visitor revocation and credential revocation must not depend on format migration.
Record this authoring compatibility change in release notes.

- `augment add`: append valid central declarations; preserve other instances and
  files; install required package dependencies through the existing path. Existing
  skill contents are never overwritten. Report retained/added assets accurately.
- `augment create <slug>`: write `src/augments/<slug>/{index.ts,schemas.ts,
  service.ts,README.md}`, `tests/augments/<slug>.test.ts`, register once centrally.
  Default includes no skill; `--with-skill` creates `skills/<slug>/SKILL.md` and
  `--without-skill` is the explicit equivalent of default. Mutually exclusive.
- The starter is labeled sample read-only lookup logic, with a deterministic
  in-memory fixture; it is not an orders database or production business system.
  A schema-validated lookup tool and authenticated route call the same service.
  Tool exposure starts creator-only; the route has explicit creator policy.
  Tests exercise valid lookup, invalid input, missing record and unauthorized
  access through supported validation/authorization boundaries.
- `augment install`: preserve existing reference semantics; do not copy/move
  arbitrary source or rewrite imports. External paths are reported as nonportable.
- `augment remove <name> --yes`: remove the one declaration only; preserve source,
  skills, packages, env and data. Required augment protections remain. No new
  confirmation prompt is needed for config-only removal; `--yes` is accepted for
  automation. Explain retained root skills remain discoverable/model-visible.
- Source/skill collisions always fail before writes. Deprecate `--force` as an
  overwrite mechanism: reject with an actionable rename/manual-review remedy.
  No destructive purge/automatic skill refresh in M4. The separate explicit
  skill repair command retains its documented behavior and is reviewed for clarity.

AgentMail gets a dedicated security work package. Inline instance discovery and
updates replace metadata-file assumptions, while retaining canonical-name and
shared-consumer restrictions, credential transport checks, env mutation locking,
preimage CAS, permission verification and failure preservation. Acquire locks in
one documented order (project mutation lease, then credential env lock); no other
writer may acquire them in reverse. Revalidate config snapshots after awaited
network work. Preview never performs credential verification. Do not log secrets
or treat successful API authentication as authorization for broader scope.

MCP and all other graph writers must use the same declaration policy; domain
files that are not graph registries retain their ownership. Deploy bundles carry
new source/tests as appropriate and exclude secrets, mutable stores, `.auggy/`
receipts and `node_modules`. External custom-source portability errors remain
explicit. Update generated README, builder skills and runtime self-guidance
together so the agent does not teach obsolete paths.
