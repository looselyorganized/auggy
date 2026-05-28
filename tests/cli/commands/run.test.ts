import { describe, expect, mock, test } from "bun:test";
import { runCommand } from "../../../src/cli/commands/run";
import type { DevOpts } from "../../../src/cli/commands/dev";

type MockRunDev = (name: string | undefined, opts: DevOpts) => Promise<void>;

describe("auggy run command", () => {
  test("registers the run subcommand with description", () => {
    const cmd = runCommand();
    expect(cmd.name()).toBe("run");
    expect(cmd.description()).toContain("/console/chat");
  });

  test("declares optional name argument and config/open options", () => {
    const cmd = runCommand();
    const help = cmd.helpInformation();
    expect(help).toContain("[name]");

    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain("--config");
    expect(longs).toContain("--no-open");
  });

  test("runs dev with open=true by default", async () => {
    const runDev = mock<MockRunDev>(async () => {});
    const cmd = runCommand({ runDev });

    await cmd.parseAsync(["zip"], { from: "user" });

    expect(runDev).toHaveBeenCalledTimes(1);
    expect(runDev).toHaveBeenCalledWith("zip", { config: undefined, open: true });
  });

  test("runs dev without a name for project-local agent dirs", async () => {
    const runDev = mock<MockRunDev>(async () => {});
    const cmd = runCommand({ runDev });

    await cmd.parseAsync([], { from: "user" });

    expect(runDev).toHaveBeenCalledTimes(1);
    expect(runDev).toHaveBeenCalledWith(undefined, { config: undefined, open: true });
  });

  test("forwards --config and honors --no-open", async () => {
    const runDev = mock<MockRunDev>(async () => {});
    const cmd = runCommand({ runDev });

    await cmd.parseAsync(["zip", "--config", "/tmp/agent.yaml", "--no-open"], {
      from: "user",
    });

    expect(runDev).toHaveBeenCalledTimes(1);
    expect(runDev).toHaveBeenCalledWith("zip", {
      config: "/tmp/agent.yaml",
      open: false,
    });
  });

  test("prints errors and exits 1 when dev fails", async () => {
    const runDev = mock<MockRunDev>(async () => {
      throw new Error("boot failed");
    });
    const exit = mock((_code: number) => {});
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: unknown) => {
      errors.push(String(msg));
    };

    try {
      const cmd = runCommand({ runDev, exit });
      await cmd.parseAsync(["zip"], { from: "user" });
    } finally {
      console.error = origErr;
    }

    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain("boot failed");
  });
});
