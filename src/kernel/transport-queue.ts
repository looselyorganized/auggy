import type { TurnTrigger, TurnResult } from "../types";

export interface TransportQueueConfig {
  concurrency: number;
  maxQueueDepth: number;
  rateLimitPerPeer?: { maxPerMinute: number };
}

export interface TransportQueue {
  enqueue(
    trigger: TurnTrigger,
    handler: (trigger: TurnTrigger) => Promise<TurnResult>,
  ): Promise<TurnResult>;
}

export function createTransportQueue(
  config: TransportQueueConfig,
): TransportQueue {
  let activeCount = 0;
  const queue: Array<{
    trigger: TurnTrigger;
    handler: (trigger: TurnTrigger) => Promise<TurnResult>;
    resolve: (result: TurnResult) => void;
    reject: (err: unknown) => void;
  }> = [];

  // Rate limit tracking: peerId → timestamps of recent messages
  const peerTimestamps = new Map<string, number[]>();

  function isRateLimited(peerId: string): boolean {
    if (!config.rateLimitPerPeer) return false;
    const now = Date.now();
    const windowMs = 60_000;
    const timestamps = peerTimestamps.get(peerId) ?? [];
    // Clean old timestamps
    const recent = timestamps.filter((t) => now - t < windowMs);
    if (recent.length === 0) {
      peerTimestamps.delete(peerId); // evict stale peer entries
    } else {
      peerTimestamps.set(peerId, recent);
    }
    return recent.length >= config.rateLimitPerPeer.maxPerMinute;
  }

  function recordPeerMessage(peerId: string) {
    if (!config.rateLimitPerPeer) return;
    const timestamps = peerTimestamps.get(peerId) ?? [];
    timestamps.push(Date.now());
    peerTimestamps.set(peerId, timestamps);
  }

  async function processNext() {
    if (activeCount >= config.concurrency || queue.length === 0) return;

    const item = queue.shift()!;
    activeCount++;

    try {
      const result = await item.handler(item.trigger);
      item.resolve(result);
    } catch (err) {
      item.reject(err);
    } finally {
      activeCount--;
      processNext();
    }
  }

  return {
    async enqueue(trigger, handler): Promise<TurnResult> {
      const peerId = trigger.peer?.id;

      // Rate limit check
      if (peerId && isRateLimited(peerId)) {
        return {
          turnId: trigger.turnId,
          success: false,
          status: "rejected",
          errorResponse: "Rate limit exceeded. Please wait before sending more messages.",
          toolCalls: [],
          trace: {
            turnId: trigger.turnId,
            threadId: "",
            timestamp: Date.now(),
            duration: 0,
            trigger: { type: trigger.type },
            contextAssembly: { augmentBlocks: [], preambleTokens: 0, toolSchemaTokens: 0, historyTokens: 0, totalTokens: 0, budgetUsed: 0 },
            toolSelection: { totalTools: 0, phase1Used: false, mountedTools: [], withheldTools: [] },
            inferenceSteps: [],
            capabilityChecks: [],
          },
        };
      }

      // Queue depth check
      if (queue.length >= config.maxQueueDepth) {
        return {
          turnId: trigger.turnId,
          success: false,
          status: "rejected",
          errorResponse: "Too many pending messages. Please try again later.",
          toolCalls: [],
          trace: {
            turnId: trigger.turnId,
            threadId: "",
            timestamp: Date.now(),
            duration: 0,
            trigger: { type: trigger.type },
            contextAssembly: { augmentBlocks: [], preambleTokens: 0, toolSchemaTokens: 0, historyTokens: 0, totalTokens: 0, budgetUsed: 0 },
            toolSelection: { totalTools: 0, phase1Used: false, mountedTools: [], withheldTools: [] },
            inferenceSteps: [],
            capabilityChecks: [],
          },
        };
      }

      if (peerId) recordPeerMessage(peerId);

      return new Promise<TurnResult>((resolve, reject) => {
        queue.push({ trigger, handler, resolve, reject });
        processNext();
      });
    },
  };
}
