---
name: Bug report
about: Something is behaving differently than the docs say it should
title: "bug: "
labels: ["bug"]
---

## What happened

A clear description of what went wrong.

## What you expected

What did you think would happen, based on the docs or your reading of the code?

## Reproduction

Minimal steps to reproduce — ideally a runnable snippet or a failing test.

```ts
// minimal repro
```

## Environment

- Auggy version: <!-- e.g. v0.2.0, or `git rev-parse HEAD` if working from source -->
- Bun version: <!-- bun --version -->
- OS: <!-- macOS 14.5, Ubuntu 24.04, etc. -->
- Engine + model: <!-- anthropic / claude-sonnet-4-6 -->
- Augments in use: <!-- e.g. layeredMemory, webTransport, filesystem -->

## Anything else

Logs, traces, related issues. If the bug involves a tool call, the `TurnTrace` is gold.
