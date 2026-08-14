# Telegram latency and cross-channel context

Date: 2026-08-13
Status: Telegram ingress fix implemented and verified; cross-channel context work planned

## Why this record exists

An end-to-end AgentMail and Telegram test exposed two independent runtime
problems that initially looked like one unreliable conversation:

1. **Telegram ingress latency.** In polling mode, the polling loop awaited the
   complete model/tool turn before it requested more Telegram updates. One slow
   turn therefore stopped ingress for every later Telegram update.
2. **Cross-channel context resolution.** A creator asked in Telegram to contact
   “the person you just replied to.” The reply had happened through Console and
   AgentMail, so it was absent from the Telegram thread history. Auggy initially
   answered that it had no record “in this conversation” instead of inspecting
   recent AgentMail activity. After the creator challenged that answer, Auggy
   queried the mailbox evidence, resolved the recipient, and sent successfully.

These require different fixes. Making Telegram faster does not create
cross-channel continuity. Loading more conversational memory does not prevent
the polling loop from blocking.

## Conversation and evidence record

This section preserves the engineering-relevant sequence. Personal addresses,
provider credentials, and message contents that are not necessary for the
decision are intentionally omitted or replaced with descriptive placeholders.

1. AgentMail received mail and generated a provider-native reply draft.
2. `notify` successfully delivered a Telegram notice that a draft was ready.
3. A Telegram chat message later received the generic runtime-failure response.
   Investigation showed that the installed RC and the PR source were different
   binaries: the installed RC still exposed an AgentMail schema rejected by the
   model provider, while the PR source contained the fix. That version-under-test
   mismatch is related release-process evidence, not the Telegram latency root
   cause.
4. Running the PR source allowed the creator to inspect and send AgentMail from
   Console successfully.
5. A later ordinary Telegram response took more than one minute. Code inspection
   confirmed that `runPollLoop()` awaited `onUpdate()`, and Telegram's
   `onUpdate()` did not return until `kernel.handleInbound()` completed the full
   turn. The observation did not include stage-level timestamps, so it cannot by
   itself divide the minute between provider pickup, scheduler wait, inference,
   tool execution, and Telegram delivery. The head-of-line blocking defect is
   nevertheless deterministic in the code.
6. The creator then asked through Telegram to email the person Auggy had just
   replied to. Auggy first said that the recipient was not present in the
   Telegram conversation. When prompted to look beyond that conversation, it
   found the authoritative AgentMail record and completed the send.
7. The test agent resolved both Console and private creator Telegram traffic to
   the canonical peer ID `creator`. Its Layered Memory configuration had
   automatic extraction disabled and contained no entries. Even if memory had
   contained an extracted recipient, provider/operation state—not probabilistic
   memory—must remain authoritative for “who did I just email?”
8. A separate inspection found that Telegram currently claims but ignores
   non-text updates such as photos. That media-support gap is not changed by the
   latency fix and needs its own product decision before Telegram is described
   as a multimodal transport.

## Problem 1: polling waits for turn completion

### Current execution path

```text
Telegram getUpdates
  -> validate batch
  -> await handleUpdate(update)
       -> canonicalize and durably claim update
       -> await kernel.handleInbound(...)
            -> scheduler wait
            -> model/tool loop
            -> outbound Telegram send
  -> advance offset
  -> begin next getUpdates
```

The long-poll `timeoutSec` is not intended to delay an update that Telegram has
already received. Telegram returns an available update immediately. The latency
comes from coupling the next poll to completion of the preceding agent turn.

### Fix

Polling must await only the safe intake boundary:

```text
Telegram getUpdates
  -> validate batch
  -> canonicalize and durably claim update
  -> submit turn to the bounded kernel scheduler
  -> advance offset
  -> immediately begin next getUpdates

Bounded scheduler
  -> preserve FIFO ordering for the same Telegram chat/thread
  -> enforce source, agent, thread, and peer limits
  -> run model/tools
  -> deliver the response
```

The webhook path remains request-coupled in this change. It already admits
independent HTTP requests concurrently and its response status currently
communicates turn-processing failure. Changing that acknowledgement contract
requires a separate provider-delivery decision.

### Safety invariants

1. A poll offset advances only after canonical validation and a durable replay
   claim (or a known duplicate/discard decision).
2. A replay conflict still quarantines polling before the conflicting update or
   any later batch entry advances.
3. The kernel scheduler remains the bounded queue. Polling must not create an
   unbounded parallel work list.
4. Same-thread turns remain ordered by the keyed scheduler.
5. Source, agent, thread, and peer capacity/rate-limit rejections remain
   user-visible through the existing safe failure response.
6. Shutdown aborts polling and every admitted in-flight Telegram turn, waits for
   tracked work within the lifecycle deadline, and clears reply routing only
   after work settles.
7. A turn failure cannot crash the detached polling loop or create an unhandled
   rejection.
8. Secrets, message content, peer IDs, and chat IDs do not enter latency logs or
   aggregate operational projections.

### Acceptance criteria

- A blocked model turn does not prevent the next `getUpdates` call.
- The next poll uses the admitted update's successor offset before that turn
  completes.
- Two updates are submitted in Telegram update order without requiring the
  first model turn to settle.
- Durable replay conflicts, invalid sequences, duplicate claims, and polling
  ownership conflicts retain their existing fail-closed behavior.
- Shutdown cancellation reaches detached turns and shutdown does not leave an
  unhandled promise.
- Focused Telegram tests, integrations, typecheck, lint, and full tracked tests
  pass.

### Implementation outcome

- Polling uses an explicit `after-admission` completion boundary; webhook
  processing retains its existing request-coupled `await-turn` boundary.
- Admitted polling turns are tracked independently of the poll loop. Shutdown
  aborts them, joins them within the lifecycle deadline, and only then clears
  Telegram reply routing.
- A deterministic regression test blocks two model turns, proves both updates
  are submitted in Telegram order, and proves the next poll starts at the
  successor offset before either turn settles.
- Existing replay-store, polling-conflict, webhook, keyed-scheduler, shutdown,
  typecheck, lint, and full tracked suites pass. The first sandboxed full-suite
  attempt could not bind its local HTTP test server; the complete suite passed
  outside that network sandbox.

### Remaining observability work

The runtime needs privacy-safe latency attribution for:

- provider timestamp to local intake;
- intake/replay claim duration;
- scheduler queue wait;
- inference and tool duration;
- outbound delivery duration.

The current process-wide scheduler and inference counters are useful but do not
yet provide one correlated Telegram latency trace. Add correlation without
putting message text, addresses, chat IDs, or peer IDs into metric labels.

## Problem 2: cross-channel references are unresolved initially

### Target operator experience

For an always-on Auggy, Telegram is the creator conversation surface while
AgentMail remains the mail system of record. The intended inbound experience
is concise and actionable:

```text
Auggy: Hey Mike, I just got an email from <sender> about <short summary>.
       What should I do?

Creator: For this sender, always draft a reply and send it to me for review.
```

The first message is driven by authenticated AgentMail arrival plus current
notification policy. The second can be remembered by Layered Memory as a
preference, but automatic future execution must become an explicit,
inspectable behavior rule. The reply draft stays provider-native in AgentMail;
Auggy can show and revise it conversationally in Console or Telegram, while
“Open in AgentMail” remains the direct provider review path.

This experience must distinguish three events that were conflated during the
test: mail arrival, a draft becoming ready, and a creator message arriving on
Telegram. Each needs its own durable operation identity, concise notification,
and trace timing.

### Why channel histories must stay separate

Console, Telegram, and AgentMail use different thread IDs by design. Combining
their transcripts would:

- leak context across audiences and authorization boundaries;
- make unrelated channels pollute each other's prompts;
- make erasure and retention rules ambiguous;
- turn one large transcript into an accidental source of truth.

The correct bridge is the canonical, currently verified principal. In this
case, both Console and private Telegram identify the creator as `creator`.
That common identity authorizes retrieval; it does not imply shared transcript
history.

### Context taxonomy

| Question | Correct source | Scope |
| --- | --- | --- |
| What was just said here? | Thread history | One channel/thread |
| Who is speaking and what may they do now? | Core `PeerIdentity` plus current policy | Current turn |
| What does this person prefer or want remembered? | Layered Memory | Principal across threads |
| What email operation just happened? | AgentMail operation state/activity projection | Agent/capability |
| What are the current message, thread, or draft contents? | AgentMail provider | Provider resource |
| What should happen automatically next time? | Typed creator-authored behavior policy | Explicit rule |

### Existing extension point

Auggy already lets an augment contribute bounded pre-inference context through
`Augment.context(turn): ContextBlock[]`. The kernel resolves identity before
running that pipeline, applies timeouts, records inclusion/eviction, and then
assembles model context. A second generic “before every turn” plugin mechanism
would duplicate this contract.

The gap is not the absence of a hook. The gap is an authorized, typed,
relevance-aware source of recent operational activity.

### Recommended retrieval behavior

Use a hybrid approach:

1. Preload only a small creator-visible hint when relevant activity exists:

   ```text
   Recent AgentMail activity is available. Use the AgentMail activity lookup
   when the creator refers to a recent email action across channels.
   ```

2. Retrieve exact activity just in time through a capability-specific,
   read-only tool such as:

   ```ts
   list_recent_mail_activity({
     action: "reply.sent",
     sinceMinutes: 30,
     limit: 5,
   });
   ```

3. Resolve one unambiguous candidate automatically.
4. Ask a concise clarifying question when several candidates match.
5. Fetch message/thread/draft content from AgentMail only when needed.
6. Re-evaluate current identity and policy for every consequential action.

For the observed request, the desired flow is:

```text
Creator in Telegram: “Email the person you just replied to.”
  -> recognize a cross-channel operational reference
  -> list recent successful AgentMail replies
  -> resolve the one recent recipient and authoritative message/thread refs
  -> use current creator identity and outbound policy to authorize a new send
  -> send through AgentMail
  -> project the new terminal activity
```

### What Layered Memory should and should not do

Layered Memory is appropriate for durable preferences and facts, for example:

- “Mike prefers concise email summaries.”
- “Notify Mike in Telegram when a reply draft is ready.”
- “For messages from a named sender, Mike usually wants a draft prepared.”

It is not the authoritative store for provider operations, exact resource IDs,
delivery outcomes, or authorization. A learned preference can suggest a typed
behavior rule; it cannot silently grant permission to send email.

### Acceptance criteria for the later cross-channel slice

- The same verified creator can resolve recent capability activity from Console
  or Telegram without sharing transcripts.
- Public, anonymous, recognized, and agent peers cannot retrieve creator
  activity unless an explicit audience policy allows it.
- One unambiguous recent AgentMail operation is resolved on the first attempt.
- Ambiguous references produce choices rather than guesses.
- Provider content and current state are fetched from AgentMail, not copied into
  a global transcript or memory entry.
- Retrieved activity never grants authorization.
- Context retrieval is bounded, timed, observable, and safely omitted on
  failure unless explicitly configured as required.
- End-to-end coverage performs an AgentMail reply through Console and resolves
  “the person you just replied to” through Telegram.

## Research grounding

- Anthropic recommends treating context as finite, supplying the smallest
  high-signal context possible, and combining small up-front context with
  just-in-time retrieval:
  <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- CoALA separates working, episodic, semantic, and procedural memory rather
  than treating all prior state as one transcript:
  <https://arxiv.org/abs/2309.02427>
- AgentMail keeps inboxes, messages, threads, drafts, and real-time provider
  events as provider resources:
  <https://www.agentmail.to/docs/integrations/skills>
- MCP standardizes context/tool exchange but deliberately leaves context
  management to the host application:
  <https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture>

## Explicitly deferred

- The Auggy Activity Index described in
  [`activity-index-architecture-2026-08-13.md`](./activity-index-architecture-2026-08-13.md).
- Typed creator-authored behavior policies.
- Telegram photo/document/voice ingestion.
- A generic cross-channel transcript or automatic transcript merge; this is
  intentionally rejected.
- Horizontal multi-replica Telegram execution; the supported production
  topology remains one process/replica per logical agent.
