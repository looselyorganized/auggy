# @auggy/ollama

Ollama engine adapter for [auggy](https://www.npmjs.com/package/auggy) — drive your agent against a local LLM with no API key required.

## Install

```bash
bun add auggy @auggy/ollama
```

`auggy create` writes the audited transitive dependency overrides. For a direct
package install, copy the `overrides` block from the installed `auggy` manifest
into the consumer application's root `package.json`; package managers do not
inherit overrides from dependencies. This is required until
`@modelcontextprotocol/sdk` accepts the fixed `@hono/node-server` v2 range.
The peer is optional only to package installers; the adapter imports Auggy at
runtime, so install the matching local core explicitly.

## Setup

1. Install Ollama from [ollama.com](https://ollama.com)
2. Start the server: `ollama serve`
3. Pull a tool-capable model: `ollama pull qwen3.5:9b`
4. Scaffold an auggy agent and pick the `ollama` provider:

```bash
auggy create my-agent
# → at the engine-provider prompt, choose "ollama"
# → installed tool-capable models appear first in the model prompt
```

`auggy create` installs `@auggy/ollama` into the agent directory and asks
whether Ollama is local or remote. Local Ollama needs no API key. For Ollama
Cloud or a bearer-gated proxy, enter the remote URL and store the bearer in
`OLLAMA_API_KEY` when prompted.

## agent.yaml

```yaml
engine:
  provider: ollama
  model: qwen3.5:9b
  # Optional:
  # baseURL: http://localhost:11434         # default
  # maxContextTokens: 8192                  # default (Llama 3.2 supports up to 128k)
  # maxTokens: 2048                         # default; per-turn output cap
  # requestTimeoutMs: 120000                # one attempt; maximum 600000
  # keepAlive: "5m"                         # default; how long to keep the model loaded
  # options:                                # native Ollama generation options
  #   temperature: 0.7
  #   seed: 42
```

Every request has one finite attempt. The deadline covers both buffered and
streaming SDK fetches, including local model stalls; automatic retries are not
performed.

Remote Ollama endpoints that receive `OLLAMA_API_KEY` must use HTTPS. Plain
HTTP with a credential is allowed for loopback only. The explicit
`allowInsecureHttpWithCredentials: true` override works only when
`NODE_ENV=development` and must never be used for staging or production.

## Recommended models (tool-capable)

Ollama models vary in structured tool-call reliability. The create wizard
discovers locally installed models and prioritizes these supported families:

- `qwen3.6`
- `qwen3.5`
- `qwen3`
- `gemma4`
- `glm-5.1`
- `deepseek-v3.2`

The current first-pull recommendation is `qwen3.5:9b`. Other installed models
remain selectable through the custom-model path, but weak or non-standard tool
calling can lead to empty turns or loops.

## Pricing

`costUsd` is always `undefined` for `ollama`-provider responses — Ollama is free, there are no API charges. The `budgets` augment cannot enforce `dailyBudgetUsd` against ollama agents. Use these instead:

- `budgets.maxTurnsPerThread` — caps turns per conversation
- `budgets.anonymousGlobalLimit` — caps total anonymous turns per day

## Common errors

- **`fetch failed`** — Ollama server isn't running. Start it with `ollama serve` (in a separate terminal or as a service).
- **`model "X" not found`** — Model isn't pulled locally. Run `ollama pull <model>` once; subsequent runs reuse the cached model.
- **Empty responses / agent loops forever** — The selected model doesn't support tool-calling. Switch to one of the recommended models above.

## Native API

This adapter uses Ollama's native `/api/chat` HTTP endpoint via the official [`ollama`](https://github.com/ollama/ollama-js) npm SDK. It does **not** route through Ollama's OpenAI-compatibility shim at `/v1`. Why native:

- Clearer tool-call error surfacing
- `keep_alive` (model unload control), `format: json`, and Ollama-specific generation options pass through directly
- No vestigial OpenAI pricing/auth machinery
- Foundation for Ollama-specific features (model listing, native vision, etc.) without an adapter rewrite

## License

Apache-2.0
