# AgentMail `emailOut` Notify Adapter Implementation Plan

> **✅ SHIPPED 2026-05-06** (AgentMail adapter integrated into the `notify` augment). This plan is historical reference; not actionable.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an AgentMail adapter to the existing `notify` augment so an aug1 can send outbound email via AgentMail (`POST /inboxes/{inbox_id}/messages`) using the same `notify({to, summary, ...})` tool surface that already drives `webhook` and `telegram`.

**Architecture:** New file `src/augments/notify/adapters/agentmail.ts` matches the existing webhook/telegram adapter contract (`NotifyAdapter.deliver(destination, payload)`). Uses the runtime's shared `createHttpClient` (from `src/http.ts`) — no new SDK dependency. Per-destination `apiKey` + `inboxId` + `to` (recipient email) on the destination config; cache the http client per `apiKey`. The notify augment's existing rate-limit, dedup, and trust-bypass machinery is unchanged. WebSocket/webhook *inbound* is out of scope — this plan is outbound-only.

**Tech stack:** TypeScript, Bun, `bun:test`. Uses existing `src/http.ts` (already battle-tested for SSRF defense, redirect security, body cap). No new runtime dependency.

**Out of scope (separate plans):** the bidirectional `emailTransport` augment (peer↔agent over AgentMail), the `aug1 deploy --to railway` CLI, AgentMail webhook inbound mode (deferred to v1.5 per the v1.0 launch sequencing — paid Railway services don't sleep, so WebSocket-only inbound is sufficient at v1.0 for the bigger transport plan).

---

## Reference context for the engineer

Read these before starting:

- `src/augments/notify.ts` — the augment's tool, dispatch logic (`adapters[destination.transport]`), rate-limit machinery
- `src/augments/notify/adapters/webhook.ts` — closest existing precedent (HTTP POST + auth + JSON body)
- `src/augments/notify/adapters/telegram.ts` — second precedent (per-token client cache, transport-mismatch guard)
- `src/types.ts:642-690` — `NotifyAdapterKind`, `NotifyDestination` union, `NotifyAdapter`, `NotifyDeliveryResult`
- `src/http.ts` — `createHttpClient({timeoutMs, userAgent})` returns `{post, get, ...}`. Use it; do not add `fetch`.
- `tests/augments/notify/adapters/webhook.test.ts` — mock pattern for `Pick<HttpClient, "post">`
- `tests/augments/notify.test.ts` — uses `adapters: { webhook, telegram }` overrides; this plan widens that override to include `agentmail` as optional

AgentMail send endpoint shape (from https://docs.agentmail.to/api-reference/inboxes/messages/send):

```
POST https://api.agentmail.to/v0/inboxes/{inbox_id}/messages
Authorization: Bearer am_<api-key>
Content-Type: application/json

{
  "to": ["recipient@example.com"],   // string OR array of strings; we always pass array
  "subject": "...",
  "text": "...",
  "html": "<p>...</p>",                // optional but recommended for deliverability
  "labels": ["..."]                    // optional
}

→ 200/201 { "message_id": "msg_...", "thread_id": "thd_..." }
→ 4xx { "error": "...", "detail": "..." }   // shape may vary — surface raw body
→ 429 { "error": "rate limit exceeded" }    // surface as failed; notify's own rate limit handles real backpressure
```

The base URL `https://api.agentmail.to/v0` is currently the documented production base; capture it as a default constant in the adapter, accept an `apiBaseUrl` override on the destination for testing/sandbox use.

---

## File structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/types.ts` | Modify (lines ~642–690) | Extend `NotifyAdapterKind` to include `"agentmail"`. Add `AgentMailNotifyDestination` interface. Extend `NotifyDestination` union. |
| `src/augments/notify/adapters/agentmail.ts` | Create | The adapter — `createAgentMailAdapter()` returns `NotifyAdapter`. ~80 LOC. |
| `src/augments/notify.ts` | Modify (lines 26–34) | Widen `NotifyAugmentInternalOptions.adapters` to `Partial<...>` and include `agentmail`. Default-construct `agentmail` adapter alongside webhook/telegram. |
| `tests/augments/notify/adapters/agentmail.test.ts` | Create | Adapter unit tests (~7 cases). |
| `tests/augments/notify.test.ts` | Modify | One new test: end-to-end via the `notify` tool with an `agentmail` destination. Existing tests unaffected (Partial override means missing `agentmail` field is fine). |
| `docs/13-notify.md` | Modify | New section "AgentMail adapter" mirroring the existing webhook + telegram sections (config example, env var hygiene, AgentMail-specific gotchas). |

---

## Task 1: Type definitions

**Files:**
- Modify: `src/types.ts:644-661`

- [ ] **Step 1: Extend `NotifyAdapterKind`**

In `src/types.ts`, change line 644 from:

```ts
export type NotifyAdapterKind = "webhook" | "telegram";
```

to:

```ts
export type NotifyAdapterKind = "webhook" | "telegram" | "agentmail";
```

- [ ] **Step 2: Add `AgentMailNotifyDestination` interface**

Insert after the `TelegramNotifyDestination` block (around line 660), before the `NotifyDestination` union:

```ts
export interface AgentMailNotifyDestination {
  name: string;
  transport: "agentmail";
  /** AgentMail API key (Bearer token, prefix `am_`). Resolve via env interpolation in agent.yaml. */
  apiKey: string;
  /** AgentMail inbox ID this notification is sent FROM. */
  inboxId: string;
  /** Recipient email address(es). String or array; adapter normalizes to array. */
  to: string | string[];
  /** Optional subject prefix prepended to the notify summary. e.g. "[Auggy] ". */
  subjectPrefix?: string;
  /** Optional labels applied to the sent message in AgentMail. */
  labels?: string[];
  /** Override the AgentMail API base URL (testing/sandbox). Default: https://api.agentmail.to/v0 */
  apiBaseUrl?: string;
}
```

- [ ] **Step 3: Extend the `NotifyDestination` union**

Change line 661 (now further down) from:

```ts
export type NotifyDestination = WebhookNotifyDestination | TelegramNotifyDestination;
```

to:

```ts
export type NotifyDestination =
  | WebhookNotifyDestination
  | TelegramNotifyDestination
  | AgentMailNotifyDestination;
```

- [ ] **Step 4: Verify typecheck passes**

Run: `bunx tsc --noEmit`
Expected: PASS (the union widening is structurally compatible; nothing references the union exhaustively yet — that change comes in Task 7).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts
git commit -m "feat(notify): add AgentMail destination type"
```

---

## Task 2: Failing test — happy-path send

**Files:**
- Create: `tests/augments/notify/adapters/agentmail.test.ts`

> **Implementation note (per Consumer-integration note above):** The adapter's HTTP send logic lives in a shared infrastructure module `src/agentmail-client.ts` rather than directly in the adapter. The adapter is then a thin shim: validate destination, build payload from notify's `{summary, reason, visitor}` fields, delegate to the client. Pattern matches `src/telegram-client.ts` shared by the telegram notify-adapter and the telegramTransport augment. Step 3 below shows both files.

- [ ] **Step 1: Write the failing test**

Create `tests/augments/notify/adapters/agentmail.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { createAgentMailAdapter } from "../../../../src/augments/notify/adapters/agentmail";
import type { AgentMailNotifyDestination } from "../../../../src/types";
import type { HttpResponse, HttpRequestInit } from "../../../../src/http";

function mockHttp(
  handler: (
    url: string,
    body: unknown,
    headers?: Record<string, string>,
  ) => { status: number; body: string },
) {
  return {
    post: async (url: string, opts?: Omit<HttpRequestInit, "method">): Promise<HttpResponse> => {
      const body = typeof opts?.body === "string" ? JSON.parse(opts.body) : undefined;
      const result = handler(url, body, opts?.headers);
      return {
        finalUrl: url,
        status: result.status,
        statusText: result.status >= 200 && result.status < 300 ? "OK" : "Error",
        contentType: "application/json",
        headers: new Headers({ "content-type": "application/json" }),
        body: result.body,
      };
    },
  };
}

const dest: AgentMailNotifyDestination = {
  name: "creator-mail",
  transport: "agentmail",
  apiKey: "am_test_key",
  inboxId: "inb_test123",
  to: "operator@example.com",
};

describe("agentMailAdapter", () => {
  it("POSTs to /inboxes/{inboxId}/messages with bearer auth and structured body", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;
    let capturedAuth = "";
    const adapter = createAgentMailAdapter({
      client: mockHttp((url, body, headers) => {
        capturedUrl = url;
        capturedBody = body;
        capturedAuth = headers?.["authorization"] ?? "";
        return { status: 200, body: JSON.stringify({ message_id: "msg_1", thread_id: "thd_1" }) };
      }),
    });
    const result = await adapter.deliver(dest, {
      summary: "Visitor wants to talk",
      reason: "Outside scope",
      visitor: "Sarah",
    });
    expect(capturedUrl).toBe("https://api.agentmail.to/v0/inboxes/inb_test123/messages");
    expect(capturedAuth).toBe("Bearer am_test_key");
    expect(capturedBody.to).toEqual(["operator@example.com"]);
    expect(capturedBody.subject).toBe("Visitor wants to talk");
    expect(typeof capturedBody.text).toBe("string");
    expect(capturedBody.text).toContain("Visitor wants to talk");
    expect(capturedBody.text).toContain("Outside scope");
    expect(capturedBody.text).toContain("Sarah");
    expect(result.status).toBe("sent");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/augments/notify/adapters/agentmail.test.ts`
Expected: FAIL with "Cannot find module" (createAgentMailAdapter does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/augments/notify/adapters/agentmail.ts`:

```ts
import { createHttpClient } from "../../../http";
import type { HttpClient } from "../../../http";
import type {
  NotifyAdapter,
  NotifyDestination,
  NotifyPayload,
  NotifyDeliveryResult,
  AgentMailNotifyDestination,
} from "../../../types";

const DEFAULT_BASE_URL = "https://api.agentmail.to/v0";

export interface CreateAgentMailAdapterOptions {
  client?: Pick<HttpClient, "post">;
}

export function createAgentMailAdapter(opts: CreateAgentMailAdapterOptions = {}): NotifyAdapter {
  const http =
    opts.client ?? createHttpClient({ timeoutMs: 15_000, userAgent: "auggy-notify-agentmail/0.1" });

  function formatBody(payload: NotifyPayload): string {
    const lines = [payload.summary];
    if (payload.reason) lines.push("", `Reason: ${payload.reason}`);
    if (payload.visitor) lines.push(`Visitor: ${payload.visitor}`);
    return lines.join("\n");
  }

  return {
    async deliver(
      destination: NotifyDestination,
      payload: NotifyPayload,
    ): Promise<NotifyDeliveryResult> {
      if (destination.transport !== "agentmail") {
        return {
          status: "failed",
          detail: `agentMailAdapter received non-agentmail destination: ${destination.transport}`,
        };
      }
      const dest = destination as AgentMailNotifyDestination;
      const baseUrl = dest.apiBaseUrl ?? DEFAULT_BASE_URL;
      const url = `${baseUrl}/inboxes/${dest.inboxId}/messages`;
      const body = JSON.stringify({
        to: Array.isArray(dest.to) ? dest.to : [dest.to],
        subject: payload.summary,
        text: formatBody(payload),
        ...(dest.labels && dest.labels.length > 0 ? { labels: dest.labels } : {}),
      });
      try {
        const res = await http.post(url, {
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${dest.apiKey}`,
          },
          body,
        });
        if (res.status < 200 || res.status >= 300) {
          return {
            status: "failed",
            detail: `agentmail ${url} returned ${res.status}: ${res.body.slice(0, 200)}`,
          };
        }
        return { status: "sent" };
      } catch (err) {
        return {
          status: "failed",
          detail: `agentmail ${url} error: ${(err as Error).message}`,
        };
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/augments/notify/adapters/agentmail.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/augments/notify/adapters/agentmail.ts tests/augments/notify/adapters/agentmail.test.ts
git commit -m "feat(notify): agentmail adapter happy-path send"
```

---

## Task 3: Subject prefix and `to` array normalization

**Files:**
- Modify: `tests/augments/notify/adapters/agentmail.test.ts` (add 2 tests)
- Modify: `src/augments/notify/adapters/agentmail.ts` (subject prefix already needs wiring)

- [ ] **Step 1: Write the failing tests**

Append to `tests/augments/notify/adapters/agentmail.test.ts` inside the `describe`:

```ts
  it("applies subjectPrefix when configured", async () => {
    let captured: any = null;
    const adapter = createAgentMailAdapter({
      client: mockHttp((_url, body) => {
        captured = body;
        return { status: 200, body: JSON.stringify({ message_id: "m1", thread_id: "t1" }) };
      }),
    });
    await adapter.deliver(
      { ...dest, subjectPrefix: "[Auggy] " },
      { summary: "Daily digest" },
    );
    expect(captured.subject).toBe("[Auggy] Daily digest");
  });

  it("normalizes string `to` to single-element array; passes array through", async () => {
    let captured: any = null;
    const adapter = createAgentMailAdapter({
      client: mockHttp((_url, body) => {
        captured = body;
        return { status: 200, body: JSON.stringify({ message_id: "m1", thread_id: "t1" }) };
      }),
    });
    await adapter.deliver(dest, { summary: "x" });
    expect(captured.to).toEqual(["operator@example.com"]);

    await adapter.deliver(
      { ...dest, to: ["a@example.com", "b@example.com"] },
      { summary: "x" },
    );
    expect(captured.to).toEqual(["a@example.com", "b@example.com"]);
  });
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test tests/augments/notify/adapters/agentmail.test.ts`
Expected: FAIL on the `subjectPrefix` test — current impl ignores `subjectPrefix`. The `to`-normalization test should already PASS from Task 2's impl, but verify.

- [ ] **Step 3: Implement subjectPrefix in adapter**

In `src/augments/notify/adapters/agentmail.ts`, change the body construction to include subject prefix. Replace the `body = JSON.stringify({...})` block with:

```ts
      const subject = `${dest.subjectPrefix ?? ""}${payload.summary}`;
      const body = JSON.stringify({
        to: Array.isArray(dest.to) ? dest.to : [dest.to],
        subject,
        text: formatBody(payload),
        ...(dest.labels && dest.labels.length > 0 ? { labels: dest.labels } : {}),
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/augments/notify/adapters/agentmail.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/augments/notify/adapters/agentmail.ts tests/augments/notify/adapters/agentmail.test.ts
git commit -m "feat(notify): agentmail adapter subject prefix + to-array normalization"
```

---

## Task 4: HTTP error mapping

**Files:**
- Modify: `tests/augments/notify/adapters/agentmail.test.ts` (add 2 tests)

- [ ] **Step 1: Write the failing tests**

Append to `tests/augments/notify/adapters/agentmail.test.ts`:

```ts
  it("returns failed with status + body excerpt on 4xx", async () => {
    const adapter = createAgentMailAdapter({
      client: mockHttp(() => ({
        status: 401,
        body: JSON.stringify({ error: "invalid api key" }),
      })),
    });
    const result = await adapter.deliver(dest, { summary: "x" });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("401");
    expect(result.detail).toContain("invalid api key");
  });

  it("returns failed with status excerpt on 5xx", async () => {
    const adapter = createAgentMailAdapter({
      client: mockHttp(() => ({
        status: 503,
        body: "Service Unavailable",
      })),
    });
    const result = await adapter.deliver(dest, { summary: "x" });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("503");
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test tests/augments/notify/adapters/agentmail.test.ts`
Expected: PASS (5 tests). The Task 2 implementation already handles the non-2xx branch, so these tests pass on first run — that's the point of writing them now: lock the contract before subsequent refactors.

- [ ] **Step 3: Commit (lock-in)**

```bash
git add tests/augments/notify/adapters/agentmail.test.ts
git commit -m "test(notify): lock agentmail adapter http error contract"
```

---

## Task 5: Network exception handling

**Files:**
- Modify: `tests/augments/notify/adapters/agentmail.test.ts` (add 1 test)

- [ ] **Step 1: Write the failing test**

Append to `tests/augments/notify/adapters/agentmail.test.ts`:

```ts
  it("returns failed when the http client throws", async () => {
    const adapter = createAgentMailAdapter({
      client: {
        post: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
    });
    const result = await adapter.deliver(dest, { summary: "x" });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("ECONNREFUSED");
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test tests/augments/notify/adapters/agentmail.test.ts`
Expected: PASS (6 tests). Existing impl's `try/catch` already covers this — locking the contract.

- [ ] **Step 3: Commit**

```bash
git add tests/augments/notify/adapters/agentmail.test.ts
git commit -m "test(notify): lock agentmail adapter network-error contract"
```

---

## Task 6: Transport-mismatch validation

**Files:**
- Modify: `tests/augments/notify/adapters/agentmail.test.ts` (add 1 test)

- [ ] **Step 1: Write the failing test**

Append to `tests/augments/notify/adapters/agentmail.test.ts`:

```ts
  it("rejects non-agentmail destinations without calling http", async () => {
    let called = false;
    const adapter = createAgentMailAdapter({
      client: {
        post: async () => {
          called = true;
          throw new Error("should not be called");
        },
      },
    });
    const result = await adapter.deliver(
      { name: "wrong", transport: "webhook", url: "https://x" },
      { summary: "x" },
    );
    expect(called).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("non-agentmail destination");
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test tests/augments/notify/adapters/agentmail.test.ts`
Expected: PASS (7 tests). The Task 2 impl already returns the mismatch message early — locking the contract.

- [ ] **Step 3: Commit**

```bash
git add tests/augments/notify/adapters/agentmail.test.ts
git commit -m "test(notify): lock agentmail adapter transport-mismatch guard"
```

---

## Task 7: Wire adapter into `notify()` defaults

**Files:**
- Modify: `src/augments/notify.ts:26-34`

- [ ] **Step 1: Read current `notify()` adapter wiring**

Open `src/augments/notify.ts`. The current shape (lines ~26–34):

```ts
export interface NotifyAugmentInternalOptions extends NotifyAugmentOptions {
  adapters?: { webhook: NotifyAdapter; telegram: NotifyAdapter };
}

export function notify(opts: NotifyAugmentInternalOptions): Augment {
  const adapters = opts.adapters ?? {
    webhook: createWebhookAdapter(),
    telegram: createTelegramAdapter(),
  };
  // ...
}
```

- [ ] **Step 2: Widen the override to `Partial` and merge with defaults**

Replace the `NotifyAugmentInternalOptions` interface and the `adapters` initialization with:

```ts
import { createAgentMailAdapter } from "./notify/adapters/agentmail";

// ... existing imports ...

export interface NotifyAugmentInternalOptions extends NotifyAugmentOptions {
  /**
   * Test-only adapter override. Production code does not pass this.
   * Partial — missing keys fall back to default adapters.
   */
  adapters?: Partial<{
    webhook: NotifyAdapter;
    telegram: NotifyAdapter;
    agentmail: NotifyAdapter;
  }>;
}

export function notify(opts: NotifyAugmentInternalOptions): Augment {
  const defaults = {
    webhook: createWebhookAdapter(),
    telegram: createTelegramAdapter(),
    agentmail: createAgentMailAdapter(),
  };
  const adapters = { ...defaults, ...(opts.adapters ?? {}) };
  // ... rest unchanged ...
}
```

The dispatch site `adapters[destination.transport]` (around line 165) keeps working unchanged because `destination.transport` is now in `"webhook" | "telegram" | "agentmail"` and the merged object has all three keys.

- [ ] **Step 3: Run the existing notify test suite**

Run: `bun test tests/augments/notify.test.ts`
Expected: PASS — existing tests pass `adapters: { webhook, telegram }` which is now valid `Partial`. The default `agentmail` adapter is constructed but never invoked because no test uses an agentmail destination.

- [ ] **Step 4: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/augments/notify.ts
git commit -m "feat(notify): wire agentmail adapter into default adapters"
```

---

## Task 8: Integration test — `notify` tool dispatches to agentmail adapter

**Files:**
- Modify: `tests/augments/notify.test.ts`

- [ ] **Step 1: Read existing notify integration tests**

Open `tests/augments/notify.test.ts`. The helpers in scope are `makePeer(id, trustLevel?)` and `makeContext(peer)`. The existing pattern is:

```ts
const aug = notify({ ...baseOpts, adapters: { webhook: mockAdapter(...), telegram: mockAdapter() } });
const tool = aug.tools!.find((t) => t.name === "notify")!;
const ctx = makeContext(makePeer("v1"));
const result = JSON.parse(await tool.execute({ to: "creator", summary: "test" }, ctx));
```

Note: `tool.execute(...)` returns `Promise<string>` directly — no cast needed. `NotifyPayload` and `NotifyDestination` are already imported at the top of the file.

- [ ] **Step 2: Write the failing test**

Append a new `it()` to the existing `describe("notify augment", ...)` block. Use the existing `makeContext` + `makePeer` helpers; trust level `"creator"` so rate-limiting bypass kicks in (matches the agentmail use case where the operator's trusted self triggers the notification, not a public peer):

```ts
  it("dispatches to agentmail adapter for agentmail destinations", async () => {
    const captured: Array<{ destination: NotifyDestination; payload: NotifyPayload }> = [];
    const agentmailMock: NotifyAdapter = {
      deliver: async (destination, payload) => {
        captured.push({ destination, payload });
        return { status: "sent" };
      },
    };
    const aug = notify({
      destinations: [
        {
          name: "creator-mail",
          transport: "agentmail",
          apiKey: "am_x",
          inboxId: "inb_x",
          to: "creator@example.com",
        },
      ],
      adapters: { agentmail: agentmailMock },
    });
    const tool = aug.tools!.find((t) => t.name === "notify")!;
    const ctx = makeContext(makePeer("creator-1", "creator"));
    const result = JSON.parse(
      await tool.execute(
        { to: "creator-mail", summary: "Mail test", reason: "test reason" },
        ctx,
      ),
    );
    expect(result.status).toBe("sent");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.destination.transport).toBe("agentmail");
    expect(captured[0]!.destination.name).toBe("creator-mail");
    expect(captured[0]!.payload.summary).toBe("Mail test");
    expect(captured[0]!.payload.reason).toBe("test reason");
  });
```

The `adapters: { agentmail: agentmailMock }` override is a `Partial` — the `webhook` and `telegram` defaults from `notify()` are constructed but never invoked (no destinations of those types in this test). This relies on the Task 7 `Partial<...>` widening.

- [ ] **Step 3: Run test to verify it passes**

Run: `bun test tests/augments/notify.test.ts`
Expected: PASS — including all pre-existing tests (regression check).

- [ ] **Step 4: Commit**

```bash
git add tests/augments/notify.test.ts
git commit -m "test(notify): integration test for agentmail adapter dispatch"
```

---

## Task 9: Documentation

**Files:**
- Modify: `docs/13-notify.md`

- [ ] **Step 1: Read the existing webhook + telegram sections**

Open `docs/13-notify.md`. Find the section that documents adapters (search for "Webhook adapter" and "Telegram adapter" headers). The new AgentMail section should sit alongside, in the same shape.

- [ ] **Step 2: Add the AgentMail adapter section**

Insert a new section after the Telegram adapter section. Use this content verbatim:

````markdown
### AgentMail adapter

Sends outbound email via [AgentMail](https://docs.agentmail.to). Each destination carries the API key, source inbox, and recipient — multiple `agentmail` destinations may share an API key (the adapter caches the http client per key implicitly via the shared `createHttpClient`).

```yaml
augments:
  - name: notify
    type: notify
    options:
      destinations:
        - name: creator-mail
          transport: agentmail
          apiKey: ${AGENTMAIL_API_KEY}
          inboxId: ${AGENTMAIL_INBOX_ID}
          to: operator@example.com
          subjectPrefix: "[Zip] "
          labels: ["alert"]
```

Required env vars:

- `AGENTMAIL_API_KEY` — bearer token from AgentMail (prefix `am_`). Use a per-inbox key with the minimum permission set: `message_send`. Org-scoped keys are over-broad — see [security note](#agentmail-key-scoping).
- `AGENTMAIL_INBOX_ID` — the AgentMail inbox the message is sent **from**.

Optional fields on the destination:

- `to` — recipient email. String or array. The adapter normalizes both to an array on the wire.
- `subjectPrefix` — prepended to `payload.summary` to form the subject line.
- `labels` — applied to the sent message in AgentMail (visible in `messages.list`).
- `apiBaseUrl` — overrides the AgentMail API base URL (default `https://api.agentmail.to/v0`).

#### Delivery result mapping

| AgentMail response | `notify` result |
|---|---|
| 2xx with `{message_id, thread_id}` | `{status: "sent"}` |
| 4xx (auth, validation, invalid recipient) | `{status: "failed", detail: "agentmail ... returned 4xx: <body excerpt>"}` |
| 5xx (transient) | `{status: "failed", detail: "agentmail ... returned 5xx: <body excerpt>"}` — caller's responsibility to retry; the adapter does not retry. |
| Network exception | `{status: "failed", detail: "agentmail ... error: <message>"}` |
| 429 (rate-limited at AgentMail tier) | Surfaced as `failed` with the 429 body. The notify augment's own rate-limit machinery is the primary defense; AgentMail's quota is the second layer. |

#### AgentMail-specific gotchas {#agentmail-key-scoping}

- **Suppression list is permanent.** A bounced or complained address is suppressed by AgentMail with no documented removal API. Test with a real recipient before pinning a destination in production.
- **Key scoping.** The OTP-issued key from `agent.sign_up` is org-scoped (full access). Mint an inbox-scoped key with whitelist permissions (`message_send` only) and use that in `.env`. The org-scoped key should be rotated or kept for console use only.
- **No idempotency on send.** AgentMail's `messages.send` does not accept an idempotency key as of this writing. Duplicate sends are possible if a network blip lands during the request. For high-stakes messages, rely on the notify augment's existing dedup window (`rateLimit.dedupThreshold`).
- **Free tier hard cap.** 100 emails/day. The runtime's `dailyBudgetUsd` does not model AgentMail tier limits — the operator should be aware that AgentMail can refuse delivery independently of runtime budgets.
- **Tier-side WebSocket and webhook inbound** are **not** part of this adapter. This is outbound-only. For bidirectional email (visitors emailing the agent), see the planned `emailTransport` augment.
````

- [ ] **Step 3: Commit**

```bash
git add docs/13-notify.md
git commit -m "docs(notify): document agentmail adapter"
```

---

## Task 10: Per-destination rate limits in `notify`

**Files:**
- Modify: `src/types.ts` — add optional `rateLimit?: { maxPerHour?: number; cooldownMs?: number }` to each destination interface (`WebhookNotifyDestination`, `TelegramNotifyDestination`, `AgentMailNotifyDestination`).
- Modify: `src/augments/notify.ts` — extend the rate-limit machinery to track per-destination counters in addition to the existing global hourly cap.
- Modify: `tests/augments/notify.test.ts` — 3 new tests.

The existing `notify` augment has a single global hourly cap (default 5) shared across all destinations. PR γ.2 (visitorAuth) needs to send up to ~50 verification mails per hour without starving operator alerts. Per-destination caps fix this without breaking existing behavior — destinations without an explicit `rateLimit` use the global cap as today.

- [ ] **Step 1: Write failing tests**

Append to `tests/augments/notify.test.ts`:

```ts
  test("per-destination cap allows verify-out 50/hr while creator stays at global default", async () => {
    const aug = notify({
      destinations: [
        { name: "creator", transport: "webhook", url: "https://example.com/c" },
        {
          name: "verify-out",
          transport: "webhook",
          url: "https://example.com/v",
          rateLimit: { maxPerHour: 50 },
        },
      ],
      rateLimit: { globalMaxPerHour: 5, dedupThreshold: 0 },
      adapters: { webhook: mockAdapter(), telegram: mockAdapter() },
    });
    const tool = aug.tools!.find((t) => t.name === "notify")!;
    const ctx = makeContext(makePeer("v1"));
    // Fire 10 to verify-out — all should succeed (under 50)
    for (let i = 0; i < 10; i++) {
      const r = JSON.parse(await tool.execute({ to: "verify-out", summary: `msg ${i}` }, ctx));
      expect(r.status).toBe("sent");
    }
    // Fire 6 to creator — 6th should be rate-limited (over 5)
    for (let i = 0; i < 5; i++) {
      const r = JSON.parse(await tool.execute({ to: "creator", summary: `alert ${i}` }, ctx));
      expect(r.status).toBe("sent");
    }
    const sixth = JSON.parse(await tool.execute({ to: "creator", summary: "alert 6" }, ctx));
    expect(sixth.status).toBe("rate_limited");
  });

  test("per-destination cap surface in rate_limited message names the destination", async () => {
    const aug = notify({
      destinations: [
        { name: "verify-out", transport: "webhook", url: "https://x", rateLimit: { maxPerHour: 1 } },
      ],
      rateLimit: { dedupThreshold: 0 },
      adapters: { webhook: mockAdapter(), telegram: mockAdapter() },
    });
    const tool = aug.tools!.find((t) => t.name === "notify")!;
    const ctx = makeContext(makePeer("v1"));
    await tool.execute({ to: "verify-out", summary: "1" }, ctx);
    const r = JSON.parse(await tool.execute({ to: "verify-out", summary: "2" }, ctx));
    expect(r.status).toBe("rate_limited");
    expect(r.message).toContain("verify-out");
  });

  test("destination without explicit rateLimit falls back to global cap", async () => {
    const aug = notify({
      destinations: [{ name: "creator", transport: "webhook", url: "https://x" }],
      rateLimit: { globalMaxPerHour: 2, dedupThreshold: 0 },
      adapters: { webhook: mockAdapter(), telegram: mockAdapter() },
    });
    const tool = aug.tools!.find((t) => t.name === "notify")!;
    const ctx = makeContext(makePeer("v1"));
    await tool.execute({ to: "creator", summary: "1" }, ctx);
    await tool.execute({ to: "creator", summary: "2" }, ctx);
    const third = JSON.parse(await tool.execute({ to: "creator", summary: "3" }, ctx));
    expect(third.status).toBe("rate_limited");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/augments/notify.test.ts`
Expected: FAIL — no per-destination rate-limit tracking yet.

- [ ] **Step 3: Add `rateLimit` field to destination types**

In `src/types.ts`, add to each of `WebhookNotifyDestination`, `TelegramNotifyDestination`, `AgentMailNotifyDestination`:

```ts
  /** Optional per-destination rate limit. Falls back to the augment-level global cap when absent. */
  rateLimit?: {
    maxPerHour?: number;
    cooldownMs?: number;
  };
```

- [ ] **Step 4: Extend `notify()` rate-limit machinery**

In `src/augments/notify.ts`:

1. Add a `Map<string, number[]>` keyed by destination name, holding timestamps in the last hour.
2. Add a `Map<string, number>` keyed by destination name for last-send timestamps (per-destination cooldown).
3. Replace the existing single `globalCountThisHour` check with: if the destination has `rateLimit.maxPerHour`, check that destination's window; else fall back to the global counter.
4. Same pattern for `cooldownMs`.
5. On a successful send, increment BOTH the global counter (kept for back-compat) AND the per-destination counter.

The existing global cap stays as the default fallback so existing operator configs without per-destination caps continue to behave identically.

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test tests/augments/notify.test.ts`
Expected: PASS — including all pre-existing tests.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/augments/notify.ts tests/augments/notify.test.ts
git commit -m "feat(notify): per-destination rate limits"
```

---

## Task 11: Extract `src/agentmail-client.ts` shared module

**Files:**
- Create: `src/agentmail-client.ts`
- Modify: `src/augments/notify/adapters/agentmail.ts` to delegate
- Create: `tests/agentmail-client.test.ts`

Why this exists separately from Task 2's adapter: a future `agentMail` augment (post-v1.0, not in this plan) will share the same AgentMail HTTP send code. Extracting now into the same shape as `src/telegram-client.ts` (shared by both the telegram notify adapter and the telegramTransport augment) prevents the second-implementer from duplicating ~30 LOC and keeps env-var handling in one place.

- [ ] **Step 1: Move the HTTP send logic from the adapter into the shared module**

Create `src/agentmail-client.ts`:

```ts
/**
 * AgentMail HTTP client — stateless infrastructure shared by the notify
 * agentmail adapter and (future) the agentMail augment.
 *
 * Pattern matches src/telegram-client.ts: env-var or constructor-arg keyed,
 * no SQLite state, no augment-system coupling.
 */

import { createHttpClient } from "./http";
import type { HttpClient } from "./http";

const DEFAULT_BASE_URL = "https://api.agentmail.to/v0";

export interface AgentMailClientOptions {
  apiKey: string;
  /** Override AgentMail API base URL (testing/sandbox). */
  apiBaseUrl?: string;
  /** Timeout per request. Default 15s. */
  timeoutMs?: number;
  /** Test-only HTTP client override. */
  http?: Pick<HttpClient, "post">;
}

export interface SendMessageInput {
  inboxId: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  labels?: string[];
}

export interface SendMessageResult {
  status: "sent";
  messageId: string;
  threadId: string;
}

export interface SendMessageError {
  status: "failed";
  detail: string;
  /** HTTP status if the failure originated from AgentMail (vs. network). */
  httpStatus?: number;
  /** AgentMail-returned Retry-After if 429. */
  retryAfterSec?: number;
}

export interface AgentMailClient {
  send(input: SendMessageInput): Promise<SendMessageResult | SendMessageError>;
}

export function createAgentMailClient(opts: AgentMailClientOptions): AgentMailClient {
  const baseUrl = opts.apiBaseUrl ?? DEFAULT_BASE_URL;
  const http =
    opts.http ??
    createHttpClient({
      timeoutMs: opts.timeoutMs ?? 15_000,
      userAgent: "auggy-agentmail-client/0.1",
    });
  return {
    async send(input) {
      const url = `${baseUrl}/inboxes/${input.inboxId}/messages`;
      const body = JSON.stringify({
        to: input.to,
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
      });
      try {
        const res = await http.post(url, {
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${opts.apiKey}`,
          },
          body,
        });
        if (res.status < 200 || res.status >= 300) {
          const result: SendMessageError = {
            status: "failed",
            detail: `agentmail returned ${res.status}: ${res.body.slice(0, 200)}`,
            httpStatus: res.status,
          };
          if (res.status === 429) {
            const retry = res.headers.get("retry-after");
            if (retry) result.retryAfterSec = Number(retry) || undefined;
          }
          return result;
        }
        const parsed = JSON.parse(res.body) as { message_id: string; thread_id: string };
        return { status: "sent", messageId: parsed.message_id, threadId: parsed.thread_id };
      } catch (err) {
        return { status: "failed", detail: `agentmail error: ${(err as Error).message}` };
      }
    },
  };
}
```

- [ ] **Step 2: Refactor the adapter to delegate**

In `src/augments/notify/adapters/agentmail.ts`, replace the inline HTTP send with a call into `createAgentMailClient`:

```ts
import { createAgentMailClient } from "../../../agentmail-client";
import type { AgentMailClient } from "../../../agentmail-client";
import type {
  NotifyAdapter,
  NotifyDestination,
  NotifyPayload,
  NotifyDeliveryResult,
  AgentMailNotifyDestination,
} from "../../../types";

export interface CreateAgentMailAdapterOptions {
  /** Test-only client override; production constructs from destination's apiKey. */
  clientFactory?: (apiKey: string, baseUrl?: string) => AgentMailClient;
}

export function createAgentMailAdapter(opts: CreateAgentMailAdapterOptions = {}): NotifyAdapter {
  const factory =
    opts.clientFactory ?? ((apiKey, baseUrl) => createAgentMailClient({ apiKey, apiBaseUrl: baseUrl }));
  const cache = new Map<string, AgentMailClient>();

  function getClient(apiKey: string, baseUrl?: string): AgentMailClient {
    const cacheKey = `${apiKey}:${baseUrl ?? ""}`;
    let client = cache.get(cacheKey);
    if (!client) {
      client = factory(apiKey, baseUrl);
      cache.set(cacheKey, client);
    }
    return client;
  }

  function formatBody(payload: NotifyPayload): string {
    const lines = [payload.summary];
    if (payload.reason) lines.push("", `Reason: ${payload.reason}`);
    if (payload.visitor) lines.push(`Visitor: ${payload.visitor}`);
    return lines.join("\n");
  }

  return {
    async deliver(
      destination: NotifyDestination,
      payload: NotifyPayload,
    ): Promise<NotifyDeliveryResult> {
      if (destination.transport !== "agentmail") {
        return {
          status: "failed",
          detail: `agentMailAdapter received non-agentmail destination: ${destination.transport}`,
        };
      }
      const dest = destination as AgentMailNotifyDestination;
      const client = getClient(dest.apiKey, dest.apiBaseUrl);
      const subject = `${dest.subjectPrefix ?? ""}${payload.summary}`;
      const result = await client.send({
        inboxId: dest.inboxId,
        to: Array.isArray(dest.to) ? dest.to : [dest.to],
        subject,
        text: formatBody(payload),
        labels: dest.labels,
      });
      if (result.status === "sent") {
        return { status: "sent" };
      }
      return { status: "failed", detail: result.detail };
    },
  };
}
```

The adapter is now ~50 LOC (was ~80). Test mock pattern shifts from mocking the http client to mocking the AgentMail client; existing tests in `tests/augments/notify/adapters/agentmail.test.ts` need their `mockHttp` replaced with a `mockClient` factory.

- [ ] **Step 3: Update existing adapter tests to use the client mock**

Mechanically: replace each `mockHttp(...)` in `tests/augments/notify/adapters/agentmail.test.ts` with a `mockClient` that returns `{status: "sent", messageId: "...", threadId: "..."}` or the relevant error shape. Test assertions on the SDK call shape (URL, headers, body fields) move into the new `tests/agentmail-client.test.ts`. The adapter tests verify only the destination → client wiring.

- [ ] **Step 4: Write tests for the shared client**

Create `tests/agentmail-client.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { createAgentMailClient } from "../src/agentmail-client";
import type { HttpResponse, HttpRequestInit } from "../src/http";

function mockHttp(handler: (url: string, body: unknown, headers?: Record<string, string>) => { status: number; body: string; headers?: Record<string, string> }) {
  return {
    post: async (url: string, opts?: Omit<HttpRequestInit, "method">): Promise<HttpResponse> => {
      const body = typeof opts?.body === "string" ? JSON.parse(opts.body) : undefined;
      const result = handler(url, body, opts?.headers);
      const respHeaders = new Headers({ "content-type": "application/json", ...(result.headers ?? {}) });
      return {
        finalUrl: url,
        status: result.status,
        statusText: result.status >= 200 && result.status < 300 ? "OK" : "Error",
        contentType: "application/json",
        headers: respHeaders,
        body: result.body,
      };
    },
  };
}

describe("createAgentMailClient", () => {
  test("posts to /inboxes/{id}/messages with bearer auth", async () => {
    let captured: any = null;
    let capturedAuth = "";
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: mockHttp((url, body, headers) => {
        captured = { url, body };
        capturedAuth = headers?.["authorization"] ?? "";
        return { status: 200, body: JSON.stringify({ message_id: "msg_1", thread_id: "thd_1" }) };
      }),
    });
    const r = await client.send({ inboxId: "inb_x", to: ["a@b.com"], subject: "s", text: "t" });
    expect(captured.url).toBe("https://api.agentmail.to/v0/inboxes/inb_x/messages");
    expect(capturedAuth).toBe("Bearer am_test");
    expect(captured.body.subject).toBe("s");
    expect(r.status).toBe("sent");
    if (r.status === "sent") {
      expect(r.messageId).toBe("msg_1");
      expect(r.threadId).toBe("thd_1");
    }
  });

  test("surfaces 429 with retry-after seconds", async () => {
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: mockHttp(() => ({
        status: 429,
        body: JSON.stringify({ error: "rate limited" }),
        headers: { "retry-after": "60" },
      })),
    });
    const r = await client.send({ inboxId: "inb_x", to: ["a@b.com"], subject: "s", text: "t" });
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.httpStatus).toBe(429);
      expect(r.retryAfterSec).toBe(60);
    }
  });

  test("returns failed on network throw", async () => {
    const client = createAgentMailClient({
      apiKey: "am_test",
      http: { post: async () => { throw new Error("ECONNREFUSED"); } },
    });
    const r = await client.send({ inboxId: "inb_x", to: ["a@b.com"], subject: "s", text: "t" });
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.detail).toContain("ECONNREFUSED");
  });
});
```

- [ ] **Step 5: Run all tests + typecheck**

Run: `bun test tests/agentmail-client.test.ts tests/augments/notify/adapters/agentmail.test.ts tests/augments/notify.test.ts`
Expected: PASS.

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agentmail-client.ts src/augments/notify/adapters/agentmail.ts tests/agentmail-client.test.ts tests/augments/notify/adapters/agentmail.test.ts
git commit -m "refactor(notify): extract AgentMail HTTP send into shared agentmail-client module"
```

---

## Task 12: Final verification

**Files:** none modified — verification only.

- [ ] **Step 1: Full typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: PASS. Test count delta: 7 adapter unit (Task 2-6) + 1 notify integration (Task 8) + 3 per-destination rate-limit (Task 10) + 3 shared-client (Task 11) = **+14 new tests**. Task 11 also restructures some Task 2-6 tests to use the new `mockClient` shape rather than `mockHttp`; net count unchanged from that refactor. The current baseline at `docs/ROADMAP.md:181` is "1091 augment-1 tests + 82 chat tests" — expect `1105 augment-1 tests` after this plan ships.

- [ ] **Step 3: Confirm git status is clean**

Run: `git status`
Expected: `nothing to commit, working tree clean`. All commits from prior tasks already landed.

- [ ] **Step 4: Final commit only if any verification edits were needed**

If any small fixes were required during verification (e.g. lint), commit them:

```bash
git add -p
git commit -m "chore(notify): finalize agentmail adapter (typecheck + test suite green)"
```

If no verification edits were needed, no commit required.

---

## Acceptance criteria

- [ ] `bun test` passes with 14 new tests across `tests/augments/notify/adapters/agentmail.test.ts` (7), `tests/augments/notify.test.ts` (1 + 3 per-destination), and `tests/agentmail-client.test.ts` (3).
- [ ] `bunx tsc --noEmit` passes clean.
- [ ] `src/augments/notify/adapters/agentmail.ts` exists, ~80 LOC, no SDK dependency (uses `src/http.ts`).
- [ ] `NotifyAdapterKind` includes `"agentmail"`; `AgentMailNotifyDestination` exists in `src/types.ts`; `NotifyDestination` union includes it.
- [ ] `notify()` constructs an `agentmail` adapter by default; tests overriding only `webhook` + `telegram` continue to compile and pass via the `Partial` widening.
- [ ] `docs/13-notify.md` documents the adapter, lists required env vars, names the four AgentMail-specific gotchas (suppression, key scoping, idempotency, tier cap).
- [ ] All commits follow the existing `feat(notify):` / `test(notify):` / `docs(notify):` convention.

---

## Consumer-integration note: PR γ DOES route through this adapter

**Reversed 2026-05-06 after Codex adversarial review.** Earlier draft of this plan said `visitorAuth` should send directly to AgentMail (bypassing `notify`) to avoid rate-limit collision with operator alerts. Codex flagged this as a violation of the outbound taxonomy defined in [`2026-04-28-notify-augment-and-outbound-taxonomy-design.md`](../../../../docs/superpowers/specs/2026-04-28-notify-augment-and-outbound-taxonomy-design.md): `notify` is the runtime's primitive for "operator-defined destinations," and creating a parallel direct-send API for visitorAuth would give the model two outbound APIs for one job.

Final shape: visitorAuth (PR γ.2 — see [`lo/docs/superpowers/specs/2026-05-06-pr-gamma-visitor-auth-magic-link-design.md`](../../../../docs/superpowers/specs/2026-05-06-pr-gamma-visitor-auth-magic-link-design.md)) calls `notify({to: "verify-out"})`. The operator wires a `verify-out` destination with `transport: agentmail` in `agent.yaml`. This adapter handles the actual send.

**Two consequences for this plan:**

1. **Extract the AgentMail HTTP send into a shared infrastructure module** `src/agentmail-client.ts` (stateless, env-var keyed, pattern matches existing `src/telegram-client.ts`). Both this adapter AND a future `agentMail` augment (post-v1.0) consume the shared module. Task 2 below now creates that module first; the adapter delegates to it.

2. **Add per-destination rate limits to `notify`.** The original rate-limit-collision concern (verification storm starves operator pages) is solved by giving each destination its own rate-limit budget. `verify-out` gets 50/hour; `creator-mail` keeps its 5/hour default. New Task 11 below.

## What this plan deliberately does NOT do

- **No `aug1 add` scaffold integration.** The catalog default for `notify` stays webhook (`src/cli/augment-catalog.ts:372`). Operators who want AgentMail edit the YAML manually — the docs section in Task 9 is sufficient. Adding a separate "notify-agentmail" catalog entry is future polish and would clutter the picker.
- **No `agent.sign_up` interactive flow.** The OTP-issued credential flow belongs in the `aug1 add agentMailTransport` plan (separate document), where it pairs with the bidirectional inbound work. For the outbound adapter, operators paste an existing key.
- **No webhook signing infrastructure.** This adapter is outbound only — no inbound webhook endpoint, no Svix verification, no `whsec_*` plumbing.
- **No magic-link generation.** That's the `visitorAuth` augment's job (PR γ on `docs/ROADMAP.md:56`). This adapter is the delivery mechanism `visitorAuth` will call into.
- **No retry, no queue.** The notify augment's existing rate-limit + dedup is the only protection. Failed deliveries surface as `failed` and are the agent's (or operator's) problem.
- **No AgentMail webhook inbound mode.** Deferred to v1.5 — paid Railway services don't sleep, so the bigger transport plan ships WebSocket-first inbound.
