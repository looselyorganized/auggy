/**
 * Telegram transport augment — bidirectional Telegram I/O.
 *
 * Inbound: polling (T12) or webhook (T13) modes. Both feed updates through
 * resolveTelegramIdentity to resolve peer identity per the four-path model
 * from item 5's spec.
 *
 * Outbound: replies to the current peer's chat via sendMessage. Outbound to
 * non-current-peer destinations is notify's job, not this transport's.
 *
 * Uses src/telegram-client.ts as a shared utility — no cross-augment coupling.
 *
 * Wiring: Implements the TransportSpec contract. The kernel calls
 * `transport.register(kernel)` to plug in; the augment retains the kernel
 * handle and calls `kernel.handleInbound(trigger, {onEvent})` for every
 * inbound text update. The reply path is wired by registering an outbound
 * callback via `kernel.onOutbound(cb)` once at register-time. Mirrors
 * web-transport's pattern.
 */

import type {
  Augment,
  InboundMessage,
  KernelEvent,
  OutboundMessage,
  Part,
  PeerIdentity,
  TelegramAuthOptions,
  TelegramTransportOptions,
  TransportKernel,
  TransportSpec,
  TurnTrigger,
} from "../types";
import type { TelegramBotClient, TelegramUpdate } from "../telegram-client";
import { createTelegramBotClient } from "../telegram-client";
import { runPollLoop, type PollLoopHandle } from "./telegram-transport/polling";
import { startWebhookServer, type WebhookServerHandle } from "./telegram-transport/webhook";

// ---------------------------------------------------------------------------
// Boot-time validation
// ---------------------------------------------------------------------------

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
      log.info(
        `[telegram-transport] admittedAgent "${agent.id}" (telegramUserId=${agent.telegramUserId}) resolved successfully`,
      );
    } catch (err) {
      log.warn(
        `[telegram-transport] admittedAgent "${agent.id}" (telegramUserId=${agent.telegramUserId}) failed boot-time validation: ${(err as Error).message}. Real agent traffic from this user_id will be silently demoted to public-anonymous. Verify the user_id is correct and the bot has access to message that user.`,
      );
    }
  }
}

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
// Augment factory — full lifecycle (T14)
// ---------------------------------------------------------------------------

/**
 * Internal extension of TelegramTransportOptions that adds test-only hooks.
 * The public type does not include this field; tests use `as any` to pass it.
 */
interface InternalOptions extends TelegramTransportOptions {
  /** Test-only: override the bot client factory. Useful for unit tests
   *  that don't want to hit the real Telegram bot API. */
  _clientFactory?: () => TelegramBotClient;
}

export function telegramTransport(opts: TelegramTransportOptions): Augment {
  const internal = opts as InternalOptions;
  const clientFactory =
    internal._clientFactory ?? (() => createTelegramBotClient({ botToken: opts.botToken }));
  const client = clientFactory();

  let pollHandle: PollLoopHandle | null = null;
  let webhookHandle: WebhookServerHandle | null = null;
  let kernel: TransportKernel | null = null;
  let registeredName: string | null = null;

  /**
   * Per-thread chat_id map. Populated when an inbound update arrives, read
   * by the outbound callback so we know where to deliver the reply.
   * Keyed by threadId (`tg-chat-<chatId>`) — same shape as the threadId we
   * pass into resolveTelegramIdentity and into the TurnTrigger.
   */
  const threadChatIds = new Map<string, number | string>();

  // ---------------------------------------------------------------------------
  // Identity resolver (TransportSpec.identify)
  // ---------------------------------------------------------------------------
  //
  // The kernel calls identify() with the raw inbound. For Telegram, the raw
  // inbound is shaped `{ userId, threadId }` — we extract those before calling
  // handleInbound so the kernel can pre-resolve peer identity if it wants to.

  const identify = (raw: unknown): PeerIdentity | null => {
    const r = raw as { userId?: number; threadId?: string };
    if (typeof r?.userId !== "number" || typeof r?.threadId !== "string") return null;
    return resolveTelegramIdentity({ userId: r.userId, threadId: r.threadId }, opts.auth);
  };

  const transport: TransportSpec = {
    async register(k: TransportKernel, augmentName: string) {
      kernel = k;
      registeredName = augmentName;
      // Wire the outbound callback once. The kernel invokes this for every
      // outbound text message during a turn — we look up the chat_id by
      // threadId (set when the inbound arrived) and call sendMessage.
      kernel.onOutbound(async (_peer: PeerIdentity, message: OutboundMessage) => {
        // Telegram replies are text-only in v0. Concatenate all text parts
        // to mirror the AG-UI text_message kernel events.
        const textParts = message.parts
          .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
          .map((p) => p.text);
        if (textParts.length === 0) return;
        const text = textParts.join("");

        // Find the chat_id. Prefer contextId/taskId-mapped threadId; fall
        // back to message.targetPeer if the kernel relays it. The contract
        // we set up at handleInbound time uses contextId === threadId.
        const threadId = message.contextId;
        if (!threadId) return;
        const chatId = threadChatIds.get(threadId);
        if (chatId === undefined) return;

        try {
          await client.sendMessage(chatId, text);
        } catch (err) {
          console.warn(
            `[telegram-transport] sendMessage failed for chatId=${chatId}: ${(err as Error).message}`,
          );
        }
      });
    },
    identify,
  };

  /**
   * Convert a Telegram update to a TurnTrigger and dispatch via the kernel.
   * Mirrors web-transport's handleAgentRun shape: build InboundMessage,
   * wrap in TurnTrigger, call kernel.handleInbound.
   */
  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    if (!kernel) return; // Not yet registered — drop the update.
    if (!update.message?.text || !update.message.from) return;

    const userId = update.message.from.id;
    const chatId = update.message.chat.id;
    const threadId = `tg-chat-${chatId}`;
    const peer = resolveTelegramIdentity({ userId, threadId }, opts.auth);

    // Remember chat_id for the outbound callback.
    threadChatIds.set(threadId, chatId);

    const parts: Part[] = [{ kind: "text", text: update.message.text }];
    const inbound: InboundMessage = {
      parts,
      sourceAugment: "telegram-transport",
      peer,
      timestamp: Date.now(),
      contextId: threadId,
    };
    const trigger: TurnTrigger = {
      type: "message",
      turnId: crypto.randomUUID(),
      threadId,
      contextId: threadId,
      timestamp: Date.now(),
      source: registeredName ?? "telegram-transport",
      peer,
      payload: inbound,
    };

    // Drop kernelEvents on the floor for now (no streaming UI for Telegram
    // in v0). The text replies arrive via the onOutbound callback wired in
    // register(). If a streaming-edit (editMessageText) experience is added
    // later, this is where text_message_delta would be intercepted.
    const onEvent = (_e: KernelEvent): void => {};

    try {
      await kernel.handleInbound(trigger, { onEvent });
    } catch (err) {
      console.warn(
        `[telegram-transport] kernel.handleInbound failed for threadId=${threadId}: ${(err as Error).message}`,
      );
    }
  }

  return {
    name: "telegram-transport",
    capabilities: ["transport"],
    transport,

    async onBoot(): Promise<void> {
      await validateAdmittedAgents(opts.auth.admittedAgents, client);

      if (opts.inbound.mode === "polling") {
        pollHandle = runPollLoop({
          client,
          timeoutSec: opts.inbound.polling?.timeoutSec ?? 30,
          onUpdate: (u) => handleUpdate(u),
        });
      } else if (opts.inbound.mode === "webhook") {
        if (!opts.inbound.webhook) {
          throw new Error(
            "[telegram-transport] inbound.mode === 'webhook' requires inbound.webhook config",
          );
        }
        await client.setWebhook(opts.inbound.webhook.publicUrl, opts.inbound.webhook.secretToken, {
          allowedUpdates: opts.inbound.webhook.allowedUpdates,
        });
        webhookHandle = await startWebhookServer({
          port: opts.inbound.webhook.port ?? 8081,
          secretToken: opts.inbound.webhook.secretToken,
          onUpdate: (u) => handleUpdate(u),
        });
      } else {
        throw new Error(
          `[telegram-transport] inbound.mode must be 'polling' or 'webhook' (got ${(opts.inbound as { mode: unknown }).mode})`,
        );
      }
    },

    async onShutdown(): Promise<void> {
      if (pollHandle) {
        pollHandle.stop();
        await pollHandle.done;
        pollHandle = null;
      }
      if (webhookHandle) {
        webhookHandle.stop();
        webhookHandle = null;
        try {
          await client.deleteWebhook();
        } catch (err) {
          console.warn(
            `[telegram-transport] deleteWebhook on shutdown failed: ${(err as Error).message}`,
          );
        }
      }
    },
  };
}
