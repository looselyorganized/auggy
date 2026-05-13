import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Drives `runCreate` non-interactively by stubbing `@inquirer/prompts` and
 * verifies the Phase-4 contract:
 *
 *  - per-agent `package.json` is written with `auggy` + the chosen engine
 *    adapter as `dependencies`
 *  - selected augments' `packageDeps` are merged in
 *  - `bun install` is invoked in the agent dir (mocked subprocess factory)
 *  - `--skip-install` writes `package.json` but does NOT invoke install
 *
 * The mock must register BEFORE create.ts is imported so the bound prompt
 * references resolve to our stubs.
 */

interface Answers {
  provider?: string;
  model?: string;
  operatorName?: string;
  purpose?: string;
  augmentTypes?: string[]; // catalog entry types to "select"
}

let answers: Answers = {};

mock.module("@inquirer/prompts", () => ({
  select: async (config: { message: string; choices: Array<{ name: string; value: unknown }> }) => {
    if (config.message.startsWith("Engine provider")) return answers.provider ?? "anthropic";
    if (config.message.startsWith("Model:")) return answers.model ?? "claude-sonnet-4-6";
    return config.choices[0]?.value;
  },
  input: async (config: { message: string; default?: string }) => {
    if (config.message.startsWith("Operator name")) return answers.operatorName ?? "tester";
    if (config.message.startsWith("Agent purpose")) return answers.purpose ?? "testing";
    return config.default ?? "";
  },
  checkbox: async (config: {
    choices: Array<{ value: { type: string }; checked?: boolean; disabled?: string | boolean }>;
  }) => {
    // Required entries are pre-checked + disabled; treat the stub answer as
    // additional optional selections on top.
    const wanted = new Set(answers.augmentTypes ?? []);
    return config.choices
      .filter((c) => c.checked || wanted.has(c.value.type))
      .map((c) => c.value);
  },
  confirm: async (config: { default?: boolean }) => config.default ?? false,
}));

const { runCreate } = await import("../../src/cli/commands/create");
const { getAgent } = await import("../../src/cli/agent-index");
const { PROVIDER_TO_PACKAGE } = await import("../../src/cli/scaffold-package-json");

let auggyDir: string;
let agentParent: string;
let bunInstallCalls: Array<{ cmd: string[]; cwd: string }>;

const stubSpawn = () => {
  return (cmd: string[], opts: { cwd: string }) => {
    bunInstallCalls.push({ cmd, cwd: opts.cwd });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    return { exited: Promise.resolve(0), stderr };
  };
};

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "create-test-auggy-"));
  agentParent = mkdtempSync(join(tmpdir(), "create-test-agents-"));
  bunInstallCalls = [];
  answers = {};
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
  rmSync(agentParent, { recursive: true, force: true });
});

describe("runCreate writes per-agent package.json", () => {
  test("Anthropic-only: package.json lists auggy + @auggy/anthropic and nothing else", async () => {
    const dir = join(agentParent, "demo-anthropic");
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-anthropic", {
      dir,
      auggyDir,
      bunInstallSpawn: stubSpawn(),
    });

    expect(existsSync(join(dir, "package.json"))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    expect(pkg.name).toBe("auggy-agent-demo-anthropic");
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe("module");
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      "@auggy/anthropic",
      "auggy",
    ]);
    // No leak of other engine adapters.
    expect(pkg.dependencies["@auggy/openai"]).toBeUndefined();
    expect(pkg.dependencies["@auggy/openrouter"]).toBeUndefined();
    expect(pkg.dependencies["@auggy/link"]).toBeUndefined();
    expect(pkg.dependencies.openai).toBeUndefined();
  });

  test("provider=openai writes @auggy/openai adapter", async () => {
    const dir = join(agentParent, "demo-openai");
    answers = { provider: "openai", model: "gpt-5" };

    await runCreate("demo-openai", {
      dir,
      auggyDir,
      bunInstallSpawn: stubSpawn(),
    });

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    expect(pkg.dependencies[PROVIDER_TO_PACKAGE.openai]).toBeDefined();
    expect(pkg.dependencies[PROVIDER_TO_PACKAGE.anthropic]).toBeUndefined();
  });

  test("selecting `link` augment merges @auggy/link from catalog packageDeps", async () => {
    const dir = join(agentParent, "demo-with-link");
    answers = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      augmentTypes: ["link"],
    };

    await runCreate("demo-with-link", {
      dir,
      auggyDir,
      bunInstallSpawn: stubSpawn(),
    });

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    expect(pkg.dependencies["@auggy/link"]).toBe("^0.1.2");
    expect(pkg.dependencies["@auggy/anthropic"]).toBeDefined();
  });
});

describe("runCreate invokes bun install in agent dir", () => {
  test("runs `bun install` with cwd = agent dir by default", async () => {
    const dir = join(agentParent, "demo-install");
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-install", {
      dir,
      auggyDir,
      bunInstallSpawn: stubSpawn(),
    });

    expect(bunInstallCalls).toHaveLength(1);
    expect(bunInstallCalls[0]?.cmd).toEqual(["bun", "install"]);
    expect(bunInstallCalls[0]?.cwd).toBe(dir);
  });

  test("--skip-install writes package.json but does NOT invoke bun install", async () => {
    const dir = join(agentParent, "demo-skip");
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-skip", {
      dir,
      auggyDir,
      skipInstall: true,
      bunInstallSpawn: stubSpawn(),
    });

    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(bunInstallCalls).toHaveLength(0);
  });

  test("failed install leaves the agent dir + index entry intact (fail-soft)", async () => {
    const dir = join(agentParent, "demo-failsoft");
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    const failingSpawn = () => {
      return (_cmd: string[], _opts: { cwd: string }) => {
        const encoder = new TextEncoder();
        const stderrBytes = encoder.encode("error: network unreachable\n");
        const stderr = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(stderrBytes);
            controller.close();
          },
        });
        return { exited: Promise.resolve(1), stderr };
      };
    };

    await runCreate("demo-failsoft", {
      dir,
      auggyDir,
      bunInstallSpawn: failingSpawn(),
    });

    // Agent dir survives (no rollback).
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(existsSync(join(dir, "agent.yaml"))).toBe(true);
    // Index entry written.
    expect(getAgent("demo-failsoft", { auggyDir })).not.toBeNull();
  });
});

describe("runCreate scaffolding integration", () => {
  test("agent.yaml + identity.md + skills/ + workspace/ all still scaffolded", async () => {
    const dir = join(agentParent, "demo-full");
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-full", {
      dir,
      auggyDir,
      bunInstallSpawn: stubSpawn(),
    });

    expect(existsSync(join(dir, "agent.yaml"))).toBe(true);
    expect(existsSync(join(dir, "identity.md"))).toBe(true);
    expect(existsSync(join(dir, "skills"))).toBe(true);
    expect(existsSync(join(dir, "workspace"))).toBe(true);
    expect(existsSync(join(dir, ".env.example"))).toBe(true);
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    expect(existsSync(join(dir, "package.json"))).toBe(true);
  });

  test("registers the agent in the index with the correct localDir", async () => {
    const dir = join(agentParent, "demo-indexed");
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-indexed", {
      dir,
      auggyDir,
      bunInstallSpawn: stubSpawn(),
    });

    const entry = getAgent("demo-indexed", { auggyDir });
    expect(entry).not.toBeNull();
    expect(entry?.localDir).toBe(dir);
  });
});
