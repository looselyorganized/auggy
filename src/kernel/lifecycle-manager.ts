import type { Augment, AgentHealth, ModelClient } from "../types";
import { withTimeout } from "./timeout";

export interface LifecycleManager {
  boot(): Promise<void>;
  shutdown(): Promise<void>;
  startIdleTimer(onIdle: () => Promise<void>, intervalMs?: number): void;
  stopIdleTimer(): void;
  resetIdleTimer(): void;
  health(): Omit<AgentHealth, "scheduler">;
}

export function createLifecycleManager(opts: {
  name: string;
  augments: Augment[];
  model?: ModelClient;
}): LifecycleManager {
  const { name, augments } = opts;
  const augmentStatus = new Map<string, { status: "ok" | "degraded" | "failed"; error?: string }>();
  let bootTime = 0;
  let idleTimerId: ReturnType<typeof setTimeout> | null = null;
  let idleIntervalMs = 300_000;
  let idleCallback: (() => Promise<void>) | null = null;
  let attemptedAugments: Augment[] = [];

  const manager: LifecycleManager = {
    async boot() {
      bootTime = Date.now();
      augmentStatus.clear();
      attemptedAugments = [];
      for (const aug of augments) {
        // Track before invoking onBoot so a hook that partially allocates and
        // then throws is still eligible for rollback through onShutdown.
        attemptedAugments.push(aug);
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
      const shutdownAugments = [...attemptedAugments].reverse();
      attemptedAugments = [];
      for (const aug of shutdownAugments) {
        try {
          if (aug.onShutdown) {
            await withTimeout((signal) => aug.onShutdown!(signal), 5000);
          }
        } catch (err) {
          // Best-effort: surface the failure so operators can see which
          // augment hung or threw, but keep iterating so the rest still shut down.
          console.warn(`[lifecycle] augment "${aug.name}" onShutdown failed:`, err);
        }
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
      idleTimerId = setInterval(async () => {
        try {
          await cb();
        } catch (err) {
          console.warn(`[lifecycle] idle callback failed:`, err);
        }
      }, idleIntervalMs);
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
