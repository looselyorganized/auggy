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
  ThreadHistoryPersistence,
} from "./types";
import { createTokenizer } from "./tokenizer";
import { generateAgentCard } from "./agent-card";
import { wireMemoryBus } from "./memory/memory-bus";
import { createTurnLoop } from "./kernel/turn-loop";
import { createLifecycleManager } from "./kernel/lifecycle-manager";
import { createTransportQueue } from "./kernel/transport-queue";
import { collectAugmentRoutes } from "./kernel/route-collector";
import type { CollectedRoute } from "./kernel/route-collector";

interface StartupAdmissionBarrier {
  wait(): Promise<void>;
  open(): void;
  close(error: Error): void;
}

function createStartupAdmissionBarrier(): StartupAdmissionBarrier {
  let state: "pending" | "open" | "closed" = "pending";
  let closeError: Error | null = null;
  const waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  return {
    wait() {
      if (state === "open") return Promise.resolve();
      if (state === "closed") return Promise.reject(closeError);
      return new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }));
    },
    open() {
      if (state !== "pending") return;
      state = "open";
      for (const waiter of waiters.splice(0)) waiter.resolve();
    },
    close(error) {
      if (state !== "pending") return;
      state = "closed";
      closeError = error;
      for (const waiter of waiters.splice(0)) waiter.reject(error);
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
    owner.publicSubstate === incoming.publicSubstate
  ) {
    return "same";
  }
  if (
    owner.trustLevel === "public" &&
    owner.publicSubstate === "anonymous" &&
    incoming.trustLevel === "public" &&
    incoming.publicSubstate === "recognized" &&
    owner.sourceAugment === incoming.sourceAugment &&
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

  let started = false;

  async function rollbackStartup(): Promise<void> {
    lifecycle.stopIdleTimer();
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
        throw error;
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
  // History compaction and durable commit happen before this function, while
  // holding the per-thread lock. The lock is deliberately released before
  // hooks so scheduleAfterTurn can inject into the same thread without a
  // self-deadlock. Sequential ordering preserves ADR-027 Decision 2: scheduleAfterTurn
  // must observe a fully-settled onTurnEnd. Errors in either hook family
  // are caught and logged so background work is best-effort.
  async function runPostTurn(
    result: TurnResult,
    trigger: TurnTrigger,
    threadId: string,
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
          if (signal?.aborted) return;
          console.warn(`onTurnEnd hook "${a.name}" failed: ${err}`);
        }
      }
    }

    const completedTurnId = result.turnId;
    const ctx: SchedulerContext = {
      inject: (t) => handle.inject(t, { signal }),
      getCompletedTranscript: async () =>
        turnLoop.getHistoryManager(threadId).getTranscript(completedTurnId),
      ...(signal ? { signal } : {}),
    };
    if (signal?.aborted) return;
    for (const a of effectiveAugments) {
      if (signal?.aborted) return;
      if (a.scheduleAfterTurn) {
        try {
          await a.scheduleAfterTurn(result, ctx);
        } catch (err) {
          console.warn(`scheduleAfterTurn hook "${a.name}" threw: ${(err as Error).message}`);
        }
      }
    }
  }

  const handle: AgentHandle = {
    async start() {
      if (started) throw new Error("Agent already started. Call stop() first.");
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
            const queue = createTransportQueue({
              concurrency: aug.transport.concurrency ?? 1,
              maxQueueDepth: aug.transport.maxQueueDepth ?? 50,
              rateLimitPerPeer: aug.transport.rateLimitPerPeer,
            });

            const transportKernel: TransportKernel = {
              async handleInbound(
                trigger: TurnTrigger,
                opts?: {
                  onEvent?: import("./types").KernelEventHandler;
                  signal?: AbortSignal;
                  historyPersistence?: ThreadHistoryPersistence;
                },
              ): Promise<TurnResult> {
                // A listener may bind before a later transport finishes its
                // ready hook. Hold all traffic until the entire ready phase
                // succeeds so failed startup cannot process a partial turn.
                await admission.wait();
                return queue.enqueue(trigger, async (t) => {
                  lifecycle.resetIdleTimer();
                  const threadId = t.threadId ?? t.turnId;
                  const result = await executeThreadTurn(t, threadId, {
                    onEvent: opts?.onEvent,
                    signal: opts?.signal,
                    historyPersistence: opts?.historyPersistence,
                    source: "transport",
                  });
                  await runPostTurn(result, t, threadId, opts?.signal);
                  return result;
                });
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
      await lifecycle.shutdown();
      await Promise.all([...threadTails.values()].map((tail) => tail.catch(() => {})));
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
      return lifecycle.health();
    },

    card(): AgentCard {
      return agentCard;
    },

    async inject(trigger: TurnTrigger, options?: { signal?: AbortSignal }): Promise<TurnResult> {
      lifecycle.resetIdleTimer();
      const threadId = trigger.threadId ?? trigger.turnId;
      const result = await executeThreadTurn(trigger, threadId, {
        source: "inject",
        signal: options?.signal,
      });
      await runPostTurn(result, trigger, threadId, options?.signal);
      return result;
    },
  };

  return handle;
}
