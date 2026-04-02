import type {
  AgentConfig,
  AgentHandle,
  AgentHealth,
  ModelClient,
  TurnTrigger,
  TurnResult,
  TransportKernel,
  PeerIdentity,
  OutboundMessage,
} from "./types";
import { createTokenizer } from "./tokenizer";
import { createTurnLoop } from "./kernel/turn-loop";
import { createLifecycleManager } from "./kernel/lifecycle-manager";
import { createTransportQueue } from "./kernel/transport-queue";

export function defineAgent(
  config: AgentConfig,
  model: ModelClient,
): AgentHandle {
  const tokenizer = createTokenizer();
  const lifecycle = createLifecycleManager({
    name: config.name,
    augments: config.augments,
    model,
  });
  const turnLoop = createTurnLoop({
    augments: config.augments,
    model,
    tokenizer,
    config,
  });

  const outboundHandlers = new Map<
    string,
    (peer: PeerIdentity, message: OutboundMessage) => Promise<void>
  >();

  let started = false;

  async function dispatchOutbound(
    result: TurnResult,
    trigger: TurnTrigger,
  ) {
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
      await lifecycle.boot();

      // Register transport augments
      for (const aug of config.augments) {
        if (aug.transport) {
          const queue = createTransportQueue({
            concurrency: aug.transport.concurrency ?? 1,
            maxQueueDepth: aug.transport.maxQueueDepth ?? 50,
            rateLimitPerPeer: aug.transport.rateLimitPerPeer,
          });

          const transportKernel: TransportKernel = {
            async handleInbound(
              trigger: TurnTrigger,
            ): Promise<TurnResult> {
              return queue.enqueue(trigger, async (t) => {
                lifecycle.resetIdleTimer();
                const threadId = t.threadId ?? t.turnId;
                const result = await turnLoop.executeTurn(t, threadId);

                await dispatchOutbound(result, t);

                // Eager compaction
                const historyBudget = Math.floor(
                  model.maxContextTokens * ((config.contextBudget?.historyPercent ?? 40) / 100),
                );
                turnLoop.getHistoryManager(threadId).compact(
                  historyBudget,
                  config.compactionStrategy ?? "truncate",
                );

                // Run onTurnEnd hooks (non-blocking)
                for (const a of config.augments) {
                  if (a.onTurnEnd) {
                    a.onTurnEnd(result).catch(() => {});
                  }
                }

                return result;
              });
            },
            onOutbound(callback) {
              outboundHandlers.set(aug.name, callback);
            },
          };
          await aug.transport.register(transportKernel);
        }
      }

      // Start idle timer
      lifecycle.startIdleTimer(async () => {
        for (const aug of config.augments) {
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

    async inject(trigger: TurnTrigger): Promise<TurnResult> {
      lifecycle.resetIdleTimer();
      const threadId = trigger.threadId ?? trigger.turnId;
      const result = await turnLoop.executeTurn(trigger, threadId);

      await dispatchOutbound(result, trigger);

      // Eager compaction
      const historyBudget = Math.floor(
        model.maxContextTokens * ((config.contextBudget?.historyPercent ?? 40) / 100),
      );
      turnLoop.getHistoryManager(threadId).compact(
        historyBudget,
        config.compactionStrategy ?? "truncate",
      );

      // Run onTurnEnd hooks (non-blocking, same as transport path)
      for (const a of config.augments) {
        if (a.onTurnEnd) {
          a.onTurnEnd(result).catch(() => {});
        }
      }

      return result;
    },
  };

  return handle;
}
