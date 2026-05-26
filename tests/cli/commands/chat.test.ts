import { describe, it, expect } from "bun:test";
import { chatCommand } from "../../../src/cli/commands/chat";

describe("auggy chat command", () => {
  it("registers the chat subcommand with name and description", () => {
    const cmd = chatCommand();
    expect(cmd.name()).toBe("chat");
    expect(cmd.description()).toContain("/console/chat");
  });

  it("declares --no-open option", () => {
    const cmd = chatCommand();
    const noOpen = cmd.options.find((o) => o.long === "--no-open");
    expect(noOpen).toBeDefined();
  });

  it("accepts an optional [name] argument", () => {
    const cmd = chatCommand();
    // Commander stores positional args as [name] on the underlying _args list.
    // Cast to the documented shape; if commander changes its internal name
    // the assertion still has signal because the test would crash here.
    const args = (cmd as unknown as { _args: Array<{ _name: string; required: boolean }> })._args;
    expect(args.length).toBe(1);
    expect(args[0]?._name).toBe("name");
    expect(args[0]?.required).toBe(false);
  });
});
