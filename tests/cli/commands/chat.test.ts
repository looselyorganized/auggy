import { describe, it, expect } from "bun:test";
import { chatCommand } from "../../../src/cli/commands/chat";

describe("aug1 chat command", () => {
  it("registers the chat subcommand with name and description", () => {
    const cmd = chatCommand();
    expect(cmd.name()).toBe("chat");
    expect(cmd.description()).toContain("Local GUI");
  });

  it("declares --port option with default 8090", () => {
    const cmd = chatCommand();
    const port = cmd.options.find(o => o.long === "--port");
    expect(port).toBeDefined();
    expect(port?.defaultValue).toBe("8090");
  });

  it("declares --no-open option", () => {
    const cmd = chatCommand();
    const noOpen = cmd.options.find(o => o.long === "--no-open");
    expect(noOpen).toBeDefined();
  });

  it("declares --rebuild option", () => {
    const cmd = chatCommand();
    const rebuild = cmd.options.find(o => o.long === "--rebuild");
    expect(rebuild).toBeDefined();
  });
});
