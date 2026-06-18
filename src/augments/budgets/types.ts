import type { TrustLevel } from "../../types";

/**
 * Per-trust-level spend and turn caps. All fields optional — omit a cap
 * to leave it unconstrained.
 */
export interface BudgetCaps {
  /** Maximum USD spend per calendar day for this peer. */
  maxUsdPerDay?: number;
  /** Maximum turns per thread per calendar day. */
  maxTurnsPerThread?: number;
  /** Maximum turns across all threads per calendar day for this peer. */
  maxTurnsPerDay?: number;
}

export interface BudgetThresholdNotifications {
  /** Set false to keep the config block documented but inactive. */
  enabled?: boolean;
  /** Named notify destination to receive threshold alerts. */
  destination: string;
  /**
   * DailyBudgetUsd fractions to alert on. Values are ratios in (0, 1].
   * Defaults to [0.5, 0.8, 1].
   */
  thresholds?: number[];
}

export interface BudgetThresholdNotificationPayload {
  destination: string;
  threshold: number;
  day: string;
  totalUsd: number;
  dailyBudgetUsd: number;
  peerId: string;
  turnId: string;
  threadId: string;
  summary: string;
  reason: string;
}

export type BudgetThresholdNotificationDispatcher = (
  payload: BudgetThresholdNotificationPayload,
) => Promise<void>;

/**
 * Differentiated caps for the public trust level, split by publicSubstate.
 * anonymous (no identity): tighter defaults (5 turns/thread, no daily).
 * recognized (cookie/token-identified): looser defaults (20 turns/thread, 50/day, $1/day).
 */
export interface PublicBudgets {
  anonymous?: BudgetCaps;
  recognized?: BudgetCaps;
}

/**
 * Full budgets augment config (passed by the T7 factory).
 * creator omitted from caps = bypass entirely (no caps, no store write).
 */
export interface BudgetsConfig {
  dbPath: string;
  caps?: {
    /** Caps for agent-trust peers. Omit = no caps for agents. */
    agent?: BudgetCaps;
    /**
     * Caps for public-trust peers, differentiated by publicSubstate.
     * Omit = no caps for public peers.
     */
    public?: PublicBudgets;
    // creator omitted = bypass entirely
  };
  /**
   * Facility-wide limit on anonymous prepares per rolling minute.
   * Applies to publicSubstate === "anonymous" peers only.
   */
  anonymousGlobalLimit?: number;
  /**
   * Facility-wide daily USD ceiling (sum of all priced turns across all
   * peers). Blocks admission once the day's total crosses this threshold.
   */
  dailyBudgetUsd?: number;
  /**
   * Optional operator notifications when priced daily spend crosses configured
   * fractions of dailyBudgetUsd. Requires resolver wiring to a notify destination.
   */
  notifications?: BudgetThresholdNotifications;
  /** Milliseconds before a pending reservation is swept to 'allow:incomplete'. Default: 3_600_000. */
  cleanupWindowMs?: number;
  /**
   * G36 — agent project directory. When set,
   * `admin-overrides.json` is read at boot to apply runtime overrides
   * (currently: dailyBudgetUsd). Admin actions persist back via this path.
   */
  agentDir?: string;
}

/**
 * A staged reservation row — created inside the prepare transaction,
 * committed when the kernel confirms the ticket.
 */
export interface TurnReservation {
  turnId: string;
  peerId: string;
  threadId: string;
  day: string; // YYYY-MM-DD UTC
  trustLevel: TrustLevel;
  publicSubstate: "anonymous" | "recognized" | null;
  reservedAt: number;
  committedAt: number | null;
  costUsd: number | null;
  priced: boolean;
  decision: "allow" | "allow:incomplete" | "allow:orphaned";
  reason: string | null;
}

/**
 * Internal result produced by cap evaluation. null = allowed;
 * string = denial reason.
 */
export type ReservationDecision = { allow: true } | { allow: false; reason: string };

/**
 * BudgetStore construction config (identical to the augment-level
 * BudgetsConfig but slimmed to what the store actually needs).
 */
export interface BudgetStoreConfig {
  dbPath: string;
  /** Milliseconds before a pending reservation is swept. Default: 3_600_000. */
  cleanupWindowMs?: number;
}

export interface BudgetCommitRecord {
  turnId: string;
  peerId: string;
  day: string;
  priced: boolean;
  costUsd: number;
}
