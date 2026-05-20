import { describe, expect, test } from "bun:test";
import { exactToolMatch } from "@evals/alara/graders/exact-tool-match";
import type { EvalTask } from "@evals/harness/types";

function makeTask(overrides?: Partial<EvalTask>): EvalTask {
  return {
    id: "test-task-1",
    prompt: "What is the weather in Berlin?",
    expectedTool: "get_weather",
    catalogSize: 4,
    seed: 42,
    catalogTools: ["get_weather", "get_forecast", "send_email", "read_file"],
    toolSpecs: [],
    ...overrides,
  };
}

describe("exactToolMatch", () => {
  test("passes when correct tool is the only call", () => {
    const result = exactToolMatch(makeTask(), ["get_weather"]);
    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("passes when correct tool is called among extras", () => {
    const result = exactToolMatch(makeTask(), ["get_weather", "get_forecast"]);
    expect(result.passed).toBe(true);
    expect(result.reason).toContain("extras");
  });

  test("fails when wrong tool is called", () => {
    const result = exactToolMatch(makeTask(), ["get_forecast"]);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("get_weather");
    expect(result.reason).toContain("get_forecast");
  });

  test("fails when no tool is called", () => {
    const result = exactToolMatch(makeTask(), []);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("(none)");
  });

  test("fails when multiple wrong tools are called", () => {
    const result = exactToolMatch(makeTask(), ["send_email", "read_file"]);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("send_email");
  });

  test("type is always tool_called", () => {
    const pass = exactToolMatch(makeTask(), ["get_weather"]);
    const fail = exactToolMatch(makeTask(), []);
    expect(pass.type).toBe("tool_called");
    expect(fail.type).toBe("tool_called");
  });
});
