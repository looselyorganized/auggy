# @auggy/anthropic

Anthropic engine adapter for [Auggy](https://www.npmjs.com/package/auggy), powered by the official [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk).

## Install

```bash
bun add auggy @auggy/anthropic
```

You don't normally install this directly — `auggy create` does it for you when you pick `anthropic` as the engine provider during scaffold.

`auggy create` also writes the audited transitive dependency overrides. For a
direct package install, copy the `overrides` block from the installed `auggy`
manifest into the consumer application's root `package.json`; package managers
do not inherit overrides from dependencies. This is required until
`@modelcontextprotocol/sdk` accepts the fixed `@hono/node-server` v2 range.
The peer is optional only to package installers; the adapter imports Auggy at
runtime, so install the matching local core explicitly.

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
  requestTimeoutMs: 120000
```

Each model POST has one attempt. The deadline defaults to 120 seconds (maximum
ten minutes), and SDK automatic retries are disabled to avoid duplicate
generation or billing after ambiguous failures.

Custom credentialed endpoints must use HTTPS. Loopback HTTP remains supported
for local development. A non-loopback plaintext endpoint is allowed only when
`allowInsecureHttpWithCredentials: true` and `NODE_ENV=development`; never use
that override for staging or production.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
