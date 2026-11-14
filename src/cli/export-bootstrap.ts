import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import type { ExportDockerOptions, ExportDockerResult } from "./deploy/contracts";

export function portArgument(value: string): number {
  if (!/^\d+$/.test(value))
    throw new InvalidArgumentError("port must be an integer from 1 to 65535");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new InvalidArgumentError("port must be an integer from 1 to 65535");
  return port;
}

export type DockerExportHandler = (options: ExportDockerOptions) => Promise<ExportDockerResult>;
const exportDocker: DockerExportHandler = async (options) =>
  (await import("./commands/export")).exportDocker(options);

export function rejectConflictingOptions(command: Command): void {
  for (const option of command.options) {
    const parse = option.parseArg;
    option.argParser<unknown>((raw, previous) => {
      const value = parse ? parse(raw, previous) : raw;
      if (command.getOptionValueSource(option.attributeName()) === "cli" && value !== previous) {
        throw new InvalidArgumentError(`conflicting duplicate ${option.long} options`);
      }
      return value;
    });
  }
}

/** Shared passive grammar: parsing/help never loads an agent's environment or code. */
export function registerExportCommand(
  program: Command,
  handler: DockerExportHandler = exportDocker,
): Command {
  const command = new Command("export").description("Export a portable deployment build context");
  command.addCommand(
    new Command("docker")
      .description("Write a new Docker build context without installing, building or deploying")
      .argument("[name]", "agent name (defaults to ./agent.yaml)")
      .option("--config <path>", "path to agent.yaml", (value) => {
        if (!value.trim()) throw new InvalidArgumentError("config must name an explicit file path");
        return value;
      })
      .requiredOption("--out <directory>", "new output directory")
      .addOption(
        new Option("--ingress <kind>", "hosting profile: auto, none or http")
          .choices(["auto", "none", "http"])
          .default("auto"),
      )
      .option("--port <number>", "existing HTTP listener port", portArgument)
      .option("--health-path <path>", "existing origin-relative HTTP health endpoint")
      .action(async (name: string | undefined, options: Omit<ExportDockerOptions, "name">) => {
        const result = await handler({ ...options, name });
        console.log(`Docker context exported to ${result.outputDir}`);
        console.log(
          result.profile.kind === "none"
            ? "Ingress: none (worker)"
            : `Ingress: HTTP on port ${result.profile.port}`,
        );
        console.log("Build verification: pending; build the exported context with Docker.");
      }),
  );
  rejectConflictingOptions(command.commands[0]!);
  program.addCommand(command);
  return command;
}

export async function dispatchExportCommand(
  argv: readonly string[],
  handler: DockerExportHandler = exportDocker,
): Promise<number | null> {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  if (args[0] !== "export") return null;
  const program = new Command("auggy").exitOverride();
  const command = registerExportCommand(program, handler);
  command.exitOverride();
  for (const child of command.commands) child.exitOverride();
  try {
    await program.parseAsync([...args], { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
}
