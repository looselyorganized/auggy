# @auggy/evals

Security and memory evaluation suites for [Auggy](https://www.npmjs.com/package/auggy) agents.

| Suite | What it tests | Cost |
|---|---|---|
| `security` | Red-team prompts (jailbreak, prompt injection, identity leak, instruction override) | LLM-judged; ~$0.07/run on Haiku |
| `auto-save` | Layered-memory fact extraction fixtures (peer isolation, retention class, false-extract) | Free in `--dry-run`; ~$0.005/run live |

Additional layered-memory harness modules ship for internal regression testing,
but they are not exposed through `auggy eval` yet.

## Install

```bash
npm i -g @auggy/evals
```

Then run via the auggy CLI:

```bash
auggy eval                          # default fixture, security suite
auggy eval my-agent                 # registered agent
auggy eval auto-save --dry-run      # fixture validation only
auggy eval my-agent --suite security-only
```

You don't normally `import` from this package — `auggy eval` resolves it lazily at command-run time.

## Why a separate package

Eval fixtures + graders are ~1MB of test infrastructure (prompts, expected-output specs, scoring rubrics). Shipping them in `auggy` core would inflate every install for the small slice of users who run evals. The split mirrors `@auggy/anthropic` / `@auggy/openai` / etc. — opt-in via npm.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
