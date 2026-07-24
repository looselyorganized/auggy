# 09 — Testing

> Test strategy, the test runner, fixtures, what to mock and what to leave real.

## What we test

The test suite is divided into six layers:

1. **Unit tests** — one module, one file. Mocked collaborators where they exist. Most of `tests/kernel/`, `tests/memory/`, `tests/transports/`, plus `tests/parts.test.ts`, `tests/tokenizer.test.ts`, `tests/helpers.test.ts`, `tests/agent-card.test.ts`, `tests/http.test.ts`.

2. **Augment tests** — `tests/augments/`. These exercise the built-in augments (`fileMemory`, `supabaseMemory`, `filesystem`, `webFetch`, `bash`) with their real backends-or-test-equivalents. `fileMemory` and `filesystem` use real temp directories. `supabaseMemory` uses an in-memory mock that satisfies the structural type. `webFetch` uses a local Bun.serve fixture.

3. **Engine tests** — `tests/engines/`. Adapter-level tests for `anthropic`, `openai`, `openrouter` — message coalescing, tool-call translation, schema normalization.

4. **CLI tests** — `tests/cli/`. Config parser, augment resolver, engine resolver, PID registry, plist generator, scaffold, skill manifest. Real filesystem, no real launchctl.

5. **Integration tests** — `tests/integration/`. Stand up a real `defineAgent` with real built-in augments (file memory, Supabase memory via mock client, web transport) and exercise the full HTTP surface end to end. The only fake is the model client.

6. **Eval harness** — `packages/evals/src/`. Security-focused grader pipeline (`packages/evals/src/security/`). Mocks the agent via `createMockModel` and asserts on refusals, forbidden substrings, and tool-call gating.

The split is deliberate: each layer protects against a different class of bug.

- Unit tests catch logic errors in isolation, run fast, pinpoint failures precisely.
- Augment tests catch bugs in the augments themselves (file IO, backend calls).
- Integration tests catch wiring bugs — the kind where every unit test passes but the system doesn't actually work because two pieces don't connect right.

## The test runner: `bun:test`

The test suite runs on Bun's built-in test runner via `bun test`. Originally we used Vitest, but switched to `bun:test` mid-Plan-2 because:

1. **`bun:test` is the same runtime as the production code.** Vitest spawns Node worker processes for tests, even when invoked via `bun run test` — which means anything that depends on a Bun-specific API (`Bun.serve`, `Bun.file`, etc.) doesn't work in tests.

2. **The migration cost was minimal.** 25 import lines (`from "vitest"` → `from "bun:test"`), one `vi.spyOn` → `spyOn`, delete `vitest.config.ts`. Path aliases (`@/*`, `@tests/*`) come from `tsconfig.json` which `bun:test` reads natively.

3. **`bun:test` is faster.** No vite transformation step.

4. **Cohesive stack.** Bun for runtime + Bun for tests + Bun for package management is one binary, one mental model.

The trade-off: Vitest has a richer mocking ecosystem, but the test suite barely uses mocking — only `tests/kernel/timeout.test.ts` uses `spyOn` (for `clearTimeout`), and `bun:test` has `spyOn` too.

### How to run

```bash
bun test                                 # full suite
bun test --watch                         # watch mode
bun test tests/integration/              # one directory
bun test tests/integration/full-agent.test.ts  # one file
```

`bun run test` works too — it runs the `test` script in `package.json`, which is just `bun test`. **Don't use `vitest run` anymore** — Vitest is no longer a dependency.

## Test fixtures

Fixtures live in `tests/fixtures/`. There are four: `mock-model.ts`, `mock-augment.ts`, `mock-supabase.ts`, `temp-dir.ts`.

### `mock-model.ts` — `createMockModel`

```ts
import { createMockModel } from "@tests/fixtures/mock-model";

const model = createMockModel({ response: "hello" });
// or
const model = createMockModel();
model.pushResponse({ content: "first" });
model.pushResponse({ content: "second", toolCalls: [{ name: "x", arguments: {} }], finishReason: "tool_use" });
```

A `ModelClient` implementation that returns canned responses.

```ts
interface MockModelClient extends ModelClient {
  calls: AssembledPrompt[];                // every prompt the kernel sent
  pushResponse(r: Partial<ModelResponse>): void;
}
```

How it works:
- Constructed with an optional default response (and `maxContextTokens`).
- `pushResponse(...)` queues a response. Multiple calls queue multiple responses (FIFO).
- `complete(prompt)` records the prompt in `calls[]` and returns the next queued response, or the default if the queue is empty.
- `countTokens(text)` returns `Math.ceil(text.length / 4)` — the same heuristic the real tokenizer uses, for consistency.

The mock model is the **only thing every test mocks**. Production code never branches on whether the model is mocked — there is no `if (env.test)` anywhere in `src/`.

### `mock-augment.ts` — Reusable test augments

A few small augment factories:
- `createMockAugment(overrides)` — minimal augment with `name: "mock-augment"` and any overrides applied.
- `createIdentityAugment(content)` — a `required: true` augment with a `context()` that returns the given string as a system block.
- `createToolAugment({ toolName, result })` — an augment with one tool that always returns the given result string.
- `createMockTransport()` — a fake transport that exposes `sendMessage(text, peer?)` so tests can drive turns without setting up HTTP.

These exist so most tests don't have to construct augment objects from scratch.

### `mock-supabase.ts` — `createMockSupabase`

An in-memory implementation of the `SupabaseLikeClient` structural type. Stores rows in a `Map<table, MockRow[]>`.

```ts
interface MockRow {
  label: string;
  content: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  [key: string]: unknown;             // allows the post-filter to read any column
}
```

The query builder is **a single thenable object** that supports the chain:
```ts
client.from(table).select(cols).ilike(col, val).order(col, opts).limit(n)
client.from(table).select(cols).eq(col, val).maybeSingle()
client.from(table).insert(row)
```

All chain methods return the same builder. The terminal call is either a thenable resolution (`then(onfulfilled)`) or `maybeSingle()` (which awaits the chain and picks the first result).

The mock's `then` signature matches the standard `PromiseLike.then` shape (with `null | undefined` accepted, broad generic params) so it satisfies `SupabaseLikeClient` structurally without TypeScript complaining.

This was tricky to get right. The clean type-check happened only after the post-Plan-2 type-cleanup pass.

### `temp-dir.ts` — `createTempDir`

A small helper:
```ts
async function createTempDir(): Promise<{ path: string; cleanup: () => Promise<void>; }>
```

Wraps `node:fs/promises.mkdtemp` and `rm`. Used by `tests/augments/file-memory.test.ts` to give each test its own scratch directory and clean it up afterward.

The pattern in those tests:
```ts
beforeEach(async () => { tmp = await createTempDir(); });
afterEach(async () => { await tmp.cleanup(); });
```

## What we mock vs what we leave real

### Always mocked

- **The model client.** Every test that runs the turn loop uses `createMockModel`. There is no test that calls a real LLM — too slow, too non-deterministic, too expensive. The integration tests rely on the mock to produce specific responses (e.g. "model returns content X" or "model calls tool Y then says Z").

### Mocked when convenient

- **The Supabase client.** `tests/augments/supabase-memory.test.ts` and `tests/integration/full-agent.test.ts` use `createMockSupabase`. Real Supabase would be too slow for unit tests and would require network access from CI.

### Always real

- **The filesystem.** `tests/augments/file-memory.test.ts` uses real temp directories and real `readFile`/`writeFile` calls. Filesystem behavior is fast enough and idiosyncratic enough (encoding, permissions, missing parent dirs, race conditions) that mocking it would lose more bug-catching power than it would save in test speed.
- **The HTTP server.** `tests/transports/web-transport.test.ts` and `tests/integration/full-agent.test.ts` start a real Bun.serve on a real port and hit it with real `fetch` calls. There is no mocked HTTP layer. This catches bugs in the SSE framing, header handling, status codes, body parsing — none of which a mocked layer would catch.
- **The kernel.** Every unit test for kernel components (turn loop, allocator, capability table, etc.) uses the real component with real collaborators (history manager, capability table, etc.). The kernel doesn't have so much surface that breaking it down into smaller mocked pieces would be useful.
- **The memory subsystem.** `tests/memory/*.test.ts` use the real `wireMemoryBus`, `buildRegistry`, etc. They construct fake augments via the mock-augment helpers, but the bus itself is real.

## The test pyramid in practice

```
               ┌──────────────────────┐
               │  Integration (1)     │   tests/integration/
               │  Full agent + HTTP   │
               └──────────┬───────────┘
                          │
              ┌───────────┴────────────┐
              │  Augment tests (2)     │   tests/augments/
              │  fileMemory, supabase  │
              └───────────┬────────────┘
                          │
        ┌─────────────────┴──────────────────┐
        │  Unit tests (24)                   │   tests/kernel/, tests/memory/,
        │  Each module, isolated, fast       │   tests/transports/, etc.
        └────────────────────────────────────┘
```

The pyramid is intentionally bottom-heavy. Most bugs get caught at the unit level, where they're easy to localize. The few integration tests catch wiring bugs that no unit test could.

## Why integration tests matter

The integration test (`tests/integration/full-agent.test.ts`) has two test cases:

**1. Full AG-UI turn end-to-end with identity + episodic memory wired up.**
- Starts a real `webTransport` on port 18950
- Mounts a real `fileMemory` (with a real temp directory and a real soul file)
- Mounts a real `supabaseMemory` (with the in-memory mock client, seeded with one row)
- Uses a `createMockModel` that returns a canned response
- POSTs to `/.well-known/agent-card.json`, asserts `provider.name`, `purpose`, `capabilities`, skill list (proves the agent card is wired)
- POSTs to `/health`, asserts 200
- POSTs to `/agent/run`, parses the SSE response, asserts every expected event type is present (`RUN_STARTED`, `TEXT_MESSAGE_*`, `RUN_FINISHED`)
- Asserts the model's response delta matches the canned response
- Asserts the identity context actually reached the model's `systemBlocks` (proves the memory bus's synthesized `context()` ran)
- Calls `agent.stop()` to verify clean shutdown

**2. Retrieves episodic memory and places it in the model's contextBlocks.**
- Same setup but with a seeded row whose content matches the user's query
- Asserts `prompt.contextBlocks` contains the seeded row's content
- This is the **single end-to-end proof** that retrieval flows from `search()` → `synthesizeContextFor` → allocator → model. Five links in the chain, one assertion.

Either of these tests failing means a wiring bug somewhere in the system. The unit tests for each individual piece can all pass while the system is still broken.

## What testing transports looks like

The web transport tests are particularly interesting because they prove things that are hard to test any other way.

### `delivers AG-UI events progressively via ReadableStream (not buffered)`

The test gates the model behind a Promise:
```ts
let release!: () => void;
const gate = new Promise<void>((r) => { release = r; });
const model = createMockModel({ response: "done" });
const originalComplete = model.complete.bind(model);
model.complete = async (prompt) => {
  await gate;          // model blocks here until release() is called
  return originalComplete(prompt);
};
```

Then it makes a request and reads from the response body **incrementally**:
```ts
const reader = resp.body!.getReader();
const { value, done } = await reader.read();
// At this point, the model is still gated. If buffering is in effect,
// the read would block waiting for the kernel to finish (which it can't,
// because the model is gated). If true streaming is in effect, the read
// returns immediately with RUN_STARTED in the first chunk.
if (buffered.includes("RUN_STARTED")) {
  seenRunStartedBeforeRelease = true;
}
release();    // unblock the model
// drain the rest
```

This test was added after the P1 review finding that the original implementation buffered everything. With the original code, this test would deadlock — `reader.read()` would never return because nothing is in the stream until the kernel finishes, and the kernel is gated on the model. With the streaming fix, `reader.read()` returns immediately with `RUN_STARTED`, the test releases the gate, and the rest of the events drain normally.

### `emits RUN_ERROR + RUN_FINISHED when a turn is rejected by the rate limiter`

```ts
const aug = webTransport({
  port,
  auth: { type: "bearer", token: "..." },
  rateLimitPerPeer: { maxPerMinute: 1 },     // ← key
});

// First request: under the limit
const first = await runOnce();
expect(first.status).toBe(200);

// Second request: rate-limited
const second = await runOnce();
expect(second.status).toBe(200);              // ← still 200 (SSE)
const events = parseSseFrames(await second.text());
expect(events).toContain({ type: "RUN_ERROR", code: "SCHEDULER_RATE_LIMITED" });
expect(events).toContain({ type: "RUN_FINISHED" });
```

This proves that scheduler rejections produce visible terminal events instead
of an empty 200 response.

## Test counts

Do not hard-code test counts in docs. They drift quickly. Use `bun test` for the
current count printed by the runner.

`bun run typecheck` is also part of the shippability gate.

## How to add new tests

### For a new kernel feature

1. Create `tests/kernel/your-feature.test.ts`.
2. Import from `@/kernel/your-feature` and `@/types`.
3. Use `createMockModel` if you need a model.
4. Use `defineAgent` + a real handle if you need to test integration with the agent lifecycle.
5. Run `bun test tests/kernel/your-feature.test.ts`.

### For a new augment

1. Create the augment in `src/augments/your-augment.ts`.
2. Create `tests/augments/your-augment.test.ts`.
3. Test the augment in isolation (just the augment object, no full agent).
4. If it needs a backend, write a fixture in `tests/fixtures/mock-your-backend.ts` that satisfies the structural type the augment expects.

### For a new transport

1. Create `tests/transports/your-transport.test.ts`.
2. Use a real port (in the 18900-18999 range to avoid conflicts).
3. Stand up a `defineAgent` with the transport mounted, real model client (mocked), real other augments.
4. Make real `fetch` (or whatever protocol) calls.
5. Don't try to mock the protocol layer — test real wire behavior.

### For an integration scenario

Add a new `it()` block to `tests/integration/full-agent.test.ts`. Each scenario should:
- Stand up a fresh agent (because tests need to be isolated)
- Clean up via `agent.stop()` in a `finally`
- Use a different port number from other scenarios (no port collisions)
- Make at least one **end-to-end assertion** that proves something a unit test couldn't catch

## What makes a good test in this codebase

**Good:**
- Tests one thing and asserts on the observable consequence of that thing
- Uses real collaborators where they're cheap and mockable ones where they aren't
- Has descriptive `it()` names that explain *what* is being tested in plain English
- Cleans up after itself (temp dirs, ports, agents)
- Doesn't depend on test execution order

**Bad:**
- Tests internal implementation details (private state, helper functions)
- Mocks the unit under test
- Has multiple unrelated assertions (split into multiple `it`s)
- Uses fake timers or `setTimeout` for synchronization (use Promises)
- Relies on previous tests' state

## Type-checking is part of testing

`bun run typecheck` is the second gate. Clean typecheck means:
- No type errors in `src/` or `tests/`
- All type narrowings in tests work (the type-cleanup pass after Plan 2 fixed several test files where the structural assertions were too narrow for TypeScript to verify)

A change that introduces a type error is a failing test even if `bun test` is green. Always run both before committing.
