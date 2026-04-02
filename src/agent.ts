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

export function defineAgent(opts: {
  config: AgentConfig;
  model: ModelClient;
}): AgentHandle {
  const { config, model } = opts;
  const tokenizer = createTokenizer();
  const lifecycle = createLifecycleManager({
    name: config.name,
    augments: config.augments,
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
    if (!result.response) return;
    const targetAugment = result.response.targetAugment ?? trigger.source;
    const peer = trigger.peer;
    if (!targetAugment || !peer) return;
    const handler = outboundHandlers.get(targetAugment);
    if (handler) {
      await handler(peer, result.response);
    }
  }

  const handle: AgentHandle = {
    async start() {
      await lifecycle.boot();

      // Register transport augments
      for (const aug of config.augments) {
        if (aug.transport) {
          const transportKernel: TransportKernel = {
            async handleInbound(
              trigger: TurnTrigger,
            ): Promise<TurnResult> {
              lifecycle.resetIdleTimer();
              const threadId = trigger.peer?.id ?? trigger.turnId;
              const result = await turnLoop.executeTurn(
                trigger,
                threadId,
              );

              await dispatchOutbound(result, trigger);

              // Run onTurnEnd hooks (non-blocking)
              for (const a of config.augments) {
                if (a.onTurnEnd) {
                  a.onTurnEnd(result).catch(() => {});
                }
              }

              return result;
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
      const threadId = trigger.peer?.id ?? trigger.turnId;
      return turnLoop.executeTurn(trigger, threadId);
    },
  };

  return handle;
}
