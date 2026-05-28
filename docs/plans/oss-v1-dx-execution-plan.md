# OSS v1 DX Execution Plan

Date: 2026-05-28
Status: Draft, implementation-ready
Owner: Auggy maintainers

## Purpose

Auggy's runtime architecture is strong enough for OSS v1. The release risk is
developer experience: a new operator must be able to create, configure, run,
extend, and deploy an agent without learning the internals first.

This plan breaks the v1 DX work into small, testable implementation units.
Each unit should be independently shippable and improve a real user journey.

## Target Experience

The primary local happy path should be:

```bash
npm i -g auggy
auggy create my-agent
auggy run my-agent
```

The command should end in a browser at `/console/chat`, or in one precise
operator action such as adding `ANTHROPIC_API_KEY` to the agent's `.env`.

The primary deploy path should be:

```bash
auggy deploy my-agent
```

The command should either finish with a working public URL or print a clear
recovery path, including logs.

## Principles

- Optimize for "chat with Auggy first, customize after."
- Use user-facing command names for outcomes, not internal architecture.
- Make repair commands available, but keep them out of the happy path.
- Install augments and their bundled skills together by default.
- Keep each PR small enough to verify with focused tests.
- Prefer actionable diagnostics over raw parser or runtime errors.

## Non-Goals For This Plan

- Redesigning the kernel.
- Replacing Bun.
- Adding non-Railway deploy targets.
- Building a multi-agent dashboard.
- Shipping a full docs site.

## Phase 1: First-Run Path

### 1. Add `auggy run <name>` *(implemented 2026-05-28)*

Behavior:

- Public happy-path command.
- Equivalent to `auggy dev <name> --open`.
- Supports `--config <path>`.

Likely files:

- `src/cli/index.ts`
- `src/cli/commands/dev.ts` only if shared naming needs cleanup
- `tests/cli/commands/run.test.ts` or equivalent

Tests:

- Commander registers `run`.
- `run` calls the same driver as `dev` with `open: true`.
- `--config` is forwarded.
- Errors use the same handling as `dev`.

Acceptance:

- `auggy run zip` boots and opens `/console/chat` when `webTransport` exists.
- README quickstart can use `create -> run`.

### 2. Improve Missing Environment Variable Diagnostics *(implemented 2026-05-28)*

Behavior:

- Missing env errors include the agent `.env` path.
- Output says which keys are missing and what to do next.
- Empty placeholder values remain missing.

Likely files:

- `src/cli/config-parser.ts`
- `src/cli/commands/dev.ts` if command-level formatting is cleaner
- `tests/cli/config-parser.test.ts`

Tests:

- Missing provider key reports the exact `.env` path.
- Multiple missing vars are listed once.
- Empty `KEY=` placeholders are treated as missing.
- Shell-exported env vars still take precedence over `.env`.

Acceptance:

- First boot with an empty `.env` tells the operator exactly where to add the
  key and which command to run next.

### 3. Add `auggy doctor <name>` *(implemented 2026-05-28)*

Behavior:

- Runs local readiness checks before boot or deploy.
- Checks config parsing, env vars, package manifest, agent-local deps, port
  availability, selected provider key, and bundled skills.
- Prints pass/fail rows with fix commands.

Likely files:

- `src/cli/commands/doctor.ts`
- `src/cli/index.ts`
- Shared helpers around config/deps may belong under `src/cli/doctor/`
- `tests/cli/commands/doctor.test.ts`

Tests:

- Healthy scaffold passes.
- Missing `package.json` fails with a re-scaffold/manual manifest fix.
- Missing engine adapter in `node_modules` fails with `cd <agentDir> && bun install`.
- Missing env vars fail with `.env` path.
- Occupied port fails with process/port guidance.
- Missing bundled skill warns or fails according to severity policy.

Acceptance:

- `auggy doctor zip` is the first suggested command when setup is unclear.

## Phase 2: Create Defaults And Output

### 4. Define The v1 Default Profile

Behavior:

- Fresh agents should be chat-ready with zero optional architecture choices.
- Default profile:
  - identity shorthand
  - learned file memory
  - `webTransport`
  - `filesystem`
  - `skills`
  - `turnControl`
  - `budgets`
  - `webFetch`
- `layeredMemory` should be optional unless background extraction is proven
  zero-surprise for first run.

Likely files:

- `src/cli/commands/create.ts`
- `src/cli/augment-catalog.ts`
- `src/cli/scaffold.ts`
- `tests/cli/create-installs-deps.test.ts`
- `tests/integration/create-then-resolve.test.ts`

Tests:

- Default create includes the expected augment set.
- `.env` includes generated web token and agent id.
- `.env` asks only for the selected provider key plus selected optional augment
  secrets.
- Bundled skills are copied for selected tool-providing augments.
- Optional profile selections still work.

Acceptance:

- A fresh agent can chat after adding one provider key.

### 5. Clean Create Output

Behavior:

- End-of-create output emphasizes the next action.
- Install failure is fail-soft and prints a retry command.
- Internal concepts are avoided in the final success message.

Likely files:

- `src/cli/commands/create.ts`
- `tests/cli/create-installs-deps.test.ts`

Tests:

- Success output includes `auggy run <name>`.
- Missing provider-key next step is shown when relevant.
- Failed install output includes retry command and does not remove scaffold.

Acceptance:

- A new operator knows exactly what to do after `create`.

## Phase 3: Augment Install UX

### 6. Support `auggy add <agent> <augment>` *(implemented 2026-05-28)*

Behavior:

- Non-interactive add path for a single augment.
- Existing interactive checkbox remains when augment is omitted.
- Add mutates YAML, copies bundled skill, updates package deps, runs install
  when needed, and prints restart/run guidance.

Likely files:

- `src/cli/index.ts`
- `src/cli/commands/add.ts`
- `src/cli/augment-catalog.ts`
- `tests/cli/add-installs-deps.test.ts`
- `tests/cli/commands/add.test.ts`

Tests:

- `auggy add zip web-fetch` mutates `agent.yaml`.
- Bundled skill is copied.
- Package deps are merged when needed.
- `bun install` runs only when deps changed.
- Unknown augment prints valid choices.
- Existing interactive flow still works.

Acceptance:

- Common augment adds do not require a checkbox wizard.

### 7. Add Human-Friendly Augment Aliases *(implemented 2026-05-28)*

Behavior:

- Operators can use kebab-case and product names:
  - `web-fetch` -> `webFetch`
  - `visitor-auth` -> `visitorAuth`
  - `telegram` -> `telegramTransport`
  - `memory` -> `layeredMemory`
  - `agent-mail` -> `agentMail`
- Canonical YAML type names remain unchanged.

Likely files:

- `src/cli/augment-catalog.ts`
- `src/cli/commands/add.ts`
- `tests/cli/augment-catalog.test.ts`

Tests:

- Each alias resolves to one catalog entry.
- Ambiguous aliases fail cleanly.
- Unknown aliases include suggestions.

Acceptance:

- Public CLI examples use friendly names.

### 8. Reframe `add-skill` As Repair *(implemented 2026-05-28)*

Behavior:

- Keep `auggy add-skill`.
- Help text and docs describe it as a repair/update command, not part of
  normal augment installation.

Likely files:

- `src/cli/commands/add-skill.ts`
- `README.md`
- `docs/07-built-in-augments.md`

Tests:

- Existing `add-skill` tests should continue to pass.

Acceptance:

- Main onboarding docs never require manual skill install.

## Phase 4: Custom Augments

### 9. Add `auggy augment create <slug>` *(implemented 2026-05-28)*

Behavior:

- Scaffolds a local custom augment.
- Default target when run inside an agent: `./augments/<slug>/`.
- Generated augment compiles and exposes one example tool.

Generated shape:

```text
augments/<slug>/
  index.ts
  SKILL.md
  README.md
  <slug>.test.ts
```

Likely files:

- `src/cli/commands/augment.ts`
- `src/cli/index.ts`
- `src/cli/scaffold-custom-augment.ts`
- `tests/cli/commands/augment-create.test.ts`

Tests:

- Creates expected files.
- Rejects invalid slug.
- Does not overwrite without `--force`.
- Generated `index.ts` has a default export factory.

Acceptance:

- A developer can generate the skeleton for a custom capability in one command.

### 10. Add `auggy augment install <agent> <path>` *(implemented 2026-05-28)*

Behavior:

- Adds a local custom augment to an agent config.
- Uses a relative `source` path from the agent dir.
- Installs `SKILL.md` into `skills/<slug>/` when present.

Likely files:

- `src/cli/commands/augment.ts`
- `src/cli/commands/add.ts` if shared YAML mutation helpers are extracted
- `tests/cli/commands/augment-install.test.ts`

Tests:

- Adds `type: custom` with correct `source`.
- Copies skill when present.
- Does not duplicate an existing custom augment.
- Missing path fails clearly.

Acceptance:

- A custom augment can be wired into an agent without manual YAML editing.

### 11. Add `auggy augment test <path>` *(implemented 2026-05-28)*

Behavior:

- Imports the augment module.
- Calls the default factory with empty options unless `--options` is passed.
- Validates basic augment shape, duplicate tool names, and tool schemas.

Likely files:

- `src/cli/commands/augment.ts`
- `src/cli/augment-validator.ts`
- `tests/cli/commands/augment-test.test.ts`

Tests:

- Valid generated augment passes.
- Missing default export fails.
- Factory returning non-object fails.
- Duplicate tool names fail.
- Invalid tool schema fails.

Acceptance:

- Custom augment authors get feedback before booting the agent.

## Phase 5: Railway Deploy Polish

### 12. Run Deploy Preflight *(implemented 2026-05-28)*

Behavior:

- `auggy deploy` runs deploy-focused checks before staging.
- Fails before Railway work if config, deps, env, or expected deploy state are
  invalid.
- Local web port availability is skipped for deploy preflight because Railway
  deployability should not depend on a developer machine's occupied ports.

Likely files:

- `src/cli/commands/deploy.ts`
- `src/cli/commands/doctor.ts`
- `tests/cli/deploy.test.ts`

Tests:

- Missing env/config fails before `stageBundle`.
- Missing Railway CLI/auth still fails early.
- `--yes` does not skip preflight.

Acceptance:

- Deploy does not queue obviously doomed builds.

### 13. Post-Deploy Health Verification *(implemented 2026-05-28)*

Behavior:

- After `railway up`, poll `${url}/health` for a bounded window.
- Print chat, console, health, logs, and redeploy commands.
- Timeout is non-destructive and gives recovery guidance.
- Deploy still records cloud metadata on health timeout because Railway builds
  can continue booting after the CLI returns.

Likely files:

- `src/cli/commands/deploy.ts`
- `src/cli/deploy/health.ts`
- `tests/cli/deploy.test.ts`

Tests:

- Successful health check prints usable URLs.
- Timeout prints logs command.
- HTTP non-200 is retried until timeout.

Acceptance:

- Deploy ends with a working URL or a clear recovery path.

### 14. Add `auggy logs <name>`

Behavior:

- For Railway-deployed agents, shells to Railway logs using stored cloud
  metadata.
- Local-only agents fail with a clear message.

Likely files:

- `src/cli/commands/logs.ts`
- `src/cli/deploy/railway-cli.ts`
- `src/cli/index.ts`
- `tests/cli/commands/logs.test.ts`

Tests:

- Not deployed fails.
- Deployed agent invokes Railway CLI with expected project/service context.
- Missing Railway CLI/auth is reported cleanly.

Acceptance:

- Deploy recovery is one command away.

## Phase 6: Docs And Release Gate

### 15. Rewrite Quickstart Around Outcomes

Behavior:

- Quickstart documents:
  - install
  - create
  - run
  - chat
  - add an augment
  - create/install a custom augment
  - deploy

Likely files:

- `README.md`
- `docs/README.md`
- `docs/16-storage-layout.md`
- `docs/18-deploy.md`
- `docs/07-built-in-augments.md`

Acceptance:

- A new adopter can follow the docs without reading architecture first.

### 16. Add Cold-Machine Walkthrough Gate

Behavior:

- Release checklist verifies the real first-run path on a clean machine.

Checklist:

- No existing `~/.auggy`.
- Global install.
- Create agent.
- Fill provider key.
- Run and chat.
- Add one built-in augment.
- Create, test, and install one custom augment.
- Deploy to Railway.
- Open public console/chat URL.

Likely files:

- `docs/RELEASING.md`
- Optional script under `scripts/` if parts can be automated

Acceptance:

- v1 release is blocked until the walkthrough passes.

## Recommended Implementation Order

1. `auggy run`
2. Missing env diagnostics
3. `auggy doctor`
4. Non-interactive `auggy add <agent> <augment>`
5. Augment aliases
6. Create default profile cleanup
7. Custom augment create/install/test
8. Deploy preflight and health verification
9. `auggy logs`
10. Docs and release gate

This order improves the first-run path immediately while keeping larger
custom-augment and deploy work behind tested foundations.

## Open Decisions

- Whether `layeredMemory` belongs in the default profile for OSS v1.
- Whether `auggy doctor` should fail or warn on missing bundled skills.
- Whether `auggy augment install` should copy custom augment source into the
  agent dir when the source lives outside the agent.
- Whether `auggy deploy` should keep `--to railway` in docs or make Railway an
  implicit v1 default.
