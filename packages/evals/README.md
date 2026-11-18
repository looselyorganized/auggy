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

## Tool-selection pilots

From a checkout of the Auggy repository, run `bun install` and set
`ANTHROPIC_API_KEY` in your shell. Both pilots use billable provider calls.
The modularity pilot also exercises real augments, including web fetch.

```bash
bun run packages/evals/src/alara/run.ts --pilot --model claude-fable-5-2
bun run packages/evals/src/modularity/run.ts --pilot --model claude-fable-5-2
```

ALARA defaults to Sonnet 4.6. Modularity defaults to the model in each condition's
YAML. Direct Fable 5.2 chooses tools automatically. Read `provider`, `model`,
and `tool_choice` on each JSONL trial before comparing runs. A text-only answer
to a tool task has `passed: false` and an empty `actual_tools` array. An execution
failure also records `error`. The full modularity fixture uses the current memory,
filesystem, webFetch, and bash augments. Its tool count is printed at startup.

In an application, confirm the operation from the tool's result before reporting
success. For example, if your order augment returns a JSON receipt:

```ts
const turn = await agent.inject(trigger);
const call = turn.toolCalls.find((entry) => entry.name === "create_order");
if (turn.success && call) {
  const receipt = orderReceiptSchema.safeParse(JSON.parse(call.output));
  if (receipt.success && receipt.data.status === "created") {
    return receipt.data.orderId;
  }
}
throw new Error("Order creation was not confirmed.");
```

## Why a separate package

Eval fixtures + graders are ~1MB of test infrastructure (prompts, expected-output specs, scoring rubrics). Shipping them in `auggy` core would inflate every install for the small slice of users who run evals. The split mirrors `@auggy/anthropic` / `@auggy/openai` / etc. — opt-in via npm.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
