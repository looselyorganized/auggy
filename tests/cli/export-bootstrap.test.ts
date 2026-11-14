import { expect, test } from "bun:test";
import { Command } from "commander";
import {
  dispatchExportCommand,
  registerExportCommand,
  type DockerExportHandler,
} from "../../src/cli/export-bootstrap";
import type { ExportDockerOptions } from "../../src/cli/deploy/contracts";

test("passive Docker grammar validates all arguments before export effects", async () => {
  const calls: ExportDockerOptions[] = [];
  const handler: DockerExportHandler = async (options) => {
    calls.push(options);
    return {
      outputDir: options.out,
      profile: { kind: "none" },
      manifestPath: "context/auggy-deployment.json",
      fileCount: 3,
      sourceBytes: 1,
      buildVerified: false,
    };
  };
  expect(await dispatchExportCommand(["inspect"], handler)).toBeNull();
  for (const args of [
    ["export", "docker"],
    ["export", "docker", "--out", "new", "--ingress", "bad"],
    ["export", "docker", "--out", "new", "--port", "1.5"],
    ["export", "docker", "--out", "new", "--port", "65536"],
    ["export", "docker", "--out", "new", "--install"],
    ["export", "docker", "--out", "new", "--config", ""],
    ["export", "docker", "--out", "new", "--config= "],
    ["export", "docker", "--out", "new", "--ingress", "none", "--ingress=http"],
    ["export", "docker", "--out", "new", "--port", "8080", "--port=8081"],
    ["export", "docker", "--out", "new", "--config", "a.yaml", "--config=b.yaml"],
    ["export", "docker", "--out", "new", "--out=other"],
  ])
    expect(await dispatchExportCommand(args, handler)).not.toBe(0);
  expect(calls).toHaveLength(0);
  expect(
    await dispatchExportCommand(
      [
        "export",
        "docker",
        "support",
        "--config",
        "custom.yaml",
        "--out",
        "new",
        "--ingress",
        "none",
      ],
      handler,
    ),
  ).toBe(0);
  expect(calls[0]).toMatchObject({
    name: "support",
    config: "custom.yaml",
    out: "new",
    ingress: "none",
  });
  const program = new Command();
  registerExportCommand(program, handler);
  await program.parseAsync(
    [
      "export",
      "docker",
      "--out",
      "another",
      "--ingress",
      "http",
      "--port",
      "8080",
      "--health-path",
      "/ready",
    ],
    { from: "user" },
  );
  expect(calls[1]).toMatchObject({
    out: "another",
    ingress: "http",
    port: 8080,
    healthPath: "/ready",
  });
  const duplicated = new Command().exitOverride();
  const exportCommand = registerExportCommand(duplicated, handler);
  exportCommand.commands[0]!.exitOverride();
  await expect(
    duplicated.parseAsync(
      ["export", "docker", "--out", "new", "--health-path", "/ready", "--health-path=/other"],
      { from: "user" },
    ),
  ).rejects.toThrow(/conflicting duplicate/);
  expect(calls).toHaveLength(2);
});
