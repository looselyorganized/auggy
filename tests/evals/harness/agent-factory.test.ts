import { describe, expect, test } from "bun:test";
import { buildEvalAgent } from "../../../evals/harness/agent-factory";
import { createMockModel } from "../../fixtures/mock-model";
import type { ToolSpec } from "../../../evals/harness/types";
import type { TurnTrigger } from "../../../src/types";

const SPECS: ToolSpec[] = [
  { name: "get_weather", description: "Get weather", domain: "weather", inputSchema: {} },
  { name: "get_forecast", description: "Get forecast", domain: "weather", inputSchema: {} },
  { name: "send_email", description: "Send email", domain: "communication", inputSchema: {} },
  { name: "read_file", description: "Read file", domain: "files", inputSchema: {} },
];

function makeTrigger(text: string): TurnTrigger {
  return {
    type: "message",
    turnId: `test-${Date.now()}`,
    timestamp: Date.now(),
    source: "eval",
    payload: {
      parts: [{ type: "text" as const, text }],
      sourceAugment: "eval",
      peer: null,
      timestamp: Date.now(),
    },
  };
}

describe("buildEvalAgent", () => {
  test("constructs an agent that can start and stop", async () => {
    const model = createMockModel();
    const agent = buildEvalAgent(SPECS, [], model);
    await agent.start();
    const health = agent.health();
    expect(health.status).toBe("healthy");
    await agent.stop();
  });

  test("with no neverExpose, all tools appear in card", async () => {
    const model = createMockModel();
    const agent = buildEvalAgent(SPECS, [], model);
    await agent.start();
    const card = agent.card();
    const skillNames = card.skills?.map((s) => s.name) ?? [];
    for (const spec of SPECS) {
      expect(skillNames).toContain(spec.name);
    }
    await agent.stop();
  });

  test("with neverExpose, blocked tools are withheld at runtime", async () => {
    const model = createMockModel();
    const blocked = ["get_forecast", "send_email", "read_file"];
    const agent = buildEvalAgent(SPECS, blocked, model);
    await agent.start();
    const result = await agent.inject(makeTrigger("What's the weather?"));
    expect(result.trace.toolSelection.mountedTools).toContain("get_weather");
    for (const name of blocked) {
      expect(result.trace.toolSelection.mountedTools).not.toContain(name);
      expect(result.trace.toolSelection.withheldTools).toContain(name);
    }
    await agent.stop();
  });

  test("inject returns a TurnResult with trace showing tool selection", async () => {
    const model = createMockModel();
    const agent = buildEvalAgent(SPECS, [], model);
    await agent.start();
    const result = await agent.inject(makeTrigger("What's the weather?"));
    expect(result.trace.toolSelection.mountedTools.length).toBe(SPECS.length);
    expect(result.trace.toolSelection.withheldTools.length).toBe(0);
    await agent.stop();
  });

  test("maxInferenceLoops defaults to 1", async () => {
    const model = createMockModel({
      toolCalls: [{ name: "get_weather", arguments: {} }],
    });
    const agent = buildEvalAgent(SPECS, [], model);
    await agent.start();
    await agent.inject(makeTrigger("What's the weather?"));
    expect(model.calls.length).toBe(1);
    await agent.stop();
  });
});
