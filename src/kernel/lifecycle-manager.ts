import type { Augment, AgentHealth, ModelClient } from "../types";
import { withTimeout } from "./timeout";
import { hasConfirmedCleanup } from "../application/cleanup-proof";

export interface LifecycleSettlement {
  readonly pendingIdleCallbacks: number;
  readonly pendingShutdownHooks: number;
  readonly resourceState: "active" | "closing" | "closed" | "unknown";
  readonly failures: readonly ("augment-shutdown-failed" | "idle-callback-failed")[];
}

export interface LifecycleManager {
  boot(): Promise<void>;
  shutdown(): Promise<{ hookFailures: number }>;
  startIdleTimer(onIdle: () => Promise<void>, intervalMs?: number): void;
  stopIdleTimer(): void;
  resetIdleTimer(): void;
  health(): Omit<AgentHealth, "scheduler">;
  settlement(): LifecycleSettlement;
  waitForSettlement(): Promise<LifecycleSettlement>;
  /** Hosted cleanup for factory allocations whose boot was never attempted. */
  disposeUnbooted(): Promise<void>;
}

export function createLifecycleManager(opts: {
  name: string;
  augments: Augment[];
  model?: ModelClient;
  canBoot?: () => boolean;
}): LifecycleManager {
  const { name, augments } = opts;
  const augmentStatus = new Map<string, { status: "ok" | "degraded" | "failed"; error?: string }>();
  let bootTime = 0;
  let idleTimerId: ReturnType<typeof setTimeout> | null = null;
  let idleIntervalMs = 300_000;
  let idleCallback: (() => Promise<void>) | null = null;
  let attemptedAugments: Augment[] = [];
  const ownedByLifecycle = new Set<Augment>();
  const pendingIdle = new Set<Promise<unknown>>();
  const pendingShutdown = new Set<Promise<unknown>>();
  const unknownCleanup = new Set<Augment>();
  const successfulCleanup = new Set<Augment>();
  const failures = new Set<"augment-shutdown-failed" | "idle-callback-failed">();
  let resourceState: LifecycleSettlement["resourceState"] = "closed";

  function snapshot(): LifecycleSettlement {
    for (const augment of unknownCleanup) {
      if (successfulCleanup.has(augment) || hasConfirmedCleanup(augment))
        unknownCleanup.delete(augment);
    }
    return Object.freeze({
      pendingIdleCallbacks: pendingIdle.size,
      pendingShutdownHooks: pendingShutdown.size,
      resourceState: unknownCleanup.size ? "unknown" : resourceState,
      failures: Object.freeze([...failures]),
    });
  }

  async function closeAugments(shutdownAugments: Augment[]): Promise<{ hookFailures: number }> {
    let hookFailures = 0;
    for (const aug of shutdownAugments) {
      try {
        if (aug.onShutdown) {
          await withTimeout((signal) => {
            const operation = Promise.resolve().then(() => aug.onShutdown!(signal));
            pendingShutdown.add(operation);
            void operation.then(
              () => {
                pendingShutdown.delete(operation);
                successfulCleanup.add(aug);
                unknownCleanup.delete(aug);
              },
              () => {
                pendingShutdown.delete(operation);
                if (!hasConfirmedCleanup(aug)) unknownCleanup.add(aug);
              },
            );
            return operation;
          }, 5000);
        }
      } catch (err) {
        hookFailures++;
        failures.add("augment-shutdown-failed");
        if (!successfulCleanup.has(aug) && !hasConfirmedCleanup(aug)) unknownCleanup.add(aug);
        // Best-effort: surface the failure so operators can see which
        // augment hung or threw, but keep iterating so the rest still shut down.
        const category = err instanceof Error ? "error-object" : "non-error-value";
        console.warn(`[lifecycle] augment "${aug.name}" onShutdown failed category=${category}`);
      }
    }
    resourceState = "closed";
    return { hookFailures };
  }

  const manager: LifecycleManager = {
    async boot() {
      if (pendingIdle.size || pendingShutdown.size || unknownCleanup.size) {
        throw new Error("Cannot boot while previous lifecycle cleanup is unsettled");
      }
      resourceState = "active";
      failures.clear();
      successfulCleanup.clear();
      bootTime = Date.now();
      augmentStatus.clear();
      attemptedAugments = [];
      ownedByLifecycle.clear();
      for (const aug of augments) {
        if (opts.canBoot?.() === false)
          throw new Error("[application] startup interrupted by shutdown");
        // Track before invoking onBoot so a hook that partially allocates and
        // then throws is still eligible for rollback through onShutdown.
        attemptedAugments.push(aug);
        ownedByLifecycle.add(aug);
        try {
          if (aug.onBoot) await aug.onBoot();
          augmentStatus.set(aug.name, { status: "ok" });
        } catch (err) {
          augmentStatus.set(aug.name, {
            status: "failed",
            error: String(err),
          });
          throw new Error(`Augment "${aug.name}" failed to boot: ${err}`);
        }
      }
    },

    async shutdown() {
      if (idleTimerId) clearInterval(idleTimerId);
      idleTimerId = null;
      idleCallback = null;
      resourceState = "closing";
      while (pendingIdle.size) await Promise.allSettled([...pendingIdle]);
      const shutdownAugments = [...attemptedAugments].reverse();
      attemptedAugments = [];
      return closeAugments(shutdownAugments);
    },

    async disposeUnbooted() {
      const unbooted = augments.filter((augment) => !ownedByLifecycle.has(augment)).reverse();
      for (const augment of unbooted) ownedByLifecycle.add(augment);
      if (unbooted.length) {
        resourceState = "closing";
        await closeAugments(unbooted);
      }
    },

    startIdleTimer(onIdle, intervalMs) {
      idleCallback = onIdle;
      if (intervalMs) idleIntervalMs = intervalMs;
      manager.resetIdleTimer();
    },

    stopIdleTimer() {
      if (idleTimerId) {
        clearInterval(idleTimerId);
        idleTimerId = null;
      }
    },

    resetIdleTimer() {
      if (idleTimerId) clearInterval(idleTimerId);
      if (!idleCallback) return;
      const cb = idleCallback;
      idleTimerId = setInterval(() => {
        const operation = Promise.resolve().then(cb);
        pendingIdle.add(operation);
        void operation.then(
          () => pendingIdle.delete(operation),
          (err) => {
            pendingIdle.delete(operation);
            failures.add("idle-callback-failed");
            const category = err instanceof Error ? "error-object" : "non-error-value";
            console.warn(`[lifecycle] idle callback failed category=${category}`);
          },
        );
      }, idleIntervalMs);
    },

    settlement: snapshot,

    async waitForSettlement() {
      while (pendingIdle.size || pendingShutdown.size) {
        await Promise.allSettled([...pendingIdle, ...pendingShutdown]);
      }
      return snapshot();
    },

    health(): Omit<AgentHealth, "scheduler"> {
      const statuses = Object.fromEntries(augmentStatus);
      const hasFailed = Object.values(statuses).some((s) => s.status === "failed");
      const hasDegraded = Object.values(statuses).some((s) => s.status === "degraded");

      let modelReachable = true;
      if (opts.model) {
        try {
          opts.model.countTokens("health check");
        } catch {
          modelReachable = false;
        }
      }

      return {
        status: hasFailed || !modelReachable ? "unhealthy" : hasDegraded ? "degraded" : "healthy",
        agent: name,
        uptime: bootTime ? Math.floor((Date.now() - bootTime) / 1000) : 0,
        augments: statuses,
        model: { reachable: modelReachable },
      };
    },
  };

  return manager;
}
