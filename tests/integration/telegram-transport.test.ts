/**
 * Integration test — Telegram transport with real kernel.
 *
 * Exercises the full inbound→handleInbound→outbound→sendMessage chain.
 * Catches C1 (contextId omission in turn-loop response) and C2
 * (trigger.source vs aug.name keying mismatch in outboundHandlers) if
 * either regresses.
 *
 * ## Inbound delivery timing
 *
 * In agent.ts, lifecycle.boot() (which calls onBoot() and starts the poll
 * loop) runs before transport.register(). The poll loop's first getUpdates
 * call can fire before the kernel handle is wired in, so handleUpdate sees
 * kernel === null and drops the update. To avoid this race, the mock
 * getUpdates returns [] until the `registered` flag is set (after start()
 * returns), then delivers the update exactly once on the next poll iteration.
 * This guarantees the update arrives after register() has been called.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { defineAgent } from "@/agent";
import { telegramTransport } from "@/augments/telegram-transport";
import { fileMemory } from "@/augments/file-memory";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTempDir } from "@tests/fixtures/temp-dir";
import type { TelegramBotClient, TelegramUpdate } from "@/telegram-client";
import type { AgentHandle } from "@/types";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("telegram-transport integration with real kernel", () => {
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

  it("inbound DM → kernel runs turn → outbound reply hits sendMessage with original chat_id", async () => {
    writeFileSync(join(tmp.path, "id.md"), "# Test agent\n\nReply with 'ok' to anything.");

    const sent: Array<{ chatId: number | string; text: string }> = [];
    let registered = false; // set true after agent.start() returns
    let delivered = false;

    const inboundUpdate: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 555, type: "private" },
        from: { id: 555, is_bot: false },
        date: 0,
        text: "hello",
      },
    };

    // Deliver the update only after transport.register() has wired in the
    // kernel handle (signaled by `registered`). Returns [] during boot.
    const client: TelegramBotClient = {
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

    const model = createMockModel({ response: "ok" });

    agent = defineAgent(
      {
        name: "test-tg-agent",
        purpose: "test",
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
            // Internal test-only override — passes a mock client to avoid
            // real Telegram API calls.
            _clientFactory: () => client,
          } as any),
        ],
      },
      model,
    );

    // Boot the agent. After start() resolves, transport.register() has been
    // called and outboundHandlers is wired. Flip the flag so the next poll
    // iteration returns the real update.
    await agent.start();
    registered = true;

    // Wait for poll loop to deliver the update, the kernel to complete
    // a turn, and the outbound callback to fire sendMessage.
    await new Promise<void>((r) => setTimeout(r, 300));

    await agent.stop();

    // Full-chain assertions:
    //   C1: contextId must be set on TurnResult.response (turn-loop fix) so
    //       the outbound callback can look up the chatId via threadChatIds.
    //   C2: trigger.source must equal aug.name (telegram-transport) so
    //       dispatchOutbound finds the right entry in outboundHandlers.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe(555);
    expect(sent[0]?.text).toBe("ok");
  });
});
