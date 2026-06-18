# @auggy/ollama

Ollama engine adapter for [auggy](https://github.com/looselyorganized/auggy) — drive your agent against a local LLM with no API key required.

## Setup

1. Install Ollama from [ollama.com](https://ollama.com)
2. Start the server: `ollama serve`
3. Pull a tool-capable model: `ollama pull llama3.2`
4. Scaffold an auggy agent and pick the `ollama` provider:

```bash
auggy create my-agent
# → at the engine-provider prompt, choose "ollama"
# → at the model prompt, pick llama3.2 (or another pulled model)
```

`auggy create` installs `@auggy/ollama` into the agent dir's `node_modules`. No `OLLAMA_API_KEY` env var — Ollama doesn't authenticate by default.

## agent.yaml

```yaml
engine:
  provider: ollama
  model: llama3.2
  # Optional:
  # baseURL: http://localhost:11434         # default
  # maxContextTokens: 8192                  # default (Llama 3.2 supports up to 128k)
  # maxTokens: 2048                         # default; per-turn output cap
  # keepAlive: "5m"                         # default; how long to keep the model loaded
  # options:                                # native Ollama generation options
  #   temperature: 0.7
  #   seed: 42
```

## Recommended models (tool-capable)

Ollama models vary in their support for tool-calling. These work well with auggy's tool-using flow:

| Model | Approx size | Notes |
|---|---|---|
| `llama3.2` | ~2 GB | Meta Llama 3.2, fast, recommended for first-time setup |
| `llama3.1` | ~4 GB | Meta Llama 3.1, more capable but slower |
| `qwen2.5` | ~4 GB | Alibaba Qwen 2.5, strong multilingual support |
| `qwen2.5-coder` | ~4 GB | Qwen 2.5 Coder, optimized for code |

Smaller / older models (e.g. `llama2`, `mistral`) may not support tool-calling at all. If you see your agent loop forever without calling tools, swap to a tool-capable model.

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
