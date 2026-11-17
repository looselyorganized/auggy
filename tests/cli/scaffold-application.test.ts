import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { planApplicationScaffold } from "../../src/cli/scaffold-application";
import { defaultTurnProgram } from "../../src/kernel/turn-program";
import type {
  ApplicationLaunch,
  ApplicationMain,
  ManagedTurnSession,
  TurnCompletion,
  TurnProgramBinding,
} from "../../src/types";

const directories: string[] = [];
function generate(configFileName = "agent.yaml") {
  const directory = mkdtempSync(join(tmpdir(), "application-template-"));
  directories.push(directory);
  const plan = planApplicationScaffold({ configFileName });
  for (const file of plan.files) {
    const path = join(directory, file.relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.bytes, { mode: file.mode });
  }
  return { directory, plan };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("owned application templates", () => {
  test("planning exposes the frozen consumer interface and conventional files", () => {
    const plan = planApplicationScaffold({ configFileName: "agent.yaml" });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan.application).toEqual({ entrypoint: "./src/main.ts", contractVersion: 2 });
    expect(plan.files.map((file) => file.relativePath)).toEqual([
      "src/main.ts",
      "src/http.ts",
      "src/turn.ts",
      "src/augments/README.md",
      "tests/application.test.ts",
      "tsconfig.json",
      "README.md",
    ]);
    for (const file of plan.files) expect(file.mode).toBe(0o644);
    const source = plan.files
      .filter((file) => /^src\/[^/]+\.ts$/.test(file.relativePath))
      .map((file) => Buffer.from(file.bytes).toString())
      .join("\n");
    expect(source).not.toMatch(
      /observability|example_tool|maxInferences:|timeoutMs:|defaultTurnProgram|runTurn/,
    );
    expect(source).toContain('from "auggy/application"');
    expect(source).toContain('path: "/agent/run"');
    expect(source).toContain("const config = await runtime.prepareConfiguration();");
    expect(source).toContain("const model = await runtime.createModel(config);");
    expect(source).toContain("const augments = await runtime.createAugments(config);");
    expect(source).toContain(
      "runtime.createAgent({\n    config,\n    model,\n    augments,\n    turnProgram,",
    );
    expect(source).toContain("runtime.transportsFrom(augments)");
    expect(source).toContain("runtime.bindTransport(transport, agent)");
    expect(source).toContain("runtime.httpBindings(agent).map(configureHttp)");
    expect(source).toContain("await runtime.start({ agent, http })");
    expect(source).not.toContain("agentExecution");
    expect(source).toContain(
      "// onTurnFinalized: (result) => console.log(result.status, result.trace),",
    );
    expect(source).not.toContain("composeAgent");
    expect(source).toContain("turn.finishAtLimit()");
    expect(source).toContain("if (import.meta.main)");
  });

  test("selected configuration is consistently encoded in direct startup and local CLI script", () => {
    const plan = planApplicationScaffold({ configFileName: "custom agent.yaml" });
    const index = Buffer.from(
      plan.files.find((file) => file.relativePath === "src/main.ts")!.bytes,
    ).toString();
    expect(index).toContain('new URL("../custom%20agent.yaml", import.meta.url)');
    expect(plan.packageFields.scripts.cli).toBe("auggy dev --config 'custom agent.yaml'");
  });

  for (const name of [
    "../agent.yaml",
    "a/b.yaml",
    "a\\b.yaml",
    "/tmp/a.yaml",
    "a'$(id).yaml",
    "a\n.yaml",
    "a#b.yaml",
    "agent.json",
    `${"a".repeat(256)}.yaml`,
  ]) {
    test(`rejects unsafe configuration basename ${JSON.stringify(name).slice(0, 50)}`, () => {
      expect(() => planApplicationScaffold({ configFileName: name })).toThrow("YAML basename");
    });
  }

  test("all source sensitivity anchors occur exactly once", () => {
    const plan = planApplicationScaffold({ configFileName: "agent.yaml" });
    for (const [path, anchor] of [
      ["src/main.ts", "  const runtime = launch.createHost();"],
      [
        "src/http.ts",
        "          const response = await web.agentRun(request);\n          return response;",
      ],
      [
        "src/turn.ts",
        '    if (prepared.kind === "terminal") return prepared.completion;\n\n    while (turn.remainingInferences > 0) {',
      ],
    ]) {
      const text = Buffer.from(
        plan.files.find((file) => file.relativePath === path)!.bytes,
      ).toString();
      expect(text.split(anchor!).length).toBe(2);
    }
  });

  test("generated recipe tests execute outside the checkout", () => {
    const { directory } = generate();
    const result = Bun.spawnSync([process.execPath, "test", "tests"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain("10 pass");
  });

  test("generated main executes each assembly stage and binds every configured transport", async () => {
    const { directory } = generate();
    mkdirSync(join(directory, "node_modules"), { recursive: true });
    symlinkSync(resolve(import.meta.dir, "../.."), join(directory, "node_modules", "auggy"), "dir");
    const { main } = (await import(pathToFileURL(join(directory, "src/main.ts")).href)) as {
      main: ApplicationMain;
    };
    const calls: string[] = [];
    const config = {},
      model = {},
      augments = {},
      agent = {},
      listener = {};
    const transports = [{ name: "http" }, { name: "polling" }];
    const runtime = {
      async prepareConfiguration() {
        calls.push("configuration");
        return config;
      },
      async createModel(input: unknown) {
        expect(input).toBe(config);
        calls.push("model");
        return model;
      },
      async createAugments(input: unknown) {
        expect(input).toBe(config);
        calls.push("augments");
        return augments;
      },
      createAgent(input: {
        config: unknown;
        model: unknown;
        augments: unknown;
        turnProgram: TurnProgramBinding;
      }) {
        expect(input.config).toBe(config);
        expect(input.model).toBe(model);
        expect(input.augments).toBe(augments);
        expect(typeof input.turnProgram.run).toBe("function");
        calls.push("agent");
        return agent;
      },
      transportsFrom(input: unknown) {
        expect(input).toBe(augments);
        calls.push("transports");
        return transports;
      },
      bindTransport(transport: (typeof transports)[number], input: unknown) {
        expect(input).toBe(agent);
        calls.push(`bind:${transport.name}`);
      },
      httpBindings(input: unknown) {
        expect(input).toBe(agent);
        calls.push("bindings");
        return [
          {
            createListener(options: { routes: { path: string }[] }) {
              expect(options.routes[0]?.path).toBe("/agent/run");
              calls.push("listener");
              return listener;
            },
          },
        ];
      },
      async start(input: { agent: unknown; http: unknown[] }) {
        expect(input.agent).toBe(agent);
        expect(input.http).toEqual([listener]);
        calls.push("start");
      },
    };
    await main({ createHost: () => runtime } as unknown as ApplicationLaunch);
    expect(calls).toEqual([
      "configuration",
      "model",
      "augments",
      "agent",
      "transports",
      "bind:http",
      "bind:polling",
      "bindings",
      "listener",
      "start",
    ]);
    calls.length = 0;
    runtime.createAugments = async () => {
      calls.push("augments-failed");
      throw new Error("factory failed");
    };
    await expect(
      main({ createHost: () => runtime } as unknown as ApplicationLaunch),
    ).rejects.toThrow("factory failed");
    expect(calls).toEqual(["configuration", "model", "augments-failed"]);
  });

  test("generated source and tests typecheck against public application declarations", () => {
    const { directory } = generate();
    const root = resolve(import.meta.dir, "../..");
    mkdirSync(join(directory, "node_modules", "@types"), { recursive: true });
    symlinkSync(root, join(directory, "node_modules", "auggy"), "dir");
    symlinkSync(
      join(root, "node_modules", "@types", "bun"),
      join(directory, "node_modules", "@types", "bun"),
      "dir",
    );
    const result = Bun.spawnSync(
      [
        process.execPath,
        join(root, "node_modules/typescript/bin/tsc"),
        "--project",
        join(directory, "tsconfig.json"),
      ],
      { cwd: directory, stdout: "pipe", stderr: "pipe", timeout: 30_000 },
    );
    expect(result.stdout.toString() + result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(directory, "tsconfig.json"), "utf8")).not.toContain('"paths"');
  });
});

type Scenario =
  | "internal"
  | "prepared-terminal"
  | "answer"
  | "tool-terminal"
  | "final-answer"
  | "final-terminal"
  | "continue"
  | "exhausted"
  | "failure"
  | "tool-then-answer";
// Opaque receipts are deliberate unit doubles; these never cross a runtime boundary.
function fixture(scenario: Scenario) {
  const calls: string[] = [];
  const completion = {} as TurnCompletion;
  let remaining = scenario === "exhausted" ? 0 : scenario === "tool-then-answer" ? 2 : 1;
  const turn = {
    turnId: "unit-turn",
    threadId: "unit-thread",
    triggerType: "message",
    signal: new AbortController().signal,
    get inferenceCount() {
      return 1 - remaining;
    },
    get remainingInferences() {
      return remaining;
    },
    async dispatchInternalTurn() {
      calls.push("internal");
      return scenario === "internal" ? { handled: true, completion } : { handled: false };
    },
    async preparePrompt() {
      calls.push("prepare");
      return scenario === "prepared-terminal"
        ? { kind: "terminal", completion }
        : { kind: "ready" };
    },
    async infer() {
      calls.push("infer");
      remaining--;
      if (scenario === "failure") throw new Error("inference failed");
      return scenario === "answer" || (scenario === "tool-then-answer" && remaining === 0)
        ? { kind: "answer", reason: "answer" }
        : { kind: "tools", toolCallCount: 1 };
    },
    async executeTools() {
      calls.push("tools");
      if (scenario === "tool-terminal") return { kind: "terminal", completion };
      return scenario.startsWith("final-")
        ? { kind: "final-answer-required" }
        : { kind: "continue" };
    },
    async inferFinal() {
      calls.push("final");
      return scenario === "final-terminal"
        ? { kind: "terminal", completion }
        : { kind: "answer", reason: "recovery" };
    },
    async refreshPrompt() {
      calls.push("refresh");
    },
    complete() {
      calls.push("complete");
      return completion;
    },
    finishAtLimit() {
      calls.push("limit");
      return completion;
    },
    stop() {
      throw new Error("unexpected stop");
    },
  } as unknown as ManagedTurnSession;
  return { turn, calls, completion };
}

test("generated decisions match the maintained default recipe across terminal and exhaustion branches", async () => {
  const { directory } = generate();
  const { turnProgram } = (await import(pathToFileURL(join(directory, "src/turn.ts")).href)) as {
    turnProgram: TurnProgramBinding;
  };
  for (const scenario of [
    "internal",
    "prepared-terminal",
    "answer",
    "tool-terminal",
    "final-answer",
    "final-terminal",
    "continue",
    "exhausted",
    "failure",
    "tool-then-answer",
  ] as const) {
    const maintained = fixture(scenario);
    const generated = fixture(scenario);
    if (scenario === "failure") {
      await expect(defaultTurnProgram(maintained.turn)).rejects.toThrow("inference failed");
      await expect(turnProgram.run(generated.turn)).rejects.toThrow("inference failed");
    } else {
      expect(await defaultTurnProgram(maintained.turn)).toBe(maintained.completion);
      expect(await turnProgram.run(generated.turn)).toBe(generated.completion);
    }
    expect(generated.calls).toEqual(maintained.calls);
  }
});
