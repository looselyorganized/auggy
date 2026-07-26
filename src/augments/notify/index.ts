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

import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type {
  AdminActionResult,
  AdminInfoBlock,
  Augment,
  NotifyAdapter,
  NotifyAugmentOptions,
  NotifyDeliveryResult,
  NotifyDestination,
  TrustLevel,
  ToolExecuteContext,
} from "../../types";
import { defineTool } from "../../helpers";
import {
  readOverrides,
  releaseAdminOverrideRoot,
  retainAdminOverrideRoot,
  writeOverrides,
} from "../../lib/admin-overrides";
import { createRingBuffer } from "../../lib/ring-buffer";
import { createNotifyDeliveryStore, type NotifyDeliveryStore } from "./delivery-store";
/**
 * Single source of truth for the transports notify ships. The type union
 * `NotifyAdapterKind` (src/types.ts) MUST stay in sync — the drift test
 * (tests/augments/notify-transport-drift.test.ts) and config-parser
 * exhaustiveness depend on this list. Adding an adapter: add the string
 * here + add the destination interface in src/types.ts + handle in the
 * config-parser destination validator + register the factory below.
 */
export const NOTIFY_TRANSPORTS = ["webhook", "telegram", "agentmail", "log-to-file"] as const;
const DEFAULT_ALLOWED_TRUST_LEVELS: readonly TrustLevel[] = ["creator", "agent"];

import { createWebhookAdapter } from "./adapters/webhook";
import { createTelegramAdapter } from "./adapters/telegram";
import { createAgentMailAdapter } from "./adapters/agentmail";
import { createLogToFileAdapter } from "./adapters/log-to-file";

export interface NotifyAugmentInternalOptions extends NotifyAugmentOptions {
  /** Canonical shared directory for admin-overrides.json. Defaults to agentDir. */
  overrideDir?: string;
  /** Deployment-owned durable state path. Production resolution always supplies this. */
  dbPath?: string;
  /** Test-only durable delivery store override. */
  _deliveryStore?: NotifyDeliveryStore;
  /** Test-only explicit opt-in to a volatile SQLite store. */
  _allowVolatileStore?: boolean;
  /** Test-only clock and identifier seams. */
  _now?: () => number;
  _attemptId?: () => string;
  _incidentId?: () => string;
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
  const overrideDir = opts.overrideDir ?? opts.agentDir;
  let overrideRootRetained = false;
  const defaults = {
    webhook: createWebhookAdapter(),
    telegram: createTelegramAdapter(),
    agentmail: createAgentMailAdapter(),
    "log-to-file": createLogToFileAdapter(),
  };
  const adapters = { ...defaults, ...(opts.adapters ?? {}) };
  const now = opts._now ?? Date.now;
  const ownsDeliveryStore = !opts._deliveryStore;
  const resolvedDbPath =
    opts.dbPath ?? (opts.agentDir ? join(opts.agentDir, "notify-delivery.db") : undefined);
  if (!opts._deliveryStore && !resolvedDbPath) {
    throw new Error(
      "notify: dbPath is required when agentDir is not provided; durable delivery state cannot use memory",
    );
  }
  if (!opts._deliveryStore && resolvedDbPath === ":memory:" && !opts._allowVolatileStore) {
    throw new Error("notify: volatile delivery state is restricted to the explicit test seam");
  }
  const deliveryStoreOptions = {
    dbPath: resolvedDbPath!,
    now,
    attemptId: opts._attemptId,
    incidentId: opts._incidentId,
  };
  let deliveryStore = opts._deliveryStore ?? createNotifyDeliveryStore(deliveryStoreOptions);
  let ownedDeliveryStoreClosed = false;

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

  if (overrideDir) {
    overrideRootRetained = retainAdminOverrideRoot(overrideDir);
    try {
      const overrides = readOverrides(overrideDir);
      const overrideVal = overrides?.overrides.notify?.globalMaxPerHour;
      if (overrideVal !== undefined) {
        globalMaxPerHour = overrideVal;
        globalMaxSource = "override";
      }
    } catch (error) {
      if (overrideRootRetained) {
        releaseAdminOverrideRoot(overrideDir);
        overrideRootRetained = false;
      }
      throw error;
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

  const recentSummaries: Array<{ summary: string; timestamp: number }> = [];

  function checkDedup(summary: string): string | null {
    if (dedupThreshold <= 0) return null;
    const timestamp = now();
    while (
      recentSummaries.length > 0 &&
      timestamp - recentSummaries[0]!.timestamp > dedupWindowMs
    ) {
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

  function allowedTrustLevels(destination: NotifyDestination): readonly TrustLevel[] {
    return destination.allowedTrustLevels ?? DEFAULT_ALLOWED_TRUST_LEVELS;
  }

  function checkDestinationAuthority(
    destination: NotifyDestination,
    trustLevel: TrustLevel,
    reason: string | undefined,
  ): string | null {
    const allowed = allowedTrustLevels(destination);
    if (!allowed.includes(trustLevel)) {
      return `Notification destination '${destination.name}' is not available to ${trustLevel} peers. Allowed trust levels: ${allowed.join(", ")}.`;
    }
    if (
      trustLevel === "public" &&
      destination.publicPolicy === "escalation-only" &&
      !reason?.trim()
    ) {
      return `Notification destination '${destination.name}' only accepts public-originated escalation notifications. Include a reason explaining the escalation.`;
    }
    return null;
  }

  function recordNotification(summary: string): void {
    if (dedupThreshold > 0) recentSummaries.push({ summary, timestamp: now() });
  }

  function hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }

  function operationHash(input: {
    peerId: string;
    threadId: string;
    destination: string;
    summary: string;
    reason?: string;
    visitor?: string;
  }): string {
    return hash(
      JSON.stringify([
        input.peerId,
        input.threadId,
        input.destination,
        input.summary,
        input.reason ?? null,
        input.visitor ?? null,
      ]),
    );
  }

  function unknownDelivery(incidentId?: string) {
    return {
      content: JSON.stringify({
        status: "failed",
        message:
          "Notification dispatch ended without a trustworthy delivery result; outcome is unknown and operator reconciliation is required.",
        ...(incidentId ? { incidentId } : {}),
      }),
      isError: true,
      outcomeUnknown: true,
    } as const;
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
      const authorityMsg = checkDestinationAuthority(destination, trustLevel, reason);
      if (authorityMsg) {
        return JSON.stringify({ status: "failed", message: authorityMsg });
      }

      const destHasExplicitLimit = !!(
        destination.rateLimit?.maxPerHour !== undefined ||
        destination.rateLimit?.cooldownMs !== undefined
      );
      if (enabled && trustLevel !== "creator" && context.peer) {
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
      if (context.signal?.aborted) {
        return JSON.stringify({
          status: "failed",
          message: "Notification canceled before dispatch.",
        });
      }

      const peerId = context.peer?.id ?? "system";
      const enforceRate = enabled && trustLevel !== "creator" && context.peer !== null;
      let reservation: ReturnType<NotifyDeliveryStore["reserve"]>;
      try {
        reservation = deliveryStore.reserve({
          operationHash: operationHash({
            peerId,
            threadId: context.threadId,
            destination: destination.name,
            summary,
            reason,
            visitor,
          }),
          threadId: context.threadId,
          peerHash: hash(peerId),
          destination: destination.name,
          summaryHash: hash(summary),
          policy: {
            enforce: enforceRate,
            globalMaxPerHour,
            perPeerCooldownMs,
            dedupWindowMs,
            destinationExplicit: destHasExplicitLimit,
            destinationMaxPerHour: destination.rateLimit?.maxPerHour,
            destinationCooldownMs: destination.rateLimit?.cooldownMs,
          },
        });
      } catch {
        return JSON.stringify({
          status: "failed",
          message: "Notification was not dispatched because durable delivery state is unavailable.",
        });
      }
      if (reservation.status === "rate_limited") {
        return JSON.stringify({ status: "rate_limited", message: reservation.message });
      }
      if (reservation.status === "in_flight") {
        return JSON.stringify({
          status: "failed",
          message: "The same notification is already being dispatched.",
        });
      }
      if (reservation.status === "outcome_unknown") {
        return unknownDelivery(reservation.incidentId);
      }
      if (enforceRate) recordNotification(summary);

      let result: NotifyDeliveryResult;
      try {
        result = await adapter.deliver(
          destination,
          { summary, reason, visitor },
          { signal: context.signal },
        );
      } catch {
        let incidentId: string | undefined;
        try {
          incidentId = deliveryStore.settle(
            reservation.attemptId,
            "outcome_unknown",
            "adapter-threw",
          )?.id;
        } catch {
          // The pending reservation remains fail-closed and is promoted on restart.
        }
        recordDispatch({
          timestamp: new Date().toISOString().slice(11, 19),
          destination: destination.name,
          status: "failed",
          summary,
        });
        return unknownDelivery(incidentId);
      }

      recordDispatch({
        timestamp: new Date().toISOString().slice(11, 19),
        destination: destination.name,
        status: result.status,
        summary,
      });

      if (result.status !== "sent" && result.status !== "failed") {
        try {
          deliveryStore.settle(reservation.attemptId, "outcome_unknown", "invalid-adapter-result");
        } catch {
          // The pending reservation remains fail-closed and is promoted on restart.
        }
        return unknownDelivery();
      }

      let incidentId: string | undefined;
      try {
        incidentId = deliveryStore.settle(
          reservation.attemptId,
          result.outcomeUnknown ? "outcome_unknown" : result.status,
          result.outcomeUnknown ? "adapter-reported-unknown" : undefined,
        )?.id;
      } catch {
        return unknownDelivery();
      }

      if (result.outcomeUnknown) return unknownDelivery(incidentId);
      return JSON.stringify({
        status: result.status,
        ...(result.detail ? { detail: result.detail } : {}),
      });
    },
  });

  async function dispatchTest(
    destinationName: string,
    summary: string,
  ): Promise<{
    status: "sent" | "failed";
    detail?: string;
    outcomeUnknown?: boolean;
    incidentId?: string;
  }> {
    const dest = destinationsByName.get(destinationName);
    if (!dest) {
      return { status: "failed", detail: `unknown destination: ${destinationName}` };
    }
    const adapter = adapters[dest.transport];
    if (!adapter) {
      return { status: "failed", detail: `no adapter for transport: ${dest.transport}` };
    }
    let reservation: ReturnType<NotifyDeliveryStore["reserve"]> | undefined;
    try {
      const payloadSummary = `[test] ${summary}`;
      reservation = deliveryStore.reserve({
        operationHash: operationHash({
          peerId: "admin",
          threadId: "notify-admin",
          destination: destinationName,
          summary: payloadSummary,
        }),
        threadId: "notify-admin",
        peerHash: hash("admin"),
        destination: destinationName,
        summaryHash: hash(payloadSummary),
        policy: {
          enforce: false,
          globalMaxPerHour,
          perPeerCooldownMs,
          dedupWindowMs,
          destinationExplicit: false,
        },
      });
      if (reservation.status === "outcome_unknown") {
        return {
          status: "failed",
          outcomeUnknown: true,
          incidentId: reservation.incidentId,
        };
      }
      if (reservation.status !== "reserved") {
        return { status: "failed", detail: "an equivalent test notification is in progress" };
      }
      const result = await adapter.deliver(dest, { summary: payloadSummary });
      if (result.outcomeUnknown) {
        const incident = deliveryStore.settle(
          reservation.attemptId,
          "outcome_unknown",
          "admin-test-outcome-unknown",
        );
        return {
          status: "failed",
          outcomeUnknown: true,
          incidentId: incident?.id,
        };
      }
      deliveryStore.settle(reservation.attemptId, result.status);
      return result;
    } catch {
      if (!reservation) {
        return {
          status: "failed",
          detail: "durable delivery state is unavailable; provider was not called",
        };
      }
      if (reservation.status === "reserved") {
        try {
          const incident = deliveryStore.settle(
            reservation.attemptId,
            "outcome_unknown",
            "admin-test-threw",
          );
          return {
            status: "failed",
            outcomeUnknown: true,
            incidentId: incident?.id,
          };
        } catch {
          // Pending durable state still prevents blind replay and is promoted on restart.
        }
      }
      return {
        status: "failed",
        outcomeUnknown: true,
      };
    }
  }

  async function persistNotifyOverride(value: number): Promise<void> {
    if (!overrideDir) {
      throw new Error("override storage not configured; admin overrides cannot persist");
    }
    const current = readOverrides(overrideDir) ?? {
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
    writeOverrides(overrideDir, current);
  }

  async function clearNotifyOverride(): Promise<void> {
    if (!overrideDir) return;
    const current = readOverrides(overrideDir);
    if (!current) return;
    if (current.overrides.notify) {
      delete (current.overrides.notify as Record<string, unknown>).globalMaxPerHour;
      if (Object.keys(current.overrides.notify).length === 0) {
        delete (current.overrides as Record<string, unknown>).notify;
      }
    }
    current.lastModified = new Date().toISOString();
    current.lastModifiedBy = "creator";
    writeOverrides(overrideDir, current);
  }

  async function adminInfo(): Promise<AdminInfoBlock> {
    const recentEvents = dispatches.snapshot().slice(-50);
    const incidents = deliveryStore.listIncidents(50);
    const destinationRows = opts.destinations.map((d) => [
      d.name,
      d.transport,
      allowedTrustLevels(d).join(", "),
      d.publicPolicy ?? "allowed",
      d.rateLimit
        ? [
            d.rateLimit.maxPerHour === undefined ? null : `max ${d.rateLimit.maxPerHour}/hr`,
            d.rateLimit.cooldownMs === undefined ? null : `${d.rateLimit.cooldownMs}ms cooldown`,
          ]
            .filter(Boolean)
            .join("; ") || "configured"
        : "global",
    ]);
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
              source: globalMaxSource === "override" ? "/console override" : "yaml",
              resetAction: { id: "notify-cap-reset", label: "Reset to yaml" },
            },
            { label: "Cooldown (ms)", value: String(cooldownMs), source: "yaml" },
            { label: "Destinations", value: String(opts.destinations.length) },
            { label: "Outcome unknown", value: String(incidents.length) },
          ],
        },
        {
          kind: "table",
          columns: ["Destination", "Transport", "Allowed trust", "Public policy", "Limit"],
          rows: destinationRows,
          caption: "Destination authority and rate-limit policy.",
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
        {
          kind: "table",
          columns: ["Incident", "Destination", "Reason", "Version", "Detected"],
          rows: incidents.map((incident) => [
            incident.id,
            incident.destination,
            incident.reasonCode,
            String(incident.version),
            new Date(incident.detectedAt).toISOString(),
          ]),
          caption:
            "Outcome-unknown deliveries. Verify the provider before reconciling; payloads are not retained here.",
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
              default: "Test from /console",
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
        {
          id: "notify-delivery-reconcile-delivered",
          label: "Confirm ambiguous notification was delivered",
          confirmRequired: true,
          inputs: notifyRecoveryInputs(
            "Use only after confirming the provider accepted the notification.",
          ),
        },
        {
          id: "notify-delivery-reconcile-no-effect",
          label: "Confirm ambiguous notification had no effect",
          confirmRequired: true,
          inputs: notifyRecoveryInputs(
            "Use only after confirming the provider did not accept the notification.",
          ),
        },
      ],
    };
  }

  function notifyRecoveryInputs(helpText: string) {
    return [
      { name: "incidentId", label: "Incident ID", type: "text" as const, required: true },
      { name: "version", label: "Expected version", type: "number" as const, required: true },
      {
        name: "evidence",
        label: "Verification evidence",
        type: "text" as const,
        required: true,
        helpText,
      },
    ];
  }

  function reconcileDelivery(
    params: Record<string, unknown>,
    disposition: "confirmed-delivered" | "confirmed-no-effect",
  ): AdminActionResult {
    const incidentId = typeof params.incidentId === "string" ? params.incidentId.trim() : "";
    const version = typeof params.version === "number" ? params.version : Number(params.version);
    const evidence = typeof params.evidence === "string" ? params.evidence.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(incidentId)) {
      return { ok: false, message: "A valid incident ID is required" };
    }
    if (!Number.isSafeInteger(version) || version < 1) {
      return { ok: false, message: "A valid expected incident version is required" };
    }
    if (!evidence || evidence.length > 400) {
      return { ok: false, message: "Verification evidence must contain 1 to 400 characters" };
    }
    const resolved = deliveryStore.reconcile({
      incidentId,
      expectedVersion: version,
      disposition,
      evidence,
    });
    if (!resolved.resolved || !resolved.threadId) {
      return { ok: false, message: "Incident is stale, resolved, or does not match" };
    }
    return {
      ok: true,
      message:
        disposition === "confirmed-delivered"
          ? "Notification incident reconciled as delivered"
          : "Notification incident reconciled as having no external effect",
      recoverThreadId: resolved.releaseThread ? resolved.threadId : undefined,
    };
  }

  const adminActions: Record<
    string,
    (params: Record<string, unknown>) => Promise<AdminActionResult>
  > = {
    "notify-test": async (params) => {
      const dest = typeof params.destination === "string" ? params.destination : "";
      const message =
        typeof params.message === "string" && params.message
          ? params.message
          : "Test from /console";
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
      if (result.outcomeUnknown) {
        return {
          ok: false,
          message: `Test delivery outcome is unknown${result.incidentId ? ` (incident ${result.incidentId})` : ""}; operator reconciliation is required`,
        };
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
    "notify-delivery-reconcile-delivered": async (params) =>
      reconcileDelivery(params, "confirmed-delivered"),
    "notify-delivery-reconcile-no-effect": async (params) =>
      reconcileDelivery(params, "confirmed-no-effect"),
  };

  return {
    name: "notify",
    type: "notify",
    category: "transports",
    tools: [notifyTool],
    adminInfo,
    adminActions,
    durableThreadQuarantine: {
      listThreadIds: () => deliveryStore.listIncidentThreads(),
      hasThread: (threadId) => deliveryStore.hasIncidentThread(threadId),
    },
    onBoot: async () => {
      if (ownsDeliveryStore && ownedDeliveryStoreClosed) {
        deliveryStore = createNotifyDeliveryStore(deliveryStoreOptions);
        ownedDeliveryStoreClosed = false;
      }
      deliveryStore.prepareForRuntime();
    },
    onShutdown: async () => {
      try {
        if (ownsDeliveryStore) {
          deliveryStore.close();
          ownedDeliveryStoreClosed = true;
        }
      } finally {
        if (overrideRootRetained) {
          releaseAdminOverrideRoot(overrideDir);
          overrideRootRetained = false;
        }
      }
    },
  };
}
