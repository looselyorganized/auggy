# Notify Augment + Telegram Transport Implementation Plan

> **✅ SHIPPED 2026-05-07** (notify + telegramTransport augments). This plan is historical reference; not actionable.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `notify` augment (outbound messaging primitive with internal webhook + telegram adapters), the `telegramTransport` augment (full bidirectional Telegram I/O — polling AND webhook modes, all four trust paths), strip `org_escalate` from `orgContext`, and migrate Zip — all underpinned by a single shared `src/telegram-client.ts` utility used by both augments without cross-augment coupling.

**Architecture:** Three-phase landing. **Phase A (T1–T8)** ships notify + the orgContext strip + Zip's outbound-path migration via the webhook adapter. Phase A is independently shippable; LORF/Zip continue working with `agent-context-api/notify` as the delegated webhook target. **Phase B (T9–T16)** ships telegramTransport with both polling and webhook modes. **Phase C (T17–T23)** ships CLI wiring, optional Zip Telegram-inbound enable, operator docs, and ROADMAP update.

**Tech Stack:** TypeScript, Bun, `bun:test`, `bun:sqlite` (no new deps), Zod, `node:crypto.timingSafeEqual`. Builds on item 5's four-path identity model (`creator | agent | public-recognized | public-anonymous`) and the existing `webTransport` reference implementation.

**Spec:** `docs/superpowers/specs/2026-04-28-notify-augment-and-outbound-taxonomy-design.md`
**ROADMAP item:** 6

---

## File Structure

**Phase A — notify + orgContext strip + Zip migration**

Creates:
- `augment-1/src/telegram-client.ts` — shared bot API client (used by both notify's telegram adapter and telegramTransport in Phase B)
- `augment-1/src/augments/notify.ts` — augment factory, destination registry, rate-limit state
- `augment-1/src/augments/notify/adapters/webhook.ts` — webhook adapter
- `augment-1/src/augments/notify/adapters/telegram.ts` — telegram adapter (uses src/telegram-client.ts)
- `augment-1/tests/telegram-client.test.ts`
- `augment-1/tests/augments/notify.test.ts`
- `augment-1/tests/augments/notify/adapters/webhook.test.ts`
- `augment-1/tests/augments/notify/adapters/telegram.test.ts`
- `augment-1/tests/integration/notify.test.ts`

Modifies:
- `augment-1/src/augments/org-context.ts` — strip `org_escalate` tool, `EscalationLimits` type, cooldown/dedup/global-counter state, `wordOverlap` helper, `recordEscalation` helper, `checkCooldown`/`checkGlobalLimit`/`checkDedup` helpers, escalation rate-limit constructor block. Keep `org_fetch`, manifest fetch, cache, context-block injection.
- `augment-1/src/types.ts` — add `NotifyAugmentOptions`, `NotifyDestination`, `NotifyAdapter` types
- `augment-1/src/cli/config-parser.ts` — add `notify` to `BUILTIN_TYPES`, add `validateNotifyOptions`
- `augment-1/src/cli/augment-resolver.ts` — wire `notify` augment factory
- `augment-1/src/cli/augment-catalog.ts` — add `notify` catalog entry with default scaffold + `NOTIFY_SKILL` template
- `augment-1/zip/agent.yaml` — add notify mount, remove orgContext escalation usage
- `augment-1/zip/skills/identity/SKILL.md` (or wherever Zip's identity skill lives) — replace `org_escalate` references with `notify`

Deletes:
- `augment-1/tests/augments/org-context.test.ts` — entire file is escalation tests; there are no `org_fetch`/manifest tests to preserve. (Confirmed by `grep -rnE "org_fetch|fetchManifest" augment-1/tests` returning no results.) New `notify` test coverage replaces what's lost.

**Phase B — telegramTransport (polling + webhook + four identity paths)**

Creates:
- `augment-1/src/augments/telegram-transport.ts` — augment factory, identity resolution, lifecycle
- `augment-1/src/augments/telegram-transport/polling.ts` — long-poll loop
- `augment-1/src/augments/telegram-transport/webhook.ts` — Bun.serve() HTTP server
- `augment-1/tests/augments/telegram-transport.test.ts` — identity resolution, lifecycle, admittedAgents validation
- `augment-1/tests/augments/telegram-transport/polling.test.ts`
- `augment-1/tests/augments/telegram-transport/webhook.test.ts`
- `augment-1/tests/integration/telegram-transport.test.ts` — full agent boot + multi-transport composition

Modifies:
- `augment-1/src/types.ts` — add `TelegramTransportOptions` and supporting types
- `augment-1/src/cli/config-parser.ts` — add `telegramTransport` to `BUILTIN_TYPES`, add `validateTelegramTransportOptions` (mode-mutual-exclusion enforcement)
- `augment-1/src/cli/augment-resolver.ts` — wire `telegramTransport` augment factory
- `augment-1/src/cli/augment-catalog.ts` — add `telegramTransport` catalog entry with default scaffold

**Phase C — Zip telegram-inbound enable, operator docs, roadmap**

Modifies:
- `augment-1/zip/agent.yaml` — optional `telegramTransport` mount (commented out unless operator opts in)
- `augment-1/docs/06-transports.md` — extend with multi-transport composition guidance
- `augment-1/docs/07-built-in-augments.md` — revise for new augments
- `lo/docs/ROADMAP.md` — retitle item 6, add follow-on items

Creates:
- `augment-1/docs/13-notify.md` — operator reference (mirrors `12-budgets.md` style)
- `augment-1/docs/14-telegram-transport.md` — operator reference

---

# Phase A — Notify Augment + OrgContext Strip + Zip Migration

Ships independently. After Phase A merges, LORF/Zip continue working unchanged at the user level — `notify({to: "creator", ...})` replaces `org_escalate({...})` and routes via `webhookOut` adapter to `agent-context-api/notify` (which still holds the Telegram bot token). `telegramTransport` is not yet built.

---

## Task T1: Shared Telegram bot API client

**Files:**
- Create: `augment-1/src/telegram-client.ts`
- Create: `augment-1/tests/telegram-client.test.ts`

- [ ] **Step 1: Write the failing test for the client surface**

In `augment-1/tests/telegram-client.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { createTelegramBotClient } from "../src/telegram-client";

function mockHttp(handler: (method: string, url: string, body?: unknown) => { status: number; body: string }) {
  return {
    get: async (url: string) => handler("GET", url),
    post: async (url: string, opts?: { body?: string }) => handler("POST", url, opts?.body ? JSON.parse(opts.body) : undefined),
  };
}

describe("createTelegramBotClient", () => {
  it("posts sendMessage with chat_id and text", async () => {
    let captured: { url?: string; body?: any } = {};
    const client = createTelegramBotClient({
      botToken: "TESTTOKEN",
      client: mockHttp((method, url, body) => {
        captured = { url, body };
        return { status: 200, body: JSON.stringify({ ok: true, result: { message_id: 99, chat: { id: 42 } } }) };
      }) as any,
    });
    const result = await client.sendMessage(42, "hello");
    expect(captured.url).toBe("https://api.telegram.org/botTESTTOKEN/sendMessage");
    expect(captured.body).toEqual({ chat_id: 42, text: "hello" });
    expect(result.messageId).toBe(99);
    expect(result.chatId).toBe(42);
  });

  it("getUpdates posts offset and timeout", async () => {
    let captured: any = {};
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp((m, u, b) => {
        captured = { url: u, body: b };
        return { status: 200, body: JSON.stringify({ ok: true, result: [] }) };
      }) as any,
    });
    await client.getUpdates({ offset: 100, timeoutSec: 30 });
    expect(captured.url).toBe("https://api.telegram.org/botT/getUpdates");
    expect(captured.body).toEqual({ offset: 100, timeout: 30 });
  });

  it("setWebhook posts url and secret_token", async () => {
    let captured: any = {};
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp((m, u, b) => {
        captured = { url: u, body: b };
        return { status: 200, body: JSON.stringify({ ok: true, result: true }) };
      }) as any,
    });
    await client.setWebhook("https://example.com/hook", "SECRET");
    expect(captured.url).toBe("https://api.telegram.org/botT/setWebhook");
    expect(captured.body).toEqual({ url: "https://example.com/hook", secret_token: "SECRET" });
  });

  it("deleteWebhook posts to deleteWebhook endpoint", async () => {
    let url = "";
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp((m, u) => { url = u; return { status: 200, body: JSON.stringify({ ok: true, result: true }) }; }) as any,
    });
    await client.deleteWebhook();
    expect(url).toBe("https://api.telegram.org/botT/deleteWebhook");
  });

  it("getChat returns chat info on success", async () => {
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp(() => ({ status: 200, body: JSON.stringify({ ok: true, result: { id: 555, type: "private", first_name: "Op" } }) })) as any,
    });
    const chat = await client.getChat(555);
    expect(chat.id).toBe(555);
    expect(chat.type).toBe("private");
  });

  it("sendMessage 4xx surfaces structured error", async () => {
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp(() => ({ status: 400, body: JSON.stringify({ ok: false, description: "chat not found" }) })) as any,
    });
    await expect(client.sendMessage(0, "x")).rejects.toThrow(/chat not found/);
  });

  it("getChat throws on bot-API error", async () => {
    const client = createTelegramBotClient({
      botToken: "T",
      client: mockHttp(() => ({ status: 400, body: JSON.stringify({ ok: false, description: "user not found" }) })) as any,
    });
    await expect(client.getChat(999)).rejects.toThrow(/user not found/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd augment-1 && bun test tests/telegram-client.test.ts
```
Expected: FAIL — `createTelegramBotClient` not found.

- [ ] **Step 3: Implement the client**

Create `augment-1/src/telegram-client.ts`:

```typescript
/**
 * Shared Telegram bot API client.
 *
 * Used by both `notify`'s telegram adapter and `telegramTransport`. NOT a
 * cross-augment dependency — peer library import only. Mirrors the shared-
 * utility pattern of `src/http.ts` and `src/engines/_shared/cost.ts`.
 *
 * Future bot-API surface (file uploads, editMessageText for streaming-edit
 * replies, reactions, inline keyboards) MUST land here, not be duplicated
 * across notify and telegramTransport.
 */

import type { HttpClient } from "./http";
import { createHttpClient } from "./http";

export interface SendMessageOptions {
  parseMode?: "Markdown" | "HTML" | "MarkdownV2";
  replyToMessageId?: number;
  disableNotification?: boolean;
}

export interface SendMessageResult {
  messageId: number;
  chatId: number | string;
}

export interface GetUpdatesOptions {
  offset?: number;
  timeoutSec?: number;
  allowedUpdates?: string[];
}

export interface SetWebhookOptions {
  allowedUpdates?: string[];
  dropPendingUpdates?: boolean;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; is_bot: boolean; first_name?: string; username?: string };
  chat: { id: number; type: string };
  date: number;
  text?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  first_name?: string;
  username?: string;
}

export interface TelegramBotClient {
  sendMessage(chatId: number | string, text: string, opts?: SendMessageOptions): Promise<SendMessageResult>;
  getUpdates(opts: GetUpdatesOptions): Promise<TelegramUpdate[]>;
  setWebhook(url: string, secretToken: string, opts?: SetWebhookOptions): Promise<void>;
  deleteWebhook(): Promise<void>;
  getChat(chatId: number | string): Promise<TelegramChat>;
}

export interface CreateTelegramBotClientOptions {
  botToken: string;
  client?: HttpClient;
  baseUrl?: string;
}

interface BotApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export function createTelegramBotClient(opts: CreateTelegramBotClientOptions): TelegramBotClient {
  const baseUrl = opts.baseUrl ?? "https://api.telegram.org";
  const url = (method: string) => `${baseUrl}/bot${opts.botToken}/${method}`;
  const http = opts.client ?? createHttpClient({ timeoutMs: 60_000, userAgent: "auggy-telegram/0.1" });

  async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await http.post(url(method), {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let parsed: BotApiResponse<T>;
    try {
      parsed = JSON.parse(res.body) as BotApiResponse<T>;
    } catch {
      throw new Error(`Telegram bot API ${method}: non-JSON response (${res.status})`);
    }
    if (!parsed.ok) {
      throw new Error(`Telegram bot API ${method}: ${parsed.description ?? "unknown error"} (${res.status})`);
    }
    return parsed.result as T;
  }

  return {
    async sendMessage(chatId, text, sendOpts) {
      const body: Record<string, unknown> = { chat_id: chatId, text };
      if (sendOpts?.parseMode) body.parse_mode = sendOpts.parseMode;
      if (sendOpts?.replyToMessageId != null) body.reply_to_message_id = sendOpts.replyToMessageId;
      if (sendOpts?.disableNotification) body.disable_notification = true;
      const result = await call<{ message_id: number; chat: { id: number | string } }>("sendMessage", body);
      return { messageId: result.message_id, chatId: result.chat.id };
    },

    async getUpdates(getOpts) {
      const body: Record<string, unknown> = {};
      if (getOpts.offset != null) body.offset = getOpts.offset;
      if (getOpts.timeoutSec != null) body.timeout = getOpts.timeoutSec;
      if (getOpts.allowedUpdates) body.allowed_updates = getOpts.allowedUpdates;
      return await call<TelegramUpdate[]>("getUpdates", body);
    },

    async setWebhook(webhookUrl, secretToken, webhookOpts) {
      const body: Record<string, unknown> = { url: webhookUrl, secret_token: secretToken };
      if (webhookOpts?.allowedUpdates) body.allowed_updates = webhookOpts.allowedUpdates;
      if (webhookOpts?.dropPendingUpdates) body.drop_pending_updates = true;
      await call<true>("setWebhook", body);
    },

    async deleteWebhook() {
      await call<true>("deleteWebhook", {});
    },

    async getChat(chatId) {
      return await call<TelegramChat>("getChat", { chat_id: chatId });
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd augment-1 && bun test tests/telegram-client.test.ts
```
Expected: 7/7 passing.

- [ ] **Step 5: Run typecheck**

```bash
cd augment-1 && bunx tsc --noEmit
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/telegram-client.ts tests/telegram-client.test.ts
git commit -m "feat(telegram-client): shared Telegram bot API client utility

Single source of truth for sendMessage, getUpdates, setWebhook,
deleteWebhook, getChat. Used by notify's telegram adapter (T4) and
telegramTransport (Phase B) without cross-augment coupling.

Mirrors src/http.ts and src/engines/_shared/cost.ts shared-utility
pattern. Future bot-API surface lands here."
```

---

## Task T2: Notify augment types

**Files:**
- Modify: `augment-1/src/types.ts`

- [ ] **Step 1: Add notify types alongside existing augment types**

Append to `augment-1/src/types.ts`:

```typescript
// ---------------------------------------------------------------------------
// Notify augment
// ---------------------------------------------------------------------------

export type NotifyAdapterKind = "webhook" | "telegram";

export interface WebhookNotifyDestination {
  name: string;
  transport: "webhook";
  url: string;
  headers?: Record<string, string>;
}

export interface TelegramNotifyDestination {
  name: string;
  transport: "telegram";
  botToken: string;
  chatId: number | string;
  parseMode?: "Markdown" | "HTML" | "MarkdownV2";
}

export type NotifyDestination = WebhookNotifyDestination | TelegramNotifyDestination;

export interface NotifyRateLimitOptions {
  enabled?: boolean;
  cooldownMs?: number;
  globalMaxPerHour?: number;
  dedupWindowMs?: number;
  dedupThreshold?: number;
  perPeerCooldownMs?: number;
}

export interface NotifyAugmentOptions {
  destinations: NotifyDestination[];
  rateLimit?: NotifyRateLimitOptions;
}

export interface NotifyPayload {
  summary: string;
  reason?: string;
  visitor?: string;
}

export interface NotifyDeliveryResult {
  status: "sent" | "failed";
  detail?: string;
}

export interface NotifyAdapter {
  deliver(destination: NotifyDestination, payload: NotifyPayload): Promise<NotifyDeliveryResult>;
}
```

- [ ] **Step 2: Run typecheck**

```bash
cd augment-1 && bunx tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): NotifyAugmentOptions, NotifyDestination, NotifyAdapter

Discriminated NotifyDestination union (webhook | telegram) keeps adapter
selection type-safe at config time. NotifyRateLimitOptions carries forward
the shape used by today's org-context EscalationLimits."
```

---

## Task T3: Webhook adapter

**Files:**
- Create: `augment-1/src/augments/notify/adapters/webhook.ts`
- Create: `augment-1/tests/augments/notify/adapters/webhook.test.ts`

- [ ] **Step 1: Write the failing tests**

In `augment-1/tests/augments/notify/adapters/webhook.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { createWebhookAdapter } from "../../../../src/augments/notify/adapters/webhook";
import type { WebhookNotifyDestination } from "../../../../src/types";

function mockHttp(handler: (url: string, body: unknown, headers?: Record<string, string>) => { status: number; body: string }) {
  return {
    get: async () => ({ status: 405, body: "" }),
    post: async (url: string, opts?: { headers?: Record<string, string>; body?: string }) => {
      const body = opts?.body ? JSON.parse(opts.body) : undefined;
      return handler(url, body, opts?.headers);
    },
  };
}

const dest: WebhookNotifyDestination = {
  name: "test",
  transport: "webhook",
  url: "https://example.com/notify",
};

describe("webhookAdapter", () => {
  it("POSTs JSON payload to configured URL", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;
    const adapter = createWebhookAdapter({
      client: mockHttp((url, body) => {
        capturedUrl = url;
        capturedBody = body;
        return { status: 200, body: JSON.stringify({ status: "sent" }) };
      }) as any,
    });
    const result = await adapter.deliver(dest, { summary: "test alert", reason: "test" });
    expect(capturedUrl).toBe("https://example.com/notify");
    expect(capturedBody).toEqual({ summary: "test alert", reason: "test", channel: "notify" });
    expect(result.status).toBe("sent");
  });

  it("includes optional visitor field when provided", async () => {
    let body: any;
    const adapter = createWebhookAdapter({
      client: mockHttp((u, b) => { body = b; return { status: 200, body: "{}" }; }) as any,
    });
    await adapter.deliver(dest, { summary: "x", visitor: "v1" });
    expect(body.visitor).toBe("v1");
  });

  it("forwards configured headers", async () => {
    const destWithHeaders: WebhookNotifyDestination = { ...dest, headers: { authorization: "Bearer T" } };
    let capturedHeaders: Record<string, string> | undefined;
    const adapter = createWebhookAdapter({
      client: mockHttp((u, b, h) => { capturedHeaders = h; return { status: 200, body: "{}" }; }) as any,
    });
    await adapter.deliver(destWithHeaders, { summary: "x" });
    expect(capturedHeaders?.authorization).toBe("Bearer T");
  });

  it("4xx surfaces as failed result", async () => {
    const adapter = createWebhookAdapter({
      client: mockHttp(() => ({ status: 400, body: JSON.stringify({ error: "bad" }) })) as any,
    });
    const result = await adapter.deliver(dest, { summary: "x" });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("400");
  });

  it("5xx surfaces as failed result", async () => {
    const adapter = createWebhookAdapter({
      client: mockHttp(() => ({ status: 503, body: "unavailable" })) as any,
    });
    const result = await adapter.deliver(dest, { summary: "x" });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("503");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd augment-1 && bun test tests/augments/notify/adapters/webhook.test.ts
```
Expected: FAIL — `createWebhookAdapter` not found.

- [ ] **Step 3: Implement the adapter**

Create `augment-1/src/augments/notify/adapters/webhook.ts`:

```typescript
import { createHttpClient } from "../../../http";
import type { HttpClient } from "../../../http";
import type {
  NotifyAdapter,
  NotifyDestination,
  NotifyPayload,
  NotifyDeliveryResult,
  WebhookNotifyDestination,
} from "../../../types";

export interface CreateWebhookAdapterOptions {
  client?: HttpClient;
}

export function createWebhookAdapter(opts: CreateWebhookAdapterOptions = {}): NotifyAdapter {
  const http = opts.client ?? createHttpClient({ timeoutMs: 10_000, userAgent: "auggy-notify-webhook/0.1" });

  return {
    async deliver(destination: NotifyDestination, payload: NotifyPayload): Promise<NotifyDeliveryResult> {
      if (destination.transport !== "webhook") {
        return { status: "failed", detail: `webhookAdapter received non-webhook destination: ${destination.transport}` };
      }
      const dest = destination as WebhookNotifyDestination;
      const body = JSON.stringify({
        summary: payload.summary,
        ...(payload.reason ? { reason: payload.reason } : {}),
        ...(payload.visitor ? { visitor: payload.visitor } : {}),
        channel: "notify",
      });

      try {
        const res = await http.post(dest.url, {
          headers: { "content-type": "application/json", ...(dest.headers ?? {}) },
          body,
        });
        if (res.status < 200 || res.status >= 300) {
          return { status: "failed", detail: `webhook ${dest.url} returned ${res.status}: ${res.body.slice(0, 200)}` };
        }
        return { status: "sent" };
      } catch (err) {
        return { status: "failed", detail: `webhook ${dest.url} error: ${(err as Error).message}` };
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd augment-1 && bun test tests/augments/notify/adapters/webhook.test.ts
```
Expected: 5/5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/augments/notify/adapters/webhook.ts tests/augments/notify/adapters/webhook.test.ts
git commit -m "feat(notify): webhook adapter

POSTs {summary, reason?, visitor?, channel: 'notify'} JSON payload to
configured URL. Subsumes the previous 'delegated escalation' shape — calling
agent-context-api/notify is just a webhook destination."
```

---

## Task T4: Telegram adapter

**Files:**
- Create: `augment-1/src/augments/notify/adapters/telegram.ts`
- Create: `augment-1/tests/augments/notify/adapters/telegram.test.ts`

- [ ] **Step 1: Write the failing tests**

In `augment-1/tests/augments/notify/adapters/telegram.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { createTelegramAdapter } from "../../../../src/augments/notify/adapters/telegram";
import type { TelegramNotifyDestination, TelegramBotClient } from "../../../../src/types";
import type { TelegramBotClient as Tbc } from "../../../../src/telegram-client";

function mockClient(handler: (chatId: number | string, text: string) => Promise<{ messageId: number; chatId: number | string }>) {
  const c: Tbc = {
    sendMessage: async (chatId, text) => handler(chatId, text),
    getUpdates: async () => [],
    setWebhook: async () => {},
    deleteWebhook: async () => {},
    getChat: async (chatId) => ({ id: Number(chatId), type: "private" }),
  };
  return c;
}

const dest: TelegramNotifyDestination = {
  name: "creator",
  transport: "telegram",
  botToken: "T",
  chatId: 555,
};

describe("telegramAdapter", () => {
  it("calls sendMessage with chatId and formatted text", async () => {
    let captured: { chatId?: number | string; text?: string } = {};
    const client = mockClient(async (chatId, text) => {
      captured = { chatId, text };
      return { messageId: 1, chatId };
    });
    const adapter = createTelegramAdapter({ clientFactory: () => client });
    const result = await adapter.deliver(dest, { summary: "Important alert", reason: "test reason" });
    expect(captured.chatId).toBe(555);
    expect(captured.text).toContain("Important alert");
    expect(captured.text).toContain("test reason");
    expect(result.status).toBe("sent");
  });

  it("includes visitor in formatted text when provided", async () => {
    let text = "";
    const client = mockClient(async (c, t) => { text = t; return { messageId: 1, chatId: c }; });
    const adapter = createTelegramAdapter({ clientFactory: () => client });
    await adapter.deliver(dest, { summary: "x", visitor: "alice" });
    expect(text).toContain("alice");
  });

  it("returns failed when sendMessage throws", async () => {
    const client = mockClient(async () => { throw new Error("API error: chat not found"); });
    const adapter = createTelegramAdapter({ clientFactory: () => client });
    const result = await adapter.deliver(dest, { summary: "x" });
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("chat not found");
  });

  it("caches client per botToken", async () => {
    let factoryCalls = 0;
    const adapter = createTelegramAdapter({
      clientFactory: () => {
        factoryCalls++;
        return mockClient(async (c) => ({ messageId: 1, chatId: c }));
      },
    });
    await adapter.deliver(dest, { summary: "1" });
    await adapter.deliver(dest, { summary: "2" });
    expect(factoryCalls).toBe(1);
  });

  it("creates separate clients for different botTokens", async () => {
    let tokens: string[] = [];
    const adapter = createTelegramAdapter({
      clientFactory: (token: string) => {
        tokens.push(token);
        return mockClient(async (c) => ({ messageId: 1, chatId: c }));
      },
    });
    await adapter.deliver(dest, { summary: "1" });
    await adapter.deliver({ ...dest, botToken: "OTHER" }, { summary: "2" });
    expect(tokens).toEqual(["T", "OTHER"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd augment-1 && bun test tests/augments/notify/adapters/telegram.test.ts
```
Expected: FAIL — `createTelegramAdapter` not found.

- [ ] **Step 3: Implement the adapter**

Create `augment-1/src/augments/notify/adapters/telegram.ts`:

```typescript
import { createTelegramBotClient } from "../../../telegram-client";
import type { TelegramBotClient } from "../../../telegram-client";
import type {
  NotifyAdapter,
  NotifyDestination,
  NotifyPayload,
  NotifyDeliveryResult,
  TelegramNotifyDestination,
} from "../../../types";

export interface CreateTelegramAdapterOptions {
  /** Override the client factory for testing. */
  clientFactory?: (botToken: string) => TelegramBotClient;
}

export function createTelegramAdapter(opts: CreateTelegramAdapterOptions = {}): NotifyAdapter {
  const factory = opts.clientFactory ?? ((botToken: string) => createTelegramBotClient({ botToken }));
  const cache = new Map<string, TelegramBotClient>();

  function getClient(botToken: string): TelegramBotClient {
    let client = cache.get(botToken);
    if (!client) {
      client = factory(botToken);
      cache.set(botToken, client);
    }
    return client;
  }

  function formatText(payload: NotifyPayload): string {
    const lines = [`*${payload.summary}*`];
    if (payload.reason) lines.push(`_Reason:_ ${payload.reason}`);
    if (payload.visitor) lines.push(`_Visitor:_ ${payload.visitor}`);
    return lines.join("\n");
  }

  return {
    async deliver(destination: NotifyDestination, payload: NotifyPayload): Promise<NotifyDeliveryResult> {
      if (destination.transport !== "telegram") {
        return { status: "failed", detail: `telegramAdapter received non-telegram destination: ${destination.transport}` };
      }
      const dest = destination as TelegramNotifyDestination;
      try {
        const client = getClient(dest.botToken);
        await client.sendMessage(dest.chatId, formatText(payload), {
          parseMode: dest.parseMode ?? "Markdown",
        });
        return { status: "sent" };
      } catch (err) {
        return { status: "failed", detail: `telegram error: ${(err as Error).message}` };
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd augment-1 && bun test tests/augments/notify/adapters/telegram.test.ts
```
Expected: 5/5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/augments/notify/adapters/telegram.ts tests/augments/notify/adapters/telegram.test.ts
git commit -m "feat(notify): telegram adapter

Wraps src/telegram-client.ts. Caches one bot client per botToken (avoids
recreating HTTP clients between calls). Markdown-formatted text with summary
+ optional reason + optional visitor."
```

---

## Task T5: Notify augment factory + rate limits + creator bypass

**Files:**
- Create: `augment-1/src/augments/notify.ts`
- Create: `augment-1/tests/augments/notify.test.ts`

This task lifts the rate-limit logic verbatim from `org-context.ts:89-165` (cooldown, dedup with `wordOverlap`, global hourly counter, per-peer cooldown). Same defaults as today's `org_escalate`.

- [ ] **Step 1: Write the failing tests**

In `augment-1/tests/augments/notify.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { notify } from "../../src/augments/notify";
import type { PeerIdentity, ToolExecuteContext, NotifyAugmentOptions } from "../../src/types";

function makePeer(id: string, trustLevel: PeerIdentity["trustLevel"] = "public"): PeerIdentity {
  return { id, kind: "human", trustLevel, sourceAugment: "web", ...(trustLevel === "public" ? { publicSubstate: "anonymous" as const } : {}) };
}

function makeContext(peer: PeerIdentity | null = null): ToolExecuteContext {
  return { turnId: `turn-${crypto.randomUUID()}`, peer, threadId: "thread-1" };
}

function mockAdapter(deliveries: Array<{ destination: string; result: "sent" | "failed" }> = []) {
  return {
    deliver: async (destination: any, _payload: any) => {
      deliveries.push({ destination: destination.name, result: "sent" });
      return { status: "sent" as const };
    },
  };
}

const baseOpts: NotifyAugmentOptions = {
  destinations: [
    { name: "creator", transport: "webhook", url: "https://example.com/notify" },
    { name: "ops", transport: "webhook", url: "https://example.com/ops" },
  ],
  rateLimit: { cooldownMs: 60_000, dedupThreshold: 0, globalMaxPerHour: 100 },
};

describe("notify augment", () => {
  it("delivers to named destination", async () => {
    const deliveries: Array<{ destination: string; result: any }> = [];
    const aug = notify({
      ...baseOpts,
      adapters: { webhook: mockAdapter(deliveries) as any, telegram: mockAdapter([]) as any },
    });
    const tool = aug.tools!.find((t) => t.name === "notify")!;
    const ctx = makeContext(makePeer("v1"));
    const result = JSON.parse(await tool.execute({ to: "creator", summary: "test" }, ctx));
    expect(result.status).toBe("sent");
    expect(deliveries).toEqual([{ destination: "creator", result: "sent" }]);
  });

  it("returns error when destination name not configured", async () => {
    const aug = notify({ ...baseOpts, adapters: { webhook: mockAdapter() as any, telegram: mockAdapter() as any } });
    const tool = aug.tools!.find((t) => t.name === "notify")!;
    const ctx = makeContext(makePeer("v1"));
    const result = JSON.parse(await tool.execute({ to: "nope", summary: "x" }, ctx));
    expect(result.status).toBe("failed");
    expect(result.message).toContain("nope");
  });

  it("blocks second call from same peer within per-peer cooldown", async () => {
    const aug = notify({
      ...baseOpts,
      rateLimit: { cooldownMs: 60_000, dedupThreshold: 0, perPeerCooldownMs: 30_000 },
      adapters: { webhook: mockAdapter() as any, telegram: mockAdapter() as any },
    });
    const tool = aug.tools!.find((t) => t.name === "notify")!;
    const ctx = makeContext(makePeer("v1"));
    await tool.execute({ to: "creator", summary: "first" }, ctx);
    const result = JSON.parse(await tool.execute({ to: "creator", summary: "second" }, ctx));
    expect(result.status).toBe("rate_limited");
    expect(result.message).toContain("cooldown");
  });

  it("allows different peer during cooldown", async () => {
    const aug = notify({
      ...baseOpts,
      rateLimit: { cooldownMs: 60_000, dedupThreshold: 0, perPeerCooldownMs: 30_000 },
      adapters: { webhook: mockAdapter() as any, telegram: mockAdapter() as any },
    });
    const tool = aug.tools!.find((t) => t.name === "notify")!;
    await tool.execute({ to: "creator", summary: "first" }, makeContext(makePeer("v1")));
    const result = JSON.parse(await tool.execute({ to: "creator", summary: "second" }, makeContext(makePeer("v2"))));
    expect(result.status).toBe("sent");
  });

  it("blocks similar-summary call within dedup window", async () => {
    const aug = notify({
      ...baseOpts,
      rateLimit: { cooldownMs: 0, dedupWindowMs: 60_000, dedupThreshold: 0.6 },
      adapters: { webhook: mockAdapter() as any, telegram: mockAdapter() as any },
    });
    const tool = aug.tools!.find((t) => t.name === "notify")!;
    await tool.execute({ to: "creator", summary: "visitor wants partnership opportunity" }, makeContext(makePeer("v1")));
    const result = JSON.parse(await tool.execute(
      { to: "creator", summary: "visitor wants partnership opportunity discussion" },
      makeContext(makePeer("v2")),
    ));
    expect(result.status).toBe("rate_limited");
  });

  it("blocks after global hourly cap reached", async () => {
    const aug = notify({
      ...baseOpts,
      rateLimit: { cooldownMs: 0, globalMaxPerHour: 2, dedupThreshold: 0 },
      adapters: { webhook: mockAdapter() as any, telegram: mockAdapter() as any },
    });
    const tool = aug.tools!.find((t) => t.name === "notify")!;
    await tool.execute({ to: "creator", summary: "1" }, makeContext(makePeer("v1")));
    await tool.execute({ to: "creator", summary: "2" }, makeContext(makePeer("v2")));
    const result = JSON.parse(await tool.execute({ to: "creator", summary: "3" }, makeContext(makePeer("v3"))));
    expect(result.status).toBe("rate_limited");
    expect(result.message).toContain("global");
  });

  it("creator-class peer bypasses all rate limits", async () => {
    const aug = notify({
      ...baseOpts,
      rateLimit: { cooldownMs: 60_000, globalMaxPerHour: 1, dedupThreshold: 0.9, perPeerCooldownMs: 30_000 },
      adapters: { webhook: mockAdapter() as any, telegram: mockAdapter() as any },
    });
    const tool = aug.tools!.find((t) => t.name === "notify")!;
    await tool.execute({ to: "creator", summary: "first" }, makeContext(makePeer("v1")));
    const result = JSON.parse(await tool.execute(
      { to: "creator", summary: "first" },
      makeContext(makePeer("op", "creator")),
    ));
    expect(result.status).toBe("sent");
  });

  it("returns error when ToolExecuteContext is missing", async () => {
    const aug = notify({ ...baseOpts, adapters: { webhook: mockAdapter() as any, telegram: mockAdapter() as any } });
    const tool = aug.tools!.find((t) => t.name === "notify")!;
    const result = JSON.parse(await tool.execute({ to: "creator", summary: "x" }));
    expect(result.status).toBe("failed");
    expect(result.message).toContain("context");
  });

  it("disabled rate limiting allows unlimited calls", async () => {
    const aug = notify({
      ...baseOpts,
      rateLimit: { enabled: false },
      adapters: { webhook: mockAdapter() as any, telegram: mockAdapter() as any },
    });
    const tool = aug.tools!.find((t) => t.name === "notify")!;
    const ctx = makeContext(makePeer("v1"));
    await tool.execute({ to: "creator", summary: "1" }, ctx);
    const result = JSON.parse(await tool.execute({ to: "creator", summary: "1" }, ctx));
    expect(result.status).toBe("sent");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd augment-1 && bun test tests/augments/notify.test.ts
```
Expected: FAIL — `notify` not exported.

- [ ] **Step 3: Implement the augment**

Create `augment-1/src/augments/notify.ts`:

```typescript
/**
 * Notify augment — outbound messaging primitive.
 *
 * Routes the agent's `notify({to, summary, ...})` calls to operator-defined
 * destinations via internal adapter modules (webhook, telegram). Owns the
 * rate-limit state lifted from org-context.ts (cooldown, dedup, global cap,
 * per-peer cooldown). Creator-class senders bypass rate limits.
 *
 * NOT a transport. NOT cross-augment-coupled. Internal adapters call the
 * shared src/telegram-client.ts (telegram adapter only) or POST directly
 * (webhook adapter).
 */

import { z } from "zod";
import type {
  Augment,
  NotifyAugmentOptions,
  NotifyAdapter,
  NotifyDestination,
  ToolExecuteContext,
} from "../types";
import { defineTool } from "../helpers";
import { createWebhookAdapter } from "./notify/adapters/webhook";
import { createTelegramAdapter } from "./notify/adapters/telegram";

export interface NotifyAugmentInternalOptions extends NotifyAugmentOptions {
  /** Test-only adapter override. Production code does not pass this. */
  adapters?: { webhook: NotifyAdapter; telegram: NotifyAdapter };
}

export function notify(opts: NotifyAugmentInternalOptions): Augment {
  const adapters = opts.adapters ?? {
    webhook: createWebhookAdapter(),
    telegram: createTelegramAdapter(),
  };

  const destinationsByName = new Map<string, NotifyDestination>();
  for (const d of opts.destinations) destinationsByName.set(d.name, d);

  const rl = opts.rateLimit ?? {};
  const enabled = rl.enabled !== false;
  const cooldownMs = rl.cooldownMs ?? 120_000;
  const globalMaxPerHour = rl.globalMaxPerHour ?? 5;
  const dedupWindowMs = rl.dedupWindowMs ?? 300_000;
  const dedupThreshold = rl.dedupThreshold ?? 0.6;
  const perPeerCooldownMs = rl.perPeerCooldownMs ?? cooldownMs;

  const peerLastNotify = new Map<string, number>();
  const recentSummaries: Array<{ summary: string; timestamp: number }> = [];
  let globalCountThisHour = 0;
  let globalHourStart = Date.now();

  function checkPeerCooldown(peerId: string): string | null {
    const last = peerLastNotify.get(peerId);
    if (!last) return null;
    const elapsed = Date.now() - last;
    if (elapsed < perPeerCooldownMs) {
      const remainingSec = Math.ceil((perPeerCooldownMs - elapsed) / 1000);
      return `Notification suppressed — per-peer cooldown active. Next available in ${remainingSec} seconds.`;
    }
    return null;
  }

  function checkGlobalLimit(): string | null {
    const now = Date.now();
    if (now - globalHourStart > 3_600_000) {
      globalCountThisHour = 0;
      globalHourStart = now;
    }
    if (globalCountThisHour >= globalMaxPerHour) {
      return `Notification suppressed — global limit reached (${globalMaxPerHour} per hour).`;
    }
    return null;
  }

  function checkDedup(summary: string): string | null {
    if (dedupThreshold <= 0) return null;
    const now = Date.now();
    while (recentSummaries.length > 0 && now - recentSummaries[0]!.timestamp > dedupWindowMs) {
      recentSummaries.shift();
    }
    for (const recent of recentSummaries) {
      if (wordOverlap(summary, recent.summary) >= dedupThreshold) {
        return "Notification suppressed — a similar message was already sent recently.";
      }
    }
    return null;
  }

  function wordOverlap(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    const smaller = wordsA.size <= wordsB.size ? wordsA : wordsB;
    const larger = wordsA.size > wordsB.size ? wordsA : wordsB;
    let matches = 0;
    for (const word of smaller) {
      if (larger.has(word)) matches++;
    }
    return matches / smaller.size;
  }

  function recordNotification(peerId: string, summary: string): void {
    peerLastNotify.set(peerId, Date.now());
    recentSummaries.push({ summary, timestamp: Date.now() });
    globalCountThisHour++;
  }

  const notifyTool = defineTool({
    name: "notify",
    description:
      "Send a notification to an operator-defined destination. Use named destinations from the agent's notify configuration (e.g. 'creator'). Use when proactively alerting an operator, sharing a status update, or escalating a situation outside your scope.",
    category: "communication",
    input: z.object({
      to: z.string().describe("Destination name configured in agent.yaml (e.g. 'creator', 'ops')"),
      summary: z.string().describe("Brief description of what needs attention"),
      reason: z.string().optional().describe("Why this notification is being sent"),
      visitor: z.string().optional().describe("Visitor name or identifier if relevant"),
    }),
    execute: async ({ to, summary, reason, visitor }, context?: ToolExecuteContext) => {
      if (!context) {
        return JSON.stringify({
          status: "failed",
          message: "notify requires turn context — cannot determine peer identity.",
        });
      }

      const destination = destinationsByName.get(to);
      if (!destination) {
        return JSON.stringify({
          status: "failed",
          message: `Unknown destination '${to}'. Configured destinations: ${[...destinationsByName.keys()].join(", ") || "(none)"}.`,
        });
      }

      const trustLevel = context.peer?.trustLevel ?? "creator";
      if (enabled && trustLevel !== "creator" && context.peer) {
        const peerId = context.peer.id;
        const peerMsg = checkPeerCooldown(peerId);
        if (peerMsg) {
          return JSON.stringify({ status: "rate_limited", message: peerMsg });
        }
        const globalMsg = checkGlobalLimit();
        if (globalMsg) {
          return JSON.stringify({ status: "rate_limited", message: globalMsg });
        }
        const dedupMsg = checkDedup(summary);
        if (dedupMsg) {
          return JSON.stringify({ status: "rate_limited", message: dedupMsg });
        }
      }

      const adapter = adapters[destination.transport];
      const result = await adapter.deliver(destination, { summary, reason, visitor });

      if (result.status === "sent" && trustLevel !== "creator" && context.peer) {
        recordNotification(context.peer.id, summary);
      }

      return JSON.stringify({
        status: result.status,
        ...(result.detail ? { detail: result.detail } : {}),
      });
    },
  });

  return {
    name: "notify",
    capabilities: ["tools"],
    tools: [notifyTool],
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd augment-1 && bun test tests/augments/notify.test.ts
```
Expected: 9/9 passing.

- [ ] **Step 5: Run typecheck and full suite**

```bash
cd augment-1 && bunx tsc --noEmit && bun test
```
Expected: typecheck clean; full suite still green (existing 871 tests + new 9 = 880).

- [ ] **Step 6: Commit**

```bash
git add src/augments/notify.ts tests/augments/notify.test.ts
git commit -m "feat(notify): augment factory with rate limits + creator bypass

Lifts cooldown / dedup / global hourly cap / per-peer cooldown / wordOverlap
verbatim from org-context.ts (lines 89-165). Adds named-destination dispatch
to internal adapters. Creator-class senders bypass all rate limits, matching
today's org_escalate semantics. Trust-level enforcement preserved.

Tool surface: notify({to, summary, reason?, visitor?})."
```

---

## Task T6: Strip `org_escalate` from `orgContext`

**Files:**
- Modify: `augment-1/src/augments/org-context.ts`
- Delete: `augment-1/tests/augments/org-context.test.ts`

The current `org-context.ts` at HEAD (~425 LOC) has these escalation pieces to remove:
- `EscalationLimits` interface (lines ~30–36)
- `escalation?` field on `OrgContextOptions` (line ~48)
- Escalation rate-limit constructor block (lines ~85–155): `escalationEnabled`, `cooldownMs`, `globalMaxPerHour`, `dedupWindowMs`, `dedupThreshold`, `peerLastEscalation`, `recentSummaries`, `globalCountThisHour`, `globalHourStart`, `checkCooldown`, `checkGlobalLimit`, `checkDedup`, `wordOverlap`, `recordEscalation`
- `orgEscalateTool` definition (lines ~287–376)
- `orgEscalateTool` reference in returned `tools: [...]` array

What stays:
- `OrgContextOptions` minus `escalation`
- `ManifestEndpoint`, `OrgManifest` types
- HTTP client setup
- `cachedManifest`, `cacheExpiresAt`, `fetchManifest`
- `buildContextBlock`
- `orgFetchTool` definition
- `context()` and `onBoot()` lifecycle hooks
- The augment's returned object minus `orgEscalateTool` from `tools` and minus the escalation imports

- [ ] **Step 1: Apply the strip**

Replace the entire body of `augment-1/src/augments/org-context.ts` with:

```typescript
/**
 * Org-context augment — read-only manifest registry.
 *
 * Connects an Auggy agent to an organization's knowledge API. Two stages of
 * progressive disclosure:
 *   1. Manifest (always in context, ~200 tokens) — org identity + endpoint list
 *   2. Endpoint content (on demand via org_fetch) — full docs, fetched when relevant
 *
 * Outbound messaging (org_escalate, rate limits) moved to the notify augment
 * in roadmap item 6 (2026-04-28). For escalation, mount the notify augment
 * alongside this one.
 *
 * Boot is graceful: if the org API is unreachable, the agent starts without
 * org context and logs a warning. org_fetch will fail with clear errors until
 * the API is reachable.
 */

import { z } from "zod";
import type { Augment, ContextBlock } from "../types";
import { defineTool } from "../helpers";
import { createHttpClient } from "../http";
import type { HttpClient } from "../http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrgContextOptions {
  /** Base URL of the org's API (e.g. "http://localhost:3000"). */
  baseUrl: string;
  /** Optional auth token for the org API. */
  token?: string;
  /** Manifest cache TTL in milliseconds. Default 1 hour. */
  cacheTtlMs?: number;
  /** Optional pre-built HTTP client (for sharing across augments or testing). */
  client?: HttpClient;
}

interface ManifestEndpoint {
  path: string;
  description: string;
  method?: string;
}

interface OrgManifest {
  org: string;
  purpose: string;
  operator?: string;
  phase?: string;
  endpoints: ManifestEndpoint[];
}

// ---------------------------------------------------------------------------
// Augment factory
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_TTL = 60 * 60 * 1000; // 1 hour

export function orgContext(opts: OrgContextOptions): Augment {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const client = opts.client ?? createHttpClient({
    timeoutMs: 10_000,
    userAgent: "auggy-org-context/0.2",
    defaultHeaders: opts.token
      ? { authorization: `Bearer ${opts.token}` }
      : {},
  });
  const cacheTtl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL;

  let cachedManifest: OrgManifest | null = null;
  let cacheExpiresAt = 0;

  // ---------------------------------------------------------------------------
  // Manifest fetching
  // ---------------------------------------------------------------------------

  async function fetchManifest(force = false): Promise<OrgManifest | null> {
    if (!force && cachedManifest && Date.now() < cacheExpiresAt) {
      return cachedManifest;
    }

    try {
      const res = await client.get(`${baseUrl}/manifest`);
      if (res.status !== 200) {
        console.warn(`[org-context] manifest returned ${res.status}: ${res.body.slice(0, 200)}`);
        return cachedManifest;
      }
      cachedManifest = JSON.parse(res.body) as OrgManifest;
      cacheExpiresAt = Date.now() + cacheTtl;
      return cachedManifest;
    } catch (err) {
      console.warn(`[org-context] failed to fetch manifest: ${(err as Error).message}`);
      return cachedManifest;
    }
  }

  // ---------------------------------------------------------------------------
  // Context block
  // ---------------------------------------------------------------------------

  function buildContextBlock(manifest: OrgManifest): string {
    const lines = [
      `# ${manifest.org} — Organization Context`,
      "",
      manifest.purpose,
      "",
    ];

    if (manifest.operator) {
      lines.push(`**Operator:** ${manifest.operator}`);
    }
    if (manifest.phase) {
      lines.push(`**Current phase:** ${manifest.phase}`);
    }

    lines.push("");
    lines.push("## Available org knowledge");
    lines.push("");
    lines.push("Use `org_fetch` to retrieve any of these when relevant to the conversation:");
    lines.push("");

    for (const ep of manifest.endpoints) {
      if (ep.method === "POST") {
        lines.push(`- **${ep.path}** (action) — ${ep.description}`);
      } else {
        lines.push(`- **${ep.path}** — ${ep.description}`);
      }
    }

    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // org_fetch tool
  // ---------------------------------------------------------------------------

  const orgFetchTool = defineTool({
    name: "org_fetch",
    description:
      "Fetch knowledge from the organization's API. Use the endpoint paths from the org context manifest.",
    category: "search",
    input: z.object({
      endpoint: z
        .string()
        .describe("The endpoint path (e.g. '/vision', '/initiatives', '/solutions/architecture')"),
      prompt: z
        .string()
        .optional()
        .describe("Optional: what you want to know from the content"),
    }),
    execute: async ({ endpoint, prompt }) => {
      const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;

      try {
        const res = await client.get(`${baseUrl}${path}`);
        if (res.status !== 200) {
          return JSON.stringify({
            error: `Org API returned ${res.status} for ${path}`,
          });
        }

        try {
          const data = JSON.parse(res.body) as { files?: Array<{ name: string; content: string }> };
          if (data.files && Array.isArray(data.files)) {
            const content = data.files
              .map((f) => `## ${f.name}\n\n${f.content}`)
              .join("\n\n---\n\n");

            const maxChars = 20_000;
            const truncated = content.length > maxChars
              ? content.slice(0, maxChars) + `\n\n[truncated — ${content.length} total chars]`
              : content;

            return JSON.stringify({
              endpoint: path,
              fileCount: data.files.length,
              content: truncated,
              ...(prompt ? { prompt } : {}),
            });
          }
        } catch {
          // Not JSON or not the expected format — return raw body.
        }

        return JSON.stringify({
          endpoint: path,
          content: res.body.slice(0, 20_000),
        });
      } catch (err) {
        return JSON.stringify({
          error: `Failed to fetch ${path}: ${(err as Error).message}`,
          hint: "The org API may be temporarily unreachable.",
        });
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Augment
  // ---------------------------------------------------------------------------

  return {
    name: "org-context",
    capabilities: ["context", "tools"],
    tools: [orgFetchTool],

    context: async () => {
      const manifest = await fetchManifest();
      if (!manifest) return [];

      const block: ContextBlock = {
        source: "org-context",
        content: buildContextBlock(manifest),
        placement: "system",
        priority: "required",
        eviction: "never",
        origin: "operator",
        provenance: "augment",
        ttl: "persistent",
      };

      return [block];
    },

    onBoot: async () => {
      const delays = [0, 2000, 5000];
      let manifest: OrgManifest | null = null;

      for (let i = 0; i < delays.length; i++) {
        if (delays[i]! > 0) await new Promise((r) => setTimeout(r, delays[i]!));
        manifest = await fetchManifest(true);
        if (manifest) break;
        if (i < delays.length - 1) {
          console.warn(`[org-context] manifest fetch failed, retrying in ${delays[i + 1]! / 1000}s...`);
        }
      }

      if (manifest) {
        console.log(`[org-context] loaded manifest for ${manifest.org} (${manifest.endpoints.length} endpoints)`);
      } else {
        console.warn("[org-context] org API unreachable — running without org context. Will retry on first org_fetch call.");
      }
    },
  };
}
```

- [ ] **Step 2: Delete the escalation test file**

```bash
cd augment-1 && rm tests/augments/org-context.test.ts
```

The file consists entirely of `org_escalate` rate-limit tests — no `org_fetch` or manifest tests to preserve. Verified by `grep -rnE "org_fetch|fetchManifest" augment-1/tests` returning no other occurrences. Coverage is replaced by the new notify tests (T5) plus the integration test (T8 below).

- [ ] **Step 3: Run typecheck**

```bash
cd augment-1 && bunx tsc --noEmit
```
Expected: clean. Any compile errors here mean the strip removed something still referenced — most likely a CLI resolver that passes `escalation:` options. If so, address in T7 (CLI wiring) by removing the deprecated option from the resolver call.

- [ ] **Step 4: Run the full test suite**

```bash
cd augment-1 && bun test
```
Expected: green. Current is 871 + 9 (notify) = 880; minus 12 deleted org-context tests = 868. Adjust below if your starting count differs.

- [ ] **Step 5: Commit**

```bash
git add src/augments/org-context.ts tests/augments/org-context.test.ts
git commit -m "refactor(org-context): strip org_escalate; outbound moves to notify

Remove org_escalate tool, EscalationLimits type, cooldown/dedup/global-counter
state, wordOverlap helper, recordEscalation helper. Keep org_fetch, manifest
fetch + cache, context-block injection.

The deleted org-context.test.ts was entirely escalation tests; equivalent
behavior now covered by tests/augments/notify.test.ts (T5).

Closes ROADMAP item 6 strip step. Notify augment (T5) takes over outbound."
```

---

## Task T7: CLI wiring for `notify`

**Files:**
- Modify: `augment-1/src/cli/config-parser.ts`
- Modify: `augment-1/src/cli/augment-resolver.ts`
- Modify: `augment-1/src/cli/augment-catalog.ts`

- [ ] **Step 1: Add `notify` to BUILTIN_TYPES**

In `augment-1/src/cli/config-parser.ts`, locate the `BUILTIN_TYPES` Set (currently lines 117–127):

```typescript
const BUILTIN_TYPES = new Set([
  "fileMemory",
  "supabaseMemory",
  "layeredMemory",
  "filesystem",
  "webTransport",
  "webFetch",
  "orgContext",
  "bash",
  "budgets",
]);
```

Add `"notify"`:

```typescript
const BUILTIN_TYPES = new Set([
  "fileMemory",
  "supabaseMemory",
  "layeredMemory",
  "filesystem",
  "webTransport",
  "webFetch",
  "orgContext",
  "bash",
  "budgets",
  "notify",
]);
```

- [ ] **Step 2: Add `validateNotifyOptions` helper**

In the same file, add this validator alongside `validateBudgetsOptions` (around line 170+):

```typescript
function validateNotifyOptions(
  opts: Record<string, unknown>,
  prefix: string,
  errors: string[],
): void {
  if (!Array.isArray(opts.destinations)) {
    errors.push(`${prefix}.destinations: required array`);
    return;
  }
  if (opts.destinations.length === 0) {
    errors.push(`${prefix}.destinations: must have at least one destination`);
  }

  const seenNames = new Set<string>();
  for (let i = 0; i < opts.destinations.length; i++) {
    const dest = opts.destinations[i] as Record<string, unknown>;
    const dPrefix = `${prefix}.destinations[${i}]`;
    if (typeof dest.name !== "string" || !dest.name) {
      errors.push(`${dPrefix}.name: required string`);
      continue;
    }
    if (seenNames.has(dest.name)) {
      errors.push(`${dPrefix}.name: duplicate name "${dest.name}"`);
    }
    seenNames.add(dest.name);

    if (dest.transport === "webhook") {
      if (typeof dest.url !== "string" || !dest.url) {
        errors.push(`${dPrefix}.url: required string for webhook transport`);
      }
    } else if (dest.transport === "telegram") {
      if (typeof dest.botToken !== "string" || !dest.botToken) {
        errors.push(`${dPrefix}.botToken: required string for telegram transport`);
      }
      if (dest.chatId == null || (typeof dest.chatId !== "string" && typeof dest.chatId !== "number")) {
        errors.push(`${dPrefix}.chatId: required string or number for telegram transport`);
      }
    } else {
      errors.push(`${dPrefix}.transport: must be "webhook" or "telegram"`);
    }
  }

  if (opts.rateLimit !== undefined) {
    const rl = opts.rateLimit as Record<string, unknown>;
    const numericFields = ["cooldownMs", "globalMaxPerHour", "dedupWindowMs", "dedupThreshold", "perPeerCooldownMs"] as const;
    for (const field of numericFields) {
      if (rl[field] !== undefined && (typeof rl[field] !== "number" || (rl[field] as number) < 0)) {
        errors.push(`${prefix}.rateLimit.${field}: must be a non-negative number`);
      }
    }
    if (rl.enabled !== undefined && typeof rl.enabled !== "boolean") {
      errors.push(`${prefix}.rateLimit.enabled: must be a boolean`);
    }
  }
}
```

- [ ] **Step 3: Wire the validator into the augment-validation switch**

Find the augment-type validation switch (around line 425, near `if (aug.type === "budgets")`). Add the notify case:

```typescript
if (aug.type === "budgets") {
  validateBudgetsOptions(aug.options ?? {}, `${prefix}.options`, errors);
} else if (aug.type === "notify") {
  validateNotifyOptions(aug.options ?? {}, `${prefix}.options`, errors);
}
```

(Adjust the surrounding control flow as needed; keep `else if` chaining if the file uses that style.)

- [ ] **Step 4: Wire the resolver case**

In `augment-1/src/cli/augment-resolver.ts`, add an import near the existing augment imports (top of file, alongside `orgContext`):

```typescript
import { notify } from "../augments/notify";
import type { NotifyAugmentOptions } from "../types";
```

Add a case in the `switch (config.type)` block (around line 290, near the `budgets` case):

```typescript
case "notify": {
  augment = notify({
    destinations: opts.destinations as NotifyAugmentOptions["destinations"],
    rateLimit: opts.rateLimit as NotifyAugmentOptions["rateLimit"],
  });
  break;
}
```

- [ ] **Step 5: Add catalog entry + skill template**

In `augment-1/src/cli/augment-catalog.ts`, add a skill template constant near `ORG_CONTEXT_SKILL` (around line 104):

```typescript
const NOTIFY_SKILL = `---
name: notify
description: Send notifications to operator-defined destinations using the notify tool.
---

# Notify

You have a \`notify\` tool that sends messages to destinations the operator has configured.

## When to use

| Situation | Example |
|---|---|
| Visitor asks to speak with a human | \`notify({ to: "creator", summary: "Visitor wants partnership discussion", reason: "Outside my scope" })\` |
| You completed a long-running task | \`notify({ to: "creator", summary: "Daily report ready", reason: "End of day summary attached" })\` |
| Something needs human approval | \`notify({ to: "creator", summary: "Permission requested for X", reason: "Visitor requested Y" })\` |

Use named destinations from your agent's configuration. Common destinations: \`creator\` (the agent's owner), \`ops\` (operations channel), \`alerts\` (urgent issues).

## Tool surface

\`\`\`
notify({ to: "<destination-name>", summary: "...", reason?: "...", visitor?: "..." })
\`\`\`

Returns \`{ status: "sent" | "rate_limited" | "failed", message?: string }\`.

## Common mistakes

| Wrong | Correct |
|-------|---------|
| Sending raw chat IDs as \`to:\` | Use the destination NAME from config |
| Calling notify in a loop | Each call counts against rate limits |
| Calling notify for routine acknowledgments | Reserve for things needing operator awareness |
`;
```

Add the catalog entry at the end of the catalog array (after the `budgets` entry):

```typescript
{
  label: "notify",
  description: "Outbound messaging to operator-defined destinations (webhook + telegram adapters)",
  type: "notify",
  defaultName: "notify",
  defaultOptions: {
    destinations: [
      { name: "creator", transport: "webhook", url: "${ORG_NOTIFY_URL}" },
    ],
    rateLimit: {
      cooldownMs: 120_000,
      globalMaxPerHour: 5,
      dedupWindowMs: 300_000,
      dedupThreshold: 0.6,
      perPeerCooldownMs: 30_000,
    },
  },
  required: false,
  envVars: ["ORG_NOTIFY_URL"],
  hasSkill: true,
  skillTemplate: NOTIFY_SKILL,
},
```

- [ ] **Step 6: Run the full suite**

```bash
cd augment-1 && bun test && bunx tsc --noEmit
```
Expected: green; clean.

- [ ] **Step 7: Commit**

```bash
git add src/cli/config-parser.ts src/cli/augment-resolver.ts src/cli/augment-catalog.ts
git commit -m "feat(cli): wire notify augment into BUILTIN_TYPES + catalog

config-parser: BUILTIN_TYPES adds 'notify'; validateNotifyOptions enforces
non-empty destinations, unique destination names, per-transport required
fields, rate-limit field types.

augment-resolver: case 'notify' constructs the augment with destinations
and rateLimit from agent.yaml.

augment-catalog: catalog entry with default scaffold (one webhook destination
pointing at \${ORG_NOTIFY_URL}); NOTIFY_SKILL template scaffolded into the
agent's skills/ directory at create time.

Mirrors the budgets integration shape from item 5."
```

---

## Task T8: Notify integration test + Zip migration

**Files:**
- Create: `augment-1/tests/integration/notify.test.ts`
- Modify: `augment-1/zip/agent.yaml`
- Modify: `augment-1/zip/skills/identity/SKILL.md` (path subject to verification — see Step 4)

- [ ] **Step 1: Write the integration test**

In `augment-1/tests/integration/notify.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { defineAgent } from "../../src/agent";
import { notify } from "../../src/augments/notify";
import { fileMemory } from "../../src/augments/file-memory";
import { mockModel } from "../fixtures/mock-model";
import { tempDir } from "../fixtures/temp-dir";
import { writeFileSync } from "fs";
import { join } from "path";

describe("notify integration", () => {
  it("agent boots with notify mounted; tool surface visible", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "id.md"), "# Test agent");

    const agent = await defineAgent({
      identity: { name: "test", id: "aug1_test" },
      engine: mockModel({ replies: ["ok"] }),
      augments: [
        fileMemory({ label: "id", source: join(dir, "id.md"), origin: "operator" }),
        notify({
          destinations: [
            { name: "creator", transport: "webhook", url: "https://example.com/notify" },
          ],
        }),
      ],
    });

    const tools = await agent.listTools();
    expect(tools.find((t) => t.name === "notify")).toBeDefined();
  });

  it("agent boots without notify mounted; no notify tool", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "id.md"), "# Test agent");

    const agent = await defineAgent({
      identity: { name: "test", id: "aug1_test" },
      engine: mockModel({ replies: ["ok"] }),
      augments: [fileMemory({ label: "id", source: join(dir, "id.md"), origin: "operator" })],
    });

    const tools = await agent.listTools();
    expect(tools.find((t) => t.name === "notify")).toBeUndefined();
  });
});
```

(If `defineAgent` or `listTools` shapes differ from the assumptions above, mirror the patterns in existing `tests/integration/*.test.ts` files — the key checks are "augment mounts cleanly" and "tool registers with kernel.")

- [ ] **Step 2: Run the test to verify it passes**

```bash
cd augment-1 && bun test tests/integration/notify.test.ts
```
Expected: 2/2 passing.

- [ ] **Step 3: Update `zip/agent.yaml`**

The current file at `augment-1/zip/agent.yaml` (line 64–67) has:

```yaml
  - name: org
    type: orgContext
    options:
      baseUrl: ${ORG_CONTEXT_URL}
```

Append a `notify` mount after the `org` block:

```yaml
  - name: org
    type: orgContext
    options:
      baseUrl: ${ORG_CONTEXT_URL}
  - name: notify
    type: notify
    options:
      destinations:
        - name: creator
          transport: webhook
          url: ${ORG_CONTEXT_URL}/notify
      rateLimit:
        cooldownMs: 120000
        dedupWindowMs: 300000
        dedupThreshold: 0.6
        globalMaxPerHour: 5
        perPeerCooldownMs: 30000
```

This routes Zip's outbound through the same delegated path as today (POST to `${ORG_CONTEXT_URL}/notify`), preserving the bot-token-stays-in-agent-context-api secret hygiene. No env var changes required.

- [ ] **Step 4: Update Zip's identity skill**

Locate Zip's identity skill — search for `org_escalate` references:

```bash
cd augment-1 && grep -rln "org_escalate" zip/
```

Replace each `org_escalate({ ... })` reference with `notify({ to: "creator", ... })` in the skill markdown. The argument shape is the same (`summary`, `reason`, `visitor`) so the skill's example invocations should change minimally — typically just the tool name.

For each file returned, update inline. Example pattern:

Before:
```
Use org_escalate when a visitor's request is outside your scope:
\`\`\`
org_escalate({ summary: "Visitor wants partnership", reason: "Outside scope" })
\`\`\`
```

After:
```
Use notify({ to: "creator", ... }) when a visitor's request is outside your scope:
\`\`\`
notify({ to: "creator", summary: "Visitor wants partnership", reason: "Outside scope" })
\`\`\`
```

- [ ] **Step 5: Verify Zip's config parses**

```bash
cd augment-1 && bun run scripts/hello.ts || true   # quick sanity boot
```

Or simulate a parse-only check:

```bash
cd augment-1 && bunx aug1 status || bunx aug1 dev zip --dry-run 2>&1 | head -20
```

(If a `--dry-run` flag doesn't exist on `aug1 dev`, fall back to running `bun test` which exercises the config parser indirectly through any CLI tests.)

Expected: no parse errors mentioning `notify` or `destinations`.

- [ ] **Step 6: Commit (single commit covering integration test + Zip migration)**

```bash
git add tests/integration/notify.test.ts zip/agent.yaml zip/skills
git commit -m "feat(zip): migrate from org_escalate to notify

agent.yaml: mount notify with single 'creator' destination routing through
\${ORG_CONTEXT_URL}/notify webhook (preserves bot-token-stays-in-server
secret hygiene; no env var changes).

Identity skill: replace org_escalate examples with notify({to: 'creator', ...}).

Integration test confirms notify mounts cleanly and tool surface registers."
```

---

**Phase A is now shippable.** All Zip outbound paths use `notify` instead of `org_escalate`. `agent-context-api/notify` continues to forward to Telegram unchanged. No telegramTransport yet.

---

# Phase B — TelegramTransport (Polling + Webhook + Four Identity Paths)

Builds on the shared `src/telegram-client.ts` from T1. Adds bidirectional Telegram I/O. Independently mountable; coexists with `webTransport` via kernel multi-transport multiplexing.

---

## Task T9: TelegramTransport types

**Files:**
- Modify: `augment-1/src/types.ts`

- [ ] **Step 1: Add types alongside other transport options**

Append to `augment-1/src/types.ts`:

```typescript
// ---------------------------------------------------------------------------
// Telegram transport
// ---------------------------------------------------------------------------

export type TelegramInboundMode = "polling" | "webhook";

export interface TelegramPollingOptions {
  timeoutSec?: number;
}

export interface TelegramWebhookOptions {
  publicUrl: string;
  port?: number;
  secretToken: string;
  allowedUpdates?: string[];
}

export interface TelegramAdmittedAgent {
  id: string;
  telegramUserId: number;
}

export type TelegramAnonymousIdentityMode = "ephemeral" | "durable";

export interface TelegramAuthOptions {
  creatorUserIds?: number[];
  admittedAgents?: TelegramAdmittedAgent[];
  recognizedUserIds?: number[];
  /**
   * peer.id durability for anonymous Telegram peers. Default "ephemeral"
   * matches web's anonymous-ephemeral semantics — peer.id is `tg_anon_<threadId>`,
   * memory dies with thread. "durable" uses `tg_user_<userId>` for cross-session
   * recall; operators opt into this consciously.
   */
  anonymousIdentityMode?: TelegramAnonymousIdentityMode;
}

export interface TelegramTransportOptions {
  botToken: string;
  inbound: {
    mode: TelegramInboundMode;
    polling?: TelegramPollingOptions;
    webhook?: TelegramWebhookOptions;
  };
  auth: TelegramAuthOptions;
}
```

- [ ] **Step 2: Run typecheck**

```bash
cd augment-1 && bunx tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): TelegramTransportOptions + supporting types

inbound.mode: 'polling' | 'webhook' (mode-mutual-exclusion enforced at config
parse time — T16). auth.anonymousIdentityMode: 'ephemeral' (default) |
'durable' — opt-in for cross-session anonymous peer.id durability."
```

---

## Task T10: Identity resolver (all four paths + ephemeral/durable)

**Files:**
- Create: `augment-1/src/augments/telegram-transport.ts` (skeleton + identity resolver)
- Create: `augment-1/tests/augments/telegram-transport.test.ts`

This task creates the augment skeleton focused on identity resolution. Polling + webhook receive logic land in T12 and T14.

- [ ] **Step 1: Write failing tests for identity resolution**

In `augment-1/tests/augments/telegram-transport.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { resolveTelegramIdentity } from "../../src/augments/telegram-transport";
import type { TelegramAuthOptions } from "../../src/types";

const baseAuth: TelegramAuthOptions = {
  creatorUserIds: [12345678],
  admittedAgents: [{ id: "scheduler-bot", telegramUserId: 555444333 }],
  recognizedUserIds: [987654321],
  anonymousIdentityMode: "ephemeral",
};

describe("resolveTelegramIdentity", () => {
  it("creator user_id → creator trust level + tg_user_ peer.id", () => {
    const peer = resolveTelegramIdentity({ userId: 12345678, threadId: "thread-1" }, baseAuth);
    expect(peer.trustLevel).toBe("creator");
    expect(peer.id).toBe("tg_user_12345678");
    expect(peer.publicSubstate).toBeUndefined();
  });

  it("admittedAgents user_id → agent trust level + configured agent id", () => {
    const peer = resolveTelegramIdentity({ userId: 555444333, threadId: "thread-1" }, baseAuth);
    expect(peer.trustLevel).toBe("agent");
    expect(peer.id).toBe("scheduler-bot");
  });

  it("recognized user_id → public/recognized + tg_user_ peer.id", () => {
    const peer = resolveTelegramIdentity({ userId: 987654321, threadId: "thread-1" }, baseAuth);
    expect(peer.trustLevel).toBe("public");
    expect(peer.publicSubstate).toBe("recognized");
    expect(peer.id).toBe("tg_user_987654321");
  });

  it("unknown user with ephemeral mode → public/anonymous + tg_anon_<threadId>", () => {
    const peer = resolveTelegramIdentity({ userId: 99, threadId: "thread-1" }, baseAuth);
    expect(peer.trustLevel).toBe("public");
    expect(peer.publicSubstate).toBe("anonymous");
    expect(peer.id).toBe("tg_anon_thread-1");
  });

  it("unknown user with durable mode → public/anonymous + tg_user_<userId>", () => {
    const peer = resolveTelegramIdentity({ userId: 99, threadId: "thread-1" }, { ...baseAuth, anonymousIdentityMode: "durable" });
    expect(peer.trustLevel).toBe("public");
    expect(peer.publicSubstate).toBe("anonymous");
    expect(peer.id).toBe("tg_user_99");
  });

  it("anonymousIdentityMode defaults to ephemeral when omitted", () => {
    const peer = resolveTelegramIdentity({ userId: 99, threadId: "thread-1" }, { ...baseAuth, anonymousIdentityMode: undefined });
    expect(peer.id).toBe("tg_anon_thread-1");
  });

  it("two anonymous DMs from same user with ephemeral → distinct peer.ids per thread", () => {
    const a = resolveTelegramIdentity({ userId: 99, threadId: "thread-A" }, baseAuth);
    const b = resolveTelegramIdentity({ userId: 99, threadId: "thread-B" }, baseAuth);
    expect(a.id).not.toBe(b.id);
  });

  it("two anonymous DMs from same user with durable → same peer.id across threads", () => {
    const opts: TelegramAuthOptions = { ...baseAuth, anonymousIdentityMode: "durable" };
    const a = resolveTelegramIdentity({ userId: 99, threadId: "thread-A" }, opts);
    const b = resolveTelegramIdentity({ userId: 99, threadId: "thread-B" }, opts);
    expect(a.id).toBe(b.id);
  });

  it("admittedAgents takes precedence over creator if both match", () => {
    const opts: TelegramAuthOptions = {
      creatorUserIds: [555],
      admittedAgents: [{ id: "agent-bot", telegramUserId: 555 }],
    };
    const peer = resolveTelegramIdentity({ userId: 555, threadId: "t" }, opts);
    expect(peer.trustLevel).toBe("creator");
    // creator path wins by spec ordering — verify ordering matches item 5's web-transport
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd augment-1 && bun test tests/augments/telegram-transport.test.ts
```
Expected: FAIL — `resolveTelegramIdentity` not exported.

- [ ] **Step 3: Implement the resolver**

Create `augment-1/src/augments/telegram-transport.ts`:

```typescript
/**
 * Telegram transport augment — bidirectional Telegram I/O.
 *
 * Inbound: polling (T12) or webhook (T14) modes. Both feed updates through
 * resolveTelegramIdentity to resolve peer identity per the four-path model
 * from item 5's spec.
 *
 * Outbound: replies to the current peer's chat via sendMessage. Outbound to
 * non-current-peer destinations is notify's job, not this transport's.
 *
 * Uses src/telegram-client.ts as a shared utility — no cross-augment coupling.
 */

import type {
  Augment,
  PeerIdentity,
  TelegramAuthOptions,
  TelegramTransportOptions,
} from "../types";

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

export interface ResolveIdentityInput {
  userId: number;
  threadId: string;
}

export function resolveTelegramIdentity(
  input: ResolveIdentityInput,
  auth: TelegramAuthOptions,
): PeerIdentity {
  const { userId, threadId } = input;
  const mode = auth.anonymousIdentityMode ?? "ephemeral";

  // Order matches item 5's web-transport: creator → agent → recognized → anonymous.
  if (auth.creatorUserIds?.includes(userId)) {
    return {
      id: `tg_user_${userId}`,
      kind: "human",
      trustLevel: "creator",
      sourceAugment: "telegram-transport",
    };
  }

  const admitted = auth.admittedAgents?.find((a) => a.telegramUserId === userId);
  if (admitted) {
    return {
      id: admitted.id,
      kind: "agent",
      trustLevel: "agent",
      sourceAugment: "telegram-transport",
    };
  }

  if (auth.recognizedUserIds?.includes(userId)) {
    return {
      id: `tg_user_${userId}`,
      kind: "human",
      trustLevel: "public",
      publicSubstate: "recognized",
      sourceAugment: "telegram-transport",
    };
  }

  // Default: public-anonymous with mode-driven peer.id shape.
  return {
    id: mode === "durable" ? `tg_user_${userId}` : `tg_anon_${threadId}`,
    kind: "human",
    trustLevel: "public",
    publicSubstate: "anonymous",
    sourceAugment: "telegram-transport",
  };
}

// ---------------------------------------------------------------------------
// Augment factory (skeleton — receive logic in T12 / T14)
// ---------------------------------------------------------------------------

export function telegramTransport(opts: TelegramTransportOptions): Augment {
  return {
    name: "telegram-transport",
    capabilities: ["transport"],
    // Lifecycle implementation (onBoot, onShutdown), polling/webhook receive
    // wiring, and reply path land in subsequent tasks (T11–T15).
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd augment-1 && bun test tests/augments/telegram-transport.test.ts
```
Expected: 9/9 passing.

- [ ] **Step 5: Commit**

```bash
git add src/augments/telegram-transport.ts tests/augments/telegram-transport.test.ts
git commit -m "feat(telegram-transport): identity resolver + augment skeleton

Four-path identity resolution (creator + agent + recognized + anonymous).
anonymousIdentityMode defaults to 'ephemeral' (peer.id = tg_anon_<threadId>);
operators opt into 'durable' (peer.id = tg_user_<userId>) for cross-session
recall. Order matches web-transport: creator → agent → recognized → anonymous.

Lifecycle and receive wiring land in subsequent tasks."
```

---

## Task T11: Boot-time `admittedAgents` validation

**Files:**
- Modify: `augment-1/src/augments/telegram-transport.ts`
- Modify: `augment-1/tests/augments/telegram-transport.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `augment-1/tests/augments/telegram-transport.test.ts`:

```typescript
import { validateAdmittedAgents } from "../../src/augments/telegram-transport";
import type { TelegramBotClient } from "../../src/telegram-client";

function mockClient(behavior: Record<number, "ok" | "fail">): TelegramBotClient {
  return {
    sendMessage: async (cId) => ({ messageId: 1, chatId: cId }),
    getUpdates: async () => [],
    setWebhook: async () => {},
    deleteWebhook: async () => {},
    getChat: async (chatId) => {
      const id = Number(chatId);
      if (behavior[id] === "ok") return { id, type: "private", first_name: "Agent" };
      throw new Error("user not found");
    },
  };
}

describe("validateAdmittedAgents", () => {
  it("logs info for each admittedAgent that resolves successfully", async () => {
    const logs: string[] = [];
    const log = { info: (msg: string) => logs.push(`info: ${msg}`), warn: (msg: string) => logs.push(`warn: ${msg}`) };
    await validateAdmittedAgents(
      [{ id: "scheduler", telegramUserId: 100 }, { id: "billing", telegramUserId: 200 }],
      mockClient({ 100: "ok", 200: "ok" }),
      log,
    );
    expect(logs.filter((l) => l.startsWith("info"))).toHaveLength(2);
  });

  it("logs warning for each admittedAgent that fails to resolve, naming id and telegramUserId", async () => {
    const logs: string[] = [];
    const log = { info: () => {}, warn: (msg: string) => logs.push(msg) };
    await validateAdmittedAgents(
      [{ id: "scheduler", telegramUserId: 100 }, { id: "typo-bot", telegramUserId: 999 }],
      mockClient({ 100: "ok", 999: "fail" }),
      log,
    );
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("typo-bot");
    expect(logs[0]).toContain("999");
  });

  it("does nothing if admittedAgents is empty or undefined", async () => {
    const logs: string[] = [];
    const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };
    await validateAdmittedAgents(undefined, mockClient({}), log);
    await validateAdmittedAgents([], mockClient({}), log);
    expect(logs).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd augment-1 && bun test tests/augments/telegram-transport.test.ts
```
Expected: FAIL — `validateAdmittedAgents` not exported.

- [ ] **Step 3: Add the implementation**

In `augment-1/src/augments/telegram-transport.ts`, add:

```typescript
import type { TelegramBotClient } from "../telegram-client";

export interface BootLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export async function validateAdmittedAgents(
  admittedAgents: Array<{ id: string; telegramUserId: number }> | undefined,
  client: TelegramBotClient,
  log: BootLogger = console,
): Promise<void> {
  if (!admittedAgents || admittedAgents.length === 0) return;
  for (const agent of admittedAgents) {
    try {
      await client.getChat(agent.telegramUserId);
      log.info(`[telegram-transport] admittedAgent "${agent.id}" (telegramUserId=${agent.telegramUserId}) resolved successfully`);
    } catch (err) {
      log.warn(
        `[telegram-transport] admittedAgent "${agent.id}" (telegramUserId=${agent.telegramUserId}) failed boot-time validation: ${(err as Error).message}. Real agent traffic from this user_id will be silently demoted to public-anonymous. Verify the user_id is correct and the bot has access to message that user.`,
      );
    }
  }
}
```

- [ ] **Step 4: Run tests to pass**

```bash
cd augment-1 && bun test tests/augments/telegram-transport.test.ts
```
Expected: 12/12 passing (9 from T10 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/augments/telegram-transport.ts tests/augments/telegram-transport.test.ts
git commit -m "feat(telegram-transport): boot-time admittedAgents validation

Calls getChat(userId) for each configured agent on boot. Failed resolution
logs explicit warning naming both the configured id and the telegramUserId,
flagging that real agent traffic will be silently demoted to public-anonymous.
Advisory only — boot continues."
```

---

## Task T12: Polling-mode receiver

**Files:**
- Create: `augment-1/src/augments/telegram-transport/polling.ts`
- Create: `augment-1/tests/augments/telegram-transport/polling.test.ts`

- [ ] **Step 1: Write failing tests**

In `augment-1/tests/augments/telegram-transport/polling.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { runPollLoop, type PollLoopHandle } from "../../../src/augments/telegram-transport/polling";
import type { TelegramBotClient, TelegramUpdate } from "../../../src/telegram-client";

function mockClient(updateBatches: TelegramUpdate[][]): { client: TelegramBotClient; getCalls: Array<{ offset?: number }> } {
  const calls: Array<{ offset?: number }> = [];
  let batchIndex = 0;
  const client: TelegramBotClient = {
    sendMessage: async (cId) => ({ messageId: 1, chatId: cId }),
    getUpdates: async (opts) => {
      calls.push({ offset: opts.offset });
      const batch = updateBatches[batchIndex] ?? [];
      batchIndex++;
      return batch;
    },
    setWebhook: async () => {},
    deleteWebhook: async () => {},
    getChat: async (chatId) => ({ id: Number(chatId), type: "private" }),
  };
  return { client, getCalls: calls };
}

describe("runPollLoop", () => {
  it("calls onUpdate for each update returned", async () => {
    const updates: TelegramUpdate[] = [
      { update_id: 1, message: { message_id: 1, chat: { id: 100, type: "private" }, date: 0, text: "hi" } },
      { update_id: 2, message: { message_id: 2, chat: { id: 200, type: "private" }, date: 0, text: "hello" } },
    ];
    const { client } = mockClient([updates, []]);
    const received: TelegramUpdate[] = [];
    let handle: PollLoopHandle | null = null;
    handle = runPollLoop({
      client,
      timeoutSec: 1,
      onUpdate: (u) => { received.push(u); if (received.length === 2) handle!.stop(); },
    });
    await handle.done;
    expect(received).toEqual(updates);
  });

  it("uses returned update_id+1 as next offset", async () => {
    const updates: TelegramUpdate[] = [{ update_id: 42, message: { message_id: 1, chat: { id: 100, type: "private" }, date: 0, text: "hi" } }];
    const { client, getCalls } = mockClient([updates, []]);
    let handle: PollLoopHandle | null = null;
    let count = 0;
    handle = runPollLoop({
      client,
      timeoutSec: 1,
      onUpdate: () => { count++; if (count === 1) handle!.stop(); },
    });
    await handle.done;
    expect(getCalls[0]?.offset).toBeUndefined(); // first call has no offset
    expect(getCalls[1]?.offset).toBe(43); // second call uses 42+1
  });

  it("handles error and continues with backoff", async () => {
    let throwOnce = true;
    const client: TelegramBotClient = {
      sendMessage: async (c) => ({ messageId: 1, chatId: c }),
      getUpdates: async () => {
        if (throwOnce) { throwOnce = false; throw new Error("net"); }
        return [];
      },
      setWebhook: async () => {},
      deleteWebhook: async () => {},
      getChat: async (chatId) => ({ id: Number(chatId), type: "private" }),
    };
    const handle = runPollLoop({ client, timeoutSec: 0, onUpdate: () => {}, errorBackoffMs: 10 });
    await new Promise((r) => setTimeout(r, 50));
    handle.stop();
    await handle.done;
    expect(throwOnce).toBe(false); // proves we got past the throw
  });

  it("stops cleanly when handle.stop() called", async () => {
    const { client } = mockClient([[], [], []]);
    const handle = runPollLoop({ client, timeoutSec: 0, onUpdate: () => {} });
    handle.stop();
    await handle.done;
    // No assertion error — stop() resolves done.
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd augment-1 && bun test tests/augments/telegram-transport/polling.test.ts
```
Expected: FAIL — `runPollLoop` not exported.

- [ ] **Step 3: Implement the polling loop**

Create `augment-1/src/augments/telegram-transport/polling.ts`:

```typescript
import type { TelegramBotClient, TelegramUpdate } from "../../telegram-client";

export interface PollLoopOptions {
  client: TelegramBotClient;
  timeoutSec?: number;
  onUpdate: (update: TelegramUpdate) => void | Promise<void>;
  errorBackoffMs?: number;
  log?: { warn: (msg: string) => void };
}

export interface PollLoopHandle {
  stop(): void;
  done: Promise<void>;
}

export function runPollLoop(opts: PollLoopOptions): PollLoopHandle {
  const timeoutSec = opts.timeoutSec ?? 30;
  const errorBackoffMs = opts.errorBackoffMs ?? 5000;
  const log = opts.log ?? console;

  let stopped = false;
  let nextOffset: number | undefined;

  const done = (async () => {
    while (!stopped) {
      try {
        const updates = await opts.client.getUpdates({ offset: nextOffset, timeoutSec });
        for (const update of updates) {
          if (stopped) break;
          await opts.onUpdate(update);
          nextOffset = update.update_id + 1;
        }
      } catch (err) {
        log.warn(`[telegram-transport.polling] getUpdates error: ${(err as Error).message} — retrying in ${errorBackoffMs}ms`);
        await new Promise((r) => setTimeout(r, errorBackoffMs));
      }
    }
  })();

  return {
    stop() { stopped = true; },
    done,
  };
}
```

- [ ] **Step 4: Run tests to pass**

```bash
cd augment-1 && bun test tests/augments/telegram-transport/polling.test.ts
```
Expected: 4/4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/augments/telegram-transport/polling.ts tests/augments/telegram-transport/polling.test.ts
git commit -m "feat(telegram-transport): polling-mode receiver

Long-poll loop calling getUpdates(offset, timeoutSec). Tracks offset as
last_update_id + 1 to avoid re-processing. On API error, logs warning and
backs off (default 5s) before retrying. Handle.stop() cleanly halts the
loop and resolves done."
```

---

## Task T13: Webhook-mode receiver + secret validation

**Files:**
- Create: `augment-1/src/augments/telegram-transport/webhook.ts`
- Create: `augment-1/tests/augments/telegram-transport/webhook.test.ts`

- [ ] **Step 1: Write failing tests**

In `augment-1/tests/augments/telegram-transport/webhook.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { startWebhookServer } from "../../../src/augments/telegram-transport/webhook";
import type { TelegramUpdate } from "../../../src/telegram-client";

function freePort(): number {
  // Quick way: pick random in 30000-40000. Tests run sequentially in bun:test so collisions rare.
  return 30000 + Math.floor(Math.random() * 9999);
}

describe("startWebhookServer", () => {
  it("accepts POST with valid secret-token header and dispatches onUpdate", async () => {
    const port = freePort();
    const received: TelegramUpdate[] = [];
    const server = await startWebhookServer({
      port,
      secretToken: "VALID",
      onUpdate: (u) => { received.push(u); },
    });
    const update = { update_id: 1, message: { message_id: 1, chat: { id: 99, type: "private" }, date: 0, text: "hi" } };
    const res = await fetch(`http://localhost:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "VALID" },
      body: JSON.stringify(update),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(1);
    expect(received[0]?.update_id).toBe(1);
    server.stop();
  });

  it("rejects POST with missing secret-token → 401, no onUpdate", async () => {
    const port = freePort();
    const received: TelegramUpdate[] = [];
    const server = await startWebhookServer({
      port,
      secretToken: "VALID",
      onUpdate: (u) => { received.push(u); },
    });
    const res = await fetch(`http://localhost:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(res.status).toBe(401);
    expect(received).toHaveLength(0);
    server.stop();
  });

  it("rejects POST with wrong secret-token → 401, no onUpdate", async () => {
    const port = freePort();
    const received: TelegramUpdate[] = [];
    const server = await startWebhookServer({
      port,
      secretToken: "VALID",
      onUpdate: (u) => { received.push(u); },
    });
    const res = await fetch(`http://localhost:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "WRONG" },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(res.status).toBe(401);
    expect(received).toHaveLength(0);
    server.stop();
  });

  it("rejects non-POST methods", async () => {
    const port = freePort();
    const server = await startWebhookServer({ port, secretToken: "X", onUpdate: () => {} });
    const res = await fetch(`http://localhost:${port}/`, { method: "GET" });
    expect(res.status).toBe(405);
    server.stop();
  });

  it("rejects malformed JSON", async () => {
    const port = freePort();
    const server = await startWebhookServer({ port, secretToken: "X", onUpdate: () => {} });
    const res = await fetch(`http://localhost:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "X" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    server.stop();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd augment-1 && bun test tests/augments/telegram-transport/webhook.test.ts
```
Expected: FAIL — `startWebhookServer` not exported.

- [ ] **Step 3: Implement the webhook server**

Create `augment-1/src/augments/telegram-transport/webhook.ts`:

```typescript
import { timingSafeEqual } from "node:crypto";
import type { TelegramUpdate } from "../../telegram-client";

export interface WebhookServerOptions {
  port: number;
  secretToken: string;
  onUpdate: (update: TelegramUpdate) => void | Promise<void>;
  log?: { warn: (msg: string) => void };
}

export interface WebhookServerHandle {
  stop(): void;
}

export async function startWebhookServer(opts: WebhookServerOptions): Promise<WebhookServerHandle> {
  const log = opts.log ?? console;
  const expected = Buffer.from(opts.secretToken, "utf8");

  function safeCompare(provided: string | null): boolean {
    if (provided == null) return false;
    const providedBuf = Buffer.from(provided, "utf8");
    if (providedBuf.length !== expected.length) return false;
    return timingSafeEqual(providedBuf, expected);
  }

  const server = Bun.serve({
    port: opts.port,
    async fetch(req: Request): Promise<Response> {
      if (req.method !== "POST") {
        return new Response(null, { status: 405 });
      }
      const provided = req.headers.get("x-telegram-bot-api-secret-token");
      if (!safeCompare(provided)) {
        return new Response(null, { status: 401 });
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return new Response(null, { status: 400 });
      }
      try {
        await opts.onUpdate(body as TelegramUpdate);
      } catch (err) {
        log.warn(`[telegram-transport.webhook] onUpdate threw: ${(err as Error).message}`);
      }
      return new Response(null, { status: 200 });
    },
  });

  return {
    stop() { server.stop(true); },
  };
}
```

- [ ] **Step 4: Run tests to pass**

```bash
cd augment-1 && bun test tests/augments/telegram-transport/webhook.test.ts
```
Expected: 5/5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/augments/telegram-transport/webhook.ts tests/augments/telegram-transport/webhook.test.ts
git commit -m "feat(telegram-transport): webhook-mode receiver

Bun.serve()-backed HTTP server. Validates X-Telegram-Bot-Api-Secret-Token
header via node:crypto.timingSafeEqual (constant-time compare; not ===).
Mismatched/missing → 401 no body so Telegram doesn't retry. Non-POST → 405.
Malformed JSON → 400. Server.stop() halts cleanly."
```

---

## Task T14: Wire receivers into the augment + reply path

**Files:**
- Modify: `augment-1/src/augments/telegram-transport.ts`
- Modify: `augment-1/tests/augments/telegram-transport.test.ts`

- [ ] **Step 1: Add failing integration-style tests for the augment lifecycle**

Append to `augment-1/tests/augments/telegram-transport.test.ts`:

```typescript
import { telegramTransport } from "../../src/augments/telegram-transport";
import type { TelegramBotClient, TelegramUpdate } from "../../src/telegram-client";

function makeMockClient(updates: TelegramUpdate[]) {
  const sent: Array<{ chatId: number | string; text: string }> = [];
  const client: TelegramBotClient = {
    sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { messageId: 1, chatId }; },
    getUpdates: async () => { const batch = updates.shift() ?? []; return batch as any; },
    setWebhook: async () => {},
    deleteWebhook: async () => {},
    getChat: async (chatId) => ({ id: Number(chatId), type: "private" }),
  };
  return { client, sent };
}

describe("telegramTransport — polling lifecycle", () => {
  it("starts polling on boot; dispatches turn for each text update", async () => {
    const updates: TelegramUpdate[] = [
      { update_id: 1, message: { message_id: 1, chat: { id: 100, type: "private" }, from: { id: 100, is_bot: false }, date: 0, text: "hello" } },
    ];
    const { client } = makeMockClient([updates, []]);
    const dispatched: any[] = [];
    const aug = telegramTransport({
      botToken: "T",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: { creatorUserIds: [100] },
      // Test-only override:
      _clientFactory: () => client,
      _dispatchTurn: (input, peer) => { dispatched.push({ input, peer }); },
    } as any);
    await aug.onBoot?.({} as any);
    await new Promise((r) => setTimeout(r, 30));
    await aug.onShutdown?.({} as any);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].peer.trustLevel).toBe("creator");
  });

  it("inbound text triggers reply via sendMessage to original chat_id", async () => {
    const updates: TelegramUpdate[] = [
      { update_id: 1, message: { message_id: 1, chat: { id: 555, type: "private" }, from: { id: 555, is_bot: false }, date: 0, text: "hi" } },
    ];
    const { client, sent } = makeMockClient([updates, []]);
    const aug = telegramTransport({
      botToken: "T",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: { anonymousIdentityMode: "ephemeral" },
      _clientFactory: () => client,
      _dispatchTurn: async (input, peer, replyFn) => { await replyFn("response text"); },
    } as any);
    await aug.onBoot?.({} as any);
    await new Promise((r) => setTimeout(r, 30));
    await aug.onShutdown?.({} as any);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe(555);
    expect(sent[0]?.text).toBe("response text");
  });

  it("ignores updates with no text", async () => {
    const updates: TelegramUpdate[] = [{ update_id: 1, message: { message_id: 1, chat: { id: 1, type: "private" }, date: 0 } }];
    const { client } = makeMockClient([updates, []]);
    const dispatched: any[] = [];
    const aug = telegramTransport({
      botToken: "T",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: {},
      _clientFactory: () => client,
      _dispatchTurn: (i: any, p: any) => { dispatched.push({ i, p }); },
    } as any);
    await aug.onBoot?.({} as any);
    await new Promise((r) => setTimeout(r, 30));
    await aug.onShutdown?.({} as any);
    expect(dispatched).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd augment-1 && bun test tests/augments/telegram-transport.test.ts
```
Expected: FAIL — augment skeleton doesn't have lifecycle wired.

- [ ] **Step 3: Wire the receivers into the augment factory**

In `augment-1/src/augments/telegram-transport.ts`, replace the skeleton `telegramTransport` factory with:

```typescript
import { createTelegramBotClient } from "../telegram-client";
import { runPollLoop, type PollLoopHandle } from "./telegram-transport/polling";
import { startWebhookServer, type WebhookServerHandle } from "./telegram-transport/webhook";
import type { TelegramUpdate, TelegramBotClient } from "../telegram-client";

// Internal hooks to enable testing without a real kernel context.
interface InternalOptions extends TelegramTransportOptions {
  _clientFactory?: () => TelegramBotClient;
  _dispatchTurn?: (
    input: { text: string; chatId: number | string; threadId: string; messageId: number },
    peer: PeerIdentity,
    reply: (text: string) => Promise<void>,
  ) => Promise<void> | void;
}

export function telegramTransport(opts: TelegramTransportOptions): Augment {
  const internal = opts as InternalOptions;
  const clientFactory = internal._clientFactory ?? (() => createTelegramBotClient({ botToken: opts.botToken }));
  const client = clientFactory();

  let pollHandle: PollLoopHandle | null = null;
  let webhookHandle: WebhookServerHandle | null = null;

  async function handleUpdate(update: TelegramUpdate, dispatchTurn: NonNullable<InternalOptions["_dispatchTurn"]>): Promise<void> {
    if (!update.message?.text || !update.message.from) return;
    const userId = update.message.from.id;
    const chatId = update.message.chat.id;
    const threadId = `tg-chat-${chatId}`;
    const peer = resolveTelegramIdentity({ userId, threadId }, opts.auth);
    const reply = async (text: string) => { await client.sendMessage(chatId, text); };
    await dispatchTurn(
      { text: update.message.text, chatId, threadId, messageId: update.message.message_id },
      peer,
      reply,
    );
  }

  return {
    name: "telegram-transport",
    capabilities: ["transport"],
    onBoot: async (ctx: any) => {
      // Production dispatch comes from kernel ctx; tests pass _dispatchTurn directly.
      const dispatch = internal._dispatchTurn ?? ((input, peer, reply) => ctx.dispatchTurn?.(input, peer, reply));
      await validateAdmittedAgents(opts.auth.admittedAgents, client);

      if (opts.inbound.mode === "polling") {
        pollHandle = runPollLoop({
          client,
          timeoutSec: opts.inbound.polling?.timeoutSec ?? 30,
          onUpdate: (u) => handleUpdate(u, dispatch),
        });
      } else if (opts.inbound.mode === "webhook") {
        if (!opts.inbound.webhook) throw new Error("[telegram-transport] inbound.mode === 'webhook' requires inbound.webhook config");
        await client.setWebhook(opts.inbound.webhook.publicUrl, opts.inbound.webhook.secretToken, {
          allowedUpdates: opts.inbound.webhook.allowedUpdates,
        });
        webhookHandle = await startWebhookServer({
          port: opts.inbound.webhook.port ?? 8081,
          secretToken: opts.inbound.webhook.secretToken,
          onUpdate: (u) => handleUpdate(u, dispatch),
        });
      } else {
        throw new Error(`[telegram-transport] inbound.mode must be 'polling' or 'webhook' (got ${(opts.inbound as any).mode})`);
      }
    },
    onShutdown: async () => {
      if (pollHandle) {
        pollHandle.stop();
        await pollHandle.done;
        pollHandle = null;
      }
      if (webhookHandle) {
        webhookHandle.stop();
        webhookHandle = null;
        try { await client.deleteWebhook(); } catch (err) {
          console.warn(`[telegram-transport] deleteWebhook on shutdown failed: ${(err as Error).message}`);
        }
      }
    },
  };
}
```

NOTE: The `dispatchTurn` interface to the kernel is sketched here. If the actual kernel transport contract differs, mirror what `webTransport` does — the lifecycle hooks and call sites are the same shape.

- [ ] **Step 4: Run tests**

```bash
cd augment-1 && bun test tests/augments/telegram-transport.test.ts tests/augments/telegram-transport
```
Expected: all telegram-transport tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/augments/telegram-transport.ts tests/augments/telegram-transport.test.ts
git commit -m "feat(telegram-transport): lifecycle wiring + reply path

onBoot: validateAdmittedAgents → start polling OR setWebhook+startWebhookServer
based on inbound.mode. onShutdown: stop poll/webhook handle, deleteWebhook on
webhook mode.

Reply path: handleUpdate resolves peer identity, calls kernel-provided
dispatchTurn with a reply closure that calls client.sendMessage(chatId, text)."
```

---

## Task T15: Mode-mutual-exclusion config validation

**Files:**
- Modify: `augment-1/src/cli/config-parser.ts`
- Create test in: `augment-1/tests/cli/config-parser.telegram-transport.test.ts` (or extend an existing config-parser test file if one exists)

- [ ] **Step 1: Write failing tests**

In `augment-1/tests/cli/config-parser.telegram-transport.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { parseConfigText } from "../../src/cli/config-parser"; // adjust import to actual exported parse function

const baseAgent = `
id: aug1_test
name: test
engine:
  provider: anthropic
  model: claude-sonnet-4-6
augments:
`;

describe("telegramTransport config validation", () => {
  it("accepts polling mode with timeoutSec", () => {
    const yaml = baseAgent + `
  - name: tg
    type: telegramTransport
    options:
      botToken: TOKEN
      inbound:
        mode: polling
        polling: { timeoutSec: 30 }
      auth:
        creatorUserIds: [123]
`;
    const result = parseConfigText(yaml);
    expect(result.errors).toEqual([]);
  });

  it("accepts webhook mode with publicUrl + secretToken", () => {
    const yaml = baseAgent + `
  - name: tg
    type: telegramTransport
    options:
      botToken: TOKEN
      inbound:
        mode: webhook
        webhook:
          publicUrl: https://example.com/hook
          port: 8081
          secretToken: SECRET
      auth: {}
`;
    const result = parseConfigText(yaml);
    expect(result.errors).toEqual([]);
  });

  it("rejects webhook mode missing publicUrl", () => {
    const yaml = baseAgent + `
  - name: tg
    type: telegramTransport
    options:
      botToken: TOKEN
      inbound:
        mode: webhook
        webhook:
          secretToken: SECRET
      auth: {}
`;
    const result = parseConfigText(yaml);
    expect(result.errors.some((e) => e.includes("publicUrl"))).toBe(true);
  });

  it("rejects webhook mode missing secretToken", () => {
    const yaml = baseAgent + `
  - name: tg
    type: telegramTransport
    options:
      botToken: TOKEN
      inbound:
        mode: webhook
        webhook: { publicUrl: https://example.com/hook }
      auth: {}
`;
    const result = parseConfigText(yaml);
    expect(result.errors.some((e) => e.includes("secretToken"))).toBe(true);
  });

  it("rejects unknown inbound.mode value", () => {
    const yaml = baseAgent + `
  - name: tg
    type: telegramTransport
    options:
      botToken: TOKEN
      inbound: { mode: smtp }
      auth: {}
`;
    const result = parseConfigText(yaml);
    expect(result.errors.some((e) => e.includes("mode"))).toBe(true);
  });

  it("rejects missing botToken", () => {
    const yaml = baseAgent + `
  - name: tg
    type: telegramTransport
    options:
      inbound: { mode: polling }
      auth: {}
`;
    const result = parseConfigText(yaml);
    expect(result.errors.some((e) => e.includes("botToken"))).toBe(true);
  });

  it("rejects invalid anonymousIdentityMode value", () => {
    const yaml = baseAgent + `
  - name: tg
    type: telegramTransport
    options:
      botToken: TOKEN
      inbound: { mode: polling }
      auth: { anonymousIdentityMode: weird }
`;
    const result = parseConfigText(yaml);
    expect(result.errors.some((e) => e.includes("anonymousIdentityMode"))).toBe(true);
  });
});
```

(If the parser's exported function is named differently, adjust the import. The pattern follows existing CLI tests in `augment-1/tests/cli/`.)

- [ ] **Step 2: Add `telegramTransport` to BUILTIN_TYPES**

In `augment-1/src/cli/config-parser.ts`, update `BUILTIN_TYPES`:

```typescript
const BUILTIN_TYPES = new Set([
  "fileMemory",
  "supabaseMemory",
  "layeredMemory",
  "filesystem",
  "webTransport",
  "webFetch",
  "orgContext",
  "bash",
  "budgets",
  "notify",
  "telegramTransport",
]);
```

- [ ] **Step 3: Add `validateTelegramTransportOptions`**

In the same file, add:

```typescript
function validateTelegramTransportOptions(
  opts: Record<string, unknown>,
  prefix: string,
  errors: string[],
): void {
  if (typeof opts.botToken !== "string" || !opts.botToken) {
    errors.push(`${prefix}.botToken: required string`);
  }

  const inbound = opts.inbound as Record<string, unknown> | undefined;
  if (!inbound || typeof inbound !== "object") {
    errors.push(`${prefix}.inbound: required object`);
    return;
  }
  const mode = inbound.mode;
  if (mode !== "polling" && mode !== "webhook") {
    errors.push(`${prefix}.inbound.mode: must be "polling" or "webhook"`);
  } else if (mode === "polling") {
    if (inbound.polling !== undefined) {
      const polling = inbound.polling as Record<string, unknown>;
      if (polling.timeoutSec !== undefined && (typeof polling.timeoutSec !== "number" || polling.timeoutSec <= 0)) {
        errors.push(`${prefix}.inbound.polling.timeoutSec: must be a positive number`);
      }
    }
    if (inbound.webhook !== undefined) {
      errors.push(`${prefix}.inbound: cannot set webhook block when mode is "polling"`);
    }
  } else if (mode === "webhook") {
    if (inbound.polling !== undefined) {
      errors.push(`${prefix}.inbound: cannot set polling block when mode is "webhook"`);
    }
    const webhook = inbound.webhook as Record<string, unknown> | undefined;
    if (!webhook || typeof webhook !== "object") {
      errors.push(`${prefix}.inbound.webhook: required object when mode is "webhook"`);
    } else {
      if (typeof webhook.publicUrl !== "string" || !webhook.publicUrl) {
        errors.push(`${prefix}.inbound.webhook.publicUrl: required string`);
      }
      if (typeof webhook.secretToken !== "string" || !webhook.secretToken) {
        errors.push(`${prefix}.inbound.webhook.secretToken: required string`);
      }
      if (webhook.port !== undefined && (typeof webhook.port !== "number" || webhook.port <= 0 || webhook.port > 65535)) {
        errors.push(`${prefix}.inbound.webhook.port: must be a positive number ≤ 65535`);
      }
    }
  }

  const auth = opts.auth as Record<string, unknown> | undefined;
  if (auth !== undefined && typeof auth === "object") {
    if (auth.creatorUserIds !== undefined && !Array.isArray(auth.creatorUserIds)) {
      errors.push(`${prefix}.auth.creatorUserIds: must be an array of numbers`);
    }
    if (auth.recognizedUserIds !== undefined && !Array.isArray(auth.recognizedUserIds)) {
      errors.push(`${prefix}.auth.recognizedUserIds: must be an array of numbers`);
    }
    if (auth.admittedAgents !== undefined) {
      if (!Array.isArray(auth.admittedAgents)) {
        errors.push(`${prefix}.auth.admittedAgents: must be an array`);
      } else {
        for (let i = 0; i < auth.admittedAgents.length; i++) {
          const a = auth.admittedAgents[i] as Record<string, unknown>;
          if (typeof a.id !== "string" || !a.id) errors.push(`${prefix}.auth.admittedAgents[${i}].id: required string`);
          if (typeof a.telegramUserId !== "number") errors.push(`${prefix}.auth.admittedAgents[${i}].telegramUserId: required number`);
        }
      }
    }
    if (auth.anonymousIdentityMode !== undefined && auth.anonymousIdentityMode !== "ephemeral" && auth.anonymousIdentityMode !== "durable") {
      errors.push(`${prefix}.auth.anonymousIdentityMode: must be "ephemeral" or "durable"`);
    }
  }
}
```

- [ ] **Step 4: Wire the validator into the augment-validation switch**

In the augment-type validation block (around line 425), add another `else if`:

```typescript
} else if (aug.type === "notify") {
  validateNotifyOptions(aug.options ?? {}, `${prefix}.options`, errors);
} else if (aug.type === "telegramTransport") {
  validateTelegramTransportOptions(aug.options ?? {}, `${prefix}.options`, errors);
}
```

- [ ] **Step 5: Run tests**

```bash
cd augment-1 && bun test tests/cli/config-parser.telegram-transport.test.ts
```
Expected: 7/7 passing.

- [ ] **Step 6: Commit**

```bash
git add src/cli/config-parser.ts tests/cli/config-parser.telegram-transport.test.ts
git commit -m "feat(cli): telegramTransport config validation + mode mutual exclusion

BUILTIN_TYPES adds 'telegramTransport'. validateTelegramTransportOptions
enforces:
- botToken required
- inbound.mode: 'polling' | 'webhook'
- mode-mutual-exclusion: polling block forbidden when mode=webhook and vice
  versa
- webhook.publicUrl, webhook.secretToken required when mode=webhook
- webhook.port range 1-65535 when set
- auth.admittedAgents shape validation
- auth.anonymousIdentityMode: 'ephemeral' | 'durable' when set"
```

---

## Task T16: TelegramTransport CLI resolver + catalog entry

**Files:**
- Modify: `augment-1/src/cli/augment-resolver.ts`
- Modify: `augment-1/src/cli/augment-catalog.ts`

- [ ] **Step 1: Add the resolver case**

In `augment-1/src/cli/augment-resolver.ts`, near the existing imports:

```typescript
import { telegramTransport } from "../augments/telegram-transport";
import type { TelegramTransportOptions } from "../types";
```

In the `switch (config.type)` block, add a case after `notify`:

```typescript
case "telegramTransport":
  augment = telegramTransport(opts as unknown as TelegramTransportOptions);
  break;
```

- [ ] **Step 2: Add the catalog entry**

In `augment-1/src/cli/augment-catalog.ts`, add a catalog entry after the `notify` entry:

```typescript
{
  label: "telegramTransport",
  description: "Bidirectional Telegram I/O — long-poll OR webhook inbound, four-path identity",
  type: "telegramTransport",
  defaultName: "telegram",
  defaultOptions: {
    botToken: "${TELEGRAM_BOT_TOKEN}",
    inbound: {
      mode: "polling",
      polling: { timeoutSec: 30 },
      // To switch to webhook mode, replace the polling block with:
      // mode: "webhook"
      // webhook: { publicUrl: "${TELEGRAM_WEBHOOK_URL}", port: 8081, secretToken: "${TELEGRAM_WEBHOOK_SECRET}" }
    },
    auth: {
      creatorUserIds: [],     // operator fills with their Telegram user_ids
      anonymousIdentityMode: "ephemeral",
    },
  },
  required: false,
  envVars: ["TELEGRAM_BOT_TOKEN"],
  hasSkill: false,
},
```

- [ ] **Step 3: Run the suite**

```bash
cd augment-1 && bun test && bunx tsc --noEmit
```
Expected: green; clean.

- [ ] **Step 4: Commit**

```bash
git add src/cli/augment-resolver.ts src/cli/augment-catalog.ts
git commit -m "feat(cli): wire telegramTransport into resolver + catalog

Resolver case constructs the augment from agent.yaml options. Catalog default
scaffold favors polling mode (no public HTTPS URL needed for self-hosted
deployments); webhook mode shape included as inline comment."
```

---

# Phase C — Operator Docs + Optional Zip Telegram-Inbound + Roadmap

---

## Task T17: Operator reference — `docs/13-notify.md`

**Files:**
- Create: `augment-1/docs/13-notify.md`

- [ ] **Step 1: Write the operator reference**

Create the file mirroring `12-budgets.md`'s structure (overview / configuration / behavior / troubleshooting). Cover at minimum:

- One-paragraph overview of what notify does and how it differs from transport-replies
- Configuration shape with both webhook and telegram destination examples
- Tool surface (the `notify({to, summary, ...})` signature, return shape)
- Rate-limit semantics (cooldown, dedup, global, per-peer; creator bypass)
- Internal adapters: webhook posts JSON `{summary, reason?, visitor?, channel: "notify"}`; telegram formats Markdown text
- Common operator mistakes (typo'd destination name, no rate-limit defaults, etc.)
- Migration from `org_escalate` (one-paragraph callout: rename tool, same arguments)

- [ ] **Step 2: Commit**

```bash
git add docs/13-notify.md
git commit -m "docs(notify): operator reference doc"
```

---

## Task T18: Operator reference — `docs/14-telegram-transport.md`

**Files:**
- Create: `augment-1/docs/14-telegram-transport.md`

- [ ] **Step 1: Write the operator reference**

Cover:

- Overview: bidirectional Telegram bot transport, peer to webTransport
- Bot setup prerequisites: register a bot with @BotFather, get the token, find your Telegram user_id (link to @userinfobot)
- Configuration: polling-mode example, webhook-mode example
- Choosing a mode: polling for self-hosted/home; webhook for cloud-hosted with public HTTPS
- Identity resolution table (four paths) + worked examples for each
- `anonymousIdentityMode` ephemeral vs durable: when to pick each, retention/privacy implications
- `admittedAgents` boot-time validation behavior (warns on unresolved user_ids)
- Coexistence with notify: both can use the same bot token; sending is concurrent-safe
- Webhook deployment notes: public HTTPS URL, certificate, reverse proxy must pass `X-Telegram-Bot-Api-Secret-Token` through
- Troubleshooting: bot not responding, mode-switch issues (Telegram only allows one mode per bot)

- [ ] **Step 2: Commit**

```bash
git add docs/14-telegram-transport.md
git commit -m "docs(telegram-transport): operator reference doc"
```

---

## Task T19: Update `docs/06-transports.md` for multi-transport composition

**Files:**
- Modify: `augment-1/docs/06-transports.md`

- [ ] **Step 1: Add a section on mounting multiple transports**

Add a section near the end describing:
- The kernel multiplexes turns from N transports into shared agent state
- Each transport has its own peer identity resolution
- Same `peer.id` namespace conventions: `vis_<uuid>`, `anon-<threadId>`, `tg_user_<userId>`, `tg_anon_<threadId>`, agent IDs (configured)
- Example: webTransport + telegramTransport mounted simultaneously, both serve their own peers

- [ ] **Step 2: Commit**

```bash
git add docs/06-transports.md
git commit -m "docs(transports): multi-transport composition section"
```

---

## Task T20: Update `docs/07-built-in-augments.md`

**Files:**
- Modify: `augment-1/docs/07-built-in-augments.md`

- [ ] **Step 1: Add sections for `notify` and `telegramTransport`; update `orgContext` section to reflect strip**

For `orgContext`: remove references to `org_escalate` and rate-limit options. Note that escalation moved to the notify augment.

For `notify`: brief one-section summary; link to `13-notify.md` for full operator reference.

For `telegramTransport`: brief one-section summary; link to `14-telegram-transport.md` for full operator reference.

- [ ] **Step 2: Commit**

```bash
git add docs/07-built-in-augments.md
git commit -m "docs(built-in-augments): notify + telegramTransport sections; org-context strip"
```

---

## Task T21: Optional — enable Telegram inbound for Zip

**Files:**
- Modify: `augment-1/zip/agent.yaml`

This task is optional — if the operator wants Zip to accept inbound DMs on Telegram (in addition to receiving notifications), add a telegramTransport mount. If left commented out, Zip continues serving on web only.

- [ ] **Step 1: Append commented telegramTransport block to zip/agent.yaml**

```yaml
  # Optional: enable inbound Telegram DMs to Zip.
  # Uncomment and set TELEGRAM_BOT_TOKEN_ZIP + OPERATOR_TELEGRAM_USER_ID env vars.
  # - name: telegram
  #   type: telegramTransport
  #   options:
  #     botToken: ${TELEGRAM_BOT_TOKEN_ZIP}
  #     inbound:
  #       mode: polling
  #       polling: { timeoutSec: 30 }
  #     auth:
  #       creatorUserIds: [${OPERATOR_TELEGRAM_USER_ID}]
  #       anonymousIdentityMode: ephemeral
```

- [ ] **Step 2: Commit**

```bash
git add zip/agent.yaml
git commit -m "chore(zip): commented telegramTransport mount for opt-in inbound"
```

---

## Task T22: Multi-transport integration test

**Files:**
- Create: `augment-1/tests/integration/telegram-transport.test.ts`

- [ ] **Step 1: Write integration test exercising telegram-transport + notify together**

```typescript
import { describe, it, expect } from "bun:test";
import { telegramTransport } from "../../src/augments/telegram-transport";
import { notify } from "../../src/augments/notify";
import type { TelegramBotClient, TelegramUpdate } from "../../src/telegram-client";

function mockClient(updates: TelegramUpdate[]) {
  const sent: any[] = [];
  const client: TelegramBotClient = {
    sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { messageId: 1, chatId }; },
    getUpdates: async () => { const batch = updates.shift() ?? []; return batch as any; },
    setWebhook: async () => {},
    deleteWebhook: async () => {},
    getChat: async (chatId) => ({ id: Number(chatId), type: "private" }),
  };
  return { client, sent };
}

describe("telegram-transport + notify integration", () => {
  it("inbound DM dispatches turn; agent calls notify; notify reaches webhook", async () => {
    const updates: TelegramUpdate[] = [
      { update_id: 1, message: { message_id: 1, chat: { id: 555, type: "private" }, from: { id: 555, is_bot: false }, date: 0, text: "I need help" } },
    ];
    const { client, sent } = mockClient([updates, []]);
    const notifyDeliveries: any[] = [];

    const tg = telegramTransport({
      botToken: "T",
      inbound: { mode: "polling", polling: { timeoutSec: 0 } },
      auth: { creatorUserIds: [555] },
      _clientFactory: () => client,
      _dispatchTurn: async (input, peer, reply) => {
        // Simulate: agent decides to notify creator and reply
        const n = notify({
          destinations: [{ name: "creator", transport: "webhook", url: "https://example.com/notify" }],
          adapters: { webhook: { deliver: async (d, p) => { notifyDeliveries.push({ d, p }); return { status: "sent" }; } } as any, telegram: { deliver: async () => ({ status: "sent" }) } as any },
        });
        const tool = n.tools![0];
        await tool.execute({ to: "creator", summary: "User needs help" }, { turnId: "t1", peer, threadId: input.threadId });
        await reply("Got it, escalating to my creator.");
      },
    } as any);

    await tg.onBoot?.({} as any);
    await new Promise((r) => setTimeout(r, 30));
    await tg.onShutdown?.({} as any);

    expect(notifyDeliveries).toHaveLength(1);
    expect(notifyDeliveries[0].p.summary).toBe("User needs help");
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(555);
  });
});
```

- [ ] **Step 2: Run**

```bash
cd augment-1 && bun test tests/integration/telegram-transport.test.ts
```
Expected: passing.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/telegram-transport.test.ts
git commit -m "test(integration): telegram-transport + notify end-to-end

Inbound Telegram DM → turn dispatches → agent calls notify → webhook
adapter delivers → reply sent via sendMessage. Validates the cross-augment
composition (without cross-augment dependency) story."
```

---

## Task T23: ROADMAP updates

**Files:**
- Modify: `lo/docs/ROADMAP.md`

- [ ] **Step 1: Retitle item 6 + add follow-on items**

Find the existing item 6 entry in `lo/docs/ROADMAP.md` (around line 51):

```markdown
### 6. Static org config in agent.yaml

`org:` section for org identity without deploying an API. Pluggable notification target for escalations.

Source: Session 2026-04-23
```

Replace with:

```markdown
### 6. Notify augment + Telegram transport + orgContext strip ✅

Outbound `notify` augment with internal webhook + telegram adapters (rate-limited, named destinations). Bidirectional `telegramTransport` with polling AND webhook modes, four-path identity resolution, ephemeral-default anonymous peer.id (durable opt-in). `orgContext` stripped to read-only (escalation moves to notify). Shared `src/telegram-client.ts` utility — no cross-augment coupling. Zip migrates from `org_escalate` to `notify` via webhook adapter pointing at `agent-context-api/notify` (preserves bot-token-stays-in-server secret hygiene).

Spec: [docs/superpowers/specs/2026-04-28-notify-augment-and-outbound-taxonomy-design.md](superpowers/specs/2026-04-28-notify-augment-and-outbound-taxonomy-design.md). Plan: [docs/superpowers/plans/2026-04-28-notify-augment-and-telegram-transport.md](superpowers/plans/2026-04-28-notify-augment-and-telegram-transport.md).
```

(Leave `✅` until the work actually ships; remove it if not yet complete at the time of this commit.)

- [ ] **Step 2: Add follow-on items**

In the priority queue section of ROADMAP.md (find the right insertion point — after item 11 or wherever new items currently land):

```markdown
### Multi-destination fan-out for `notify`

`notify({to: ["a", "b"]})` atomic best-effort delivery with per-destination result aggregation. Cross-channel cooldowns. Adds reliability for multi-channel ops alerting.

Source: Roadmap item 6 follow-on.

### Severity-based routing rules for `notify`

Declarative `routing: [{if: {severity, topic}, to: [...]}]` schema. Operator pre-decides where each kind of notification goes; agent calls `notify({severity: "critical", ...})` without naming destinations.

Source: Roadmap item 6 follow-on.

### `slackOut`, `emailOut`, `discordOut` adapters for `notify`

Same internal-adapter pattern as `webhook` and `telegram`. Each adapter ~50 LOC, lives in `src/augments/notify/adapters/`. Add as concrete need arrives.

Source: Roadmap item 6 follow-on.

### `telegramTransport` streaming-edit replies

`editMessageText` for incremental output as the model streams. Operator opt-in (high API call volume otherwise). Reuses the shared `src/telegram-client.ts`.

Source: Roadmap item 6 follow-on.

### `telegramTransport` dynamic agent-driven recognition

Agent decides at runtime to "recognize" a previously-anonymous user without operator config change. Mirrors web's token-issuance flow. Requires a persistent recognition store. Defer until concrete demand.

Source: Roadmap item 6 follow-on.

### `whatsappTransport`

Full bidirectional WhatsApp transport, same shape as `telegramTransport`. WhatsApp Cloud API (Meta), four-path identity, polling/webhook modes. Reuses transport SPI patterns.

Source: Roadmap item 6 follow-on.

### `orgContext` write-route generalization

Manifest schema evolution to register write routes as typed tools. OpenAPI-shaped declarations, operator allowlist, confused-deputy mitigation, multi-org namespacing. Possibly accompanied by `orgContext` rename (e.g., `orgManifest`).

Source: Roadmap item 6 follow-on.
```

- [ ] **Step 3: Commit**

```bash
cd /Users/bigviking/Documents/github/projects/lo && git add docs/ROADMAP.md
# (Note: lo/ is not currently a git repo. If it is at the time of this commit,
# use the above. Otherwise, manually edit and skip the commit step — the
# ROADMAP lives outside augment-1's repo.)
```

If `lo/` is not a git repo, just edit the file in place; no commit needed for that path.

---

# Self-Review

After saving the plan, verify:

**1. Spec coverage**

Walk each spec section:

| Spec section | Plan task(s) |
|---|---|
| Notify augment configuration shape | T2 (types), T7 (CLI validation), T7 step 5 (catalog default) |
| Notify tool surface | T5 (implementation + tests) |
| Notify adapter interface | T2 (types), T3 (webhook), T4 (telegram) |
| Notify trust-level behavior (creator bypass) | T5 step 1 ("creator bypasses all rate limits" test), T5 step 3 (implementation guard) |
| Telegram transport configuration shape | T9 (types), T15 (CLI validation), T16 (catalog default) |
| Telegram transport inbound flow (polling + webhook) | T12 (polling), T13 (webhook), T14 (wiring) |
| Telegram transport identity resolution (four paths) | T10 |
| Boot-time admittedAgents validation | T11 |
| Threading + peer.id semantics (ephemeral default + durable opt-in) | T10 (resolver tests cover both modes) |
| Shared Telegram bot API client utility | T1 |
| OrgContext strip | T6 |
| Zip migration | T8 (notify + identity skill); T21 (optional Telegram inbound) |
| Operator reference docs | T17 (notify), T18 (telegram-transport), T19 (transports), T20 (built-in-augments) |
| ROADMAP updates | T23 |
| Test plan items (notify, telegram identity, polling, webhook, mode mutual exclusion, shared client) | T1, T3–T5, T10–T15, T22 |

All spec sections have at least one task. The "Coexistence with notify" section is verified by T22's integration test exercising both augments together.

**2. Placeholder scan**

No `TBD`, `TODO`, `implement later`, `add appropriate error handling`, etc. Every code step contains the actual code. Every command has expected output.

**3. Type consistency**

- `notify` augment factory signature: `(opts: NotifyAugmentInternalOptions) => Augment` — used consistently across T5, T7, T8, T22.
- `NotifyAdapter.deliver(destination, payload) => Promise<NotifyDeliveryResult>` — used in T3, T4, T5.
- `TelegramBotClient` — defined in T1, used in T4, T11, T12, T13, T14, T22.
- `resolveTelegramIdentity({userId, threadId}, auth) => PeerIdentity` — defined in T10, used in T14.
- `TelegramTransportOptions.inbound.mode: "polling" | "webhook"` — consistent across T9, T14, T15.

**4. Migration ordering**

T6 (orgContext strip) deletes `org_escalate`. If T6 lands before T7+T8 (notify CLI wiring + Zip migration), Zip's `org_escalate` calls would break. **Land T6, T7, T8 in the same PR** OR land them in this order in tight succession with a green tree between each.

Recommended single-PR groupings:
- **PR 1 (Phase A):** T1–T8 — shared client, notify augment, orgContext strip, CLI, Zip migration. ~1300 LOC + ~30 tests.
- **PR 2 (Phase B):** T9–T16 — telegramTransport with both modes, identity, CLI. ~900 LOC + ~25 tests.
- **PR 3 (Phase C):** T17–T23 — docs, optional Zip enable, integration test, roadmap. ~minimal LOC + ~5 tests.

Plan-phase confirms; this matches the spec's "Plan-phase decomposition (advisory)" section.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-28-notify-augment-and-telegram-transport.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
