import { z } from "zod";
import type {
  Augment,
  ContextBlock,
  TurnTrigger,
  TurnResult,
  PeerIdentity,
  OutboundMessage,
  TransportSpec,
  TransportKernel,
  InboundMessage,
} from "@/types";

export function createMockAugment(overrides?: Partial<Augment>): Augment {
  return {
    name: "mock-augment",
    ...overrides,
  };
}

export function createIdentityAugment(content: string): Augment {
  return {
    name: "identity",
    required: true,
    capabilities: ["context"],
    context: async (): Promise<ContextBlock[]> => [
      {
        source: "identity",
        content,
        placement: "system",
        provenance: "identity",
        priority: "required",
        eviction: "never",
        origin: "operator",
      },
    ],
  };
}

export function createToolAugment(opts: {
  name?: string;
  toolName: string;
  result: string;
}): Augment {
  return {
    name: opts.name ?? "tool-augment",
    capabilities: ["tools"],
    tools: [
      {
        name: opts.toolName,
        description: `Test tool: ${opts.toolName}`,
        category: "meta",
        input: z.object({ input: z.string() }),
        execute: async () => opts.result,
      },
    ],
  };
}

export function createMockTransport(): {
  augment: Augment;
  sendMessage: (text: string, peer?: PeerIdentity) => Promise<TurnResult>;
  outboundMessages: { peer: PeerIdentity; message: OutboundMessage }[];
} {
  let kernel: TransportKernel | null = null;
  const outboundMessages: {
    peer: PeerIdentity;
    message: OutboundMessage;
  }[] = [];

  const defaultPeer: PeerIdentity = {
    id: "test-peer",
    kind: "human",
    trustLevel: "authenticated",
    sourceAugment: "mock-transport",
  };

  const transport: TransportSpec = {
    async register(k: TransportKernel) {
      kernel = k;
      k.onOutbound(async (peer, message) => {
        outboundMessages.push({ peer, message });
      });
    },
    identify: () => defaultPeer,
    concurrency: 1,
  };

  const augment: Augment = {
    name: "mock-transport",
    capabilities: ["transport"],
    transport,
  };

  async function sendMessage(
    text: string,
    peer?: PeerIdentity,
  ): Promise<TurnResult> {
    if (!kernel) throw new Error("Transport not registered");
    const p = peer ?? defaultPeer;
    const trigger: TurnTrigger = {
      type: "message",
      turnId: crypto.randomUUID(),
      timestamp: Date.now(),
      source: "mock-transport",
      peer: p,
      payload: {
        parts: [{ kind: "text", text }],
        sourceAugment: "mock-transport",
        peer: p,
        timestamp: Date.now(),
      } satisfies InboundMessage,
    };
    return kernel.handleInbound(trigger);
  }

  return { augment, sendMessage, outboundMessages };
}
