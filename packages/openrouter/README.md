# @auggy/openrouter

OpenRouter engine adapter for [auggy](https://www.npmjs.com/package/auggy) — implements `ModelClient` against [OpenRouter](https://openrouter.ai/)'s OpenAI-compatible API. Routes to any of the 200+ models OpenRouter supports.

## Install

```bash
bun add @auggy/openrouter
```

You don't normally install this directly — `auggy create` does it for you when you pick `openrouter` as the engine provider during scaffold.

## Usage

```ts
import { createOpenRouterEngine } from "@auggy/openrouter";

const engine = createOpenRouterEngine({
  model: "anthropic/claude-sonnet-4-6",
  // apiKey omitted → SDK reads OPENROUTER_API_KEY from env.
});
```

The auggy runtime resolves the engine via `agent.yaml`:

```yaml
engine:
  provider: openrouter
  model: anthropic/claude-sonnet-4-6
  maxContextTokens: 200000
  maxTokens: 4096
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).
