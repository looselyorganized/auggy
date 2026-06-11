import { describe, expect, mock, test } from "bun:test";

mock.module("@inquirer/prompts", () => ({
  checkbox: async () => [],
  confirm: async () => true,
  input: async () => "",
  password: async () => "",
  select: async (config: { choices?: Array<{ value: unknown }> }) => config.choices?.[0]?.value,
}));

const { buildCli, formatDeployInfoLine, formatDeployResultMessage } = await import(
  "../../src/cli/index"
);

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
    expect(names).toContain("models");
    expect(names).toContain("routes");
    expect(names).toContain("augment");
    expect(names).toContain("mcp");
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
    expect(create?.helpInformation()).toContain("--refresh-models");
  });

  test("skill namespace exposes add/create/list/remove", () => {
    const skill = buildCli().commands.find((cmd) => cmd.name() === "skill");
    const subcommands = skill?.commands.map((cmd) => cmd.name());
    expect(subcommands).toEqual(["add", "create", "list", "remove"]);
  });

  test("project-local cloud commands accept omitted names", () => {
    const cli = buildCli();
    expect(cli.commands.find((cmd) => cmd.name() === "deploy")?.helpInformation()).toContain(
      "[name]",
    );
    expect(cli.commands.find((cmd) => cmd.name() === "logs")?.helpInformation()).toContain(
      "[name]",
    );
    expect(cli.commands.find((cmd) => cmd.name() === "remove")?.helpInformation()).toContain(
      "[name]",
    );
  });

  test("formats deploy progress as concise operator-facing lines", () => {
    expect(formatDeployInfoLine("Deploy preflight passed.", { color: false })).toBe(
      "✔ Deploy preflight passed",
    );
    expect(formatDeployInfoLine("Railway CLI ready.", { color: false })).toBe(
      "✔ Railway CLI ready",
    );
    expect(
      formatDeployInfoLine("Bundle staged at /tmp/auggy-deploy-x.", { color: false }),
    ).toBeNull();
    expect(
      formatDeployInfoLine("Vendored local Auggy runtime auggy-0.4.4.tgz into deploy bundle.", {
        color: false,
      }),
    ).toBeNull();
    expect(
      formatDeployInfoLine('Using Railway workspace "Michael Hofweller\'s Projects".', {
        color: false,
      }),
    ).toBe("✔ Railway workspace: Michael Hofweller's Projects");
    expect(
      formatDeployInfoLine("Created Railway project dx-agent (proj_123).", { color: false }),
    ).toBe("✔ Created Railway project dx-agent (proj_123)");
    expect(
      formatDeployInfoLine('Volume "dx-agent-data" mounted at /app/data.', { color: false }),
    ).toBe("✔ Mounted volume dx-agent-data at /app/data");
    expect(
      formatDeployInfoLine("Deployment health verified: https://agent.test/health", {
        color: false,
      }),
    ).toBe("✔ Service is healthy: https://agent.test/health");
  });

  test("formats deploy success marks in green for TTY output", () => {
    expect(formatDeployInfoLine("Deploy preflight passed.", { color: true })).toBe(
      "\x1b[32m✔\x1b[0m Deploy preflight passed",
    );
    expect(formatDeployInfoLine("Railway CLI ready.", { color: true })).toBe(
      "\x1b[32m✔\x1b[0m Railway CLI ready",
    );
  });

  test("formats successful Railway deploy result as a cloud banner", () => {
    const out = formatDeployResultMessage(
      {
        name: "dx-agent",
        url: "https://dx-agent.up.railway.app",
        projectId: "proj_123",
        serviceId: "dx-agent",
        volumeId: "dx-agent-data",
        health: {
          ok: true,
          url: "https://dx-agent.up.railway.app/health",
          attempts: 1,
          status: 200,
        },
      },
      { nameArg: undefined },
    );

    expect(out).toContain("dx-agent is live on Railway.");
    expect(out).toContain("  Chat:     https://dx-agent.up.railway.app/console/chat");
    expect(out).toContain("  Console:  https://dx-agent.up.railway.app/console");
    expect(out).toContain("  Health:   https://dx-agent.up.railway.app/health");
    expect(out).toContain("  Home:     https://dx-agent.up.railway.app");
    expect(out).toContain("Manage it:");
    expect(out).toContain("  auggy logs");
    expect(out).toMatch(/ {2}auggy deploy --yes\s+Redeploy/);
    expect(out).toContain("Details:");
    expect(out).toContain("  Project:  proj_123");
    expect(out).toContain("  Service:  dx-agent");
    expect(out).not.toContain("Current health is passing");
  });
});
