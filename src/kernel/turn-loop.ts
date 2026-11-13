import type {
  AgentConfig,
  Augment,
  ModelClient,
  TurnTrigger,
  TurnResult,
  TurnGateProvider,
  KernelEventHandler,
  ExecutionContextV1,
  TurnProgramBinding,
} from "../types";
import type { Tokenizer } from "../tokenizer";
import { resolveModelResponseLimits } from "../engines/_shared/response-limits";
import { resolveProviderRequestTimeoutMs } from "../engines/_shared/provider-resilience";
import { createHistoryManager, type HistoryManager } from "./history-manager";
import type { RuntimeSignals } from "./runtime-signals";
import type { KernelTurnSettlement } from "./turn-contract";
import { executeManagedTurn, validateTurnProgramBinding } from "./turn-session";
export interface TurnLoopOptions {
  signal?: AbortSignal;
  onEvent?: KernelEventHandler;
  executionContext?: ExecutionContextV1;
  trackDetachedOperation?: (operation: Promise<unknown>) => void;
}

export interface TurnLoop {
  executeTurnSettled(
    trigger: TurnTrigger,
    threadId: string,
    options?: TurnLoopOptions,
  ): Promise<KernelTurnSettlement>;
  executeTurn(
    trigger: TurnTrigger,
    threadId: string,
    options?: TurnLoopOptions,
  ): Promise<TurnResult>;
  getHistoryManager(threadId: string): HistoryManager;
  hasHistoryManager(threadId: string): boolean;
  /** Prevent this thread's exact resident manager from being evicted while active. */
  pinHistoryManager(threadId: string): () => void;
  forgetHistoryManager(threadId: string): void;
  clearHistoryManagers(): void;
}

export function createTurnLoop(opts: {
  augments: Augment[];
  model: ModelClient;
  tokenizer: Tokenizer;
  config: AgentConfig;
  turnProgram?: TurnProgramBinding;
  onHistoryEvicted?: (threadId: string) => void;
  operationalSignals?: RuntimeSignals;
}): TurnLoop {
  const { augments, model, tokenizer, config } = opts;
  const turnProgram = validateTurnProgramBinding(opts.turnProgram, config.maxInferenceLoops ?? 10);
  const turnGateOwners = augments.filter(
    (augment): augment is Augment & { turnGate: TurnGateProvider } =>
      augment.turnGate !== undefined,
  );
  if (turnGateOwners.length > 1) {
    throw new Error(
      `Only one augment may declare turnGate; found: ${turnGateOwners
        .map((augment) => augment.name)
        .join(", ")}.`,
    );
  }
  const turnGateOwner = turnGateOwners[0];
  const responseLimits = resolveModelResponseLimits(config.responseLimits);
  const providerRequestTimeoutMs = resolveProviderRequestTimeoutMs(config.providerRequestTimeoutMs);
  const detachedProviderAttemptLimit = Math.max(2, config.turnScheduling?.maxConcurrent ?? 4);
  const detachedProviderAttempts = new Set<Promise<unknown>>();

  function trackDetachedProviderAttempt(operation: Promise<unknown>): void {
    detachedProviderAttempts.add(operation);
    void operation.then(
      () => detachedProviderAttempts.delete(operation),
      () => detachedProviderAttempts.delete(operation),
    );
  }

  const historyManagers = new Map<string, HistoryManager>();
  const historyLastAccess = new Map<string, number>();
  const historyPins = new Map<string, number>();
  const deferredHistoryEvictions = new Set<string>();
  const MAX_HISTORY_THREADS = 500;

  function evictHistory(threadId: string) {
    if ((historyPins.get(threadId) ?? 0) > 0) {
      deferredHistoryEvictions.add(threadId);
      return false;
    }
    historyManagers.delete(threadId);
    historyLastAccess.delete(threadId);
    deferredHistoryEvictions.delete(threadId);
    opts.onHistoryEvicted?.(threadId);
    return true;
  }

  function evictHistoriesToLimit(): void {
    while (historyManagers.size > MAX_HISTORY_THREADS) {
      let oldestId: string | null = null;
      let oldestTime = Infinity;
      for (const [id, timestamp] of historyLastAccess) {
        if ((historyPins.get(id) ?? 0) > 0) continue;
        if (timestamp < oldestTime) {
          oldestTime = timestamp;
          oldestId = id;
        }
      }
      if (!oldestId || !evictHistory(oldestId)) return;
    }
  }

  function getOrCreateHistory(threadId: string): HistoryManager {
    let hm = historyManagers.get(threadId);
    if (!hm) {
      // Evict the oldest inactive thread if at capacity. When every resident
      // manager is pinned, allow bounded temporary overshoot rather than
      // replacing state that an active turn will later commit.
      if (historyManagers.size >= MAX_HISTORY_THREADS) {
        let oldestId: string | null = null;
        let oldestTime = Infinity;
        for (const [id, t] of historyLastAccess) {
          if ((historyPins.get(id) ?? 0) > 0) continue;
          if (t < oldestTime) {
            oldestTime = t;
            oldestId = id;
          }
        }
        if (oldestId) {
          evictHistory(oldestId);
        }
      }
      hm = createHistoryManager();
      historyManagers.set(threadId, hm);
    }
    historyLastAccess.set(threadId, Date.now());
    return hm;
  }

  const facade: TurnLoop = {
    getHistoryManager: getOrCreateHistory,
    hasHistoryManager(threadId: string) {
      return historyManagers.has(threadId);
    },
    pinHistoryManager(threadId: string) {
      getOrCreateHistory(threadId);
      historyPins.set(threadId, (historyPins.get(threadId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (historyPins.get(threadId) ?? 1) - 1;
        if (remaining > 0) {
          historyPins.set(threadId, remaining);
          return;
        }
        historyPins.delete(threadId);
        if (deferredHistoryEvictions.has(threadId)) evictHistory(threadId);
        evictHistoriesToLimit();
      };
    },
    forgetHistoryManager(threadId: string) {
      evictHistory(threadId);
    },
    clearHistoryManagers() {
      const threadIds = [...historyManagers.keys()];
      historyManagers.clear();
      historyLastAccess.clear();
      historyPins.clear();
      deferredHistoryEvictions.clear();
      for (const threadId of threadIds) opts.onHistoryEvicted?.(threadId);
    },

    async executeTurn(trigger, threadId, options) {
      const settlement = await facade.executeTurnSettled(trigger, threadId, options);
      if (settlement.kind === "threw") throw settlement.error;
      return settlement.result;
    },
    executeTurnSettled(trigger, threadId, options) {
      return executeManagedTurn(
        {
          augments,
          model,
          tokenizer,
          config,
          turnProgram,
          turnGateOwner,
          responseLimits,
          providerRequestTimeoutMs,
          detachedProviderAttemptLimit,
          detachedProviderAttempts,
          trackDetachedProviderAttempt,
          getOrCreateHistory,
          operationalSignals: opts.operationalSignals,
        },
        trigger,
        threadId,
        options,
      );
    },
  };
  return facade;
}
