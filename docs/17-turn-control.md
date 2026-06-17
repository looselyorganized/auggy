# 17 — turnControl augment

## What it does

Lets the agent **pause a turn and request input from the user** via a single tool, `request_input`. When called, the kernel ends the current turn with status `input-required`; the chat widget shows a passive "waiting for you" hint near the input box; the conversation resumes when the user sends their next message.

## When to load it

`auggy create` includes `turnControl` in the default scaffold (any agent generated via the standard scaffold ships with it enabled). It is recommended for chat-shaped agents — anything that uses `webTransport` or `telegramTransport`. Headless / scripted agents (no human transport) can safely remove it.

To opt out, remove the `turnControl` entry from the agent's `augments` array in
`agent.yaml`. To add it later, run `auggy augment add turnControl`.

## The `request_input` tool

```yaml
# agent.yaml
augments:
  - turnControl
```

The tool's signature:

```
request_input(prompt: string, reason?: string)
  prompt:  required, non-empty. Shown to the user as the assistant's reply.
  reason:  optional internal note for tracing. Not shown to the user.
```

Calling `request_input(prompt)` ends the current turn with status `input-required`. The next user message starts a new turn that resumes the conversation in the same thread.

### Example interaction

```
Model: I need to know your timezone before I can schedule that.
       → calls request_input({ prompt: "What timezone are you in?" })
Kernel: ends turn with status "input-required"
Widget: shows "Waiting for your reply…" hint near input box
User:  "America/New_York"
Model: → resumes the original task with the new context
```

## Wire shape

The terminal AG-UI event carries a `result` payload with the status discriminator:

```json
{
  "type": "RUN_FINISHED",
  "threadId": "...",
  "runId": "...",
  "result": {
    "status": "input-required",
    "message": "What timezone are you in?"
  }
}
```

Old AG-UI consumers that ignore `result` continue to work — they treat every `RUN_FINISHED` as "done" (graceful degradation). New consumers branch on `result.status` to render the right affordance.

The HTTP layer is unchanged: `/agent/run` still returns 200 + SSE. HTTP-status mapping (e.g. 4xx for `rejected`) is a separately scoped roadmap item, not part of turn-control.

## Configuration

The augment supports one option:

```yaml
# augments/turnControl/augment.yaml
type: turnControl
config:
    requestInputDescription: "Use ONLY when blocked on missing user input. Never as a closing pleasantry."
```

`requestInputDescription` overrides the default tool description if you want to constrain or expand when the model should call `request_input`. The default text already includes anti-misuse guidance ("not as a closing pleasantry").

## What `turnControl` does NOT do

- It does **not** produce `auth-required`. No augment ships a credential request mid-turn today; this state stays type-level until a future `oauth_request`-shaped tool is added.
- It does **not** produce `failed` / `canceled` / `rejected`. Those remain kernel-controlled (engine error, transport cancel, gate denial).
- It does **not** introduce backgrounded / deferred tasks. "I'll get back to you" semantics are deferred until concrete demand emerges.

The narrowed `terminate.status` type (`Extract<TaskState, "input-required" | "completed">`) is a compile-time guarantee that augments cannot spoof kernel-controlled states via the `terminate` directive.

## Misuse and mitigation

A model may call `request_input` as a closing pleasantry ("Anything else?"), which would end the turn as `input-required` when the operator wanted `completed`. Mitigations:

1. The default tool description tells the model to call this tool **only when actually blocked on missing input**, not as a closing.
2. Operators who see drift can override via the `requestInputDescription` option above.
3. Eval suites can grade for state-expectation alignment (deferred follow-up).

## Reference

- Current turn-state contract: [03-types.md](./03-types.md)
- Kernel turn loop behavior: [04-kernel.md](./04-kernel.md)
- Roadmap: [ROADMAP.md](./ROADMAP.md)
