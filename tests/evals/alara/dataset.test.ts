import { describe, expect, test } from "bun:test";
import { generateTasks } from "@evals/alara/dataset";

describe("generateTasks", () => {
  test("determinism — same seed produces same output", () => {
    const a = generateTasks(4, 42, 10);
    const b = generateTasks(4, 42, 10);
    expect(a).toEqual(b);
  });

  test("different seeds produce different output", () => {
    const a = generateTasks(4, 42, 10);
    const b = generateTasks(4, 137, 10);
    const aIds = a.map((t) => t.expectedTool);
    const bIds = b.map((t) => t.expectedTool);
    expect(aIds).not.toEqual(bIds);
  });

  test("catalog size 1 — single tool, no distractors", () => {
    const tasks = generateTasks(1, 42, 5);
    for (const task of tasks) {
      expect(task.catalogTools).toHaveLength(1);
      expect(task.catalogTools[0]).toBe(task.expectedTool);
      expect(task.toolSpecs).toHaveLength(1);
    }
  });

  test("catalog size matches requested size", () => {
    for (const size of [2, 4, 8, 16]) {
      const tasks = generateTasks(size, 42, 5);
      for (const task of tasks) {
        expect(task.catalogTools).toHaveLength(size);
        expect(task.toolSpecs).toHaveLength(size);
      }
    }
  });

  test("correct tool is always in catalog", () => {
    const tasks = generateTasks(8, 42, 20);
    for (const task of tasks) {
      expect(task.catalogTools).toContain(task.expectedTool);
    }
  });

  test("no duplicate tools in catalog", () => {
    const tasks = generateTasks(8, 42, 20);
    for (const task of tasks) {
      const unique = new Set(task.catalogTools);
      expect(unique.size).toBe(task.catalogTools.length);
    }
  });

  test("distractors are mostly same-domain when possible", () => {
    const tasks = generateTasks(4, 42, 50);
    let sameDomainDistractors = 0;
    let totalDistractors = 0;

    for (const task of tasks) {
      const correctSpec = task.toolSpecs.find((s) => s.name === task.expectedTool);
      if (!correctSpec) continue;
      for (const spec of task.toolSpecs) {
        if (spec.name === task.expectedTool) continue;
        totalDistractors++;
        if (spec.domain === correctSpec.domain) sameDomainDistractors++;
      }
    }

    const ratio = sameDomainDistractors / totalDistractors;
    expect(ratio).toBeGreaterThan(0.3);
  });

  test("prompts are non-empty strings", () => {
    const tasks = generateTasks(4, 42, 10);
    for (const task of tasks) {
      expect(task.prompt.length).toBeGreaterThan(10);
    }
  });

  test("task IDs include catalog size and seed", () => {
    const tasks = generateTasks(8, 137, 5);
    for (const task of tasks) {
      expect(task.id).toContain("8");
      expect(task.id).toContain("137");
    }
  });

  test("catalog size 32 — uses all available templates", () => {
    const tasks = generateTasks(20, 42, 5);
    for (const task of tasks) {
      expect(task.catalogTools).toHaveLength(20);
    }
  });
});
