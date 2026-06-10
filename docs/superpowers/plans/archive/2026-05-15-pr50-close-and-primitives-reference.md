# PR #50 Close + Primitives-Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close PR #50 (the embedding-recipe doc that became a security-recipe codex treadmill) and ship a tiny replacement PR with a primitives-reference doc + a trimmed runtime-contract test. Net: ~80% smaller doc, no copy-paste recipe to defend in future codex rounds, the durable bits (corrected identity model + integration test pattern) survive.

**Architecture:** Close PR #50 with `--delete-branch` and an explanatory comment that points forward. Create a fresh branch from `main` (cleaner history than rewriting on top of the closed branch). Write `docs/20-embedding.md` as a small primitives reference — names the four `webTransport.identify()` paths, the AG-UI event shape, the visitor-token rotation contract, and cross-references to creator surfaces (`auggy chat`, Telegram). No copy-paste code. Port the integration test as a runtime-contract verifier, not a recipe mirror. Update CHANGELOG + `docs/todos.md` Tier-3 wording to reflect the pivot. One commit, one PR, one round of CI, merge.

**Tech Stack:** Bash + `gh` CLI for PR mechanics; git for branch ops; Bun + TypeScript for tests; markdown for docs.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| **PR #50** | Close with `--delete-branch` **LAST** (after replacement PR is open + CI green) | Remove the recipe doc + 4 commits of codex iteration from active state. Closing comment links to the actual replacement PR number. |
| `docs/20-embedding.md` | Create fresh (new branch from main) | Primitives reference: identity-model contract, AG-UI events, visitor-token bootstrap + rotation, visitorAuth verify endpoint. No proxy code, no widget code, no hardening checklist (those belonged to a recipe we're not shipping). |
| `tests/integration/embedding-primitives.test.ts` | Create (port from PR #50's test, trimmed + renamed; add creator-path + invalid-bearer coverage) | Verify the runtime contract — creator path, public-anonymous bootstrap, public-recognized rotation, visitorAuth upgrade flow, invalid-bearer 401 (no silent downgrade), `x-peer-id` is ignored. Six tests. Drops anything that mirrored a specific copy-paste pattern. |
| `CHANGELOG.md` | Modify Unreleased section | Three bullets: primitives reference, primitives test, chat/server.ts malformed-URI hardening. |
| `docs/todos.md` | Modify Tier-3 G1 line | Drop "Recipe doc is enough for v1.0" wording; reframe as "primitives reference shipped, packaged widget deferred to post-v1.0"; add G37 ui-kit pointer. |
| `docs/19-visitor-auth.md` | Modify if it links to 20-embedding | Confirm cross-references still make sense; trim any "see the recipe" wording. |
| `chat/server.ts` | Cherry-pick from closed branch | The `decodeURIComponent` try/catch hardening at line 195. Returns 404 on malformed `/api/chat/<id>` paths instead of Bun.serve 500. **Durable hardening, NOT recipe-related — should land on main regardless of the recipe pivot.** |
| `chat/tests/server.test.ts` | Cherry-pick from closed branch | Regression test for the malformed-percent-encoding path. |

**Files NOT touched:**
- `lo/docs/ROADMAP.md` — outside the augment-1 repo, no git, not editable in this PR.
- Any other runtime code — this is a doc + test PR plus the one targeted chat hardening cherry-pick. The shared-cookie handoff (visitorAuth `successHandoff`) ships separately.

---

## Out of scope

- Shared-cookie handoff in visitorAuth + webTransport (separate PR, ~half-day, lands after this).
- LORF widget build (operator's work, on `looselyorganized.xyz` repo).
- `docs/todos.md` Tier-1 changes — G1 was never explicitly listed in Tier-1 of `docs/todos.md`; only `lo/docs/ROADMAP.md` listed it, and we can't edit that.

---

## Adversarial-review revisions (round 5 against the rev-1 plan)

Codex flagged four issues against rev-1 of this plan. All four integrated:

| # | Finding | Severity | Resolution in this plan |
|---|---|---|---|
| 1 | Doc claimed `x-visitor-token` is optional + tokens survive past TTL; runtime verified to require bootstrap sentinel + reject expired tokens (`web-transport.ts:666`, `visitor-token.ts:80`) | high | Task 3 doc text corrected: "send `x-visitor-token: bootstrap` (any value) on first contact" + "tokens are rejected after TTL expiry, visitor falls back to anonymous." |
| 2 | 4 tests don't cover the "runtime contract" the plan claims; missing creator path + invalid-bearer no-downgrade | high | Task 4 adds 2 tests: creator path (valid bearer → creator trust), invalid bearer → 401 (security claim). Doc claims narrowed: identity-path coverage limited to {creator, public-anonymous, public-recognized}; agent-path coverage delegated to `src/transports/` tests. |
| 3 | Rollout closes PR #50 before replacement PR exists; if branch-create/test-port/push fails, forward pointer is dead | medium | Tasks reordered: branch + doc + tests + CHANGELOG + cherry-pick happen FIRST; replacement PR opens with CI green; PR #50 closes LAST with the new PR # cited verbatim in the closing comment. |
| 4 | `chat/server.ts` malformed-URI hardening (durable, not recipe-specific) gets stranded on deleted branch | medium | Task X (new): cherry-pick the chat/server.ts + chat/tests/server.test.ts changes from the closed branch into the replacement PR. CHANGELOG bullet added. |

---

## Task 0: Pre-flight

**Files:** None modified.

- [ ] **Step 1: Verify clean working tree on the closed branch**

```bash
git status --short
```
Expected: empty output.

- [ ] **Step 2: Baseline gates on the current branch state**

```bash
bun test 2>&1 | tail -3
```
Expected: `1955 pass / 0 fail` (the baseline from PR #50 round-3 commit).

```bash
bunx tsc --noEmit 2>&1 | tail -3
```
Expected: empty output (clean).

```bash
bun run lint 2>&1 | tail -2
```
Expected: `Found 29 warnings. Found 1 info.` (no errors).

- [ ] **Step 3: Confirm PR #50 is still open**

```bash
gh pr view 50 --json state,headRefName --jq '"state=\(.state) head=\(.headRefName)"'
```
Expected: `state=OPEN head=docs/g1-embedding-recipe`.

- [ ] **Step 4: Capture the SHA of PR #50's HEAD (for the closing comment to reference)**

```bash
git rev-parse docs/g1-embedding-recipe
```
Expected: `0111bc1f...` (the round-3 commit). Note the full SHA for use in the closing comment.

---

## Task 1: Create fresh branch from main

**Files:** None.

- [ ] **Step 1: Fetch latest main**

```bash
git fetch origin main
```

- [ ] **Step 2: Switch to main and pull**

```bash
git checkout main && git pull --ff-only origin main
```
Expected: `Already up to date.` or a fast-forward.

- [ ] **Step 3: Create new branch**

```bash
git checkout -b docs/g1-primitives-reference
```
Expected: `Switched to a new branch 'docs/g1-primitives-reference'`.

- [ ] **Step 4: Verify starting state — no embedding doc, no integration test**

```bash
ls docs/20-embedding.md tests/integration/embedding-recipe.test.ts 2>&1 | tail -3
```
Expected: both files report "No such file or directory" — we're starting clean from main.

---

## Task 2: Write the primitives-reference doc

**Files:**
- Create: `docs/20-embedding.md`

- [ ] **Step 1: Write the doc**

Create `docs/20-embedding.md` with this content:

````markdown
# 20 — Embedding Auggy in your frontend

> **Primitives reference.** Auggy ships the runtime primitives needed to wire a chat surface (your own widget, your own framework, your own deployment topology) to a running agent. This doc documents the wire contract — identity resolution, the AG-UI event shape on the response, visitor-token rotation, and the visitorAuth verify endpoint. It deliberately does **not** ship a copy-paste recipe.

**Why no recipe?** A copy-paste integration recipe is a security-sensitive artifact at the adopter's application layer (origin policy, CSRF gates, cookie domain, token storage, framework idioms). The right shape for those decisions depends on the adopter's stack and topology. Auggy ships clean primitives; you compose them.

**Creator-side chat (skip this doc):** if you want to chat with your own agent, use `auggy chat` (Local GUI) or `telegramTransport` (mobile). See `docs/15-chat.md` and `docs/14-telegram-transport.md`. The future operator-browser surface is G36 `/admin`.

**Visitor-side chat (this doc):** the contract a visitor-facing frontend must satisfy to talk to a running Auggy agent.

---

## The wire

A visitor turn is one HTTP POST:

```
POST <agent-url>/agent/run
Content-Type: application/json
Authorization: <optional — see "Identity resolution" below>
x-visitor-token: <optional — see "Identity resolution">
x-agent-id, x-agent-secret: <optional — agent-to-agent only>
Idempotency-Key: <optional — cost-dedup on retry>

{ "messages": [{ "role": "user", "content": "..." }], "threadId": "<your-choice>" }
```

The response is a Server-Sent Events stream of AG-UI events:

```
data: {"type":"RUN_STARTED","threadId":"...","runId":"..."}
data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Hello"}
data: {"type":"TEXT_MESSAGE_CONTENT","delta":" there"}
...
data: {"type":"TEXT_MESSAGE_END"}
data: {"type":"RUN_FINISHED"}
```

Full event taxonomy (TEXT_MESSAGE_*, TOOL_CALL_*, RUN_ERROR, etc.) lives in `docs/06-transports.md`. The minimum a chat widget handles is `TEXT_MESSAGE_CONTENT` (delta accumulation) and `RUN_FINISHED` / `RUN_ERROR` (terminal states).

---

## Identity resolution

`webTransport.identify()` (`src/transports/web-transport.ts`) resolves each request to one of four mutually-exclusive identity paths:

| Path | Trigger | trustLevel | peer.id |
|---|---|---|---|
| **1 Creator** | Valid bearer matching `webTransport.auth.token`, AND no `x-visitor-token`, AND no `x-agent-*` headers | `creator` | hardcoded `"creator"` |
| **2 Agent** | `x-agent-id` + matching `x-agent-secret` (timing-safe compare) | `agent` | `"agent:" + x-agent-id` |
| **3 Public / recognized** | Valid HMAC-signed `x-visitor-token` (not revoked, `agentBinding` matches) | `public` + `recognized` | `payload.visitorId` from the token (stable across requests) |
| **4 Public / anonymous** | Default — fallback when above don't match. Includes admitted-by-`allowAnonymous` with no bearer AND bearer-validated with present-but-invalid visitor token | `public` + `anonymous` | `"anon-" + threadId` |

What other headers do:

- `x-peer-name` — cosmetic `displayName`. Does NOT affect trust.
- `x-peer-kind` — `kind` field (`"human"` / `"agent"` / etc.). Does NOT affect trust.
- `x-org-id` — cosmetic `orgId`. Does NOT affect trust.
- **`x-peer-id` — accepted but UNUSED by identity resolution.** Do not rely on it for identity scoping; use `threadId` for anonymous continuity or `x-visitor-token` for durable identity.

`allowAnonymous` is the operator's gate (`webTransport.allowAnonymous: true` in yaml, or `AUGGY_ALLOW_ANONYMOUS=true` env var). Default rule: `NODE_ENV !== "production"`. See `docs/06-transports.md#anonymous-posture` for the resolution precedence.

---

## Visitor-token rotation

When `webTransport.visitorTokens.enabled: true`, a visitor's first request must include an `x-visitor-token` header — any non-empty value works as a bootstrap sentinel (`x-visitor-token: bootstrap` is the documented convention). On receiving a request with a missing/invalid `x-visitor-token`, the runtime mints a fresh `vis_<uuid>` HMAC-signed token and returns it in the response's `x-visitor-token` header. The current request stays at `public/anonymous`; the newly-issued token is for **future** requests.

The next request from the same visitor includes that minted token, which resolves to `public/recognized` with a stable `peer.id` (the `visitorId` embedded in the token's payload). Memory namespace stays consistent across requests for that visitor.

If the request has no `x-visitor-token` header at all, no token is minted — the request is treated as anonymous, but the visitor has no continuity into future requests. A correctly-implemented widget MUST send the sentinel on first contact and the rotated token thereafter.

The signing key (`visitorTokens.signingKey`) is injected at boot by visitorAuth when present (so visitor-tokens and verify-flow tokens share trust). Operators who run with `visitorTokens` but no `visitorAuth` set their own signing key directly.

Token TTL defaults to 30 days (`visitorTokens.ttlSeconds`). **Expired tokens are rejected** — `verifyVisitorToken` returns null when `payload.expiresAt < Date.now()`. The visitor falls back to anonymous on the next request and must re-bootstrap (or re-verify via visitorAuth for `vis_<uuid>` continuity). Tokens are also checked against the revocation list on every request — a revoked token is treated as invalid regardless of TTL.

---

## visitorAuth verify endpoint

If the `visitorAuth` augment is mounted, the agent exposes `GET / POST /visitor-auth/verify`. The flow:

1. Inside chat, the agent calls the `request_auth({email})` tool.
2. AgentMail (real or console — see `docs/19-visitor-auth.md`) sends the visitor a magic link to `<agent>/visitor-auth/verify?token=<single-use-jwt>`.
3. Visitor clicks → GET renders a confirm page (no consumption).
4. Visitor confirms → POST consumes the token, mints a long-lived `vis_<uuid>`, returns success page.
5. **Token handoff back to your widget** depends on your topology — see "Token handoff" below.

The single-use POST is mail-scanner-prefetch safe (scanners do GET, not POST).

---

## Token handoff (the deployment-topology question)

After verify, the upgraded `vis_<uuid>` lives in the verify page's response. How does your chat widget receive it?

The answer depends on whether your widget shares an origin (or eTLD) with the agent. Today the verify-page implementation stores the token in `localStorage` on the agent's origin — works for same-origin widgets, requires a handoff mechanism for cross-origin ones. We're shipping `successHandoff` config (`localStorage` / `postMessage` / `redirect` / shared-cookie via subdomain) as a separate runtime change.

Until that lands, your options:

| Widget topology | Handoff |
|---|---|
| Widget served from `<agent>/` (same-origin, e.g., bundled `GET /chat` page — G2) | Current localStorage handoff works as-is. |
| Widget on a subdomain of the same eTLD as the agent (e.g., `app.example.com` ↔ `chat.example.com`) | Shared-cookie via `Domain=.example.com` (requires the upcoming `successHandoff: shared-cookie` config). |
| Widget cross-origin (different eTLD or no shared parent) | Fragment redirect, popup + postMessage, or device-code polling — your call, your code. |

This doc deliberately doesn't pick one — the right choice depends on your stack.

---

## Operator-side / creator surfaces (NOT this doc)

For creator-side chat (the operator chatting with their own agent), Auggy ships two surfaces today:

- **`auggy chat`** — Local GUI (Vite/React SPA + Bun proxy on `127.0.0.1`). Discovers running agents via PID manifests. See `docs/15-chat.md`.
- **`telegramTransport`** — Telegram bot, polling or webhook mode. See `docs/14-telegram-transport.md`.

Future: G36 `/admin` route adds an in-browser operator surface using HTTP basic auth with the bearer as password. Designed; not yet shipped.

---

## Tested reference

`tests/integration/embedding-primitives.test.ts` boots a real agent + makes direct HTTP requests to assert these identity-path behaviors:

- Valid bearer → `creator` trust, `peer.id === "creator"` (Path 1)
- Present-but-invalid bearer → 401 (no silent downgrade to anonymous; security claim)
- No bearer + bootstrap `x-visitor-token` → `public/anonymous`, fresh `vis_<uuid>` returned in response header (Path 4)
- Subsequent request with the rotated token → `public/recognized`, stable `peer.id` (Path 3)
- visitorAuth flow with console adapter → upgraded `vis_<uuid>` token (Path 3 via verify)
- `x-peer-id` header is ignored for identity regardless of request shape (regression guard)

Six tests. **Out of scope for this test file:** agent-path identity (Path 2, covered in `src/transports/web-transport.test.ts`), full AG-UI event taxonomy (`docs/06-transports.md` + transport unit tests), visitorAuth verify-page GET/POST mechanics (`tests/augments/visitor-auth/*.test.ts`), Idempotency-Key behavior (`tests/integration/budgets-and-trust.test.ts`).

If you change webTransport identity resolution or visitorAuth's upgrade flow, run this test to verify the documented identity-path contract still holds.

---

## Cross-references

- **Wire protocol details**: [`docs/06-transports.md`](./06-transports.md) — full AG-UI event shape, all four identity paths in depth, allowAnonymous resolution.
- **Visitor recognition flow**: [`docs/19-visitor-auth.md`](./19-visitor-auth.md) — magic-link verification, console-adapter for OSS testing, production safeguards.
- **Operator-side chat**: [`docs/15-chat.md`](./15-chat.md) (Local GUI) and [`docs/14-telegram-transport.md`](./14-telegram-transport.md) (Telegram).
- **G3 `allowAnonymous` posture**: [`docs/06-transports.md#anonymous-posture`](./06-transports.md#anonymous-posture).
- **G34 console-mail-client**: [`docs/19-visitor-auth.md#console-mode-for-local-testing`](./19-visitor-auth.md#console-mode-for-local-testing).
````

- [ ] **Step 2: Verify the file renders without obvious issues**

```bash
wc -l docs/20-embedding.md
```
Expected: ~120 lines (down from PR #50's final ~500+).

```bash
grep -nE "Pattern [AB]|recipe|copy-paste" docs/20-embedding.md
```
Expected: only the "no recipe" / "no copy-paste" framing in the intro. No Pattern A/B residue.

---

## Task 3: Port the integration test (trimmed + renamed)

**Files:**
- Create: `tests/integration/embedding-primitives.test.ts`

We salvage the runtime-contract pieces from PR #50's test, drop the recipe-specific pieces (signed-cookie threadId continuity, tampered-cookie rejection, idempotency truth — those tested a specific copy-paste pattern, not the runtime contract).

- [ ] **Step 1: Pull the source content from the closed branch (local ref still works)**

```bash
git show docs/g1-embedding-recipe:tests/integration/embedding-recipe.test.ts > /tmp/embedding-recipe.test.ts.orig
wc -l /tmp/embedding-recipe.test.ts.orig
```
Expected: ~650 lines.

- [ ] **Step 2: Write the trimmed primitives test**

Create `tests/integration/embedding-primitives.test.ts`. Salvage the imports + the peer-capture augment helper, drop the signed-cookie helpers (recipe-specific). Six test cases:

**Ported from PR #50 (with `recipeProxy` removed — direct fetch instead):**
- `request without bearer + bootstrap visitor-token → public/anonymous + fresh token in response`
- `subsequent request with rotated token → public/recognized with stable peer.id`
- `visitorAuth upgrade flow with console adapter → upgraded vis_<uuid> token`
- `x-peer-id is IGNORED for identity (regression guard for codex finding 2)`

**New tests added per round-5 finding #2 (broader identity-contract coverage):**
- `valid bearer → creator trust, peer.id === "creator"` — Path 1
- `present-but-invalid bearer → 401, never silent downgrade to anonymous` — security claim about Path-1 failure mode

**Dropped from PR #50** (verified a specific copy-paste recipe, not the runtime contract):
- `signed cookie binds threadId across requests` — recipe's cookie helper, not a runtime feature
- `tampered cookie → fresh threadId minted` — same
- `Idempotency-Key dedups budget reservation but kernel re-calls model on retry` — covered conceptually in `tests/integration/budgets-and-trust.test.ts` (via `inject()`)
- `malformed auggy-thread cookie (URIError) → fresh threadId minted` — recipe's cookie helper

Also drop the `recipeProxy` function — we test against `/agent/run` directly (no inline proxy) because there is no recipe to mirror. The remaining tests use direct fetch.

Update the docblock to reflect the rename and the narrower scope: verifies the identity-path runtime contract; explicitly does NOT cover agent path, AG-UI event taxonomy, visitorAuth verify-page mechanics, or HTTP-layer Idempotency-Key behavior (each lives in a more specific test file).

```typescript
/**
 * Integration test for `docs/20-embedding.md` — verifies the identity-path
 * runtime contract documented as the primitives reference. Each test boots a
 * real agent + uses direct fetch against /agent/run to assert
 * webTransport.identify() resolves the documented identity paths correctly.
 *
 * Closes codex adversarial-review findings on the (now-closed) recipe PR #50
 * and the round-5 review on the replacement plan:
 *   1. A request without a bearer MUST resolve to public:anonymous, NOT creator.
 *   2. `x-peer-id` MUST NOT be used for identity.
 *   3. A valid bearer MUST resolve to creator trust.
 *   4. An invalid bearer MUST 401 (no silent downgrade to anonymous).
 *
 * Out of scope (covered elsewhere): agent path (src/transports/* tests),
 * full AG-UI event taxonomy (transport unit tests), visitorAuth verify-page
 * GET/POST mechanics (tests/augments/visitor-auth/*), Idempotency-Key
 * behavior (tests/integration/budgets-and-trust.test.ts).
 *
 * If you change webTransport.identify or visitorAuth's upgrade flow, run this
 * test to confirm the documented identity-path contract still holds.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { defineAgent } from "@/agent";
import { webTransport } from "@/transports/web-transport";
import { visitorAuth } from "../../src/augments/visitor-auth/index";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTempDir } from "@tests/fixtures/temp-dir";
import type { AgentHandle, Augment, PeerIdentity, TurnState } from "@/types";

const SIGNING_KEY = "shared-signing-key-embedding-primitives-test";
const BEARER = "embedding-primitives-bearer";

interface PeerCapture {
  augment: Augment;
  captured: PeerIdentity[];
}

function createPeerCaptureAugment(): PeerCapture {
  const captured: PeerIdentity[] = [];
  const augment: Augment = {
    name: "peer-capture",
    capabilities: ["context"],
    context: async (turn: TurnState) => {
      if (turn.peer) captured.push(turn.peer);
      return [];
    },
  };
  return { augment, captured };
}

describe("integration: embedding primitives (docs/20-embedding.md)", () => {
  let tmp: { path: string; cleanup: () => Promise<void> };
  let agent: AgentHandle | undefined;

  beforeEach(async () => {
    tmp = await createTempDir();
  });

  afterEach(async () => {
    try {
      await agent?.stop();
    } catch {
      // ignore
    }
    agent = undefined;
    await tmp.cleanup();
  });

  // (port the 4 runtime-contract tests here, removing the recipeProxy indirection —
  // each test fetches /agent/run directly with the headers it cares about.
  // Use the bodies from the closed-branch source for guidance.)
});
```

The exact body of the four ported test cases comes from `git show docs/g1-embedding-recipe:tests/integration/embedding-recipe.test.ts`. Adapt them to call `fetch(...)` directly against `/agent/run` instead of going through `recipeProxy`. Use ports `19200`–`19205` (six tests).

For the "subsequent request with rotated token" test: since there's no `recipeProxy` to forward the response's `x-visitor-token` header back, the test now needs to:
1. Call /agent/run with `x-visitor-token: bootstrap`
2. Read the response's `x-visitor-token` header
3. Call /agent/run again with that token
4. Assert the second call resolves to `public/recognized`

For the "visitorAuth upgrade flow" test: same shape — direct fetch, no proxy.

For the "x-peer-id IGNORED" test: already does direct fetch in the original (the `void proxy;` line). Remove the unused proxy variable.

For "request without bearer + bootstrap": direct fetch, assert response status + `x-visitor-token` header + captured peer identity.

**For the new "valid bearer → creator" test** (Path 1):

```typescript
it("valid bearer → creator trust, peer.id === \"creator\"", async () => {
  const PORT = 19204;
  const model = createMockModel({ response: "hi creator" });
  const peerCapture = createPeerCaptureAugment();

  const transport = webTransport({
    port: PORT,
    auth: { type: "bearer", token: BEARER },
    allowAnonymous: false,
  });
  agent = defineAgent(
    { name: "path1-creator", model: "mock", augments: [transport, peerCapture.augment] },
    model,
  );
  await agent.start();

  const resp = await fetch(`http://localhost:${PORT}/agent/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${BEARER}`,
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      threadId: "thread-creator",
    }),
  });
  expect(resp.status).toBe(200);
  await resp.text();

  expect(peerCapture.captured).toHaveLength(1);
  const peer = peerCapture.captured[0]!;
  expect(peer.trustLevel).toBe("creator");
  expect(peer.id).toBe("creator");
}, 30_000);
```

**For the new "invalid bearer → 401" test** (Path 1 failure mode, security claim):

```typescript
it("present-but-invalid bearer → 401, never silent downgrade to anonymous", async () => {
  // CRITICAL security claim: an invalid bearer MUST 401. The runtime never
  // silently treats an invalid bearer as "no bearer" and admits the request
  // as anonymous — that would let an attacker probe what the bearer should be
  // by trying random tokens and watching for 200 vs 401.
  const PORT = 19205;
  const model = createMockModel({ response: "should never reach model" });
  const peerCapture = createPeerCaptureAugment();

  const transport = webTransport({
    port: PORT,
    auth: { type: "bearer", token: BEARER },
    // Note: allowAnonymous: true. Even with anonymous admitted, a PRESENT
    // but WRONG bearer must still 401 — the runtime does not downgrade.
    allowAnonymous: true,
    visitorTokens: { enabled: true, signingKey: SIGNING_KEY, ttlSeconds: 86_400 },
  });
  agent = defineAgent(
    { name: "path1-invalid", model: "mock", augments: [transport, peerCapture.augment] },
    model,
  );
  await agent.start();

  const resp = await fetch(`http://localhost:${PORT}/agent/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer wrong-token-12345`,
      "x-visitor-token": "bootstrap",
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      threadId: "thread-invalid-bearer",
    }),
  });

  expect(resp.status).toBe(401);
  await resp.text();
  // Model never reached.
  expect(peerCapture.captured).toHaveLength(0);
}, 30_000);
```

- [ ] **Step 3: Run the new test**

```bash
bun test tests/integration/embedding-primitives.test.ts 2>&1 | tail -10
```
Expected: `6 pass / 0 fail`.

- [ ] **Step 4: Verify no Pattern A/B residue in test file**

```bash
git grep -nE "Pattern [AB]|pattern[AB]|recipeProxy|patternAProxy|patternBProxy" tests/integration/embedding-primitives.test.ts
```
Expected: empty (clean).

---

## Task 4: Cherry-pick chat/server.ts malformed-URI hardening from the closed branch

**Files:**
- Modify: `chat/server.ts`
- Modify: `chat/tests/server.test.ts`

The `decodeURIComponent` try/catch hardening at `chat/server.ts:195` is a durable runtime fix unrelated to the embedding recipe — it prevents the Bun.serve `/api/chat/<id>` route from surfacing a 500 on malformed percent-encoded paths (e.g., `/api/chat/%ZZ`). The fix landed on the closed branch in commit `0111bc1` and would be stranded if not extracted.

The diff is small (~15 LOC in `chat/server.ts`, ~13 LOC regression test in `chat/tests/server.test.ts`). Re-apply by hand rather than `git cherry-pick` because `cherry-pick` would also bring the doc/CHANGELOG changes from `0111bc1` that we DON'T want — those are recipe-related.

- [ ] **Step 1: Inspect the desired changes from the closed branch**

```bash
git diff main docs/g1-embedding-recipe -- chat/server.ts chat/tests/server.test.ts
```
Expected: the diff shows the try/catch wrap around `decodeURIComponent` plus the regression test "POST /api/chat/<id> with malformed percent-encoding returns 404 (not 500)".

- [ ] **Step 2: Apply the chat/server.ts change**

Open `chat/server.ts`. Find the block:

```ts
      if (url.pathname.startsWith("/api/chat/") && req.method === "POST") {
        const agentId = decodeURIComponent(url.pathname.slice("/api/chat/".length));
        return handleChatProxy(req, agentId);
      }
```

Replace with:

```ts
      if (url.pathname.startsWith("/api/chat/") && req.method === "POST") {
        // decodeURIComponent throws URIError on malformed percent-encoding
        // (e.g. `/api/chat/%ZZ`). Treat as 404 rather than letting it surface
        // as a Bun.serve 500.
        let agentId: string;
        try {
          agentId = decodeURIComponent(url.pathname.slice("/api/chat/".length));
        } catch {
          return new Response("Not Found", { status: 404 });
        }
        return handleChatProxy(req, agentId);
      }
```

- [ ] **Step 3: Add the regression test in chat/tests/server.test.ts**

Open `chat/tests/server.test.ts`. Find the existing test:

```ts
  it("POST /api/chat/<id> with unknown agent returns 404", async () => {
    const port = await bootServer();
    const res = await fetch(`http://localhost:${port}/api/chat/nonexistent`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://localhost:${port}` },
      body: JSON.stringify({ message: "x" }),
    });
    expect(res.status).toBe(404);
  });
```

Insert immediately after it:

```ts
  it("POST /api/chat/<id> with malformed percent-encoding returns 404 (not 500)", async () => {
    // `%ZZ` is not valid percent-encoding — decodeURIComponent throws URIError
    // on it. Without the try/catch wrap in the route handler, Bun.serve would
    // surface this as a 500. Regression guard.
    const port = await bootServer();
    const res = await fetch(`http://localhost:${port}/api/chat/%ZZ`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://localhost:${port}` },
      body: JSON.stringify({ message: "x" }),
    });
    expect(res.status).toBe(404);
  });
```

- [ ] **Step 4: Run chat tests**

```bash
cd chat && bun test 2>&1 | tail -5
```
Expected: `12 pass / 0 fail` (was 11 on main; +1 with the new regression test).

```bash
cd ..  # back to repo root for subsequent tasks
```

---

## Task 5: Update CHANGELOG.md (3 bullets)

**Files:**
- Modify: `CHANGELOG.md`

PR #50 was never merged, so its CHANGELOG entries don't exist on main. We add a fresh, honest Unreleased bullet for the primitives reference.

- [ ] **Step 1: Inspect the current Unreleased section on main**

```bash
sed -n '1,30p' CHANGELOG.md
```
Confirm the Unreleased section exists and matches main's state (no recipe bullets — they only existed on the closed branch).

- [ ] **Step 2: Add three bullets under `### Added` in the `## [Unreleased]` section**

Replace the placeholder Added section (or insert as the first bullets) with:

```markdown
- **`docs/20-embedding.md` primitives reference** for wiring a visitor-facing chat surface to a running Auggy agent. Documents the wire contract (POST `/agent/run` with AG-UI SSE response), the identity-path resolution of `webTransport.identify()` (creator / agent / public-recognized / public-anonymous), the visitor-token bootstrap + rotation flow (including TTL expiry semantics), and the visitorAuth verify endpoint. Deliberately ships **no copy-paste recipe** — visitor-side widgets are an adopter-application-layer concern (origin policy, CSRF gates, cookie domain, framework idioms) where Auggy's job is to expose clean primitives, not to ship a security-sensitive integration the adopter is supposed to copy. Replaces the deferred PR #50 "embedding recipe" direction; the recipe doc surfaced four rounds of codex findings about gaps at the adopter-app layer (CSRF / verify-page reverse-proxy / trust boundaries), all of which dissolved by reframing as primitives. Tested by `tests/integration/embedding-primitives.test.ts` (6 tests covering identity paths + visitorAuth upgrade flow). (G1 — v1.0 concierge-readiness.)
- **`tests/integration/embedding-primitives.test.ts`** — integration suite that boots a real agent and asserts: a valid bearer resolves to `creator` trust with `peer.id === "creator"` (Path 1); a present-but-invalid bearer returns 401 with no silent downgrade to anonymous (security claim about Path 1 failure mode); a request without bearer + bootstrap visitor-token resolves to `public/anonymous` with a fresh token in the response (Path 4); the rotated token resolves to `public/recognized` with a stable `peer.id` (Path 3); the visitorAuth upgrade flow (G34 console adapter) mints a `vis_<uuid>`; `x-peer-id` is ignored for identity regardless of request shape. Regression guard against runtime drift from the documented identity-path contract.
- **`chat/server.ts` malformed-path hardening.** The Local GUI proxy's `/api/chat/<id>` route now catches `URIError` from `decodeURIComponent` and returns 404 instead of surfacing a Bun.serve 500. Regression coverage in `chat/tests/server.test.ts`. (Extracted from the closed PR #50 branch — durable runtime hardening unrelated to the embedding recipe.)
```

- [ ] **Step 3: Verify CHANGELOG parses (no obvious markdown breakage)**

```bash
head -20 CHANGELOG.md
```
Expected: the new bullets sit cleanly under `### Added` in `## [Unreleased]`. No section headers broken.

---

## Task 6: Update docs/todos.md Tier-3 wording

**Files:**
- Modify: `docs/todos.md`

The Tier-3 line currently says "Recipe doc is enough for v1.0" — that wording is wrong under the pivot. Reframe.

- [ ] **Step 1: Locate the current Tier-3 line**

```bash
grep -n "G1 packaged" docs/todos.md
```
Expected: a line in Tier 3 referencing `@auggy/chat-widget-react`.

- [ ] **Step 2: Replace the line**

Find:
```
- [ ] **[chat-widget]** Publish `@auggy/chat-widget-react` (+ optional `@auggy/next` route helper). Recipe doc is enough for v1.0; package shape benefits from real adopter feedback. (G1 packaged)
```

Replace with:
```
- [ ] **[chat-widget]** Publish `@auggy/chat-widget-react` (+ optional `@auggy/next` route helper) and/or a Web Component embed. v1.0 ships primitives reference only (`docs/20-embedding.md`) — packaged widget shape benefits from real adopter feedback (looselyorganized.xyz first). Generative-UI vision: components Auggy emits via tool calls (DossierCard, ChoicePrompt, FormBubble, etc.) using the existing AG-UI `TOOL_CALL_*` payload as the render contract — no runtime protocol changes. (G1 packaged + G37 ui-kit)
```

This also adds the G37 ui-kit pointer that came out of this session's brainstorming.

- [ ] **Step 3: Verify the diff is what we expected**

```bash
git diff docs/todos.md
```
Expected: one line removed, one line added.

---

## Task 7: Update docs/19-visitor-auth.md cross-references (if any)

**Files:**
- Modify (conditional): `docs/19-visitor-auth.md`

- [ ] **Step 1: Check what 19-visitor-auth says about 20-embedding**

```bash
grep -n "20-embedding\|recipe" docs/19-visitor-auth.md
```

- [ ] **Step 2: If the reference says "see the recipe" or similar, soften to "see the primitives reference"**

If matches exist with "recipe" wording, edit each to say "primitives reference" instead. If no matches or wording is already neutral, skip this task.

```bash
git diff docs/19-visitor-auth.md
```
Expected: small wording changes only, or empty diff (no edit needed).

---

## Task 8: Run all gates

**Files:** None modified.

- [ ] **Step 1: Run full test suite**

```bash
bun test 2>&1 | tail -5
```
Expected: `1949 pass / 0 fail` (was 1955; -9 dropped tests from embedding-recipe.test.ts plus +4 new tests in embedding-primitives.test.ts; chat tests stay at 83; net: 1955 - 9 + 4 - 1 chat-malformed-test = 1949; verify the actual count before claiming).

Note: The chat/server.ts decodeURIComponent fix is on the closed branch. It does NOT come over to this fresh branch from main. So `chat/tests/server.test.ts` reverts to its pre-fix count of 10 (was 11 with the malformed-cookie test). The earlier +1 chat test from PR #50 also doesn't survive. Recompute the expected:
- main baseline (before PR #50): 1955 - 9 (embedding-recipe tests, none of which exist on main yet) = 1946
- This branch adds 4 new tests in embedding-primitives.test.ts
- Total: 1950

Actually the cleanest verification is: run the baseline on main first, then count the delta. Let me adjust step 1:

```bash
# On main BEFORE checking out the new branch:
git stash list  # confirm no stashed work
git switch main
bun test 2>&1 | tail -3
# capture the count, call it MAIN_COUNT
git switch docs/g1-primitives-reference
bun test 2>&1 | tail -3
# verify count == MAIN_COUNT + 7  (6 new primitives tests + 1 new chat malformed-URI test)
```

If the math doesn't add up, investigate before continuing. The `+7` math:
- `tests/integration/embedding-primitives.test.ts` adds 6 tests (didn't exist on main)
- `chat/tests/server.test.ts` adds 1 test (the malformed-URI regression test from Task 4)
- Net delta from main: +7

Also explicitly run the chat tests in isolation to confirm the cherry-pick survived:

```bash
cd chat && bun test 2>&1 | tail -3 && cd ..
```
Expected: `12 pass / 0 fail` (was 11 on main).

- [ ] **Step 2: Typecheck**

```bash
bunx tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Lint**

```bash
bun run lint 2>&1 | tail -3
```
Expected: 0 errors, baseline warnings preserved (29 warnings + 1 info from main; the doc changes shouldn't add warnings).

- [ ] **Step 4: Residue sweep**

```bash
git grep -nE "Pattern [AB]|pattern[AB]|two patterns|two-pattern|recipeProxy|patternAProxy|patternBProxy" docs/ tests/ CHANGELOG.md
```
Expected: empty.

---

## Task 9: Commit + push + open replacement PR (PR #50 still open at this point)

**Files:** None modified — git ops only.

- [ ] **Step 1: Review the staged diff**

```bash
git status
```
Expected: 6-7 modified/new files (`docs/20-embedding.md`, `tests/integration/embedding-primitives.test.ts`, `chat/server.ts`, `chat/tests/server.test.ts`, `CHANGELOG.md`, `docs/todos.md`, optionally `docs/19-visitor-auth.md`).

```bash
git diff --stat
```
Expected: ~250-400 lines added across ~7 files — still much smaller than PR #50's churn.

- [ ] **Step 2: Stage everything**

```bash
git add docs/20-embedding.md tests/integration/embedding-primitives.test.ts chat/server.ts chat/tests/server.test.ts CHANGELOG.md docs/todos.md
```
If Task 7 made changes, also `git add docs/19-visitor-auth.md`.

- [ ] **Step 3: Commit with HEREDOC message**

```bash
git commit -m "$(cat <<'EOF'
docs(embedding): primitives reference (G1) — replaces deferred copy-paste recipe

Following four rounds of adversarial review on the original PR #50 recipe doc,
the recurring pattern of findings was structural: each round surfaced a new
gap at the adopter-application layer (CSRF, verify-page reverse-proxy trust
boundaries, cross-origin handoff mechanics), not in the runtime itself.

The recipe was solving an integration problem adopters should own — origin
policy, CSRF gates, cookie domain, framework idioms — using a one-size-fits-all
copy-paste pattern that didn't actually fit any specific topology.

This PR ships the smaller, durable answer:

- `docs/20-embedding.md` — primitives reference. Documents the wire (POST
  /agent/run + AG-UI SSE), the identity-path resolution of webTransport.identify(),
  visitor-token bootstrap + rotation (including TTL expiry semantics — codex
  R5 finding #1), and the visitorAuth verify endpoint. NO copy-paste recipe.
  Token-handoff topology question explicitly punted to the adopter.

- `tests/integration/embedding-primitives.test.ts` — 6 tests verifying the
  identity-path contract: creator path (Path 1), invalid-bearer 401 (Path 1
  failure mode, security claim), public-anonymous bootstrap (Path 4),
  public-recognized rotation (Path 3), visitorAuth upgrade flow, x-peer-id
  is ignored. Out of scope: agent path (Path 2 — covered in src/transports
  tests), AG-UI event taxonomy, verify-page mechanics, Idempotency-Key
  behavior (each in a more specific test file). Regression guard against
  drift from the documented identity contract. (Codex R5 finding #2: broader
  test coverage to match the doc's contract claims.)

- `chat/server.ts` malformed-URI hardening + regression test extracted from
  the (now-deleted) PR #50 branch. The /api/chat/<id> route now catches
  URIError from decodeURIComponent and returns 404 instead of Bun.serve 500.
  Durable runtime hardening, unrelated to the embedding recipe. (Codex R5
  finding #4: don't strand this fix on the closed branch.)

- CHANGELOG: 3 bullets explaining the pivot, the test, and the chat hardening.

- `docs/todos.md` Tier-3 G1-packaged line reframed to remove "Recipe doc is
  enough for v1.0" wording; adds the G37 ui-kit pointer (component-emit-
  through-chat vision from this session's brainstorming).

Follow-on runtime work (separate PR, half-day): visitorAuth `successHandoff`
config with `shared-cookie` mode (Domain=.parent.tld HttpOnly cookie), so
subdomain-deployed agents share visitor identity with their parent-domain
frontend transparently. This is the cleanest path for the looselyorganized.xyz
deployment and any adopter who can run their agent on a subdomain.

Codex R4 findings dropped to non-issues: CSRF on /api/chat (recipe-specific)
and verify-page reverse-proxy trust collapse (recipe-specific) — neither
pattern exists in the primitives reference.

PR #50 is closed in a separate task after this PR is opened and CI is green
(codex R5 finding #3: don't close-before-replacement-exists to avoid dead
forward pointers).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```
Expected: `[docs/g1-primitives-reference <sha>] docs(embedding): primitives reference (G1) — replaces deferred copy-paste recipe`.

- [ ] **Step 4: Push**

```bash
git push -u origin docs/g1-primitives-reference
```
Expected: `Branch 'docs/g1-primitives-reference' set up to track 'origin/docs/g1-primitives-reference'`.

- [ ] **Step 5: Open the new PR**

```bash
gh pr create --title "docs(embedding): primitives reference (G1)" --body "$(cat <<'EOF'
## Summary

Replaces the (still-open as of this PR being filed) PR #50 — custom-proxy "embedding recipe" that became a security-recipe codex treadmill.

- `docs/20-embedding.md` is now a small **primitives reference** — wire contract, identity-resolution paths, visitor-token bootstrap + rotation (including TTL expiry), visitorAuth verify endpoint. No copy-paste recipe.
- `tests/integration/embedding-primitives.test.ts` verifies the identity-path contract (6 tests covering Path 1 / Path 3 / Path 4 + visitorAuth upgrade flow + invalid-bearer security claim).
- `chat/server.ts` malformed-URI hardening + regression test extracted from the PR #50 branch (durable runtime fix, unrelated to the recipe).
- CHANGELOG: 3 bullets.
- `docs/todos.md` Tier-3 G1-packaged line reframed.

## Why the pivot

PR #50 went through four rounds of `/codex:adversarial-review`. Each round surfaced a new gap at the **adopter-application layer** (CSRF on the proxy's `/api/chat`, verify-page reverse-proxy trust collapse, cross-origin handoff mechanics) — not in Auggy's runtime. The pattern wasn't isolated bugs; it was a categorical mismatch: a copy-paste recipe is a security-sensitive artifact at the adopter's layer, and the right shape for those decisions depends on stack + topology.

Reframing as primitives shrinks the doc ~80% and ends the round count.

This plan was itself reviewed via codex round 5 against the rev-1 plan; four findings (visitor-token contract mismatch, test-coverage overclaim, close-before-replacement hazard, chat hardening stranding) all integrated into rev-2 of the plan and reflected in this PR.

## Follow-on runtime work

`visitorAuth.successHandoff: shared-cookie` (with `cookieDomain` config) lands as a separate ~half-day PR. Enables subdomain-deployed agents to share visitor identity with the parent-domain frontend via HttpOnly first-party cookies. This is what unblocks the looselyorganized.xyz deployment cleanly.

## Test plan

- [x] `bun test` passes (MAIN_COUNT + 7 from main baseline)
- [x] `cd chat && bun test` — 12 pass (was 11 on main; +1 malformed-URI regression test)
- [x] `bunx tsc --noEmit` clean
- [x] `bun run lint` 0 errors, baseline warnings preserved
- [x] Residue sweep clean (no Pattern A/B / recipe / proxy framing leaks)
- [ ] `/codex:adversarial-review` round 6 (run after this PR is up; expect clean since the surface that surfaced earlier findings is gone and round-5 findings against this plan are integrated)

## Will close: #50

#50 will be closed in a separate operation immediately after this PR is opened and CI is green — link will be added here for traceability.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: returns the new PR URL.

- [ ] **Step 6: Record the new PR number**

```bash
NEW_PR=$(gh pr view --json number --jq '.number')
echo "New replacement PR: #$NEW_PR"
```
Capture the number for Task 10's closing comment. Keep `$NEW_PR` available in the shell.

- [ ] **Step 7: Wait for CI green on the new PR**

```bash
gh pr checks "$NEW_PR" --watch
```
Expected: all checks SUCCESS. Do NOT proceed to Task 10 (close PR #50) until CI is green — if CI fails, fix on the new branch and re-push; PR #50 stays open as the rollback path.

---

## Task 10: Close PR #50 with reference to the replacement PR

**Files:** None. GitHub state change only.

**Precondition:** Task 9 complete, replacement PR open, CI green on the replacement PR, `$NEW_PR` captured.

- [ ] **Step 1: Confirm preconditions**

```bash
gh pr view "$NEW_PR" --json state,statusCheckRollup --jq '"replacement state=\(.state) checks=\([.statusCheckRollup[] | .conclusion] | unique)"'
```
Expected: `replacement state=OPEN checks=["SUCCESS"]`. If anything else, abort and fix the replacement PR first.

```bash
gh pr view 50 --json state --jq '.state'
```
Expected: `OPEN` (PR #50 is still open at this point).

- [ ] **Step 2: Post the closing comment with the replacement PR # cited verbatim**

```bash
gh pr comment 50 --body "$(cat <<EOF
Closing this PR — replacement is up at #$NEW_PR (CI green).

After four rounds of codex adversarial review, the recurring finding pattern (each round surfacing a new gap at the adopter-app layer, not the runtime layer) made it clear we were polishing the wrong artifact. The custom-proxy recipe was solving an integration problem adopters should own, not one Auggy should ship.

**The pivot:**

- v1.0 ships runtime + transports + creator surfaces (\`auggy chat\`, Telegram). **No visitor-chat widget.**
- The visitor-side integration becomes the adopter's responsibility, with Auggy exposing the primitives clearly (corrected identity-model docs, AG-UI event contract, visitor-token bootstrap + rotation, AgentMail magic-link via visitorAuth) — but not a copy-paste recipe.
- looselyorganized.xyz becomes our showcase deployment. We build the widget for our own site; it becomes the de facto reference adopters can study.

**Replacement PR:** #$NEW_PR — \`docs/20-embedding.md\` rewritten as a primitives reference (no copy-paste code), \`tests/integration/embedding-primitives.test.ts\` verifies the identity-path contract (6 tests), \`chat/server.ts\` malformed-URI hardening extracted (durable, not recipe-specific), \`CHANGELOG\` updated to explain the call.

**Codex R4 high-sev findings** (CSRF on \`/api/chat\`, verify-page reverse-proxy trust collapse) drop to non-issues because neither pattern exists in the primitives reference. The reverse-proxy was a recipe-specific workaround; the CSRF concern only applied to the recipe's proxy code.

**Separate runtime work landing after:** visitorAuth \`successHandoff: shared-cookie\` option (with \`cookieDomain\` config), which makes subdomain-deployed agents share visitor identity with their parent-domain frontend via HttpOnly first-party cookies. ~half-day; arrives as its own PR.

Last commit on this branch: 0111bc1 (round-3 fixes — drop Pattern B, harden cookie helper, G36 design pivot). Commits remain visible in this closed PR's GitHub UI for anyone wanting to study the round-by-round design path.
EOF
)"
```
Expected: GitHub URL of the new comment. Note the use of `<<EOF` (no quotes) so `$NEW_PR` interpolates; backticks are escaped inline.

- [ ] **Step 3: Close PR #50 and delete the branch**

```bash
gh pr close 50 --delete-branch
```
Expected: `✓ Closed pull request #50 ... ✓ Deleted branch docs/g1-embedding-recipe`.

- [ ] **Step 4: Verify closure and remote branch deletion**

```bash
gh pr view 50 --json state --jq '.state'
```
Expected: `CLOSED`.

```bash
git ls-remote origin docs/g1-embedding-recipe
```
Expected: empty output (remote branch deleted).

- [ ] **Step 5: Post a follow-up comment on the replacement PR linking to closed #50**

```bash
gh pr comment "$NEW_PR" --body "PR #50 now closed with reference to this PR. Replacement landed; rollback path closed."
```

- [ ] **Step 6: Local branch hygiene (optional)**

Local `docs/g1-embedding-recipe` still exists and tracks the now-deleted remote. We don't delete it locally — it preserves the commits in your reflog if you ever need to dig.

```bash
git branch -vv | grep g1-embedding-recipe
```
Expected: line containing `: gone]` indicating the upstream is gone.

---

## Task 11: Adversarial review round 6 on the replacement PR

**Files:** None modified.

This task is a checkpoint, not code work. PR #50 is already closed (Task 10); the codex review is now against the live replacement PR.

- [ ] **Step 1: Tell the operator the PR is ready for `/codex:adversarial-review`**

The operator triggers `/codex:adversarial-review` against the replacement PR's branch (`docs/g1-primitives-reference`). The plan does not run codex itself — that's an operator-cost decision (billed).

- [ ] **Step 2: If round 6 surfaces findings — triage with operator**

Per the operating contract: high-sev → fix-push-loop on `docs/g1-primitives-reference`; nits → file in `docs/todos.md`, merge.

Expected outcome of round 6: clean or low-severity nits only. The CSRF/verify-page concerns that drove R4 are structurally absent in the primitives reference (no proxy code, no reverse-proxy guidance). The visitor-token contract mismatch and test-coverage overclaim from R5-against-the-plan are integrated in this rev's Task 2 doc text and Task 3 test list.

- [ ] **Step 3: Merge on green**

Once round 6 is clean (or findings filed), squash-merge:

```bash
gh pr merge "$NEW_PR" --squash --delete-branch
git checkout main && git pull --ff-only origin main
```

---

## Self-review

**Spec coverage:**

| Spec item | Task |
|---|---|
| Pre-flight verification | Task 0 |
| Create fresh branch from main | Task 1 |
| Write primitives-reference doc | Task 2 |
| Port + trim integration test (with R5 broader coverage) | Task 3 |
| Cherry-pick chat hardening (R5 finding #4) | Task 4 |
| Update CHANGELOG (3 bullets) | Task 5 |
| Update docs/todos.md Tier-3 wording | Task 6 |
| Clean up cross-references (conditional) | Task 7 |
| Run all gates | Task 8 |
| Commit, push, open replacement PR | Task 9 |
| Close PR #50 LAST with reference to replacement PR (R5 finding #3) | Task 10 |
| Codex round 6 + merge | Task 11 |

All spec items have a task. R5 findings #1, #2, #3, #4 all integrated. No gaps.

**Placeholder scan:** No "TBD" / "TODO" / "fill in" / "similar to Task N" patterns. Task 3's "port from the closed branch using these guidance shapes" gives concrete instructions; Task 4 includes the literal code blocks for the chat fix + regression test; Task 10's closing comment cites `$NEW_PR` as a variable that gets set in Task 9 step 6.

**Type consistency:** N/A — this PR is docs + tests + CHANGELOG + one small chat-server hardening, no new types or function signatures.

**Rollback paths preserved:**

- If Task 3-9 fails → PR #50 is still open, branch `docs/g1-embedding-recipe` is still on origin, no information lost.
- If CI fails on the replacement PR (Task 9 step 7) → fix on the new branch and re-push; PR #50 stays open until CI is green.
- If Task 10's close fails → replacement PR is already up and merged-pending; PR #50 just stays open until manually closed.
- If `$NEW_PR` variable is lost between sessions → recover via `gh pr view --json number,headRefName --jq 'select(.headRefName == "docs/g1-primitives-reference") | .number'` or `gh pr list --head docs/g1-primitives-reference --json number --jq '.[0].number'`.

**Round-5 findings integrated:**

1. ✅ Doc fixed to require bootstrap sentinel + state TTL rejection (Task 2's "Visitor-token rotation" section).
2. ✅ Tests expanded to 6 cases (Path 1, Path 1 failure 401, Path 3, Path 4, visitorAuth upgrade, x-peer-id ignored); doc coverage claims narrowed to match (Task 3's docblock + doc text).
3. ✅ Rollout reordered — branch + replacement PR open + CI green BEFORE closing #50 (Tasks 1-9 then 10).
4. ✅ chat/server.ts + chat/tests/server.test.ts cherry-picked from PR #50 branch into replacement PR (new Task 4). CHANGELOG bullet added (Task 5).

**Possible round-6 findings to anticipate** (notes for operator triage, not plan gaps):

- The plan deletes `docs/g1-embedding-recipe` from origin in Task 10 step 3. If we want to preserve the round-1/2/3 iteration history in a more accessible form than "scroll the closed PR's commit list," consider archiving the branch (e.g., `git push origin docs/g1-embedding-recipe:archive/g1-embedding-recipe-2026-05-15` before deleting). This isn't a R5 finding but might come up in R6.
- The CHANGELOG explicitly says "G1 — v1.0 concierge-readiness." A reviewer might ask whether G1 is now considered "done" (the primitives reference is shipped) or just "shipped in a smaller shape." The plan's framing is "G1 done, G1-packaged-widget deferred to post-v1.0." Pre-empted in the todos.md update.
- The doc forward-references `successHandoff` config that doesn't exist yet. We say "until that lands, your options are X/Y/Z" — current state is honest, but a reviewer could push back on advertising un-shipped runtime work. Defense: the section is framed as "the deployment-topology question," not as "this feature exists."

5. **Possible round-5 NEW findings** that the adversarial framing might surface:
   - The doc still mentions visitor-token rotation but doesn't specify CSRF gating on `/agent/run` itself — this is webTransport's responsibility, not the doc's, but a reviewer might flag the omission. Defense: the doc points to `docs/06-transports.md` for transport-level gating.
   - The doc names "successHandoff" config that doesn't exist yet — that's true; we say "shipping as a separate runtime change." Reviewer might flag this as forward-referencing unmerged work. Defense: the doc says "until that lands, your options are..." — current state is honest.

These are observations for the operator's R5 triage, not gaps in the plan itself.
