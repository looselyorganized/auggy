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
  TurnResult,
  TurnTrigger,
} from "../../types";
import type { TelegramBotClient, TelegramUpdate } from "../../telegram-client";
import { createTelegramBotClient } from "../../telegram-client";
import { runPollLoop, type PollLoopHandle } from "./polling";
import { startWebhookServer, type WebhookServerHandle } from "./webhook";
import { createHash } from "node:crypto";
import {
  createInMemoryTelegramReplayStore,
  createSqliteTelegramReplayStore,
  InvalidTelegramUpdateError,
  TelegramReplayConflictError,
  type TelegramReplayStore,
} from "./replay-store";

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
): Promise<Array<{ id: string; telegramUserId: number }>> {
  if (!admittedAgents || admittedAgents.length === 0) return [];
  const validated: Array<{ id: string; telegramUserId: number }> = [];
  for (const agent of admittedAgents) {
    try {
      await client.getChat(agent.telegramUserId);
      validated.push(agent);
      log.info(
        `[telegram-transport] admittedAgent "${agent.id}" (telegramUserId=${agent.telegramUserId}) resolved successfully`,
      );
    } catch {
      log.warn(
        `[telegram-transport] admittedAgent "${agent.id}" (telegramUserId=${agent.telegramUserId}) failed boot-time validation and was removed from the active mapping. Traffic from this user_id is public-anonymous until the configuration validates on a later restart.`,
      );
    }
  }
  return validated;
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

export interface ResolveIdentityInput {
  userId: number;
  threadId: string;
  chatType?: string;
  displayName?: string;
}

export function resolveTelegramIdentity(
  input: ResolveIdentityInput,
  auth: TelegramAuthOptions,
  creator: TelegramTransportOptions["creator"] = undefined,
): PeerIdentity {
  const { userId, threadId } = input;
  const chatType = input.chatType ?? "private";
  const mode = auth.anonymousIdentityMode ?? "ephemeral";
  const creatorUserIds = resolveTelegramCreatorUserIds(auth);

  // Order matches item 5's web-transport: creator → agent → recognized → anonymous.
  if (creatorUserIds.includes(userId) && chatType === "private") {
    return {
      id: "creator",
      kind: "human",
      trustLevel: "creator",
      sourceAugment: "telegram-transport",
      displayName: creator?.displayName ?? input.displayName,
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

function normalizeTelegramAuthOptions(auth: TelegramAuthOptions): TelegramAuthOptions {
  return {
    ...auth,
    creatorUserIds: resolveTelegramCreatorUserIds(auth),
  };
}

function resolveTelegramCreatorUserIds(auth: TelegramAuthOptions): number[] {
  const out = [...(auth.creatorUserIds ?? [])];
  if (!auth.creatorUserIdsEnv) return out;
  const raw = process.env[auth.creatorUserIdsEnv];
  if (!raw?.trim()) return out;

  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const value = Number(trimmed);
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `telegramTransport: ${auth.creatorUserIdsEnv} must be a comma-separated list of numeric Telegram user IDs`,
      );
    }
    out.push(value);
  }
  return out;
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
  const auth = normalizeTelegramAuthOptions(opts.auth);
  const internal = opts as InternalOptions;
  const clientFactory =
    internal._clientFactory ?? (() => createTelegramBotClient({ botToken: opts.botToken }));
  const client = clientFactory();

  let pollHandle: PollLoopHandle | null = null;
  let webhookHandle: WebhookServerHandle | null = null;
  let kernel: TransportKernel | null = null;
  let registeredName: string | null = null;
  let replayStore: TelegramReplayStore | null = opts.replay?.store ?? null;
  let ownsReplayStore = false;

  /**
   * Per-thread chat_id map. Populated when an inbound update arrives, read
   * by the outbound callback so we know where to deliver the reply.
   * Keyed by threadId (`tg-chat-<chatId>`) — same shape as the threadId we
   * pass into resolveTelegramIdentity and into the TurnTrigger.
   */
  const threadChatIds = new Map<string, { chatId: number | string; activeTurns: number }>();
  const genericFailureReply =
    "I hit a runtime error while handling that message. The operator has the details.";

  function getReplayStore(): TelegramReplayStore {
    if (replayStore) return replayStore;
    replayStore = internal._clientFactory
      ? createInMemoryTelegramReplayStore()
      : createSqliteTelegramReplayStore({
          dbPath: opts.replay?.dbPath ?? "./data/telegram-replay.db",
          retentionMs: opts.replay?.retentionMs,
          maxEntries: opts.replay?.maxEntries,
        });
    ownsReplayStore = true;
    return replayStore;
  }

  function replayNamespace(): string {
    if (opts.replay?.namespace) return opts.replay.namespace;
    const botId = opts.botToken.match(/^(\d+):/)?.[1];
    if (internal._clientFactory && !botId) {
      return `${registeredName ?? "telegram-transport"}:test-client`;
    }
    if (!botId) {
      throw new Error(
        "[telegram-transport] replay.namespace is required when botToken has no numeric bot id",
      );
    }
    return `${registeredName ?? "telegram-transport"}:bot-${botId}`;
  }

  // ---------------------------------------------------------------------------
  // Identity resolver (TransportSpec.identify)
  // ---------------------------------------------------------------------------
  //
  // The kernel calls identify() with the raw inbound. For Telegram, the raw
  // inbound is shaped `{ userId, threadId }` — we extract those before calling
  // handleInbound so the kernel can pre-resolve peer identity if it wants to.

  const identify = (raw: unknown): PeerIdentity | null => {
    const r = raw as {
      userId?: number;
      threadId?: string;
      chatType?: string;
      displayName?: string;
    };
    if (typeof r?.userId !== "number" || typeof r?.threadId !== "string") return null;
    return resolveTelegramIdentity(
      { userId: r.userId, threadId: r.threadId, chatType: r.chatType, displayName: r.displayName },
      auth,
      opts.creator,
    );
  };

  const transport: TransportSpec = {
    async register(k: TransportKernel, augmentName: string) {
      kernel = k;
      registeredName = augmentName;
      // Wire the outbound callback once. The kernel invokes this for every
      // outbound text message during a turn — we look up the chat_id by
      // threadId (set when the inbound arrived) and call sendMessage.
      kernel.onOutbound(async (_peer: PeerIdentity, message: OutboundMessage, context) => {
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
        const route = threadChatIds.get(threadId);
        if (!route) return;
        const chatId = route.chatId;

        try {
          await client.sendMessage(chatId, text, { signal: context?.signal });
        } catch (err) {
          console.warn(
            `[telegram-transport] sendMessage failed for chatId=${chatId}: ${(err as Error).message}`,
          );
        }
      });
    },
    async ready() {
      if (!kernel || !registeredName) {
        throw new Error("[telegram-transport] cannot become ready before kernel registration");
      }
      if (pollHandle || webhookHandle) return;

      if (opts.inbound.mode === "polling") {
        pollHandle = runPollLoop({
          client,
          timeoutSec: opts.inbound.polling?.timeoutSec ?? 30,
          onUpdate: (u) => handleUpdate(u),
        });
        return;
      }

      const webhook = opts.inbound.webhook;
      if (!webhook) {
        throw new Error(
          "[telegram-transport] inbound.mode === 'webhook' requires inbound.webhook config",
        );
      }

      // Bind locally only after kernel registration, then tell Telegram where
      // to deliver. If the remote update fails, tear down the local listener
      // and best-effort remove an ambiguously accepted remote webhook.
      webhookHandle = await startWebhookServer({
        port: webhook.port ?? 8081,
        secretToken: webhook.secretToken,
        maxBodyBytes: webhook.maxBodyBytes,
        onUpdate: (u) => handleUpdate(u),
      });
      try {
        await client.setWebhook(webhook.publicUrl, webhook.secretToken, {
          allowedUpdates: webhook.allowedUpdates,
        });
      } catch (err) {
        webhookHandle.stop();
        webhookHandle = null;
        try {
          await client.deleteWebhook();
        } catch (cleanupErr) {
          console.warn(
            `[telegram-transport] deleteWebhook after readiness failure failed: ${(cleanupErr as Error).message}`,
          );
        }
        throw err;
      }
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
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
      throw new InvalidTelegramUpdateError();
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(update);
    } catch {
      throw new InvalidTelegramUpdateError();
    }
    const payloadHash = createHash("sha256").update(serialized).digest("hex");
    const claim = getReplayStore().claim(replayNamespace(), update.update_id, payloadHash);
    if (claim === "duplicate") return;
    if (claim === "conflict") throw new TelegramReplayConflictError();
    if (!update.message?.text || !update.message.from) return;

    const userId = update.message.from.id;
    const chatId = update.message.chat.id;
    const chatType = update.message.chat.type;
    const displayName = update.message.from.first_name ?? update.message.from.username ?? undefined;
    const threadId = `tg-chat-${chatId}`;
    const peer = resolveTelegramIdentity(
      { userId, threadId, chatType, displayName },
      auth,
      opts.creator,
    );

    // Retain chat routing only while a turn is active. A reference count
    // keeps concurrent updates for the same chat from deleting each other's
    // reply route.
    const activeRoute = threadChatIds.get(threadId);
    threadChatIds.set(threadId, {
      chatId,
      activeTurns: (activeRoute?.activeTurns ?? 0) + 1,
    });

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
      const result = await kernel.handleInbound(trigger, { onEvent });
      if (!result.success) {
        console.warn(
          `[telegram-transport] turn failed for threadId=${threadId}: status=${result.status}` +
            `${result.error?.source ? ` source=${result.error.source}` : ""}`,
        );
        await sendFailureReply(chatId, failureReplyForResult(result));
      }
    } catch {
      console.warn(`[telegram-transport] kernel.handleInbound failed for threadId=${threadId}`);
      await sendFailureReply(chatId, genericFailureReply);
    } finally {
      const route = threadChatIds.get(threadId);
      if (route) {
        if (route.activeTurns <= 1) threadChatIds.delete(threadId);
        else threadChatIds.set(threadId, { ...route, activeTurns: route.activeTurns - 1 });
      }
    }
  }

  function failureReplyForResult(result: TurnResult): string {
    const candidate = result.errorResponse?.trim();
    if (candidate && isSafePublicFailure(candidate)) return candidate;
    return genericFailureReply;
  }

  function isSafePublicFailure(message: string): boolean {
    return (
      message === "Turn was aborted." ||
      message.startsWith("Rate limit exceeded.") ||
      message.startsWith("Too many pending messages.")
    );
  }

  async function sendFailureReply(chatId: number | string, text: string): Promise<void> {
    try {
      await client.sendMessage(chatId, text);
    } catch (err) {
      console.warn(
        `[telegram-transport] sendMessage failed for failure reply chatId=${chatId}: ${(err as Error).message}`,
      );
    }
  }

  const adminInfo = async (): Promise<import("../../types").AdminInfoBlock> => {
    const mode = opts.inbound.mode;
    return {
      augmentName: "telegram-transport",
      title: "Telegram transport",
      sections: [
        {
          kind: "keyValue",
          rows: [
            { label: "Bot token configured", value: opts.botToken ? "yes" : "no" },
            { label: "Inbound mode", value: mode },
            ...(mode === "polling"
              ? [
                  {
                    label: "Polling timeout (s)",
                    value: String(opts.inbound.polling?.timeoutSec ?? 30),
                  },
                ]
              : []),
            ...(mode === "webhook" && opts.inbound.webhook
              ? [
                  { label: "Webhook URL", value: opts.inbound.webhook.publicUrl },
                  { label: "Webhook port", value: String(opts.inbound.webhook.port ?? 8081) },
                ]
              : []),
            {
              label: "Admitted agents",
              value: String(auth.admittedAgents?.length ?? 0),
            },
          ],
        },
        {
          kind: "status",
          level: pollHandle || webhookHandle ? "ok" : "warn",
          message:
            pollHandle || webhookHandle
              ? "Transport running."
              : "Transport not yet started (boot in progress or shutdown).",
        },
      ],
    };
  };

  return {
    name: "telegram-transport",
    type: "telegramTransport",
    category: "transports",
    transport,
    adminInfo,

    async onBoot(): Promise<void> {
      auth.admittedAgents = await validateAdmittedAgents(auth.admittedAgents, client);
      if (opts.inbound.mode === "webhook" && !opts.inbound.webhook) {
        throw new Error(
          "[telegram-transport] inbound.mode === 'webhook' requires inbound.webhook config",
        );
      }
      if (opts.inbound.mode !== "polling" && opts.inbound.mode !== "webhook") {
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
      kernel = null;
      registeredName = null;
      threadChatIds.clear();
      if (ownsReplayStore) replayStore?.close?.();
      replayStore = opts.replay?.store ?? null;
      ownsReplayStore = false;
    },
  };
}
