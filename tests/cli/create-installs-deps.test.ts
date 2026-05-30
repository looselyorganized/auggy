import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
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

const { runCreate, runInit } = await import("../../src/cli/commands/create");
const { PROVIDER_TO_PACKAGE } = await import("../../src/cli/scaffold-package-json");

let auggyDir: string;
let projectParent: string;
let bunInstallCalls: SpawnCapture[];

function agentDirFor(name: string): string {
  return join(projectParent, name);
}

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "create-test-auggy-"));
  projectParent = mkdtempSync(join(tmpdir(), "create-test-projects-"));
  bunInstallCalls = [];
  answers = {};
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
  rmSync(projectParent, { recursive: true, force: true });
});

describe("runCreate writes per-agent package.json", () => {
  test("Anthropic-only: package.json lists auggy + @auggy/anthropic and nothing else", async () => {
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-anthropic", {
      cwd: projectParent,
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
      cwd: projectParent,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const pkg = JSON.parse(readFileSync(join(agentDirFor("demo-openai"), "package.json"), "utf-8"));
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
      cwd: projectParent,
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
      cwd: projectParent,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    expect(bunInstallCalls).toHaveLength(1);
    expect(bunInstallCalls[0]?.cmd).toEqual(["bun", "install"]);
    expect(bunInstallCalls[0]?.cwd).toBe(agentDirFor("demo-install"));
  });

  test("--skip-install writes package.json but does NOT invoke bun install", async () => {
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-skip", {
      cwd: projectParent,
      skipInstall: true,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    expect(existsSync(join(agentDirFor("demo-skip"), "package.json"))).toBe(true);
    expect(bunInstallCalls).toHaveLength(0);
  });

  test("failed install leaves the agent dir intact (fail-soft)", async () => {
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-failsoft", {
      cwd: projectParent,
      bunInstallSpawn: createStubBunInstallSpawn({
        exitCode: 1,
        stderrText: "error: network unreachable\n",
      }),
    });

    const dir = agentDirFor("demo-failsoft");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(existsSync(join(dir, "agent.yaml"))).toBe(true);
  });
});

describe("runCreate scaffolding integration", () => {
  test("default create includes the v1 chat-ready augment profile", async () => {
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-defaults", {
      cwd: projectParent,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const dir = agentDirFor("demo-defaults");
    const config = parseYaml(readFileSync(join(dir, "agent.yaml"), "utf-8")) as {
      augments: Array<{ type: string; name: string }>;
    };
    expect(config.augments.map((a) => a.type)).toEqual([
      "fileMemory",
      "filesystem",
      "webTransport",
      "webFetch",
      "budgets",
      "turnControl",
    ]);
    expect(existsSync(join(dir, "skills", "filesystem", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, "skills", "web-fetch", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, "skills", "turn-control", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, "augments", "web-fetch", "augment.yaml"))).toBe(true);
    expect(existsSync(join(dir, "augments", "filesystem", "augment.yaml"))).toBe(true);
    expect(existsSync(join(dir, "augments", "README.md"))).toBe(true);
    const webFetchMeta = parseYaml(
      readFileSync(join(dir, "augments", "web-fetch", "augment.yaml"), "utf-8"),
    ) as Record<string, unknown>;
    expect(webFetchMeta).toMatchObject({
      name: "web-fetch",
      kind: "builtin",
      runtime: "auggy",
      configType: "webFetch",
      skill: "../../skills/web-fetch/SKILL.md",
    });

    const env = readFileSync(join(dir, ".env"), "utf-8");
    expect(env).toMatch(/AUGGY_WEB_TOKEN=[a-f0-9]{64}/);
    expect(env).toContain("AUGGY_AGENT_ID=demo-defaults");
    expect(env).toContain("AUGGY_PUBLIC_URL=http://localhost:8080");
    expect(env).toContain("ANTHROPIC_API_KEY=");
  });

  test("create output points first-runners at auggy run", async () => {
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      await runCreate("demo-output", {
        cwd: projectParent,
        skipInstall: true,
        bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
      });
    } finally {
      console.log = originalLog;
    }

    expect(logs.join("\n")).toContain("auggy run demo-output");
    expect(logs.join("\n")).not.toContain("auggy dev demo-output --open");
  });

  test("agent.yaml + identity.md + skills/ + data/workspace all scaffolded", async () => {
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };

    await runCreate("demo-full", {
      cwd: projectParent,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const dir = agentDirFor("demo-full");
    expect(existsSync(join(dir, "agent.yaml"))).toBe(true);
    expect(existsSync(join(dir, "identity.md"))).toBe(true);
    expect(existsSync(join(dir, "skills"))).toBe(true);
    expect(existsSync(join(dir, "data", "workspace"))).toBe(true);
    expect(existsSync(join(dir, "workspace"))).toBe(false);
    expect(existsSync(join(dir, ".env"))).toBe(true);
    expect(existsSync(join(dir, ".env.example"))).toBe(true);
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    expect(existsSync(join(dir, "package.json"))).toBe(true);
  });

  test("create writes a standalone project directory", async () => {
    answers = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      augmentTypes: ["layeredMemory"],
    };

    await runCreate("demo-project", {
      cwd: projectParent,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const dir = join(projectParent, "demo-project");
    expect(existsSync(join(dir, "agent.yaml"))).toBe(true);
    expect(existsSync(join(dir, "identity.md"))).toBe(true);
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(existsSync(join(dir, "skills"))).toBe(true);
    expect(existsSync(join(dir, "augments"))).toBe(true);
    expect(existsSync(join(dir, "data", "workspace"))).toBe(true);
    expect(existsSync(join(dir, "workspace"))).toBe(false);
    expect(bunInstallCalls[0]?.cwd).toBe(dir);

    const config = parseYaml(readFileSync(join(dir, "agent.yaml"), "utf-8")) as {
      augments: Array<{ type: string; options?: Record<string, unknown> }>;
    };
    const memory = config.augments.find((aug) => aug.type === "layeredMemory");
    const budgets = config.augments.find((aug) => aug.type === "budgets");
    const files = config.augments.find((aug) => aug.type === "filesystem");
    expect(memory?.options?.dbPath).toBe("./data/memory.sqlite");
    expect(budgets?.options?.dbPath).toBe("./data/budgets.db");
    expect(JSON.stringify(files?.options)).toContain("./data/workspace");
  });

  test("init scaffolds the current directory and run guidance omits the name", async () => {
    answers = { provider: "anthropic", model: "claude-sonnet-4-6" };
    const dir = join(projectParent, "current-agent");
    mkdirSync(dir, { recursive: true });
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      await runInit({
        cwd: dir,
        skipInstall: true,
        bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
      });
    } finally {
      console.log = originalLog;
    }

    expect(existsSync(join(dir, "agent.yaml"))).toBe(true);
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(existsSync(join(dir, "augments", "web-fetch", "augment.yaml"))).toBe(true);
    expect(logs.join("\n")).toContain("auggy run");
    expect(logs.join("\n")).not.toContain("auggy run current-agent");
    expect(bunInstallCalls).toHaveLength(0);
  });
});
