import { Command, InvalidArgumentError, Option } from "commander";
import { portArgument, rejectConflictingOptions } from "./export-bootstrap";

/** The bootstrap and full CLI use the same argument grammar. No handlers here. */
export const PROJECT_COMMANDS = [
  "run",
  "dev",
  "start",
  "restart",
  "doctor",
  "routes",
  "deploy",
] as const;
export type ProjectCommand = (typeof PROJECT_COMMANDS)[number];
export type BootstrapCommand = ProjectCommand | "stop" | "status";

export function createLaunchCommand(name: BootstrapCommand): Command {
  const command = new Command(name);
  if (name === "stop") return command.description("Stop a running agent").argument("<name>");
  if (name === "status")
    return command.description("Show running agents or detail a specific one").argument("[name]");
  if (name === "deploy") {
    command
      .description("Deploy an agent to the cloud (--to railway)")
      .argument("[name]")
      .option("--config <path>", "path to agent.yaml", (value) => {
        if (!value.trim()) throw new InvalidArgumentError("config must name an explicit file path");
        return value;
      })
      .addOption(
        new Option("--ingress <kind>", "hosting profile: auto, none or http")
          .choices(["auto", "none", "http"])
          .default("auto"),
      )
      .option("--port <number>", "existing HTTP listener port", portArgument)
      .option("--health-path <path>", "existing origin-relative HTTP health endpoint")
      .option("--to <provider>", "deployment platform (railway)", "railway")
      .option("--project <project-id>", "deploy into an existing Railway project")
      .option("--project-name <name>", "create a new Railway project with this name")
      .option("--service <name-or-id>", "deploy into an existing Railway service")
      .option("--workspace <workspace>", "Railway workspace name or ID when creating a new project")
      .option("--yes", "skip the secrets-push confirmation prompt");
    rejectConflictingOptions(command);
    return command;
  }
  if (name === "run")
    return command
      .description("Run an agent locally and open /console/chat with a one-time sign-in")
      .argument("[name]", "agent name (defaults to ./agent.yaml)")
      .option("--config <path>", "path to agent.yaml")
      .option("--no-open", "don't launch a browser after boot");
  if (name === "dev")
    return command
      .description("Run an agent in the foreground (Ctrl-C to stop)")
      .argument("[name]")
      .option("--config <path>", "path to agent.yaml")
      .option("--open", "auto-launch the operator's browser to /console/chat once the agent is up")
      .option("--internal-mode <mode>", "(internal) process mode for PID manifest");
  if (name === "start")
    return command
      .description("Install agent as a launchd service (always-on)")
      .argument("[name]")
      .option("--config <path>", "path to agent.yaml");
  if (name === "restart")
    return command
      .description("Stop and restart a running agent")
      .argument("<name>")
      .option("--config <path>", "path to agent.yaml");
  if (name === "doctor")
    return command
      .description("Check whether an agent is ready to run")
      .argument("[name]", "agent name")
      .option("--config <path>", "path to agent.yaml")
      .option("--cloud", "include cloud deploy preflight checks")
      .option("--verbose", "show absolute paths");
  return command
    .description("Show HTTP routes registered by an agent")
    .argument("[name]", "agent name")
    .option("--config <path>", "path to agent.yaml")
    .option("--json", "print the route manifest as JSON")
    .option("--openapi", "print an OpenAPI 3.1 document as JSON")
    .option("--client <format>", "print a generated route client (currently: ts)")
    .option("--target <target>", "generated client target: browser or server (default: browser)")
    .option("--out <path>", "write generated client output to a file");
}
