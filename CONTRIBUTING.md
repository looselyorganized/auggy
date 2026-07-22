# Contributing to Auggy

Thanks for taking a look. Auggy is currently in public-preview development with
private source collaboration. This document covers what invited collaborators
need to know to land a change.

## Before you start

Read these in order:

1. [`README.md`](README.md) — what Auggy is and how to run an agent.
2. [`docs/02-architecture-overview.md`](docs/02-architecture-overview.md) — module map and turn data-flow.
3. [`docs/07-built-in-augments.md`](docs/07-built-in-augments.md) — what each built-in augment does and the bundled-skill convention.
4. [`CLAUDE.md`](CLAUDE.md) — repo rules. Particularly the **kernel-is-finished** rule.

## Development setup

Auggy runs on Bun. There is no Node.js fallback.

```bash
# 1. Clone and install
git clone <private-auggy-repo-url>
cd auggy
bun install

# 2. Local CLI
bun link                 # makes `auggy` available globally

# 3. Static checks + tests
bun run typecheck
bun run lint
bun test

# 4. Run the demo agent (requires ANTHROPIC_API_KEY)
cp .env.example .env     # add your key
bun run scripts/hello.ts
```

Required versions: **Bun ≥ 1.2.0**, **TypeScript ≥ 5**.

## What to work on

- **Behavior changes go in augments**, not the kernel. The kernel under `src/kernel/` is finished — bug fixes are welcome, new features need explicit justification in the PR description. (See [CLAUDE.md](CLAUDE.md) rule 1.)
- **New built-in augments** are welcome under `src/augments/` — see existing augments as templates and read [`docs/07-built-in-augments.md`](docs/07-built-in-augments.md) for the contract.
- **Engine adapters** belong in `packages/<provider>/`. Shared adapter helpers
  and pricing tables can live under `src/engines/`; do not create `src/models/`.
- **Tests** go alongside code under `tests/` mirroring the source layout. Use `bun:test` (never `vitest`).

## Coding conventions

- **TypeScript strict mode is on.** No `any`, no `@ts-ignore`. If you genuinely need an escape hatch, justify it inline.
- **Public runtime contracts live in `src/types.ts`.** Module-local and
  implementation-only types may stay with the code that owns them.
- **Prefer factories and plain functions.** Avoid stateful classes unless an
  external SDK contract requires one.
- **A2A-shaped types are load-bearing** (`Part[]`, `TaskState`, `AgentCard`). Don't drift the shapes even if v1 doesn't speak A2A on the wire.
- **Skills are files, not code.** The runtime publishes frontmatter summaries
  for discovery; full `SKILL.md` bodies and references are read on demand.

If you've read the rule list in [CLAUDE.md](CLAUDE.md), you've seen all of this.

## Bundled skills convention

Per ADR-025 (`augment-folder-and-skill-bundling`), every built-in augment is a folder under `src/augments/<name>/`. If your augment contributes model-callable tools, ship a bundled skill alongside the factory:

```
src/augments/<name>/
├── index.ts                # the augment factory
└── skill/
    ├── SKILL.md            # YAML frontmatter (name, description) + body
    └── references/         # optional deep docs the model loads on demand
```

- **Frontmatter is required** (`name`, `description`) — matches the [agentskills.io](https://agentskills.io/home) OSS convention so the skill is byte-for-byte interchangeable with third-party skill folders.
- **SKILL.md content:** tool inventory + when-to-use guidance + common pitfalls. Roughly 100–200 lines per skill is the norm — `src/augments/filesystem/skill/SKILL.md` is the template shape.
- **Operator-friendly framing.** No internal type names, kernel hooks, or factory function names exposed in skill content. Identity.md security rule 3 ("don't disclose internal architecture") applies — skills get loaded by the model and must read like operator docs, not implementation notes.
- **Scaffold copies it.** `auggy create` and `auggy augment add` copy
  `src/augments/<name>/skill/` into `<agent-dir>/skills/<name>/`. `auggy skill
  add <name>` re-installs it post-scaffold.
- **Boot-time validator.** `src/cli/skill-validator.ts` warns at agent startup if a tool-providing augment is mounted without a skill — applies to factory-declared `tools[]` AND namespace memory providers (kernel-synthesized `memory_*` tools).
- **Tool-less augments may skip the skill folder.** Memory providers without tools, transports, and admission gates contribute only `context()` blocks — no model-callable tools, no skill required.

## Background work hooks (ADR-027)

Two optional augment fields enable post-turn background work. Use these when your augment needs to do something after a user-facing turn completes — extraction, consolidation, outbox sync — and that work may itself need to run an LLM call or write to storage.

### `Augment.scheduleAfterTurn?(result, ctx)`

Fires after `onTurnEnd` has run for the just-completed user-facing turn. Receives:

- `result: TurnResult` — the outcome of the turn (success/failure, turnId).
- `ctx: SchedulerContext` — two capabilities:
  - `ctx.inject(trigger)` — admit a follow-up internal turn through the full turn-loop machinery (admission, budgets, lifecycle hooks, cost commit). Returns the resulting `TurnResult`.
  - `ctx.getCompletedTranscript()` — retrieve the just-completed turn's transcript snapshot (peer, parts, tool calls). Returns `null` if the turn was compacted before the hook ran.

Errors from this hook are caught and logged; they never block the user-facing turn or affect the peer's response. Background work is best-effort.

**When to use:** post-turn work that reads the just-completed transcript and may need to inject a follow-up internal turn. Examples: fact extraction after a conversation turn, outbox flush triggered by turn completion.

```ts
const myAugment: Augment = {
  name: "my-augment",
  scheduleAfterTurn: async (result, ctx) => {
    const transcript = await ctx.getCompletedTranscript();
    if (!transcript) return; // compacted — skip gracefully
    // decide whether to act, then optionally inject a follow-up turn
    await ctx.inject({
      type: "internal",
      source: "my-augment.some-work",
      peer: transcript.peer,
      // ... other fields
    });
  },
};
```

### `Augment.handleInternalTurn?(trigger, ctx)`

When the kernel dispatches a turn whose `trigger.type === "internal"`, it walks the augment list in declaration order calling `handleInternalTurn` on each augment that defines it. The **first augment to return a non-null `TurnResult`** owns the turn — the standard model-engine inference loop is bypassed and the returned result is the turn's outcome. Augments that do not recognize the trigger **must return `null`** so dispatch continues to the next augment.

Use `trigger.source` as the routing key — by convention use a dotted prefix matching your augment name (e.g. `"my-augment.some-work"`) to avoid cross-augment collisions.

**Cost-flow contract:** if your handler makes an LLM call, the cost of that call must flow through the turn's `TurnResult.trace.inferenceSteps[]` so `runCostCommit` aggregates it into the budgets store. In-handler costs that bypass this path silently break daily-budget accounting. See ADR-027 (`internal-turn-admission`) Decision 5 for the two valid cost-reporting shapes.

**When to use:** when your augment emits internal triggers via `ctx.inject` and needs to run a custom execution body for those triggers (a different prompt, a different model, specialized output handling) rather than the standard model-engine inference loop.

```ts
const myAugment: Augment = {
  name: "my-augment",
  handleInternalTurn: async (trigger, ctx) => {
    if (trigger.source !== "my-augment.some-work") return null; // not ours
    // run the work; build and return a TurnResult with cost in trace
    return { turnId: trigger.turnId, success: true, /* ... */ };
  },
};
```

**Recursion guard:** a handler for `"my-augment.some-work"` must not emit another `"my-augment.some-work"` trigger via `ctx.inject` during its own execution.

## Commit style

We use [Conventional Commits](https://www.conventionalcommits.org/). The recent log is the source of truth for examples:

```
feat(budgets): BATS-style budget-aware preamble injected per turn
fix(visitor-economics): four post-implementation hardening fixes
refactor(engines): per-adapter pricing modules + CostResult discriminated union
docs(readme): refresh badges + augments table for v0.2.0 visitor-economics work
test(transport): cover four-path identity resolution
```

Scopes match top-level source areas: `kernel`, `memory`, `transport`, `engines`, `cli`, plus augment names (`layered-memory`, `budgets`, `bash`, `manifest`, `web-fetch`).

## Pull request checklist

Before requesting review:

- [ ] `bun test` passes.
- [ ] `bun run typecheck` is clean.
- [ ] `bun run lint` is clean.
- [ ] If you changed behavior documented in `docs/`, the doc is updated in the same PR.
- [ ] If the change crosses a public surface (new augment, new tool, new engine), a test exercises it.
- [ ] Commit messages follow the convention above.

We squash-merge by default. Keep your PR description sharp — that's what becomes the merged commit.

## Security eval (paid integration tests)

The portable security suite at `packages/evals/src/security/` runs against a real Anthropic API call per case (see [`packages/evals/src/security/README.md`](packages/evals/src/security/README.md) for the full contract). Each run costs roughly $0.07 on Haiku.

**The CI workflow does NOT auto-trigger on pull requests.** This is deliberate — to avoid burning maintainer API budget on every contributor push. The workflow runs on three explicit channels:

- `workflow_dispatch` — maintainers click "Run workflow" against any branch from the Actions tab to verify a PR before merging.
- `push: main` — runs once after every merge to catch regressions.
- `schedule` (nightly, 07:00 UTC) — catches model behavior drift between merges.

**If your PR touches eval-relevant code** (kernel turn-loop, augment refusal logic, identity preamble, fixture composition, suite YAML, eval-context module, or anything under `src/augments/*`, `src/scaffold-templates/*`, `src/cli/scaffold*.ts`, `src/cli/skill-*.ts`) — see ADR-029 (`eval-as-canary-for-prompt-shape-changes`) for the full canary discipline:

1. **Run the suite locally before opening the PR:**
   ```bash
   ANTHROPIC_API_KEY=... auggy eval                            # default fixture, full suite
   ANTHROPIC_API_KEY=... auggy eval --suite security-only      # skip benign counterparts
   ANTHROPIC_API_KEY=... auggy eval my-agent                   # against a registered agent
   ```
   The underlying script is still `bun run packages/evals/src/security/run.ts`; `auggy eval` is a thin wrapper that resolves the agent.yaml path from the agent index (or the bundled fixture) and forwards the same flags.
2. **Or:** configure `ANTHROPIC_API_KEY_SECURITY_EVAL` in your own repository's
   GitHub secrets (Settings -> Secrets and variables -> Actions), and add the
   trigger you want to your copy of `.github/workflows/security-eval.yml`. Your
   CI, your spend.
3. Mention in your PR description that you've run the suite and it passes.

Maintainers will dispatch the eval against your PR's branch via `workflow_dispatch` if review surfaces eval-relevant changes that weren't locally verified.

## Cost guardrails (deploying Auggy)

**If you're deploying Auggy to run an agent of your own — especially on Railway or any always-on cloud surface — you are responsible for setting a provider-side spend cap.** This is the hard limit on how much your agent can spend per day. Auggy's runtime `dailyBudgetUsd` (in the budgets augment) is a soft cap that catches most overshoots gracefully; the provider cap is the backstop that fires regardless of any Auggy configuration error or runtime bug.

Configure your cap in the relevant console:

- Anthropic: <https://console.anthropic.com/settings/limits>
- OpenAI: <https://platform.openai.com/settings/organization/limits>
- OpenRouter: <https://openrouter.ai/settings/credits>

When the provider cap fires, the engine adapter surfaces a clear operator-actionable message ("provider spend cap reached — increase or wait for reset in your console"). This is the v1.0 cost-cap architecture per ADR-024 (`kernel-surface-v1-lock`). See [`docs/07-built-in-augments.md` § Cost-cap architecture](docs/07-built-in-augments.md) for the runtime soft cap details.

## Filing issues

During private-preview source collaboration, use the shared issue tracker only
if you have repo access. Bugs need a reproduction. Feature requests need a use
case.

For security issues, **do not open a public issue.** See [SECURITY.md](SECURITY.md).

## Releasing (maintainer notes)

Maintainers should follow [`docs/RELEASING.md`](docs/RELEASING.md). Feature PRs
do not bump package versions; the release PR is the only place that moves
`package.json` and the workspace package versions.
