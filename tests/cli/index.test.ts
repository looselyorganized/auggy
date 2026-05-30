import { describe, expect, mock, test } from "bun:test";

mock.module("@inquirer/prompts", () => ({
  checkbox: async () => [],
  confirm: async () => true,
  input: async () => "",
  select: async (config: { choices?: Array<{ value: unknown }> }) => config.choices?.[0]?.value,
}));

const { buildCli } = await import("../../src/cli/index");

describe("auggy CLI command table", () => {
  test("registers the public command suite", () => {
    const cli = buildCli();
    const names = cli.commands.map((cmd) => cmd.name());

    expect(names).toContain("create");
    expect(names).toContain("add");
    expect(names).toContain("init");
    expect(names).toContain("skill");
    expect(names).not.toContain("add-skill");
    expect(names).toContain("run");
    expect(names).toContain("doctor");
    expect(names).toContain("augment");
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
    expect(help).toContain("run [options] [name]");
    expect(help).toContain("Run an agent locally and open /console/chat");
  });

  test("create scaffolds standalone projects by default", () => {
    const create = buildCli().commands.find((cmd) => cmd.name() === "create");
    expect(create?.helpInformation()).not.toContain("--project");
    expect(create?.helpInformation()).toContain("standalone agent project");
  });

  test("skill namespace exposes add/create/list/remove", () => {
    const skill = buildCli().commands.find((cmd) => cmd.name() === "skill");
    const subcommands = skill?.commands.map((cmd) => cmd.name());
    expect(subcommands).toEqual(["add", "create", "list", "remove"]);
  });
});
