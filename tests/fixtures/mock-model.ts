import type { ModelClient, AssembledPrompt, ModelResponse } from "@/types";

export interface MockModelClient extends ModelClient {
  calls: AssembledPrompt[];
  pushResponse(r: Partial<ModelResponse>): void;
}

export function createMockModel(opts?: {
  response?: string;
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  maxContextTokens?: number;
}): MockModelClient {
  const responses: ModelResponse[] = [];
  let callIndex = 0;

  const client: MockModelClient = {
    maxContextTokens: opts?.maxContextTokens ?? 100_000,
    calls: [],

    pushResponse(r: Partial<ModelResponse>) {
      responses.push({
        content: r.content ?? "",
        toolCalls: r.toolCalls,
        inputTokens: r.inputTokens ?? 100,
        outputTokens: r.outputTokens ?? 50,
        finishReason: r.finishReason ?? "end_turn",
        costUsd: r.costUsd,
        unpricedReason: r.unpricedReason,
      });
    },

    async complete(prompt: AssembledPrompt): Promise<ModelResponse> {
      client.calls.push(prompt);
      if (callIndex < responses.length) {
        return responses[callIndex++]!;
      }
      return {
        content: opts?.response ?? "Mock response",
        toolCalls: opts?.toolCalls,
        inputTokens: 100,
        outputTokens: 50,
        finishReason: opts?.toolCalls ? "tool_use" : "end_turn",
      };
    },

    countTokens(text: string): number {
      return Math.ceil(text.length / 4);
    },
  };

  return client;
}
