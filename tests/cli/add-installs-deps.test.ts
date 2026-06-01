import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mockInquirerPrompts, type Answers } from "../fixtures/inquirer-mock";
import { createStubBunInstallSpawn, type SpawnCapture } from "../fixtures/bun-install-stub";

/**
 * Verifies `runAdd` (Phase 4 contract):
 *  - mutates the agent's `package.json` to include `packageDeps` from the
 *    catalog entry of every newly-selected augment
 *  - invokes `bun install` in the agent dir (mocked)
 *  - is a no-op on install when nothing new came in
 *  - bails clearly when the agent project has no package.json
 */

let answers: Answers = { augmentTypes: [] };
mockInquirerPrompts(() => answers);

const { runAdd } = await import("../../src/cli/commands/add");

let auggyDir: string;
let agentParent: string;
let bunInstallCalls: SpawnCapture[];

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
  writeFileSync(
    join(dir, ".env"),
    "AUGGY_WEB_TOKEN=tok-test\nAUGGY_AGENT_ID=existing-agent\nAUGGY_PUBLIC_URL=http://localhost:18080\n",
  );

  const pkg = {
    name: `auggy-agent-${name}`,
    private: true,
    type: "module",
    dependencies: { auggy: "^0.3.1", "@auggy/anthropic": "^0.3.1" },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));

  return dir;
}

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
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    expect(pkg.dependencies["@auggy/link"]).toBe("^0.1.2");
    // Pre-existing deps untouched.
    expect(pkg.dependencies.auggy).toBe("^0.3.1");
    expect(pkg.dependencies["@auggy/anthropic"]).toBe("^0.3.1");
    const metadata = readFileSync(join(dir, "augments", "link", "augment.yaml"), "utf-8");
    expect(metadata).toContain("kind: builtin");
    expect(metadata).toContain("configType: link");
  });

  test("adding `supabaseMemory` merges @supabase/supabase-js", async () => {
    const dir = setupAgent("with-supa");
    answers = { augmentTypes: ["supabaseMemory"] };

    await runAdd("with-supa", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
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
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
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
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    expect(pkg.dependencies["@auggy/link"]).toBe("^0.1.2");
    expect(bunInstallCalls).toHaveLength(0);
  });
});

describe("runAdd no-op cases", () => {
  test("non-interactive augment argument mutates yaml without invoking picker", async () => {
    const dir = setupAgent("with-fetch");

    await runAdd("with-fetch", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      augment: "webFetch",
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const yaml = readFileSync(join(dir, "agent.yaml"), "utf-8");
    expect(yaml).toContain("type: webFetch");
    expect(yaml).toContain("name: webFetch");
    expect(existsSync(join(dir, "skills", "webFetch", "SKILL.md"))).toBe(true);
  });

  test("project-local single arg is treated as augment when cwd has agent.yaml", async () => {
    const dir = setupAgent("local-add");

    await runAdd("webFetch", {
      cwd: dir,
      auggyDir,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const yaml = readFileSync(join(dir, "agent.yaml"), "utf-8");
    expect(yaml).toContain("type: webFetch");
    expect(yaml).toContain("name: webFetch");
    expect(existsSync(join(dir, "skills", "webFetch", "SKILL.md"))).toBe(true);
  });

  test("project-local no args opens the picker for the cwd agent", async () => {
    const dir = setupAgent("local-picker");
    answers = { augmentTypes: ["bash"] };

    await runAdd(undefined, {
      cwd: dir,
      auggyDir,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const yaml = readFileSync(join(dir, "agent.yaml"), "utf-8");
    expect(yaml).toContain("type: bash");
  });

  test("non-interactive canonical augment argument works for layeredMemory", async () => {
    const dir = setupAgent("with-memory");

    await runAdd("with-memory", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      augment: "layeredMemory",
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const yaml = readFileSync(join(dir, "agent.yaml"), "utf-8");
    expect(yaml).toContain("type: layeredMemory");
  });

  test("adding visitorAuth generates VISITOR_SIGNING_KEY in .env", async () => {
    const dir = setupAgent("with-auth");

    await runAdd("with-auth", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      augment: "visitorAuth",
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const yaml = readFileSync(join(dir, "agent.yaml"), "utf-8");
    expect(yaml).toContain("type: visitorAuth");
    expect(yaml).toContain("signingKey: ${VISITOR_SIGNING_KEY}");

    const env = readFileSync(join(dir, ".env"), "utf-8");
    const signingKey = env.match(/^VISITOR_SIGNING_KEY=([a-f0-9]{64})$/m)?.[1];
    expect(signingKey).toBeTruthy();
    expect(env).toContain("AUGGY_AGENT_ID=existing-agent");
    expect(env).toContain("AUGGY_PUBLIC_URL=http://localhost:18080");
    expect(existsSync(join(dir, "skills", "visitorAuth", "SKILL.md"))).toBe(true);
  });

  test("adding visitorAuth fills blank generated env vars", async () => {
    const dir = setupAgent("with-auth-blank");
    writeFileSync(join(dir, ".env"), "AUGGY_AGENT_ID=\nAUGGY_PUBLIC_URL=\nVISITOR_SIGNING_KEY=\n");

    await runAdd("with-auth-blank", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      augment: "visitorAuth",
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const env = readFileSync(join(dir, ".env"), "utf-8");
    expect(env).toContain("AUGGY_AGENT_ID=with-auth-blank");
    expect(env).toContain("AUGGY_PUBLIC_URL=http://localhost:8080");
    expect(env).toMatch(/^VISITOR_SIGNING_KEY=[a-f0-9]{64}$/m);
  });

  test("non-interactive unknown augment throws with valid choices", async () => {
    const dir = setupAgent("bad-augment");

    await expect(
      runAdd("bad-augment", {
        config: join(dir, "agent.yaml"),
        auggyDir,
        augment: "not-real",
        bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
      }),
    ).rejects.toThrow(/Unknown augment "not-real".*webFetch/s);
  });

  test("non-interactive already-installed augment makes no changes", async () => {
    const dir = setupAgent("already-fetch", [{ name: "fetch", type: "webFetch" }]);
    const before = readFileSync(join(dir, "agent.yaml"), "utf-8");

    await runAdd("already-fetch", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      augment: "webFetch",
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    expect(readFileSync(join(dir, "agent.yaml"), "utf-8")).toBe(before);
    expect(bunInstallCalls).toHaveLength(0);
  });

  test("adding augments with no packageDeps does NOT run bun install", async () => {
    const dir = setupAgent("with-bash");
    answers = { augmentTypes: ["bash"] }; // bash has no packageDeps

    await runAdd("with-bash", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    expect(bunInstallCalls).toHaveLength(0);

    // agent.yaml still mutated.
    const yaml = readFileSync(join(dir, "agent.yaml"), "utf-8");
    expect(yaml).toContain("type: bash");
  });
});

describe("runAdd package manifest preflight", () => {
  test("missing package.json: bail BEFORE any disk write; yaml untouched, no skills, no install", async () => {
    const dir = setupAgent("missing-package");
    // Simulate an incomplete v1 agent project by removing the package.json
    // setupAgent wrote.
    rmSync(join(dir, "package.json"));
    const yamlBefore = readFileSync(join(dir, "agent.yaml"), "utf-8");
    answers = { augmentTypes: ["link"] };

    const originalExitCode = process.exitCode;
    try {
      await runAdd("missing-package", {
        config: join(dir, "agent.yaml"),
        auggyDir,
        bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
      });

      // Exit signals failure to the operator.
      expect(process.exitCode).toBe(1);

      // Atomicity: yaml is BYTE-IDENTICAL to before the call. No partial
      // state for the operator to clean up before retrying after migration.
      const yamlAfter = readFileSync(join(dir, "agent.yaml"), "utf-8");
      expect(yamlAfter).toBe(yamlBefore);
      expect(yamlAfter).not.toContain("type: link");

      // package.json still absent (we never created it).
      expect(existsSync(join(dir, "package.json"))).toBe(false);

      // No `bun install` attempted.
      expect(bunInstallCalls).toHaveLength(0);
    } finally {
      // Normalize undefined → 0. Bun's test runner exits with whatever
      // process.exitCode is at suite end; some versions don't treat
      // `undefined` as "clean exit" the way Node does, so set explicitly.
      process.exitCode = originalExitCode ?? 0;
    }
  });

  test("commit-then-install order: all three artifacts present + consistent on happy path", async () => {
    // Pins the §13.3 contract that yaml + package.json + skills all persist
    // as a sequence after preflight passes, and that install runs strictly
    // last. Regression-guard: if a future refactor splits the writes or
    // re-introduces partial-state, the assertions here fail.
    const dir = setupAgent("happy-path");
    answers = { augmentTypes: ["link"] };

    await runAdd("happy-path", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    // 1. agent.yaml mutation present.
    const yamlAfter = readFileSync(join(dir, "agent.yaml"), "utf-8");
    expect(yamlAfter).toContain("type: link");

    // 2. package.json updated with the new dep.
    const pkgAfter = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkgAfter.dependencies["@auggy/link"]).toBe("^0.1.2");

    // 3. bun install invoked exactly once after the writes.
    expect(bunInstallCalls).toHaveLength(1);
    expect(bunInstallCalls[0]?.cwd).toBe(dir);
  });
});
