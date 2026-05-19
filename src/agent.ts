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
      await lifecycle.boot();

      // PR γ.1 — collect augment-registered HTTP routes AFTER boot so
      // onBoot-populated route lists are visible, BEFORE any transport
      // binds a port so a collision can't leave the agent half-bound.
      const collected = collectAugmentRoutes(effectiveAugments);
      if (collected.errors.length > 0) {
        // Run shutdown to undo the boot side-effects we just performed
        // (otherwise SQLite handles, file watchers, etc. leak).
        try {
          await lifecycle.shutdown();
        } catch {
          // best-effort; the original validation error wins
        }
        throw new Error(
          `Cannot start agent — augment HTTP route validation failed:\n  ` +
            collected.errors.join("\n  "),
        );
      }
      const augmentRoutes: readonly CollectedRoute[] = collected.routes;

      // G36 — frozen augment snapshot exposed to transports via kernel.getAugments().
      // Downstream consumers (notably /admin's adminInfo collector) iterate this
      // list; freezing prevents accidental mutation by a buggy adminInfo()
      // implementation from corrupting iteration.
      const frozenAugments: readonly Augment[] = Object.freeze(effectiveAugments.slice());

      // Register transport augments
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

      // Start idle timer
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
    },

    async stop() {
      if (!started) return; // no-op if not started
      lifecycle.stopIdleTimer();
      await lifecycle.shutdown();
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
