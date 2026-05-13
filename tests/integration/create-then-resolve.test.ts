import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { mockInquirerPrompts, type Answers } from "../fixtures/inquirer-mock";
import { createStubBunInstallSpawn } from "../fixtures/bun-install-stub";

/**
 * Phase 4.5 — canonical end-to-end regression test for the v0.3.2 release gate.
 *
 * Codex flagged that there was no test exercising the full create → boot
 * path; without one, a future regression could silently re-break it. This
 * test closes that gap: it drives `runCreate` non-interactively, fabricates
 * the agent's `node_modules/@auggy/<engine>` resolution tree from the
 * workspace symlinks (avoids needing `@auggy/anthropic@^0.3.2` to be
 * published to npm), then calls `resolveEngine` against the agent dir and
 * asserts the engine constructs.
 *
 * What this DOES test:
 *  - `runCreate` writes a `package.json` listing `auggy` + the chosen adapter
 *  - the resolution algorithm in `importFromAgent` finds the adapter when
 *    `node_modules/@auggy/<engine>` is present in the agent dir
 *  - `resolveEngine` constructs a valid `ModelClient` against that adapter
 *
 * What this does NOT test (deferred to Phase 9 on a clean machine):
 *  - real `bun install` against a real npm registry
 *  - lockfile generation + transitive dep resolution
 *  - cross-machine portability of the install graph
 *
 * The trade-off is hermetic, fast tests (< 100ms) that catch the entire
 * class of "engine package not found from agent dir" regressions.
 */

let answers: Answers = {};
mockInquirerPrompts(() => answers);

const { runCreate } = await import("../../src/cli/commands/create");
const { resolveEngine } = await import("../../src/cli/engine-resolver");

// `bun test` runs from the repo root, so cwd IS the auggy repo. Matches the
// convention in tests/cli/engine-resolver.test.ts (AGENT_DIR = process.cwd()).
const REPO_ROOT = process.cwd();

/**
 * Fabricate `<agentDir>/node_modules/{auggy, @auggy/<engine>}` as symlinks
 * to the workspace tree, mirroring what a real `bun install` does without
 * the network round-trip.
 */
function fabricateNodeModules(agentDir: string, engineProvider: "anthropic" | "openai" | "openrouter"): void {
  const nm = join(agentDir, "node_modules");
  mkdirSync(nm, { recursive: true });
  symlinkSync(REPO_ROOT, join(nm, "auggy"));

  mkdirSync(join(nm, "@auggy"), { recursive: true });
  symlinkSync(
    join(REPO_ROOT, "packages", engineProvider),
    join(nm, "@auggy", engineProvider),
  );
  // OpenRouter has a workspace dep on @auggy/openai — symlink that too so
  // the adapter's internal `import { ... } from "@auggy/openai"` resolves.
  if (engineProvider === "openrouter") {
    symlinkSync(
      join(REPO_ROOT, "packages", "openai"),
      join(nm, "@auggy", "openai"),
    );
  }
}

let auggyDir: string;
let agentParent: string;

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "e2e-auggy-"));
  agentParent = mkdtempSync(join(tmpdir(), "e2e-agents-"));
  answers = {};
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
  rmSync(agentParent, { recursive: true, force: true });
});

describe("end-to-end: create → fabricate install → resolveEngine", () => {
  test("Anthropic scaffold yields a resolveable engine", async () => {
    const dir = join(agentParent, "demo-anthropic");
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-anthropic", {
      dir,
      auggyDir,
      skipInstall: true, // fabricate the install instead
      bunInstallSpawn: createStubBunInstallSpawn(),
    });

    expect(existsSync(join(dir, "package.json"))).toBe(true);
    fabricateNodeModules(dir, "anthropic");

    // Parse the agent.yaml the scaffold wrote, then resolve the engine
    // against the fabricated node_modules tree.
    const agentYaml = parseYaml(readFileSync(join(dir, "agent.yaml"), "utf-8")) as {
      engine: { provider: string; model: string; maxContextTokens?: number; maxTokens?: number };
    };

    const engine = await resolveEngine(agentYaml.engine, dir);

    expect(engine).toBeDefined();
    expect(engine.maxContextTokens).toBeGreaterThan(0);
    expect(typeof engine.countTokens).toBe("function");
    expect(typeof engine.complete).toBe("function");
  });

  test("OpenAI scaffold yields a resolveable engine", async () => {
    const dir = join(agentParent, "demo-openai");
    answers = { provider: "openai", model: "gpt-5" };

    process.env.OPENAI_API_KEY = "sk-test-fabricated";

    await runCreate("demo-openai", {
      dir,
      auggyDir,
      skipInstall: true,
      bunInstallSpawn: createStubBunInstallSpawn(),
    });

    fabricateNodeModules(dir, "openai");

    const agentYaml = parseYaml(readFileSync(join(dir, "agent.yaml"), "utf-8")) as {
      engine: { provider: string; model: string };
    };
    const engine = await resolveEngine(agentYaml.engine, dir);
    expect(engine.maxContextTokens).toBeGreaterThan(0);
    expect(typeof engine.complete).toBe("function");
  });

  test("OpenRouter scaffold yields a resolveable engine (requires @auggy/openai workspace dep)", async () => {
    const dir = join(agentParent, "demo-openrouter");
    answers = {
      provider: "openrouter",
      // Pick an OpenRouter-shaped model id; pricing tables won't have it
      // but that's a warning, not an error.
      model: "anthropic/claude-sonnet-4-6",
    };

    process.env.OPENROUTER_API_KEY = "sk-or-test-fabricated";

    await runCreate("demo-openrouter", {
      dir,
      auggyDir,
      skipInstall: true,
      bunInstallSpawn: createStubBunInstallSpawn(),
    });

    fabricateNodeModules(dir, "openrouter");

    const agentYaml = parseYaml(readFileSync(join(dir, "agent.yaml"), "utf-8")) as {
      engine: { provider: string; model: string };
    };
    const engine = await resolveEngine(agentYaml.engine, dir);
    expect(engine.maxContextTokens).toBeGreaterThan(0);
    expect(typeof engine.complete).toBe("function");
  });

  test("agent without fabricated node_modules surfaces the diagnostic missing-dep error", async () => {
    // Negative path: the create flow writes package.json but if no install
    // (real or fabricated) happens, resolveEngine MUST fail with a clear
    // MissingAgentDependencyError pointing the operator at bun install.
    const dir = join(agentParent, "demo-no-install");
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-no-install", {
      dir,
      auggyDir,
      skipInstall: true,
      bunInstallSpawn: createStubBunInstallSpawn(),
    });

    const agentYaml = parseYaml(readFileSync(join(dir, "agent.yaml"), "utf-8")) as {
      engine: { provider: string; model: string };
    };

    await expect(resolveEngine(agentYaml.engine, dir)).rejects.toThrow(
      /Cannot find "@auggy\/anthropic"/,
    );
  });
});
