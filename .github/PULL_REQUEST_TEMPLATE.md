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

- [ ] `bun test` passes locally.
- [ ] `bun run typecheck` is clean.
- [ ] `bun run lint` is clean.
- [ ] Numbered reference docs under `docs/` updated if behavior they describe changed.
- [ ] New public surface (augment, tool, engine adapter, CLI flag) has tests.
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).
- [ ] If this change has security implications, the threat model is described in the description above.
- [ ] If this PR touches `src/augments/*`, `src/scaffold-templates/`, `src/cli/scaffold*.ts`, `src/cli/skill-*.ts`, or kernel system-prompt assembly, kicked off `gh workflow run security-eval.yml --ref <branch>` and confirmed green before requesting review. (See ADR-029 — eval is the canary for prompt-shape changes; merging while red disables it.)

## Notes for reviewers

Anything non-obvious: load-bearing assumptions, places to look first, parts you're unsure about.
