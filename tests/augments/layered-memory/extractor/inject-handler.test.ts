import { describe, expect, test } from "bun:test";
import { handleExtractionTurn } from "@/augments/layeredMemory/extractor/inject-handler";
import type { Transcript } from "@/types";

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
    }
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
    }
  });
});
