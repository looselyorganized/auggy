import { describe, it, expect, afterEach } from "bun:test";
import { defineAgent } from "@/agent";
import { webTransport } from "@/transports/web-transport";
import { turnControl } from "@/augments/turnControl";
import { createMockModel } from "@tests/fixtures/mock-model";
import type { AgentHandle } from "@/types";

/**
 * End-to-end integration test for roadmap item 9 (request_input).
 *
 * Boots a real agent with `turnControl` + `webTransport`, posts a message
 * over HTTP, parses the SSE stream, and asserts that the terminal
 * RUN_FINISHED event carries `result.status === "input-required"` and
 * `result.message === <prompt>`.
 *
 * Exercises the full slice:
 *   model.tool_use → augment ToolResult.terminate → kernel turn-loop honors
 *   terminate → run_finished kernel event with status → AG-UI translator
 *   emits RUN_FINISHED.result → web-transport patchThreadId preserves
 *   result → SSE serialization → consumer parses result.status.
 */
describe("integration: input-required via web-transport", () => {
  let agent: AgentHandle | undefined;

  afterEach(async () => {
    try {
      await agent?.stop();
    } catch {
      // ignore — may already be stopped
    }
    agent = undefined;
  });

  it("ends the turn with RUN_FINISHED.result.status === 'input-required'", async () => {
    const model = createMockModel();
    model.pushResponse({
      content: "",
      toolCalls: [{ name: "request_input", arguments: { prompt: "What is your name?" } }],
      finishReason: "tool_use",
    });

    const port = 18975;
    const transport = webTransport({
      port,
      auth: { type: "bearer", token: "integration-token" },
    });

    agent = defineAgent(
      {
        name: "ask-bot",
        purpose: "asks for input",
        model: "mock",
        augments: [turnControl(), transport],
      },
      model,
    );

    await agent.start();

    const resp = await fetch(`http://127.0.0.1:${port}/agent/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer integration-token",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");

    const body = await resp.text();
    const events = body
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice("data: ".length))) as Array<{
      type: string;
      threadId?: string;
      result?: { status: string; message?: string };
    }>;

    const finished = events.find((e) => e.type === "RUN_FINISHED");
    expect(finished).toBeDefined();
    expect(typeof finished?.threadId).toBe("string");
    expect(finished?.threadId?.length).toBeGreaterThan(0);
    expect(finished?.result).toBeDefined();
    expect(finished?.result?.status).toBe("input-required");
    expect(finished?.result?.message).toBe("What is your name?");

    // The prompt must also appear as a normal assistant text message so chat
    // widgets render it in the message bubble (not just inside the tool-call
    // panel) and old AG-UI consumers see something. The kernel emits a
    // `text_message` event before `run_finished` for the directive's message;
    // the AG-UI translator expands it into TEXT_MESSAGE_START / _CONTENT / _END.
    const textContent = events.find(
      (e) =>
        e.type === "TEXT_MESSAGE_CONTENT" &&
        (e as unknown as { delta?: string }).delta === "What is your name?",
    );
    expect(textContent).toBeDefined();
  }, 30_000);
});
