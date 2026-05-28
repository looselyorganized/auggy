import { describe, expect, mock, test } from "bun:test";
import { augmentCommand } from "../../../src/cli/commands/augment";

describe("auggy augment command", () => {
  test("registers the augment command with create subcommand", () => {
    const cmd = augmentCommand();
    expect(cmd.name()).toBe("augment");
    expect(cmd.commands.map((c) => c.name())).toContain("create");
  });

  test("create dispatches to scaffold helper", async () => {
    const scaffold = mock(() => "/tmp/weather");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => {
      logs.push(String(msg));
    };

    try {
      const cmd = augmentCommand({ scaffoldCustomAugment: scaffold });
      await cmd.parseAsync(["create", "weather", "--dir", "/tmp/weather", "--force"], {
        from: "user",
      });
    } finally {
      console.log = origLog;
    }

    expect(scaffold).toHaveBeenCalledWith({
      slug: "weather",
      targetDir: "/tmp/weather",
      force: true,
    });
    expect(logs.join("\n")).toContain('Created custom augment "weather"');
  });

  test("create exits 1 on scaffold errors", async () => {
    const scaffold = mock(() => {
      throw new Error("bad slug");
    });
    const exit = mock((_code: number) => {});
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: unknown) => {
      errors.push(String(msg));
    };

    try {
      const cmd = augmentCommand({ scaffoldCustomAugment: scaffold, exit });
      await cmd.parseAsync(["create", "Bad"], { from: "user" });
    } finally {
      console.error = origErr;
    }

    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain("bad slug");
  });
});
