/**
 * Integration test — webTransport + telegramTransport mounted simultaneously.
 *
 * Verifies that two transports mounted on the same agent serve their own peers
 * without crosstalk:
 *   - Telegram inbound → sendMessage to originating chat_id, NOT to web
 *   - Web inbound → HTTP SSE response, NOT to sendMessage
 *
 * This catches multi-transport dispatch contract bugs (e.g., the trigger.source
 * vs aug.name keying issue from Phase B) that single-transport tests miss.
 *
 * ## Inbound delivery timing (same race as Phase B's single-transport test)
 *
 * lifecycle.boot() starts the poll loop before transport.register() wires the
 * kernel handle. The first getUpdates() can fire before the kernel is wired,
 * so handleUpdate sees kernel === null and drops the update. We use the same
 * pattern as telegram-transport.test.ts: getUpdates returns [] until
 * `registered` is set (after agent.start() resolves), then delivers the update
 * exactly once on the next iteration.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { defineAgent } from "@/agent";
import { telegramTransport } from "@/augments/telegramTransport";
import { webTransport } from "@/transports/web-transport";
import { fileMemory } from "@/augments/fileMemory";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTempDir } from "@tests/fixtures/temp-dir";
import type { TelegramBotClient, TelegramUpdate } from "@/telegram-client";
import type { AgentHandle } from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a randomized port in the ephemeral range to avoid collisions with
 * other test files running in parallel. Mirrors the helper used in
 * tests/augments/telegramTransport/webhook.test.ts.
 */
function freePort(): number {
  return 30000 + Math.floor(Math.random() * 9999);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("multi-transport integration: webTransport + telegramTransport", () => {
  let tmp: { path: string; cleanup: () => Promise<void> };
  let agent: AgentHandle;

  beforeEach(async () => {
    tmp = await createTempDir();
  });

  afterEach(async () => {
    try {
      await agent?.stop();
    } catch {
      // ignore — may already be stopped or never started
    }
    await tmp.cleanup();
  });

  it("both transports serve their own peers; replies route to the correct transport only", async () => {
    writeFileSync(join(tmp.path, "id.md"), "# Test agent\n\nReply succinctly.");

    // -----------------------------------------------------------------------
    // Mock Telegram client — mirrors Phase B's pattern
    // -----------------------------------------------------------------------

    const sent: Array<{ chatId: number | string; text: string }> = [];
    let registered = false; // flipped after agent.start() returns
    let delivered = false;

    const inboundUpdate: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 555, type: "private" },
        from: { id: 555, is_bot: false },
        date: 0,
        text: "hi from telegram",
      },
    };

    // Deliver the update only after transport.register() has wired the kernel.
    const tgClient: TelegramBotClient = {
      async sendMessage(chatId, text) {
        sent.push({ chatId, text });
        return { messageId: 1, chatId };
      },
      async getUpdates() {
        if (registered && !delivered) {
          delivered = true;
          return [inboundUpdate];
        }
        return [];
      },
      async setWebhook() {},
      async deleteWebhook() {},
      async getChat(chatId) {
        return { id: Number(chatId), type: "private" };
      },
    };

    // -----------------------------------------------------------------------
    // Mock model — two queued replies (first for TG, second for web)
    // -----------------------------------------------------------------------

    const model = createMockModel({ response: "fallback" });
    // Queue in expected delivery order: telegram fires first (poll loop), web
    // fires second (explicit fetch after start()).
    model.pushResponse({ content: "reply-to-tg", finishReason: "end_turn" });
    model.pushResponse({ content: "reply-to-web", finishReason: "end_turn" });

    // -----------------------------------------------------------------------
    // Agent with both transports
    // -----------------------------------------------------------------------

    const port = freePort();

    agent = defineAgent(
      {
        name: "test-multi-transport",
        purpose: "multi-transport integration test",
        model: "mock",
        augments: [
          fileMemory({
            label: "id",
            source: join(tmp.path, "id.md"),
            mutable: false,
            origin: "operator",
            priority: "required",
            placement: "system",
            eviction: "never",
          }),
          telegramTransport({
            botToken: "T",
            inbound: {
              mode: "polling",
              polling: { timeoutSec: 0 },
            },
            auth: { creatorUserIds: [555] },
            // Test-only: inject a mock client to avoid real Telegram API calls.
            _clientFactory: () => tgClient,
          } as any),
          webTransport({
            port,
            auth: { type: "bearer", token: "WEBSECRET" },
          }),
        ],
      },
      model,
    );

    // Boot the agent. After start() resolves, both transport.register() calls
    // have completed and the kernel handles are wired. Flip the flag so the
    // next telegram poll iteration returns the real update.
    await agent.start();
    registered = true;

    // -----------------------------------------------------------------------
    // 1. Telegram inbound — wait for poll loop to deliver the update
    // -----------------------------------------------------------------------

    // Allow time for the poll loop to fire, handleInbound to run, and the
    // outbound callback to call sendMessage. 300ms mirrors Phase B's timing.
    await new Promise<void>((r) => setTimeout(r, 300));

    // Assert: telegram reply delivered to correct chat_id
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe(555);
    expect(sent[0]?.text).toBe("reply-to-tg");

    // -----------------------------------------------------------------------
    // 2. Web inbound — drive a POST to the webTransport server
    // -----------------------------------------------------------------------

    const webRes = await fetch(`http://localhost:${port}/agent/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer WEBSECRET",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi from web" }],
      }),
    });

    expect(webRes.status).toBe(200);
    expect(webRes.headers.get("content-type")).toContain("text/event-stream");

    // Read the full SSE stream and verify the web turn's reply lands.
    const webBody = await webRes.text();
    expect(webBody).toContain("reply-to-web");

    // -----------------------------------------------------------------------
    // 3. Crosstalk guard — verify no reply bleed between transports
    // -----------------------------------------------------------------------

    // Telegram client must NOT have received the web turn's reply.
    // sent.length must still be 1 (only the telegram turn).
    expect(sent).toHaveLength(1);
    // And the only entry is still the telegram reply, not the web reply.
    expect(sent[0]?.text).toBe("reply-to-tg");

    // The web SSE body must NOT contain the telegram reply text.
    expect(webBody).not.toContain("reply-to-tg");

    await agent.stop();
  });
});
