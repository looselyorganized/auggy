import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { createTurnLoop } from "@/kernel/turn-loop";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTokenizer } from "@/tokenizer";
import type { Augment, TurnTrigger, PeerIdentity, InboundMessage, ToolResult } from "@/types";

function makeTrigger(text: string): TurnTrigger {
  const peer: PeerIdentity = {
    id: "p1",
    kind: "human",
    trustLevel: "public",
    publicSubstate: "anonymous",
    sourceAugment: "test",
  };
  return {
    type: "message",
    turnId: crypto.randomUUID(),
    timestamp: Date.now(),
    source: "test",
    peer,
    payload: {
      parts: [{ kind: "text", text }],
      sourceAugment: "test",
      peer,
      timestamp: Date.now(),
    } satisfies InboundMessage,
  };
}

function identityAugment(): Augment {
  return {
    name: "identity",
    required: true,
    context: async () => [
      {
        source: "identity",
        content: "You are a test agent.",
        placement: "system",
        provenance: "identity",
        priority: "required",
        eviction: "never",
        origin: "operator",
      },
    ],
  };
}

describe("TurnLoop — terminate directive", () => {
  it("ends turn with input-required when a tool returns ToolResult.terminate", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "ask_user", arguments: { prompt: "What date?" } }],
      finishReason: "tool_use",
    });
    // No second response is expected — turn should end after the tool runs.

    const askAugment: Augment = {
      name: "asker",
      tools: [
        {
          name: "ask_user",
          description: "ask the user something",
          category: "meta",
          input: z.object({ prompt: z.string() }),
          execute: async ({ prompt }): Promise<ToolResult> => ({
            content: prompt,
            terminate: { status: "input-required", message: prompt },
          }),
        },
      ],
    };

    const loop = createTurnLoop({
      augments: [identityAugment(), askAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("hi"), "thread-1");

    expect(result.status).toBe("input-required");
    expect(result.success).toBe(true);
    expect(model.calls).toHaveLength(1); // turn ended; no second model.complete()
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe("ask_user");
  });

  it("ignores terminate when the tool throws (error path wins)", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "buggy_ask", arguments: { prompt: "hi" } }],
      finishReason: "tool_use",
    });
    // After the buggy tool returns an error, the kernel does NOT short-circuit
    // — it loops back to the model. The next response ends the turn normally.
    model.pushResponse({ content: "I see an error happened.", finishReason: "end_turn" });

    const buggyAugment: Augment = {
      name: "buggy",
      tools: [
        {
          name: "buggy_ask",
          description: "throws then tries to terminate",
          category: "meta",
          input: z.object({ prompt: z.string() }),
          execute: async (): Promise<ToolResult> => {
            throw new Error("boom");
          },
        },
      ],
    };

    const loop = createTurnLoop({
      augments: [identityAugment(), buggyAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("hi"), "thread-1");

    expect(result.status).toBe("completed"); // model resumed after the error
    expect(model.calls).toHaveLength(2); // kernel did NOT short-circuit
  });

  it("runs all tool calls when one carries terminate; first directive wins", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [
        { name: "ask_user", arguments: { prompt: "What date?" } },
        { name: "log_event", arguments: { msg: "user-asked" } },
      ],
      finishReason: "tool_use",
    });

    let logCalls = 0;
    const askAugment: Augment = {
      name: "asker",
      tools: [
        {
          name: "ask_user",
          description: "ask",
          category: "meta",
          input: z.object({ prompt: z.string() }),
          execute: async ({ prompt }): Promise<ToolResult> => ({
            content: prompt,
            terminate: { status: "input-required", message: prompt },
          }),
        },
        {
          name: "log_event",
          description: "side effect",
          category: "meta",
          input: z.object({ msg: z.string() }),
          execute: async ({ msg }) => {
            logCalls += 1;
            return `logged:${msg}`;
          },
        },
      ],
    };

    const loop = createTurnLoop({
      augments: [identityAugment(), askAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("hi"), "thread-1");

    expect(result.status).toBe("input-required");
    expect(logCalls).toBe(1); // side-effect tool DID execute
    expect(result.toolCalls).toHaveLength(2);
    expect(model.calls).toHaveLength(1); // turn ended after the batch
  });

  it("rejects spoofed terminate.status outside the input-required|completed allowlist", async () => {
    // A custom JS augment (or a TS one using `as` casts) could try to set
    // terminate.status to a kernel-controlled state like "failed" / "rejected".
    // The kernel must runtime-validate and ignore such directives.
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "spoof", arguments: {} }],
      finishReason: "tool_use",
    });
    // After the spoof is rejected, the kernel falls through to the next
    // inference iteration. Provide a follow-up response so the turn ends.
    model.pushResponse({ content: "ok", finishReason: "end_turn" });

    const spoofAugment: Augment = {
      name: "spoofer",
      tools: [
        {
          name: "spoof",
          description: "tries to spoof a kernel-controlled status",
          category: "meta",
          input: z.object({}),
          execute: async (): Promise<ToolResult> => ({
            content: "spoofed",
            // biome-ignore lint/suspicious/noExplicitAny: deliberately bypasses compile-time narrowing to exercise runtime allowlist
            terminate: { status: "failed" as any, message: "should be ignored" },
          }),
        },
      ],
    };

    const loop = createTurnLoop({
      augments: [identityAugment(), spoofAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    const result = await loop.executeTurn(makeTrigger("hi"), "thread-1");

    // Kernel rejected the spoof; turn continued to the second model response
    // and ended normally as "completed".
    expect(result.status).toBe("completed");
    expect(model.calls).toHaveLength(2);
  });

  it("emits the directive's message as a normal text_message before run_finished", async () => {
    // Codex Critical finding: without a text_message event, the prompt is only
    // visible inside the (collapsed by default) tool-call panel and old AG-UI
    // consumers see literally nothing. The kernel must emit the message as a
    // normal assistant text event before the terminal run_finished.
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "ask_user", arguments: { prompt: "What date?" } }],
      finishReason: "tool_use",
    });

    const askAugment: Augment = {
      name: "asker",
      tools: [
        {
          name: "ask_user",
          description: "ask the user something",
          category: "meta",
          input: z.object({ prompt: z.string() }),
          execute: async ({ prompt }): Promise<ToolResult> => ({
            content: prompt,
            terminate: { status: "input-required", message: prompt },
          }),
        },
      ],
    };

    const events: Array<{ kind: string; text?: string; status?: string }> = [];
    const loop = createTurnLoop({
      augments: [identityAugment(), askAugment],
      model,
      tokenizer: createTokenizer(),
      config: { name: "test", model: "mock", augments: [] },
    });

    await loop.executeTurn(makeTrigger("hi"), "thread-1", {
      onEvent: (ev) => events.push(ev as { kind: string; text?: string; status?: string }),
    });

    const textMsg = events.find((e) => e.kind === "text_message" && e.text === "What date?");
    const runFinished = events.find((e) => e.kind === "run_finished");
    expect(textMsg).toBeDefined();
    expect(runFinished).toBeDefined();
    // Order: text_message must appear before run_finished so consumers see the
    // assistant's reply before the terminal event.
    const textIdx = events.findIndex((e) => e.kind === "text_message" && e.text === "What date?");
    const finishedIdx = events.findIndex((e) => e.kind === "run_finished");
    expect(textIdx).toBeLessThan(finishedIdx);
  });
});
