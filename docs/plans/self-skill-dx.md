# Self-Skill DX Plan

Status: proposal.

## Problem

Fresh Auggy agents ship with `skills/auggy/SKILL.md`, a starter guide intended
to help the creator ask the agent how to customize itself. The current guide is
useful, but it is mostly a static command reference. It can answer common
questions, yet it cannot reliably ground those answers in the agent's actual
runtime state.

The result is a leaky first-run experience:

- A creator can ask "what can you do?" and receive a generic answer instead of
  an installed-capability inventory.
- A creator can ask "I want to do X with Auggy" and receive command snippets,
  but not a structured diagnosis of whether X needs identity, a skill,
  knowledge, an augment, MCP, memory, auth, notify, deploy, or a custom route.
- The skill tells the model to inspect `agent.yaml` and augment configs, but a
  fresh scaffold only mounts `skills/` read-only and `data/workspace/`
  read/write. The model normally cannot read `agent.yaml`, `augments/*`, or
  `.mcp.json`.
- Widening the filesystem mount to the whole project would expose `.env` and
  other sensitive files unless we add a careful allowlist.

## Current Architecture

The relevant pieces are:

- `src/scaffold-starter-skills/auggy/SKILL.md` is copied into every new agent
  at `skills/auggy/SKILL.md`.
- `copyStarterSkills()` handles this copy during `auggy create` and `auggy init`.
- Built-in augment skills live under `src/augments/<type>/skill/SKILL.md` and
  are copied to `skills/<type>/SKILL.md`.
- The `skills` augment is auto-mounted when an agent has a `skills/` directory.
  It emits a system-placement manifest with each skill folder and frontmatter
  description. The full skill body is read on demand via `fs_read`.
- The default `filesystem` augment mounts:
  - `./skills` as read-only
  - `./data/workspace` as writable/deletable
- `/console/api/dashboard` already has a sanitized operator-facing inventory of
  mounted augments, runtime surfaces, tool counts, admin blocks, and skills, but
  that surface is not available to the model as a tool or context block.

## CTO Assessment

Do not solve this by making `skills/auggy/SKILL.md` huge. The project already
made the right architecture choice with progressive disclosure. A giant
boot-loaded or frequently read guide would compete with useful context and
still drift from runtime state.

Do not solve this by giving the model broad read access to the agent project
root. The model needs safe facts about the agent, not raw access to `.env`,
cloud metadata, package lockfiles, and deployment state.

The right direction is a small self-description layer:

1. Keep `skills/auggy/SKILL.md` as the model-facing coach.
2. Add a sanitized self-inspection surface that exposes what this agent is,
   what is installed, what is available, what is missing, and what the next
   setup steps are.
3. Teach the self-skill to use that surface before answering build-out
   questions.
4. Add evals for the first-run questions creators naturally ask.

This is adjacent to the future commissioning layer, but it is smaller. It does
not let the agent write code or mutate its config. It helps the creator and the
agent understand the current project and choose the next safe action.

## Target Experience

From a fresh `/console/chat`, the creator should be able to ask:

- "What are you?"
- "What can you do right now?"
- "What can I add to you?"
- "I want you to remember repeat visitors. How?"
- "I want you to answer from my docs. How?"
- "I want you to send me alerts. How?"
- "I want to connect GitHub MCP. What are the steps?"
- "Should this be a skill, knowledge, an augment, or identity?"
- "What should I configure before deploy?"

The agent should respond with:

- A concise statement of its identity and installed capabilities.
- A grounded distinction between installed, available stable, and preview
  augments.
- A recommendation for the smallest extension point that solves the user's goal.
- Exact files or CLI commands only after explaining why that path is right.
- Safety constraints: secrets in `.env`, preview augments require deliberate
  opt-in, restart after changing augments or skills, run `auggy doctor`.
- No claim that a tool or integration is currently available unless it is
  installed and surfaced by the runtime.

## Proposed Slices

### Slice 1: Rewrite the starter `auggy` skill as a diagnostic coach

Keep this as a docs-only change.

Changes:

- Reorganize `skills/auggy/SKILL.md` around creator questions, not command
  inventory.
- Add a required first move for self-build questions:
  - read the `auggy` skill,
  - inspect available mounted skills with the skill manifest,
  - use only observed tools and mounted skills,
  - if runtime state is unknown, say what cannot be verified.
- Add a decision matrix:
  - identity for durable persona/policy,
  - skill for workflow teaching,
  - knowledge for reference material,
  - augment for runtime capability,
  - MCP for external tool servers,
  - custom augment for app-specific APIs/routes,
  - visitorAuth/layeredMemory for repeat visitor continuity,
  - notify/agentMail/telegram for outbound or alternate channels.
- Add recipe cards for the top creator intents.
- Add "do not overbuild" guidance: prefer knowledge or a skill before custom
  code unless the user needs a new runtime side effect.

Acceptance:

- The skill still passes existing frontmatter/content audits.
- Fresh agent skill copy tests continue to pass.
- No runtime behavior changes.

### Slice 2: Add a safe self-inspection augment or tool surface

Add a small built-in runtime surface, likely `projectSelf` or `auggySelf`, that
exposes sanitized project facts to creator-trust turns.

Candidate tools:

- `auggy_self_info()`
  - agent name, purpose, engine provider/model, creator display name, current
    trust level, runtime version.
  - installed augments with type, category, stability, structural runtime
    surfaces, tool count, and whether a skill is installed.
  - installed skills and invalid/missing skill warnings.
- `auggy_self_catalog()`
  - stable available augments, preview available augments, and short use cases.
- `auggy_self_recommend({ goal })`
  - deterministic rule-based recommendation: identity vs skill vs knowledge vs
    augment vs MCP vs custom augment, plus CLI/file next steps.

Constraints:

- Never return secret values.
- Do not expose raw `.env`.
- Do not expose arbitrary file contents.
- Default to creator-only. Public peers should not get project internals.
- Treat preview augment recommendations as opt-in with warnings.

Implementation note:

Prefer reusing existing collectors and metadata:

- `AUGMENT_CATALOG` for stable/preview catalog entries.
- `collectAugmentSummaries()` shape for mounted runtime summary.
- `collectSkillsInfo()` for installed/missing skills.
- `ParsedConfig` for config-level identity/engine.
- `doctor` checks for "next setup" status, but summarize them without secrets.

Acceptance:

- A fresh agent can answer "what can you do right now?" from actual runtime
  state.
- Public-trust peers cannot enumerate internal project config.
- Missing skills or invalid frontmatter are visible in the self-info result.
- Tests cover creator access, public denial, secret redaction, and catalog
  stability labels.

### Slice 3: Teach the self-skill to use self-inspection

After Slice 2, update `skills/auggy/SKILL.md` again:

- Before answering "what can you do?", call `auggy_self_info()`.
- Before recommending an augment, call `auggy_self_catalog()` or
  `auggy_self_recommend({ goal })`.
- If the self-inspection tools are absent, fall back to static guidance and say
  the answer is based on the starter guide, not live config.

Acceptance:

- The skill no longer implies it can inspect files it cannot read.
- Answers are grounded in live installed state when the tool exists.
- Fallback behavior remains useful for older agents.

### Slice 4: First-run prompt and console nudges

Tune the empty-state chat prompts to activate the new experience.

Candidate prompts:

- "What can you do right now?"
- "Help me decide what to add next."
- "I want you to work with my docs."
- "I want you to remember people."

Add a compact "Build this agent" prompt group if the console design allows it,
but keep chat as the first surface.

Acceptance:

- Prompt clicks produce answers that use the self-inspection tool.
- No marketing or explainer page replaces the chat-first console.

### Slice 5: Evals for creator-buildout conversations

Add a small regression suite for the self-DX path.

Scenarios:

- Fresh agent answers "what can you do?" without claiming absent augments.
- User asks for docs ingestion; answer recommends `knowledge`, not custom code.
- User asks for repeat visitor memory; answer recommends `layeredMemory` and
  `visitorAuth` when continuity across sessions matters.
- User asks for "send me alerts"; answer distinguishes `notify` from
  `agentMail`.
- User asks for arbitrary API integration; answer recommends MCP if an MCP
  server exists, otherwise custom augment.
- Public peer asks for internal config; answer refuses or gives public-safe
  capability language.

Acceptance:

- These become stable v1 DX regression tests.
- Failures indicate either a prompt/skill regression or a tool-state grounding
  bug.

## What Else This Should Eventually Cover

Once the basic self-description layer works, it can become the front door to the
larger commissioning layer:

- Setup wizards: "I want Telegram" can collect bot token guidance and edit the
  right config only with creator approval.
- Capability health: "You have MCP mounted, but no servers configured."
- Deployment readiness: summarize `auggy doctor --cloud` style checks in chat.
- Learning loop: after a successful setup, suggest creating a skill or knowledge
  source to teach the agent how to use the new capability in the user's domain.
- Approval flow: later, self-generated skills or custom augments can be proposed
  as diffs for creator review, not silently installed.

## Recommended Sequence

1. Ship Slice 1 immediately. It is low risk and improves the current experience
   without new authority.
2. Ship Slice 2 as a narrow creator-only introspection augment/tool. This is the
   structural unlock.
3. Ship Slice 3 and 4 together: use the tool from the self-skill and improve the
   empty chat prompts.
4. Add Slice 5 before broadening into mutating commissioning flows.

Do not start with self-mutation. The first DX win is for Auggy to explain itself
accurately and recommend the next build step. Mutation and code generation
should come later, behind explicit creator approval and better trust tiers.
