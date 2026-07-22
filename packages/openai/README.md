# @auggy/openai

OpenAI engine adapter for [auggy](https://www.npmjs.com/package/auggy) — implements `ModelClient` against the official [`openai`](https://www.npmjs.com/package/openai) SDK.

## Install

```bash
bun add @auggy/openai
```

You don't normally install this directly — `auggy create` does it for you when you pick `openai` as the engine provider during scaffold.

## Usage

```ts
import { createOpenAIEngine } from "@auggy/openai";

const engine = createOpenAIEngine({
  model: "gpt-5.4-mini",
  // apiKey omitted → SDK reads OPENAI_API_KEY from env.
});
```

The auggy runtime resolves the engine via `agent.yaml`:

```yaml
engine:
  provider: openai
  model: gpt-5.4-mini
  maxContextTokens: 200000
  maxTokens: 4096
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).
