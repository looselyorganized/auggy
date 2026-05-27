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

- [ ] **[CLI]** `auggy create` from wrong directory (e.g. a sibling project's checkout) scaffolds `<wrong-dir>/<name>/` without warning. Should detect or ask "create here?".
- [ ] **[CLI]** Env var error messages list missing vars but don't say "add these to your .env" or show the file path.

## Polish

- [ ] **[manifest]** Retry-at-boot message says "running without a loaded manifest" — should also say "lazy retry on first manifest_fetch" so operator doesn't restart unnecessarily.
- [ ] **[scaffold]** `agent.yaml` comments could include engine provider options (currently only shows anthropic as the default).

---

When you fix something, remove the line. When you discover something,
add it. If it grows into a real project, move it to
[`docs/ROADMAP.md`](./ROADMAP.md).
