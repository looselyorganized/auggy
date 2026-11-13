import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import {
  dispatchAuthoringCommand,
  registerAuthoringCommands,
  type AuthoringCommandHandlers,
} from "../../src/cli/authoring-bootstrap";

describe("passive authoring command boundary", () => {
  test("binary dispatch shares programmatic grammar and preserves handler exit codes", async () => {
    const calls: unknown[] = [];
    const handlers: AuthoringCommandHandlers = {
      inspect(name, options) {
        calls.push({ command: "inspect", name, options });
        return 1;
      },
      migrate(name, options) {
        calls.push({ command: "migrate", name, options });
        return 0;
      },
    };
    const args = ["inspect", "support", "--config", "custom.yaml", "--json"];
    expect(await dispatchAuthoringCommand(args, handlers)).toBe(1);
    const program = new Command("auggy");
    let result: number | undefined;
    registerAuthoringCommands(program, handlers, (code) => {
      result = code;
    });
    await program.parseAsync(args, { from: "user" });
    expect(result).toBe(1);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]).toEqual({
      command: "inspect",
      name: "support",
      options: { config: "custom.yaml", json: true },
    });
  });

  test("does not select ordinary launch commands or evaluate an unused handler", async () => {
    const handlers: AuthoringCommandHandlers = {
      inspect() {
        throw new Error("unused inspect handler");
      },
      migrate() {
        return 0;
      },
    };
    for (const args of [["run"], ["--version"], ["help"], []]) {
      expect(await dispatchAuthoringCommand(args, handlers)).toBeNull();
    }
    expect(
      await dispatchAuthoringCommand(
        ["migrate", "--project-dir", "/tmp/project", "--rollback", "receipt", "--apply"],
        handlers,
      ),
    ).toBe(0);
    expect(await dispatchAuthoringCommand(["--", "migrate"], handlers)).toBe(0);
  });

  test.each(
    [
      ["migrate", "--config", "agent.yaml", "--project-dir", "/tmp/project"],
      ["migrate", "--project-dir", "/tmp/project"],
      ["migrate", "named", "--project-dir", "/tmp/project", "--rollback", "receipt"],
      ["migrate", "--project-dir", "/tmp/project", "--application"],
    ].map((args) => ({ args })),
  )(
    "incompatible recovery selectors fail grammar validation before handlers: %j",
    async ({ args }) => {
      let calls = 0;
      const program = new Command("auggy").exitOverride().configureOutput({ writeErr() {} });
      registerAuthoringCommands(program, {
        inspect() {
          calls++;
          return 0;
        },
        migrate() {
          calls++;
          return 0;
        },
      });
      for (const command of program.commands)
        command.exitOverride().configureOutput({ writeErr() {} });
      await expect(
        program.parseAsync(args, {
          from: "user",
        }),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    },
  );
});
