import type {
  AgentCard,
  AgentConfig,
  AgentHandle,
  AgentHealth,
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

  const handle: AgentHandle = {
    async start() {
      if (started) throw new Error("Agent already started. Call stop() first.");
      await lifecycle.boot();

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

                await dispatchOutbound(result, t);

                // Eager compaction
                const historyBudget = Math.floor(
                  model.maxContextTokens * ((config.contextBudget?.historyPercent ?? 40) / 100),
                );
                turnLoop
                  .getHistoryManager(threadId)
                  .compact(historyBudget, config.compactionStrategy ?? "truncate");

                // Run onTurnEnd hooks (non-blocking)
                for (const a of effectiveAugments) {
                  if (a.onTurnEnd) {
                    a.onTurnEnd(result).catch((err) => {
                      console.warn(`onTurnEnd hook "${a.name}" failed: ${err}`);
                    });
                  }
                }

                return result;
              });
            },
            onOutbound(callback) {
              outboundHandlers.set(aug.name, callback);
            },
            getAgentCard() {
              return agentCard;
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

      await dispatchOutbound(result, trigger);

      // Eager compaction
      const historyBudget = Math.floor(
        model.maxContextTokens * ((config.contextBudget?.historyPercent ?? 40) / 100),
      );
      turnLoop
        .getHistoryManager(threadId)
        .compact(historyBudget, config.compactionStrategy ?? "truncate");

      // Run onTurnEnd hooks. Awaited sequentially in declaration order so
      // that ADR-027's lifecycle ordering guarantee holds — scheduleAfterTurn
      // must observe a fully-settled onTurnEnd. Errors are caught/logged so
      // a single failing hook never propagates out of the inject path.
      for (const a of effectiveAugments) {
        if (a.onTurnEnd) {
          try {
            await a.onTurnEnd(result);
          } catch (err) {
            console.warn(`onTurnEnd hook "${a.name}" failed: ${err}`);
          }
        }
      }

      // ADR-027: dispatch scheduleAfterTurn for augments that registered it.
      // SchedulerContext closes over inject (this handle's method) +
      // getCompletedTranscript (closure-bound to the just-completed turn id;
      // arbitrary-turnId reads stay kernel-internal at v1.0). Sequential
      // execution in declaration order per ADR-027 Decision 2; errors are
      // caught + logged, never propagated — background work is best-effort.
      const ctx: SchedulerContext = {
        inject: (t) => handle.inject(t),
        getCompletedTranscript: async () => null,
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

      return result;
    },
  };

  return handle;
}
