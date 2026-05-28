import { describe, expect, test } from "bun:test";
import { buildCli } from "../../src/cli/index";

describe("auggy CLI command table", () => {
  test("registers the public command suite", () => {
    const cli = buildCli();
    const names = cli.commands.map((cmd) => cmd.name());

    expect(names).toContain("create");
    expect(names).toContain("add");
    expect(names).toContain("add-skill");
    expect(names).toContain("run");
    expect(names).toContain("doctor");
    expect(names).toContain("dev");
    expect(names).toContain("start");
    expect(names).toContain("stop");
    expect(names).toContain("restart");
    expect(names).toContain("status");
    expect(names).toContain("remove");
    expect(names).toContain("list");
    expect(names).toContain("visitors");
    expect(names).toContain("deploy");
    expect(names).toContain("chat");
    expect(names).toContain("eval");
  });

  test("includes run in top-level help", () => {
    const help = buildCli().helpInformation();
    expect(help).toContain("run [options] <name>");
    expect(help).toContain("Run an agent locally and open /console/chat");
  });
});
