import { describe, expect, test } from "bun:test";
import { handleExtractionTurn } from "@/augments/layeredMemory/extractor/inject-handler";
import type {
  ExecutionAuthorityV1,
  ExecutionTraceContextV1,
  ModelCompleteOptions,
  Transcript,
} from "@/types";

const sampleTranscript: Transcript = {
  turnId: "user-turn-1",
  threadId: "thread-1",
  peer: {
    id: "sam",
    kind: "human",
    trustLevel: "creator",
    sourceAugment: "web-transport",
  },
  parts: [{ kind: "text", text: "Hi I'm Sam" }],
  toolCalls: [],
  startedAt: 0,
  endedAt: 1,
};

describe("handleExtractionTurn", () => {
  test("renders prompt + calls engine + returns parsed facts", async () => {
    let capturedPrompt = "";
    const mockEngine = {
      complete: async (prompt: string) => {
        capturedPrompt = prompt;
        return {
          text: '[{"subject":"peer","predicate":"name","object":"Sam","confidence":0.95,"isVerbatim":true}]',
          costUsd: 0.005,
        };
      },
    };
    const result = await handleExtractionTurn({
      transcript: sampleTranscript,
      engine: mockEngine,
      promptTemplate: "TRANSCRIPT: {{TRANSCRIPT}}",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.facts.length).toBe(1);
      expect(result.facts[0]?.object).toBe("Sam");
      expect(result.facts[0]?.predicate).toBe("name");
      expect(result.costUsd).toBe(0.005);
      expect(result.inferenceOutcome).toBe("completed");
    }
    // Verify prompt template substitution happened with transcript text
    expect(capturedPrompt).toContain("Hi I'm Sam");
    expect(capturedPrompt).toContain("TRANSCRIPT:");
    expect(capturedPrompt).not.toContain("{{TRANSCRIPT}}");
  });

  test("returns failure on engine error", async () => {
    const mockEngine = {
      complete: async (_prompt: string): Promise<{ text: string; costUsd: number }> => {
        throw new Error("rate-limited");
      },
    };
    const result = await handleExtractionTurn({
      transcript: sampleTranscript,
      engine: mockEngine,
      promptTemplate: "x",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("rate-limited");
      expect(result.costUsd).toBe(0);
      expect(result.inferenceOutcome).toBe("failed");
    }
  });

  test("forwards cancellation to the extraction engine and does not swallow abort", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const mockEngine = {
      complete: async (_prompt: string, options?: { signal?: AbortSignal }) => {
        observedSignal = options?.signal;
        markStarted();
        await new Promise<void>((_done, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () =>
              reject(options.signal?.reason ?? new DOMException("Operation aborted", "AbortError")),
            { once: true },
          );
        });
        return { text: "must not complete", costUsd: 0 };
      },
    };
    const pending = handleExtractionTurn({
      transcript: sampleTranscript,
      engine: mockEngine,
      promptTemplate: "x",
      signal: controller.signal,
    });
    await started;
    controller.abort(new DOMException("caller left", "AbortError"));

    expect(observedSignal).toBe(controller.signal);
    expect(pending).rejects.toThrow("caller left");
  });

  test("forwards safe fenced operation metadata to the extraction engine", async () => {
    let observed: ModelCompleteOptions | undefined;
    const executionContext: ExecutionTraceContextV1 = {
      version: 1,
      executionId: "execution-1",
      attempt: 2,
      correlationId: "correlation-1",
    };
    const executionAuthority: ExecutionAuthorityV1 = {
      version: 1,
      attempt: 2,
      fence: 7,
    };
    const engine = {
      complete: async (_prompt: string, options?: ModelCompleteOptions) => {
        observed = options;
        return { text: "[]", costUsd: 0.001 };
      },
    };

    await handleExtractionTurn({
      transcript: sampleTranscript,
      engine,
      promptTemplate: "{{TRANSCRIPT}}",
      executionContext,
      executionAuthority,
      operationId: `auggy-op-v1-${"a".repeat(64)}`,
    });

    expect(observed).toEqual({
      executionContext,
      executionAuthority,
      operationId: `auggy-op-v1-${"a".repeat(64)}`,
    });
    expect(JSON.stringify(observed)).not.toContain("bindingHash");
    expect(JSON.stringify(observed)).not.toContain("idempotencyKeyHash");
  });

  test("returns failure on malformed JSON response", async () => {
    const mockEngine = {
      complete: async (_prompt: string) => ({ text: "not json", costUsd: 0.002 }),
    };
    const result = await handleExtractionTurn({
      transcript: sampleTranscript,
      engine: mockEngine,
      promptTemplate: "x",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // costUsd surfaces even when parse fails — the engine call succeeded
      expect(result.costUsd).toBe(0.002);
      expect(result.inferenceOutcome).toBe("completed");
    }
  });
});
