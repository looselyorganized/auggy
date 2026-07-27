import type {
  AgentCard,
  AgentConfig,
  AgentHandle,
  AgentInjectOptions,
  AgentHealth,
  Augment,
  ModelClient,
  TurnTrigger,
  TurnResult,
  TransportKernel,
  PeerIdentity,
  OutboundMessage,
  SchedulerContext,
  TurnSchedulingConfig,
  ThreadHistoryPersistence,
  RuntimeOperationalSnapshot,
  ExecutionContextV1,
  ExecutionAuthorityV1,
  OutboundDeliveryContext,
  CostResult,
  ThreadHistorySnapshot,
} from "./types";
import { createTokenizer } from "./tokenizer";
import { generateAgentCard } from "./agent-card";
import { wireMemoryBus } from "./memory/memory-bus";
import { createTurnLoop } from "./kernel/turn-loop";
import { createLifecycleManager } from "./kernel/lifecycle-manager";
import { collectAugmentRoutes } from "./kernel/route-collector";
import type { CollectedRoute } from "./kernel/route-collector";
import {
  createKeyedTurnScheduler,
  type KeyedTurnLease,
  type ScheduledRunResult,
  type SchedulerSourcePolicy,
} from "./kernel/keyed-turn-scheduler";
import { emptyTrace } from "./kernel/trace-emitter";
import { isOutcomeUnknownError, OutcomeUnknownError } from "./outcome-unknown";
import { assertDistributedCoordinationStartupAllowed } from "./coordination/topology";
import { createRuntimeSignals } from "./kernel/runtime-signals";
import {
  bindDistributedExecutionContext,
  deriveCausalExecutionContext,
  deriveEffectOperationId,
  executionContextForTrace,
  validateTrustedExecutionContext,
} from "./kernel/execution-context";
import {
  createCanonicalDistributedTurnRequest,
  type DistributedRootExecutionControl,
} from "./coordination";
import {
  consumeDistributedRuntimeForTest,
  type DistributedAgentRuntimeTestAdapter,
} from "./coordination/testing-agent-runtime";
import {
  createDistributedPeerBinding,
  decodeDistributedHistory,
  decodeDistributedReplay,
  encodeDistributedHistory,
  encodeDistributedOutboxBody,
  encodeDistributedReplay,
} from "./coordination/agent-turn-state";
import type {
  DistributedCostMarkerV1,
  DistributedOutboxIntentV1,
  DistributedPeerBindingV1,
} from "./coordination/types";

const DEFAULT_TURN_SCHEDULING: TurnSchedulingConfig = {
  maxConcurrent: 4,
  maxQueued: 100,
  maxQueuedPerThread: 20,
  maxCausalDepth: 8,
};

interface DistributedTurnStateAccumulator {
  threadId: string;
  loaded: boolean;
  control?: DistributedRootExecutionControl;
  peerBinding?: DistributedPeerBindingV1;
  expectedHistoryRevision?: number;
  history?: ThreadHistorySnapshot;
  costMarkers: DistributedCostMarkerV1[];
  outboxIntents: DistributedOutboxIntentV1[];
}

function resolveTurnScheduling(configured: AgentConfig["turnScheduling"]): TurnSchedulingConfig {
  const maxQueued = configured?.maxQueued ?? DEFAULT_TURN_SCHEDULING.maxQueued;
  return {
    maxConcurrent: configured?.maxConcurrent ?? DEFAULT_TURN_SCHEDULING.maxConcurrent,
    maxQueued,
    maxQueuedPerThread:
      configured?.maxQueuedPerThread ??
      Math.min(DEFAULT_TURN_SCHEDULING.maxQueuedPerThread, maxQueued),
    maxCausalDepth: configured?.maxCausalDepth ?? DEFAULT_TURN_SCHEDULING.maxCausalDepth,
  };
}

interface StartupAdmissionBarrier {
  wait(signal?: AbortSignal): Promise<void>;
  open(): void;
  close(error: Error): void;
}

function createStartupAdmissionBarrier(): StartupAdmissionBarrier {
  let state: "pending" | "open" | "closed" = "pending";
  let closeError: Error | null = null;
  const waiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abortListener?: () => void;
  }> = [];

  return {
    wait(signal) {
      if (signal?.aborted) return Promise.resolve();
      if (state === "open") return Promise.resolve();
      if (state === "closed") return Promise.reject(closeError);
      return new Promise<void>((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          ...(signal ? { signal } : {}),
          abortListener: undefined as (() => void) | undefined,
        };
        waiter.abortListener = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          resolve();
        };
        signal?.addEventListener("abort", waiter.abortListener, { once: true });
        waiters.push(waiter);
      });
    },
    open() {
      if (state !== "pending") return;
      state = "open";
      for (const waiter of waiters.splice(0)) {
        waiter.signal?.removeEventListener("abort", waiter.abortListener!);
        waiter.resolve();
      }
    },
    close(error) {
      if (state !== "pending") return;
      state = "closed";
      closeError = error;
      for (const waiter of waiters.splice(0)) {
        waiter.signal?.removeEventListener("abort", waiter.abortListener!);
        waiter.reject(error);
      }
    },
  };
}

interface ExecutionCancellation {
  signal?: AbortSignal;
  cleanup(): void;
}

function executionCancellation(
  signal: AbortSignal | undefined,
  context: ExecutionContextV1 | undefined,
): ExecutionCancellation {
  if (!context?.deadlineAt) return { signal, cleanup: () => {} };

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    abortFromCaller();
  } else {
    signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const deadlineTimer = setTimeout(
    () => {
      controller.abort(new DOMException("Execution deadline exceeded", "TimeoutError"));
    },
    Math.max(0, context.deadlineAt - Date.now()),
  );
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function combineAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!first) return second;
  if (!second || first === second) return first;
  return AbortSignal.any([first, second]);
}

function threadOwnerTransition(
  owner: PeerIdentity | null,
  incoming: PeerIdentity | null,
): "same" | "promote" | "deny" {
  if (owner === null || incoming === null) return owner === incoming ? "same" : "deny";
  if (
    owner.id === incoming.id &&
    owner.trustLevel === incoming.trustLevel &&
    owner.sourceAugment === incoming.sourceAugment &&
    owner.publicSubstate === incoming.publicSubstate &&
    owner.orgId === incoming.orgId
  ) {
    return "same";
  }
  if (
    owner.trustLevel === "public" &&
    owner.publicSubstate === "anonymous" &&
    incoming.trustLevel === "public" &&
    incoming.publicSubstate === "recognized" &&
    owner.sourceAugment === incoming.sourceAugment &&
    owner.orgId === incoming.orgId &&
    incoming.authenticatedPriorPeerId === owner.id
  ) {
    return "promote";
  }
  return "deny";
}

export function defineAgent(config: AgentConfig, model: ModelClient): AgentHandle {
  return defineAgentRuntime(config, model);
}

function defineAgentRuntime(config: AgentConfig, model: ModelClient): AgentHandle {
  const distributed: DistributedAgentRuntimeTestAdapter | undefined =
    consumeDistributedRuntimeForTest(config);
  if (
    distributed?.authorityLossGraceMs !== undefined &&
    (!Number.isSafeInteger(distributed.authorityLossGraceMs) ||
      distributed.authorityLossGraceMs < 0 ||
      distributed.authorityLossGraceMs > 30_000)
  ) {
    throw new Error("authorityLossGraceMs must be a safe integer between 0 and 30000");
  }
  if (
    distributed?.drainTimeoutMs !== undefined &&
    (!Number.isSafeInteger(distributed.drainTimeoutMs) ||
      distributed.drainTimeoutMs < 100 ||
      distributed.drainTimeoutMs > 300_000)
  ) {
    throw new Error("drainTimeoutMs must be a safe integer between 100 and 300000");
  }
  const tokenizer = createTokenizer();
  const operationalSignals = createRuntimeSignals();

  // Wire the memory bus BEFORE constructing other kernel components.
  // This synthesizes context() for memory providers and adds a synthetic
  // augment carrying the generic memory tools.
  const wiring = wireMemoryBus(config.augments);
  const effectiveAugments = wiring.syntheticToolsAugment
    ? [...wiring.augmentsWithSynthesizedContext, wiring.syntheticToolsAugment]
    : wiring.augmentsWithSynthesizedContext;

  const effectiveConfig: AgentConfig = {
    ...config,
    augments: effectiveAugments,
  };

  // Agent card is generated from the effective config (includes memory
  // capability if any augment has a memory field).
  const agentCard: AgentCard = generateAgentCard(effectiveConfig);

  const lifecycle = createLifecycleManager({
    name: effectiveConfig.name,
    augments: effectiveAugments,
    model,
  });
  const restoredThreads = new Map<
    string,
    { persistence: ThreadHistoryPersistence; peer: PeerIdentity }
  >();
  const unmanagedThreadOwners = new Map<string, PeerIdentity | null>();
  const turnLoop = createTurnLoop({
    augments: effectiveAugments,
    model,
    tokenizer,
    config: effectiveConfig,
    operationalSignals,
    onHistoryEvicted: (threadId) => {
      restoredThreads.delete(threadId);
      unmanagedThreadOwners.delete(threadId);
    },
  });

  const outboundHandlers = new Map<
    string,
    (
      peer: PeerIdentity,
      message: OutboundMessage,
      context?: OutboundDeliveryContext,
    ) => Promise<void>
  >();
  const threadTails = new Map<string, Promise<void>>();
  const turnScheduling = resolveTurnScheduling(effectiveConfig.turnScheduling);
  const turnScheduler = createKeyedTurnScheduler({
    maxConcurrent: turnScheduling.maxConcurrent,
    maxQueued: turnScheduling.maxQueued,
    maxQueuedPerKey: turnScheduling.maxQueuedPerThread,
    maxCausalDepth: turnScheduling.maxCausalDepth,
  });
  const injectSource: SchedulerSourcePolicy = {
    id: "kernel:inject",
    maxConcurrent: turnScheduling.maxConcurrent,
    maxQueued: turnScheduling.maxQueued,
  };
  turnScheduler.registerSource(injectSource);

  function durableThreadStillQuarantined(threadId: string): boolean {
    for (const aug of effectiveAugments) {
      const authority = aug.durableThreadQuarantine;
      if (!authority) continue;
      try {
        if (authority.hasThread(threadId)) return true;
      } catch {
        // A failed durable-state read can never authorize scheduler recovery.
        return true;
      }
    }
    return false;
  }

  function restoreDurableThreadQuarantines(): void {
    const restored = new Set<string>();
    for (const aug of effectiveAugments) {
      const authority = aug.durableThreadQuarantine;
      if (!authority) continue;
      const threadIds = authority.listThreadIds();
      if (threadIds.length > 1_000) {
        throw new Error(
          `Augment "${aug.name}" has too many unresolved thread incidents; operator recovery is required`,
        );
      }
      for (const threadId of threadIds) {
        const hasControlCharacter = [...threadId].some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint <= 31 || codePoint === 127;
        });
        if (!threadId || threadId.length > 256 || hasControlCharacter) {
          throw new Error(`Augment "${aug.name}" returned an invalid quarantined thread id`);
        }
        restored.add(threadId);
      }
    }
    for (const threadId of restored) turnScheduler.quarantine(threadId);
  }

  function recoverThreadLane(threadId: string): boolean {
    if (durableThreadStillQuarantined(threadId)) {
      operationalSignals.recordThreadRecovery(false);
      return false;
    }
    const recovered = turnScheduler.recover(threadId);
    operationalSignals.recordThreadRecovery(recovered);
    return recovered;
  }

  let started = false;
  let lifecycleTail: Promise<void> | null = null;

  function serializeLifecycle(operation: () => Promise<void>): Promise<void> {
    const predecessor = lifecycleTail;
    // Run synchronously until the first await when idle so stop() closes
    // admission before it returns its promise. Later lifecycle calls preserve
    // invocation order and cannot overlap a previous start/stop/rollback.
    const result = predecessor ? predecessor.then(operation, operation) : operation();
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    lifecycleTail = settled;
    void settled.then(() => {
      if (lifecycleTail === settled) lifecycleTail = null;
    });
    return result;
  }

  async function rollbackStartup(): Promise<void> {
    const shutdownObservation = operationalSignals.beginShutdown();
    lifecycle.stopIdleTimer();
    turnScheduler.close();
    await distributed?.runtime.beginDrain().catch(() => {});
    await turnScheduler.drain();
    const shutdown = await lifecycle.shutdown();
    await distributed?.runtime.close().catch(() => {});
    shutdownObservation.finish(shutdown.hookFailures);
    outboundHandlers.clear();
  }

  function effectContext(
    operationName: string,
    signal?: AbortSignal,
    executionContext?: ExecutionContextV1,
    executionAuthority?: ExecutionAuthorityV1,
  ): OutboundDeliveryContext {
    const trace = executionContextForTrace(executionContext);
    return {
      ...(signal ? { signal } : {}),
      ...(trace ? { executionContext: trace } : {}),
      ...(executionAuthority ? { executionAuthority } : {}),
      ...(executionContext
        ? { operationId: deriveEffectOperationId(executionContext, operationName, 0) }
        : {}),
    };
  }

  async function dispatchOutbound(
    result: TurnResult,
    trigger: TurnTrigger,
    signal?: AbortSignal,
    executionContext?: ExecutionContextV1,
    executionAuthority?: ExecutionAuthorityV1,
    distributedState?: DistributedTurnStateAccumulator,
  ) {
    if (signal?.aborted) return;
    // Collect all messages to dispatch: single response + multi-destination responses
    const messages: OutboundMessage[] = [];
    if (result.response) messages.push(result.response);
    if (result.responses) messages.push(...result.responses);
    if (messages.length === 0) return;

    for (const [messageIndex, msg] of messages.entries()) {
      if (signal?.aborted) return;
      const targetAugment = msg.targetAugment ?? trigger.source;
      const peer = trigger.peer;
      if (!targetAugment || !peer) continue;
      const handler = outboundHandlers.get(targetAugment);
      if (handler) {
        if (distributedState) {
          if (
            distributedState.outboxIntents.length >= distributed!.turnState.outbox.maxIntentsPerTurn
          ) {
            throw new Error("distributed outbox intent count exceeds limits");
          }
          const operationId = effectContext(
            `outbound:${messageIndex}:${targetAugment}`,
            signal,
            executionContext,
            executionAuthority,
          ).operationId;
          if (!operationId) throw new Error("distributed outbox identity is unavailable");
          if (distributedState.outboxIntents.some((intent) => intent.operationId === operationId)) {
            throw new Error("distributed outbox identity was reused");
          }
          distributedState.outboxIntents.push({
            version: 1,
            ordinal: distributedState.outboxIntents.length,
            operationId,
            contentType: "application/json",
            body: encodeDistributedOutboxBody(
              targetAugment,
              peer,
              msg,
              distributed!.turnState.outbox,
            ),
          });
          continue;
        }
        const startedAt = Date.now();
        const observation = operationalSignals.beginResponseDelivery();
        try {
          await handler(
            peer,
            msg,
            effectContext(
              `outbound:${messageIndex}:${targetAugment}`,
              signal,
              executionContext,
              executionAuthority,
            ),
          );
          observation.finish("completed", Date.now() - startedAt);
        } catch (error) {
          observation.finish(
            isOutcomeUnknownError(error) ? "outcome-unknown" : "failed",
            Date.now() - startedAt,
          );
          throw error;
        }
      }
    }
  }

  async function withThreadLock<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const previous = threadTails.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => gate);
    threadTails.set(threadId, tail);

    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
      if (threadTails.get(threadId) === tail) threadTails.delete(threadId);
    }
  }

  async function preparePersistentHistory(
    threadId: string,
    peer: PeerIdentity | null,
    persistence: ThreadHistoryPersistence | undefined,
    source: "transport" | "inject",
  ): Promise<{ persistence: ThreadHistoryPersistence; peer: PeerIdentity } | null> {
    let restored = restoredThreads.get(threadId);
    if (restored && !turnLoop.hasHistoryManager(threadId)) {
      // Defensive repair for any eviction path that predates or bypasses the
      // callback. Never commit an empty replacement over durable history.
      restoredThreads.delete(threadId);
      restored = undefined;
    }

    if (source === "inject" && persistence === undefined && restored) {
      // An injected continuation may reuse the transport-established
      // persistence capability, but never its identity. The injected trigger
      // must independently carry the same resolved peer and pass the store's
      // exact owner check before model-visible history is exposed.
      if (!peer) {
        throw new Error(
          `Thread history access denied for "${threadId}": resolved peer identity is required`,
        );
      }
      await restored.persistence.assertAccess(threadId, peer);
      return restored;
    }

    if (!persistence) {
      if (restored) {
        throw new Error(
          `Thread history access denied for "${threadId}": persistence authorization is required`,
        );
      }
      if (unmanagedThreadOwners.has(threadId)) {
        const owner = unmanagedThreadOwners.get(threadId) ?? null;
        const transition = threadOwnerTransition(owner, peer);
        if (transition === "deny") {
          throw new Error(
            `Thread history access denied for "${threadId}": thread belongs to another peer`,
          );
        }
        if (transition === "promote" && peer) {
          unmanagedThreadOwners.set(threadId, { ...peer });
        }
      } else {
        unmanagedThreadOwners.set(threadId, peer ? { ...peer } : null);
      }
      return null;
    }
    if (!peer) {
      throw new Error(
        `Thread history access denied for "${threadId}": resolved peer identity is required`,
      );
    }

    if (restored) {
      if (restored.persistence !== persistence) {
        throw new Error(
          `Thread history access denied for "${threadId}": persistence provider changed`,
        );
      }
      await persistence.assertAccess(threadId, peer);
      return { persistence, peer };
    }

    const history = turnLoop.getHistoryManager(threadId);
    if (history.snapshot().messages.length > 0) {
      throw new Error(
        `Thread history access denied for "${threadId}": unmanaged history already exists`,
      );
    }

    // load() is the durable authorization boundary. It atomically claims a
    // new thread or rejects an owner mismatch before any model work begins.
    const snapshot = await persistence.load(threadId, peer);
    history.replace(snapshot ?? { version: 1, messages: [] });
    const association = { persistence, peer: { ...peer } };
    restoredThreads.set(threadId, association);
    return association;
  }

  async function compactAndCommitHistory(
    threadId: string,
    association: { persistence: ThreadHistoryPersistence; peer: PeerIdentity } | null,
    distributedState?: DistributedTurnStateAccumulator,
  ): Promise<void> {
    const historyBudget = Math.floor(
      model.maxContextTokens * ((config.contextBudget?.historyPercent ?? 40) / 100),
    );
    const history = turnLoop.getHistoryManager(threadId);
    history.compact(historyBudget, config.compactionStrategy ?? "truncate");
    if (distributedState) distributedState.history = history.snapshot();
    if (association) {
      try {
        await association.persistence.commit(threadId, association.peer, history.snapshot());
      } catch (error) {
        // The durable outcome is unknown. Drop the resident copy so a retry
        // must re-authorize and restore the store's authoritative snapshot.
        turnLoop.forgetHistoryManager(threadId);
        throw new OutcomeUnknownError("Thread history commit outcome is unknown.", {
          cause: error,
        });
      }
    }
  }

  async function executeThreadTurn(
    trigger: TurnTrigger,
    threadId: string,
    options: {
      onEvent?: import("./types").KernelEventHandler;
      signal?: AbortSignal;
      historyPersistence?: ThreadHistoryPersistence;
      executionContext?: ExecutionContextV1;
      includeExecutionContextInResult?: boolean;
      executionAuthority?: ExecutionAuthorityV1;
      ensureExecutionStarted?: () => Promise<void>;
      markExecutionUncertain?: () => void;
      source: "transport" | "inject";
      trackDetachedOperation?: (operation: Promise<unknown>) => void;
      distributedControl?: DistributedRootExecutionControl;
      distributedState?: DistributedTurnStateAccumulator;
    },
  ): Promise<TurnResult> {
    return withThreadLock(threadId, async () => {
      let association: { persistence: ThreadHistoryPersistence; peer: PeerIdentity } | null = null;
      if (options.distributedState) {
        const distributedHistoryControl =
          options.distributedControl ?? options.distributedState.control;
        if (!distributedHistoryControl || options.distributedState.threadId !== threadId) {
          throw new Error("distributed history authority is unavailable");
        }
        const binding = createDistributedPeerBinding(trigger.peer ?? null);
        if (!options.distributedState.loaded) {
          const loaded = await distributed!.coordinator.loadHistory(
            distributedHistoryControl.lease(),
            binding,
          );
          if (loaded.status !== "ok") {
            throw new Error(`distributed history load failed: ${loaded.status}`);
          }
          turnLoop.getHistoryManager(threadId).replace(decodeDistributedHistory(loaded.body));
          options.distributedState.loaded = true;
          options.distributedState.peerBinding = binding;
          options.distributedState.expectedHistoryRevision = loaded.revision;
          options.distributedState.history = turnLoop.getHistoryManager(threadId).snapshot();
        } else if (options.distributedState.peerBinding?.bindingHash !== binding.bindingHash) {
          throw new Error("distributed causal history peer changed");
        }
      } else {
        association = await preparePersistentHistory(
          threadId,
          trigger.peer ?? null,
          options.historyPersistence,
          options.source,
        );
      }
      let result: TurnResult;
      try {
        result = await turnLoop.executeTurn(trigger, threadId, {
          onEvent: options.onEvent,
          signal: options.signal,
          executionContext: options.executionContext,
          executionAuthority: options.executionAuthority,
          ensureExecutionStarted: options.ensureExecutionStarted,
          markExecutionUncertain: options.markExecutionUncertain,
          trackDetachedOperation: options.trackDetachedOperation,
          ...(options.distributedState
            ? {
                stageCost: (cost: CostResult, operationId: string) => {
                  if (
                    options.distributedState!.costMarkers.length >=
                    distributed!.turnState.maxCostMarkersPerTurn
                  ) {
                    throw new Error("distributed cost marker count exceeds limits");
                  }
                  if (
                    options.distributedState!.costMarkers.some(
                      (marker) => marker.operationId === operationId,
                    )
                  ) {
                    throw new Error("distributed cost identity was reused");
                  }
                  options.distributedState!.costMarkers.push(
                    cost.priced
                      ? { version: 1, operationId, priced: true, costUsd: cost.costUsd }
                      : {
                          version: 1,
                          operationId,
                          priced: false,
                          reason: cost.reason.toLowerCase().includes("usage")
                            ? "missing-usage"
                            : "missing-pricing",
                        },
                  );
                },
              }
            : {}),
        });
      } catch (error) {
        // Model/tool failures can happen after history was mutated. Persist a
        // compact terminal snapshot before surfacing the original failure.
        await compactAndCommitHistory(threadId, association, options.distributedState);
        throw error;
      }
      await compactAndCommitHistory(threadId, association, options.distributedState);
      return options.executionContext === undefined || !options.includeExecutionContextInResult
        ? result
        : { ...result, executionContext: options.executionContext };
    });
  }

  // Post-turn pipeline: outbound dispatch → onTurnEnd
  // hooks → scheduleAfterTurn dispatch. Used by both transport-driven turns
  // (handleInbound) and kernel-injected ones (inject). ADR-027 requires both
  // paths run the same surface so PR β's auto-save and any future post-turn
  // augment behavior fires identically regardless of how the turn entered.
  // History compaction and durable commit happen before this function. The
  // narrow history lock is released, but the agent-wide scheduler retains its
  // keyed lease across delivery and hooks. SchedulerContext.inject uses that
  // unforgeable lease for a bounded causal same-thread child, avoiding
  // self-deadlock without allowing a later customer turn to overtake terminal
  // work. Sequential ordering preserves ADR-027 Decision 2:
  // scheduleAfterTurn observes a fully-settled onTurnEnd. Errors in either
  // hook family are caught and logged so background work is best-effort.
  async function runPostTurn(
    result: TurnResult,
    trigger: TurnTrigger,
    threadId: string,
    lease: KeyedTurnLease,
    signal?: AbortSignal,
    executionContext?: ExecutionContextV1,
    executionAuthority?: ExecutionAuthorityV1,
    markExecutionUncertain?: () => void,
    includeExecutionContextInResult = false,
    distributedState?: DistributedTurnStateAccumulator,
  ): Promise<void> {
    await dispatchOutbound(
      result,
      trigger,
      signal,
      executionContext,
      executionAuthority,
      distributedState,
    );
    const { executionContext: _trustedExecutionContext, ...hookResult } = result;

    if (signal?.aborted) return;
    for (const [augmentIndex, a] of effectiveAugments.entries()) {
      if (signal?.aborted) return;
      if (a.onTurnEnd) {
        try {
          await a.onTurnEnd(
            hookResult,
            effectContext(
              `augment:${augmentIndex}:${a.name}:turn-end`,
              signal,
              executionContext,
              executionAuthority,
            ),
          );
        } catch (err) {
          markExecutionUncertain?.();
          if (isOutcomeUnknownError(err)) lease.quarantine();
          operationalSignals.recordHookFailure(
            isOutcomeUnknownError(err) ? "outcome-unknown" : "failed",
          );
          if (signal?.aborted) return;
          const category = err instanceof Error ? "error-object" : "non-error-value";
          console.warn(`onTurnEnd hook "${a.name}" failed category=${category}`);
        }
      }
    }

    const completedTurnId = result.turnId;
    if (signal?.aborted) return;
    for (const [augmentIndex, a] of effectiveAugments.entries()) {
      if (signal?.aborted) return;
      if (a.scheduleAfterTurn) {
        let contextActive = true;
        let childOrdinal = 0;
        const ctx: SchedulerContext = {
          inject: (t) => {
            if (!contextActive) {
              const causalThreadId = t.threadId ?? t.turnId;
              turnScheduler.recordExternalRejection("causal-context-expired");
              const expired = schedulerTerminalResult(t, causalThreadId, {
                status: "rejected",
                reason: "causal-context-expired",
              });
              operationalSignals.recordTurn({ outcome: "rejected", durationMs: 0 });
              return Promise.resolve(expired);
            }
            const injected = scheduleTurn(
              t,
              {
                source: "inject",
                signal,
                executionContext: deriveCausalExecutionContext(
                  executionContext,
                  `${augmentIndex}:${a.name}`,
                  childOrdinal++,
                ),
                executionAuthority,
                markExecutionUncertain,
                includeExecutionContextInResult,
                distributedState,
              },
              injectSource,
              lease,
            );
            // The scheduler owns and joins the underlying causal task even
            // when a hook intentionally detaches this public promise. Attach
            // a rejection observer so a discarded promise cannot be unhandled.
            void injected.then(
              (childResult) => {
                if (childResult.status === "failed" || childResult.outcomeUnknown) {
                  markExecutionUncertain?.();
                }
                if (childResult.outcomeUnknown) lease.quarantine();
              },
              (error) => {
                markExecutionUncertain?.();
                if (isOutcomeUnknownError(error)) lease.quarantine();
              },
            );
            return injected;
          },
          getCompletedTranscript: async () =>
            turnLoop.getHistoryManager(threadId).getTranscript(completedTurnId),
          ...(signal ? { signal } : {}),
          ...effectContext(
            `augment:${augmentIndex}:${a.name}:schedule-after-turn`,
            signal,
            executionContext,
            executionAuthority,
          ),
        };
        try {
          await a.scheduleAfterTurn(hookResult, ctx);
        } catch (err) {
          markExecutionUncertain?.();
          if (isOutcomeUnknownError(err)) lease.quarantine();
          operationalSignals.recordHookFailure(
            isOutcomeUnknownError(err) ? "outcome-unknown" : "failed",
          );
          const category = err instanceof Error ? "error-object" : "non-error-value";
          console.warn(`scheduleAfterTurn hook "${a.name}" failed category=${category}`);
        } finally {
          contextActive = false;
        }
        // A hook may intentionally detach ctx.inject(). The scheduler still
        // owns that causal work, so declaration-order hooks cannot overlap it.
        await lease.join();
      }
    }
  }

  function schedulerTerminalResult(
    trigger: TurnTrigger,
    threadId: string,
    result: Exclude<ScheduledRunResult<TurnResult>, { status: "completed" }>,
    executionContext?: ExecutionContextV1,
  ): TurnResult {
    if (result.status === "canceled") {
      return {
        turnId: trigger.turnId,
        success: false,
        status: "canceled",
        errorResponse: "Turn was aborted.",
        toolCalls: [],
        trace: emptyTrace({
          turnId: trigger.turnId,
          threadId,
          trigger: { type: trigger.type, sourceAugment: trigger.source },
          executionContext: executionContextForTrace(executionContext),
        }),
        ...(executionContext === undefined ? {} : { executionContext }),
      };
    }

    const errorResponse =
      result.reason === "peer-rate-limit"
        ? "Rate limit exceeded. Please wait before sending more messages."
        : result.reason === "runtime-stopping"
          ? "The agent is stopping. Please retry after it restarts."
          : result.reason === "thread-quarantined"
            ? "This conversation requires operator recovery before it can continue."
            : result.reason === "causal-depth" ||
                result.reason === "causal-concurrency" ||
                result.reason === "causal-context-expired" ||
                result.reason === "causal-thread-mismatch"
              ? "The scheduled follow-up was rejected by the runtime."
              : "Too many pending messages. Please try again later.";
    return {
      turnId: trigger.turnId,
      success: false,
      status: "rejected",
      errorResponse,
      rejection: {
        reason: result.reason,
        ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
      },
      toolCalls: [],
      trace: emptyTrace({
        turnId: trigger.turnId,
        threadId,
        trigger: { type: trigger.type, sourceAugment: trigger.source },
        executionContext: executionContextForTrace(executionContext),
      }),
      ...(executionContext === undefined ? {} : { executionContext }),
    };
  }

  function distributedTerminalResult(
    trigger: TurnTrigger,
    threadId: string,
    reason: "conflict" | "unavailable" | "outcome-unknown",
    executionContext?: ExecutionContextV1,
  ): TurnResult {
    const outcomeUnknown = reason === "outcome-unknown";
    const message = outcomeUnknown
      ? "The turn ended without a trustworthy distributed outcome. Operator recovery is required."
      : reason === "conflict"
        ? "The retry identity conflicts with the original request."
        : "Distributed turn coordination is unavailable. Please retry later.";
    return {
      turnId: trigger.turnId,
      success: false,
      status: outcomeUnknown ? "failed" : "rejected",
      errorResponse: message,
      toolCalls: [],
      trace: emptyTrace({
        turnId: trigger.turnId,
        threadId,
        trigger: { type: trigger.type, sourceAugment: trigger.source },
        executionContext: executionContextForTrace(executionContext),
      }),
      ...(outcomeUnknown ? { outcomeUnknown: true } : {}),
      ...(executionContext === undefined ? {} : { executionContext }),
    };
  }

  async function scheduleTurn(
    trigger: TurnTrigger,
    options: {
      source: "transport" | "inject";
      onEvent?: import("./types").KernelEventHandler;
      signal?: AbortSignal;
      historyPersistence?: ThreadHistoryPersistence;
      beforeExecute?: () => Promise<void>;
      onExecutionStart?: () => void | Promise<void>;
      executionContext?: ExecutionContextV1;
      executionAuthority?: ExecutionAuthorityV1;
      markExecutionUncertain?: () => void;
      includeExecutionContextInResult?: boolean;
      distributedState?: DistributedTurnStateAccumulator;
    },
    sourcePolicy: SchedulerSourcePolicy,
    parentLease?: KeyedTurnLease,
    distributedControl?: {
      control: DistributedRootExecutionControl;
      request: ReturnType<typeof createCanonicalDistributedTurnRequest>;
    },
  ): Promise<TurnResult> {
    const threadId = trigger.threadId ?? trigger.turnId;
    if (distributed && options.historyPersistence) {
      throw new Error(
        "distributed checkpoint runtime rejects legacy unfenced thread history persistence",
      );
    }
    if (distributed && !parentLease && !distributedControl) {
      const request = createCanonicalDistributedTurnRequest({
        trigger,
        threadId,
        source: {
          id: sourcePolicy.id,
          maxConcurrent: sourcePolicy.maxConcurrent,
          maxQueued: sourcePolicy.maxQueued,
        },
        executionContext: options.executionContext,
      });
      const distributedState: DistributedTurnStateAccumulator = {
        threadId,
        loaded: false,
        costMarkers: [],
        outboxIntents: [],
      };
      const coordinated = await distributed.runtime.run<TurnResult>({
        request,
        signal: options.signal,
        local: async (control) => {
          distributedState.control = control;
          const value = await scheduleTurn(
            trigger,
            { ...options, distributedState },
            sourcePolicy,
            undefined,
            { control, request },
          );
          if (value.status === "rejected") return { status: "rejected" };
          if (value.status === "canceled") return { status: "canceled" };
          return { status: "completed", value };
        },
        isSuccessful: (value) => value.success && !value.outcomeUnknown,
        commit: (lease, value) => {
          if (
            !distributedState.loaded ||
            !distributedState.peerBinding ||
            distributedState.expectedHistoryRevision === undefined ||
            !distributedState.history
          ) {
            throw new Error("distributed turn state is incomplete");
          }
          return distributed.coordinator.commitTurn(lease, {
            peerBinding: distributedState.peerBinding,
            expectedHistoryRevision: distributedState.expectedHistoryRevision,
            history: encodeDistributedHistory(
              distributedState.history,
              distributed.turnState.history,
            ),
            replay: encodeDistributedReplay(value, threadId, distributed.result),
            costMarkers: distributedState.costMarkers,
            outboxIntents: distributedState.outboxIntents,
          });
        },
      });
      turnLoop.forgetHistoryManager(threadId);
      if (coordinated.status === "completed") return coordinated.value;
      if (coordinated.status === "replay") {
        try {
          return decodeDistributedReplay(coordinated.result, threadId);
        } catch {
          return distributedTerminalResult(trigger, threadId, "outcome-unknown");
        }
      }
      if (coordinated.status === "outcome-unknown") {
        turnScheduler.quarantine(threadId);
        return distributedTerminalResult(trigger, threadId, "outcome-unknown");
      }
      if (coordinated.status === "terminal" && coordinated.state === "canceled") {
        return schedulerTerminalResult(
          trigger,
          threadId,
          { status: "canceled", reason: "distributed-request-canceled" },
          options.executionContext,
        );
      }
      return distributedTerminalResult(
        trigger,
        threadId,
        coordinated.status === "conflict" ? "conflict" : "unavailable",
      );
    }
    const operationalStartedAt = Date.now();
    const schedulingSignal = combineAbortSignals(
      options.signal,
      distributedControl?.control.signal,
    );
    if (durableThreadStillQuarantined(threadId)) {
      turnScheduler.recordExternalRejection("thread-quarantined");
      operationalSignals.recordTurn({ outcome: "rejected", durationMs: 0 });
      return schedulerTerminalResult(
        trigger,
        threadId,
        { status: "rejected", reason: "thread-quarantined" },
        options.executionContext,
      );
    }
    const executeCompleteTurn = async (lease: KeyedTurnLease): Promise<TurnResult> => {
      const distributedAuthority = distributedControl?.control.executionAuthority();
      const executionAuthority = distributedAuthority ?? options.executionAuthority;
      const executionContext = distributedControl
        ? bindDistributedExecutionContext(
            options.executionContext,
            distributedControl.request.requestId,
            distributedControl.request.bindingHash,
            distributedAuthority!,
          )
        : options.executionContext;
      const markExecutionUncertain = () => {
        distributedControl?.control.markUncertain();
        options.markExecutionUncertain?.();
      };
      const executePipeline = async (): Promise<TurnResult> => {
        await options.beforeExecute?.();
        if (schedulingSignal?.aborted) {
          return schedulerTerminalResult(
            trigger,
            threadId,
            {
              status: "canceled",
              reason: schedulingSignal.reason,
            },
            executionContext,
          );
        }
        lifecycle.resetIdleTimer();
        // Repair a stale persistence memo before pinning creates a replacement
        // manager for this ID. The pin then protects the exact manager through
        // transcript-consuming hooks and any causal same-thread child.
        if (restoredThreads.has(threadId) && !turnLoop.hasHistoryManager(threadId)) {
          restoredThreads.delete(threadId);
        }
        const unpinHistory = turnLoop.pinHistoryManager(threadId);
        try {
          const result = await executeThreadTurn(trigger, threadId, {
            onEvent: options.onEvent,
            signal: schedulingSignal,
            historyPersistence: options.historyPersistence,
            executionContext,
            executionAuthority,
            markExecutionUncertain,
            includeExecutionContextInResult:
              options.includeExecutionContextInResult ?? options.executionContext !== undefined,
            ensureExecutionStarted: async () => {
              await distributedControl?.control.ensureExecutionStarted();
              try {
                await options.onExecutionStart?.();
              } catch (error) {
                markExecutionUncertain();
                throw error;
              }
            },
            source: options.source,
            trackDetachedOperation: (operation) => {
              if (!distributedControl) {
                lease.track(operation);
                return;
              }
              markExecutionUncertain();
              lease.quarantine();
              void operation.catch(() => {});
            },
            distributedControl: distributedControl?.control,
            distributedState: options.distributedState,
          });
          if (result.outcomeUnknown) lease.quarantine();
          await runPostTurn(
            result,
            trigger,
            threadId,
            lease,
            schedulingSignal,
            executionContext,
            executionAuthority,
            markExecutionUncertain,
            options.includeExecutionContextInResult ?? options.executionContext !== undefined,
            options.distributedState,
          );
          return result;
        } catch (error) {
          if (isOutcomeUnknownError(error)) lease.quarantine();
          throw error;
        } finally {
          unpinHistory();
        }
      };

      if (!distributedControl) return executePipeline();
      const execution = executePipeline();
      const observed = execution.then(
        (value) => ({ status: "completed" as const, value }),
        (error) => ({ status: "failed" as const, error }),
      );
      const authorityLost = new Promise<{ status: "authority-lost" }>((resolve) => {
        if (distributedControl.control.signal.aborted) {
          resolve({ status: "authority-lost" });
          return;
        }
        distributedControl.control.signal.addEventListener(
          "abort",
          () => resolve({ status: "authority-lost" }),
          { once: true },
        );
      });
      const first = await Promise.race([observed, authorityLost]);
      if (first.status === "completed") return first.value;
      if (first.status === "failed") throw first.error;

      markExecutionUncertain();
      lease.quarantine();
      const graceMs = distributed?.authorityLossGraceMs ?? 1_000;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        observed,
        new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, graceMs);
        }),
      ]);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      lease.detachOwnedWorkAfterAuthorityLoss();
      return distributedTerminalResult(
        trigger,
        threadId,
        "outcome-unknown",
        (options.includeExecutionContextInResult ?? options.executionContext !== undefined)
          ? executionContext
          : undefined,
      );
    };

    try {
      const scheduled = parentLease
        ? await turnScheduler.runCausal(
            parentLease,
            {
              key: threadId,
              ...(schedulingSignal ? { signal: schedulingSignal } : {}),
            },
            executeCompleteTurn,
          )
        : await turnScheduler.submit(
            {
              key: threadId,
              source: sourcePolicy,
              ...(trigger.peer?.id ? { peerId: trigger.peer.id } : {}),
              ...(schedulingSignal ? { signal: schedulingSignal } : {}),
              ...(distributedControl
                ? { beforeStart: distributedControl.control.beforeStart }
                : {}),
            },
            executeCompleteTurn,
          );
      const result =
        scheduled.status === "completed"
          ? scheduled.value
          : schedulerTerminalResult(trigger, threadId, scheduled, options.executionContext);
      operationalSignals.recordTurn({
        outcome: result.outcomeUnknown
          ? "outcome-unknown"
          : result.status === "canceled"
            ? "canceled"
            : result.status === "rejected"
              ? "rejected"
              : result.success
                ? "completed"
                : "failed",
        durationMs: Date.now() - operationalStartedAt,
      });
      return result;
    } catch (error) {
      operationalSignals.recordTurn({
        outcome: isOutcomeUnknownError(error) ? "outcome-unknown" : "failed",
        durationMs: Date.now() - operationalStartedAt,
      });
      throw error;
    }
  }

  const handle: AgentHandle = {
    start() {
      return serializeLifecycle(async () => {
        if (started) throw new Error("Agent already started. Call stop() first.");
        if (!distributed) assertDistributedCoordinationStartupAllowed(effectiveConfig.coordination);
        if (turnScheduler.snapshot().state === "stopped") turnScheduler.reopen();
        operationalSignals.reset();
        const admission = createStartupAdmissionBarrier();
        try {
          await distributed?.runtime.start();
          await lifecycle.boot();

          // Rebuild scheduler fences from every durable incident authority
          // before routes are collected or any listener can be registered.
          restoreDurableThreadQuarantines();

          // Collect routes after boot but before transport registration. No
          // transport may accept traffic until the later ready phase.
          const collected = collectAugmentRoutes(effectiveAugments);
          if (collected.errors.length > 0) {
            throw new Error(
              `Cannot start agent — augment HTTP route validation failed:\n  ` +
                collected.errors.join("\n  "),
            );
          }
          const augmentRoutes: readonly CollectedRoute[] = collected.routes;

          const frozenAugments: readonly Augment[] = Object.freeze(effectiveAugments.slice());

          // Register every transport before any transport is allowed to start
          // listeners. This closes the startup window where early inbound data
          // could arrive without a kernel handle.
          for (const aug of effectiveAugments) {
            if (aug.transport) {
              const sourcePolicy: SchedulerSourcePolicy = {
                id: `transport:${aug.name}`,
                maxConcurrent: aug.transport.concurrency ?? 1,
                maxQueued: aug.transport.maxQueueDepth ?? 50,
                ...(aug.transport.rateLimitPerPeer
                  ? { rateLimitPerPeer: aug.transport.rateLimitPerPeer }
                  : {}),
              };
              turnScheduler.registerSource(sourcePolicy);

              const transportKernel: TransportKernel = {
                async handleInbound(
                  trigger: TurnTrigger,
                  opts?: {
                    onEvent?: import("./types").KernelEventHandler;
                    signal?: AbortSignal;
                    historyPersistence?: ThreadHistoryPersistence;
                    onExecutionStart?: () => void | Promise<void>;
                  },
                ): Promise<TurnResult> {
                  // A listener may bind before a later transport finishes its
                  // ready hook. Hold all traffic until the entire ready phase
                  // succeeds so failed startup cannot process a partial turn.
                  return scheduleTurn(
                    trigger,
                    {
                      source: "transport",
                      onEvent: opts?.onEvent,
                      signal: opts?.signal,
                      historyPersistence: opts?.historyPersistence,
                      beforeExecute: () => admission.wait(opts?.signal),
                      onExecutionStart: opts?.onExecutionStart,
                    },
                    sourcePolicy,
                  );
                },
                onOutbound(callback) {
                  outboundHandlers.set(aug.name, callback);
                },
                getAgentCard() {
                  return agentCard;
                },
                getOperationalSnapshot() {
                  return operationalSnapshot();
                },
                quarantineThread(threadId: string) {
                  return turnScheduler.quarantine(threadId);
                },
                recoverThread(threadId: string) {
                  return recoverThreadLane(threadId);
                },
                getAugmentRoutes() {
                  return augmentRoutes;
                },
                getAugments() {
                  return frozenAugments;
                },
                forgetThreadHistory(threadId: string) {
                  turnLoop.forgetHistoryManager(threadId);
                },
              };
              await aug.transport.register(transportKernel, aug.name);
            }
          }

          for (const aug of effectiveAugments) {
            await aug.transport?.ready?.();
          }

          lifecycle.startIdleTimer(async () => {
            for (const aug of effectiveAugments) {
              if (aug.onIdle) {
                try {
                  await aug.onIdle();
                } catch {
                  // Log and continue
                }
              }
            }
          });

          started = true;
          admission.open();
        } catch (err) {
          admission.close(err instanceof Error ? err : new Error(String(err)));
          await rollbackStartup();
          throw err;
        }
      });
    },

    stop() {
      return serializeLifecycle(async () => {
        if (!started) return; // no-op if not started
        const shutdownObservation = operationalSignals.beginShutdown();
        lifecycle.stopIdleTimer();
        // Admission must close synchronously when stop() is invoked. In
        // distributed mode beginDrain() performs coordinator I/O and may
        // suspend; leaving the local scheduler open across that await admits
        // work after shutdown has begun.
        turnScheduler.close();
        let coordinationDrainError: unknown;
        try {
          await distributed?.runtime.beginDrain();
        } catch (error) {
          coordinationDrainError = error;
        }
        const schedulerDrain = turnScheduler.drain();
        let forcedDistributedDrain = false;
        if (distributed) {
          let drainTimer: ReturnType<typeof setTimeout> | undefined;
          const drainOutcome = await Promise.race([
            schedulerDrain.then(() => "drained" as const),
            new Promise<"deadline">((resolve) => {
              drainTimer = setTimeout(
                () => resolve("deadline"),
                distributed.drainTimeoutMs ?? 30_000,
              );
            }),
          ]);
          if (drainTimer !== undefined) clearTimeout(drainTimer);
          if (drainOutcome === "deadline") {
            forcedDistributedDrain = true;
            await distributed.runtime.close();
            await schedulerDrain;
          }
        } else {
          await schedulerDrain;
        }
        if (forcedDistributedDrain) {
          for (const tail of threadTails.values()) void tail.catch(() => {});
        } else {
          await Promise.all([...threadTails.values()].map((tail) => tail.catch(() => {})));
        }
        const shutdown = await lifecycle.shutdown();
        await distributed?.runtime.close();
        shutdownObservation.finish(shutdown.hookFailures);
        outboundHandlers.clear();
        turnLoop.clearHistoryManagers();
        restoredThreads.clear();
        unmanagedThreadOwners.clear();
        threadTails.clear();
        started = false;
        if (coordinationDrainError !== undefined) throw coordinationDrainError;
      });
    },

    async ready() {
      if (!started) throw new Error("Agent not started");
    },

    health(): AgentHealth {
      return {
        ...lifecycle.health(),
        scheduler: turnScheduler.snapshot(),
      };
    },

    operationalSnapshot,

    card(): AgentCard {
      return agentCard;
    },

    async inject(trigger: TurnTrigger, options?: AgentInjectOptions): Promise<TurnResult> {
      if (!started) {
        throw new Error("Agent not started. Call and await start() before inject().");
      }
      const executionContext =
        options?.executionContext === undefined
          ? undefined
          : validateTrustedExecutionContext(options.executionContext);
      const cancellation = executionCancellation(options?.signal, executionContext);
      try {
        return await scheduleTurn(
          trigger,
          {
            source: "inject",
            signal: cancellation.signal,
            onEvent: options?.onEvent,
            onExecutionStart: options?.onExecutionStart,
            executionContext,
          },
          injectSource,
        );
      } finally {
        cancellation.cleanup();
      }
    },

    recoverThread(threadId: string): boolean {
      return recoverThreadLane(threadId);
    },
  };

  return handle;

  function operationalSnapshot(): RuntimeOperationalSnapshot {
    const signals = operationalSignals.snapshot();
    const scheduler = turnScheduler.snapshot();
    const state = !started && scheduler.state === "accepting" ? "not-started" : scheduler.state;
    return Object.freeze({
      ...signals,
      readiness: Object.freeze({
        accepting: started && scheduler.state === "accepting",
        state,
      }),
      scheduler,
    });
  }
}
