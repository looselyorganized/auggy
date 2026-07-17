/**
 * Integration test — Telegram transport with real kernel.
 *
 * Exercises the full inbound→handleInbound→outbound→sendMessage chain.
 * Catches C1 (contextId omission in turn-loop response) and C2
 * (trigger.source vs aug.name keying mismatch in outboundHandlers) if
 * either regresses.
 *
 * The mock returns the update on the first poll. Transport readiness must run
 * after kernel registration, so an immediate inbound update cannot be lost.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { defineAgent } from "@/agent";
import { telegramTransport } from "@/augments/telegramTransport";
import { fileMemory } from "@/augments/fileMemory";
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

    const client: TelegramBotClient = {
      async sendMessage(chatId, text) {
        sent.push({ chatId, text });
        return { messageId: 1, chatId };
      },
      async getUpdates() {
        if (!delivered) {
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
          } as unknown as Parameters<typeof telegramTransport>[0]),
        ],
      },
      model,
    );

    await agent.start();

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
