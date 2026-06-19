import type {
  AdminActionResult,
  AdminInfoBlock,
  Augment,
  ContextBlock,
  PeerIdentity,
  TurnGateProvider,
  TurnGateTicket,
  TurnState,
} from "../../types";
import { readOverrides, writeOverrides } from "../../lib/admin-overrides";
import { createBudgetStore, type BudgetStore } from "./budget-store";
import type {
  BudgetsConfig,
  BudgetCaps,
  BudgetThresholdNotificationDispatcher,
  BudgetThresholdNotifications,
} from "./types";
import { buildBudgetPreamble } from "./preamble";

export interface BudgetsAugmentOptions extends BudgetsConfig {
  /** Storage backend. Only "sqlite" is supported in v0. */
  backend?: "sqlite";
  /** Resolver/test hook for sending configured threshold notifications. */
  notificationDispatcher?: BudgetThresholdNotificationDispatcher;
}

/**
 * Resolve the BudgetCaps for a peer based on their trust level and, for
 * public-trust peers, their publicSubstate.
 *
 *   creator             → null (bypass — no store write)
 *   agent               → config.caps?.agent ?? null
 *   public:anonymous    → config.caps?.public?.anonymous ?? null
 *   public:recognized   → config.caps?.public?.recognized ?? null
 *
 * A null peer (internal/scheduled trigger) also bypasses.
 */
function resolveCaps(peer: PeerIdentity | null, config: BudgetsConfig): BudgetCaps | null {
  if (!peer) return null;
  switch (peer.trustLevel) {
    case "creator":
      return null;
    case "agent":
      return config.caps?.agent ?? null;
    case "public":
      return peer.publicSubstate === "recognized"
        ? (config.caps?.public?.recognized ?? null)
        : (config.caps?.public?.anonymous ?? null);
    default:
      return null;
  }
}

const DEFAULT_NOTIFICATION_THRESHOLDS = [0.5, 0.8, 1] as const;

function normalizeThresholds(config: BudgetThresholdNotifications | undefined): number[] {
  if (!config || config.enabled === false) return [];
  const raw = config.thresholds ?? [...DEFAULT_NOTIFICATION_THRESHOLDS];
  const unique = new Set<number>();
  for (const value of raw) {
    if (Number.isFinite(value) && value > 0 && value <= 1) unique.add(value);
  }
  return [...unique].sort((a, b) => a - b);
}

function formatPercent(threshold: number): string {
  return `${Math.round(threshold * 100)}%`;
}

export function budgets(opts: BudgetsAugmentOptions): Augment {
  const store: BudgetStore = createBudgetStore({
    dbPath: opts.dbPath,
    cleanupWindowMs: opts.cleanupWindowMs,
  });
  const notificationThresholds = normalizeThresholds(opts.notifications);
  const sentThresholds = new Set<string>();

  // G36 — dailyBudgetUsd is mutable at runtime via /admin. The yaml value
  // (opts.dailyBudgetUsd) is the boot-time default; an override in
  // admin-overrides.json takes precedence. Subsequent admin-cap-adjust
  // actions mutate the closure and re-persist.
  const yamlDailyBudgetUsd = opts.dailyBudgetUsd;
  let currentDailyBudgetUsd = yamlDailyBudgetUsd;
  let dailyBudgetSource: "yaml" | "override" = "yaml";

  if (opts.agentDir) {
    const overrides = readOverrides(opts.agentDir);
    const overrideVal = overrides?.overrides.budgets?.dailyBudgetUsd;
    if (overrideVal !== undefined) {
      currentDailyBudgetUsd = overrideVal;
      dailyBudgetSource = "override";
    }
  }

  // Periodic sweep: mark reservations stuck in pending state (engine errored
  // before commit) as 'allow:incomplete'. Fire at half the cleanup window so
  // stale turns are caught within at most cleanupWindowMs of becoming stale.
  const cleanupWindowMs = opts.cleanupWindowMs ?? 60 * 60_000; // default 1 hour
  const sweepIntervalMs = Math.max(60_000, Math.floor(cleanupWindowMs / 2));
  const sweepTimer = setInterval(() => {
    store.sweepIncompleteReservations({ olderThanMs: cleanupWindowMs }).catch((err) => {
      console.error("[budgets] sweep failed:", err);
    });
  }, sweepIntervalMs);
  // Don't keep the process alive just for the sweeper.
  sweepTimer.unref();

  const turnGate: TurnGateProvider = {
    /**
     * PREPARE — delegates to the store. The store opens a SQLite transaction,
     * evaluates caps, stages writes, returns a ticket whose confirm/rollback
     * close the transaction. The augment is a thin pass-through.
     *
     * Creator and null peer (internal trigger) bypass entirely. Return a no-op
     * ticket — no transaction opened, no rows staged.
     */
    async prepare({ turnId, peer, threadId }): Promise<TurnGateTicket> {
      if (!peer || peer.trustLevel === "creator") {
        return {
          decision: { allow: true },
          confirm: async () => {},
          rollback: async () => {},
        };
      }

      const caps = resolveCaps(peer, opts);
      return store.prepare({
        turnId,
        peerId: peer.id,
        threadId,
        trustLevel: peer.trustLevel,
        publicSubstate: peer.publicSubstate ?? null,
        caps,
        anonymousGlobalLimit: opts.anonymousGlobalLimit,
        dailyBudgetUsd: currentDailyBudgetUsd,
      });
    },

    /**
     * COMMIT — post-response cost recording. Skips creator and null-peer turns
     * (their prepare returned a no-op ticket; nothing in the store to commit
     * against).
     */
    async commit({ turnId, peer, threadId, cost }): Promise<void> {
      if (!peer || peer.trustLevel === "creator") return;
      const record = await store.commit(turnId, peer.id, cost);
      if (!record?.priced) return;
      await maybeDispatchThresholdNotification({
        turnId,
        peerId: peer.id,
        threadId,
        day: record.day,
      });
    },
  };

  async function maybeDispatchThresholdNotification(input: {
    turnId: string;
    peerId: string;
    threadId: string;
    day: string;
  }): Promise<void> {
    if (!opts.notifications || opts.notifications.enabled === false) return;
    if (!opts.notificationDispatcher) return;
    if (notificationThresholds.length === 0) return;
    if (currentDailyBudgetUsd === undefined) return;

    const spend = await store.getDaySpend(input.day);
    const ratio = spend.totalUsd / currentDailyBudgetUsd;
    const crossed = notificationThresholds.filter(
      (threshold) => ratio >= threshold && !sentThresholds.has(`${input.day}:${threshold}`),
    );
    if (crossed.length === 0) return;

    for (const threshold of crossed) {
      sentThresholds.add(`${input.day}:${threshold}`);
    }
    const threshold = crossed[crossed.length - 1]!;
    const percent = formatPercent(threshold);
    const summary = `Budget threshold reached: ${percent} of daily budget used`;
    const reason = [
      `Daily budget spend is $${spend.totalUsd.toFixed(2)} of $${currentDailyBudgetUsd.toFixed(2)} for ${input.day}.`,
      `Triggered by peer ${input.peerId}.`,
    ].join(" ");

    try {
      await opts.notificationDispatcher({
        destination: opts.notifications.destination,
        threshold,
        day: input.day,
        totalUsd: spend.totalUsd,
        dailyBudgetUsd: currentDailyBudgetUsd,
        peerId: input.peerId,
        turnId: input.turnId,
        threadId: input.threadId,
        summary,
        reason,
      });
    } catch (err) {
      console.error("[budgets] threshold notification failed:", err);
    }
  }

  async function persistDailyBudgetOverride(value: number): Promise<void> {
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
    current.overrides.budgets = {
      ...current.overrides.budgets,
      dailyBudgetUsd: value,
    };
    writeOverrides(opts.agentDir, current);
  }

  async function clearDailyBudgetOverride(): Promise<void> {
    if (!opts.agentDir) return;
    const current = readOverrides(opts.agentDir);
    if (!current) return;
    if (current.overrides.budgets) {
      delete (current.overrides.budgets as Record<string, unknown>).dailyBudgetUsd;
      if (Object.keys(current.overrides.budgets).length === 0) {
        delete (current.overrides as Record<string, unknown>).budgets;
      }
    }
    current.lastModified = new Date().toISOString();
    current.lastModifiedBy = "creator";
    writeOverrides(opts.agentDir, current);
  }

  function formatCap(v: number | undefined): string {
    return v === undefined ? "(unlimited)" : `$${v.toFixed(2)}`;
  }

  function formatPricingConfidence(unpricedTurns: number): string {
    if (unpricedTurns === 0) return "priced";
    const noun = unpricedTurns === 1 ? "turn" : "turns";
    return `degraded (${unpricedTurns} unpriced ${noun} today)`;
  }

  async function adminInfo(): Promise<AdminInfoBlock> {
    const spend = await store.getDaySpend();
    return {
      augmentName: "budgets",
      title: "Budgets",
      sections: [
        {
          kind: "keyValue",
          rows: [
            { label: "Status", value: "preview" },
            {
              label: "Guardrail model",
              value: "runtime spend guardrails; not billing control",
            },
            {
              label: "USD enforcement",
              value: "post-hoc soft cap; provider-side hard caps still required",
            },
            { label: "Storage", value: "SQLite; single-process and single-replica" },
            { label: "Retention", value: "no built-in purge policy" },
            {
              label: "Daily budget cap",
              value: formatCap(currentDailyBudgetUsd),
              source: dailyBudgetSource === "override" ? "/console override" : "yaml",
              resetAction: { id: "budget-cap-reset", label: "Reset to yaml" },
            },
            { label: "Today's spend", value: `$${spend.totalUsd.toFixed(2)}` },
            { label: "Pricing confidence", value: formatPricingConfidence(spend.unpricedTurns) },
            {
              label: "Threshold notifications",
              value:
                opts.notifications && opts.notifications.enabled !== false
                  ? `to ${opts.notifications.destination} at ${notificationThresholds.map(formatPercent).join(", ")}`
                  : "off",
            },
            {
              label: "Active peers today",
              value: String(spend.byPeer.length),
            },
          ],
        },
        {
          kind: "table",
          columns: ["Peer", "Today's cost", "Unpriced turns"],
          rows: spend.byPeer
            .slice(0, 50)
            .map((p) => [p.peerId, `$${p.costUsd.toFixed(2)}`, String(p.unpricedTurns)]),
          caption:
            spend.byPeer.length > 50
              ? `Showing 50 of ${spend.byPeer.length} peers`
              : `${spend.byPeer.length} peer(s) with spend today`,
        },
      ],
      actions: [
        {
          id: "budget-cap-adjust",
          label: "Adjust daily budget cap",
          confirmRequired: true,
          inputs: [
            {
              name: "value",
              label: "New daily cap (USD)",
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
    "budget-cap-adjust": async (params) => {
      const raw = params.value;
      const value = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        return {
          ok: false,
          message: `invalid value: must be a positive number (got ${String(raw)})`,
        };
      }
      try {
        await persistDailyBudgetOverride(value);
      } catch (err) {
        return {
          ok: false,
          message: `could not persist override: ${(err as Error).message}; agent state unchanged`,
        };
      }
      currentDailyBudgetUsd = value;
      dailyBudgetSource = "override";
      return { ok: true, message: `Daily budget cap updated to $${value.toFixed(2)}` };
    },
    "budget-cap-reset": async () => {
      try {
        await clearDailyBudgetOverride();
      } catch (err) {
        return {
          ok: false,
          message: `could not clear override: ${(err as Error).message}`,
        };
      }
      currentDailyBudgetUsd = yamlDailyBudgetUsd;
      dailyBudgetSource = "yaml";
      return { ok: true, message: "Daily budget cap reset to yaml value" };
    },
  };

  return {
    name: "budgets",
    type: "budgets",
    category: "guardrails",
    capabilities: ["context", "lifecycle"],
    turnGate,
    adminInfo,
    adminActions,

    /**
     * BATS-style budget context block. Reads peer usage from the store
     * and emits a ContextBlock describing remaining capacity and behavioral
     * guidance. Called after the turn-gate 2PC confirm, so `used` already
     * counts the current turn as consumed — remaining values are post-this-turn.
     */
    context: async (turn: TurnState): Promise<ContextBlock[]> => {
      const peer = turn.peer;
      if (!peer) return [];
      const caps = resolveCaps(peer, opts);
      if (caps === null) return [];
      const used = await store.getPeerUsage(peer.id, turn.threadId);
      const block = buildBudgetPreamble({ caps, used });
      return block ? [block] : [];
    },

    onShutdown: async () => {
      clearInterval(sweepTimer);
      await store.close();
    },
  };
}
