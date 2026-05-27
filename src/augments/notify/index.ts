/**
 * Notify augment — outbound messaging primitive.
 *
 * Routes the agent's `notify({to, summary, ...})` calls to operator-defined
 * destinations via internal adapter modules (webhook, telegram, agentmail). Owns the
 * rate-limit state lifted from manifest.ts (cooldown, dedup, global cap,
 * per-peer cooldown). Creator-class senders bypass rate limits.
 *
 * NOT a transport. NOT cross-augment-coupled. Internal adapters call the
 * shared src/telegram-client.ts (telegram adapter) or src/agentmail-client.ts
 * (agentmail adapter), or POST directly (webhook adapter).
 */

import { z } from "zod";
import type {
  AdminActionResult,
  AdminInfoBlock,
  Augment,
  NotifyAdapter,
  NotifyAugmentOptions,
  NotifyDeliveryResult,
  NotifyDestination,
  ToolExecuteContext,
} from "../../types";
import { defineTool } from "../../helpers";
import { readOverrides, writeOverrides } from "../../lib/admin-overrides";
import { createRingBuffer } from "../../lib/ring-buffer";
/**
 * Single source of truth for the transports notify ships. The type union
 * `NotifyAdapterKind` (src/types.ts) MUST stay in sync — the drift test
 * (tests/augments/notify-transport-drift.test.ts) and config-parser
 * exhaustiveness depend on this list. Adding an adapter: add the string
 * here + add the destination interface in src/types.ts + handle in the
 * config-parser destination validator + register the factory below.
 */
export const NOTIFY_TRANSPORTS = ["webhook", "telegram", "agentmail", "log-to-file"] as const;

import { createWebhookAdapter } from "./adapters/webhook";
import { createTelegramAdapter } from "./adapters/telegram";
import { createAgentMailAdapter } from "./adapters/agentmail";
import { createLogToFileAdapter } from "./adapters/log-to-file";

export interface NotifyAugmentInternalOptions extends NotifyAugmentOptions {
  /**
   * Test-only adapter override. Production code does not pass this.
   * Partial — missing keys fall back to default adapters.
   */
  adapters?: Partial<{
    webhook: NotifyAdapter;
    telegram: NotifyAdapter;
    agentmail: NotifyAdapter;
    "log-to-file": NotifyAdapter;
  }>;
}

export function notify(opts: NotifyAugmentInternalOptions): Augment {
  const defaults = {
    webhook: createWebhookAdapter(),
    telegram: createTelegramAdapter(),
    agentmail: createAgentMailAdapter(),
    "log-to-file": createLogToFileAdapter(),
  };
  const adapters = { ...defaults, ...(opts.adapters ?? {}) };

  const destinationsByName = new Map<string, NotifyDestination>();
  for (const d of opts.destinations) destinationsByName.set(d.name, d);

  const rl = opts.rateLimit ?? {};
  const enabled = rl.enabled !== false;
  const cooldownMs = rl.cooldownMs ?? 120_000;
  const yamlGlobalMaxPerHour = rl.globalMaxPerHour ?? 5;
  let globalMaxPerHour = yamlGlobalMaxPerHour;
  let globalMaxSource: "yaml" | "override" = "yaml";
  const dedupWindowMs = rl.dedupWindowMs ?? 300_000;
  const dedupThreshold = rl.dedupThreshold ?? 0.6;
  const perPeerCooldownMs = rl.perPeerCooldownMs ?? cooldownMs;

  if (opts.agentDir) {
    const overrides = readOverrides(opts.agentDir);
    const overrideVal = overrides?.overrides.notify?.globalMaxPerHour;
    if (overrideVal !== undefined) {
      globalMaxPerHour = overrideVal;
      globalMaxSource = "override";
    }
  }

  interface DispatchRecord {
    timestamp: string;
    destination: string;
    status: "sent" | "rate_limited" | "failed";
    summary: string;
  }
  const dispatches = createRingBuffer<DispatchRecord>(100);
  function recordDispatch(record: DispatchRecord): void {
    dispatches.push(record);
  }

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

  function recordNotification(
    peerId: string,
    summary: string,
    destName: string,
    destHasExplicitLimit: boolean,
  ): void {
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
      const destHasExplicitLimit = !!(
        destination.rateLimit?.maxPerHour !== undefined ||
        destination.rateLimit?.cooldownMs !== undefined
      );
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
        recordDispatch({
          timestamp: new Date().toISOString().slice(11, 19),
          destination: destination.name,
          status: "failed",
          summary,
        });
        return JSON.stringify({
          status: "failed",
          message: `Adapter for '${destination.transport}' threw: ${(err as Error).message}`,
        });
      }

      if (result.status === "sent" && trustLevel !== "creator" && context.peer) {
        recordNotification(context.peer.id, summary, destination.name, destHasExplicitLimit);
      }

      recordDispatch({
        timestamp: new Date().toISOString().slice(11, 19),
        destination: destination.name,
        status: result.status,
        summary,
      });

      return JSON.stringify({
        status: result.status,
        ...(result.detail ? { detail: result.detail } : {}),
      });
    },
  });

  async function dispatchTest(
    destinationName: string,
    summary: string,
  ): Promise<{ status: "sent" | "failed"; detail?: string }> {
    const dest = destinationsByName.get(destinationName);
    if (!dest) {
      return { status: "failed", detail: `unknown destination: ${destinationName}` };
    }
    const adapter = adapters[dest.transport];
    if (!adapter) {
      return { status: "failed", detail: `no adapter for transport: ${dest.transport}` };
    }
    try {
      const result = await adapter.deliver(dest, { summary: `[test] ${summary}` });
      return result;
    } catch (err) {
      return { status: "failed", detail: (err as Error).message };
    }
  }

  async function persistNotifyOverride(value: number): Promise<void> {
    if (!opts.agentDir) {
      throw new Error("agentDir not configured; admin overrides cannot persist");
    }
    const current = readOverrides(opts.agentDir) ?? {
      version: 1 as const,
      lastModified: new Date().toISOString(),
      lastModifiedBy: "creator",
      overrides: {},
    };
    current.lastModified = new Date().toISOString();
    current.lastModifiedBy = "creator";
    current.overrides.notify = {
      ...current.overrides.notify,
      globalMaxPerHour: value,
    };
    writeOverrides(opts.agentDir, current);
  }

  async function clearNotifyOverride(): Promise<void> {
    if (!opts.agentDir) return;
    const current = readOverrides(opts.agentDir);
    if (!current) return;
    if (current.overrides.notify) {
      delete (current.overrides.notify as Record<string, unknown>).globalMaxPerHour;
      if (Object.keys(current.overrides.notify).length === 0) {
        delete (current.overrides as Record<string, unknown>).notify;
      }
    }
    current.lastModified = new Date().toISOString();
    current.lastModifiedBy = "creator";
    writeOverrides(opts.agentDir, current);
  }

  async function adminInfo(): Promise<AdminInfoBlock> {
    const recentEvents = dispatches.snapshot().slice(-50);
    return {
      augmentName: "notify",
      title: "Notify",
      sections: [
        {
          kind: "keyValue",
          rows: [
            {
              label: "Global cap per hour",
              value: String(globalMaxPerHour),
              source: globalMaxSource === "override" ? "/admin override" : "yaml",
              resetAction: { id: "notify-cap-reset", label: "Reset to yaml" },
            },
            { label: "Cooldown (ms)", value: String(cooldownMs), source: "yaml" },
            { label: "Destinations", value: String(opts.destinations.length) },
          ],
        },
        {
          kind: "table",
          columns: ["Time", "Destination", "Status", "Summary"],
          rows: recentEvents.map((e) => [
            e.timestamp,
            e.destination,
            e.status,
            e.summary.slice(0, 80),
          ]),
          caption: `Recent dispatches (${recentEvents.length})`,
        },
      ],
      actions: [
        {
          id: "notify-test",
          label: "Send test notification",
          confirmRequired: false,
          inputs: [
            {
              name: "destination",
              label: "Destination name",
              type: "text",
              required: true,
            },
            {
              name: "message",
              label: "Message",
              type: "text",
              required: false,
              default: "Test from /admin",
            },
          ],
        },
        {
          id: "notify-cap-adjust",
          label: "Adjust globalMaxPerHour",
          confirmRequired: true,
          inputs: [
            {
              name: "value",
              label: "New value (positive integer)",
              type: "number",
              required: true,
              helpText: "Persists across restart via admin-overrides.json.",
            },
          ],
        },
      ],
    };
  }

  const adminActions: Record<
    string,
    (params: Record<string, unknown>) => Promise<AdminActionResult>
  > = {
    "notify-test": async (params) => {
      const dest = typeof params.destination === "string" ? params.destination : "";
      const message =
        typeof params.message === "string" && params.message ? params.message : "Test from /admin";
      if (!dest) {
        return { ok: false, message: "destination is required" };
      }
      const result = await dispatchTest(dest, message);
      recordDispatch({
        timestamp: new Date().toISOString().slice(11, 19),
        destination: dest,
        status: result.status,
        summary: `[test] ${message}`,
      });
      if (result.status === "sent") {
        return { ok: true, message: `Test notification sent to ${dest}` };
      }
      return { ok: false, message: `Test failed: ${result.detail ?? "unknown error"}` };
    },
    "notify-cap-adjust": async (params) => {
      const raw = params.value;
      const value = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
        return {
          ok: false,
          message: `invalid value: must be a positive integer (got ${String(raw)})`,
        };
      }
      try {
        await persistNotifyOverride(value);
      } catch (err) {
        return {
          ok: false,
          message: `could not persist override: ${(err as Error).message}`,
        };
      }
      globalMaxPerHour = value;
      globalMaxSource = "override";
      return { ok: true, message: `globalMaxPerHour set to ${value}` };
    },
    "notify-cap-reset": async () => {
      try {
        await clearNotifyOverride();
      } catch (err) {
        return {
          ok: false,
          message: `could not clear override: ${(err as Error).message}`,
        };
      }
      globalMaxPerHour = yamlGlobalMaxPerHour;
      globalMaxSource = "yaml";
      return { ok: true, message: "globalMaxPerHour reset to yaml value" };
    },
  };

  return {
    name: "notify",
    capabilities: ["tools"],
    tools: [notifyTool],
    adminInfo,
    adminActions,
  };
}
