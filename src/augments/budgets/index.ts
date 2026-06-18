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
import type { BudgetsConfig, BudgetCaps } from "./types";
import { buildBudgetPreamble } from "./preamble";

export interface BudgetsAugmentOptions extends BudgetsConfig {
  /** Storage backend. Only "sqlite" is supported in v0. */
  backend?: "sqlite";
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

export function budgets(opts: BudgetsAugmentOptions): Augment {
  const store: BudgetStore = createBudgetStore({
    dbPath: opts.dbPath,
    cleanupWindowMs: opts.cleanupWindowMs,
  });

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
    async commit({ turnId, peer, cost }): Promise<void> {
      if (!peer || peer.trustLevel === "creator") return;
      await store.commit(turnId, peer.id, cost);
    },
  };

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
            .map((p) => [p.peerId, `$${p.costUsd.toFixed(2)}`, String(p.turnCount)]),
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
