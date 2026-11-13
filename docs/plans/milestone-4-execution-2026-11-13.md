# Milestone 4 — inspectable project authoring

Status: planning complete and independently reviewed; implementation has not
started. See the [review dispositions](./milestone-4-plan-review-2026-11-13.md).
This packet is prepared for
specialized engineering subagents orchestrated by the CTO / AI Engineering Lead.
The current request authorizes planning, not implementation, merging or publishing.
See the [task ledger](./milestone-4-tasks.json) for gates and review status.

## Outcome and entry gate

An engineer installs Auggy, creates an agent, and opens a project whose own source
shows startup, composition, the HTTP endpoint, and the actual model/tool loop.
They can add a custom capability, trace it into domain logic, locate the exact
installed built-in implementation, and change application behavior by editing
their files. Central YAML remains the single enabled-augment configuration.

This turns M3's working reference into the default authoring experience. It does
not reopen the [accepted ownership ADR](../adr/2026-11-12-inspectable-agent-application.md).
Built-ins and guarded runtime operations remain dependency-managed; application
orchestration and custom business adapters are project-owned.

Planning evidence is frozen at M3 candidate
`ba16ce3a8be1f5ef8ec36e43c79889c3feecc250` on `feat/inspectable-application`.
At planning inspection, [PR #227](https://github.com/looselyorganized/auggy/pull/227)
is open and main is `209185d0e7481b4ff5d3b4c87e3447e7583b2fef`.
The candidate is not an accepted main baseline. Its
[M3 evidence](./milestone-3-evidence-2026-11-13.md) is supporting evidence, not
permission to skip verification after merge.

**G0:** before M4 implementation, obtain implementation authorization, complete
the reviewed M3 merge, verify the resulting main and required checks, and record
the exact SHA/tree, lock hash, toolchain and source differences from this planning
candidate. Reconcile these contracts if that difference changes their assumptions.
Start an isolated implementation branch from that main. Preserve the original
dirty checkout and all experiment worktrees. No experiment supplies the baseline.

This planning branch, `docs/milestone-4-execution-plan`, is separate from PR #227.
No Auggy version bump, npm publication, repository-wide cleanup or worktree
retirement is included. Publication remains a release-PR activity.

## Contract packet and decisions

Read this map, then the task-specific contract; do not give every worker the whole
repository as an undifferentiated prompt.

| Contract | Decisions and consumer |
| --- | --- |
| [C1 — authoring](./milestone-4-contracts/authoring.md) | Generated tree, real recipe, command behavior, central document API, custom and credential writers |
| [C2 — migration](./milestone-4-contracts/migration.md) | Supported inputs, preview/apply, identity/path preservation, publication and recovery |
| [C3 — inspection](./milestone-4-contracts/inspection.md) | Passive CLI path, declared report, installed source index, incomplete/error behavior |
| [C4 — acceptance](./milestone-4-contracts/acceptance.md) | Installed generated-project oracle, scenario matrix, evidence and certification |

These are reviewed planning contracts. M4-00 records their accepted
revision before dependent implementation; changes then require a root decision,
consumer notification, fixture update and a focused re-review.

Locked recommendations for that review:

1. Four small executable files: `src/index.ts`, `agent.ts`, `http.ts`, `turn.ts`.
   The turn file contains the real guarded-operation recipe, not a hidden-loop call.
2. `agent.yaml` owns the enabled graph and application declaration. No new
   `definition.ts` registry, builtin wrappers, or builtin source copies.
3. New custom TypeScript lives in `src/augments/<slug>/`. The existing root
   `skills/` remains the only mounted skill surface; an optional custom skill has
   a documented pointer from its module.
4. `inspect` describes declarations and verified source navigation without
   evaluating project code. `routes` remains explicitly executable inspection.
5. Migration previews by default, converts configuration without changing
   execution mode, and adopts application source only with `--application`.
6. `init` refuses generated-file collisions. M4 does not merge an agent into an
   existing Next.js package; creating a sibling service is the recommended remedy.
7. Augment removal unregisters only. It preserves source, skills, data, credentials
   and dependencies, and explains that retained skills remain model-visible.
8. Installed acceptance starts with actual `auggy create` output. No reference
   application is copied over it to make tests pass.

## Generated project and execution path

```text
support-agent/
├── agent.yaml                  # central configuration + application contract 1
├── package.json                # local dependencies; start/dev/typecheck/test
├── bun.lock                    # produced by successful installation
├── tsconfig.json
├── README.md                   # endpoint → handler → turn → augment walkthrough
├── .env.example                # placeholders
├── .env                        # private, ignored; never model-visible
├── .gitignore
├── identity.md
├── learned-behaviors.md
├── src/
│   ├── index.ts                # exported main + direct execution guard
│   ├── agent.ts                # compose configured augments with local turn
│   ├── http.ts                 # POST /agent/run → guarded request adapter
│   ├── turn.ts                 # actual inference/tool control flow
│   └── augments/
│       └── README.md           # augment create instructions
├── tests/
│   └── application.test.ts     # executable recipe edge cases
├── skills/                     # selected bundled/user-owned instructions
├── data/                       # mutable state, created when needed; ignored
└── node_modules/               # installed and ignored
    ├── auggy/src/
    │   ├── application/
    │   ├── kernel/
    │   ├── augments/
    │   ├── transports/
    │   └── metadata/source-index.json
    └── @auggy/<selected-provider>/
```

The tree shows ownership, not a promise that empty state directories or a lockfile
exist before installation. Selected features may add existing knowledge/skill
assets. No sample business augment is silently enabled by fresh creation.

After `auggy augment create orders --with-skill`:

```text
src/augments/orders/{index.ts,schemas.ts,service.ts,README.md}
tests/augments/orders.test.ts
skills/orders/SKILL.md
agent.yaml                     # one inline custom declaration
```

```text
message → POST /agent/run
  → project src/http.ts
  → installed adapter authenticates, validates and owns durable delivery
  → configured agent admits/schedules/restores the thread
  → project src/turn.ts selects inference/tool steps
  → installed guarded operation authorizes and invokes augment adapter
  → project/custom or installed/builtin schema + domain logic
  → runtime settles accounting/history/hooks; HTTP adapter streams/replays result
```

`src/index.ts` starts that host; `src/agent.ts` binds the local recipe using
`configured.compose`. Every supported application launch executes those files.
Dependency upgrades never regenerate them. TypeScript is trusted application
code, not a security sandbox; deterministic authorization stays in maintained
runtime operations and narrow augment adapters.

## Findings that determine scope

All source paths below refer to the frozen candidate. M4-00 verifies them against
merged main and completes the reader/writer inventory before assignments.

| Existing surface | Evidence | Required change or preservation |
| --- | --- | --- |
| Create and init | `src/cli/commands/create.ts`, `cli-program.ts` | Interactive-only; writes referenced YAML. Generate owned application and inline graph; add deterministic automation flags |
| Existing-directory publishing | `create.ts` checks `agent.yaml`, then recursive `cpSync` | Preflight all destinations; no overwrite of package/source/env/skills |
| Manifest | `scaffold-package-json.ts` | Preserve selected dependencies and security overrides; add public-API typecheck and local scripts |
| Current loader | `config-parser.ts`, `loadAugmentFolderEntry` | Supports inline and referenced forms; interpolates env/defaults. Reuse schema meaning, not resolved output, for authoring |
| Add/create/install/remove | `commands/add.ts`, `commands/augment.ts`, `scaffold-custom-augment.ts` | Consolidate central writers; stop destructive removal and force overwrites |
| Credential setup | `commands/agentmail.ts` | Rejects inline today; preserve credential locks/CAS/shared-consumer rules while adapting configuration ownership |
| Skills | `scaffold-skills.ts`, `augment-resolver.ts` | Root skills are mounted; copying currently overwrites. Preserve existing owned skills |
| Inspection | `commands/routes.ts`, `route-inspector.ts` | Imports and boots augments; cannot be reused for passive inspection |
| CLI import graph | `index.ts`, `cli-program.ts`, `augment-resolver.ts` | Full program imports builtin implementations eagerly; passive commands need a pre-dispatch path |
| Runtime selection | `project-runtime.ts`, `command-bootstrap.ts` | Exact project-local package selection and capability checks already exist; preserve launch behavior |
| Installed proof | `release-smoke/application-install.ts` | Copies reference app; needs a generated-project adoption path |
| Deployment | `deploy/bundle.ts`, `deploy/dockerfile.ts` | Carry new source, retain secret/state exclusions and local runtime selection |

Inventory also covers MCP configuration, doctor/setup guidance, `yaml-helpers.ts`,
`augment-metadata.ts`, builder skills, `auggy-self-augment.ts`,
`scaffold-knowledge.ts`, console integration copy and release fixtures. Existing
legacy fixtures remain intentionally available for compatibility tests.

Ollama installed-model discovery already exists. Preserve it, including bounded
failure and credential transport, rather than claiming a new implementation.
The resolver supports non-picker built-ins such as `skills` and `supabaseMemory`;
source navigation must cover them too.

## Work packages and exclusive ownership

Root is the CTO/orchestrator: freeze contracts, arbitrate shared changes, integrate
reviewed work, own gate state and certify outcomes. Specialists own bounded
implementation and producer evidence. A producer cannot accept their own task.
At most three specialists run concurrently, plus root.

All paths below are relative to the implementation worktree. New names are planned
ownership boundaries, not claims that files already exist. Root reserves
`src/types.ts`, `src/cli/types.ts`, `config-parser.ts`, `safe-write.ts`,
`cli-program.ts`, `index.ts`, `command-bootstrap.ts`, `launch-command-options.ts`,
`resolve-config.ts`, `project-runtime.ts`,
root/provider manifests and locks, `scripts/prepack.ts`, shared release harness,
CI/inventory and status documents. Specialists submit requested patches for those
files; root integrates sequentially. No simultaneous ownership of the same file.

| ID / role | Deliverable and exclusive write set | Dependencies / proof |
| --- | --- | --- |
| M4-00 / root + architect | Accepted main, inventory, contract/schema fixtures, ownership reservations, measured pre-change trace tasks | G0; C1–C4 frozen |
| M4-01 / configuration engineer | Pure raw-document/planned-mutation API; bounded safe file publication; new `src/cli/authoring/{document,mutation,publication}*` and focused tests | 00; A04/A10/A11/A12 primitives |
| M4-02 / application DX engineer | Create/init, `scaffold-package-json.ts`, new `scaffold-application.ts`, packaged `src/scaffold-templates/application/`, create/template tests | 01; A01–A05, A12, A15 |
| M4-03 / augment authoring engineer | `commands/add.ts`, `commands/augment.ts`, `scaffold-custom-augment.ts`, `scaffold-skills.ts`, `augment-metadata.ts`, matching tests | 01; A06/A07; package helper changes requested from 02/root |
| M4-04 / migration engineer | `commands/migrate.ts`, new `src/cli/authoring/migration*`, legacy fixture corpus and failure/recovery tests | 01 + accepted template interface from 02; A10–A13 |
| M4-05 / credential security engineer | `commands/agentmail.ts`, AgentMail configuration fixtures/tests; central-inline setup with old security semantics | 01, 03; A17 and operational legacy regression |
| M4-06 / inspection engineer | `commands/inspect.ts`, `authoring/inspection*`, source-index generator/schema/JSON, catalog source metadata and inspection tests | 01; A08/A09/A16; root owns pre-dispatch/prepack hooks |
| M4-07 / harness engineer | New `scripts/release-smoke/authoring-{suite,consumer,inspection,migration}.ts`, focused `tests/scripts/authoring-*` | Preparation after 00; final installed acceptance after 02–06 and 08; all A rows |
| M4-08 / documentation engineer | Public guides, builder assets, `auggy-self-augment.ts`, setup hints and generated README copy; map current/legacy behavior | 02–06; A16; 02 temporarily hands template README ownership over |
| M4-09 / independent adversarial reviewer | Read-only findings against frozen integrated head; reproduction commands and severity/disposition | 02–08 producer completion; C4 attack list |
| M4-10 / root certification | Reviewed fixes, exact artifact/run evidence, required CI, final PR description and handoff | 07–09 accepted; no unresolved blocking findings |

M4-01 supplies a CLI-local type API (not public runtime types) for raw declaration
provenance, redacted plans and preconditioned mutations. M4-02 exposes a pure
application-template planner consumed by migration. M4-06 supplies a pure report
builder and shared passive command grammar consumed by root. Freeze these small
interfaces and compile fixtures in 00; no framework-sized abstraction.

The harness may prepare fixtures and negative controls after 00 without waiting
for product completion. This does not make its acceptance ready. Its ledger
records preparation dependencies separately from acceptance dependencies.

For M4-01–06/08, acceptance IDs identify contributions to milestone outcomes.
Accepting a producer means independent review and its focused, scoped evidence
passed; it does not mark the full installed row passed. M4-07 consumes accepted
producer interfaces and certifies installed scenarios after documentation is
final. M4-10 alone accepts the whole milestone against final artifacts and CI.
This avoids a circular dependency in which a producer waits for the harness
that is itself waiting for the producer; unit evidence never substitutes for
the later installed outcome.

## Execution waves and review gates

1. **G0 / M4-00:** verify main, accept contracts, fixtures and ownership map;
   record pre-change developer trace tasks. No producer starts from an open PR.
2. **Foundation:** M4-01 implements the pure document and publication primitives;
   M4-07 prepares bounded acceptance fixtures. Independent review validates raw
   versus effective configuration and failure semantics before consumers land.
3. **First producers:** M4-02, M4-03 and M4-06 run in independent scopes. Root
   adds command/bootstrap/prepack integration from reviewed small patches.
4. **Dependent producers:** M4-04 and M4-05 integrate accepted templates/writers;
   M4-07 adapts generated-output execution once its prerequisites land. Root
   resolves shared-file changes and preserves three-specialist capacity.
5. **Product closure:** M4-08 aligns docs/teaching after CLI contracts stabilize;
   M4-07 completes installed proof. Reviewer checks producer patches as they
   become available, then M4-09 reviews the frozen integrated result.
6. **Certification:** producers fix findings in their scopes; independent reviewer
   rechecks. Root runs required suites, records exact identities, opens the scoped
   PR and hands off the result. Merging and publication are separate gates.

Use separate commits per producer and reviewed repair. Isolation can use clean
worktrees or exclusive file ownership; neither permits unreviewed cross-task
edits. A blocked consumer reports its exact missing contract and continues only
independent preparation. The root ledger alone changes `ready → in_progress →
review → accepted`; implementation is never inferred from a planning document.

## Assignment prompt for every specialist

Root fills this template with task-specific detail from the ledger:

```text
Role: <specialization>; task: <M4-ID>; orchestrator: CTO / AI Engineering Lead.
Objective: <one observable engineer-facing outcome>.
Baseline: <accepted main SHA/tree>, current integration SHA, contract revision.
Read: AGENTS.md, ownership ADR, this task's C-contract and named source owners.
Write only: <exclusive files>; reserved/shared files: <root-owned list>.
Dependencies: <accepted producer SHAs>; preparation-only work: <if applicable>.
Deliver: implementation, meaningful fixtures, acceptance IDs, redacted evidence.
Preserve: public runtime/security/lifecycle semantics and legacy support stated
in the contract. Use Bun tests. No kernel change without a concrete boundary bug.
Do not: vendor builtins, add another enabled graph, import code for static inspect,
weaken required checks, publish/bump, overwrite user files, or expand M5/M6 scope.
Escalate: contract conflict, needed shared-file edit, missing accepted dependency,
unsafe preservation case, or new security/compatibility finding. Propose a small fix.
Handoff: commit/diff, files, tests and commands, artifact IDs, acceptance outcomes,
known limitations, failed attempts and cleanup. Passing producer tests is not acceptance.
```

Reviewers receive the contracts, frozen producer/integration diff and evidence,
with a mandate to disprove acceptance. They do not repair their own review target
while serving as its independent reviewer. Root assigns repairs back to producers
and requests a recheck of the same failure plus its regression control.

## Definition of done

Every [acceptance row](./milestone-4-contracts/acceptance.md) has a concrete command,
observable assertion, failure control and evidence identity. In particular:

- Actual packed create → install → inspect → authenticated HTTP turn → custom
  extension works outside the repository, with untouched generated bytes recorded.
- Visible application edits change execution under all supported M3 launch paths.
- Legacy conversion preserves identity, paths, state and source, and interrupted
  writes/rollback cannot silently clobber subsequent edits.
- Inline authoring works for ordinary augments and AgentMail setup; revoked
  credentials/visitor operations do not require migration as a precondition.
- Passive inspection stays passive through the binary's actual import graph and
  reports the selected installed source, including partial/unavailable cases.
- Required runtime, console, inventory, package, strict audit, M3 release,
  PostgreSQL 17 and both CodeQL analysis/findings gates pass. No bypass or reduction.
- User-facing docs teach the actual scaffold. No claim of measured human DX
  improvement before M6's external-engineer exercise.

M4 demonstrates inspectability mechanically: visible source runs, navigation
exists, edits affect behavior, and source ownership survives an artifact change.
It prepares the baseline and tasks for later human measurement; test counts alone
do not establish ease of use.

## Scope boundaries and subsequent milestones

M5 remains a standalone Auggy service beside a Next.js frontend: authenticated
streaming, explicit tenant isolation, deployment/persistence and recovery on
Railway. Generic Docker product work belongs to that integration/release tranche;
M4 only preserves existing bundle/start contracts with the new source layout.

M6 owns supported version upgrades, breaking-change guidance, edited application
migration/codemods where warranted, and measured unfamiliar-engineer traceability.
M4's artifact A/B preservation check is not full production upgrade certification.

No new runtime package, public client SDK, provider, frontend redesign, PostgreSQL
enablement, universal migration framework, arbitrary TypeScript static evaluator
or automatic custom-source relocation is part of M4. Scope additions require a
concrete failure of an M4 acceptance row and a root decision.

## Harness guidance applied

Use the repository as the durable handoff: a short map, focused contracts,
machine-readable task state, evidence and mechanically checked ownership boundaries.
This applies the practices described in OpenAI's
[Harness engineering](https://openai.com/index/harness-engineering/), rather than
depending on a worker remembering an earlier chat.

Bounded tasks, explicit feature acceptance, incremental commits and actual
end-to-end checks address premature completion and lost context, as described in
Anthropic's [Effective harnesses for long-running agents](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents).
Delegate independent scopes with precise objectives, inputs, outputs and review
feedback; do not parallelize shared writes. That applies the coordination lessons
in [How we built our multi-agent research system](https://www.anthropic.com/research/multi-agent-research-system)
without treating research-task results as a performance guarantee for coding.
