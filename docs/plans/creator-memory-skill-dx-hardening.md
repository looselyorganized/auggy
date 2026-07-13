# Creator, Memory, And Skill DX Hardening

Status: implementation complete. All four slices and the adversarial follow-up
are covered by automated tests. A real-model creator-console walkthrough
remains the release gate.

## Outcome

A runtime-verified creator can teach an agent an allowed global behavior and
receive truthful persistence feedback. Public peers cannot make that change.
The agent can also discover and read its Auggy skill before answering
framework-specific questions, without loading every skill body on every turn.

## Evidence Behind The Scope

The failed DX walkthrough exposed three connected gaps:

1. The model did not reliably distinguish a creator-authorized learned
   behavior update from an attempt to rewrite immutable identity or security
   policy.
2. `memory_write` overloaded peer-scoped facts and agent-global behavior. The
   model first attempted an unavailable peer write, then claimed success too
   early.
3. The mounted Auggy skill existed, but its catalog entry did not reliably
   activate the skill for Auggy-specific questions without a user nudge.

The current branch already contains important foundations: runtime creator
identity in the preamble, trust-gated static memory writes, the
`learned-behaviors.md` compatibility migration, automatic skill mounting, and
an on-demand skill manifest. This plan hardens those contracts instead of
replacing them.

## Adversarial Design Decisions

- Do not add a second filesystem write path to `learned-behaviors.md` in 0.5.
  `fileMemory` owns an in-memory cache, so an overlapping filesystem mount
  would introduce stale reads and two authorization surfaces. A virtual
  file-backed projection can be designed later with one owner and explicit
  cache invalidation.
- Keep `memory_write({ label: "learned" })` compatible for existing agents.
  Improve its decision guidance and outcomes rather than renaming it before
  1.0.
- Keep specialized peer memory. Peer binding, tenant isolation, provenance,
  deletion, and auth checks justify a constrained API even if agent-global
  project knowledge becomes more file-native over time.
- Do not rely on prompt wording alone for authorization. Provider ownership and
  trust checks remain deterministic in the tool layer.
- Do not boot-load full skills. Emit a compact, trust-filtered catalog and read
  only the relevant guide on demand.
- Do not claim that deterministic tests prove every model will comply. They
  prove that identity, capability, tool outcome, and skill instructions reach
  the model correctly. A real-model DX walkthrough remains the release gate.

## Slice 1: Turn Authority Contract

Make creator authority and its limits unmistakable in every model turn.

Implementation:

- Render runtime identity separately from mutable capabilities.
- State that a verified creator may request an agent-global learned behavior
  update when the learned provider is available.
- State that chat cannot rewrite immutable identity, authorization, or security
  policy.
- Require a successful tool result before the model says a value was saved.
- Preserve public and agent trust behavior across every transport.

Acceptance:

- Creator preamble identifies the verified creator and the allowed behavior
  update path.
- Public preamble explicitly denies agent-global behavior updates.
- All trust levels receive the rule that persistence may only be confirmed
  after a successful tool result.
- Existing creator, agent, recognized-public, anonymous-public, and internal
  turn tests remain green.

## Slice 2: Persistence And Memory-Destination Contract

Remove ambiguity between peer memory and agent-global learned behavior without
breaking the 0.5 API.

Implementation:

- Emit a compact, required memory-capability context block describing the
  writable destinations actually installed for the current turn.
- Describe learned behavior and peer memory as distinct decisions in the
  `memory_write` schema.
- Return explicit `PERSISTED`, `NOT_PERSISTED`, or `PERSISTENCE_UNKNOWN`
  outcomes. Provider exceptions are unknown because a provider may commit and
  then throw.
- Mark expected write failures as kernel tool errors while preserving the
  existing string-returning tool API.
- Catch provider write failures and report them as `PERSISTENCE_UNKNOWN` tool
  results because a provider can throw after committing. Do not retry these
  outcomes blindly.
- Update `fileMemory` cache only after the disk write succeeds.
- Treat the default learned-behavior store as operator-origin guidance with a
  creator-only write allowlist. Admitted agents may not mutate it by default.
- Keep exact-label writes backward compatible for static providers and topic
  writes for namespace providers.
- Require topic-based namespace writes; accepting caller-authored namespace
  labels would permit cross-peer label forgery in generic providers.

Acceptance:

- With only learned behavior installed, the model sees that global behavior is
  writable and peer persistence is unavailable before it calls a tool.
- With layered memory installed, the model sees peer persistence as available.
- Public peers do not see learned behavior as writable.
- Validation and authorization failures return `NOT_PERSISTED`. Provider
  exceptions return `PERSISTENCE_UNKNOWN`; `fileMemory` keeps its cache and
  destination unchanged when its atomic replacement fails before commit.
- Successful writes return `PERSISTED` and are readable on the next turn.
- No-provider guidance identifies valid alternatives without claiming a save.

## Slice 3: Deterministic Skill Activation

Make the installed Auggy guide discoverable without loading its full body.

Implementation:

- Strengthen the skill-manifest instruction into an explicit activation
  contract: if a request matches a listed skill, read it before answering.
- Ensure each catalog entry gives enough trigger vocabulary to select it.
- Expand the Auggy skill frontmatter description to name its principal domains,
  including custom augments, routes/tools, Next.js, auth, memory, deploy, and
  troubleshooting.
- Preserve trust filtering so creator-only skills are absent for public peers.
- Keep packaged and scaffolded copies byte-for-byte synchronized.

Acceptance:

- A creator turn contains the Auggy catalog entry and exact `fs_read` path.
- The entry visibly covers custom augments, route shapes, Next.js, and app auth.
- A public turn does not reveal the creator-only Auggy skill.
- An end-to-end scripted turn can read the skill with `fs_read` before its
  final answer.
- Missing or invalid skills remain absent and diagnostics remain truthful.

## Slice 4: Cross-Slice Acceptance And Documentation

Prove the complete runtime contract and align operator/model documentation.

Acceptance flow:

1. A creator turn is identified as creator in model context.
2. The creator writes a learned greeting and receives `PERSISTED`.
3. A later turn receives the learned behavior in context.
4. A public peer attempting the same global write receives `NOT_PERSISTED` and
   the provider is unchanged.
5. A peer fact without layered memory receives `NOT_PERSISTED` plus accurate
   setup guidance.
6. An Auggy framework question exposes the skill catalog and permits an
   on-demand `fs_read` of `skills/auggy/SKILL.md`.

Verification:

- Focused unit tests for preamble, memory tools/bus, file memory, skills, and
  turn-loop prompt assembly.
- End-to-end scripted model test covering creator write, public denial,
  next-turn context, and skill read.
- Builder-skill content/parity checks.
- Full `bunx tsc --noEmit`, `bun run lint`, and `bun test`.
- Manual creator-console walkthrough with a real model before PR creation.

## Deferred

- A virtual filesystem projection for learned behavior or peer memory.
- Multiple operator identities and team roles.
- Automatic behavior mutation without an explicit creator request.
- Guaranteeing model compliance without real-provider evaluation.
