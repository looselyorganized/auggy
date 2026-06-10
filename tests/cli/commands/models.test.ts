import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  formatModelsDoctor,
  formatModelsList,
  modelsCommand,
  runModelsDoctor,
} from "../../../src/cli/commands/models";
import type { ModelRegistryResult } from "../../../src/cli/model-registry";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "models-command-test-"));
  roots.push(root);
  return root;
}

function writeAgent(
  root: string,
  name: string,
  opts: {
    model?: string;
    costOverride?: Record<string, unknown>;
    budgets?: boolean;
  } = {},
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agent.yaml"),
    stringify({
      id: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
      name,
      engine: {
        provider: "anthropic",
        model: opts.model ?? "claude-sonnet-4-6",
        ...(opts.costOverride ? { costOverride: opts.costOverride } : {}),
      },
      augments: [
        { type: "webTransport", options: { port: 8080 } },
        ...(opts.budgets
          ? [{ type: "budgets", options: { dbPath: "./data/budgets.db", dailyBudgetUsd: 5 } }]
          : []),
      ],
    }),
  );
  return dir;
}

describe("formatModelsList", () => {
  test("prints a compact model table", () => {
    const result: ModelRegistryResult = {
      warnings: [],
      models: [
        {
          provider: "anthropic",
          id: "claude-sonnet-4-6",
          pricing: { inputUsdPerMtok: 3, outputUsdPerMtok: 15 },
          tools: true,
          source: "static",
          status: "known",
        },
      ],
    };

    const out = formatModelsList(result, { color: false });

    expect(out).toContain("Models");
    expect(out).toContain("anthropic  claude-sonnet-4-6");
    expect(out).toContain("$3/M");
    expect(out).toContain("$15/M");
    expect(out).toContain("yes");
    expect(out).toContain("static");
  });

  test("prints provider warnings after the table", () => {
    const out = formatModelsList(
      { models: [], warnings: ["openai: missing key"] },
      { color: false },
    );

    expect(out).toContain("No models found.");
    expect(out).toContain("WARN: openai: missing key");
  });
});

describe("runModelsDoctor", () => {
  test("passes known model pricing", () => {
    const root = tempRoot();
    writeAgent(root, "zip");

    const result = runModelsDoctor("zip", { cwd: root });
    const out = formatModelsDoctor(result);

    expect(result.pricing.status).toBe("known");
    expect(out).toContain("PASS model pricing: anthropic/claude-sonnet-4-6 $3/$15 per Mtok");
  });

  test("warns when USD budgets use an unknown model without costOverride", () => {
    const root = tempRoot();
    writeAgent(root, "zip", { model: "claude-future-99", budgets: true });

    const result = runModelsDoctor("zip", { cwd: root });
    const out = formatModelsDoctor(result);

    expect(result.pricing.status).toBe("unknown");
    expect(result.usdBudgets).toBe(true);
    expect(out).toContain("WARN model pricing");
    expect(out).toContain("cannot enforce dollar spend");
    expect(out).toContain("engine.costOverride");
  });
});

describe("modelsCommand", () => {
  test("list subcommand prints JSON", async () => {
    const exit = mock((_code: number) => {});
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => {
      logs.push(String(msg));
    };

    try {
      const command = modelsCommand({
        exit,
        listModelRegistry: async () => ({
          warnings: [],
          models: [
            {
              provider: "openai",
              id: "gpt-5",
              pricing: { inputUsdPerMtok: 5, outputUsdPerMtok: 20 },
              source: "static",
              status: "known",
            },
          ],
        }),
      });
      await command.parseAsync(["list", "openai", "--json"], { from: "user" });

      expect(JSON.parse(logs[0] ?? "{}").models[0].id).toBe("gpt-5");
      expect(exit).not.toHaveBeenCalledWith(1);
    } finally {
      console.log = origLog;
    }
  });
});
