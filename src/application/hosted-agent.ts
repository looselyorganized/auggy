import type { AgentHandle, HostCleanupFailureCode, TurnSchedulerSnapshot } from "../types";

/** Package-private lifecycle observations; the host adds its other owned work. */
export interface HostedAgentSnapshot {
  readonly admission: "pending" | "open" | "closed";
  readonly scheduler: Readonly<TurnSchedulerSnapshot>;
  readonly pendingTurns: number;
  readonly pendingIdleCallbacks: number;
  readonly pendingShutdownHooks: number;
  readonly resourceState: "active" | "closing" | "closed" | "unknown";
  readonly failures: readonly Extract<
    HostCleanupFailureCode,
    "augment-shutdown-failed" | "idle-callback-failed"
  >[];
}

/** Created only through the shared internal agent constructor, never by an app. */
export interface HostedAgentInstance {
  readonly agent: AgentHandle;
  /** Requires completed agent readiness and a still-pending host gate. */
  openAdmission(): void;
  /** Synchronously closes admission permanently and settles pending gate waiters. */
  closeAdmission(): void;
  snapshot(): HostedAgentSnapshot;
  /** Actual settlement, which may outlive a caller's bounded observation deadline. */
  waitForQuiescence(): Promise<HostedAgentSnapshot>;
}
