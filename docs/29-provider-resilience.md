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
