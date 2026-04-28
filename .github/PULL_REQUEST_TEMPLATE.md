## What this changes

A one-paragraph description of the change. Lead with *why*; the diff already shows *what*.

Closes #<!-- issue number, if any -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New augment / engine / CLI feature
- [ ] Refactor (no behavior change)
- [ ] Kernel change (justify below — kernel is finished by default)
- [ ] Docs only
- [ ] Tests only

## Checklist

- [ ] `bun test` passes locally (all 863+).
- [ ] `bunx tsc --noEmit` is clean.
- [ ] Reference docs under `docs/01-12-*.md` updated if behavior they describe changed.
- [ ] New public surface (augment, tool, engine adapter, CLI flag) has tests.
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).
- [ ] If this change has security implications, the threat model is described in the description above.

## Notes for reviewers

Anything non-obvious: load-bearing assumptions, places to look first, parts you're unsure about.
