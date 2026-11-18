# Provider Resilience

Auggy gives every model inference one finite attempt. The deadline covers DNS
and connection setup, the first response or stream event, the complete stream,
and buffered response materialization.

```yaml
engine:
  provider: anthropic
  model: claude-sonnet-4-6
  requestTimeoutMs: 120000 # default; positive integer, maximum 600000
```

The same value configures the first-party adapter and the kernel boundary.
Direct `ModelClient` consumers of the Anthropic, OpenAI, OpenRouter, and Ollama
adapters therefore receive a finite default even outside `defineAgent`.

## Direct model selection

Set `engine.provider` and `engine.model` in `agent.yaml`, or pass
`--provider` and `--model` to `auggy create`. The following direct API
IDs and standard USD rates per million tokens were verified on 2026-11-18.

| Provider | Model | Input | Output | Cache read | Short write | Long write |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| OpenAI | `gpt-6.2-astra` | 8 | 40 | 0.40 | 10 | 20 |
| OpenAI | `gpt-6.2-sol` | 2 | 10 | 0.10 | 2.50 | 5 |
| Anthropic | `claude-fable-5-2` | 8 | 40 | 0.20 | 10 | 16 |
| Anthropic | `claude-opus-5` | 5 | 25 | 0.50 | 6.25 | 10 |

GPT-6.2 uses the Responses API with `store: false`. The adapter requests
30-minute cache writes and prices 30-minute and 12-hour writes from usage.
Above 272,000 input tokens the entire request uses double input and cache
rates and 1.5 times the output rate. Reasoning tokens are included in output.
[Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra) · [Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol) · [Cache accounting](https://developers.openai.com/api/docs/guides/prompt-caching)

Claude uses the Messages API. Its write durations are 5 minutes and 1 hour.
Fable 5.2 uses automatic tool choice. Programmatic callers that require a
specific tool can use Opus 5. Anthropic requires workspace access to Fable and its
data-retention terms. [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing) · [Fable migration guide](https://platform.claude.com/docs/en/models/fable-5-2/migration-guide)

During a tool turn, the adapter returns the provider's signed or encrypted
reasoning with the original tool calls and their Auggy results. This state
lives in memory for the active turn. If the history budget trims the prefix
needed for continuation, the turn stops before another provider request.
The tool results already recorded in Auggy remain in the thread.

## One-attempt policy

Automatic model POST retries are disabled. The upstream OpenAI and Anthropic
SDKs otherwise retry some connection errors, timeouts, 408/409/429 responses,
and 5xx responses. Auggy does not have a provider-neutral idempotency contract
that proves those failures happened before generation or billing, so retrying
could duplicate cost. There is consequently no jitter/backoff setting: the
safe retry set is empty. A future retry policy must add authenticated
provider-specific pre-effect evidence or an idempotency contract first.

Provider failover and automatic multi-provider routing are also outside this
boundary. Operators may retry a new customer turn after an ordinary, definitive
provider rejection. They must reconcile and recover a quarantined thread after
an outcome-unknown deadline rather than manufacturing a new request blindly.

## Deadline behavior

The kernel passes a combined caller/deadline signal to the model adapter. On a
deadline:

- the adapter and underlying fetch/stream are asked to abort;
- an open text stream is closed exactly once;
- the turn becomes outcome-unknown and its thread is quarantined;
- possible unreported usage is committed as unpriced accounting evidence;
- no late text, tool call, history mutation, or follow-up inference is accepted;
  and
- the scheduler releases local capacity even if third-party provider code
  ignores cancellation forever.

Releasing the slot is safe because a model response cannot execute a tool until
the awaited inference wins inside the kernel. This rule is deliberately not
shared with dispatched tools, notifications, hooks, or other side effects;
those retain their scheduler ownership until non-cooperative work settles.

A custom `ModelClient` can ignore cancellation completely. Auggy tracks those
unresolved attempts after their deadline. One unresolved attempt does not pin
the only scheduler slot forever, but once the bounded detached-attempt budget
(`max(2, settings.turnScheduling.maxConcurrent)`) is exhausted, new inference
fails closed until an earlier attempt settles. Attempts that were already
running may cross the deadline concurrently, so retained provider work is at
most that budget plus `maxConcurrent - 1`. A permanently non-cooperative
adapter requires a process restart; first-party adapters abort their underlying
request and normally acknowledge cancellation promptly.

The deadline is per inference. A tool-using turn can perform several inferences,
bounded separately by `settings.maxInferenceLoops`. Select a value appropriate
for the model and hardware. Local reasoning models may need a larger value, but
the ten-minute ceiling prevents one provider request from retaining runtime
capacity indefinitely.

## Operational boundary

Provider failures and outcome-unknown inference counts appear in the bounded
runtime operational snapshot. The operator owns alert thresholds and provider
status monitoring. Auggy does not supply a circuit breaker, cross-provider
health router, or availability SLO in this release.

Multiple replicas serving one logical Auggy remain unsupported. This deadline
protects one runtime process; it is not distributed provider coordination.
