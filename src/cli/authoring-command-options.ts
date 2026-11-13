/** Shared grammar for the passive binary path and programmatic CLI help. */
import { Command, Option } from "commander";

export interface InspectCommandOptions {
  config?: string;
  json?: boolean;
}

export interface MigrateCommandOptions extends InspectCommandOptions {
  apply?: boolean;
  application?: boolean;
  rollback?: string;
  projectDir?: string;
}

export function createInspectCommand(): Command {
  return new Command("inspect")
    .description("Trace declared execution and installed sources without running the agent")
    .argument("[name]", "agent project name")
    .option("--config <path>", "select the agent configuration")
    .option("--json", "emit one versioned inspection report");
}

export function createMigrateCommand(): Command {
  return new Command("migrate")
    .description("Preview configuration conversion, application adoption, or receipt recovery")
    .argument("[name]", "agent project name")
    .addOption(
      new Option("--config <path>", "select the agent configuration").conflicts("projectDir"),
    )
    .option("--apply", "publish the recomputed plan; preview is the default")
    .addOption(
      new Option("--application", "also adopt the project-owned execution files").conflicts(
        "rollback",
      ),
    )
    .addOption(
      new Option("--rollback <id>", "recover a recorded authoring operation").conflicts(
        "application",
      ),
    )
    .addOption(
      new Option(
        "--project-dir <path>",
        "select a recovery directory without agent.yaml",
      ).conflicts(["config", "application"]),
    )
    .option("--json", "emit one redacted plan or result report")
    .hook("preAction", (command) => {
      const options = command.opts<MigrateCommandOptions>();
      if (options.projectDir !== undefined && (!options.rollback || command.args.length > 0)) {
        command.error(
          "--project-dir requires --rollback and cannot be combined with an agent name.",
        );
      }
    });
}
