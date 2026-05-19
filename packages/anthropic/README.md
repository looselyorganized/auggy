# @auggy/anthropic

Anthropic engine adapter for [auggy](https://www.npmjs.com/package/auggy) — implements `ModelClient` against the official [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk).

## Install

```bash
bun add @auggy/anthropic
```

You don't normally install this directly — `auggy create` does it for you when you pick `anthropic` as the engine provider during scaffold.

## Usage

```ts
import { createAnthropicEngine } from "@auggy/anthropic";

const engine = createAnthropicEngine({
  model: "claude-sonnet-4-6",
  // apiKey omitted → SDK reads ANTHROPIC_API_KEY from env.
});
```

The auggy runtime resolves the engine via `agent.yaml`:

```yaml
engine:
  provider: anthropic
  model: claude-sonnet-4-6
  maxContextTokens: 200000
  maxTokens: 4096
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).
