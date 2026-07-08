# Auggy — Operational Backlog

The "grab one when you have a spare hour" list — bugs, small UX
fixes, polish. **Not a roadmap.** Roadmap features live in
[`docs/ROADMAP.md`](./ROADMAP.md); the operator console contract lives
in [`docs/21-console.md`](./21-console.md). If something here grows
into a real feature, move it to the roadmap.

Format: `- [ ] [category] description (context: where/when found)`

---

## Bugs

*(none currently open — recent fixes are recorded in git history /
release notes, not here)*

## UX

- [ ] **[memory]** Rename or reposition scaffolded `learned.md` as `learned-behaviors.md` so users and agents understand it is for agent-global learned operating guidance, not user-specific memory. Keep compatibility or migration clear if the file is renamed.
- [ ] **[memory]** Teach the default agent memory decision tree: user-specific facts like "my favorite color is blue" require `layeredMemory`; agent-global operating preferences like "greet people with HEY YO" belong in learned behaviors when the requester has creator/operator authority; hard identity/security rules still belong in `identity.md` and should not be mutated casually through chat.
- [ ] **[memory]** Improve `memory_write` failure guidance when no writable current-peer namespace exists. The error should explain that peer memory needs `layeredMemory`, and the agent should not promise "I'll remember" after `memory_list()` shows no writable namespace.
- [ ] **[auth/console]** Respect the verified creator principal across Auggy surfaces, not as a special "mode." When a request carries valid creator credentials, route context and model-facing trust guidance should make clear the caller is the creator/operator. Creator-authenticated requests should be able to request lower-authority learned-behavior updates, while identity/security rules remain higher-authority and require an explicit operator-edit flow.
- [ ] **[console]** Normalize `/console/chat` `/agent/run` SSE `RUN_ERROR` events for retryable provider/model failures. The DX walkthrough surfaced raw Anthropic overload JSON (`overloaded_error`) after a tool path; the console should show a clear retryable provider status instead.

## Polish

- [ ] **[manifest]** Retry-at-boot message says "running without a loaded manifest" — should also say "lazy retry on first manifest_fetch" so operator doesn't restart unnecessarily.
- [ ] **[scaffold]** `agent.yaml` comments could include engine provider options (currently only shows anthropic as the default).

---

When you fix something, remove the line. When you discover something,
add it. If it grows into a real project, move it to
[`docs/ROADMAP.md`](./ROADMAP.md).
