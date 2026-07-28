# @auggy/openrouter

OpenRouter engine adapter for [Auggy](https://www.npmjs.com/package/auggy), using [OpenRouter](https://openrouter.ai/)'s OpenAI-compatible API. Routes to any of the 200+ models OpenRouter supports.

## Install

```bash
bun add auggy @auggy/openrouter
```

You don't normally install this directly — `auggy create` does it for you when you pick `openrouter` as the engine provider during scaffold.

`auggy create` also writes the audited transitive dependency overrides. For a
direct package install, copy the `overrides` block from the installed `auggy`
manifest into the consumer application's root `package.json`; package managers
do not inherit overrides from dependencies. This is required until
`@modelcontextprotocol/sdk` accepts the fixed `@hono/node-server` v2 range.
The peer is optional only to package installers; the adapter imports Auggy at
runtime, so install the matching local core explicitly.

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
  requestTimeoutMs: 120000
  providerRouting:
    only: [anthropic]
```

Each model POST has one attempt. The deadline defaults to 120 seconds (maximum
ten minutes), and SDK automatic retries are disabled to avoid duplicate
generation or billing after ambiguous failures.

`only` and `ignore` accept canonical lowercase base-provider slugs. When either
is configured, the adapter checks every slug against OpenRouter's authenticated
provider directory before sending the model request. An unavailable or malformed
directory fails closed, and `only` also forces upstream fallbacks off. Provider
variants containing `/` are intentionally rejected until OpenRouter exposes an
authoritative variant catalog that the adapter can validate.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
