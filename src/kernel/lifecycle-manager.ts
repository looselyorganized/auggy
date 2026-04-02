import type { Augment, AgentHealth } from "../types";
import { withTimeout } from "./timeout";

export interface LifecycleManager {
  boot(): Promise<void>;
  shutdown(): Promise<void>;
  startIdleTimer(onIdle: () => Promise<void>, intervalMs?: number): void;
  stopIdleTimer(): void;
  resetIdleTimer(): void;
  health(): AgentHealth;
}

export function createLifecycleManager(opts: {
  name: string;
  augments: Augment[];
}): LifecycleManager {
  const { name, augments } = opts;
  const augmentStatus = new Map<
    string,
    { status: "ok" | "degraded" | "failed"; error?: string }
  >();
  let bootTime = 0;
  let idleTimerId: ReturnType<typeof setTimeout> | null = null;
  let idleIntervalMs = 300_000;
  let idleCallback: (() => Promise<void>) | null = null;

  const manager: LifecycleManager = {
    async boot() {
      bootTime = Date.now();
      for (const aug of augments) {
        try {
          if (aug.onBoot) await aug.onBoot();
          augmentStatus.set(aug.name, { status: "ok" });
        } catch (err) {
          augmentStatus.set(aug.name, {
            status: "failed",
            error: String(err),
          });
          throw new Error(
            `Augment "${aug.name}" failed to boot: ${err}`,
          );
        }
      }
    },

    async shutdown() {
      if (idleTimerId) clearTimeout(idleTimerId);
      for (const aug of [...augments].reverse()) {
        try {
          if (aug.onShutdown) {
            await withTimeout(() => aug.onShutdown!(), 5000);
          }
        } catch {
          // Best-effort shutdown
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
        clearTimeout(idleTimerId);
        idleTimerId = null;
      }
    },

    resetIdleTimer() {
      if (idleTimerId) clearTimeout(idleTimerId);
      if (!idleCallback) return;
      const cb = idleCallback;
      idleTimerId = setTimeout(async () => {
        try {
          await cb();
        } catch {
          // Log and continue
        }
        manager.resetIdleTimer();
      }, idleIntervalMs);
    },

    health(): AgentHealth {
      const statuses = Object.fromEntries(augmentStatus);
      const hasFailed = Object.values(statuses).some(
        (s) => s.status === "failed",
      );
      const hasDegraded = Object.values(statuses).some(
        (s) => s.status === "degraded",
      );

      return {
        status: hasFailed
          ? "unhealthy"
          : hasDegraded
            ? "degraded"
            : "healthy",
        agent: name,
        uptime: bootTime
          ? Math.floor((Date.now() - bootTime) / 1000)
          : 0,
        augments: statuses,
        model: { reachable: true },
      };
    },
  };

  return manager;
}
