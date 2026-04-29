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
// Augment factory (skeleton — receive logic in T12 / T13)
// ---------------------------------------------------------------------------

export function telegramTransport(_opts: TelegramTransportOptions): Augment {
  return {
    name: "telegram-transport",
    capabilities: ["transport"],
    // Lifecycle implementation (onBoot, onShutdown), polling/webhook receive
    // wiring, and reply path land in subsequent tasks (T11–T14).
  };
}
