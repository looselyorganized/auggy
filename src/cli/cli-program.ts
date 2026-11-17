/**
 * auggy — CLI for the Auggy agent runtime.
 *
 * Commands:
 *   auggy create <name>              Scaffold a new agent (interactive)
 *   auggy augment add <augment>      Add an augment to an agent
 *   auggy augment remove <augment>   Remove an augment from an agent
 *   auggy augment list               List augments in an agent
 *   auggy skill add <augment>        Repair/reinstall a bundled skill
 *   auggy run [name] [--no-open]     Run agent in foreground; opens /console/chat by default
 *   auggy console [name] [--cloud]   Open a running local or Railway Console
 *   auggy doctor [name]              Check whether an agent is ready to run
 *   auggy coordination migrate [name] Apply configured coordination migrations
 *   auggy models list [provider]     List known/provider engine models
 *   auggy routes [name]              Show route manifest/OpenAPI/client output for an agent
 *   auggy augment create <slug>      Scaffold a local custom augment
 *   auggy augment setup <augment>    Configure secrets and external services
 *   auggy dev [name] [--open]        Run agent in foreground; --open pops /console in browser
 *   auggy start [name] [--config]    Install as launchd service (always-on)
 *   auggy stop <name>                Stop a running agent
 *   auggy restart <name>             Stop + start
 *   auggy status [name]              Show running agents
 *   auggy list                       List agent projects in this directory
 *   auggy remove [name] [--yes] [--cloud]  Delete an agent project, optionally Railway service
 *   auggy deploy [name]             Deploy an agent to Railway
 *   auggy logs [name]               Show Railway logs for a deployed agent
 *   auggy chat                       Launch local GUI
 *   auggy eval [name]                Run portable security eval suite
 */

import { Command } from "commander";
import { createLaunchCommand } from "./launch-command-options";
import pkg from "../../package.json" with { type: "json" };
import { runCreate } from "./commands/create";
import { skillCommand } from "./commands/add-skill";
import { runCommand } from "./commands/run";
import { consoleCommand } from "./commands/console";
import { doctorCommand } from "./commands/doctor";
import { coordinationCommand } from "./commands/coordination";
import { routesCommand } from "./commands/routes";
import { augmentCommand } from "./commands/augment";
import { agentMailCommand } from "./commands/agentmail";
import { runDev } from "./commands/dev";
import { runStart } from "./commands/start";
import { runStop } from "./commands/stop";
import { runRestart } from "./commands/restart";
import { runStatus } from "./commands/status";
import { chatCommand } from "./commands/chat";
import { evalCommand } from "./commands/eval";
import { mcpCommand } from "./commands/mcp";
import { modelsCommand } from "./commands/models";
import { runtimeStateCommand } from "./commands/state";
import { jobsCommand } from "./commands/jobs";
import { runRemove } from "./commands/remove";
import { runLs } from "./commands/ls";
import { withBrailleSpinner } from "./spinner";
import type { DeployResult } from "./commands/deploy";
import type { RailwayCli } from "./deploy/railway-cli";
import type { CloudRecord } from "./types";
import { failureMark, successMark, warningLabel, type CliStyleOptions } from "./_shared/styles";
import { registerAuthoringCommands } from "./authoring-bootstrap";
import { authoringCommandHandlers } from "./authoring-command-handlers";
import { registerExportCommand } from "./export-bootstrap";

interface CreateCommandOptions {
  skipInstall?: boolean;
  refreshModels?: boolean;
  provider?: string;
  model?: string;
  yes?: boolean;
  allowUnpricedModel?: boolean;
}

export function buildCli(): Command {
  const program = new Command();

  program.name("auggy").description("Auggy agent runtime CLI").version(pkg.version);
  registerAuthoringCommands(program, authoringCommandHandlers);
  registerExportCommand(program);

  program
    .command("create <name>")
    .description("Scaffold a standalone agent project at ./<name> (interactive)")
    .option("--skip-install", "write package.json but don't run bun install")
    .option("--refresh-models", "fetch live provider model catalogs before model selection")
    .option("--provider <id>", "select anthropic, openai, openrouter, or ollama")
    .option("--model <id>", "select an explicit provider model")
    .option("--yes", "use deterministic defaults without prompts; requires provider and model")
    .option("--allow-unpriced-model", "explicitly acknowledge unavailable pricing for this model")
    .action(async (name: string, opts: CreateCommandOptions) => {
      try {
        if (!opts.yes) assertInteractiveCommand("auggy create");
        await runCreate(name, { ...opts, useModelCache: true });
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command("init [name]")
    .description("Initialize the current directory as an Auggy agent project")
    .option("--skip-install", "write package.json but don't run bun install")
    .option("--refresh-models", "fetch live provider model catalogs before model selection")
    .option("--provider <id>", "select anthropic, openai, openrouter, or ollama")
    .option("--model <id>", "select an explicit provider model")
    .option("--yes", "use deterministic defaults without prompts; requires provider and model")
    .option("--allow-unpriced-model", "explicitly acknowledge unavailable pricing for this model")
    .action(async (name: string | undefined, opts: CreateCommandOptions) => {
      try {
        if (!opts.yes) assertInteractiveCommand("auggy init");
        const { runInit } = await import("./commands/create");
        await runInit({
          ...opts,
          name,
          useModelCache: true,
        });
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program.addCommand(skillCommand());
  program.addCommand(runCommand());
  program.addCommand(consoleCommand());
  program.addCommand(doctorCommand());
  program.addCommand(coordinationCommand());
  program.addCommand(modelsCommand());
  program.addCommand(runtimeStateCommand());
  program.addCommand(jobsCommand());
  program.addCommand(routesCommand());
  program.addCommand(augmentCommand());
  program.addCommand(agentMailCommand());
  program.addCommand(mcpCommand());

  addLaunchCommand(program, "dev").action(
    async (
      name: string | undefined,
      opts: { config?: string; open?: boolean; internalMode?: string },
    ) => {
      try {
        await runDev(name, opts);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    },
  );

  addLaunchCommand(program, "start").action(
    async (name: string | undefined, opts: { config?: string }) => {
      try {
        await runStart(name, opts);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    },
  );

  addLaunchCommand(program, "stop").action(async (name: string) => {
    try {
      await runStop(name);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

  addLaunchCommand(program, "restart").action(async (name: string, opts: { config?: string }) => {
    try {
      await runRestart(name, opts);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

  addLaunchCommand(program, "status").action(async (name?: string) => {
    try {
      await runStatus(name);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

  program
    .command("remove [name]")
    .description("Remove an agent project (--cloud also destroys the Railway service)")
    .option("--yes", "skip the confirmation prompt")
    .option("--cloud", "also destroy the agent's Railway service (when cloud-deployed)")
    .action(async (name: string | undefined, opts: { yes?: boolean; cloud?: boolean }) => {
      try {
        await runRemove(name, { yes: opts.yes, cloud: opts.cloud });
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command("list")
    .description("List agent projects in this directory with their status")
    .action(async () => {
      try {
        await runLs();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command("visitors <name>")
    .description("list verified visitors for an agent")
    .option("--revoke <email>", "revoke a verified visitor by email")
    .option("--yes", "skip the confirmation prompt for --revoke")
    .action(async (agentName: string, options: { revoke?: string; yes?: boolean }) => {
      try {
        if (options.revoke) {
          const { runVisitorsRevoke } = await import("./commands/visitors-revoke");
          await runVisitorsRevoke(agentName, options.revoke, { confirm: options.yes !== true });
          return;
        }
        const { runVisitorsList } = await import("./commands/visitors");
        await runVisitorsList(agentName);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command("logs [name]")
    .description("Show Railway logs for a deployed agent")
    .action(async (name: string | undefined) => {
      try {
        const { runLogs } = await import("./commands/logs");
        await runLogs(name);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  addLaunchCommand(program, "deploy").action(
    async (
      name: string | undefined,
      opts: {
        to: string;
        project?: string;
        projectName?: string;
        service?: string;
        workspace?: string;
        yes?: boolean;
        config?: string;
        ingress?: "auto" | "none" | "http";
        port?: number;
        healthPath?: string;
      },
    ) => {
      try {
        const { runDeploy } = await import("./commands/deploy");
        const { createRailwayCli } = await import("./deploy/railway-cli");
        const { input, confirm, select } = await import("@inquirer/prompts");

        const cli = createRailwayCli();
        const result = await runDeploy(name, {
          to: opts.to as "railway",
          yes: opts.yes ?? false,
          config: opts.config,
          ingress: opts.ingress,
          port: opts.port,
          healthPath: opts.healthPath,
          project: opts.project,
          projectName: opts.projectName,
          service: opts.service,
          workspace: opts.workspace,
          cli,
          promptProjectTarget: ({ workspace, projects } = {}) =>
            select({
              message: workspace ? `Railway project in ${workspace.name}:` : "Railway project:",
              choices: [
                {
                  name: `Create a new Railway project for ${name ?? "this agent"}`,
                  value: "new" as const,
                },
                {
                  name:
                    projects && projects.length > 0
                      ? "Use an existing Railway project"
                      : "Enter an existing Railway project ID",
                  value: "existing" as const,
                },
              ],
            }),
          promptProjectName: (defaultName) =>
            input({
              message: "New Railway project name:",
              default: defaultName,
              validate: (v) => v.trim().length > 0 || "project name required",
            }),
          promptProjectId: async (projects) => {
            const manual = "__manual__";
            if (projects && projects.length > 0) {
              const selected = await select({
                message: "Existing Railway project:",
                choices: [
                  ...projects.map((project) => ({
                    name: project.name,
                    value: project.id,
                  })),
                  { name: "Enter project ID manually", value: manual },
                ],
              });
              if (selected !== manual) return selected;
            }
            return input({
              message:
                "Railway project ID (find it in the Railway dashboard URL or via `railway list`):",
              validate: (v) => v.trim().length > 0 || "project ID required",
            });
          },
          promptWorkspace: async (workspaces) => {
            const manual = "__manual__";
            if (workspaces.length > 0) {
              const selected = await select({
                message: "Railway workspace:",
                choices: [
                  ...workspaces.map((workspace) => ({
                    name: workspace.name,
                    value: workspace.id,
                  })),
                  { name: "Enter workspace manually", value: manual },
                ],
              });
              if (selected !== manual) return selected;
            }
            return input({
              message: "Railway workspace name (personal/team workspace, not project name):",
              validate: (v) => v.trim().length > 0 || "workspace required",
            });
          },
          promptSavedDeploymentTarget: async ({ cloud }) => {
            const target = await describeSavedRailwayTarget(cli, cloud);
            return select({
              message:
                `Saved Railway service:\n` +
                `  ${target.service}\n` +
                `  ${target.scope}\n\n` +
                `What do you want to do?`,
              choices: [
                {
                  name: `Redeploy ${target.service}`,
                  value: "saved" as const,
                },
                {
                  name: `Recreate ${target.service} in this project`,
                  value: "recreate" as const,
                },
                {
                  name: "Choose another Railway project/service",
                  value: "choose" as const,
                },
                {
                  name: "Remove saved deploy metadata and start over",
                  value: "reset" as const,
                },
                {
                  name: "Cancel",
                  value: "cancel" as const,
                },
              ],
            });
          },
          promptServiceTarget: ({ defaultServiceName }) =>
            select({
              message: `Railway service for ${defaultServiceName}:`,
              choices: [
                {
                  name: `Create new service ${defaultServiceName}`,
                  value: "new" as const,
                },
                {
                  name: "Use an existing Railway service",
                  value: "existing" as const,
                },
              ],
            }),
          promptServiceName: (defaultName) =>
            input({
              message: "Existing Railway service name or ID:",
              default: defaultName,
              validate: (v) => v.trim().length > 0 || "service name required",
            }),
          promptConfirm: (message) => confirm({ message, default: false }),
          logger: {
            info: (msg) => {
              const line = formatDeployInfoLine(msg);
              if (line) console.log(line);
            },
            warn: (msg) => console.warn(formatWarning(msg)),
            error: (msg) => console.error(`error: ${msg}`),
            task: (msg, run) =>
              withBrailleSpinner(msg, run, {
                failureText: `${failureMark()} ${msg}`,
              }),
          },
        });
        console.log(formatDeployResultMessage(result, { nameArg: name }));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    },
  );

  program.addCommand(chatCommand());
  program.addCommand(evalCommand());

  return program;
}

function assertInteractiveCommand(command: string): void {
  if (process.stdin.isTTY) return;
  throw new Error(
    `${command} is interactive and needs a terminal.\n\n` +
      "  Run it directly in your shell, or pass --provider <id> --model <id> --yes for automation.",
  );
}

function formatWarning(msg: string): string {
  return `\n${warningLabel({ color: process.stderr.isTTY })}: ${msg}\n`;
}

export async function describeSavedRailwayTarget(
  cli: Pick<RailwayCli, "listProjects">,
  cloud: NonNullable<CloudRecord>,
): Promise<{ service: string; scope: string }> {
  let scope = `project ${cloud.projectId}`;
  try {
    const projects = await cli.listProjects();
    const project = projects.find((candidate) => candidate.id === cloud.projectId);
    if (project?.workspaceName && project.name) {
      scope = `${project.workspaceName} / ${project.name}`;
    } else if (project?.name) {
      scope = project.name;
    } else if (project?.workspaceName) {
      scope = `${project.workspaceName} / project ${project.id}`;
    }
  } catch {
    // Display-only enrichment. Falling back to IDs must not block deploy.
  }
  return { service: cloud.serviceId, scope };
}

export function formatDeployInfoLine(msg: string, style: CliStyleOptions = {}): string | null {
  const check = successMark(style);

  if (/^Bundle staged at /.test(msg)) return null;
  if (/^Vendored local Auggy runtime /.test(msg)) return null;
  if (/^Linked staging dir /.test(msg)) return null;

  if (msg === "Deploy preflight passed.") return `${check} Deploy preflight passed`;
  if (msg === "Railway CLI ready.") return `${check} Railway CLI ready`;
  if (msg === "Build started. Railway will build the image, deploy it, then start the service.") {
    return `${check} Build started`;
  }

  let match = msg.match(/^Using Railway workspace "(.+)"\.$/);
  if (match) return `${check} Railway workspace: ${match[1]}`;

  let pair = splitBoundedMessage(msg, "Created Railway project ", " (", ").");
  if (pair) return `${check} Created Railway project ${pair[0]} (${pair[1]})`;

  pair = splitBoundedMessage(msg, "First deploy of ", " to existing Railway project ", ".");
  if (pair) return `${check} Railway project: ${pair[1]}`;

  pair = splitBoundedMessage(msg, "Redeploying ", " to Railway project ", ".");
  if (pair) return `${check} Railway project: ${pair[1]}`;

  match = msg.match(/^Created Railway service (.+)\.$/);
  if (match) return `${check} Created Railway service ${match[1]}`;

  match = msg.match(/^Using existing Railway service (.+)\.$/);
  if (match) return `${check} Railway service: ${match[1]}`;

  pair = splitBoundedMessage(msg, 'Volume "', '" mounted at ', ".");
  if (pair) return `${check} Mounted volume ${pair[0]} at ${pair[1]}`;

  match = msg.match(/^Public URL: (.+)$/);
  if (match) return `${check} Public URL: ${match[1]}`;

  match = msg.match(/^Pushed (.+ env var\(s\)) to Railway\.$/);
  if (match) return `${check} Pushed ${match[1]} to Railway`;

  match = msg.match(/^Railway deployment finished: (.+)\.$/);
  if (match) return `${check} Build successful (${match[1]})`;

  match = msg.match(/^Deployment health verified: (.+)$/);
  if (match) return `${check} Service is healthy: ${match[1]}`;

  match = msg.match(/^Service status: (.+)\.$/);
  if (match) return `${check} Railway status: ${match[1]}`;

  match = msg.match(
    /^Railway deployment status not final yet; continuing with health check \((.+)\)\.$/,
  );
  if (match) return `Railway status pending: ${match[1]}`;

  match = msg.match(
    /^Deployment health is pending \((.+)\)\. Railway may still be building or starting the service\.$/,
  );
  if (match) return `Health check pending: ${match[1]}`;

  return msg;
}

function splitBoundedMessage(
  value: string,
  prefix: string,
  separator: string,
  suffix: string,
): [string, string] | null {
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return null;
  const body = value.slice(prefix.length, value.length - suffix.length);
  const separatorIndex = body.lastIndexOf(separator);
  if (separatorIndex <= 0 || separatorIndex + separator.length >= body.length) return null;
  return [body.slice(0, separatorIndex), body.slice(separatorIndex + separator.length)];
}

export function formatDeployResultMessage(
  result: DeployResult,
  opts: { nameArg?: string | undefined } = {},
): string {
  const rerun = opts.nameArg ? `auggy deploy ${opts.nameArg} --yes` : "auggy deploy --yes";
  const { readiness } = result;
  const lines = [
    "",
    `Railway deployment submitted for ${result.name}.`,
    "",
    `  Platform: ${readiness.platform}`,
    `  HTTP:     ${readiness.http.state}`,
    `  Channel:  ${readiness.channel.state}`,
  ];
  if (result.profile.kind === "none") {
    lines.push("  Ingress:  none (worker)");
  } else if (result.url !== null) {
    lines.push(`  Home:     ${result.url}`);
    if (result.profile.consolePath !== null) {
      const consoleUrl = new URL(result.profile.consolePath, result.url).toString();
      lines.push(`  Console:  ${consoleUrl}`);
      if (result.profile.consolePath === "/console")
        lines.push(`  Chat:     ${new URL("/console/chat", result.url).toString()}`);
    }
    if (result.health) lines.push(`  Health:   ${result.health.url}`);
  }
  lines.push("", "Manage it:");
  if (result.profile.kind === "http" && result.profile.consolePath !== null)
    lines.push(`  auggy console ${result.name}`);
  lines.push(
    `  auggy logs ${result.name}`,
    `  ${rerun.padEnd(24)} Redeploy`,
    "",
    "Details:",
    `  Project:  ${result.projectId}`,
    `  Service:  ${result.serviceId}`,
    `  Volume:   ${result.volumeId} (mounted at /app/data)`,
  );
  if (readiness.platform !== "ready")
    lines.push("", "Platform readiness is unconfirmed. Inspect `auggy logs` and Railway status.");
  if (["failed", "timed-out"].includes(readiness.http.state))
    lines.push("", "HTTP health did not pass. Inspect `auggy logs` before sending requests.");
  lines.push("", "A channel turn has not been verified by this deployment command.");

  return lines.join("\n");
}

function addLaunchCommand(
  program: Command,
  name: Parameters<typeof createLaunchCommand>[0],
): Command {
  const command = createLaunchCommand(name);
  program.addCommand(command);
  return command;
}
