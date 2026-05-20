import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mockInquirerPrompts, type Answers } from "../fixtures/inquirer-mock";
import { createStubBunInstallSpawn, type SpawnCapture } from "../fixtures/bun-install-stub";

/**
 * Drives `runCreate` non-interactively by stubbing `@inquirer/prompts` and
 * verifies the scaffold contract:
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

let answers: Answers = {};
mockInquirerPrompts(() => answers);

const { runCreate } = await import("../../src/cli/commands/create");
const { getAgent } = await import("../../src/cli/agent-index");
const { PROVIDER_TO_PACKAGE } = await import("../../src/cli/scaffold-package-json");

let auggyDir: string;
let bunInstallCalls: SpawnCapture[];

function agentDirFor(name: string): string {
  return join(auggyDir, "agents", name);
}

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "create-test-auggy-"));
  bunInstallCalls = [];
  answers = {};
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
});

describe("runCreate writes per-agent package.json", () => {
  test("Anthropic-only: package.json lists auggy + @auggy/anthropic and nothing else", async () => {
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-anthropic", {
      auggyDir,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const dir = agentDirFor("demo-anthropic");
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    expect(pkg.name).toBe("auggy-agent-demo-anthropic");
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe("module");
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@auggy/anthropic", "auggy"]);
    expect(pkg.dependencies["@auggy/openai"]).toBeUndefined();
    expect(pkg.dependencies["@auggy/openrouter"]).toBeUndefined();
    expect(pkg.dependencies["@auggy/link"]).toBeUndefined();
    expect(pkg.dependencies.openai).toBeUndefined();
  });

  test("provider=openai writes @auggy/openai adapter", async () => {
    answers = { provider: "openai", model: "gpt-5" };

    await runCreate("demo-openai", {
      auggyDir,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const pkg = JSON.parse(
      readFileSync(join(agentDirFor("demo-openai"), "package.json"), "utf-8"),
    );
    expect(pkg.dependencies[PROVIDER_TO_PACKAGE.openai]).toBeDefined();
    expect(pkg.dependencies[PROVIDER_TO_PACKAGE.anthropic]).toBeUndefined();
  });

  test("selecting `link` augment merges @auggy/link from catalog packageDeps", async () => {
    answers = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      augmentTypes: ["link"],
    };

    await runCreate("demo-with-link", {
      auggyDir,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const pkg = JSON.parse(
      readFileSync(join(agentDirFor("demo-with-link"), "package.json"), "utf-8"),
    );
    expect(pkg.dependencies["@auggy/link"]).toBe("^0.1.2");
    expect(pkg.dependencies["@auggy/anthropic"]).toBeDefined();
  });
});

describe("runCreate invokes bun install in agent dir", () => {
  test("runs `bun install` with cwd = agent dir by default", async () => {
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-install", {
      auggyDir,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    expect(bunInstallCalls).toHaveLength(1);
    expect(bunInstallCalls[0]?.cmd).toEqual(["bun", "install"]);
    expect(bunInstallCalls[0]?.cwd).toBe(agentDirFor("demo-install"));
  });

  test("--skip-install writes package.json but does NOT invoke bun install", async () => {
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-skip", {
      auggyDir,
      skipInstall: true,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    expect(existsSync(join(agentDirFor("demo-skip"), "package.json"))).toBe(true);
    expect(bunInstallCalls).toHaveLength(0);
  });

  test("failed install leaves the agent dir intact (fail-soft)", async () => {
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-failsoft", {
      auggyDir,
      bunInstallSpawn: createStubBunInstallSpawn({
        exitCode: 1,
        stderrText: "error: network unreachable\n",
      }),
    });

    const dir = agentDirFor("demo-failsoft");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(existsSync(join(dir, "agent.yaml"))).toBe(true);
    expect(getAgent("demo-failsoft", { auggyDir })).not.toBeNull();
  });
});

describe("runCreate scaffolding integration", () => {
  test("agent.yaml + identity.md + skills/ + workspace/ all scaffolded", async () => {
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-full", {
      auggyDir,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const dir = agentDirFor("demo-full");
    expect(existsSync(join(dir, "agent.yaml"))).toBe(true);
    expect(existsSync(join(dir, "identity.md"))).toBe(true);
    expect(existsSync(join(dir, "skills"))).toBe(true);
    expect(existsSync(join(dir, "workspace"))).toBe(true);
    expect(existsSync(join(dir, ".env"))).toBe(true);
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    expect(existsSync(join(dir, "package.json"))).toBe(true);
  });

  test("agent appears in the filesystem at the canonical localDir", async () => {
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-indexed", {
      auggyDir,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const entry = getAgent("demo-indexed", { auggyDir });
    expect(entry).not.toBeNull();
    expect(entry?.localDir).toBe(agentDirFor("demo-indexed"));
  });
});
