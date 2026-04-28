---
name: Feature request
about: Propose a new augment, kernel capability, engine, or CLI feature
title: "feat: "
labels: ["enhancement"]
---

## What you want to do

The use case, in one or two sentences. What are you trying to build with Auggy that you can't build today?

## Why the runtime needs to change

Can this be solved by writing a custom augment outside the runtime? If yes, this might be a docs issue or an example we should ship — say so. If no, explain what kernel/built-in change is required and why.

## Proposed shape

A sketch of the API or behavior you'd want — types, config, CLI command, whatever's relevant.

```ts
// proposed shape
```

## Alternatives you considered

What did you try first? Why didn't it work?

## Scope

- [ ] New augment under `src/augments/`
- [ ] New engine adapter under `src/engines/`
- [ ] CLI feature
- [ ] Kernel change (please justify — the kernel is finished, see [`docs/01-philosophy.md`](../../docs/01-philosophy.md))
- [ ] Docs / examples
