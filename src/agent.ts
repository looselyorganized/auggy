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
  const turnLoop = createTurnLoop({
    augments: effectiveAugments,
    model,
    tokenizer,
    config: effectiveConfig,
  });

  const outboundHandlers = new Map<
    string,
    (peer: PeerIdentity, message: OutboundMessage) => Promise<void>
  >();

  let started = false;

  async function rollbackStartup(): Promise<void> {
    lifecycle.stopIdleTimer();
    await lifecycle.shutdown();
    outboundHandlers.clear();
  }

  async function dispatchOutbound(result: TurnResult, trigger: TurnTrigger) {
    // Collect all messages to dispatch: single response + multi-destination responses
    const messages: OutboundMessage[] = [];
    if (result.response) messages.push(result.response);
    if (result.responses) messages.push(...result.responses);
    if (messages.length === 0) return;

    for (const msg of messages) {
      const targetAugment = msg.targetAugment ?? trigger.source;
      const peer = trigger.peer;
      if (!targetAugment || !peer) continue;
      const handler = outboundHandlers.get(targetAugment);
      if (handler) {
        await handler(peer, msg);
      }
    }
  }

  // Post-turn pipeline: outbound dispatch → eager compaction → onTurnEnd
  // hooks → scheduleAfterTurn dispatch. Used by both transport-driven turns
  // (handleInbound) and kernel-injected ones (inject). ADR-027 requires both
  // paths run the same surface so PR β's auto-save and any future post-turn
  // augment behavior fires identically regardless of how the turn entered.
  // Sequential ordering preserves ADR-027 Decision 2: scheduleAfterTurn
  // must observe a fully-settled onTurnEnd. Errors in either hook family
  // are caught and logged so background work is best-effort.
  async function runPostTurn(
    result: TurnResult,
    trigger: TurnTrigger,
    threadId: string,
  ): Promise<void> {
    await dispatchOutbound(result, trigger);

    const historyBudget = Math.floor(
      model.maxContextTokens * ((config.contextBudget?.historyPercent ?? 40) / 100),
    );
    turnLoop
      .getHistoryManager(threadId)
      .compact(historyBudget, config.compactionStrategy ?? "truncate");

    for (const a of effectiveAugments) {
      if (a.onTurnEnd) {
        try {
          await a.onTurnEnd(result);
        } catch (err) {
          console.warn(`onTurnEnd hook "${a.name}" failed: ${err}`);
        }
      }
    }

    const completedTurnId = result.turnId;
    const ctx: SchedulerContext = {
      inject: (t) => handle.inject(t),
      getCompletedTranscript: async () =>
        turnLoop.getHistoryManager(threadId).getTranscript(completedTurnId),
    };
    for (const a of effectiveAugments) {
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
                opts?: { onEvent?: import("./types").KernelEventHandler },
              ): Promise<TurnResult> {
                // A listener may bind before a later transport finishes its
                // ready hook. Hold all traffic until the entire ready phase
                // succeeds so failed startup cannot process a partial turn.
                await admission.wait();
                return queue.enqueue(trigger, async (t) => {
                  lifecycle.resetIdleTimer();
                  const threadId = t.threadId ?? t.turnId;
                  const result = await turnLoop.executeTurn(t, threadId, {
                    onEvent: opts?.onEvent,
                  });
                  await runPostTurn(result, t, threadId);
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
      outboundHandlers.clear();
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

    async inject(trigger: TurnTrigger): Promise<TurnResult> {
      lifecycle.resetIdleTimer();
      const threadId = trigger.threadId ?? trigger.turnId;
      const result = await turnLoop.executeTurn(trigger, threadId);
      await runPostTurn(result, trigger, threadId);
      return result;
    },
  };

  return handle;
}
