import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Verifies `runAdd` (Phase 4 contract):
 *  - mutates the agent's `package.json` to include `packageDeps` from the
 *    catalog entry of every newly-selected augment
 *  - invokes `bun install` in the agent dir (mocked)
 *  - is a no-op on install when nothing new came in
 *  - bails clearly when the agent dir has no package.json (pre-v0.3.2 shape)
 */

interface Answers {
  augmentTypes: string[];
}

let answers: Answers = { augmentTypes: [] };

mock.module("@inquirer/prompts", () => ({
  checkbox: async (config: {
    choices: Array<{ value: { type: string } }>;
  }) => {
    const wanted = new Set(answers.augmentTypes);
    return config.choices.filter((c) => wanted.has(c.value.type)).map((c) => c.value);
  },
}));

const { runAdd } = await import("../../src/cli/commands/add");

let auggyDir: string;
let agentParent: string;
let bunInstallCalls: Array<{ cmd: string[]; cwd: string }>;

function setupAgent(name: string, augments: Array<{ type: string; name: string }> = []): string {
  const dir = join(agentParent, name);
  mkdirSync(dir, { recursive: true });

  const yaml =
    `# Agent configuration\n` +
    `id: aug1_test\nname: ${name}\n` +
    `engine:\n  provider: anthropic\n  model: claude-sonnet-4-6\n` +
    `augments:\n` +
    augments.map((a) => `  - name: ${a.name}\n    type: ${a.type}\n`).join("");
  writeFileSync(join(dir, "agent.yaml"), yaml);

  const pkg = {
    name: `auggy-agent-${name}`,
    private: true,
    type: "module",
    dependencies: { auggy: "^0.3.1", "@auggy/anthropic": "^0.3.1" },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));

  return dir;
}

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

beforeEach(async () => {
  auggyDir = mkdtempSync(join(tmpdir(), "add-test-auggy-"));
  agentParent = mkdtempSync(join(tmpdir(), "add-test-agents-"));
  bunInstallCalls = [];
  answers = { augmentTypes: [] };
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
  rmSync(agentParent, { recursive: true, force: true });
});

describe("runAdd mutates per-agent package.json", () => {
  test("adding `link` merges @auggy/link into dependencies", async () => {
    const dir = setupAgent("with-link");
    answers = { augmentTypes: ["link"] };

    await runAdd("with-link", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      bunInstallSpawn: stubSpawn(),
    });

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    expect(pkg.dependencies["@auggy/link"]).toBe("^0.1.2");
    // Pre-existing deps untouched.
    expect(pkg.dependencies.auggy).toBe("^0.3.1");
    expect(pkg.dependencies["@auggy/anthropic"]).toBe("^0.3.1");
  });

  test("adding `supabaseMemory` merges @supabase/supabase-js", async () => {
    const dir = setupAgent("with-supa");
    answers = { augmentTypes: ["supabaseMemory"] };

    await runAdd("with-supa", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      bunInstallSpawn: stubSpawn(),
    });

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    expect(pkg.dependencies["@supabase/supabase-js"]).toBe("^2.103.0");
  });

  test("invokes bun install in agent dir when packageDeps are added", async () => {
    const dir = setupAgent("with-link");
    answers = { augmentTypes: ["link"] };

    await runAdd("with-link", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      bunInstallSpawn: stubSpawn(),
    });

    expect(bunInstallCalls).toHaveLength(1);
    expect(bunInstallCalls[0]?.cwd).toBe(dir);
  });

  test("--skip-install mutates package.json but does NOT invoke install", async () => {
    const dir = setupAgent("with-link");
    answers = { augmentTypes: ["link"] };

    await runAdd("with-link", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      skipInstall: true,
      bunInstallSpawn: stubSpawn(),
    });

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    expect(pkg.dependencies["@auggy/link"]).toBe("^0.1.2");
    expect(bunInstallCalls).toHaveLength(0);
  });
});

describe("runAdd no-op cases", () => {
  test("adding augments with no packageDeps does NOT run bun install", async () => {
    const dir = setupAgent("with-bash");
    answers = { augmentTypes: ["bash"] }; // bash has no packageDeps

    await runAdd("with-bash", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      bunInstallSpawn: stubSpawn(),
    });

    expect(bunInstallCalls).toHaveLength(0);

    // agent.yaml still mutated.
    const yaml = readFileSync(join(dir, "agent.yaml"), "utf-8");
    expect(yaml).toContain("type: bash");
  });
});

describe("runAdd legacy compatibility", () => {
  test("exits non-zero with a guidance message when agent dir has no package.json", async () => {
    const dir = setupAgent("legacy");
    // Simulate a pre-v0.3.2 agent dir by removing the package.json setupAgent
    // wrote. (The boot-time migration in Phase 6 will scaffold it on first
    // `auggy dev` call.)
    rmSync(join(dir, "package.json"));
    answers = { augmentTypes: ["link"] };

    const originalExitCode = process.exitCode;
    try {
      await runAdd("legacy", {
        config: join(dir, "agent.yaml"),
        auggyDir,
        bunInstallSpawn: stubSpawn(),
      });

      expect(process.exitCode).toBe(1);
      // agent.yaml was still mutated (we exit AFTER the yaml write); the
      // operator is told to run auggy dev once to trigger migration.
      const yaml = readFileSync(join(dir, "agent.yaml"), "utf-8");
      expect(yaml).toContain("type: link");
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});
