import { expect, test } from "bun:test";
import { cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEvalArgs, selectEvalModel } from "@evals/harness/model-selection";
import { bootModularityAgent } from "@evals/modularity/boot-agent";
import { createTempDir } from "../../fixtures/temp-dir";

test("tool choice is specific to the direct Fable 5.2 ID", () => {
  expect(parseEvalArgs([])).toMatchObject({ pilot: false });
  expect(() => parseEvalArgs(["--model"])).toThrow();
  expect(() => parseEvalArgs(["--model", ""])).toThrow();
  expect(
    selectEvalModel({ provider: "openrouter", model: "anthropic/claude-fable-5.2" }).tool_choice,
  ).toBe("any");
  expect(selectEvalModel({ provider: "anthropic", model: "claude-fable-5" }).tool_choice).toBe(
    "any",
  );
});

test("all four modularity conditions boot with the selected model or their YAML default", async () => {
  const directory = await createTempDir();
  const originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-fixture";
  try {
    cpSync(
      resolve(import.meta.dir, "../../../packages/evals/src/modularity/agents"),
      directory.path,
      { recursive: true },
    );
    for (const args of [[], ["--pilot", "--model", "claude-fable-5-2"]]) {
      const { model: override } = parseEvalArgs(args);
      for (const condition of ["minimal", "light", "moderate", "full"]) {
        const { agent, selection } = await bootModularityAgent(
          join(directory.path, `${condition}.yaml`),
          override,
        );
        try {
          expect(selection).toEqual({
            provider: "anthropic",
            model: override ?? "claude-sonnet-4-6",
            tool_choice: override ? "auto" : "any",
          });
          expect(agent.card().skills?.some((tool) => tool.name === "web_fetch")).toBe(true);
        } finally {
          await agent.stop();
        }
      }
    }
  } finally {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    await directory.cleanup();
  }
});
