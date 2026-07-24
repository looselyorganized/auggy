import type {
  AgentCard,
  AgentConfig,
  AgentHandle,
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

const DEFAULT_TURN_SCHEDULING: TurnSchedulingConfig = {
  maxConcurrent: 4,
  maxQueued: 100,
  maxQueuedPerThread: 20,
  maxCausalDepth: 8,
};

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
  const tokenizer = createTokenizer();

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
      context?: { signal?: AbortSignal },
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

  let started = false;

  async function rollbackStartup(): Promise<void> {
    lifecycle.stopIdleTimer();
    turnScheduler.close();
    await turnScheduler.drain();
    await lifecycle.shutdown();
    outboundHandlers.clear();
  }

  async function dispatchOutbound(result: TurnResult, trigger: TurnTrigger, signal?: AbortSignal) {
    if (signal?.aborted) return;
    // Collect all messages to dispatch: single response + multi-destination responses
    const messages: OutboundMessage[] = [];
    if (result.response) messages.push(result.response);
    if (result.responses) messages.push(...result.responses);
    if (messages.length === 0) return;

    for (const msg of messages) {
      if (signal?.aborted) return;
      const targetAugment = msg.targetAugment ?? trigger.source;
      const peer = trigger.peer;
      if (!targetAugment || !peer) continue;
      const handler = outboundHandlers.get(targetAugment);
      if (handler) {
        await handler(peer, msg, { signal });
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
  ): Promise<void> {
    const historyBudget = Math.floor(
      model.maxContextTokens * ((config.contextBudget?.historyPercent ?? 40) / 100),
    );
    const history = turnLoop.getHistoryManager(threadId);
    history.compact(historyBudget, config.compactionStrategy ?? "truncate");
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
      source: "transport" | "inject";
      trackDetachedOperation?: (operation: Promise<unknown>) => void;
    },
  ): Promise<TurnResult> {
    return withThreadLock(threadId, async () => {
      const association = await preparePersistentHistory(
        threadId,
        trigger.peer ?? null,
        options.historyPersistence,
        options.source,
      );
      let result: TurnResult;
      try {
        result = await turnLoop.executeTurn(trigger, threadId, {
          onEvent: options.onEvent,
          signal: options.signal,
          trackDetachedOperation: options.trackDetachedOperation,
        });
      } catch (error) {
        // Model/tool failures can happen after history was mutated. Persist a
        // compact terminal snapshot before surfacing the original failure.
        await compactAndCommitHistory(threadId, association);
        throw error;
      }
      await compactAndCommitHistory(threadId, association);
      return result;
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
  ): Promise<void> {
    await dispatchOutbound(result, trigger, signal);

    if (signal?.aborted) return;
    for (const a of effectiveAugments) {
      if (signal?.aborted) return;
      if (a.onTurnEnd) {
        try {
          await a.onTurnEnd(result, { signal });
        } catch (err) {
          if (isOutcomeUnknownError(err)) lease.quarantine();
          if (signal?.aborted) return;
          console.warn(`onTurnEnd hook "${a.name}" failed: ${err}`);
        }
      }
    }

    const completedTurnId = result.turnId;
    if (signal?.aborted) return;
    for (const a of effectiveAugments) {
      if (signal?.aborted) return;
      if (a.scheduleAfterTurn) {
        let contextActive = true;
        const ctx: SchedulerContext = {
          inject: (t) => {
            if (!contextActive) {
              const causalThreadId = t.threadId ?? t.turnId;
              return Promise.resolve(
                schedulerTerminalResult(t, causalThreadId, {
                  status: "rejected",
                  reason: "causal-context-expired",
                }),
              );
            }
            const injected = scheduleTurn(
              t,
              {
                source: "inject",
                signal,
              },
              injectSource,
              lease,
            );
            // The scheduler owns and joins the underlying causal task even
            // when a hook intentionally detaches this public promise. Attach
            // a rejection observer so a discarded promise cannot be unhandled.
            void injected.catch((error) => {
              if (isOutcomeUnknownError(error)) lease.quarantine();
            });
            return injected;
          },
          getCompletedTranscript: async () =>
            turnLoop.getHistoryManager(threadId).getTranscript(completedTurnId),
          ...(signal ? { signal } : {}),
        };
        try {
          await a.scheduleAfterTurn(result, ctx);
        } catch (err) {
          if (isOutcomeUnknownError(err)) lease.quarantine();
          console.warn(`scheduleAfterTurn hook "${a.name}" threw: ${(err as Error).message}`);
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
        }),
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
      }),
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
      onExecutionStart?: () => void;
    },
    sourcePolicy: SchedulerSourcePolicy,
    parentLease?: KeyedTurnLease,
  ): Promise<TurnResult> {
    const threadId = trigger.threadId ?? trigger.turnId;
    if (parentLease && parentLease.key !== threadId) {
      return schedulerTerminalResult(trigger, threadId, {
        status: "rejected",
        reason: "causal-thread-mismatch",
      });
    }

    const executeCompleteTurn = async (lease: KeyedTurnLease): Promise<TurnResult> => {
      await options.beforeExecute?.();
      if (options.signal?.aborted) {
        return schedulerTerminalResult(trigger, threadId, {
          status: "canceled",
          reason: options.signal.reason,
        });
      }
      options.onExecutionStart?.();
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
          signal: options.signal,
          historyPersistence: options.historyPersistence,
          source: options.source,
          trackDetachedOperation: (operation) => lease.track(operation),
        });
        if (result.outcomeUnknown) lease.quarantine();
        await runPostTurn(result, trigger, threadId, lease, options.signal);
        return result;
      } catch (error) {
        if (isOutcomeUnknownError(error)) lease.quarantine();
        throw error;
      } finally {
        unpinHistory();
      }
    };

    const scheduled = parentLease
      ? await turnScheduler.runCausal(
          parentLease,
          {
            key: threadId,
            ...(options.signal ? { signal: options.signal } : {}),
          },
          executeCompleteTurn,
        )
      : await turnScheduler.submit(
          {
            key: threadId,
            source: sourcePolicy,
            ...(trigger.peer?.id ? { peerId: trigger.peer.id } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
          },
          executeCompleteTurn,
        );
    return scheduled.status === "completed"
      ? scheduled.value
      : schedulerTerminalResult(trigger, threadId, scheduled);
  }

  const handle: AgentHandle = {
    async start() {
      if (started) throw new Error("Agent already started. Call stop() first.");
      if (turnScheduler.snapshot().state === "stopped") turnScheduler.reopen();
      const admission = createStartupAdmissionBarrier();
      try {
        await lifecycle.boot();

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
                  onExecutionStart?: () => void;
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
    },

    async stop() {
      if (!started) return; // no-op if not started
      lifecycle.stopIdleTimer();
      turnScheduler.close();
      await turnScheduler.drain();
      await Promise.all([...threadTails.values()].map((tail) => tail.catch(() => {})));
      await lifecycle.shutdown();
      outboundHandlers.clear();
      turnLoop.clearHistoryManagers();
      restoredThreads.clear();
      unmanagedThreadOwners.clear();
      threadTails.clear();
      started = false;
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

    card(): AgentCard {
      return agentCard;
    },

    async inject(trigger: TurnTrigger, options?: { signal?: AbortSignal }): Promise<TurnResult> {
      return scheduleTurn(
        trigger,
        {
          source: "inject",
          signal: options?.signal,
        },
        injectSource,
      );
    },

    recoverThread(threadId: string): boolean {
      return turnScheduler.recover(threadId);
    },
  };

  return handle;
}
