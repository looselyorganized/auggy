import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { EngineConfig } from "../../src/cli/types";
import { mockInquirerPrompts, type Answers } from "../fixtures/inquirer-mock";
import { createStubBunInstallSpawn } from "../fixtures/bun-install-stub";

/**
 * Phase 4.5 — canonical end-to-end regression test for the v0.3.2 release gate.
 *
 * Drives `runCreate` non-interactively, fabricates the agent's
 * `node_modules/@auggy/<engine>` resolution tree from workspace symlinks
 * (avoids needing the published package), then calls `resolveEngine` against
 * the agent dir and asserts the engine constructs.
 */

let answers: Answers = {};
mockInquirerPrompts(() => answers);

const { runCreate } = await import("../../src/cli/commands/create");
const { resolveEngine } = await import("../../src/cli/engine-resolver");

const REPO_ROOT = process.cwd();

function fabricateNodeModules(
  agentDir: string,
  engineProvider: "anthropic" | "openai" | "openrouter",
): void {
  const nm = join(agentDir, "node_modules");
  mkdirSync(nm, { recursive: true });
  symlinkSync(REPO_ROOT, join(nm, "auggy"));

  mkdirSync(join(nm, "@auggy"), { recursive: true });
  symlinkSync(join(REPO_ROOT, "packages", engineProvider), join(nm, "@auggy", engineProvider));
  if (engineProvider === "openrouter") {
    symlinkSync(join(REPO_ROOT, "packages", "openai"), join(nm, "@auggy", "openai"));
  }
}

let auggyDir: string;

function agentDirFor(name: string): string {
  return join(auggyDir, "agents", name);
}

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "e2e-auggy-"));
  answers = {};
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
});

describe("end-to-end: create → fabricate install → resolveEngine", () => {
  test("Anthropic scaffold yields a resolveable engine", async () => {
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-anthropic", {
      auggyDir,
      skipInstall: true,
      bunInstallSpawn: createStubBunInstallSpawn(),
    });

    const dir = agentDirFor("demo-anthropic");
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    fabricateNodeModules(dir, "anthropic");

    const agentYaml = parseYaml(readFileSync(join(dir, "agent.yaml"), "utf-8")) as {
      engine: EngineConfig;
    };

    const engine = await resolveEngine(agentYaml.engine, dir);

    expect(engine).toBeDefined();
    expect(engine.maxContextTokens).toBeGreaterThan(0);
    expect(typeof engine.countTokens).toBe("function");
    expect(typeof engine.complete).toBe("function");
  });

  test("OpenAI scaffold yields a resolveable engine", async () => {
    answers = { provider: "openai", model: "gpt-5" };

    process.env.OPENAI_API_KEY = "sk-test-fabricated";

    await runCreate("demo-openai", {
      auggyDir,
      skipInstall: true,
      bunInstallSpawn: createStubBunInstallSpawn(),
    });

    const dir = agentDirFor("demo-openai");
    fabricateNodeModules(dir, "openai");

    const agentYaml = parseYaml(readFileSync(join(dir, "agent.yaml"), "utf-8")) as {
      engine: EngineConfig;
    };
    const engine = await resolveEngine(agentYaml.engine, dir);
    expect(engine.maxContextTokens).toBeGreaterThan(0);
    expect(typeof engine.complete).toBe("function");
  });

  test("OpenRouter scaffold yields a resolveable engine (requires @auggy/openai workspace dep)", async () => {
    answers = {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4-6",
    };

    process.env.OPENROUTER_API_KEY = "sk-or-test-fabricated";

    await runCreate("demo-openrouter", {
      auggyDir,
      skipInstall: true,
      bunInstallSpawn: createStubBunInstallSpawn(),
    });

    const dir = agentDirFor("demo-openrouter");
    fabricateNodeModules(dir, "openrouter");

    const agentYaml = parseYaml(readFileSync(join(dir, "agent.yaml"), "utf-8")) as {
      engine: EngineConfig;
    };
    const engine = await resolveEngine(agentYaml.engine, dir);
    expect(engine.maxContextTokens).toBeGreaterThan(0);
    expect(typeof engine.complete).toBe("function");
  });

  test("agent without fabricated node_modules surfaces the diagnostic missing-dep error", async () => {
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-no-install", {
      auggyDir,
      skipInstall: true,
      bunInstallSpawn: createStubBunInstallSpawn(),
    });

    const dir = agentDirFor("demo-no-install");
    const agentYaml = parseYaml(readFileSync(join(dir, "agent.yaml"), "utf-8")) as {
      engine: EngineConfig;
    };

    await expect(resolveEngine(agentYaml.engine, dir)).rejects.toThrow(
      /Cannot find "@auggy\/anthropic"/,
    );
  });
});
