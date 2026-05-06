import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addAgent } from "../../../src/cli/agent-index";
import { evalCommand, resolveEvalConfigPath } from "../../../src/cli/commands/eval";

type RunEvalSuiteArgs = {
  configPath: string;
  runSecurity: boolean;
  runBenign: boolean;
  trialsOverride?: number;
};
type MockRunEvalSuite = (args: RunEvalSuiteArgs) => Promise<{ exitCode: number }>;

let auggyDir: string;
let agentParent: string;

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "auggy-eval-test-auggy-"));
  agentParent = mkdtempSync(join(tmpdir(), "auggy-eval-test-agents-"));
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
  rmSync(agentParent, { recursive: true, force: true });
});

describe("auggy eval — command shape", () => {
  test("registers as 'eval' subcommand with description", () => {
    const cmd = evalCommand();
    expect(cmd.name()).toBe("eval");
    expect(cmd.description()).toContain("security eval suite");
  });

  test("declares optional [agent] argument", () => {
    const cmd = evalCommand();
    // Commander stores arguments in the `_args` field; check via formatted help.
    const help = cmd.helpInformation();
    expect(help).toContain("[agent]");
  });

  test("declares --config, --suite, --trials options", () => {
    const cmd = evalCommand();
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain("--config");
    expect(longs).toContain("--suite");
    expect(longs).toContain("--trials");
  });

  test("--suite defaults to 'all'", () => {
    const cmd = evalCommand();
    const suite = cmd.options.find((o) => o.long === "--suite");
    expect(suite?.defaultValue).toBe("all");
  });
});

describe("resolveEvalConfigPath", () => {
  test("explicit --config wins", () => {
    const cfg = join(agentParent, "custom.yaml");
    writeFileSync(cfg, "id: aug1_test\n");
    expect(resolveEvalConfigPath({ explicitConfig: cfg }, { auggyDir })).toBe(cfg);
  });

  test("explicit --config to nonexistent path throws", () => {
    expect(() =>
      resolveEvalConfigPath({ explicitConfig: "/nonexistent/agent.yaml" }, { auggyDir }),
    ).toThrow(/not found/i);
  });

  test("registered agent name resolves to indexed agent.yaml", () => {
    const dir = join(agentParent, "zip");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent.yaml"), "id: aug1_test\n");
    addAgent("zip", dir, { auggyDir });

    expect(resolveEvalConfigPath({ agentName: "zip" }, { auggyDir })).toBe(join(dir, "agent.yaml"));
  });

  test("unregistered agent name throws clear error", () => {
    expect(() => resolveEvalConfigPath({ agentName: "ghost" }, { auggyDir })).toThrow(/not found/i);
    expect(() => resolveEvalConfigPath({ agentName: "ghost" }, { auggyDir })).toThrow(
      /auggy ls|--config/i,
    );
  });

  test("indexed agent missing agent.yaml on disk throws helpful error", () => {
    const dir = join(agentParent, "zip");
    mkdirSync(dir, { recursive: true });
    addAgent("zip", dir, { auggyDir }); // dir exists, agent.yaml does not
    expect(() => resolveEvalConfigPath({ agentName: "zip" }, { auggyDir })).toThrow(
      /missing|agent\.yaml/i,
    );
  });

  test("explicit --config takes precedence over agent name", () => {
    const dir = join(agentParent, "zip");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent.yaml"), "id: aug1_test\n");
    addAgent("zip", dir, { auggyDir });

    const override = join(agentParent, "override.yaml");
    writeFileSync(override, "id: aug1_override\n");

    expect(
      resolveEvalConfigPath({ agentName: "zip", explicitConfig: override }, { auggyDir }),
    ).toBe(override);
  });

  test("no agent name and no --config falls back to fixture path", () => {
    const fakeFixture = join(agentParent, "fixture.yaml");
    writeFileSync(fakeFixture, "id: aug1_fixture\n");
    expect(
      resolveEvalConfigPath({}, { auggyDir, defaultFixtureConfigPath: () => fakeFixture }),
    ).toBe(fakeFixture);
  });
});

// --- Action handler dispatch ----------------------------------------------------
//
// The action handler is wired through Commander; we exercise it by calling
// `cmd.parseAsync([...args], { from: "user" })` so Commander runs the option
// parsers for us. We mock both `runEvalSuite` and `exit` so no real API
// calls happen and `process.exit` is intercepted.

describe("auggy eval — action dispatch", () => {
  test("default (no args) passes fixture path + runSecurity=true + runBenign=true", async () => {
    const fakeFixture = join(agentParent, "fixture.yaml");
    writeFileSync(fakeFixture, "id: aug1_fixture\n");

    const runEvalSuite = mock<MockRunEvalSuite>(async () => ({ exitCode: 0 }));
    const exit = mock((_code: number) => {});

    // We need to inject the fixture resolver, but evalCommand doesn't expose
    // that. Instead, route through resolveEvalConfigPath by passing --config
    // explicitly here — the "no args" default path is covered by the
    // resolveEvalConfigPath unit tests above.
    const cmd = evalCommand({ runEvalSuite, exit, auggyDir });
    await cmd.parseAsync(["--config", fakeFixture], { from: "user" });

    expect(runEvalSuite).toHaveBeenCalledTimes(1);
    const callArgs = runEvalSuite.mock.calls[0]?.[0];
    expect(callArgs).toEqual({
      configPath: resolve(fakeFixture),
      runSecurity: true,
      runBenign: true,
      trialsOverride: undefined,
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  test("agent name resolves through registry", async () => {
    const dir = join(agentParent, "zip");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent.yaml"), "id: aug1_test\n");
    addAgent("zip", dir, { auggyDir });

    const runEvalSuite = mock<MockRunEvalSuite>(async () => ({ exitCode: 0 }));
    const exit = mock((_code: number) => {});

    const cmd = evalCommand({ runEvalSuite, exit, auggyDir });
    await cmd.parseAsync(["zip"], { from: "user" });

    expect(runEvalSuite).toHaveBeenCalledTimes(1);
    expect(runEvalSuite.mock.calls[0]?.[0]?.configPath).toBe(join(dir, "agent.yaml"));
  });

  test("--config overrides agent name lookup", async () => {
    const dir = join(agentParent, "zip");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent.yaml"), "id: aug1_indexed\n");
    addAgent("zip", dir, { auggyDir });

    const override = join(agentParent, "override.yaml");
    writeFileSync(override, "id: aug1_override\n");

    const runEvalSuite = mock<MockRunEvalSuite>(async () => ({ exitCode: 0 }));
    const exit = mock((_code: number) => {});

    const cmd = evalCommand({ runEvalSuite, exit, auggyDir });
    await cmd.parseAsync(["zip", "--config", override], { from: "user" });

    expect(runEvalSuite.mock.calls[0]?.[0]?.configPath).toBe(resolve(override));
  });

  test("missing agent surfaces a clear error and exits 1 without invoking runner", async () => {
    const runEvalSuite = mock<MockRunEvalSuite>(async () => ({ exitCode: 0 }));
    const exit = mock((_code: number) => {});

    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: unknown) => {
      errors.push(String(msg));
    };

    try {
      const cmd = evalCommand({ runEvalSuite, exit, auggyDir });
      await cmd.parseAsync(["ghost"], { from: "user" });
    } finally {
      console.error = origErr;
    }

    expect(runEvalSuite).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toMatch(/not found/i);
  });

  test("--suite security-only sets runBenign=false", async () => {
    const cfg = join(agentParent, "agent.yaml");
    writeFileSync(cfg, "id: aug1_test\n");

    const runEvalSuite = mock<MockRunEvalSuite>(async () => ({ exitCode: 0 }));
    const exit = mock((_code: number) => {});

    const cmd = evalCommand({ runEvalSuite, exit, auggyDir });
    await cmd.parseAsync(["--config", cfg, "--suite", "security-only"], {
      from: "user",
    });

    const callArgs = runEvalSuite.mock.calls[0]?.[0];
    expect(callArgs?.runSecurity).toBe(true);
    expect(callArgs?.runBenign).toBe(false);
  });

  test("--suite benign-only sets runSecurity=false", async () => {
    const cfg = join(agentParent, "agent.yaml");
    writeFileSync(cfg, "id: aug1_test\n");

    const runEvalSuite = mock<MockRunEvalSuite>(async () => ({ exitCode: 0 }));
    const exit = mock((_code: number) => {});

    const cmd = evalCommand({ runEvalSuite, exit, auggyDir });
    await cmd.parseAsync(["--config", cfg, "--suite", "benign-only"], {
      from: "user",
    });

    const callArgs = runEvalSuite.mock.calls[0]?.[0];
    expect(callArgs?.runSecurity).toBe(false);
    expect(callArgs?.runBenign).toBe(true);
  });

  test("--suite invalid value rejects with exit 1", async () => {
    const cfg = join(agentParent, "agent.yaml");
    writeFileSync(cfg, "id: aug1_test\n");

    const runEvalSuite = mock<MockRunEvalSuite>(async () => ({ exitCode: 0 }));
    const exit = mock((_code: number) => {});

    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: unknown) => {
      errors.push(String(msg));
    };

    try {
      const cmd = evalCommand({ runEvalSuite, exit, auggyDir });
      await cmd.parseAsync(["--config", cfg, "--suite", "bogus"], {
        from: "user",
      });
    } finally {
      console.error = origErr;
    }

    expect(runEvalSuite).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toMatch(/--suite must be one of/i);
  });

  test("--trials 5 is parsed and passed as trialsOverride", async () => {
    const cfg = join(agentParent, "agent.yaml");
    writeFileSync(cfg, "id: aug1_test\n");

    const runEvalSuite = mock<MockRunEvalSuite>(async () => ({ exitCode: 0 }));
    const exit = mock((_code: number) => {});

    const cmd = evalCommand({ runEvalSuite, exit, auggyDir });
    await cmd.parseAsync(["--config", cfg, "--trials", "5"], { from: "user" });

    const callArgs = runEvalSuite.mock.calls[0]?.[0];
    expect(callArgs?.trialsOverride).toBe(5);
  });

  test("--trials non-integer rejects with exit 1", async () => {
    const cfg = join(agentParent, "agent.yaml");
    writeFileSync(cfg, "id: aug1_test\n");

    const runEvalSuite = mock<MockRunEvalSuite>(async () => ({ exitCode: 0 }));
    const exit = mock((_code: number) => {});

    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: unknown) => {
      errors.push(String(msg));
    };

    try {
      const cmd = evalCommand({ runEvalSuite, exit, auggyDir });
      await cmd.parseAsync(["--config", cfg, "--trials", "nope"], {
        from: "user",
      });
    } finally {
      console.error = origErr;
    }

    expect(runEvalSuite).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toMatch(/positive integer/i);
  });

  test("non-zero exitCode from runner propagates to exit()", async () => {
    const cfg = join(agentParent, "agent.yaml");
    writeFileSync(cfg, "id: aug1_test\n");

    const runEvalSuite = mock<MockRunEvalSuite>(async () => ({ exitCode: 1 }));
    const exit = mock((_code: number) => {});

    const cmd = evalCommand({ runEvalSuite, exit, auggyDir });
    await cmd.parseAsync(["--config", cfg], { from: "user" });

    expect(exit).toHaveBeenCalledWith(1);
  });
});
