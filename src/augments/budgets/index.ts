import type {
  Augment,
  PeerIdentity,
  TurnGateProvider,
  TurnGateTicket,
  ContextBlock,
  TurnState,
} from "../../types";
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
  if (typeof sweepTimer === "object" && sweepTimer !== null && "unref" in sweepTimer) {
    (sweepTimer as { unref(): void }).unref();
  }

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
        dailyBudgetUsd: opts.dailyBudgetUsd,
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

  return {
    name: "budgets",
    capabilities: ["context", "lifecycle"],
    turnGate,

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
