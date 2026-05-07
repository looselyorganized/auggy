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
  NotifyDeliveryResult,
  NotifyDestination,
  ToolExecuteContext,
} from "../types";
import { defineTool } from "../helpers";
import { createWebhookAdapter } from "./notify/adapters/webhook";
import { createTelegramAdapter } from "./notify/adapters/telegram";
import { createAgentMailAdapter } from "./notify/adapters/agentmail";

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

  const destinationsByName = new Map<string, NotifyDestination>();
  for (const d of opts.destinations) destinationsByName.set(d.name, d);

  const rl = opts.rateLimit ?? {};
  const enabled = rl.enabled !== false;
  const cooldownMs = rl.cooldownMs ?? 0;
  const globalMaxPerHour = rl.globalMaxPerHour ?? 5;
  const dedupWindowMs = rl.dedupWindowMs ?? 300_000;
  const dedupThreshold = rl.dedupThreshold ?? 0.6;
  const perPeerCooldownMs = rl.perPeerCooldownMs ?? cooldownMs;

  const peerLastNotify = new Map<string, number>();
  const recentSummaries: Array<{ summary: string; timestamp: number }> = [];
  let globalCountThisHour = 0;
  let globalHourStart = Date.now();

  // Per-destination rate-limit state
  const destinationCountsThisHour = new Map<string, number[]>();
  const destinationLastNotify = new Map<string, number>();

  function checkPeerCooldown(peerId: string, destName: string): string | null {
    const key = `${peerId}:${destName}`;
    const last = peerLastNotify.get(key);
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

  function checkDestinationLimit(destination: NotifyDestination): string | null {
    const destRl = destination.rateLimit;
    if (!destRl) return null;

    const destName = destination.name;
    const now = Date.now();

    // Per-destination cooldown
    if (destRl.cooldownMs !== undefined) {
      const last = destinationLastNotify.get(destName);
      if (last !== undefined) {
        const elapsed = now - last;
        if (elapsed < destRl.cooldownMs) {
          const remainingSec = Math.ceil((destRl.cooldownMs - elapsed) / 1000);
          return `Notification suppressed — per-destination cooldown active for '${destName}'. Next available in ${remainingSec} seconds.`;
        }
      }
    }

    // Per-destination hourly cap
    if (destRl.maxPerHour !== undefined) {
      const windowStart = now - 3_600_000;
      const timestamps = destinationCountsThisHour.get(destName) ?? [];
      // Prune timestamps outside the sliding window
      const recent = timestamps.filter((t) => t > windowStart);
      destinationCountsThisHour.set(destName, recent);
      if (recent.length >= destRl.maxPerHour) {
        return `Notification suppressed — per-destination cap reached for '${destName}' (${destRl.maxPerHour}/hr).`;
      }
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
    const wordsA = new Set(
      a
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
    const wordsB = new Set(
      b
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    const smaller = wordsA.size <= wordsB.size ? wordsA : wordsB;
    const larger = wordsA.size > wordsB.size ? wordsA : wordsB;
    let matches = 0;
    for (const word of smaller) {
      if (larger.has(word)) matches++;
    }
    return matches / smaller.size;
  }

  function recordNotification(peerId: string, summary: string, destName: string, destHasExplicitLimit: boolean): void {
    const now = Date.now();

    if (destHasExplicitLimit) {
      // Destination governs itself — only update per-destination counters.
      // Per-peer cooldown and global counter are not used for this destination,
      // so don't update peerLastNotify or globalCountThisHour (avoids cross-destination pollution).
      const timestamps = destinationCountsThisHour.get(destName) ?? [];
      timestamps.push(now);
      destinationCountsThisHour.set(destName, timestamps);
      destinationLastNotify.set(destName, now);
    } else {
      // No explicit per-destination limit — update per-peer cooldown and global counter.
      // Key is per (peerId, destName) so activity on one destination doesn't bleed into others.
      peerLastNotify.set(`${peerId}:${destName}`, now);
      recentSummaries.push({ summary, timestamp: now });
      globalCountThisHour++;
    }
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

      // Null peer = internal trigger (scheduled, system) — treated as creator, bypasses rate limits.
      const trustLevel = context.peer?.trustLevel ?? "creator";
      const destHasExplicitLimit = !!(destination.rateLimit?.maxPerHour !== undefined || destination.rateLimit?.cooldownMs !== undefined);
      if (enabled && trustLevel !== "creator" && context.peer) {
        const peerId = context.peer.id;

        // Per-destination cap checked first — more specific than peer cooldown or global limit.
        // When a destination has an explicit rateLimit, it governs itself; peer cooldown and
        // global cap are skipped for that destination.
        if (destHasExplicitLimit) {
          const destMsg = checkDestinationLimit(destination);
          if (destMsg) {
            return JSON.stringify({ status: "rate_limited", message: destMsg });
          }
        } else {
          // No per-destination limit — apply per-peer cooldown and global cap
          const peerMsg = checkPeerCooldown(peerId, destination.name);
          if (peerMsg) {
            return JSON.stringify({ status: "rate_limited", message: peerMsg });
          }
          const globalMsg = checkGlobalLimit();
          if (globalMsg) {
            return JSON.stringify({ status: "rate_limited", message: globalMsg });
          }
        }

        const dedupMsg = checkDedup(summary);
        if (dedupMsg) {
          return JSON.stringify({ status: "rate_limited", message: dedupMsg });
        }
      }

      const adapter = adapters[destination.transport];
      if (!adapter) {
        return JSON.stringify({
          status: "failed",
          message: `No adapter registered for transport '${destination.transport}'.`,
        });
      }

      let result: NotifyDeliveryResult;
      try {
        result = await adapter.deliver(destination, { summary, reason, visitor });
      } catch (err) {
        return JSON.stringify({
          status: "failed",
          message: `Adapter for '${destination.transport}' threw: ${(err as Error).message}`,
        });
      }

      if (result.status === "sent" && trustLevel !== "creator" && context.peer) {
        recordNotification(context.peer.id, summary, destination.name, destHasExplicitLimit);
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
